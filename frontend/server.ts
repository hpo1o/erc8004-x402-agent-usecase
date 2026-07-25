// ---------------------------------------------------------------------------
// frontend/server.ts — self-contained Express server
//
// No imports from ../erc8004/ or ../image-generator/.
// All blockchain, payment, and AI logic is inlined here.
// Registry addresses are hardcoded (Base Sepolia, deterministic via CREATE2).
// ---------------------------------------------------------------------------

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import OpenAI from "openai";
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
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(resolve(__dir, ".env")); } catch { /* shell / Railway */ }

// ---------------------------------------------------------------------------
// Registry constants — Base Sepolia, chainId 84532
// Addresses are deterministic via CREATE2 (same on all EVM networks).
// ---------------------------------------------------------------------------
const COLORIZER_AGENT_ID  = 2214;
const CHAIN_ID            = 84532;
const IDENTITY_REGISTRY   = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Address;
const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as Address;
const AGENT_REGISTRY_STR  = `eip155:${CHAIN_ID}:${IDENTITY_REGISTRY}`;
const FALLBACK_ENDPOINT   = "https://erc8004-agent-demo-production.up.railway.app/agent";
const DEFAULT_AGENT_WALLET = "0x171c4E80E4cA6bBe95Eb38D9d226b52897350dBb" as Address;
const X402_NETWORK        = "eip155:84532" as const;
const IPFS_GATEWAYS       = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
];

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

// Identity Registry: tokenURI, ownerOf, getAgentWallet
const IDENTITY_ABI = [
  {
    inputs:  [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ internalType: "string",  name: "",        type: "string"  }],
    stateMutability: "view", type: "function",
  },
  {
    inputs:  [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "",        type: "address" }],
    stateMutability: "view", type: "function",
  },
  {
    inputs:  [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "getAgentWallet",
    outputs: [{ internalType: "address", name: "",        type: "address" }],
    stateMutability: "view", type: "function",
  },
] as const;

// Reputation Registry: giveFeedback, NewFeedback event, getSummary
const REPUTATION_ABI = [
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
    name: "giveFeedback", outputs: [], stateMutability: "nonpayable", type: "function",
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
    name: "NewFeedback", type: "event",
  },
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "getClients",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view", type: "function",
  },
  {
    inputs: [
      { internalType: "uint256",   name: "agentId",         type: "uint256"   },
      { internalType: "address[]", name: "clientAddresses", type: "address[]" },
      { internalType: "string",    name: "tag1",            type: "string"    },
      { internalType: "string",    name: "tag2",            type: "string"    },
    ],
    name: "getSummary",
    outputs: [
      { internalType: "uint64", name: "count",                type: "uint64" },
      { internalType: "int128", name: "summaryValue",         type: "int128" },
      { internalType: "uint8",  name: "summaryValueDecimals", type: "uint8"  },
    ],
    stateMutability: "view", type: "function",
  },
] as const;

// Validation Registry: validationRequest, ValidationRequest event,
//                      validationResponse, ValidationResponse event
const VALIDATION_ABI = [
  {
    inputs: [
      { internalType: "address", name: "validatorAddress", type: "address" },
      { internalType: "uint256", name: "agentId",          type: "uint256" },
      { internalType: "string",  name: "requestURI",       type: "string"  },
      { internalType: "bytes32", name: "requestHash",      type: "bytes32" },
    ],
    name: "validationRequest", outputs: [], stateMutability: "nonpayable", type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  internalType: "address", name: "validatorAddress", type: "address" },
      { indexed: true,  internalType: "uint256", name: "agentId",          type: "uint256" },
      { indexed: false, internalType: "string",  name: "requestURI",       type: "string"  },
      { indexed: true,  internalType: "bytes32", name: "requestHash",      type: "bytes32" },
    ],
    name: "ValidationRequest", type: "event",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "requestHash",  type: "bytes32" },
      { internalType: "uint8",   name: "response",     type: "uint8"   },
      { internalType: "string",  name: "responseURI",  type: "string"  },
      { internalType: "bytes32", name: "responseHash", type: "bytes32" },
      { internalType: "string",  name: "tag",          type: "string"  },
    ],
    name: "validationResponse", outputs: [], stateMutability: "nonpayable", type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// SSE types
// ---------------------------------------------------------------------------
type SSEEvent =
  | { type: "step";         n: number; total: number; label: string }
  | { type: "log";          message: string }
  | { type: "input_image";  data: string }
  | { type: "output_image"; data: string }
  | { type: "proof";        paymentTxHash: string; requestHash?: string;
                             validationTxHash?: string; validationResponseTxHash?: string;
                             agentId: number; agentIdentifier: string }
  | { type: "done" }
  | { type: "error";        message: string };

