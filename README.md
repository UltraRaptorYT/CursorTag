# Cursor Tag

Cursor Tag is a disposable, browser-based multiplayer party game. Players join from their phones, calibrate a neutral holding position, and steer colored cursors on a shared host screen by tilting their devices.

## Game rules

- One connected player is randomly selected as **it**.
- The chaser scores `+1` by colliding with another cursor. Both cursors freeze for 300 ms, the tagged player becomes it, and receives a 1.5-second shield against an instant re-tag.
- If time expires, every connected runner scores `+1` for surviving. Nobody is eliminated, so everyone plays the full game.
- Calibrated phones can move immediately in the warm-up arena before the host starts the round.
- Power-ups spawn one at a time at random moments during play: 5-second Turbo movement, a 5-second Slow Field against rivals, a 1-second rival freeze, or a `+2` point bonus. The host can choose Off, Normal (every 3–6 seconds, up to 3 on screen), or Chaos (every 1.5–3 seconds, up to 5). Turbo makes movement faster and more responsive; Slow Field gives rivals a heavy movement drag.
- Before starting, the host chooses 5, 10, or 15 rounds and a fixed 10, 15, or 20-second round timer.
- After the selected number of rounds, the player with the most points wins.
- Disconnected cursors get a 10-second reconnect grace period, then leave the room automatically. A disconnected chaser is released immediately so the game cannot get stuck.
- Rooms support 2–16 players by default. Change `MAX_PLAYERS` in `cloudflare/wrangler.jsonc` to use a lower cap.

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

The controller preserves the original airmouse mapping: calibrated `alpha` rotation controls horizontal aim, `beta` controls vertical aim, the ranges are 32° × 24°, smoothing is `0.35`, and updates are sent every 50 ms. Cursor Tag adds only the requested 1.5° neutral dead zone. The host retains the original 80 ms linear interpolation.

The controller header shows WebSocket round-trip time:

- green: up to 80 ms
- amber: 81–140 ms
- red: above 140 ms

The shared input implementation and tuning constants live in `lib/input/airmouse.ts`. Test on the same Wi-Fi and on cellular before changing them; RTT is only the network portion of tilt-to-photon latency.

## Deploy

### 1. Realtime Worker

Authenticate once, then deploy:

```bash
bunx wrangler login
bun run realtime:types
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
