// ---------------------------------------------------------------------------
// erc8004/scripts/validation.ts
//
// Reusable module — records an ERC-8004 validation request and response.

// Agent 2's owner signs validationRequest(), while Agent 1's payer wallet is
// selected as an independent validator and signs validationResponse(). A separate
// VALIDATOR_PRIVATE_KEY can be supplied to replace the payer with a dedicated
// validator.
//
// Exports:
//   requestValidation(params) → { txHash, requestHash }
//
// Required env vars:
//   PINATA_JWT          — Pinata JWT for IPFS uploads
//   ERC8004_PRIVATE_KEY — private key of the agent owner (signer of the tx)
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
// ABI — validationRequest + validationResponse + their events.
// Source: https://github.com/erc-8004/erc-8004-contracts/blob/main/abis/ValidationRegistry.json
// ---------------------------------------------------------------------------
const VALIDATION_REGISTRY_ABI = [
  // validationRequest(validatorAddress, agentId, requestURI, requestHash)
  {
    inputs: [
      { internalType: "address", name: "validatorAddress", type: "address" },
      { internalType: "uint256", name: "agentId",          type: "uint256" },
      { internalType: "string",  name: "requestURI",       type: "string"  },
      { internalType: "bytes32", name: "requestHash",      type: "bytes32" },
    ],
    name: "validationRequest",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId,
  //                         string requestURI, bytes32 indexed requestHash)
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: "address", name: "validatorAddress", type: "address" },
      { indexed: true,  internalType: "uint256", name: "agentId",          type: "uint256" },
      { indexed: false, internalType: "string",  name: "requestURI",       type: "string"  },
      { indexed: true,  internalType: "bytes32", name: "requestHash",      type: "bytes32" },
    ],
    name: "ValidationRequest",
    type: "event",
  },
  // validationResponse(requestHash, response, responseURI, responseHash, tag)
  {
    inputs: [
      { internalType: "bytes32", name: "requestHash",  type: "bytes32" },
      { internalType: "uint8",   name: "response",     type: "uint8"   },
      { internalType: "string",  name: "responseURI",  type: "string"  },
      { internalType: "bytes32", name: "responseHash", type: "bytes32" },
      { internalType: "string",  name: "tag",          type: "string"  },
    ],
    name: "validationResponse",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId,
  //   bytes32 indexed requestHash, uint8 response, string responseURI,
  //   bytes32 responseHash, string tag)
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: "address", name: "validatorAddress", type: "address" },
      { indexed: true,  internalType: "uint256", name: "agentId",          type: "uint256" },
      { indexed: true,  internalType: "bytes32", name: "requestHash",      type: "bytes32" },
      { indexed: false, internalType: "uint8",   name: "response",         type: "uint8"   },
      { indexed: false, internalType: "string",  name: "responseURI",      type: "string"  },
      { indexed: false, internalType: "bytes32", name: "responseHash",     type: "bytes32" },
      { indexed: false, internalType: "string",  name: "tag",              type: "string"  },
    ],
    name: "ValidationResponse",
    type: "event",
  },
] as const;


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Off-chain validation request file (ERC-8004 convention). */
interface ValidationRequestFile {
  agentRegistry: string;
  agentId: number;
  task: string;
  input: { imageHash: string };
  output: { imageHash: string };
  a2a: { contextId: string; taskId: string };
  proofOfPayment: { txHash: string; chainId: string };
  timestamp: string;
}

export interface RequestValidationParams {
  agentId: number;
  /** keccak256 of the source image (base64 string) */
  inputImageHash: string;
  /** keccak256 of the grayscale result (base64 string) */
  outputImageHash: string;
  contextId: string;
  taskId: string;
  paymentTxHash: string;
  /** Independent validator that will submit the validation response. */
  validatorAddress: string;
}

export interface RequestValidationResult {
  txHash: Hash;
  /** bytes32 keccak256 of the request file — primary key in ValidationRegistry */
  requestHash: `0x${string}`;
}

