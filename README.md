# QROnly signaling service

This Worker owns property routing and the doorbell call state. It is not a
general-purpose Stream token issuer.

## Provisioning

1. Create a Cloudflare D1 database named `qringer`, replace the placeholder
   `database_id` in `wrangler.jsonc`, then apply both SQL files in `migrations/`
   in numeric order.
2. Set the deployment secrets; never add them to `wrangler.jsonc`:

   ```sh
   wrangler secret put STREAM_API_KEY
   wrangler secret put STREAM_API_SECRET
   ```

3. Set `VISITOR_WEB_ORIGIN` to the exact deployed Flutter web origin and deploy
   the Worker at the existing public API hostname. Optional
   `VISITOR_WEB_ORIGINS` is a comma-separated list of additional preview origins.
4. Configure the Stream Firebase and APNs VoIP push providers in the Stream
   dashboard. The provider names must match the mobile `AppKeys` values.
5. Configure a signed Stream Video webhook to
   `https://<worker-host>/v1/stream/webhook` for `call.ended` and
   `call.session_ended`. The Worker verifies `X-Signature` with the existing
   `STREAM_API_SECRET`; no new secret is needed. This releases an accepted
   property call when a client End request is lost. Calls created before this
   Worker version lack the required property metadata and continue to use the
   one-hour safety timeout.
6. Host `/.well-known/assetlinks.json` on `qringer.app` and the Apple
   `apple-app-site-association` document before enabling App/Universal Links.

## Public API

- `POST /v1/visitor-sessions` accepts `{ "propertyId": "…", "requestId": "…" }`
  from the visitor QR page and begins ringing automatically. Reusing the same
  request ID safely recovers a response lost during a network interruption.
- `POST /v1/visitor-sessions/abandon` accepts the same property and request ID
  when a page closes before session creation returns. A 60-second tombstone
  prevents a late request from ringing an absent visitor.
- `GET /v1/calls/{id}/events` returns an authenticated state snapshot. A
  WebSocket upgrade to the same endpoint streams state changes immediately;
  pass `propertyId` in the URL and the visitor secret as the
  `session.<token>` WebSocket subprotocol, alongside `qronly.v1`. The visitor
  app falls back to two-second polling if the socket disconnects and uses a
  ten-second safety snapshot while connected.
- A property permits 20 new calls per source and 60 total new calls per ten
  minutes. Idempotent retries and Busy responses do not consume attempts;
  excess attempts return HTTP 429 with `Retry-After`.
- Homeowner endpoints require a verified Firebase ID token. They create the
  opaque property ID and issue a short-lived Stream session token.

The Worker keeps only property mappings and one active call state per property;
it does not record video or audio. Ringing expires after 30 seconds, and a
one-hour accepted-call safety timeout prevents an abandoned session from
leaving the property permanently Busy.
