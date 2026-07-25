// ---------------------------------------------------------------------------
// tests/x402-flow.test.ts
//
// Tests the x402 payment flow in colorizer-client.ts without a real blockchain.
// Uses bun:test mock to intercept global fetch.
//
// What is covered:
//   - 200 on first try → returns grayscale result, txHash = "no-payment-required"
//   - Non-ok, non-402 response (5xx) → throws with status code
//   - 402 without a valid PAYMENT-REQUIRED header → throws before prompting user
// ---------------------------------------------------------------------------

import { test, expect, mock, afterEach } from "bun:test";
import { sendToColorizer } from "../image-generator/src/colorizer-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid A2A v0.3.0 task response. */
function makeA2AResponse(agentText: string): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      kind: "task",
      id: "task-test-001",
      contextId: "ctx-test-001",
      status: {
        state: "completed",
        message: {
          kind: "message",
          messageId: "msg-test-001",
          role: "agent",
          parts: [{ kind: "text", text: agentText }],
        },
      },
    },
  };
}

// A mock grayscale data URL — just needs to be parseable by extractGrayscaleDataUrl.
// The function only strips the prefix to get base64; it does NOT re-decode the image.
const MOCK_GREY_DATA_URL = "data:image/png;base64,AAECBAUGB";

// ---------------------------------------------------------------------------
// fetch mock helper
// ---------------------------------------------------------------------------

function mockFetchOnce(response: Response): () => void {
  const orig = global.fetch;
  global.fetch = mock(() => Promise.resolve(response)) as typeof fetch;
  return () => {
    global.fetch = orig;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("200 on first try: returns grayscale result without x402 handshake", async () => {
  const restore = mockFetchOnce(
    new Response(JSON.stringify(makeA2AResponse(MOCK_GREY_DATA_URL)), {
      status: 200,
    })
  );
  try {
    const result = await sendToColorizer("dGVzdA==", "http://mock/agent");

    expect(result.txHash).toBe("no-payment-required");
    expect(result.contextId).toBe("ctx-test-001");
    expect(result.taskId).toBe("task-test-001");
    expect(typeof result.grayscaleBase64).toBe("string");
    expect(result.grayscaleBase64.length).toBeGreaterThan(0);
  } finally {
    restore();
  }
});

test("200 response: grayscaleBase64 has data URL prefix stripped", async () => {
  const restore = mockFetchOnce(
    new Response(JSON.stringify(makeA2AResponse(MOCK_GREY_DATA_URL)), {
      status: 200,
    })
  );
  try {
    const result = await sendToColorizer("dGVzdA==", "http://mock/agent");
    // Must be raw base64 — no "data:image/..." prefix
    expect(result.grayscaleBase64.startsWith("data:")).toBe(false);
  } finally {
    restore();
  }
});

test("5xx response: throws with status code in message", async () => {
  const restore = mockFetchOnce(
    new Response("Internal Server Error", { status: 500 })
  );
  try {
    await expect(
      sendToColorizer("dGVzdA==", "http://mock/agent")
    ).rejects.toThrow("Unexpected 500");
  } finally {
    restore();
  }
});

test("402 without PAYMENT-REQUIRED header: throws before prompting user", async () => {
  // Set a syntactically valid private key so createX402HttpClient() doesn't
  // fail on key format. The 402 has no payment header so the x402 client
  // should throw when trying to decode the payment requirements.
  process.env.PAYER_PRIVATE_KEY =
    "0x0000000000000000000000000000000000000000000000000000000000000001";

  const restore = mockFetchOnce(
    new Response(null, { status: 402 })
  );
  try {
    // Should throw — either missing payment header or absent private key at
    // any earlier point. We just verify it does not hang waiting for stdin.
    await expect(
      sendToColorizer("dGVzdA==", "http://mock/agent")
    ).rejects.toThrow();
  } finally {
    restore();
    delete process.env.PAYER_PRIVATE_KEY;
  }
});

test("A2A error response: throws with error message from result.error", async () => {
  const errorResponse = {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Internal agent error" },
  };
  const restore = mockFetchOnce(
    new Response(JSON.stringify(errorResponse), { status: 200 })
  );
  try {
    await expect(
      sendToColorizer("dGVzdA==", "http://mock/agent")
    ).rejects.toThrow("Internal agent error");
  } finally {
    restore();
  }
});
