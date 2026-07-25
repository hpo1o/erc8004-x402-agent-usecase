import { tool } from "ai";
import sharp from "sharp";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helper: strip the "data:image/...;base64," prefix if the client sent a
// Data URL instead of a raw base64 string.
//
// Example input:  "data:image/jpeg;base64,/9j/4AAQ..."
// Example output: "/9j/4AAQ..."
// ---------------------------------------------------------------------------
function stripDataUrlPrefix(input: string): string {
  const match = input.match(/^data:image\/[a-z]+;base64,(.+)$/s);
  return match ? match[1] : input;
}

// ---------------------------------------------------------------------------
// colorize tool
//
// Workflow (triggered AFTER the client has paid $0.01 USDC via x402):
//
//   1. Receive a base64-encoded image from the A2A client (data URL or raw base64)
//   2. Decode it into a raw binary Buffer
//   3. Pass the buffer through sharp().grayscale() → re-encode as PNG
//   4. Encode the result back to base64 and return it
//
// Why PNG as output?
//   PNG is lossless — the grayscale conversion is exact. If we used JPEG
//   there would be additional compression artifacts on top of the B&W conversion.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// executeColorize — the pure processing function, exported separately so
// agent.ts can call it directly without going through the LLM tool wrapper.
// ---------------------------------------------------------------------------
export async function executeColorize(imageBase64: string): Promise<string> {
  const rawBase64 = stripDataUrlPrefix(imageBase64);
  const inputBuffer = Buffer.from(rawBase64, "base64");

  if (inputBuffer.byteLength < 8) {
    throw new Error("Invalid image: decoded buffer is too small.");
  }

  const outputBuffer = await sharp(inputBuffer)
    .grayscale()
    .png()
    .toBuffer();

  return `data:image/png;base64,${outputBuffer.toString("base64")}`;
}

// The tool() wrapper keeps the MCP endpoint working (server.ts MCPPlugin).
export default tool({
  description:
    "Converts a color image to black-and-white (grayscale). " +
    "Input: base64-encoded image (JPEG / PNG / WebP / AVIF). " +
    "Output: base64-encoded grayscale PNG data URL.",

  inputSchema: z.object({
    imageBase64: z
      .string()
      .min(4)
      .describe(
        "Base64-encoded source image. May include a Data URL prefix " +
          "(data:image/jpeg;base64,...) or be a raw base64 string."
      ),
  }),

  execute: async ({ imageBase64 }) => executeColorize(imageBase64),
});