function makeSseEmitter(res: Response) {
  return (event: SSEEvent): void => { res.write(`data: ${JSON.stringify(event)}\n\n`); };
}

// ---------------------------------------------------------------------------
// viem clients (shared, lazy-initialized per request via rpc env)
// ---------------------------------------------------------------------------
function publicClient() {
  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
  return createPublicClient({ chain: baseSepolia, transport: http(rpc) });
}

function walletClientFromEnv(name: "ERC8004_PRIVATE_KEY" | "PAYER_PRIVATE_KEY") {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
  return { account, wallet: createWalletClient({ account, chain: baseSepolia, transport: http(rpc) }) };
}

const agentOwnerWalletClient = () => walletClientFromEnv("ERC8004_PRIVATE_KEY");
const payerWalletClient = () => walletClientFromEnv("PAYER_PRIVATE_KEY");

// ---------------------------------------------------------------------------
// IPFS helper
// ---------------------------------------------------------------------------
async function pinToIPFS(content: unknown): Promise<string> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is not set");
  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ pinataContent: content, pinataOptions: { cidVersion: 1 } }),
  });
  if (!res.ok) throw new Error(`Pinata upload failed (HTTP ${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { IpfsHash: string };
  if (!data.IpfsHash) throw new Error(`Pinata response missing IpfsHash`);
  return data.IpfsHash;
}

// ---------------------------------------------------------------------------
// ERC-8004 Discovery
// ---------------------------------------------------------------------------
interface AgentInfo {
  agentId: number;
  agentIdentifier: string;
  agentURI: string;
  endpoint: string;
  owner: Address;
  agentWallet: Address;
}

let cachedAgent: AgentInfo | null = null;
let cacheExpires = 0;

async function discoverColorizer(): Promise<AgentInfo> {
  if (cachedAgent && Date.now() < cacheExpires) return cachedAgent;

  const client = publicClient();
  const agentIdBig = BigInt(COLORIZER_AGENT_ID);

  let agentURI: string;
  let owner: Address;
  let agentWallet: Address;

  try {
    [agentURI, owner, agentWallet] = await Promise.all([
      client.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "tokenURI",       args: [agentIdBig] }) as Promise<string>,
      client.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "ownerOf",        args: [agentIdBig] }) as Promise<Address>,
      client.readContract({ address: IDENTITY_REGISTRY, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [agentIdBig] }) as Promise<Address>,
    ]);
  } catch {
    // Chain unreachable — fall back to known Railway URL
    console.warn("[discovery] chain read failed, using fallback endpoint");
    const info: AgentInfo = {
      agentId: COLORIZER_AGENT_ID,
      agentIdentifier: `${AGENT_REGISTRY_STR}/${COLORIZER_AGENT_ID}`,
      agentURI: "",
      endpoint: FALLBACK_ENDPOINT,
      owner: "0x0000000000000000000000000000000000000000",
      agentWallet: "0x0000000000000000000000000000000000000000",
    };
    cachedAgent = info;
    cacheExpires = Date.now() + 5 * 60 * 1000;
    return info;
  }

  // Fetch registration file from IPFS
  let endpoint = FALLBACK_ENDPOINT;
  if (agentURI) {
    const cid = agentURI.startsWith("ipfs://") ? agentURI.slice(7) : null;
    if (cid) {
      for (const gw of IPFS_GATEWAYS) {
        try {
          const r = await fetch(`${gw}${cid}`);
          if (r.ok) {
            const reg = (await r.json()) as { services?: Array<{ name: string; endpoint: string }> };
            const a2a = reg.services?.find(s => s.name.toLowerCase() === "a2a");
            if (a2a?.endpoint) { endpoint = a2a.endpoint; break; }
          }
        } catch { /* try next gateway */ }
      }
    }
  }

  const info: AgentInfo = {
    agentId: COLORIZER_AGENT_ID,
    agentIdentifier: `${AGENT_REGISTRY_STR}/${COLORIZER_AGENT_ID}`,
    agentURI,
    endpoint,
    owner,
    agentWallet,
  };
  cachedAgent = info;
  cacheExpires = Date.now() + 5 * 60 * 1000;
  return info;
}

// ---------------------------------------------------------------------------
// GPT Image 2 image generation
// ---------------------------------------------------------------------------
async function generateImage(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured. Add it in Vercel → Project Settings → Environment Variables, then redeploy."
    );
  }

  const client = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 1 });
  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2";

  let response: Awaited<ReturnType<typeof client.images.generate>>;
  try {
    response = await client.images.generate({
      model,
      prompt,
      n: 1,
      size: "1024x1024",
      quality: "low",
    });
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      const code = (err as InstanceType<typeof OpenAI.APIError> & { code?: string }).code;
      const suffix = code ? `/${code}` : "";
      let hint = "Check the OpenAI project, API key, and image-model access.";
      if (err.status === 401) hint = "The Vercel OPENAI_API_KEY is invalid or expired.";
      if (err.status === 403 || err.status === 404) hint = `The API project cannot access ${model}.`;
      if (err.status === 429) hint = "The API project has no available quota or hit its image rate limit.";
      throw new Error(`OpenAI image generation failed (HTTP ${err.status ?? "unknown"}${suffix}). ${hint}`);
    }
    throw new Error(`OpenAI image generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned an empty image response");

  const optimized = await sharp(Buffer.from(b64, "base64"))
    .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return optimized.toString("base64");
}

