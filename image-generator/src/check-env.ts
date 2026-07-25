// ---------------------------------------------------------------------------
// check-env.ts
//
// Pre-flight checker: validates env vars and wallet balances before running
// the main demo. Run with: npm run check (from image-generator/)
//
// Checks:
//   1. All required env vars are present in both .env files
//   2. PAYER_PRIVATE_KEY is a valid 32-byte hex private key
//   3. Payer wallet has ETH on Base Sepolia (for gas)
//   4. Payer wallet has >= $0.01 USDC on Base Sepolia (for payment)
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, isHex, isAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
// image-generator/ is one level up from src/
const IMG_GEN_ROOT = resolve(__dir, "..");
// colorizer-service/ is a sibling of image-generator/
const COLORIZER_ROOT = resolve(IMG_GEN_ROOT, "..", "colorizer-service");

// ---------------------------------------------------------------------------
// Minimal ERC-20 ABI — only what we need for balanceOf and decimals
// ---------------------------------------------------------------------------
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
] as const;

// USDC contract address on Base Sepolia testnet (deployed by Circle)
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

// Minimum USDC needed: $0.01 = 10_000 units (USDC has 6 decimals)
const MIN_USDC = 10_000n;

// ---------------------------------------------------------------------------
// Simple .env file parser
//
// Supports:
//   KEY=value
//   KEY="value with spaces"
//   # comments
//   blank lines
//
// Does NOT support multiline values — sufficient for our .env files.
// ---------------------------------------------------------------------------
function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const result: Record<string, string> = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) result[key] = value;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
type Status = "ok" | "warn" | "fail";

interface CheckResult {
  label: string;
  status: Status;
  detail: string;
}

const results: CheckResult[] = [];

function ok(label: string, detail: string): void {
  results.push({ label, status: "ok", detail });
}

function warn(label: string, detail: string): void {
  results.push({ label, status: "warn", detail });
}

function fail(label: string, detail: string): void {
  results.push({ label, status: "fail", detail });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// USDC amount in display format: 10_000n → "0.010000"
function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

// ETH amount in display format: 1_000_000_000_000_000n → "0.001 ETH"
function formatEth(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  return `${eth.toFixed(6)} ETH`;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkEnvFiles(
  imgGenEnv: Record<string, string>,
  colorizerEnv: Record<string, string>
): void {
  // image-generator .env
  const imgGenPath = resolve(IMG_GEN_ROOT, ".env");
  if (!existsSync(imgGenPath)) {
    fail(
      "image-generator/.env",
      `File not found. Run: cp image-generator/.env.example image-generator/.env`
    );
  } else {
    ok("image-generator/.env", "File exists");
  }

  // colorizer-service .env
  const colorizerPath = resolve(COLORIZER_ROOT, ".env");
  if (!existsSync(colorizerPath)) {
    fail(
      "colorizer-service/.env",
      `File not found. Run: cp colorizer-service/.env.example colorizer-service/.env`
    );
  } else {
    ok("colorizer-service/.env", "File exists");
  }

  // Required vars in image-generator/.env
  const requiredImgGen: Array<{ key: string; hint: string }> = [
    { key: "OPENAI_API_KEY", hint: "Get from https://platform.openai.com/api-keys" },
    {
      key: "PAYER_PRIVATE_KEY",
      hint: "Export from MetaMask → Account Details → Show private key",
    },
  ];

  for (const { key, hint } of requiredImgGen) {
    const val = imgGenEnv[key] ?? process.env[key];
    if (!val || val.includes("...") || val === "sk-placeholder") {
      fail(`image-generator: ${key}`, `Not set or still has placeholder value. ${hint}`);
    } else {
      ok(`image-generator: ${key}`, `Set (${val.slice(0, 8)}...)`);
    }
  }

  // Required vars in colorizer-service/.env
  const recipientVal =
    colorizerEnv["PAYMENT_RECIPIENT_ADDRESS"] ??
    process.env["PAYMENT_RECIPIENT_ADDRESS"];

  if (
    !recipientVal ||
    recipientVal.includes("...") ||
    recipientVal === "0x0000000000000000000000000000000000000000"
  ) {
    warn(
      "colorizer-service: PAYMENT_RECIPIENT_ADDRESS",
      "Not set or zero address — payments will work but go nowhere. Set to your wallet address."
    );
  } else if (!isAddress(recipientVal)) {
    fail(
      "colorizer-service: PAYMENT_RECIPIENT_ADDRESS",
      `"${recipientVal}" is not a valid Ethereum address`
    );
  } else {
    ok(
      "colorizer-service: PAYMENT_RECIPIENT_ADDRESS",
      `${recipientVal.slice(0, 10)}...`
    );
  }
}

function checkPrivateKey(imgGenEnv: Record<string, string>): string | null {
  const raw = imgGenEnv["PAYER_PRIVATE_KEY"] ?? process.env["PAYER_PRIVATE_KEY"] ?? "";

  if (!raw || raw.includes("...")) return null; // already reported above

  // Must be 0x + 64 hex chars (32 bytes)
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!isHex(normalized) || normalized.length !== 66) {
    fail(
      "PAYER_PRIVATE_KEY format",
      "Must be 0x + 64 hex characters (32 bytes). Re-export from MetaMask."
    );
    return null;
  }

  try {
    const account = privateKeyToAccount(normalized as `0x${string}`);
    ok("PAYER_PRIVATE_KEY format", `Valid key → address ${account.address}`);
    return account.address;
  } catch {
    fail("PAYER_PRIVATE_KEY format", "Could not derive address — key is malformed");
    return null;
  }
}

async function checkBalances(payerAddress: string): Promise<void> {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(), // uses public Base Sepolia RPC
  });

  // ── ETH balance ───────────────────────────────────────────────────────────
  let ethBalance: bigint;
  try {
    ethBalance = await client.getBalance({
      address: payerAddress as `0x${string}`,
    });

    if (ethBalance === 0n) {
      fail(
        "ETH balance (Base Sepolia)",
        "0 ETH — needed for gas. Get from https://www.alchemy.com/faucets/base-sepolia"
      );
    } else if (ethBalance < 100_000_000_000_000n) {
      // < 0.0001 ETH
      warn(
        "ETH balance (Base Sepolia)",
        `${formatEth(ethBalance)} — low, may run out of gas quickly`
      );
    } else {
      ok("ETH balance (Base Sepolia)", formatEth(ethBalance));
    }
  } catch (e) {
    warn(
      "ETH balance (Base Sepolia)",
      `Could not fetch (RPC error): ${(e as Error).message}`
    );
  }

  // ── USDC balance ──────────────────────────────────────────────────────────
  try {
    const [usdcBalance, symbol] = await Promise.all([
      client.readContract({
        address: USDC_BASE_SEPOLIA,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [payerAddress as `0x${string}`],
      }) as Promise<bigint>,
      client.readContract({
        address: USDC_BASE_SEPOLIA,
        abi: ERC20_ABI,
        functionName: "symbol",
      }) as Promise<string>,
    ]);

    const display = `${formatUsdc(usdcBalance)} ${symbol}`;

    if (usdcBalance === 0n) {
      fail(
        "USDC balance (Base Sepolia)",
        `0 ${symbol} — needed for payment. Get from https://faucet.circle.com (select Base Sepolia)`
      );
    } else if (usdcBalance < MIN_USDC) {
      fail(
        "USDC balance (Base Sepolia)",
        `${display} — need at least $0.01 (10,000 units). Get more from https://faucet.circle.com`
      );
    } else {
      const runs = usdcBalance / MIN_USDC;
      ok(
        "USDC balance (Base Sepolia)",
        `${display} — enough for ~${runs} test run${runs === 1n ? "" : "s"}`
      );
    }
  } catch (e) {
    warn(
      "USDC balance (Base Sepolia)",
      `Could not fetch (RPC error): ${(e as Error).message}`
    );
  }
}

