# TWIGA WhatsApp production deployment

This repository contains two separate production services. Do not link the same environment group to both services: the OpenWA gateway does not need the xAI key, Supabase service-role key or R2 credentials.

## Render workspace setup

Workspace: Michael's workspace.

Two Render environment groups have been prepared:
- `twiga-openwa-gateway-production` — OpenWA master key and gateway runtime settings only.
- `twiga-whatsapp-production` — TWIGA Reply API settings. It already has `OPENWA_API_KEY` set to the matching OpenWA master key and `OPENWA_WEBHOOK_SECRET` set for webhook signatures.

The environment groups are not linked to services yet. Render rejected service creation with HTTP 402 because the workspace requires payment information first. Add a payment method at https://dashboard.render.com/billing, then create the services below and link only their respective group.

### Service 1: OpenWA gateway

- Service name: `twiga-openwa-gateway`
- Type: Web Service
- Repository: this repository, `main`
- Runtime: Docker
- Dockerfile: `./Dockerfile`
- Docker context: repository root
- Region: Singapore
- Plan: Standard (paid; persistent storage is required)
- Health check: `/api/health/ready`
- Persistent disk: 1 GB at `/app/data`
- Environment group: `twiga-openwa-gateway-production` only

The gateway group's variables set the internal port to 2785, Baileys engine, SQLite databases under /app/data, auto-start and session directories. Keep one gateway instance for its SQLite database and linked-device sessions. Do not scale it horizontally.

### Service 2: TWIGA Reply API

- Service name: `twiga-whatsapp-reply`
- Type: Web Service
- Repository: this repository, `main`
- Runtime: Node
- Root directory: `twiga-reply`
- Build command: `npm install`
- Start command: `npm start`
- Region: Singapore
- Plan: Starter (paid; must remain available to receive webhooks)
- Health check: `/healthz`
- Environment group: `twiga-whatsapp-production` only

After Render gives both services their public URLs, add these variables to the TWIGA Reply group:
- `OPENWA_BASE_URL`: the gateway public origin, e.g. `https://twiga-openwa-gateway.onrender.com` (no trailing slash and no /api suffix).
- `OPENWA_WEBHOOK_URL`: the reply service public URL plus `/webhooks/openwa`.

### Required reply-service secrets still to add

Add these directly in the Render environment group editor. Do not place them in GitHub, the APK, or this document.
- `SUPABASE_SERVICE_ROLE_KEY`: from Supabase Project Settings → API → service_role (server-side only).
- `XAI_API_KEY`: a newly rotated xAI API key. Any key pasted into a chat should be considered exposed and revoked.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: the R2 S3 credentials described below.

Already configured in the reply group:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- `OPENWA_API_KEY` (matches the gateway API master key)
- `OPENWA_WEBHOOK_SECRET`
- `R2_ACCOUNT_ID`, `R2_BUCKET=twiga-product-images`
- `XAI_MODEL=grok-3-mini`
- TWIGA dashboard CORS origins

## Cloudflare R2

The private `twiga-product-images` bucket already exists in the Cloudflare account. Its CORS policy permits GET, PUT and HEAD from `https://app.twiga.co.ke` and `https://twiga.co.ke`. Public bucket access is not enabled.

Create an R2 S3 API token in the Cloudflare dashboard:
1. Open R2 Object Storage → Overview → Account Details → API Tokens.
2. Create an account-level R2 API token with Object Read & Write access.
3. Scope it to the `twiga-product-images` bucket only.
4. Copy the Access Key ID and Secret Access Key into the Render reply-service group as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.

Cloudflare guide: https://developers.cloudflare.com/r2/api/tokens/

## Final verification sequence

After deploying and adding all required secrets:
1. Confirm the gateway and reply services both report Healthy.
2. Open the reply service `/healthz` and confirm `ok=true`.
3. Sign in to TWIGA, select a business and call `POST /api/whatsapp/connect`; scan the QR using that business's WhatsApp account.
4. Confirm `GET /api/whatsapp/status` reports `connected` for that business.
5. Enable AI replies only for a controlled test business. Send a test message from a separate WhatsApp account; confirm an inbound row and outbound Grok reply in the same business's message list.
6. Test a product photo upload. Confirm the image object path begins `businesses/<that-business-id>/products/`, then confirm the UI can load its signed image URL.
7. Send `STOP` from the test customer and confirm no new AI marketing/follow-up messages are sent. Test a separate business and verify its inbox, products and WhatsApp session are isolated.
8. Confirm a scheduled follow-up is rejected without opt-in confirmation, and only runs after the customer has explicitly opted in.

The GitHub CI smoke test verifies the reply server starts, the health endpoint responds, unauthenticated business routes are denied, and unsigned OpenWA webhooks are rejected. It cannot replace the real QR scan, inbound WhatsApp message, xAI response or R2 upload tests above.