// ---------------------------------------------------------------------------
// x402 + A2A colorizer client (auto-confirm — no readline)
// ---------------------------------------------------------------------------
interface A2ATextPart { kind?: string; type?: string; text: string }
interface A2ATask {
  kind: "task"; id: string; contextId: string;
  status: { state: string; message?: { parts: A2ATextPart[] } };
  artifacts?: Array<{ parts: A2ATextPart[] }>;
  history?: Array<{ role: string; parts: A2ATextPart[] }>;
}
interface A2AResponse { jsonrpc: "2.0"; id: number; result?: A2ATask; error?: { code: number; message: string } }

function buildA2ABody(imageDataUrl: string): { body: string } {
  const payload = {
    jsonrpc: "2.0", method: "message/send",
    params: { message: { kind: "message", messageId: randomUUID(), role: "user", parts: [{ kind: "text", text: imageDataUrl }] } },
    id: 1,
  };
  return { body: JSON.stringify(payload) };
}

function extractGrayscaleBase64(response: A2AResponse): string {
  if (response.error) throw new Error(`A2A error ${response.error.code}: ${response.error.message}`);
  if (!response.result) throw new Error("A2A response has no result");
  const anyText = (parts: A2ATextPart[]) => parts.find(p => p.text)?.text;
  const fromDataUrl = (t: string) => t.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/)?.[0];
  const { result } = response;
  if (result.artifacts) {
    for (const a of result.artifacts) {
      const t = anyText(a.parts); if (t) return (fromDataUrl(t) ?? t).replace(/^data:image\/[a-z]+;base64,/, "");
    }
  }
  if (result.history) {
    for (let i = result.history.length - 1; i >= 0; i--) {
      const msg = result.history[i];
      if (msg.role !== "agent") continue;
      const t = anyText(msg.parts); if (t) return (fromDataUrl(t) ?? t).replace(/^data:image\/[a-z]+;base64,/, "");
    }
  }
  if (result.status?.message?.parts) {
    const t = anyText(result.status.message.parts);
    if (t) return (fromDataUrl(t) ?? t).replace(/^data:image\/[a-z]+;base64,/, "");
  }
  throw new Error(`Agent returned state "${result.status.state}" with no extractable image output`);
}

