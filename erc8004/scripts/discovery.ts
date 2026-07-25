// ---------------------------------------------------------------------------
// erc8004/scripts/discovery.ts
//
// Agent discovery via the ERC-8004 Identity Registry.
//
// This is the core promise of ERC-8004: "discover agents across
// organisational boundaries without pre-existing trust."
// Instead of hardcoding an endpoint, callers ask the on-chain registry
// what the current endpoint is — the agent owner can update it at any
// time via setAgentURI(), and all clients get the new address automatically.
//
// Discovery flow:
//   1. Read colorizer.json → registrations[last].agentId
//      (if empty → throw with hint to run `npm run register`)
//   2. publicClient.readContract tokenURI(agentId) → ipfs://<CID>
//      (on-chain source of truth for the registration file)
//   3. Fetch the registration file from IPFS via public gateway
//   4. Validate: type === ERC-8004#registration-v1, active === true
//   5. Find the A2A endpoint in services[]
//   6. Return AgentInfo
//
// Exports:
//   discoverColorizer()         → AgentInfo   (hardcoded to colorizer.json)
//   discoverAgent(agentId)      → AgentInfo   (general-purpose)
//   fetchRegistrationFile(uri)  → RegistrationFile (IPFS/HTTPS fetch helper)
//
// CLI usage (from erc8004/):
//   npm run discover
//
// Required env vars:
//   BASE_SEPOLIA_RPC — optional, default: https://sepolia.base.org
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Address } from "viem";
import { baseSepolia } from "viem/chains";

// ---------------------------------------------------------------------------
// Paths & env
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const ERC8004_ROOT = resolve(__dir, "..");
const CONTRACTS_FILE = resolve(ERC8004_ROOT, "contracts", "registry-addresses.json");
const COLORIZER_REG_FILE = resolve(ERC8004_ROOT, "registration", "colorizer.json");

try {
  process.loadEnvFile(resolve(ERC8004_ROOT, ".env"));
} catch { /* .env absent — vars from shell */ }

// ---------------------------------------------------------------------------
// ABI — only the read functions needed for discovery.
// Source: https://github.com/erc-8004/erc-8004-contracts/blob/main/abis/IdentityRegistry.json
// ---------------------------------------------------------------------------
const IDENTITY_REGISTRY_ABI = [
  // tokenURI(uint256 tokenId) → string   — returns the agentURI (ipfs:// or https://)
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  // ownerOf(uint256 tokenId) → address
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  // getAgentWallet(uint256 agentId) → address
  {
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    name: "getAgentWallet",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry in services[] of the ERC-8004 registration file. */
export interface ServiceEntry {
  name: string;
  endpoint: string;
  version?: string;
  description?: string;
}

/** Parsed ERC-8004 registration file (agentURI resolves to this). */
export interface RegistrationFile {
  type: string;
  name: string;
  description: string;
  image?: string;
  active: boolean;
  x402Support?: boolean;
  supportedTrust?: string[];
  services: ServiceEntry[];
  skills?: unknown[];
  registrations: Array<{ agentRegistry: string; agentId: string }>;
}

/** Result returned by discoverAgent / discoverColorizer. */
export interface AgentInfo {
  /** ERC-721 token ID in the IdentityRegistry */
  agentId: number;
  /** Full ERC-8004 agent identifier: eip155:<chainId>:<registryAddress>/<tokenId> */
  agentIdentifier: string;
  /** IPFS or HTTPS URI of the registration file (from on-chain tokenURI) */
  agentURI: string;
  /** A2A endpoint URL extracted from services[] */
  endpoint: string;
  /** NFT owner address */
  owner: Address;
  /** Receiving wallet registered via setAgentWallet (may equal owner) */
  agentWallet: Address;
  /** Full parsed registration file */
  registrationFile: RegistrationFile;
}

// ---------------------------------------------------------------------------
// IPFS gateway resolution
//
// Tries gateways in order, returns the first successful response.
// Using multiple gateways makes the fetch resilient to individual gateway
// outages — common in demo/testnet environments.
// ---------------------------------------------------------------------------
const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];

/**
 * Fetch and parse the ERC-8004 registration file from an IPFS or HTTPS URI.
 *
 * Supports:
 *   ipfs://<CID>          → tried against IPFS_GATEWAYS in order
 *   https://...           → fetched directly
 */
export async function fetchRegistrationFile(uri: string): Promise<RegistrationFile> {
  if (uri.startsWith("https://") || uri.startsWith("http://")) {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`Failed to fetch registration file from ${uri}: HTTP ${res.status}`);
    return res.json() as Promise<RegistrationFile>;
  }

  if (uri.startsWith("ipfs://")) {
    const cid = uri.slice("ipfs://".length);
    const errors: string[] = [];

    for (const gateway of IPFS_GATEWAYS) {
      try {
        const res = await fetch(`${gateway}${cid}`);
        if (res.ok) return res.json() as Promise<RegistrationFile>;
        errors.push(`${gateway}: HTTP ${res.status}`);
      } catch (e) {
        errors.push(`${gateway}: ${(e as Error).message}`);
      }
    }

    throw new Error(
      `Could not fetch IPFS file ${uri} from any gateway:\n` +
      errors.map(e => `  • ${e}`).join("\n")
    );
  }

  throw new Error(`Unsupported URI scheme: "${uri}". Expected ipfs:// or https://.`);
}

