# STRIKE NIGHT

A CS-style family deathmatch that runs in the browser. No install: open https://strikenight.redleg.dev, pick a name and a character, share the room code, play.

- WASD move · mouse aim · click shoot · R reload · 1/2/3 weapons · Ctrl crouch · Space jump · Tab scores · Enter chat · right-click scopes the sniper
- Rooms: `?room=family` (default). Anyone with the same room code is in the same match.
- Modes: free-for-all and team deathmatch (pause menu). First to 30 or best after 6 minutes.

Built with three.js on the client and a Cloudflare Durable Object per room as the authoritative server. See `AGENTS.md` for the architecture and how to work on it.