async function sendToColorizerWeb(
  imageBase64: string,
  colorizerUrl: string,
  emit: ReturnType<typeof makeSseEmitter>
): Promise<{ grayscaleBase64: string; txHash: string; contextId: string; taskId: string }> {
  const { body } = buildA2ABody(`data:image/png;base64,${imageBase64}`);

  emit({ type: "log", message: `→ POST ${colorizerUrl}` });

  let initialRes: Response | undefined;
  const maxFacilitatorInitAttempts = 4;

  for (let attempt = 1; attempt <= maxFacilitatorInitAttempts; attempt++) {
    const candidate = await fetch(colorizerUrl, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });

    if (candidate.ok || candidate.status === 402) {
      initialRes = candidate;
      break;
    }

    const errorBody = await candidate.text();
    const facilitatorNotReady =
      errorBody.includes("no supported payment kinds loaded from any facilitator");

    if (!facilitatorNotReady) {
      throw new Error(`Unexpected ${candidate.status}: ${errorBody}`);
    }

    if (attempt === maxFacilitatorInitAttempts) {
      throw new Error(
        `x402 facilitator initialization failed after ${maxFacilitatorInitAttempts} attempts. ` +
        "The public testnet facilitator may be temporarily unavailable."
      );
    }

    const retryDelayMs = 1_250 * attempt;
    emit({
      type: "log",
      message: `→ x402 facilitator is temporarily unavailable; retrying in ${retryDelayMs}ms...`,
    });
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }

  if (!initialRes) throw new Error("Agent 2 did not return a response");

  if (initialRes.status !== 402) {
    const data = (await initialRes.json()) as A2AResponse;
    return { grayscaleBase64: extractGrayscaleBase64(data), txHash: "no-payment-required",
             contextId: data.result?.contextId ?? "", taskId: data.result?.id ?? "" };
  }

  const responseBody = await initialRes.json().catch(() => null);
  const x402Core = new x402Client();
  const rawPayerKey = process.env.PAYER_PRIVATE_KEY?.trim();
  if (!rawPayerKey) {
    throw new Error(
      "PAYER_PRIVATE_KEY is not configured. It is required when Agent 2 requests x402 payment."
    );
  }
  const payerKey = (rawPayerKey.startsWith("0x") ? rawPayerKey : `0x${rawPayerKey}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(payerKey)) {
    throw new Error("PAYER_PRIVATE_KEY must be a 32-byte hexadecimal private key.");
  }
  const payerAccount = privateKeyToAccount(payerKey);
  x402Core.register("eip155:84532", new ExactEvmScheme(payerAccount));
  const x402Http = new x402HTTPClient(x402Core);

  const paymentRequired = x402Http.getPaymentRequiredResponse((h) => initialRes.headers.get(h), responseBody);

  emit({ type: "log", message: "→ Signing EIP-3009 payment (auto-confirmed)..." });
  const paymentPayload = await x402Http.createPaymentPayload(paymentRequired);
  const paymentHeaders = x402Http.encodePaymentSignatureHeader(paymentPayload);

  emit({ type: "log", message: "→ Retrying with PAYMENT-SIGNATURE header..." });
  const paidRes = await fetch(colorizerUrl, {
    method: "POST", headers: { "Content-Type": "application/json", ...paymentHeaders }, body,
  });

  if (!paidRes.ok) throw new Error(`Payment rejected (${paidRes.status}): ${await paidRes.text()}`);

  let txHash = "pending";
  try { txHash = x402Http.getPaymentSettleResponse((h) => paidRes.headers.get(h)).transaction; }
  catch { /* async settlement */ }

  const data = (await paidRes.json()) as A2AResponse;
  return { grayscaleBase64: extractGrayscaleBase64(data), txHash,
           contextId: data.result?.contextId ?? "", taskId: data.result?.id ?? "" };
}

// ---------------------------------------------------------------------------
// ERC-8004 Reputation feedback
// ---------------------------------------------------------------------------
async function submitFeedback(params: {
  agentId: number; contextId: string; taskId: string;
  paymentTxHash: string; paymentFrom: string; paymentTo: string;
  success: boolean; responseTimeMs: number; endpoint: string;
}): Promise<{ txHash: Hash; feedbackCID: string; feedbackIndex: bigint }> {
  const { agentId, contextId, taskId, paymentTxHash, paymentFrom, paymentTo,
          success, responseTimeMs, endpoint } = params;

  const { account, wallet } = payerWalletClient();

  if (paymentFrom.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`PAYER_PRIVATE_KEY resolves to ${account.address}, but paymentFrom is ${paymentFrom}`);
  }

  const value = success ? 100 : 0;
  const feedbackFile = {
    agentRegistry: AGENT_REGISTRY_STR, agentId,
    clientAddress: `eip155:${CHAIN_ID}:${paymentFrom}`,
    createdAt: new Date().toISOString(),
    value, valueDecimals: 0, tag1: "successRate", endpoint,
    a2a: { contextId, taskId },
    proofOfPayment: { fromAddress: paymentFrom, toAddress: paymentTo, chainId: String(CHAIN_ID), txHash: paymentTxHash },
    responseTimeMs,
  };

  const feedbackCID = await pinToIPFS(feedbackFile);
  const feedbackURI = `ipfs://${feedbackCID}`;
  const feedbackHash = keccak256(stringToBytes(JSON.stringify(feedbackFile)));

  const txHash = await wallet.writeContract({
    address: REPUTATION_REGISTRY, abi: REPUTATION_ABI, functionName: "giveFeedback",
    args: [BigInt(agentId), BigInt(value), 0, "successRate", "", endpoint, feedbackURI, feedbackHash],
    account, chain: baseSepolia,
  });

  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`giveFeedback() reverted. Hash: ${txHash}`);

  const logs = parseEventLogs({ abi: REPUTATION_ABI, eventName: "NewFeedback", logs: receipt.logs });
  if (logs.length === 0) throw new Error(`NewFeedback event not found in tx ${txHash}`);

  return { txHash, feedbackCID, feedbackIndex: logs[0].args.feedbackIndex };
}

