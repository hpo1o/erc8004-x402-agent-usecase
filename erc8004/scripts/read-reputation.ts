// ---------------------------------------------------------------------------
// erc8004/scripts/read-reputation.ts
//
// CLI script — reads and displays on-chain reputation for an agent.
//
// Usage (from erc8004/):
//   npm run reputation -- --agentId <n> --client <0x...>
//
// Required env vars:
//   BASE_SEPOLIA_RPC — optional, default: https://sepolia.base.org
//
// What it does:
//   1. getSummary(agentId, [client], "successRate", "")
//      → total call count + aggregate value
//   2. readAllFeedback(agentId, [client], "successRate", "", false)
//      → full list of individual entries
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

try {
  process.loadEnvFile(resolve(ERC8004_ROOT, ".env"));
} catch { /* .env absent */ }

// ---------------------------------------------------------------------------
// ABI — only the read functions used here.
// Source: https://github.com/erc-8004/erc-8004-contracts/blob/main/abis/ReputationRegistry.json
// ---------------------------------------------------------------------------
const REPUTATION_REGISTRY_ABI = [
  // getSummary(agentId, clientAddresses, tag1, tag2)
  //   → (count, summaryValue, summaryValueDecimals)
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
    stateMutability: "view",
    type: "function",
  },
  // readAllFeedback(agentId, clientAddresses, tag1, tag2, includeRevoked)
  {
    inputs: [
      { internalType: "uint256",   name: "agentId",          type: "uint256"   },
      { internalType: "address[]", name: "clientAddresses",  type: "address[]" },
      { internalType: "string",    name: "tag1",             type: "string"    },
      { internalType: "string",    name: "tag2",             type: "string"    },
      { internalType: "bool",      name: "includeRevoked",   type: "bool"      },
    ],
    name: "readAllFeedback",
    outputs: [
      { internalType: "address[]", name: "clients",          type: "address[]" },
      { internalType: "uint64[]",  name: "feedbackIndexes",  type: "uint64[]"  },
      { internalType: "int128[]",  name: "values",           type: "int128[]"  },
      { internalType: "uint8[]",   name: "valueDecimals",    type: "uint8[]"   },
      { internalType: "string[]",  name: "tag1s",            type: "string[]"  },
      { internalType: "string[]",  name: "tag2s",            type: "string[]"  },
      { internalType: "bool[]",    name: "revokedStatuses",  type: "bool[]"    },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatValue(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
}

/** Shorten address to 0x1234...abcd */
function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      result[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.agentId || !args.client) {
    console.error(`
Usage:
  npm run reputation -- --agentId <n> --client <0x...>

Example:
  npm run reputation -- --agentId 1 --client 0xABCDEF...
`);
    process.exit(1);
  }

  const agentId = BigInt(args.agentId);
  const clientAddress = args.client as Address;
  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";

  // ── Load registry address ──────────────────────────────────────────────────
  const raw = await readFile(CONTRACTS_FILE, "utf-8");
  const { reputationRegistry } = JSON.parse(raw) as { reputationRegistry: Address };

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpc),
  });

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ERC-8004 Reputation — agentId ${agentId}`);
  console.log(`  client : ${clientAddress}`);
  console.log(`${"═".repeat(60)}`);

  // ── getSummary ─────────────────────────────────────────────────────────────
  const [count, summaryValue, summaryDecimals] = await publicClient.readContract({
    address: reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: "getSummary",
    args: [agentId, [clientAddress], "successRate", ""],
  });

  console.log(`\n  SUMMARY  (tag: successRate)`);
  console.log(`  ${"─".repeat(40)}`);

  if (count === 0n) {
    console.log(`  No feedback found for this client.`);
  } else {
    const avg = summaryDecimals === 0
      ? summaryValue / count
      : summaryValue / count;

    console.log(`  Total calls      : ${count}`);
    console.log(`  Aggregate value  : ${formatValue(summaryValue, summaryDecimals)}`);
    console.log(`  Average / call   : ${formatValue(avg, summaryDecimals)}`);

    // For successRate (value=100 or 0, decimals=0):
    // average = summaryValue / count = success% directly
    if (summaryDecimals === 0 && summaryValue >= 0n) {
      const successPct = Number((summaryValue * 100n) / (count * 100n));
      const bar = buildBar(successPct, 30);
      console.log(`  Success rate     : ${bar} ${successPct}%`);
    }
  }

  // ── readAllFeedback ────────────────────────────────────────────────────────
  const [clients, feedbackIndexes, values, valueDecimals, tag1s, , revokedStatuses] =
    await publicClient.readContract({
      address: reputationRegistry,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: "readAllFeedback",
      args: [agentId, [clientAddress], "successRate", "", false],
    });

  console.log(`\n  FEEDBACK ENTRIES  (${clients.length} total)`);
  console.log(`  ${"─".repeat(40)}`);

  if (clients.length === 0) {
    console.log(`  None.`);
  } else {
    const header = `  ${"#".padEnd(4)} ${"client".padEnd(14)} ${"tag".padEnd(12)} ${"value".padEnd(8)} status`;
    console.log(header);
    console.log(`  ${"─".repeat(56)}`);

    for (let i = 0; i < clients.length; i++) {
      const idx = feedbackIndexes[i].toString().padEnd(4);
      const addr = shortAddr(clients[i]).padEnd(14);
      const tag = tag1s[i].padEnd(12);
      const val = formatValue(values[i], valueDecimals[i]).padEnd(8);
      const status = revokedStatuses[i] ? "REVOKED" : values[i] === 100n ? "✓ success" : "✗ failure";
      console.log(`  ${idx} ${addr} ${tag} ${val} ${status}`);
    }
  }

  console.log(`\n${"═".repeat(60)}\n`);
}

/** Renders a simple ASCII progress bar: ████████░░░░  */
function buildBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

main().catch((err: unknown) => {
  console.error("\nFatal error:");
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
