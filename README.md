# STRIKE NIGHT

Family paintball that runs in the browser. No install: open https://strikenight.redleg.dev, pick a name, a character and a marker, share the room code, play. Nobody dies: three hits and you're marked out.

- WASD move · mouse aim · click shoot · R reload · 1/2/3 marker, sidearm, hand tag · G paint grenade · F smoke · Ctrl crouch · Space jump · Tab scores · Enter chat · right-click scopes the pump marker
- Markers: Semi (accurate, 5 balls a second), Auto (10 a second, more spread), Pump (scoped, one ball marks you out). A body mark takes 1 hit, a head mark 2.
- Rooms: `?room=family` (default). Anyone with the same room code is in the same match.
- Modes (pause menu): free-for-all and team paintball (first to 30 marks or best after 6 minutes), and Elimination: two sides, no coming back until the round ends, 2:30 rounds, first to 7 rounds.

Built with three.js on the client and a Cloudflare Durable Object per room as the authoritative server. See `AGENTS.md` for the architecture and how to work on it.