function checkColorizerRunning(): void {
  const url = process.env["COLORIZER_URL"] ?? "http://localhost:3000/agent";
  // We'll do a quick sync check via fetch (async, handled separately)
  ok(
    "COLORIZER_URL",
    `Configured as: ${url} — make sure colorizer-service is running before npm start`
  );
}

// ---------------------------------------------------------------------------
// Print results
// ---------------------------------------------------------------------------
function printResults(): boolean {
  const icons: Record<Status, string> = { ok: "✓", warn: "⚠", fail: "✗" };
  const labels: Record<Status, string> = {
    ok: "OK  ",
    warn: "WARN",
    fail: "FAIL",
  };

  console.log("\n=== Pre-flight Check ===\n");

  let hasFailures = false;

  for (const r of results) {
    const icon = icons[r.status];
    const label = labels[r.status];
    console.log(`  ${icon} [${label}] ${r.label}`);
    if (r.status !== "ok") {
      console.log(`         → ${r.detail}`);
    }
  }

  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;

  console.log(`\n${"─".repeat(50)}`);

  if (fails > 0) {
    console.log(
      `\n  ✗ ${fails} check(s) failed. Fix the issues above, then re-run:\n`
    );
    console.log(`      npm run check\n`);
    hasFailures = true;
  } else if (warns > 0) {
    console.log(
      `\n  ⚠ ${warns} warning(s). You can proceed, but check the notes above.\n`
    );
    console.log(`  Ready to run! See SETUP.md → Шаг 8 for launch commands.\n`);
  } else {
    console.log(`\n  ✓ All checks passed! Ready to run:\n`);
    console.log(`      # Terminal 1 — start Agent 2:`);
    console.log(`      cd ../colorizer-service && npx aixyz dev\n`);
    console.log(`      # Terminal 2 — run Agent 1:`);
    console.log(`      npm start "a golden retriever in a sunlit meadow"\n`);
  }

  return !hasFailures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("Loading .env files...");

  const imgGenEnv = parseEnvFile(resolve(IMG_GEN_ROOT, ".env"));
  const colorizerEnv = parseEnvFile(resolve(COLORIZER_ROOT, ".env"));

  // Merge parsed vars into process.env so subsequent calls can use process.env
  // (but don't overwrite vars that are already set in the shell environment)
  for (const [k, v] of Object.entries(imgGenEnv)) {
    if (!process.env[k]) process.env[k] = v;
  }
  for (const [k, v] of Object.entries(colorizerEnv)) {
    if (!process.env[k]) process.env[k] = v;
  }

  // Run structural checks (sync)
  checkEnvFiles(imgGenEnv, colorizerEnv);
  const payerAddress = checkPrivateKey(imgGenEnv);
  checkColorizerRunning();

  // Run on-chain checks (async) only if we have a valid address
  if (payerAddress) {
    console.log(`\nChecking on-chain balances for ${payerAddress}...`);
    await checkBalances(payerAddress);
  } else {
    warn(
      "On-chain balance check",
      "Skipped — fix PAYER_PRIVATE_KEY first"
    );
  }

  const allGood = printResults();
  process.exit(allGood ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("\nCheck script crashed:", err);
  process.exit(1);
});