// ---------------------------------------------------------------------------
// ERC-8004 Validation request
// ---------------------------------------------------------------------------
async function submitValidationRequest(params: {
  agentId: number; inputImageHash: `0x${string}`; outputImageHash: `0x${string}`;
  contextId: string; taskId: string; paymentTxHash: string; validatorAddress: Address;
}): Promise<{ txHash: Hash; requestHash: `0x${string}` }> {
  const { agentId, inputImageHash, outputImageHash, contextId, taskId, paymentTxHash, validatorAddress } = params;

  const { account, wallet } = agentOwnerWalletClient();

  const requestFile = {
    agentRegistry: AGENT_REGISTRY_STR, agentId,
    task: "grayscale-conversion",
    input: { imageHash: inputImageHash },
    output: { imageHash: outputImageHash },
    a2a: { contextId, taskId },
    proofOfPayment: { txHash: paymentTxHash, chainId: String(CHAIN_ID) },
    timestamp: new Date().toISOString(),
  };

  const pinataCID = await pinToIPFS(requestFile);
  const requestURI = `ipfs://${pinataCID}`;
  const requestHash = keccak256(stringToBytes(JSON.stringify(requestFile)));

  const txHash = await wallet.writeContract({
    address: VALIDATION_REGISTRY, abi: VALIDATION_ABI, functionName: "validationRequest",
    args: [validatorAddress, BigInt(agentId), requestURI, requestHash],
    account, chain: baseSepolia,
  });

  // Wait for an extra block so every backend behind a load-balanced public RPC
  // can observe the request before the validator submits its response.
  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, confirmations: 2 });
  if (receipt.status !== "success") throw new Error(`validationRequest() reverted. Hash: ${txHash}`);

  return { txHash, requestHash };
}

// ---------------------------------------------------------------------------
// ERC-8004 Validation response
// ---------------------------------------------------------------------------
async function submitValidationResponse(params: {
  requestHash: `0x${string}`; response: number;
  agentId: number; validatorAddress: string; notes?: string;
}): Promise<{ txHash: Hash }> {
  const { requestHash, response, agentId, validatorAddress, notes } = params;

  const { account, wallet } = payerWalletClient();

  if (validatorAddress.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Validator key resolves to ${account.address}, but request expects ${validatorAddress}`);
  }

  const responseFile = {
    requestHash, response, agentId,
    validator: validatorAddress,
    notes: notes ?? "Self-attested validation",
    timestamp: new Date().toISOString(),
  };

  const pinataCID = await pinToIPFS(responseFile);
  const responseURI = `ipfs://${pinataCID}`;
  const responseHash = keccak256(stringToBytes(JSON.stringify(responseFile)));

  let txHash: Hash | undefined;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      txHash = await wallet.writeContract({
        address: VALIDATION_REGISTRY, abi: VALIDATION_ABI, functionName: "validationResponse",
        args: [requestHash, response, responseURI, responseHash, "grayscale-conversion"],
        account, chain: baseSepolia,
      });
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const requestNotVisible =
        message.includes('reason: unknown') || message.includes('execution reverted: unknown');

      if (!requestNotVisible || attempt === maxAttempts) throw err;

      // Public Base Sepolia RPC is load-balanced. A backend can briefly lag
      // behind the node that returned the validationRequest receipt.
      await new Promise(resolve => setTimeout(resolve, 1_500 * attempt));
    }
  }

  if (!txHash) throw new Error("validationResponse() was not submitted");

  const receipt = await publicClient().waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`validationResponse() reverted. Hash: ${txHash}`);

  return { txHash };
}

// ---------------------------------------------------------------------------
// Reputation reader (GET /api/reputation)
// ---------------------------------------------------------------------------
async function readReputation(agentId: number) {
  const client = publicClient();
  const clients = await client.readContract({
    address: REPUTATION_REGISTRY, abi: REPUTATION_ABI, functionName: "getClients",
    args: [BigInt(agentId)],
  }) as readonly Address[];

  if (clients.length === 0) {
    return {
      agentId,
      agentName: "Colorizer Service",
      agentIdentifier: `${AGENT_REGISTRY_STR}/${agentId}`,
      totalCalls: 0,
      successRate: 0,
      summaryValue: 0,
    };
  }

  const [count, summaryValue] = await client.readContract({
    address: REPUTATION_REGISTRY, abi: REPUTATION_ABI, functionName: "getSummary",
    args: [BigInt(agentId), [...clients], "successRate", ""],
  });
  const totalCalls = Number(count);
  const successRate = totalCalls === 0 ? 0 : Math.round(Number(summaryValue) / totalCalls);
  return {
    agentId,
    agentName: "Colorizer Service",
    agentIdentifier: `${AGENT_REGISTRY_STR}/${agentId}`,
    totalCalls,
    successRate,
    summaryValue: Number(summaryValue),
  };
}

