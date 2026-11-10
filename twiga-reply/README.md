# TWIGA WhatsApp Reply

A TWIGA multi-business WhatsApp reply and follow-up bridge built alongside the OpenWA gateway. It uses OpenWA for WhatsApp Web sessions and xAI's OpenAI-compatible chat completions endpoint for short text replies.

## Runtime services
- OpenWA gateway: the upstream OpenWA Docker image built from the repository root. Mount a Render persistent disk at `/app/data`; WhatsApp linked-device credentials must survive deploys and restarts.
- This service: Render Node web service with root directory `twiga-reply`, start command `npm start`, health check `/healthz`.

## Required environment variables
- `PORT` (Render supplies this)
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (secret; server-side only)
- `OPENWA_BASE_URL` (gateway origin, without trailing slash or /api)
- `OPENWA_API_KEY` (OpenWA master/API key; secret)
- `OPENWA_WEBHOOK_SECRET` (random 32+ character secret, same value used to register OpenWA webhook signatures)
- `OPENWA_WEBHOOK_URL` (public URL + `/webhooks/openwa`)
- `XAI_API_KEY` (secret; set only after rotating any key that was exposed)
- `XAI_MODEL` (default `grok-3-mini`; override with a model enabled for the xAI account)
- `DASHBOARD_ORIGINS` (comma-separated exact dashboard origins)

## API
All dashboard routes require a Supabase access token in `Authorization: Bearer <JWT>` and verify membership in `business_members` for the requested business.
- `POST /api/whatsapp/connect` body: `{ "businessId": "..." }` — creates a per-business OpenWA session, registers signed message/status webhooks and returns QR data.
- `GET /api/whatsapp/status?businessId=...`
- `GET /api/whatsapp/qr?businessId=...`
- `POST /api/whatsapp/disconnect` body: `{ "businessId": "..." }`
- `PATCH /api/whatsapp/settings` body: `{ "businessId": "...", "aiEnabled": true, "systemPrompt": "..." }`
- `GET /api/whatsapp/messages?businessId=...`
- `POST /api/whatsapp/send` body: `{ "businessId": "...", "phone": "2547...", "message": "..." }` — authenticated staff reply.
- `POST /api/whatsapp/followups` body: `{ "businessId": "...", "phone": "2547...", "message": "...", "dueAt": "ISO timestamp", "customerName": "...", "consentConfirmed": true }

## Reply safeguards
- Only private one-to-one chats are auto-replied to; group chats, channels, broadcasts, calls and status events are not.
- Only inbound messages are considered. Own messages are ignored.
- Webhook HMAC signatures are verified against the raw request body.
- Message IDs are unique per OpenWA session; duplicate deliveries are ignored.
- AI replies are off by default until a business owner enables them.
- STOP / UNSUBSCRIBE / OPT OUT / CANCEL adds the sender to a business-scoped opt-out list and cancels scheduled WhatsApp follow-ups; START opts them back in.
- Scheduled follow-ups are sent only when `consent_status=opted_in`; do not use this for unsolicited marketing.
- Every API operation checks the signed-in user's business membership. Service-role credentials never leave this server.

## WhatsApp account note
OpenWA links a WhatsApp account as a companion device using the QR shown in TWIGA. This is an unofficial WhatsApp Web integration, not the official WhatsApp Business Platform Cloud API. WhatsApp can change or restrict companion-device automation. Use only accounts you own or are authorized to manage, respect opt-outs and customer consent, and test with a low-volume business number first.


## Business knowledge and POS catalogue

Every business has its own `twiga_business_profiles` row and its own `twiga_products` rows. The profile is where the owner explains what the business does, what it sells, who it serves, opening hours, service area, delivery/payment and return policies, FAQs, preferred tone/language, and custom receptionist instructions. The assistant loads only the selected business's profile and active products before drafting a WhatsApp reply.

API routes (all require a Supabase bearer token and membership in the requested business):
- `GET /api/business/profile?businessId=...`
- `PATCH /api/business/profile` with `businessId` and profile fields
- `GET /api/catalog/products?businessId=...`
- `POST /api/catalog/products`
- `PATCH /api/catalog/products`
- `DELETE /api/catalog/products`
- `POST /api/catalog/upload-url` with `businessId`, `contentType`, and `sizeBytes`
- `GET /api/catalog/image-url?businessId=...&key=...`

Product images are private R2 objects stored beneath `businesses/<business-id>/products/`. The service only signs keys under the authenticated business's own prefix. Upload URL expiry is 15 minutes; supported types are JPG, PNG and WebP; maximum upload is 5 MB.

### Cloudflare R2 environment

Set these as private Render environment variables (never commit them or put them in the APK):
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET=twiga-product-images`

R2 must first be enabled for the Cloudflare account and the bucket created. The API can then sign private PUT and GET URLs directly against the Cloudflare R2 S3-compatible endpoint. No public bucket is required.
