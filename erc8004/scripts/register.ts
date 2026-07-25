// ---------------------------------------------------------------------------
// erc8004/scripts/register.ts
//
// Registers both agents in the ERC-8004 Identity Registry on Base Sepolia.
//
// Flow for each agent:
//   1. Read registration file from erc8004/registration/<name>.json
//   2. Upload it to IPFS via Pinata → get CID (initial agentURI)
//   3. Call register(agentURI) on IdentityRegistry → get agentId from event
//   4. Patch registrations[] in the registration file with { agentRegistry, agentId }
//   5. Re-upload the updated file to IPFS → get new CID
//   6. Call setAgentURI(agentId, newURI) to point the NFT at the final file
//   7. Print summary: agentId, txHash, IPFS CID
//
// Usage:
//   npm run register          (from erc8004/)
//
// Required env vars (see erc8004/.env.example):
//   PINATA_JWT                JWT from pinata.cloud (for IPFS uploads)
//   ERC8004_PRIVATE_KEY       0x-prefixed 32-byte hex private key
//   BASE_SEPOLIA_RPC          RPC URL (default: https://sepolia.base.org)
// ---------------------------------------------------------------------------

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const ERC8004_ROOT = resolve(__dir, "..");
const REGISTRATION_DIR = resolve(ERC8004_ROOT, "registration");
const CONTRACTS_FILE = resolve(ERC8004_ROOT, "contracts", "registry-addresses.json");

// ---------------------------------------------------------------------------
// Load .env
// ---------------------------------------------------------------------------
const envPath = resolve(ERC8004_ROOT, ".env");
try {
  process.loadEnvFile(envPath);
} catch {
  // .env not present — env vars must come from shell
}

// ---------------------------------------------------------------------------
// ABI — only the functions and events this script uses.
// Source: https://github.com/erc-8004/erc-8004-contracts/blob/main/abis/IdentityRegistry.json
// ---------------------------------------------------------------------------
const IDENTITY_REGISTRY_ABI = [
  // register(string agentURI) → uint256 agentId
  {
    inputs: [{ internalType: "string", name: "agentURI", type: "string" }],
    name: "register",
    outputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  // setAgentURI(uint256 agentId, string newURI)
  {
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "string", name: "newURI", type: "string" },
    ],
    name: "setAgentURI",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // event Registered(uint256 indexed agentId, string agentURI, address indexed owner)
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agentId", type: "uint256" },
      { indexed: false, internalType: "string", name: "agentURI", type: "string" },
      { indexed: true, internalType: "address", name: "owner", type: "address" },
    ],
    name: "Registered",
    type: "event",
  },
  // event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agentId", type: "uint256" },
      { indexed: false, internalType: "string", name: "newURI", type: "string" },
      { indexed: true, internalType: "address", name: "updatedBy", type: "address" },
    ],
    name: "URIUpdated",
    type: "event",
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface RegistryAddresses {
  network: string;
  chainId: number;
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  validationRegistry: `0x${string}`;
}

interface RegistrationEntry {
  agentRegistry: string; // e.g. "eip155:84532:0x8004A818..."
  agentId: string;       // decimal string to preserve precision
}

interface RegistrationFile {
  type: string;
  name: string;
  description: string;
  registrations: RegistrationEntry[];
  [key: string]: unknown; // other fields passed through unchanged
}