function embeddedColorizerEndpoint(): string {
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (process.env.VERCEL) {
    if (!vercelUrl) {
      throw new Error("VERCEL_URL is missing; cannot resolve the embedded paid Agent 2 endpoint.");
    }
    return `https://${vercelUrl}/api/agent`;
  }

  const configured = process.env.COLORIZER_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");

  return `http://127.0.0.1:${process.env.PORT ?? "3001"}/api/agent`;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
async function runPipeline(
  input: { type: "prompt"; prompt: string } | { type: "upload"; buffer: Buffer; mimeType: string },
  emit: ReturnType<typeof makeSseEmitter>
): Promise<void> {
  const TOTAL = 5;
  let paymentTxHash = "";
  let requestHash: string | undefined;
  let validationTxHash: string | undefined;
  let validationResponseTxHash: string | undefined;

  // ── Step 1: Discover Agent 2 ─────────────────────────────────────────────
  emit({ type: "step", n: 1, total: TOTAL, label: "Discovering Agent 2 via ERC-8004..." });
  const agent = await discoverColorizer();
  emit({ type: "log", message: `✓ Discovered: ${agent.endpoint} (agentId: ${agent.agentId})` });
  if (agent.agentWallet !== "0x0000000000000000000000000000000000000000") {
    emit({ type: "log", message: `  agentWallet: ${agent.agentWallet}` });
  }

  // ── Step 2: Generate or receive image ────────────────────────────────────
  let imageBase64: string;
  if (input.type === "prompt") {
    emit({ type: "step", n: 2, total: TOTAL, label: "Generating image with GPT Image 2..." });
    imageBase64 = await generateImage(input.prompt);
    emit({ type: "log", message: `✓ Image generated (≈${Math.round((imageBase64.length * 3) / 4 / 1024)} KB)` });
  } else {
    emit({ type: "step", n: 2, total: TOTAL, label: "Processing uploaded image..." });
    const pngBuffer = await sharp(input.buffer).png().toBuffer();
    imageBase64 = pngBuffer.toString("base64");
    emit({ type: "log", message: `✓ Upload received (≈${Math.round(pngBuffer.length / 1024)} KB)` });
  }
  emit({ type: "input_image", data: `data:image/png;base64,${imageBase64}` });

  // ── Step 3: Send to colorizer-service ───────────────────────────────────
  emit({ type: "step", n: 3, total: TOTAL, label: "Sending to Agent 2 (colorizer)..." });
  const colorizerEndpoint = embeddedColorizerEndpoint();
  if (colorizerEndpoint !== agent.endpoint) {
    emit({ type: "log", message: `→ Registered endpoint is unavailable; using embedded x402 Agent 2: ${colorizerEndpoint}` });
  }
  const startMs = Date.now();
  let usedLocalColorizer = false;
  let colorizerResult: Awaited<ReturnType<typeof sendToColorizerWeb>>;

  try {
    colorizerResult = await sendToColorizerWeb(imageBase64, colorizerEndpoint, emit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const endpointUnavailable =
      /(?:\b404\b|\b410\b|\b502\b|\b503\b|\b504\b|application not found|fetch failed|econnrefused|enotfound|timed?\s*out)/i.test(message);

    const allowLocalFallback = !process.env.VERCEL && process.env.ALLOW_LOCAL_COLORIZER_FALLBACK === "true";
    if (!endpointUnavailable || !allowLocalFallback) {
      if (endpointUnavailable) {
        throw new Error(
          `Paid Agent 2 is unavailable (${message}). No fallback was used, so no x402 transaction was charged.`
        );
      }
      throw err;
    }

    usedLocalColorizer = true;
    emit({
      type: "log",
      message: `⚠ Agent 2 unavailable (${message}). Using the local grayscale fallback.`,
    });

    const grayscaleBuffer = await sharp(Buffer.from(imageBase64, "base64"))
      .grayscale()
      .png({ compressionLevel: 9 })
      .toBuffer();

    colorizerResult = {
      grayscaleBase64: grayscaleBuffer.toString("base64"),
      txHash: "local-fallback",
      contextId: `local-${randomUUID()}`,
      taskId: `local-${randomUUID()}`,
    };
  }

  const { grayscaleBase64, txHash, contextId, taskId } = colorizerResult;
  const responseTimeMs = Date.now() - startMs;
  paymentTxHash = txHash;

  emit({ type: "log", message: `✓ Grayscale received (${responseTimeMs}ms)` });
  if (usedLocalColorizer) {
    emit({ type: "log", message: "⚠ x402 payment skipped because the local fallback was used" });
  } else if (!txHash.startsWith("MOCK_TX") && txHash !== "pending" && txHash !== "no-payment-required") {
    emit({ type: "log", message: `✓ Payment txHash: ${txHash}` });
  } else if (txHash.startsWith("MOCK_TX")) {
    emit({ type: "log", message: `⚠ Payment: MOCK (not a real transaction)` });
  }
  emit({ type: "output_image", data: `data:image/png;base64,${grayscaleBase64}` });

  // ── Steps 4–5: ERC-8004 (best-effort, requires PINATA_JWT + ERC8004_PRIVATE_KEY) ──
  const payerKey = process.env.PAYER_PRIVATE_KEY ?? "";
  if (usedLocalColorizer) {
    emit({ type: "log", message: "⚠ ERC-8004 proof steps skipped for local fallback output" });
  } else if (!payerKey) {
    emit({ type: "log", message: "⚠ PAYER_PRIVATE_KEY not set — skipping ERC-8004 steps" });
  } else {
    const payerAccount = privateKeyToAccount((payerKey.startsWith("0x") ? payerKey : `0x${payerKey}`) as `0x${string}`);

    // ── Step 4: Reputation ───────────────────────────────────────────────────
    emit({ type: "step", n: 4, total: TOTAL, label: "Recording reputation feedback..." });
    try {
      const fb = await submitFeedback({
        agentId: COLORIZER_AGENT_ID, contextId, taskId,
        paymentTxHash: txHash, paymentFrom: payerAccount.address,
        paymentTo: agent.agentWallet, success: true,
        responseTimeMs, endpoint: colorizerEndpoint,
      });
      emit({ type: "log", message: `✓ Feedback recorded (index: ${fb.feedbackIndex})` });
      emit({ type: "log", message: `  IPFS: ipfs://${fb.feedbackCID}` });
    } catch (err) {
      emit({ type: "log", message: `⚠ Reputation feedback skipped: ${err instanceof Error ? err.message : String(err)}` });
    }

    // ── Step 5: Validation ───────────────────────────────────────────────────
    emit({ type: "step", n: 5, total: TOTAL, label: "Submitting ERC-8004 validation..." });
    try {
      const inputHash  = keccak256(stringToBytes(imageBase64));
      const outputHash = keccak256(stringToBytes(grayscaleBase64));
      const val = await submitValidationRequest({
        agentId: COLORIZER_AGENT_ID, inputImageHash: inputHash, outputImageHash: outputHash,
        contextId, taskId, paymentTxHash: txHash, validatorAddress: payerAccount.address,
      });
      requestHash = val.requestHash;
      validationTxHash = val.txHash;
      emit({ type: "log", message: `✓ Validation request on-chain` });
      emit({ type: "log", message: `  requestHash: ${val.requestHash}` });

      try {
        const vr = await submitValidationResponse({
          requestHash: val.requestHash, response: 100,
          agentId: COLORIZER_AGENT_ID, validatorAddress: payerAccount.address,
        });
        validationResponseTxHash = vr.txHash;
        emit({ type: "log", message: `✓ Validation response submitted` });
      } catch (re) {
        emit({ type: "log", message: `⚠ Validation response skipped: ${re instanceof Error ? re.message : String(re)}` });
      }
    } catch (ve) {
      emit({ type: "log", message: `⚠ Validation skipped: ${ve instanceof Error ? ve.message : String(ve)}` });
    }
  }

  emit({ type: "proof", paymentTxHash, requestHash, validationTxHash,
         validationResponseTxHash, agentId: agent.agentId, agentIdentifier: agent.agentIdentifier });
  emit({ type: "done" });
}

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const configuredPaymentRecipient = process.env.PAYMENT_RECIPIENT_ADDRESS?.trim();
const paymentRecipient = (
  configuredPaymentRecipient && /^0x[0-9a-fA-F]{40}$/.test(configuredPaymentRecipient)
    ? configuredPaymentRecipient
    : DEFAULT_AGENT_WALLET
) as Address;
if (configuredPaymentRecipient && paymentRecipient === DEFAULT_AGENT_WALLET) {
  console.warn("[config] invalid PAYMENT_RECIPIENT_ADDRESS; using the registered Agent 2 wallet");
}

const defaultFacilitatorUrl = "https://x402.org/facilitator";
const configuredFacilitatorUrl = process.env.X402_FACILITATOR_URL?.trim();
let facilitatorUrl = defaultFacilitatorUrl;
if (configuredFacilitatorUrl) {
  try {
    const parsed = new URL(configuredFacilitatorUrl);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      facilitatorUrl = parsed.toString();
    } else {
      console.warn("[config] X402_FACILITATOR_URL must use HTTP(S); using the default facilitator");
    }
  } catch {
    console.warn("[config] invalid X402_FACILITATOR_URL; using the default facilitator");
  }
}

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
  .register(X402_NETWORK, new ExactEvmServerScheme());

app.use(paymentMiddleware(
  {
    "POST /api/agent": {
      accepts: [{
        scheme: "exact",
        price: "$0.01",
        network: X402_NETWORK,
        payTo: paymentRecipient,
      }],
      description: "Convert an image to grayscale with Agent 2",
      mimeType: "application/json",
    },
  },
  resourceServer
));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5, parts: 6 },
  fileFilter: (_req, file, callback) => {
    callback(null, file.mimetype.startsWith("image/"));
  },
});