// ---------------------------------------------------------------------------
// discoverAgent — core discovery function
//
// Given an agentId, reads the on-chain tokenURI, fetches the registration
// file, validates it, and returns a structured AgentInfo.
// ---------------------------------------------------------------------------
export async function discoverAgent(agentId: number): Promise<AgentInfo> {
  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

  // ── Load registry address ──────────────────────────────────────────────────
  const raw = await readFile(CONTRACTS_FILE, "utf-8");
  const { chainId, identityRegistry } = JSON.parse(raw) as {
    chainId: number;
    identityRegistry: Address;
  };

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpc),
  });

  const agentIdBig = BigInt(agentId);

  // ── Step 1: Fetch tokenURI and owner from chain ────────────────────────────
  //
  // tokenURI is the authoritative pointer to the registration file.
  // The agent owner can update it at any time via setAgentURI().
  // We always read it fresh — never cache it locally.
  let agentURI: string;
  let owner: Address;
  let agentWallet: Address;

  try {
    [agentURI, owner, agentWallet] = await Promise.all([
      publicClient.readContract({
        address: identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "tokenURI",
        args: [agentIdBig],
      }) as Promise<string>,
      publicClient.readContract({
        address: identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "ownerOf",
        args: [agentIdBig],
      }) as Promise<Address>,
      publicClient.readContract({
        address: identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "getAgentWallet",
        args: [agentIdBig],
      }) as Promise<Address>,
    ]);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // ERC-721 reverts with ERC721NonexistentToken if the token doesn't exist.
    if (msg.includes("ERC721NonexistentToken") || msg.includes("nonexistent token")) {
      throw new Error(
        `Agent #${agentId} does not exist in IdentityRegistry (${identityRegistry}).\n` +
        `Run: npm run register   (from erc8004/)`
      );
    }
    throw new Error(`IdentityRegistry read failed for agentId ${agentId}: ${msg}`);
  }

  if (!agentURI) {
    throw new Error(`Agent #${agentId} has no agentURI set on-chain.`);
  }

  // ── Step 2: Fetch and parse the registration file ─────────────────────────
  let regFile: RegistrationFile;
  try {
    regFile = await fetchRegistrationFile(agentURI);
  } catch (err) {
    throw new Error(
      `Could not load registration file for agent #${agentId} from "${agentURI}":\n` +
      (err as Error).message
    );
  }

  // ── Step 3: Validate the registration file ────────────────────────────────
  if (regFile.type !== "https://eips.ethereum.org/EIPS/eip-8004#registration-v1") {
    throw new Error(
      `Agent #${agentId}: registration file has unexpected type "${regFile.type}".\n` +
      `Expected: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"`
    );
  }

  if (!regFile.active) {
    throw new Error(`Agent #${agentId} ("${regFile.name}") is marked active: false in its registration file.`);
  }

  // ── Step 4: Extract A2A endpoint ──────────────────────────────────────────
  //
  // Prefer the first service of type "a2a".
  // Agents that expose no A2A endpoint are valid ERC-8004 agents but cannot
  // be called via the A2A protocol — we treat that as an error here.
  const a2aService = regFile.services.find(s => s.name.toLowerCase() === "a2a");
  if (!a2aService) {
    throw new Error(
      `Agent #${agentId} ("${regFile.name}") has no A2A service in its registration file.\n` +
      `services: ${JSON.stringify(regFile.services.map(s => s.name))}`
    );
  }

  const agentIdentifier = `eip155:${chainId}:${identityRegistry}/${agentId}`;

  return {
    agentId,
    agentIdentifier,
    agentURI,
    endpoint: a2aService.endpoint,
    owner,
    agentWallet,
    registrationFile: regFile,
  };
}

