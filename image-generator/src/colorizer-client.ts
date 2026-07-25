// ---------------------------------------------------------------------------
// colorizer-client.ts
//
// Sends an image to Agent 2 (colorizer-service) via the A2A protocol and
// handles the x402 payment flow:
//
//   1. POST /agent  →  HTTP 402  (payment required)
//   2. Prompt user  →  y/n confirmation
//   3. Sign payment off-chain (EIP-3009 / transferWithAuthorization)
//   4. POST /agent with PAYMENT-SIGNATURE header  →  HTTP 200
//   5. Return grayscale image + txHash
// ---------------------------------------------------------------------------

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// A2A protocol types (Google Agent2Agent spec v0.3.0)
//
// v0.3.0 changes from earlier drafts:
//   - parts use `kind: "text"` (not `type: "text"`)
//   - Message has `kind: "message"` and `messageId` fields
//   - method is "message/send" (not "tasks/send")
//   - Task response has `kind: "task"` top-level field
// ---------------------------------------------------------------------------
interface A2ATextPart {
  kind?: "text";   // some aixyz versions emit "type" instead — made optional
  type?: "text";   // fallback for older A2A drafts
  text: string;
}

interface A2AMessage {
  kind: "message";
  messageId: string;
  role: "user" | "agent";
  parts: A2ATextPart[];
}

interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: {
    state: "submitted" | "working" | "completed" | "failed" | "canceled";
    message?: A2AMessage;
  };
  // artifacts = explicit output artifacts (may be absent)
  artifacts?: Array<{ artifactId: string; parts: A2ATextPart[] }>;
  // history = full message log; agent replies have role: "agent"
  history?: A2AMessage[];
}

interface A2AResponse {
  jsonrpc: "2.0";
  id: number;
  result?: A2ATask;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// buildMessageBody
//
// Constructs the JSON-RPC body for A2A message/send (v0.3.0).
// The image is passed as plain text inside the message parts —
// the LLM in Agent 2 will read it and call the `colorize` tool with it.
// ---------------------------------------------------------------------------
function buildMessageBody(imageDataUrl: string): { body: string; messageId: string } {
  const messageId = randomUUID();

  const payload = {
    jsonrpc: "2.0",
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId,
        role: "user",
        // The colorizer agent's instructions expect: "base64 image (raw or data URL)"
        parts: [{ kind: "text", text: imageDataUrl }],
      },
    },
    id: 1,
  };

  return { body: JSON.stringify(payload), messageId };
}

// ---------------------------------------------------------------------------
// extractGrayscaleDataUrl
//
// Pulls the result text out of the A2A v0.3.0 response (Task object).
// Agents can return output in two places:
//   - result.artifacts[0].parts[0].text  (preferred: explicit output artifact)
//   - result.status.message.parts[0].text  (fallback: final message from LLM)
//
// In v0.3.0 parts use `kind: "text"` — filter to avoid metadata parts.
// ---------------------------------------------------------------------------
// anyText returns the text of the first part that has any text content,
// regardless of whether the part uses kind/type field names.
function anyText(parts: A2ATextPart[]): string | undefined {
  return parts.find((p) => p.text)?.text;
}

// dataUrlFromText extracts a data:image/... URL from a string that may
// contain surrounding prose (e.g. "Here it is: data:image/png;base64,...")
function dataUrlFromText(text: string): string | undefined {
  const match = text.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/);
  return match?.[0];
}

function extractGrayscaleDataUrl(response: A2AResponse): string {
  if (response.error) {
    throw new Error(
      `A2A error ${response.error.code}: ${response.error.message}`
    );
  }

  const result = response.result;
  if (!result) throw new Error("A2A response has no result field");

  // 1. Explicit artifacts
  if (result.artifacts) {
    for (const artifact of result.artifacts) {
      const text = anyText(artifact.parts);
      if (text) return dataUrlFromText(text) ?? text;
    }
  }

  // 2. history — agent messages, newest first
  if (result.history) {
    for (let i = result.history.length - 1; i >= 0; i--) {
      const msg = result.history[i];
      if (msg.role !== "agent") continue;
      const text = anyText(msg.parts);
      if (text) return dataUrlFromText(text) ?? text;
    }
  }

  // 3. status.message (the task's final message — often the agent reply)
  if (result.status?.message?.parts) {
    const text = anyText(result.status.message.parts);
    if (text) return dataUrlFromText(text) ?? text;
  }

  // ── DEBUG: nothing found — dump the structure ─────────────────────────────
  console.log("\n[DEBUG extractGrayscaleDataUrl] result keys:", Object.keys(result));
  console.log("[DEBUG] artifacts:", JSON.stringify(result.artifacts, null, 2));
  console.log("[DEBUG] status.message:", JSON.stringify(result.status?.message, null, 2));

  if (result.history) {
    console.log(`[DEBUG] history (${result.history.length} entries):`);
    result.history.forEach((msg, i) => {
      console.log(`  [${i}] role="${msg.role}"`);
      msg.parts.forEach((p, j) => {
        const preview = p.text ? p.text.slice(0, 100) + (p.text.length > 100 ? "…" : "") : "(no text)";
        console.log(`    part[${j}] kind="${p.kind ?? p.type}" text="${preview}"`);
      });
    });
  } else {
    console.log("[DEBUG] history: absent");
  }
  console.log("[DEBUG] end dump\n");

  throw new Error(
    `Agent returned state "${result.status.state}" with no extractable text output`
  );
}