// ---------------------------------------------------------------------------
// requireEnv — fail fast with a clear message
// ---------------------------------------------------------------------------
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\nError: env variable ${name} is not set.`);
    console.error(`Copy erc8004/.env.example → erc8004/.env and fill in the values.\n`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// pinToIPFS
//
// Uploads a JSON object to IPFS via the Pinata pinning API.
// Returns the IPFS CID (IpfsHash field).
//
// API docs: https://docs.pinata.cloud/api-reference/endpoint/ipfs/pin-json
// ---------------------------------------------------------------------------
async function pinToIPFS(
  jwt: string,
  content: unknown,
  filename: string
): Promise<string> {
  const body = {
    pinataContent: content,
    pinataMetadata: { name: filename },
    pinataOptions: { cidVersion: 1 },
  };

  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
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

// ---------------------------------------------------------------------------
// registerAgent
//
// Full registration flow for a single agent.
// ---------------------------------------------------------------------------
async function registerAgent(opts: {
  registrationFile: string;           // e.g. "colorizer.json"
  agentName: string;                  // for logging
  identityRegistryAddress: `0x${string}`;
  agentRegistry: string;              // e.g. "eip155:84532:0x8004A818..."
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: ReturnType<typeof createPublicClient<ReturnType<typeof http>, typeof baseSepolia>>;
  walletClient: ReturnType<typeof createWalletClient>;
  pinatajwt: string;
}): Promise<{ agentId: bigint; registerTxHash: string; setUriTxHash: string; finalCid: string }> {
  const {
    registrationFile,
    agentName,
    identityRegistryAddress,
    agentRegistry,
    account,
    publicClient,
    walletClient,
    pinatajwt,
  } = opts;

  const filePath = resolve(REGISTRATION_DIR, registrationFile);

  // ── Step 1: Read the registration file ───────────────────────────────────
  console.log(`\n[${agentName}] Reading ${registrationFile}...`);
  const raw = await readFile(filePath, "utf-8");
  const regFile = JSON.parse(raw) as RegistrationFile;
  console.log(`  ✓ Loaded: "${regFile.name}"`);

  // ── Step 2: Upload initial registration file to IPFS ────────────────────
  console.log(`[${agentName}] Uploading initial registration file to IPFS...`);
  const initialCid = await pinToIPFS(pinatajwt, regFile, registrationFile);
  const initialUri = `ipfs://${initialCid}`;
  console.log(`  ✓ CID: ${initialCid}`);
  console.log(`  ✓ URI: ${initialUri}`);

  // ── Step 3: Call register(agentURI) on IdentityRegistry ─────────────────
  console.log(`[${agentName}] Calling register("${initialUri}") on-chain...`);

  const registerHash = await walletClient.writeContract({
    address: identityRegistryAddress,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "register",
    args: [initialUri],
    account,
    chain: baseSepolia,
  });

  console.log(`  → tx submitted: ${registerHash}`);
  console.log(`  → waiting for confirmation...`);

  const registerReceipt = await publicClient.waitForTransactionReceipt({
    hash: registerHash,
    confirmations: 1,
  });

  if (registerReceipt.status !== "success") {
    throw new Error(`register() tx reverted. Hash: ${registerHash}`);
  }

  // ── Step 4: Extract agentId from the Registered event ───────────────────
  const registeredLogs = parseEventLogs({
    abi: IDENTITY_REGISTRY_ABI,
    eventName: "Registered",
    logs: registerReceipt.logs,
  });

  if (registeredLogs.length === 0) {
    throw new Error(`Registered event not found in tx ${registerHash}`);
  }

  const agentId = registeredLogs[0].args.agentId;
  console.log(`  ✓ Registered — agentId: ${agentId}`);

  // ── Step 5: Patch registrations[] in the registration file ──────────────
  // Replace the existing entry for this agentRegistry if present, otherwise append.
  console.log(`[${agentName}] Updating registrations[] in registration file...`);
  const newEntry = { agentRegistry, agentId: agentId.toString() };
  const existingIndex = regFile.registrations.findIndex(r => r.agentRegistry === agentRegistry);
  const updatedRegistrations =
    existingIndex >= 0
      ? regFile.registrations.map((r, i) => (i === existingIndex ? newEntry : r))
      : [...regFile.registrations, newEntry];
  const updatedRegFile: RegistrationFile = {
    ...regFile,
    registrations: updatedRegistrations,
  };

  // ── Step 6: Re-upload the updated file to IPFS ──────────────────────────
  console.log(`[${agentName}] Re-uploading updated registration file to IPFS...`);
  const finalCid = await pinToIPFS(pinatajwt, updatedRegFile, registrationFile);
  const finalUri = `ipfs://${finalCid}`;
  console.log(`  ✓ CID: ${finalCid}`);
  console.log(`  ✓ URI: ${finalUri}`);

  // ── Step 7: Call setAgentURI(agentId, finalUri) ──────────────────────────
  console.log(`[${agentName}] Calling setAgentURI(${agentId}, "${finalUri}") on-chain...`);

  const setUriHash = await walletClient.writeContract({
    address: identityRegistryAddress,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "setAgentURI",
    args: [agentId, finalUri],
    account,
    chain: baseSepolia,
  });

  console.log(`  → tx submitted: ${setUriHash}`);
  console.log(`  → waiting for confirmation...`);

  const setUriReceipt = await publicClient.waitForTransactionReceipt({
    hash: setUriHash,
    confirmations: 1,
  });

  if (setUriReceipt.status !== "success") {
    throw new Error(`setAgentURI() tx reverted. Hash: ${setUriHash}`);
  }

  console.log(`  ✓ URI updated on-chain`);

  // ── Step 8: Persist updated registration file to disk ───────────────────
  // Keep the local copy in sync with what's on IPFS + on-chain.
  await writeFile(filePath, JSON.stringify(updatedRegFile, null, 2) + "\n", "utf-8");
  console.log(`  ✓ ${registrationFile} updated on disk`);

  return {
    agentId,
    registerTxHash: registerHash,
    setUriTxHash: setUriHash,
    finalCid,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("\n=== ERC-8004 Agent Registration ===\n");

  // ── Validate env ──────────────────────────────────────────────────────────
  const pinatajwt = requireEnv("PINATA_JWT");
  const privateKey = requireEnv("ERC8004_PRIVATE_KEY");
  const rpcUrl = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

  const normalizedKey = (
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
  ) as `0x${string}`;

  // ── Load registry addresses ───────────────────────────────────────────────
  console.log("Loading registry-addresses.json...");
  const addressesRaw = await readFile(CONTRACTS_FILE, "utf-8");
  const addresses = JSON.parse(addressesRaw) as RegistryAddresses;

  if (addresses.identityRegistry === "0x0000000000000000000000000000000000000000") {
    console.error("\nError: identityRegistry address is still the zero address.");
    console.error("Update erc8004/contracts/registry-addresses.json with real addresses.\n");
    process.exit(1);
  }

  console.log(`  Network  : ${addresses.network} (chainId ${addresses.chainId})`);
  console.log(`  Identity : ${addresses.identityRegistry}`);

  // ── Set up viem clients ───────────────────────────────────────────────────
  const account = privateKeyToAccount(normalizedKey);
  console.log(`  Signer   : ${account.address}\n`);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  // ERC-8004 agentRegistry identifier: eip155:<chainId>:<identityRegistryAddress>
  const agentRegistry = `eip155:${addresses.chainId}:${addresses.identityRegistry}`;

  // ── Register both agents ──────────────────────────────────────────────────
  const agents: Array<{ file: string; label: string }> = [
    { file: "colorizer.json",       label: "Colorizer Service" },
    { file: "image-generator.json", label: "Image Generator"   },
  ];

  const results: Array<{
    label: string;
    agentId: bigint;
    registerTxHash: string;
    setUriTxHash: string;
    finalCid: string;
  }> = [];

  for (const agent of agents) {
    try {
      const result = await registerAgent({
        registrationFile: agent.file,
        agentName: agent.label,
        identityRegistryAddress: addresses.identityRegistry,
        agentRegistry,
        account,
        publicClient,
        walletClient,
        pinatajwt,
      });
      results.push({ label: agent.label, ...result });
    } catch (err) {
      console.error(`\n[${agent.label}] Registration failed:`);
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  // ── Print summary ─────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log("  REGISTRATION COMPLETE");
  console.log("═".repeat(60));

  const explorerBase = "https://sepolia.basescan.org";

  for (const r of results) {
    console.log(`\n  Agent     : ${r.label}`);
    console.log(`  agentId   : ${r.agentId}`);
    console.log(`  agentReg  : ${agentRegistry}/${r.agentId}`);
    console.log(`  register  : ${explorerBase}/tx/${r.registerTxHash}`);
    console.log(`  setURI    : ${explorerBase}/tx/${r.setUriTxHash}`);
    console.log(`  IPFS      : ipfs://${r.finalCid}`);
    console.log(`  Gateway   : https://gateway.pinata.cloud/ipfs/${r.finalCid}`);
  }

  console.log("\n  ✓ Both registration files updated on disk with agentId.\n");
}

main().catch((err: unknown) => {
  console.error("\nFatal error:");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
