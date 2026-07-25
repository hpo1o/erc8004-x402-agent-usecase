import type { AixyzConfig } from "aixyz/config";

const config: AixyzConfig = {
  name: "Colorizer Service",
  description:
    "Accepts a base64-encoded image (data URL or raw base64) and returns a grayscale version. " +
    "Charges $0.01 USDC via x402 on Base Sepolia.",
  version: "0.1.0",

  x402: {
    // Wallet address that receives USDC payments on Base Sepolia
    // Set via env so we never hardcode a private key derivation path here
    payTo: process.env.PAYMENT_RECIPIENT_ADDRESS as `0x${string}`,

    // Base Sepolia testnet in CAIP-2 format
    // eip155:84532 = Base Sepolia  |  eip155:8453 = Base Mainnet
    network: "eip155:84532",
  },

  skills: [
    {
      id: "colorize",
      name: "Colorize (Grayscale)",
      description: "Converts a color image to black-and-white. Costs $0.01 USDC per call.",
      tags: ["image", "grayscale", "colorize", "processing"],
      examples: [
        "Convert this image to black and white: https://example.com/photo.jpg",
        "Make a grayscale version of my image",
      ],
    },
  ],
};

export default config;
