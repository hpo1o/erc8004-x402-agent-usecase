// ---------------------------------------------------------------------------
// erc8004/scripts/reputation.ts
//
// Reusable module — called by image-generator after each successful
// colorizer-service call to record on-chain reputation feedback.
//
// Exports one function:
//   submitFeedback(params) → { txHash, feedbackCID, feedbackIndex }
//
// Flow:
//   1. Build off-chain feedback JSON per ERC-8004 spec
//   2. Upload it to IPFS via Pinata   → feedbackCID
//   3. Hash the JSON with keccak256   → feedbackHash (bytes32)
//   4. Call giveFeedback() on ReputationRegistry
//   5. Parse NewFeedback event        → feedbackIndex
//   6. Return txHash + feedbackCID + feedbackIndex
//
// Required env vars:
//   PINATA_JWT          — Pinata JWT for IPFS uploads
//   PAYER_PRIVATE_KEY   — private key of the paying/client wallet (= paymentFrom)
//   BASE_SEPOLIA_RPC    — optional, default: https://sepolia.base.org
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToBytes,
  parseEventLogs,
  type Address,
  type Hash,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Paths & env
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const ERC8004_ROOT = resolve(__dir, "..");
const CONTRACTS_FILE = resolve(ERC8004_ROOT, "contracts", "registry-addresses.json");

try {
  process.loadEnvFile(resolve(ERC8004_ROOT, ".env"));
} catch { /* .env absent — vars from shell */ }
try {
  process.loadEnvFile(resolve(ERC8004_ROOT, "../image-generator/.env"));
} catch { /* CLI env may be supplied by the shell */ }

// ---------------------------------------------------------------------------
// ABI — only giveFeedback + NewFeedback event.
// Source: https://github.com/erc-8004/erc-8004-contracts/blob/main/abis/ReputationRegistry.json
// ---------------------------------------------------------------------------
const REPUTATION_REGISTRY_ABI = [
  {
    inputs: [
      { internalType: "uint256", name: "agentId",      type: "uint256" },
      { internalType: "int128",  name: "value",         type: "int128"  },
      { internalType: "uint8",   name: "valueDecimals", type: "uint8"   },
      { internalType: "string",  name: "tag1",          type: "string"  },
      { internalType: "string",  name: "tag2",          type: "string"  },
      { internalType: "string",  name: "endpoint",      type: "string"  },
      { internalType: "string",  name: "feedbackURI",   type: "string"  },
      { internalType: "bytes32", name: "feedbackHash",  type: "bytes32" },
    ],
    name: "giveFeedback",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: "uint256", name: "agentId",       type: "uint256" },
      { indexed: true,  internalType: "address", name: "clientAddress", type: "address" },
      { indexed: false, internalType: "uint64",  name: "feedbackIndex", type: "uint64"  },
      { indexed: false, internalType: "int128",  name: "value",         type: "int128"  },
      { indexed: false, internalType: "uint8",   name: "valueDecimals", type: "uint8"   },
      { indexed: true,  internalType: "string",  name: "indexedTag1",   type: "string"  },
      { indexed: false, internalType: "string",  name: "tag1",          type: "string"  },
      { indexed: false, internalType: "string",  name: "tag2",          type: "string"  },
      { indexed: false, internalType: "string",  name: "endpoint",      type: "string"  },
      { indexed: false, internalType: "string",  name: "feedbackURI",   type: "string"  },
      { indexed: false, internalType: "bytes32", name: "feedbackHash",  type: "bytes32" },
    ],
    name: "NewFeedback",
    type: "event",
  },
] as const;