export interface SubmitValidationResponseParams {
  /** bytes32 requestHash returned by requestValidation() */
  requestHash: `0x${string}`;
  /** 0–100; 100 = passed, 0 = failed */
  response: number;
  agentId: number;
  /** Address of the validator EOA (stored in the off-chain JSON). */
  validatorAddress: string;
  notes?: string;
}

export interface SubmitValidationResponseResult {
  txHash: Hash;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizePrivateKey(raw: string): `0x${string}` {
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}

function loadOwnerPrivateKey(): `0x${string}` {
  const raw = process.env.ERC8004_PRIVATE_KEY;
  if (!raw) throw new Error("ERC8004_PRIVATE_KEY (Agent 2 owner) is not set");
  return normalizePrivateKey(raw);
}

function loadValidatorPrivateKey(): `0x${string}` {
  const raw = process.env.VALIDATOR_PRIVATE_KEY ?? process.env.PAYER_PRIVATE_KEY;
  if (!raw) throw new Error("VALIDATOR_PRIVATE_KEY or PAYER_PRIVATE_KEY is not set");
  return normalizePrivateKey(raw);
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
  if (!data.IpfsHash) throw new Error(`Pinata response missing IpfsHash: ${JSON.stringify(data)}`);
  return data.IpfsHash;
}

// ---------------------------------------------------------------------------
// requestValidation
// ---------------------------------------------------------------------------
export async function requestValidation(
  params: RequestValidationParams
): Promise<RequestValidationResult> {
  const {
    agentId,
    inputImageHash,
    outputImageHash,
    contextId,
    taskId,
    paymentTxHash,
    validatorAddress,
  } = params;

  // ── Env ────────────────────────────────────────────────────────────────────
  const pinatajwt = process.env.PINATA_JWT;
  if (!pinatajwt) throw new Error("PINATA_JWT is not set");

  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

  // ── Registry config ────────────────────────────────────────────────────────
  const raw = await readFile(CONTRACTS_FILE, "utf-8");
  const { chainId, identityRegistry, validationRegistry } = JSON.parse(raw) as {
    chainId: number;
    identityRegistry: Address;
    validationRegistry: Address;
  };

  const agentRegistry = `eip155:${chainId}:${identityRegistry}`;

  // ── Step 1: Build validation request file ─────────────────────────────────
  //
  // The file documents exactly what was validated:
  //   - which agent performed the task
  //   - what the input was (by hash — not the actual image)
  //   - what the output was (by hash)
  //   - the A2A task context for cross-referencing with reputation feedback
  //   - payment proof, so the request is tied to a real economic event
  const requestFile: ValidationRequestFile = {
    agentRegistry,
    agentId,
    task: "grayscale-conversion",
    input: { imageHash: inputImageHash },
    output: { imageHash: outputImageHash },
    a2a: { contextId, taskId },
    proofOfPayment: { txHash: paymentTxHash, chainId: String(chainId) },
    timestamp: new Date().toISOString(),
  };

  // ── Step 2: Upload to IPFS ─────────────────────────────────────────────────
  const requestCID = await pinToIPFS(pinatajwt, requestFile);
  const requestURI = `ipfs://${requestCID}`;

  // ── Step 3: keccak256 of the canonical JSON ────────────────────────────────
  //
  // requestHash is the primary key used by the ValidationRegistry and by
  // any validator that later wants to confirm or respond to this request.
  // Hashing JSON.stringify(requestFile) is deterministic because key insertion
  // order is stable (ES2015+) and no values are undefined.
  const requestJson = JSON.stringify(requestFile);
  const requestHash = keccak256(stringToBytes(requestJson));

  // ── Step 4: Submit to ValidationRegistry ──────────────────────────────────
  //
  // validationRequest() must be called by the owner or an approved operator
  // of the agentId in the IdentityRegistry — not by a random address.
  // We use ERC8004_PRIVATE_KEY which should be the agent owner's key.
  //
  const account = privateKeyToAccount(loadOwnerPrivateKey());

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpc),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpc),
  });

  // The owner requests validation from an independent validator. In this demo
  // Agent 1 (the payer) also acts as the validator, so the existing two-wallet
  // setup is sufficient and self-validation is avoided.
  const txHash = await walletClient.writeContract({
    address: validationRegistry,
    abi: VALIDATION_REGISTRY_ABI,
    functionName: "validationRequest",
    args: [validatorAddress as Address, BigInt(agentId), requestURI, requestHash],
    account,
    chain: baseSepolia,
  });

  // ── Step 5: Confirm and return ─────────────────────────────────────────────
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  if (receipt.status !== "success") {
    throw new Error(`validationRequest() tx reverted. Hash: ${txHash}`);
  }

  // Verify the event was emitted with the expected requestHash.
  // (The contract derives its own hash from the args — we confirm they match.)
  const logs = parseEventLogs({
    abi: VALIDATION_REGISTRY_ABI,
    eventName: "ValidationRequest",
    logs: receipt.logs,
  });

  if (logs.length > 0 && logs[0].args.requestHash !== requestHash) {
    // Should never happen — means our local hash diverged from the contract's.
    console.warn(
      `[validation] Warning: local requestHash ${requestHash} ` +
      `≠ on-chain ${logs[0].args.requestHash}`
    );
  }

  return { txHash, requestHash };
}

