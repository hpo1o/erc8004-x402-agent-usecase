// ---------------------------------------------------------------------------
// tests/registration.test.ts
//
// Validates that erc8004/registration/colorizer.json conforms to the
// ERC-8004 registration-v1 schema (name/endpoint service format).
// Catches schema drift before on-chain re-registration.
// ---------------------------------------------------------------------------

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Load registration file
// ---------------------------------------------------------------------------

const colorizerPath = resolve(
  process.cwd(),
  "erc8004/registration/colorizer.json"
);

interface ServiceEntry {
  name: string;
  endpoint: string;
  version?: string;
}

interface RegistrationFile {
  type: string;
  name: string;
  active: boolean;
  x402Support: boolean;
  services: ServiceEntry[];
  registrations: Array<{ agentRegistry: string; agentId: string }>;
}

const reg: RegistrationFile = JSON.parse(readFileSync(colorizerPath, "utf-8"));

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

test("colorizer.json: type is ERC-8004 registration-v1", () => {
  expect(reg.type).toBe(
    "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"
  );
});

test("colorizer.json: active is true", () => {
  expect(reg.active).toBe(true);
});

test("colorizer.json: x402Support is true", () => {
  expect(reg.x402Support).toBe(true);
});

test("colorizer.json: services[] contains an A2A entry", () => {
  const a2a = reg.services.find(
    (s) => s.name.toLowerCase() === "a2a"
  );
  expect(a2a).toBeDefined();
  // Endpoint must be a valid HTTP(S) URL
  expect(a2a!.endpoint).toMatch(/^https?:\/\/.+/);
});

test("colorizer.json: A2A service uses official name/endpoint schema (not type/url)", () => {
  for (const svc of reg.services) {
    // Must have name and endpoint (ERC-8004 spec)
    expect(typeof svc.name).toBe("string");
    expect(typeof svc.endpoint).toBe("string");
    // Must NOT have legacy type/url fields
    expect((svc as Record<string, unknown>)["type"]).toBeUndefined();
    expect((svc as Record<string, unknown>)["url"]).toBeUndefined();
  }
});

test("colorizer.json: registrations[] is non-empty with valid agentId", () => {
  expect(reg.registrations.length).toBeGreaterThan(0);
  const last = reg.registrations[reg.registrations.length - 1];
  expect(last.agentId).toBeDefined();
  expect(Number(last.agentId)).toBeGreaterThan(0);
});

test("colorizer.json: agentRegistry uses eip155 CAIP-2 format", () => {
  const last = reg.registrations[reg.registrations.length - 1];
  expect(last.agentRegistry).toMatch(/^eip155:\d+:0x[0-9a-fA-F]{40}$/);
});
