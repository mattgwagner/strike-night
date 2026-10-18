# STRIKE NIGHT — agent notes

Family browser FPS (CS-style deathmatch) for Matt, Amanda and the three boys.
Live: https://strikenight.redleg.dev · Repo: mattgwagner/strike-night · Worker `strike-night` in the Red Leg Dev CF account.

## Stack
- Client: Vite 8 + TypeScript + three.js 0.186, no framework. DOM HUD. WebAudio synth SFX (no asset files).
- Server: Cloudflare Worker serving `dist/client` via ASSETS, `/api/room/<code>` → one `Room` Durable Object per room running the authoritative `Game` (`src/worker/game.ts`) at 20 Hz over WebSockets (hibernation API).
- Shared (`src/shared/`): `constants.ts` (weapons, player dims, characters, match rules), `protocol.ts` (wire messages), `map.ts` (box-world map data, `block()`/`box()`/`stairs()` helpers), `physics.ts` (AABB move-and-slide, rays, line of sight). **Both client and server import these; keep them free of DOM/three/workers types.**

## Commands
```
npm run dev          # vite + local workerd (the CF plugin runs the DO locally). Port 5190, or the next free one — read the log.
npm test             # vitest: tests/physics.test.ts, tests/game.test.ts
npm run typecheck    # tsc for client AND worker (separate tsconfigs)
npm run build        # must pass before push
npm run deploy       # manual build + wrangler deploy. Normal path: push to main → Actions deploys (secret is set).
PLAYWRIGHT_DIR=~/.local/share/mise/installs/npm-playwright/latest/node_modules/playwright CHROMIUM=/usr/bin/chromium node e2e/two.mjs http://127.0.0.1:<port> e2e/out
```
`e2e/two.mjs` joins two headless browsers to a random room, walks one, has it shoot the other, prints positions/hp and screenshots both. Run it against the dev server before every push and against production after a deploy.

## Architecture invariants
- Movement is client-authoritative with a server clamp (`Game.handle` input: max distance per tick, resync after 8 rejects). Hits are client-detected (`Weapons.fire` raycasts world + player boxes) and **server-validated** (`Game.validateHit`: alive, range, hit point near the server's idea of the target, line of sight through `bulletBoxes`). Keep both halves in sync when you change player size or weapon ranges.
- Everything collidable is an axis-aligned box in `MapData.boxes`. Ramps are `stairs()`. `nocollide` = visual only. `shootThrough` = blocks movement, not bullets. The renderer merges boxes by `mat` into one mesh each.
- Remote players render at `serverNow() - 100ms` interpolation. Local player renders immediately.
- `yaw 0` looks down -Z; `forward()` in physics.ts is the single source of truth for yaw/pitch → direction.
- Character meshes (`world/skins.ts`) must fit inside the PLAYER box; the head mesh sits in the top `PLAYER.headHeight` so what you see is what gets hit.

## Gotchas
- Headless Chromium has no pointer lock. Tests set `window.strike.input.locked = true` and `setPaused(false)` to drive the game. `window.strike` is the `Game` instance (always exposed).
- SwiftShader renders at a few fps; an auto weapon needs the mouse held across a frame. A click is also queued (`fireQueued`) so semi-auto always fires once.
- The server rejects a position jump > ~2.9 m per tick. Test teleports must hop in ≤2 m steps (see `hopTo` in e2e/two.mjs).
- `vitest.config.ts` is separate from `vite.config.ts` because the Cloudflare plugin breaks under vitest.
- `npm install` on node 26 needs `allowScripts` for esbuild/workerd (already in package.json).
- three.js uses physical light units: point lights need intensity in the hundreds to be visible.

## House rules for parallel agents
- Work in your own worktree: `git worktree add ~/Code/strike-night-wt-<name> -b wt/<name> origin/main`, then `npm ci` there. Never touch `~/Code/strike-night` (the driver's checkout).
- `git pull --rebase origin main` before starting and before every push. Stage by path, never `-A`. Never `git reset --hard`. Push with `git push origin HEAD:main`.
- Gate before push: `npm test && npm run typecheck && npm run build`, plus `e2e/two.mjs` against your dev server.
- Stay inside your workstream's files (collision map below). If you must touch a shared file, add; don't rewrite. Say so in the commit message.
- Don't deploy. The driver deploys after merging.

## Current wave (2026-10-18 evening) — collision map
| Workstream | Owns | Touches only by adding |
|---|---|---|
| world (Opus) | `src/shared/map.ts` content, `src/client/world/*`, `tests/map.test.ts`, `e2e/tour.mjs` | `constants.ts` CHARACTERS blurbs |
| feel (Opus) | `src/client/engine/*`, `src/client/game.ts`, `src/client/world/viewmodel.ts`, `src/client/world/fx.ts` (new) | `constants.ts` WEAPONS tuning, `hud.ts` new methods |
| bots (Cursor) | `src/worker/bots.ts` (new), `src/worker/game.ts`, `src/worker/index.ts`, `tests/game.test.ts`, `tests/bots.test.ts` | `protocol.ts` new optional fields |
| ui (Cursor) | `src/client/ui/*`, `src/client/audio/*`, `src/client/main.ts`, `index.html` | nothing else |
