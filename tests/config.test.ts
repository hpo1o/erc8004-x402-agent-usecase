import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

test("active image-generation paths use GPT Image 2", () => {
  const sources = [
    read("image-generator/src/dalle.ts"),
    read("frontend/server.ts"),
  ];
  for (const source of sources) {
    expect(source).toContain("gpt-image-2");
    expect(source).not.toContain("dall-e-2");
  }
});

test("ERC-8004 metadata documents x402 v2 headers", () => {
  const registration = read("erc8004/registration/colorizer.json");
  expect(registration).toContain("PAYMENT-SIGNATURE");
  expect(registration).not.toContain("X-PAYMENT");
});

test("frontend requires a patched Multer major version", () => {
  const pkg = JSON.parse(read("frontend/package.json")) as {
    dependencies: Record<string, string>;
  };
  expect(pkg.dependencies.multer.replace(/^[~^]/, "").startsWith("2.")).toBe(true);
  expect(pkg.dependencies["@x402/express"]).toBeTruthy();
});

test("CI workflow and deployment guides are present", () => {
  expect(read(".github/workflows/ci.yml")).toContain("bun test tests/");
  const guide = read("docs/CUSTOM_DOMAIN.md");
  expect(guide).toContain("SERVICE_ACCESS_TOKEN");
  expect(guide).toContain("Root Directory");
  expect(guide).toContain("OPENAI_API_KEY");
});

test("Vercel runtime exports Express and exposes safe readiness checks", () => {
  const source = read("frontend/server.ts");
  expect(source).toContain("export const maxDuration = 300");
  expect(source).toContain("export default app");
  expect(source).toContain("if (!process.env.VERCEL)");
  expect(source).toContain("openaiApiKey");
  expect(source).toContain("PAYER_PRIVATE_KEY is not configured");
  expect(source).toContain("using the registered Agent 2 wallet");
  expect(source).toContain("using the default facilitator");
  expect(source).not.toContain('throw new Error("PAYMENT_RECIPIENT_ADDRESS must be a valid EVM address.")');
});

test("browser reports API response details instead of only an HTTP code", () => {
  const source = read("frontend/public/app.js");
  expect(source).toContain('contentType.includes("application/json")');
  expect(source).toContain("detail ||");
});

test("reputation and validation use separate wallet roles", () => {
  const reputation = read("erc8004/scripts/reputation.ts");
  const validation = read("erc8004/scripts/validation.ts");
  expect(reputation).toContain("loadPayerPrivateKey");
  expect(validation).toContain("loadOwnerPrivateKey");
  expect(validation).toContain("loadValidatorPrivateKey");
  expect(validation).toContain("args: [validatorAddress as Address");
});


test("Vercel maps the project root to the web UI", () => {
  const source = read("frontend/server.ts");
  const config = JSON.parse(read("frontend/vercel.json")) as {
    rewrites: Array<{ source: string; destination: string }>;
  };
  expect(source).toContain('app.get("/",');
  expect(config.rewrites).toContainEqual({ source: "/", destination: "/index.html" });
});


test("Vercel exposes explicit backend function entrypoints", () => {
  const config = JSON.parse(read("frontend/vercel.json")) as {
    rewrites: Array<{ source: string; destination: string }>;
  };
  for (const path of ["process", "reputation", "agent"]) {
    const source = read(`frontend/api/${path}.ts`);
    expect(source).toContain('from "../server.js"');
    expect(source).toContain("maxDuration");
  }

  const health = read("frontend/api/health.ts");
  expect(health).toContain('status: requiredReady ? "ok" : "degraded"');
  expect(health).toContain("paymentRecipientAddress");
  expect(health).not.toContain('from "../server.js"');

  expect(config.rewrites).toContainEqual({ source: "/health", destination: "/api/health" });
  expect(read("frontend/api/process.ts")).toContain("VERCEL_PROJECT_PRODUCTION_URL");
});


test("frontend local fallback is explicit and development-only", () => {
  const source = read("frontend/server.ts");
  expect(source).toContain("usedLocalColorizer");
  expect(source).toContain('process.env.ALLOW_LOCAL_COLORIZER_FALLBACK === "true"');
  expect(source).toContain("No fallback was used, so no x402 transaction was charged.");
  expect(source).toContain("Using the local grayscale fallback");
  expect(source).toContain(".grayscale()");
  expect(source).toContain('txHash: "local-fallback"');
  expect(source).toContain("ERC-8004 proof steps skipped for local fallback output");
});


test("embedded Agent 2 enforces a real Base Sepolia x402 payment", () => {
  const source = read("frontend/server.ts");
  expect(source).toContain("paymentMiddleware");
  expect(source).toContain('"POST /api/agent"');
  expect(source).toContain('price: "$0.01"');
  expect(source).toContain('"https://x402.org/facilitator"');
  expect(source).toContain('.register(X402_NETWORK, new ExactEvmServerScheme())');
  expect(source).toContain("function embeddedColorizerEndpoint");
  expect(source).toContain("if (process.env.VERCEL)");
  expect(source.indexOf("const vercelUrl")).toBeLessThan(source.indexOf("const configured"));
  expect(source).toContain('!process.env.VERCEL && process.env.ALLOW_LOCAL_COLORIZER_FALLBACK === "true"');
  expect(source).toContain("sendToColorizerWeb(imageBase64, colorizerEndpoint, emit)");
  expect(source).toContain("responseTimeMs, endpoint: colorizerEndpoint");
});


test("repository-root Vercel projects deploy the frontend application", () => {
  const config = JSON.parse(read("vercel.json")) as {
    installCommand: string;
    builds: Array<{ src: string; use: string }>;
    rewrites: Array<{ source: string; destination: string }>;
  };

  expect(config.installCommand).toBe("npm install --prefix frontend");
  expect(config.builds).toContainEqual({ src: "api/*.ts", use: "@vercel/node" });
  expect(config.builds).toContainEqual({ src: "frontend/public/**", use: "@vercel/static" });
  expect(config.rewrites).toContainEqual({
    source: "/",
    destination: "/frontend/public/index.html",
  });
  expect(config.rewrites).toContainEqual({
    source: "/health",
    destination: "/api/health",
  });

  for (const path of ["process", "reputation", "health", "agent"]) {
    const source = read(`api/${path}.ts`);
    expect(source).toContain(`from "../frontend/api/${path}.js"`);
    expect(source).toContain("maxDuration");
  }
});

test("portfolio page exposes stable project metadata", () => {
  const source = read("frontend/public/index.html");
  expect(source).toContain("https://erc8004-agent-demo.vercel.app/");
  expect(source).toContain("CI verified");
  expect(source).toContain("verifiable testnet payment and on-chain audit trail");
  expect(source).not.toContain("17 tests passing");
  expect(source).not.toContain("fully trustless");
});
