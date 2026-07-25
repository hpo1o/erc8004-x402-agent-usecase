# Custom domain deployment

## 1. Deploy the frontend

Create a Railway service from this repository with:

- Root Directory: `/frontend`
- Config File: `/frontend/railway.json`
- Builder: Dockerfile (`/frontend/Dockerfile`)
- Healthcheck: `/health`
- Port: supplied automatically through `PORT`

Copy every required value from `frontend/.env.example`. Use different wallets
for `PAYER_PRIVATE_KEY` (Agent 1) and `ERC8004_PRIVATE_KEY` (Agent 2 owner).

Set a long random `SERVICE_ACCESS_TOKEN`. The browser UI has an Access token
field and sends it only to `POST /api/process`.

## 2. Verify before adding DNS

Open:

```text
https://<railway-domain>/health
```

Expected response:

```json
{"status":"ok","service":"erc8004-frontend","timestamp":"..."}
```

Then run one upload flow and one prompt flow. Prompt generation requires
OpenAI API access to `gpt-image-2`; both flows require a funded Base Sepolia
payer wallet for x402.

## 3. Attach your domain

In Railway:

1. Open the frontend service.
2. Go to **Settings → Networking → Custom Domain**.
3. Enter the domain or subdomain, for example `agent.example.com`.
4. Copy the CNAME target shown by Railway.
5. Create that CNAME record at your DNS provider.
6. Wait for DNS verification and TLS issuance.

Do not proxy the record until Railway has issued the certificate. If using
Cloudflare, start with **DNS only**, then enable proxying after HTTPS works.

## 4. Keep the agent endpoint separate

The ERC-8004 registration currently points to the colorizer service at
`erc8004-agent-demo-production.up.railway.app`. Attaching a domain to the
frontend does not require an on-chain update.

If the colorizer endpoint itself moves, update
`erc8004/registration/colorizer.json`, pin the new registration file to IPFS,
and call `setAgentURI()` before removing the old endpoint.


## Vercel deployment

This repository is a monorepo. In Vercel Project Settings, set **Root
Directory** to `frontend`. The repository root is not the web application.

Vercel detects the default Express export in `frontend/server.ts`
automatically, serves `frontend/public/**` through its CDN, and runs the
backend with Fluid Compute. No Vercel build command or output directory is
needed.

Add these variables in **Settings → Environment Variables** for both Production
and Preview, then trigger a redeploy:

- `OPENAI_API_KEY` — required for prompt generation;
- `OPENAI_IMAGE_MODEL=gpt-image-2`;
- `PAYER_PRIVATE_KEY` — required if Agent 2 responds with x402 payment;
- `SERVICE_ACCESS_TOKEN` — recommended for public deployments;
- `ERC8004_PRIVATE_KEY` and `PINATA_JWT` — optional on-chain proof steps.

Check `/health` after deployment. It returns only safe booleans, never secret
values. Prompt generation is ready only when `checks.openaiApiKey` is `true`.
If it is `false`, the variable is missing from the environment used by that
specific Vercel deployment. Environment changes require a redeploy.
