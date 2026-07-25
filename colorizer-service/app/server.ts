// Custom server entry point.
//
// aixyz normally auto-generates .aixyz/dev/server.ts, but on Windows it
// produces backslash paths (..\..\app/agent) that Bun cannot resolve.
// Providing this file at app/server.ts overrides the auto-generated one.
// See: https://github.com/AgentlyHQ/aixyz — "Custom server" section.

import { AixyzApp } from "aixyz/app";
import { HTTPFacilitatorClient } from "aixyz/accepts";
import { IndexPagePlugin } from "aixyz/app/plugins/index-page";
import { A2APlugin } from "aixyz/app/plugins/a2a";
import { MCPPlugin } from "aixyz/app/plugins/mcp";

// These imports use forward-slash relative paths — safe on all platforms
import * as agent from "./agent";
import * as colorize from "./tools/colorize";
import { mockFacilitator } from "./mock-facilitator";

// ---------------------------------------------------------------------------
// Facilitator selection
//
// X402_MOCK=true  → mockFacilitator: always approves, no network calls
// X402_MOCK=false → Coinbase facilitator: https://x402.org/facilitator
//
// Use mock mode when:
//   - testing locally without real USDC
//   - the EIP-3009 signature logic works but on-chain settlement fails
// ---------------------------------------------------------------------------
const isMock = process.env.X402_MOCK === "true";

const facilitator = isMock
  ? mockFacilitator
  : new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });

if (isMock) {
  console.warn(`
╔══════════════════════════════════════════════════════╗
║  ⚠  MOCK MODE ACTIVE — PAYMENTS ARE NOT REAL        ║
║  All x402 payments will be accepted without          ║
║  on-chain verification. txHash will be FAKE.         ║
║  Set X402_MOCK=false for real Base Sepolia payments. ║
╚══════════════════════════════════════════════════════╝`);
} else {
  console.log("[x402] Using Coinbase facilitator: https://x402.org/facilitator");
}

// AixyzApp is the HTTP server. It:
//   - reads aixyz.config.ts for agent metadata and x402 settings
//   - mounts plugins as route handlers
//   - starts on port 3000 by default (overridable via PORT env var)
const app = new AixyzApp({ facilitators: facilitator });

// IndexPagePlugin — serves a human-readable HTML page at GET /
// useful for manual testing in the browser
await app.withPlugin(new IndexPagePlugin());

// A2APlugin — mounts the agent behind the A2A protocol:
//   POST /agent          → JSON-RPC task endpoint (payment-gated via x402)
//   GET  /.well-known/agent-card.json → A2A Agent Card (separate from ERC-8004 registration file)
//                                       ERC-8004 registration is stored on IPFS, see erc8004/registration/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await app.withPlugin(new A2APlugin(agent as any));

// MCPPlugin — exposes tools over WebSocket at /mcp
// Allows MCP-compatible desktop and IDE clients to call the colorize tool directly
await app.withPlugin(new MCPPlugin([
  { name: "colorize", exports: colorize },
]));

await app.initialize();

export default app;