// ---------------------------------------------------------------------------
// createX402HttpClient
//
// Builds the x402HTTPClient for Base Sepolia (chain ID 84532).
//
// Stack:
//   privateKeyToAccount  →  provides `address` + `signTypedData`
//   ExactEvmScheme       →  implements the EIP-3009 payment signing logic
//   x402Client           →  manages scheme registrations + payload creation
//   x402HTTPClient       →  HTTP layer: encodes/decodes headers, adds hooks
//
// The scheme is registered for "eip155:84532" (Base Sepolia CAIP-2 identifier).
// The colorizer's x402 config uses the same network string.
// ---------------------------------------------------------------------------
function createX402HttpClient(): x402HTTPClient {
  const privateKey = process.env.PAYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("PAYER_PRIVATE_KEY not set in .env");

  // viem account — satisfies the ClientEvmSigner interface because
  // it exposes `address` and `signTypedData` at minimum.
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const core = new x402Client();

  // ExactEvmScheme signs an EIP-3009 transferWithAuthorization message.
  // This is an off-chain signature — no on-chain transaction happens here.
  // The facilitator (Agently's service by default) later settles on-chain.
  core.register("eip155:84532", new ExactEvmScheme(account));

  return new x402HTTPClient(core);
}

// ---------------------------------------------------------------------------
// promptConfirm
//
// Displays the payment prompt and waits for the user to type y or n.
// ---------------------------------------------------------------------------
async function promptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`\n${question} (y/n) > `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

