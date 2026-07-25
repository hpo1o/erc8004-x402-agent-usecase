import type { Accepts } from "aixyz/accepts";
import { executeColorize } from "./tools/colorize";

// ---------------------------------------------------------------------------
// x402 Payment declaration
//
// aixyz reads this named export and wraps the /agent endpoint with
// HTTP 402 middleware before the request reaches the agent.
// ---------------------------------------------------------------------------
export const accepts: Accepts = {
  scheme: "exact",
  price: "$0.01",
};

// ---------------------------------------------------------------------------
// Deterministic agent — no LLM involved.
//
// Converting an image to grayscale requires no reasoning: the input is a
// base64 image, the output is sharp().grayscale(). Using an LLM here would
// be unreliable (models truncate large base64 strings) and wasteful.
//
// Interface contract (AixyzApp A2APlugin):
//   agent.stream({ prompt }) → { textStream: AsyncIterable<string> }
//
// The executor iterates textStream chunks and publishes each as an
// artifact-update event → result.artifacts[0].parts[0].text in the response.
// ---------------------------------------------------------------------------
export default {
  stream: async ({ prompt }: { prompt: string }) => {
    // prompt is the text content from the user's A2A message parts —
    // in our case the full "data:image/png;base64,..." data URL.
    console.log("  [agent] calling executeColorize...");
    const grayscaleDataUrl = await executeColorize(prompt.trim());
    console.log(`  [agent] done — output ${grayscaleDataUrl.length} chars`);

    // Return as a single-chunk async generator so textStream is non-empty.
    async function* makeStream() {
      yield grayscaleDataUrl;
    }

    return { textStream: makeStream() };
  },
};
