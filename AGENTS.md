# STRIKE NIGHT — agent notes

Family browser paintball FPS for Matt, Amanda and the three boys. Nobody dies: you get marked.
Live: https://strikenight.redleg.dev · Repo: mattgwagner/strike-night · Worker `strike-night` in the Red Leg Dev CF account.

## Stack
- Client: Vite 8 + TypeScript + three.js 0.186, no framework. DOM HUD. WebAudio synth SFX (no asset files).
- Server: Cloudflare Worker serving `dist/client` via ASSETS, `/api/room/<code>` → one `Room` Durable Object per room running the authoritative `Game` (`src/worker/game.ts`) at 20 Hz over WebSockets (hibernation API).
- Shared (`src/shared/`): `constants.ts` (weapons, player dims, characters, match rules), `protocol.ts` (wire messages), `map.ts` (box-world map data, `block()`/`box()`/`stairs()` helpers), `physics.ts` (AABB move-and-slide, rays, line of sight). **Both client and server import these; keep them free of DOM/three/workers types.**

## Commands
```
npm run dev          # vite + local workerd (the CF plugin runs the DO locally). Port 5190, or the next free one — read the log.
npm test             # vitest: tests/*.test.ts (physics, game + hits model, elim rounds, bots, projectiles, map)
npm run typecheck    # tsc for client AND worker (separate tsconfigs)
npm run build        # must pass before push
npm run deploy       # manual build + wrangler deploy. Normal path: push to main → Actions deploys (secret is set).
PLAYWRIGHT_DIR=~/.local/share/mise/installs/npm-playwright/latest/node_modules/playwright CHROMIUM=/usr/bin/chromium node e2e/two.mjs http://127.0.0.1:<port> e2e/out
```
`e2e/two.mjs` joins two headless browsers to a random room, walks one, has it mark the other out with three semi-marker clicks, prints the victim's hp after each (expect `[2,1,0]`) and screenshots both. Run it against the dev server before every push and against production after a deploy. Also: `e2e/fire.mjs` (paint fx, marked cam, pump scope), `e2e/nades.mjs` (grenades), `e2e/ui.mjs` (join, HUD, pause, scoreboards incl. elim), `e2e/scale.mjs` (rig scale after respawn).

## Architecture invariants
- Movement is client-authoritative with a server clamp (`Game.handle` input: max distance per tick, resync after 8 rejects). Hits are client-detected (`Weapons.fire` raycasts world + player boxes) and **server-validated** (`Game.validateHit`: alive, range, hit point near the server's idea of the target, line of sight through `bulletBoxes`). Keep both halves in sync when you change player size or weapon ranges.
- Everything collidable is an axis-aligned box in `MapData.boxes`. Ramps are `stairs()`. `nocollide` = visual only. `shootThrough` = blocks movement, not bullets. The renderer merges boxes by `mat` into one mesh each.
- Remote players render at `serverNow() - 100ms` interpolation. Local player renders immediately.
- `yaw 0` looks down -Z; `forward()` in physics.ts is the single source of truth for yaw/pitch → direction.
- Character meshes (`world/skins.ts`) must fit inside the PLAYER box; the head mesh sits in the top `PLAYER.headHeight` so what you see is what gets hit. Rig scale is set absolutely every frame (`setCrouch` owns `scale.y`); never scale the group multiplicatively.
- **Hits model.** `PLAYER.maxHp = 3` hits. `hp` on the wire is hits left. Damage = `round(WeaponDef.damage × (head ? headshot : 1))`: body mark 1, head mark 2, pump 3, hand tag 3 (instant out). Paint grenade `PAINT.damage = 1`. Change hits only in `constants.ts`; the HUD pips read `PLAYER.maxHp`.
- **Markers.** `WeaponId = 'tag' | 'pistol' | 'semi' | 'auto' | 'pump'` (renamed 2026-10-19 from knife/rifle/shotgun/sniper). Slot 1 = `PRIMARY_WEAPONS` (semi, auto, pump; `DEFAULT_PRIMARY` semi), slot 2 = pistol (sidearm marker), slot 3 = tag. All markers are hitscan, one ball per shot (`pellets: 1`). Only `pump` has `scope`.
- **Paint colour = the shooter's skin colour** (`CHARACTERS[].color`): ball streaks, player-hit bursts, wall splats (`Fx.decal`, 200 max, ~20 s), grenade bursts, and the splat disc on a marked rig (`SkinRig.mark`). Player-facing words are "mark/marked"; protocol names (`hp`, `kill`, `kills`, `deaths`) stay. `kill.nade = 'paint'` when a grenade made the mark (`applyDamage(..., w, nade)`).
- **Modes.** `ffa` (default for a new room), `tdm`, `elim`. `isTeamMode()` in protocol.ts is the one check for "two sides" (friendly fire, team spawns, bot targeting, grenade immunity); use it, not `=== 'tdm'`.
- **Elimination rounds** (`ELIM` in constants, `Game.tickRound` on the server). `match.round = { n, stage: 'freeze' | 'live' | 'over', winner?, why? }` and `match.endsAt` is the end of the current stage. Freeze 5 s (move, no shots/grenades: `Game.canAttack()`), live 2:30, a side with players and nobody standing loses (`why: 'wipe'`; both at once = draw, `winner: -1`), timeout gives the round to `ELIM.defenders` = team 1 (Day), 4 s round-over banner, first to 7 rounds (`teamScore` = rounds won). `Game.canRespawn()` is false for the whole live elim match: it gates the respawn message, the server auto-respawn, bots, and late joiners (they join with hp 0 and come in next round). `startRound` respawns everyone at their side's spawns. Marked players spectate client-side (click cycles living teammates).
- Active smoke is sent to a joiner right after `welcome`; the client derives a cloud's age from `until - SMOKE.durationMs`.

- Netcode hardening (2026-10-19): `join.v` must equal `PROTOCOL_VERSION` or the server answers `error: update` and the client reloads, so bump the version whenever the wire format or weapon ids change. The client reconnects with capped exponential backoff plus jitter and closes a socket that has not seen a pong for 6 s. A dropped socket keeps its player for `RECONNECT_GRACE_MS` (10 s); the welcome carries a token and a join with that token re-attaches to the same id and score.

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
- Stay inside your workstream's files (the current wave's collision map, below, when there is one). If you must touch a shared file, add; don't rewrite. Say so in the commit message.
- Don't deploy. The driver deploys after merging.

## Wave 2 (2026-10-19) — paintball conversion
One agent (paint) owned the whole repo for this wave: markers and the hits model, paint fx and wording, elimination rounds, and the grenade follow-ups (sounds, smoke for late joiners, no local splat through smoke, bot count read-back, no crosshair in the marked cam). The wave-1 collision map is retired; when several agents run again, write a new map here before starting.