// ---------------------------------------------------------------------------
// discoverColorizer — discovers the colorizer agent specifically.
//
// Reads the agentId from the local colorizer.json registration file
// (populated by `npm run register`), then performs a full on-chain lookup.
//
// This is the function called by image-generator to find Agent 2.
// ---------------------------------------------------------------------------
export async function discoverColorizer(): Promise<AgentInfo> {
  // ── Read agentId from local registration file ──────────────────────────────
  let agentId: number;
  try {
    const raw = await readFile(COLORIZER_REG_FILE, "utf-8");
    const regFile = JSON.parse(raw) as { registrations: Array<{ agentId: string }> };
    const last = regFile.registrations[regFile.registrations.length - 1];

    if (!last?.agentId) {
      throw new Error("registrations[] is empty");
    }

    agentId = Number(last.agentId);
  } catch (err) {
    const detail = (err as Error).message;
    throw new Error(
      `Cannot discover colorizer: ${detail}\n\n` +
      `The colorizer agent is not registered on-chain yet.\n` +
      `Run: npm run register   (from erc8004/)\n\n` +
      `This will:\n` +
      `  1. Upload colorizer.json to IPFS\n` +
      `  2. Call register() on IdentityRegistry → mint agent NFT\n` +
      `  3. Write the agentId back to colorizer.json`
    );
  }

  return discoverAgent(agentId);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Optional: discover a specific agentId instead of colorizer
  const agentIdArg = args.find(a => !a.startsWith("--"))
    ?? args[args.indexOf("--agentId") + 1];

  console.log("\n=== ERC-8004 Agent Discovery ===\n");

  let info: AgentInfo;

  if (agentIdArg && !isNaN(Number(agentIdArg))) {
    console.log(`Looking up agentId ${agentIdArg} on Base Sepolia...`);
    info = await discoverAgent(Number(agentIdArg));
  } else {
    console.log("Looking up Colorizer Service on Base Sepolia...");
    info = await discoverColorizer();
  }

  const explorerBase = "https://sepolia.basescan.org";

  console.log(`
  Name            : ${info.registrationFile.name}
  Description     : ${info.registrationFile.description.slice(0, 80)}...
  Agent ID        : ${info.agentId}
  Identifier      : ${info.agentIdentifier}

  On-chain
  ────────────────────────────────────────────────────────
  agentURI        : ${info.agentURI}
  owner           : ${info.owner}
  agentWallet     : ${info.agentWallet}
  NFT             : ${explorerBase}/token/${(await readFile(CONTRACTS_FILE, "utf-8").then(r => JSON.parse(r) as { identityRegistry: string })).identityRegistry}/instance/${info.agentId}

  Registration file
  ────────────────────────────────────────────────────────
  active          : ${info.registrationFile.active}
  x402Support     : ${info.registrationFile.x402Support ?? false}
  supportedTrust  : ${(info.registrationFile.supportedTrust ?? []).join(", ")}

  Services
  ────────────────────────────────────────────────────────`);

  for (const svc of info.registrationFile.services) {
    console.log(`  ${svc.name.padEnd(8)}: ${svc.endpoint}`);
  }

  console.log(`
  A2A endpoint    : ${info.endpoint}
  `);
}

main().catch((err: unknown) => {
  console.error("\nError:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
