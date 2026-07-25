type VercelRequest = {
  method?: string;
};

type VercelResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): VercelResponse;
  json(body: unknown): void;
};

function isConfigured(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function isPrivateKeyConfigured(name: string): boolean {
  const value = process.env[name]?.trim() ?? "";
  return /^(?:0x)?[0-9a-fA-F]{64}$/.test(value);
}

function isOptionalAddressValid(name: string): boolean {
  const value = process.env[name]?.trim();
  return !value || /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isOptionalHttpUrlValid(name: string): boolean {
  const value = process.env[name]?.trim();
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export const maxDuration = 10;

export default function health(_req: VercelRequest, res: VercelResponse): void {
  const checks = {
    openaiApiKey: isConfigured("OPENAI_API_KEY"),
    payerPrivateKey: isPrivateKeyConfigured("PAYER_PRIVATE_KEY"),
    serviceAccessToken: isConfigured("SERVICE_ACCESS_TOKEN"),
    paymentRecipientAddress: isOptionalAddressValid("PAYMENT_RECIPIENT_ADDRESS"),
    x402FacilitatorUrl: isOptionalHttpUrlValid("X402_FACILITATOR_URL"),
    erc8004PrivateKey: isPrivateKeyConfigured("ERC8004_PRIVATE_KEY"),
    pinataJwt: isConfigured("PINATA_JWT"),
  };

  const requiredReady =
    checks.openaiApiKey &&
    checks.payerPrivateKey &&
    checks.paymentRecipientAddress &&
    checks.x402FacilitatorUrl;

  res.setHeader("Cache-Control", "no-store");
  res.status(requiredReady ? 200 : 503).json({
    status: requiredReady ? "ok" : "degraded",
    service: "erc8004-frontend",
    runtime: "vercel",
    checks,
    timestamp: new Date().toISOString(),
  });
}