const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const rateWindowMs = Number(process.env.PROCESS_RATE_LIMIT_WINDOW_MS ?? 60 * 60 * 1000);
const rateMax = Number(process.env.PROCESS_RATE_LIMIT_MAX ?? 10);

function processRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }
  const current = rateBuckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + rateWindowMs }
    : current;
  bucket.count += 1;
  rateBuckets.set(key, bucket);

  res.setHeader("X-RateLimit-Limit", String(rateMax));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, rateMax - bucket.count)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > rateMax) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    res.status(429).json({ error: "Too many generation requests. Try again later." });
    return;
  }
  next();
}

function requireAccessToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.SERVICE_ACCESS_TOKEN;
  if (!expected) {
    next();
    return;
  }
  const supplied = req.get("x-service-token") ?? "";
  const valid = supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) {
    res.status(401).json({ error: "Invalid or missing service access token." });
    return;
  }
  next();
}

app.use(express.json({ limit: "8mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(express.static(resolve(__dir, "public")));

// Vercel ignores express.static() for Express functions. Keep an explicit
// root handler as a runtime fallback; vercel.json rewrites / to /index.html
// before the request reaches the function.
app.get("/", (_req, res) => {
  res.sendFile(resolve(__dir, "public", "index.html"));
});

app.get("/health", (_req, res) => {
  const checks = {
    openaiApiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
    payerPrivateKey: Boolean(process.env.PAYER_PRIVATE_KEY?.trim()),
    serviceAccessToken: Boolean(process.env.SERVICE_ACCESS_TOKEN?.trim()),
  };
  res.json({
    status: checks.openaiApiKey ? "ok" : "degraded",
    service: "erc8004-frontend",
    runtime: process.env.VERCEL ? "vercel" : "node",
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/agent", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = req.body as {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: { message?: { parts?: Array<{ kind?: string; text?: string }> } };
    };

    if (request.jsonrpc !== "2.0" || request.method !== "message/send") {
      res.status(400).json({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32600, message: "Expected an A2A message/send request." },
      });
      return;
    }

    const imageDataUrl = request.params?.message?.parts
      ?.find((part) => part.kind === "text" && typeof part.text === "string")
      ?.text;
    const match = imageDataUrl?.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      res.status(400).json({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32602, message: "A base64 image data URL is required." },
      });
      return;
    }

    const source = Buffer.from(match[1], "base64");
    if (!source.length || source.length > 4 * 1024 * 1024) {
      res.status(413).json({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32602, message: "Image must be between 1 byte and 4 MB." },
      });
      return;
    }

    const grayscale = await sharp(source)
      .grayscale()
      .png({ compressionLevel: 9 })
      .toBuffer();
    const taskId = randomUUID();
    const contextId = randomUUID();

    res.json({
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "completed" },
        artifacts: [{
          artifactId: randomUUID(),
          name: "grayscale.png",
          parts: [{ kind: "text", text: `data:image/png;base64,${grayscale.toString("base64")}` }],
        }],
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/reputation", async (_req, res) => {
  try {
    res.json(await readReputation(COLORIZER_AGENT_ID));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post(
  "/api/process",
  processRateLimit,
  requireAccessToken,
  upload.single("image"),
  async (req: Request, res: Response) => {
    const input: Parameters<typeof runPipeline>[0] = req.file
      ? { type: "upload", buffer: req.file.buffer, mimeType: req.file.mimetype }
      : { type: "prompt", prompt: (req.body as { prompt?: string }).prompt ?? "" };

    if (input.type === "prompt") {
      input.prompt = input.prompt.trim();
      if (!input.prompt || input.prompt.length > 2000) {
        res.status(400).json({ error: "Prompt must contain 1–2000 characters." });
        return;
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");

    const emit = makeSseEmitter(res);
    try {
      await runPipeline(input, emit);
    } catch (err) {
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  }
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Invalid request";
  res.status(400).json({ error: message });
});

export const maxDuration = 300;
export default app;

if (!process.env.VERCEL) {
  const PORT = Number(process.env.PORT ?? 3001);
  app.listen(PORT, () => {
    console.log(`\n  ERC-8004 + x402 Frontend`);
    console.log(`  http://localhost:${PORT}\n`);
  });
}
