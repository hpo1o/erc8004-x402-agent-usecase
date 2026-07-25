// ---------------------------------------------------------------------------
// mock-facilitator.ts
//
// A fake x402 FacilitatorClient that unconditionally approves every payment.
// Used when X402_MOCK=true to bypass the remote Agently facilitator
// (https://x402.use-agently.com/facilitator).
//
// Why a mock facilitator instead of disabling x402 entirely?
//   - The full x402 middleware still runs: the client must send PAYMENT-SIGNATURE header
//   - The EIP-3009 signature is still created by the client
//   - Only the on-chain settlement / remote verification is skipped
//   - This lets you test the complete payment flow end-to-end without real funds
//     or an accessible external facilitator
//
// What the real facilitator does (for reference):
//   verify()      → checks the EIP-3009 signature is valid on-chain
//   settle()      → broadcasts transferWithAuthorization to the USDC contract
//   getSupported() → advertises which networks/schemes are supported
// ---------------------------------------------------------------------------

import type { FacilitatorClient } from "aixyz/accepts";

// Deliberately un-real mock transaction identifier.
// Does NOT start with 0x so it cannot be confused with a real on-chain hash.
const MOCK_TX_HASH = "MOCK_TX_NOT_REAL_0x0000000000000000000000000000000000000000";

export const mockFacilitator: FacilitatorClient = {
  // ── verify ───────────────────────────────────────────────────────────────
  // The real implementation checks the EIP-3009 signature against the
  // USDC contract on-chain. We skip that and always return isValid: true.
  async verify(_payload, _requirements) {
    console.warn("[x402 MOCK] ⚠ FAKE PAYMENT — not a real transaction");
    console.log(
      "[x402 MOCK] verify() called — skipping on-chain check, returning isValid: true"
    );
    return {
      isValid: true,
      // payer field is optional; omitting it is valid
    };
  },

  // ── settle ───────────────────────────────────────────────────────────────
  // The real implementation calls transferWithAuthorization on the USDC
  // contract and waits for the transaction receipt. We return a fake txHash.
  async settle(_payload, requirements) {
    console.warn("[x402 MOCK] ⚠ FAKE PAYMENT — not a real transaction");
    console.log(
      `[x402 MOCK] settle() called — skipping broadcast, returning mock txHash`
    );
    console.log(`[x402 MOCK] Mock txHash: ${MOCK_TX_HASH}`);
    return {
      success: true,
      transaction: MOCK_TX_HASH,
      // network must match what the client sent — read it from requirements
      network: requirements.network,
    };
  },

  // ── getSupported ──────────────────────────────────────────────────────────
  // Advertises which scheme/network combinations this facilitator handles.
  // The client uses this to decide which payment option to select.
  async getSupported() {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "eip155:84532" as `eip155:${number}`, // Base Sepolia
        },
        {
          x402Version: 2,
          scheme: "exact",
          network: "eip155:8453" as `eip155:${number}`,  // Base Mainnet
        },
      ],
      extensions: [],
      signers: {} as Record<string, string[]>,
    };
  },
};
