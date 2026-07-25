// ---------------------------------------------------------------------------
// tests/colorize.test.ts
//
// Unit tests for executeColorize() in colorizer-service/app/tools/colorize.ts.
// Uses bun:test — no jest/vitest needed.
//
// sharp is resolved from root node_modules (devDependency) for test-image
// creation. The colorize module itself resolves sharp from its own
// colorizer-service/node_modules — both instances work independently.
// ---------------------------------------------------------------------------

import { test, expect } from "bun:test";
import sharp from "sharp";
import { executeColorize } from "../colorizer-service/app/tools/colorize";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a 1x1 red pixel as a base64 PNG data URL. */
async function makeRedPixelDataUrl(): Promise<string> {
  const buf = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("executeColorize: result starts with data:image/", async () => {
  const input = await makeRedPixelDataUrl();
  const result = await executeColorize(input);
  expect(result.startsWith("data:image/")).toBe(true);
});

test("executeColorize: output pixel is grayscale (R === G === B)", async () => {
  const input = await makeRedPixelDataUrl();
  const result = await executeColorize(input);

  // Strip the data URL prefix to get raw base64
  const base64 = result.replace(/^data:image\/[a-z]+;base64,/, "");
  const buf = Buffer.from(base64, "base64");

  // Decode to raw RGBA channels to inspect the pixel value
  const { data } = await sharp(buf)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  // For a 1x1 grayscale image expanded to RGBA: R === G === B (grey value)
  expect(data[0]).toBe(data[1]);
  expect(data[1]).toBe(data[2]);
});

test("executeColorize: does not throw on valid data URL input", async () => {
  const input = await makeRedPixelDataUrl();
  await expect(executeColorize(input)).resolves.toBeDefined();
});

test("executeColorize: accepts raw base64 without data URL prefix", async () => {
  // Build a red pixel, strip the prefix, pass raw base64
  const dataUrl = await makeRedPixelDataUrl();
  const rawBase64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, "");
  const result = await executeColorize(rawBase64);
  expect(result.startsWith("data:image/")).toBe(true);
});

test("executeColorize: throws on invalid/too-small input", async () => {
  await expect(executeColorize("dGVzdA==")).rejects.toThrow();
});
