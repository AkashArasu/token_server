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
   the Worker at the existing public API hostname.
4. Configure the Stream Firebase and APNs VoIP push providers in the Stream
   dashboard. The provider names must match the mobile `AppKeys` values.
5. Host `/.well-known/assetlinks.json` on `qringer.app` and the Apple
   `apple-app-site-association` document before enabling App/Universal Links.

## Public API

- `POST /v1/visitor-sessions` accepts `{ "propertyId": "…", "requestId": "…" }`
  from the visitor QR page and begins ringing automatically. Reusing the same
  request ID safely recovers a response lost during a network interruption.
- `GET /v1/calls/{id}/events` is a short-poll signaling endpoint authenticated
  by the visitor session capability.
- Homeowner endpoints require a verified Firebase ID token. They create the
  opaque property ID and issue a short-lived Stream session token.

The Worker keeps only property mappings and one active call state per property;
it does not record video or audio. Ringing expires after 30 seconds, and a
one-hour accepted-call safety timeout prevents an abandoned session from
leaving the property permanently Busy.