// ---------------------------------------------------------------------------
// sendToColorizer  (main exported function)
//
// Full flow: initial request → 402 → confirm → sign → retry → extract result
// ---------------------------------------------------------------------------
export async function sendToColorizer(
  imageBase64: string, // raw base64 from DALL-E, no prefix
  colorizerUrl: string
): Promise<{ grayscaleBase64: string; txHash: string; contextId: string; taskId: string }> {

  // Prepend the data URL prefix so the colorizer's stripDataUrlPrefix helper
  // (in tools/colorize.ts) can handle it correctly.
  const imageDataUrl = `data:image/png;base64,${imageBase64}`;
  const { body, messageId } = buildMessageBody(imageDataUrl);

  console.log(`  → POST ${colorizerUrl}  (message ${messageId})`);

  // ── Step 1: Initial request ──────────────────────────────────────────────
  const initialRes = await fetch(colorizerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  // ── Step 2: Handle non-402 cases ─────────────────────────────────────────
  if (initialRes.status !== 402) {
    if (!initialRes.ok) {
      throw new Error(
        `Unexpected ${initialRes.status}: ${await initialRes.text()}`
      );
    }
    // 200 on first try (x402 disabled or already paid — unusual)
    const data = (await initialRes.json()) as A2AResponse;
    const grayscaleDataUrl = extractGrayscaleDataUrl(data);
    const grayscaleBase64 = grayscaleDataUrl.replace(
      /^data:image\/[a-z]+;base64,/,
      ""
    );
    return {
      grayscaleBase64,
      txHash: "no-payment-required",
      contextId: data.result?.contextId ?? "",
      taskId: data.result?.id ?? "",
    };
  }

  // ── Step 3: Parse the 402 Payment Required response ──────────────────────
  //
  // aixyz wraps the endpoint with x402 middleware which responds with:
  //   HTTP 402
  //   PAYMENT-REQUIRED: <base64(PaymentRequired JSON)>
  //
  // x402HTTPClient.getPaymentRequiredResponse() finds the right header
  // (case-insensitive) and decodes it — we pass both header getter and the
  // body in case the server sends v1-style body format.
  const responseBody = await initialRes.json().catch(() => null);
  const x402 = createX402HttpClient();

  const paymentRequired = x402.getPaymentRequiredResponse(
    (h) => initialRes.headers.get(h),
    responseBody
  );

  // ── Step 4: User confirmation ─────────────────────────────────────────────
  const confirmed = await promptConfirm(
    "Агент 2 запрашивает оплату $0.01 USDC на Base Sepolia. Подтвердить?"
  );
  if (!confirmed) throw new Error("Оплата отменена пользователем.");

  // ── Step 5: Sign the payment (off-chain EIP-3009 signature) ──────────────
  //
  // createPaymentPayload:
  //   1. Selects the best payment option from paymentRequired.accepts[]
  //   2. Calls ExactEvmScheme.createPaymentPayload() which:
  //      a. Reads USDC contract on Base Sepolia to get the nonce
  //      b. Signs transferWithAuthorization via account.signTypedData()
  //   3. Returns a PaymentPayload (pure data — no broadcast yet)
  //
  // encodePaymentSignatureHeader:
  //   Serialises the payload to base64 and returns { "PAYMENT-SIGNATURE": "..." }
  console.log("  → Подписываю платёж (EIP-3009)...");
  const paymentPayload = await x402.createPaymentPayload(paymentRequired);
  const paymentHeaders = x402.encodePaymentSignatureHeader(paymentPayload);

  // ── Step 6: Retry with payment header ────────────────────────────────────
  //
  // The facilitator (Agently) receives the PAYMENT-SIGNATURE header, verifies the
  // signature on-chain, and if valid, settles the USDC transfer.
  // The server then processes the request normally.
  console.log("  → Повторный запрос с PAYMENT-SIGNATURE заголовком...");
  let paidRes: Response;
  try {
    paidRes = await fetch(colorizerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...paymentHeaders,
      },
      body,
    });
  } catch (fetchErr) {
    throw new Error(`[STEP 6] fetch() threw: ${(fetchErr as Error).message}`, { cause: fetchErr });
  }

  console.log(`[STEP 6] paidRes.status=${paidRes.status} ok=${paidRes.ok}`);

  if (!paidRes.ok) {
    const errBody = await paidRes.text();
    throw new Error(`Payment rejected (${paidRes.status}): ${errBody}`);
  }

  // ── Step 7: Extract txHash from settlement header ─────────────────────────
  let txHash = "(нет PAYMENT-RESPONSE — асинхронный расчёт)";
  try {
    const settle = x402.getPaymentSettleResponse((h) => paidRes.headers.get(h));
    txHash = settle.transaction;
    console.log(`[STEP 7] txHash=${txHash}`);
  } catch (settleErr) {
    console.log(`[STEP 7] getPaymentSettleResponse threw (non-fatal): ${(settleErr as Error).message}`);
  }

  // ── Step 8: Parse the A2A response ───────────────────────────────────────
  let rawText: string;
  try {
    rawText = await paidRes.text();
    console.log(`[STEP 8a] raw response text (first 500 chars):\n${rawText.slice(0, 500)}`);
  } catch (textErr) {
    throw new Error(`[STEP 8a] paidRes.text() threw: ${(textErr as Error).message}`, { cause: textErr });
  }

  let responseData: A2AResponse;
  try {
    responseData = JSON.parse(rawText) as A2AResponse;
    console.log(`[STEP 8b] parsed JSON keys: ${Object.keys(responseData)}`);
    console.log(`[STEP 8b] result keys: ${responseData.result ? Object.keys(responseData.result) : "no result"}`);
  } catch (parseErr) {
    throw new Error(`[STEP 8b] JSON.parse threw: ${(parseErr as Error).message}`, { cause: parseErr });
  }

  console.log(`[STEP 8c] passing to extractGrayscaleDataUrl...`);
  const grayscaleDataUrl = extractGrayscaleDataUrl(responseData);

  // Strip the data URL prefix to get raw base64 for file writing
  const grayscaleBase64 = grayscaleDataUrl.replace(
    /^data:image\/[a-z]+;base64,/,
    ""
  );

  return {
    grayscaleBase64,
    txHash,
    contextId: responseData.result?.contextId ?? "",
    taskId: responseData.result?.id ?? "",
  };
}
