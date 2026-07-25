import OpenAI from "openai";
import sharp from "sharp";

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";

/**
 * Generate an image with the current GPT Image model and normalize it to a
 * compact PNG before sending it through A2A. Keeping the transport image below
 * 1024px avoids oversized JSON/base64 requests while preserving demo quality.
 */
export async function generateImage(prompt: string): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log(`  → Requesting ${IMAGE_MODEL} image for: "${prompt}"`);

  let response: Awaited<ReturnType<typeof client.images.generate>>;
  try {
    response = await client.images.generate({
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      size: "1024x1024",
      quality: "low",
    });
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      const apiErr = err as InstanceType<typeof OpenAI.APIError> & {
        error?: { type?: string; code?: string };
      };
      throw new Error(
        `OpenAI API error — HTTP ${apiErr.status} ${apiErr.name}\n` +
        `  message : ${apiErr.message}\n` +
        `  type    : ${apiErr.error?.type ?? "—"}\n` +
        `  code    : ${apiErr.error?.code ?? "—"}\n` +
        "  hint    : check OPENAI_API_KEY, billing status, and image-model access",
        { cause: err }
      );
    }
    throw err;
  }

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned an empty image response");

  const optimized = await sharp(Buffer.from(b64, "base64"))
    .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return optimized.toString("base64");
}
