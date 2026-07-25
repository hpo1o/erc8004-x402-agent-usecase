// ---------------------------------------------------------------------------
// image-generator — CLI entry point
//
// Usage:
//   npm start "a cat sitting on a chair"
//   # or:
//   tsx src/index.ts "a cat sitting on a chair"
//
// What happens:
//   1. Read the text prompt from argv
//   2. Generate a 256x256 image with GPT Image 2 (returns base64)
//   3. Send the image to Agent 2 (colorizer-service) via A2A
//      → receives HTTP 402, prompts user, pays via x402
//   4. Receive the grayscale PNG, convert to JPEG, save as output.jpg
//   5. Record ERC-8004 reputation feedback for Agent 2 (if registered)
//   6. Submit ERC-8004 validation request with image hashes (if registered)
//   7. Print the on-chain payment txHash + feedback + validation results
// ---------------------------------------------------------------------------

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { generateImage } from "./dalle.js";
import { sendToColorizer } from "./colorizer-client.js";
import { submitFeedback } from "../../erc8004/scripts/reputation.js";
import { requestValidation, submitValidationResponse } from "../../erc8004/scripts/validation.js";
import { discoverColorizer } from "../../erc8004/scripts/discovery.js";

// ---------------------------------------------------------------------------
// Load .env — built-in Node.js 20.12+ API, no dotenv package needed.
//
// We resolve the path relative to this source file rather than process.cwd()
// so the script works regardless of which directory the user runs it from.
//
// process.loadEnvFile() reads KEY=VALUE pairs and sets them on process.env,
// skipping keys that are already defined in the environment (shell wins).
// ---------------------------------------------------------------------------
const __envFile = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
try {
  process.loadEnvFile(__envFile);
} catch {
  // .env not found — env vars must come from the shell environment
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\nError: env variable ${name} is not set.`);
    console.error(`Copy .env.example → .env and fill in the values.\n`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // ── Validate env ──────────────────────────────────────────────────────────
  requireEnv("OPENAI_API_KEY");
  requireEnv("PAYER_PRIVATE_KEY");

  // ── Determine colorizer endpoint + payment recipient ─────────────────────
  //
  // In dev mode (COLORIZER_URL set): use .env values for both.
  // In production (discovery): read agentWallet from on-chain — it is the
  // canonical payment recipient registered by the agent owner, not a
  // manually configured env var that can drift out of sync.
  let colorizerEndpoint: string;
  let colorizerPayTo: string;
  if (process.env.COLORIZER_URL) {
    colorizerEndpoint = process.env.COLORIZER_URL;
    colorizerPayTo = process.env.PAYMENT_RECIPIENT_ADDRESS ?? "";
    console.log("Using COLORIZER_URL from .env (dev mode)");
  } else {
    console.log("Discovering Agent 2 via ERC-8004 registry...");
    const agentInfo = await discoverColorizer();
    if (!agentInfo) {
      throw new Error(
        "Agent 2 not found in ERC-8004 registry.\nRun: cd erc8004 && npm run register"
      );
    }
    colorizerEndpoint = agentInfo.endpoint;
    colorizerPayTo = agentInfo.agentWallet;   // on-chain source of truth
    console.log(`  ✓ Discovered: ${colorizerEndpoint} (agentId: ${agentInfo.agentId})\n`);
  }

  // ── Parse CLI arguments ───────────────────────────────────────────────────
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "\nUsage: npm start \"<description of the image you want>\"\n"
    );
    process.exit(1);
  }
  const prompt = args.join(" ");

  console.log("\n=== image-generator ===");
  console.log(`Prompt: "${prompt}"\n`);

  // ── Step 1: Generate image with GPT Image 2 ─────────────────────────────────
  console.log("[1/5] Generating image with GPT Image 2...");
  const imageBase64 = await generateImage(prompt);
  const inputKb = Math.round((imageBase64.length * 3) / 4 / 1024);
  console.log(`  ✓ Image generated (≈${inputKb} KB as base64)\n`);

  // ── Step 2: Send to colorizer-service (Agent 2) ───────────────────────────
  console.log("[2/5] Sending to colorizer-service (Agent 2)...");
  const colorizerStartMs = Date.now();
  const { grayscaleBase64, txHash, contextId, taskId } = await sendToColorizer(imageBase64, colorizerEndpoint);
  const responseTimeMs = Date.now() - colorizerStartMs;
  const outputKb = Math.round((grayscaleBase64.length * 3) / 4 / 1024);
  console.log(`\n  ✓ Grayscale image received (≈${outputKb} KB, ${responseTimeMs}ms)\n`);

  // ── Step 3: Save result as output.jpg ────────────────────────────────────
  //
  // The colorizer returns a PNG (lossless grayscale).
  // We convert to JPEG here using sharp so the output matches the
  // requested filename (output.jpg).
  //
  // quality: 90 — high quality, still much smaller than PNG for photos.
  console.log("[3/5] Saving output.jpg...");
  const pngBuffer = Buffer.from(grayscaleBase64, "base64");
  const jpegBuffer = await sharp(pngBuffer)
    .jpeg({ quality: 90 })
    .toBuffer();

  await writeFile("output.jpg", jpegBuffer);

  // ── Steps 4–5: ERC-8004 on-chain recording ───────────────────────────────
  //
  // Both steps read the same colorizer.json for agentId, so we parse it once.
  // If the agent isn't registered yet (registrations[] empty) both steps skip.
  // All ERC-8004 work is best-effort: errors are caught and logged, never
  // allowed to prevent the already-saved output.jpg from being reported.
  //
  // Required env vars (optional — steps skipped if absent):
  //   PINATA_JWT, ERC8004_PRIVATE_KEY, BASE_SEPOLIA_RPC
  const __srcDir = dirname(fileURLToPath(import.meta.url));
  const colorizerRegPath = resolve(__srcDir, "../../erc8004/registration/colorizer.json");

  let colorizerAgentId: number | null = null;
  try {
    const colorizerReg = JSON.parse(await readFile(colorizerRegPath, "utf-8")) as {
      registrations: Array<{ agentId: string }>;
    };
    const last = colorizerReg.registrations[colorizerReg.registrations.length - 1];
    if (last?.agentId) colorizerAgentId = Number(last.agentId);
  } catch { /* file missing or unreadable — both steps will skip */ }

  // Derive payer address once (reused by both steps).
  // privateKeyToAccount is available via the viem dep already pulled by @x402/evm.
  const payerPrivateKey = process.env.PAYER_PRIVATE_KEY ?? "";
  const { privateKeyToAccount } = await import("viem/accounts");
  const normalizedKey = (payerPrivateKey.startsWith("0x")
    ? payerPrivateKey
    : `0x${payerPrivateKey}`) as `0x${string}`;
  const payerAccount = privateKeyToAccount(normalizedKey);
  // colorizerPayTo is set above: agentWallet (discovery) or PAYMENT_RECIPIENT_ADDRESS (dev mode)

  // ── Step 4: Reputation feedback ───────────────────────────────────────────
  console.log("[4/5] Recording ERC-8004 reputation feedback...");
  try {
    if (!colorizerAgentId) {
      console.log("  ⚠ colorizer.json has no agentId — run npm run register first. Skipping.\n");
    } else {
      const feedback = await submitFeedback({
        agentId: colorizerAgentId,
        contextId,
        taskId,
        paymentTxHash: txHash,
        paymentFrom: payerAccount.address,
        paymentTo: colorizerPayTo,
        success: true,
        responseTimeMs,
        endpoint: colorizerEndpoint,
      });
      console.log(`  ✓ Feedback recorded`);
      console.log(`    feedbackIndex : ${feedback.feedbackIndex}`);
      console.log(`    txHash        : ${feedback.txHash}`);
      console.log(`    IPFS          : ipfs://${feedback.feedbackCID}\n`);
    }
  } catch (feedbackErr) {
    const msg = feedbackErr instanceof Error ? feedbackErr.message : String(feedbackErr);
    console.log(`  ⚠ Reputation feedback skipped: ${msg}\n`);
  }

  // ── Step 5: Validation request ────────────────────────────────────────────
  //
  // Hash both images so the request file contains a cryptographic fingerprint
  // of the input/output pair — any validator can later verify the conversion.
  // We hash the base64 strings (not decoded bytes) for simplicity; what
  // matters is that the hash is stable and tied to a specific payload.
  console.log("[5/5] Submitting ERC-8004 validation request...");
  try {
    if (!colorizerAgentId) {
      console.log("  ⚠ colorizer.json has no agentId — skipping.\n");
    } else {
      const { keccak256, stringToBytes } = await import("viem");
      const inputImageHash  = keccak256(stringToBytes(imageBase64));
      const outputImageHash = keccak256(stringToBytes(grayscaleBase64));

      const validation = await requestValidation({
        agentId: colorizerAgentId,
        inputImageHash,
        outputImageHash,
        contextId,
        taskId,
        paymentTxHash: txHash,
        validatorAddress: payerAccount.address,
      });
      console.log(`  ✓ Validation recorded on-chain`);
      console.log(`    requestHash : ${validation.requestHash}`);
      console.log(`    txHash      : ${validation.txHash}\n`);

      try {
        const validationResponse = await submitValidationResponse({
          requestHash: validation.requestHash,
          response: 100,
          agentId: colorizerAgentId,
          validatorAddress: payerAccount.address,
        });
        console.log(`  ✓ Validation response submitted`);
        console.log(`    txHash      : ${validationResponse.txHash}\n`);
      } catch (responseErr) {
        const responseMsg = responseErr instanceof Error ? responseErr.message : String(responseErr);
        console.log(`  ⚠ Validation response skipped: ${responseMsg}\n`);
      }
    }
  } catch (validationErr) {
    const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
    console.log(`  ⚠ Validation request skipped: ${msg}\n`);
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log("=== Done ===");
  console.log(`✓ Saved to: output.jpg`);
  if (txHash.startsWith("MOCK_TX")) {
    console.log(`⚠ Payment txHash: MOCK (not a real transaction)\n`);
  } else {
    console.log(`✓ Payment txHash: ${txHash}\n`);
  }
}

main().catch((err: unknown) => {
  console.error("\nFatal error:");
  if (err instanceof Error) {
    // err.stack already contains the message on the first line, then the trace
    console.error(err.stack ?? err.message);
    // If the error was re-thrown with { cause }, print that too
    if (err.cause instanceof Error) {
      console.error("\nCaused by:");
      console.error(err.cause.stack ?? err.cause.message);
    }
  } else {
    console.error(String(err));
  }
  process.exit(1);
});
