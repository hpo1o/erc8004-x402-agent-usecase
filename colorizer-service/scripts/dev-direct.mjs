/**
 * dev-direct.mjs — starts colorizer-service without going through `aixyz dev`.
 *
 * Why this exists:
 *   `npx aixyz dev` internally calls Bun.spawn(["bun", worker, entrypoint, port]).
 *   On Windows, Bun.spawn uses CreateProcess which only finds native .exe files
 *   in PATH — not the .cmd wrapper that npm installs for "bun".
 *   This script bypasses that spawn by calling bun.exe directly via Node's
 *   child_process.spawn (which correctly resolves .cmd on Windows).
 *
 * What it does — same as `aixyz dev` under the hood:
 *   1. Load .env files (same as @next/env does in the CLI)
 *   2. Print the startup banner
 *   3. Spawn: bun <worker.ts> <app/server.ts> <port>
 *   4. Watch app/ for changes and restart (hot-reload)
 */

import { spawn } from "node:child_process";
import { readFileSync, watch, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");

// ---------------------------------------------------------------------------
// Step 1 — Load .env files (mirrors what @next/env does in aixyz dev)
//
// Priority order (same as Next.js / @next/env):
//   .env.local  →  .env.development  →  .env
// Later files do NOT override earlier ones.
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Don't override vars already in the environment (same as @next/env)
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

for (const name of [".env.local", ".env.development", ".env"]) {
  loadEnvFile(resolve(ROOT, name));
}

process.env.NODE_ENV = "development";
process.env.AIXYZ_ENV = "development";

// ---------------------------------------------------------------------------
// Step 2 — Resolve paths
//
// worker.ts  — the aixyz dev worker (imported directly by bun, no compile step)
// entrypoint — our app/server.ts (custom server with AixyzApp + plugins)
// ---------------------------------------------------------------------------
const WORKER = resolve(ROOT, "node_modules/@aixyz/cli/dev/worker.ts");
const ENTRYPOINT = resolve(ROOT, "app/server.ts");
const PORT = process.env.PORT || "3000";
const BASE_URL = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Step 3 — Find bun.exe
//
// Search order:
//   a) node_modules/.bin/bun.exe  (local, copied during setup)
//   b) npm global: node_modules/bun/bin/bun.exe relative to npm prefix
//   c) "bun" — fallback, works if bun is natively in PATH
// ---------------------------------------------------------------------------
function findBunExe() {
  const candidates = [
    // 1. Local node_modules/.bin/bun.exe — copied during setup (most reliable)
    resolve(ROOT, "node_modules/.bin/bun.exe"),
    // 2. npm global install on Windows (standard npm install -g bun location)
    resolve(process.env.APPDATA || "", "npm/node_modules/bun/bin/bun.exe"),
    // 3. Native bun install on Windows (~/.bun/bin/)
    resolve(process.env.USERPROFILE || "", ".bun/bin/bun.exe"),
    // 4. Native bun install on Unix/Mac
    resolve(process.env.HOME || "", ".bun/bin/bun"),
  ];

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }

  // Last resort: let the OS find it (works if bun.exe is genuinely in PATH)
  return "bun";
}

const BUN_EXE = findBunExe();

// ---------------------------------------------------------------------------
// Step 4 — Startup banner (matches aixyz dev output)
// ---------------------------------------------------------------------------
console.log("");
console.log(`\x1b[94m➫ aixyz.sh (direct)\x1b[0m`);
console.log(`- A2A:           ${BASE_URL}/.well-known/agent-card.json`);
console.log(`- MCP:           ${BASE_URL}/mcp`);
console.log(`- Environments:  .env`);
console.log(`- Runner:        ${BUN_EXE}`);
console.log("");

// ---------------------------------------------------------------------------
// Step 5 — Spawn bun worker
//
// Node's child_process.spawn on Windows resolves .cmd files correctly,
// so even if BUN_EXE resolves to "bun" it will find bun.cmd in PATH.
// The args mirror exactly what `aixyz dev` passes to the worker:
//   bun <worker.ts> <entrypoint> <port>
// (no "custom" flag — our server.ts has `export default app` so isCustom=false)
// ---------------------------------------------------------------------------
let child = null;

function startServer() {
  child = spawn(BUN_EXE, [WORKER, ENTRYPOINT, PORT], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env },
    // shell: true allows .cmd resolution on Windows as ultimate fallback
    shell: process.platform === "win32",
  });

  child.on("exit", (code) => {
    if (code !== 0) {
      console.log(`\nServer exited with code ${code}, waiting for changes...`);
    }
  });
}

function restartServer(reason) {
  console.log(`Restarting... ${reason}`);
  if (child) {
    child.kill();
    child = null;
  }
  setTimeout(startServer, 150);
}

startServer();

// ---------------------------------------------------------------------------
// Step 6 — Hot-reload: watch app/ and aixyz.config.ts for changes
// ---------------------------------------------------------------------------
let debounce = null;

watch(resolve(ROOT, "app"), { recursive: true }, (_event, filename) => {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => restartServer(filename || "file changed"), 100);
});

if (existsSync(resolve(ROOT, "aixyz.config.ts"))) {
  watch(resolve(ROOT, "aixyz.config.ts"), () => restartServer("config changed"));
}

// ---------------------------------------------------------------------------
// Step 7 — Graceful shutdown
// ---------------------------------------------------------------------------
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (child) child.kill();
    process.exit(0);
  });
}

// Keep the process alive
await new Promise(() => {});
