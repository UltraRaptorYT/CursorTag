# Cursor Tag

Cursor Tag is a disposable, browser-based multiplayer party game. Players join from their phones, calibrate a neutral holding position, and steer colored cursors on a shared host screen by tilting their devices.

## Game rules

- One connected player is randomly selected as **it**.
- The chaser scores `+1` by colliding with another cursor. Both cursors freeze for 300 ms, the tagged player becomes it, and a new 15–30 second timer starts.
- If time expires, the chaser loses `1` point, a different connected player becomes it, and play continues.
- Disconnected cursors remain frozen on screen. A disconnected chaser is released immediately so the game cannot get stuck.
- Rooms support 2–8 players by default. Change `MAX_PLAYERS` in `cloudflare/wrangler.jsonc` to use a different cap (2–16).

## Architecture

The repository keeps the original airmouse deployment pattern:

- **Next.js on Vercel** serves `/`, `/host`, and `/room/[code]`.
- **A Cloudflare Worker + one Durable Object per room** owns WebSockets, presence, collision detection, scores, alarms, and reconnect state.
- Cursor packets are forwarded in memory and are not stored on every frame. Only the active room snapshot is retained so a hibernated room or reconnect can recover. There are no accounts, game history, or leaderboard tables.

The split is intentional. A room needs every socket to reach the same coordinator. Keeping the coordinator outside the Vercel frontend preserves the airmouse approach and gives each room a stable, single authority.

## Local setup

Install dependencies:

```bash
bun install
```

Copy `.env.example` to `.env.local`, then run these in separate terminals:

```bash
bun run realtime:dev
bun run dev
```

Open `http://localhost:3000/host`, then use two controller clients at the QR URL.

Motion sensors generally require a secure context on real phones. For physical-device testing, use the deployed HTTPS frontend and WSS Worker, or put the local services behind trusted HTTPS tunnels.

## Validation

```bash
bun run typecheck
bun run lint
bun run build
bun run realtime:check
```

With the local Worker running, exercise a complete host → two players → calibration → start → tag → disconnect flow:

```bash
bun run realtime:smoke
```

## Latency tuning

The controller samples `deviceorientation`, removes a 1.5° dead zone, applies adaptive smoothing, and sends at most once every 33 ms (about 30 Hz). The host uses a 34 ms linear interpolation so motion is smooth without adding a long easing tail.

The controller header shows WebSocket round-trip time:

- green: up to 80 ms
- amber: 81–140 ms
- red: above 140 ms

The key tuning constants are near the top of `app/room/[code]/room-client.tsx`. Test on the same Wi-Fi and on cellular before changing smoothing or send frequency; RTT is only the network portion of tilt-to-photon latency.

## Deploy

### 1. Realtime Worker

Authenticate once, then deploy:

```bash
bunx wrangler login
bun run realtime:deploy
```

Wrangler prints a URL such as:

```text
https://cursor-tag-realtime.YOUR-SUBDOMAIN.workers.dev
```

Verify `/health`, then optionally restrict browser origins:

```bash
bunx wrangler secret put ALLOWED_ORIGINS --config cloudflare/wrangler.jsonc
```

Enter comma-separated frontend origins, for example `https://cursor-tag.vercel.app,https://play.example.com`.

### 2. Vercel frontend

Import this repository into Vercel and add this Production and Preview environment variable:

```text
NEXT_PUBLIC_CURSOR_TAG_WS_URL=wss://cursor-tag-realtime.YOUR-SUBDOMAIN.workers.dev
```

Redeploy after changing it because `NEXT_PUBLIC_` values are embedded in the browser bundle at build time.

