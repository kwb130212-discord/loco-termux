# Discord control plane (feature branch)

This is a separate Discord control-plane service for LOCO-Termux. It does **not** claim that Kakao Open Chat transport is implemented: the current repository's OAuth path authenticates a Kakao account, but does not provide a supported API for listing all joined Open Chats, sending room messages, or kicking room members. The bot fails closed until a real, authorized bridge implementing the documented contract is connected.

## Intended Discord flow

- `/panel` opens a private ephemeral control panel.
- Macro setup fetches real rooms from `GET /v1/rooms`, presents a select menu (room ID distinguishes duplicate names), then opens a modal for message + interval. The service requires an explicit confirmation and a minimum 10-minute interval.
- QR login is requested from `POST /v1/auth/qr`; the returned QR is delivered in the user's Discord DM. QR is never fabricated. Refresh is delegated to the bridge and only shown when a new QR is actually returned.
- `/license` shows the calling Discord user's entitlements. Entitlements are separated: `allkick` cannot unlock macro, and `macro_monthly` / `macro_lifetime` cannot unlock moderation.
- `/license-issue` is restricted to configured Discord admin IDs and records manual license grants. Payment processing is not included; do not represent a grant as a completed payment.
- Mass-kick automation is intentionally not implemented. A moderation license can enable a review workflow, but a moderator must review and confirm individual actions through a supported platform interface.

## Bridge contract (must be implemented by a real supported transport)

All requests use `Authorization: Bearer LOCO_BRIDGE_TOKEN`.

- `GET /v1/rooms` -> `{ "rooms": [{ "id": "opaque-room-id", "name": "Room name", "isOpenChat": true, "canModerate": true }] }`
- `POST /v1/auth/qr` -> `{ "qrDataUrl": "data:image/png;base64,...", "expiresAt": "ISO-8601" }`
- `POST /v1/macros` -> `{ "id": "macro-id", "roomId": "...", "message": "...", "intervalMinutes": 10 }`
- `GET /v1/macros` -> `{ "macros": [...] }`
- `DELETE /v1/macros/:id` -> `{ "ok": true }`
- `GET /v1/auth/status` -> `{ "authenticated": true, "nickname": "..." }`

The Discord service validates responses and uses short request timeouts. No fake room data is returned if the bridge is missing.

## Environment

Copy `.env.example` and set secrets in Render's Environment page; never commit a real token or service-role key.

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_ADMIN_IDS`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `LOCO_BRIDGE_URL`, `LOCO_BRIDGE_TOKEN`

Use a persistent database for licenses and audit logs. Never use a local JSON file for production license state on Render because its filesystem can be ephemeral.

## Supabase

Run `supabase/schema.sql` in the intended Supabase project. Service-role key must remain server-side. The schema stores Discord IDs as text, separates license product types, prevents negative remaining-use counts, and records audit events. Restrict the service-role key and do not expose it to the client.

## Run

```bash
cd discord-control
npm install
cp .env.example .env
npm start
```

This control-plane package is not end-to-end until the bridge contract above is implemented and tested against a real session. OAuth login alone is not proof of Open Chat messaging capability.