// ---------------------------------------------------------------------------
// submitValidationResponse
//
// Called by the independent validator after
// requestValidation(). Records the pass/fail outcome on-chain and links to
// an off-chain JSON file that describes the response in detail.
// ---------------------------------------------------------------------------
export async function submitValidationResponse(
  params: SubmitValidationResponseParams
): Promise<SubmitValidationResponseResult> {
  const { requestHash, response, agentId, validatorAddress, notes } = params;

  // ── Env ────────────────────────────────────────────────────────────────────
  const pinatajwt = process.env.PINATA_JWT;
  if (!pinatajwt) throw new Error("PINATA_JWT is not set");

  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

  // ── Registry config ────────────────────────────────────────────────────────
  const raw = await readFile(CONTRACTS_FILE, "utf-8");
  const { validationRegistry } = JSON.parse(raw) as {
    validationRegistry: Address;
  };

  // ── Step 1: Build response file ───────────────────────────────────────────
  const responseFile = {
    requestHash,
    response,
    agentId,
    validator: validatorAddress,
    notes: notes ?? "Self-attested validation",
    timestamp: new Date().toISOString(),
  };

  // ── Step 2: Upload to IPFS ─────────────────────────────────────────────────
  const responseCID = await pinToIPFS(pinatajwt, responseFile);
  const responseURI = `ipfs://${responseCID}`;

  // ── Step 3: keccak256 of the canonical JSON ────────────────────────────────
  const responseJson = JSON.stringify(responseFile);
  const responseHash = keccak256(stringToBytes(responseJson));

  // ── Step 4: Submit on-chain ────────────────────────────────────────────────
  //
  // The response must be signed by the validator selected in the request.
  // PAYER_PRIVATE_KEY is the default validator key for the two-wallet demo.
  const account = privateKeyToAccount(loadValidatorPrivateKey());

  if (validatorAddress.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `Validator key resolves to ${account.address}, but request expects ${validatorAddress}`
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
    address: validationRegistry,
    abi: VALIDATION_REGISTRY_ABI,
    functionName: "validationResponse",
    args: [requestHash, response, responseURI, responseHash, "grayscale-conversion"],
    account,
    chain: baseSepolia,
  });

  // ── Step 5: Wait for confirmation ─────────────────────────────────────────
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  if (receipt.status !== "success") {
    throw new Error(`validationResponse() tx reverted. Hash: ${txHash}`);
  }

  return { txHash };
}