// ---------------------------------------------------------------------------
// Off-chain feedback file shape (ERC-8004 spec)
// ---------------------------------------------------------------------------
interface FeedbackFile {
  agentRegistry: string;
  agentId: number;
  clientAddress: string;
  createdAt: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  endpoint: string;
  a2a: {
    contextId: string;
    taskId: string;
  };
  proofOfPayment: {
    fromAddress: string;
    toAddress: string;
    chainId: string;
    txHash: string;
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export interface SubmitFeedbackParams {
  agentId: number;
  contextId: string;
  taskId: string;
  paymentTxHash: string;
  paymentFrom: string;
  paymentTo: string;
  success: boolean;
  responseTimeMs: number;
  /** A2A endpoint that was called — stored in the off-chain feedback file. */
  endpoint: string;
}

export interface SubmitFeedbackResult {
  txHash: Hash;
  feedbackCID: string;
  feedbackIndex: bigint;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadRegistryAddresses(): Promise<{
  chainId: number;
  identityRegistry: Address;
  reputationRegistry: Address;
}> {
  const raw = await readFile(CONTRACTS_FILE, "utf-8");
  return JSON.parse(raw);
}

async function pinToIPFS(jwt: string, content: unknown): Promise<string> {
  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: content,
      pinataOptions: { cidVersion: 1 },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pinata upload failed (HTTP ${res.status}): ${text}`);
  }

  const data = (await res.json()) as { IpfsHash: string };
  if (!data.IpfsHash) {
    throw new Error(`Pinata response missing IpfsHash: ${JSON.stringify(data)}`);
  }

  return data.IpfsHash;
}

function loadPayerPrivateKey(): `0x${string}` {
  const raw = process.env.PAYER_PRIVATE_KEY;
  if (!raw) throw new Error("PAYER_PRIVATE_KEY is not set");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}

// ---------------------------------------------------------------------------
// submitFeedback
// ---------------------------------------------------------------------------
export async function submitFeedback(
  params: SubmitFeedbackParams
): Promise<SubmitFeedbackResult> {
  const {
    agentId,
    contextId,
    taskId,
    paymentTxHash,
    paymentFrom,
    paymentTo,
    success,
    responseTimeMs,
  } = params;

  // ── Env ────────────────────────────────────────────────────────────────────
  const pinatajwt = process.env.PINATA_JWT;
  if (!pinatajwt) throw new Error("PINATA_JWT is not set");

  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

  // ── Registry config ────────────────────────────────────────────────────────
  const { chainId, identityRegistry, reputationRegistry } =
    await loadRegistryAddresses();

  const agentRegistry = `eip155:${chainId}:${identityRegistry}`;

  // ── Step 1: Build off-chain feedback JSON ──────────────────────────────────
  //
  // value=100 means success (the task completed), value=0 means failure.
  // valueDecimals=0 — no decimal places needed for a binary success signal.
  // tag1="successRate" — standard tag for binary call success.
  //
  // responseTimeMs is included in the off-chain file for richer off-chain
  // analytics but is not sent on-chain (contract stores only the numeric signal).
  const value = success ? 100 : 0;
  const { endpoint } = params;

  const feedbackFile: FeedbackFile = {
    agentRegistry,
    agentId,
    clientAddress: `eip155:${chainId}:${paymentFrom}`,
    createdAt: new Date().toISOString(),
    value,
    valueDecimals: 0,
    tag1: "successRate",
    endpoint,
    a2a: { contextId, taskId },
    proofOfPayment: {
      fromAddress: paymentFrom,
      toAddress: paymentTo,
      chainId: String(chainId),
      txHash: paymentTxHash,
    },
  };

  // responseTimeMs lives only in the off-chain file — extend the type here
  // rather than adding it to FeedbackFile so the ERC-8004 required fields stay clean.
  const fullFeedbackFile = { ...feedbackFile, responseTimeMs };

  // ── Step 2: Upload to IPFS ──────────────────────────────────────────────────
  const feedbackCID = await pinToIPFS(pinatajwt, fullFeedbackFile);
  const feedbackURI = `ipfs://${feedbackCID}`;

  // ── Step 3: keccak256 of the canonical JSON string ─────────────────────────
  //
  // JSON.stringify produces a deterministic string here because the keys are
  // inserted in insertion order (ES2015+) and no values are undefined.
  // The hash lets on-chain verifiers confirm the off-chain file wasn't altered.
  const feedbackJson = JSON.stringify(fullFeedbackFile);
  const feedbackHash = keccak256(stringToBytes(feedbackJson));

  // ── Step 4: Submit on-chain ────────────────────────────────────────────────
  const account = privateKeyToAccount(loadPayerPrivateKey());

  // The feedback client recorded off-chain must be the transaction signer.
  // The registry itself rejects the signer if it owns or operates agentId.
  if (paymentFrom.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `PAYER_PRIVATE_KEY resolves to ${account.address}, but paymentFrom is ${paymentFrom}`
    );
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpc),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpc),
  });

  const txHash = await walletClient.writeContract({
    address: reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: "giveFeedback",
    args: [
      BigInt(agentId),
      BigInt(value),   // int128
      0,               // valueDecimals
      "successRate",   // tag1
      "",              // tag2
      endpoint,        // endpoint
      feedbackURI,     // feedbackURI
      feedbackHash,    // feedbackHash (bytes32)
    ],
    account,
    chain: baseSepolia,
  });

  // ── Step 5: Wait for receipt & extract feedbackIndex ──────────────────────
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  if (receipt.status !== "success") {
    throw new Error(`giveFeedback() tx reverted. Hash: ${txHash}`);
  }

  const logs = parseEventLogs({
    abi: REPUTATION_REGISTRY_ABI,
    eventName: "NewFeedback",
    logs: receipt.logs,
  });

  if (logs.length === 0) {
    throw new Error(`NewFeedback event not found in tx ${txHash}`);
  }

  const feedbackIndex = logs[0].args.feedbackIndex;

  return { txHash, feedbackCID, feedbackIndex };
}
