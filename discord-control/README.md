# Discord control plane

Standalone Discord worker for LOCO-Termux. The KakaoForge HTTP bridge is implemented in `src/openchat-main.ts` so it shares the same authenticated client used by the existing command runtime.

## Discord flow

- `/panel` opens a private control panel.
- Macro setup requests `GET /v1/rooms`, lets the user select a room, then asks for a message and interval and requires a separate confirmation.
- `POST /v1/auth/qr` starts QR authentication only when there is no saved auth file or active session; a real QR image is sent to the requesting user's Discord DM.
- `/license` shows product entitlements. Macro products do not unlock moderation.
- `/license-issue` is limited to configured Discord admin IDs. This records a manual grant; payment processing is not implemented.
- Mass-kick automation is not exposed. A future moderation workflow should preview targets and require a human confirmation per action.

## Important room-list limitation

`GET /v1/rooms` currently returns **rooms observed by the running LOCO-Termux client**, not a guaranteed complete list of every Open Chat the account has joined. A room appears after the runtime observes a message in it. The bot must not label this as a complete account room list until KakaoForge exposes and the project verifies a supported room-discovery method.

## Bridge endpoints

Every bridge request requires `Authorization: Bearer <LOCO_BRIDGE_TOKEN>`.

- `GET /health` — unauthenticated Render health check; reveals no secrets.
- `GET /v1/auth/status` — current client-ready state.
- `POST /v1/auth/qr` — returns a real QR data URL and expiry when a new login can be started.
- `GET /v1/rooms` — observed rooms, marked with `completeness: "observed-only"`.
- `POST /v1/macros` — validates message length and interval, allows one active macro per room, and delays the first send by the configured interval.
- `GET /v1/macros` — lists macro state.
- `DELETE /v1/macros/:id` — stops a macro.

The bridge defaults to localhost. For a public Render web service, set `LOCO_BRIDGE_HOST=0.0.0.0`, use a long random `LOCO_BRIDGE_TOKEN`, and enable a persistent disk for `LOCO_DATA_DIR`. Do not expose the service without bearer-token authentication.

## Environment

Set these as Render environment variables. Never commit secrets.

- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_ADMIN_IDS`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `LOCO_BRIDGE_URL`, `LOCO_BRIDGE_TOKEN`

Run `discord-control/supabase/schema.sql` in the intended Supabase project before using license commands. The service-role key must remain server-side. Do not use a local JSON file for production license state.

## Deployment status

The Render Blueprint defines a persistent-disk bridge web service and a separate Discord worker. Both are set to `autoDeploy: false`. Deployment is not complete until the services are created, environment variables are configured, the Supabase schema is applied, and the real Kakao QR/login + message flow is tested. QR reissue after an expired in-progress attempt still needs validation against the pinned KakaoForge library.
