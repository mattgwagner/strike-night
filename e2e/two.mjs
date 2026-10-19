// Two headless browsers join the same room, one walks and marks the other out (three body hits).
// Usage: node e2e/two.mjs http://127.0.0.1:5192 out/   (room is random per run)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR ?? 'playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:5192';
const out = process.argv[3] ?? 'e2e/out';
mkdirSync(out, { recursive: true });
const room = 'e2e-' + Math.random().toString(36).slice(2, 7);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];
const mk = async (tag) => {
  const p = await browser.newPage({ viewport: { width: 960, height: 600 } });
  p.on('console', m => { if (process.env.DBG) console.log(tag, m.type(), m.text().slice(0, 200)); if (m.type() === 'error') errs.push(`${tag}: ${m.text().slice(0, 300)}`); });
  p.on('pageerror', e => errs.push(`${tag}: ${e.message}`));
  return p;
};
const join = async (p, name, skin, w) => {
  await p.goto(`${url}/?room=${room}&name=${name}&skin=${skin}&w=${w}`);
  await p.waitForSelector('button.go');
  await p.click('button.go', { timeout: 90000 });
  await p.waitForFunction(() => window.strike && window.strike.myId > 0, null, { timeout: 15000 });
  // headless has no pointer lock; pretend
  await p.evaluate(() => { window.strike.input.locked = true; window.strike.setPaused(false); });
};
const a = await mk('A'), b = await mk('B');
await join(a, 'Alpha', 'bot', 'semi');
await join(b, 'Bravo', 'bear', 'auto');
await a.waitForFunction(() => window.strike.remotes.size === 1, null, { timeout: 10000 });
await b.waitForFunction(() => window.strike.remotes.size === 1, null, { timeout: 10000 });
const state = p => p.evaluate(() => { const g = window.strike; const r = [...g.remotes.values()][0]; return { id: g.myId, me: g.me.body.p.map(n => +n.toFixed(2)), hp: g.hp, alive: g.me.alive, remote: r && { id: r.id, p: r.p.map(n => +n.toFixed(2)), hp: r.hp, name: r.name }, rtt: Math.round(g.net.rtt), phase: g.match.phase }; });
console.log('A0', JSON.stringify(await state(a)));
console.log('B0', JSON.stringify(await state(b)));
// A walks forward for a second
await a.keyboard.down('KeyW'); await a.waitForTimeout(1000); await a.keyboard.up('KeyW');
await a.waitForTimeout(400);
const a1 = await state(a), b1 = await state(b);
console.log('A1', JSON.stringify(a1));
console.log('B1', JSON.stringify(b1));
const moved = Math.hypot(a1.me[0] - b1.remote.p[0], a1.me[2] - b1.remote.p[2]);
console.log('B sees A within', moved.toFixed(2), 'm of where A is');
// Wait for the live phase so a warmup->live respawn cannot move players mid-test
await a.waitForFunction(() => window.strike.match.phase === 'live', null, { timeout: 25000 });
await a.waitForTimeout(500);
// Walk both onto open floor by the west wall (test-only hops of 2m; the server clamps teleports)
const hopTo = async (p, tx, tz) => {
  for (let i = 0; i < 60; i++) {
    const done = await p.evaluate(([tx, tz]) => { const g = window.strike; const dx = tx - g.me.body.p[0], dz = tz - g.me.body.p[2]; const d = Math.hypot(dx, dz); if (d < 0.3) return true; const k = Math.min(1.5, d) / d; g.me.body.p[0] += dx * k; g.me.body.p[2] += dz * k; g.me.body.p[1] = 0; return false; }, [tx, tz]);
    if (done) break;
    await p.waitForTimeout(200);
  }
};
await Promise.all([hopTo(a, -26, 0), hopTo(b, -20, 0)]);
// Under heavy load the hops outrun the 20 Hz input stream and the server resyncs late; wait for both views to agree.
const converged = async (p) => p.waitForFunction(() => { const g = window.strike; const r = [...g.remotes.values()][0]; return r && Math.hypot(r.p[0] - (g.myId === 1 ? -20 : -26), r.p[2]) < 1; }, null, { timeout: 20000 }).then(() => true).catch(() => false);
console.log('views converged:', await converged(a), await converged(b));
await b.waitForTimeout(500);
await a.evaluate(() => { const g = window.strike; const r = [...g.remotes.values()][0]; const dx = r.p[0] - g.me.body.p[0], dz = r.p[2] - g.me.body.p[2]; g.me.yaw = Math.atan2(-dx, -dz); g.me.pitch = -0.05; });
const hpBefore = (await state(b)).hp;
// three body marks with the semi marker (one ball per click) should take B out: hp 3 -> 2 -> 1 -> 0
const trail = [];
for (let i = 0; i < 3; i++) {
  await a.mouse.down(); await a.waitForTimeout(80); await a.mouse.up();
  await a.waitForTimeout(700);
  trail.push((await state(b)).hp);
}
console.log('B hp after each click', JSON.stringify(trail));
const a2 = await state(a), b2 = await state(b);
console.log('A2', JSON.stringify(a2));
console.log('B2', JSON.stringify(b2));
console.log(`B hp ${hpBefore} -> ${b2.hp} (expect 3 -> 0, B marked out: ${!b2.alive}); A sees B hp ${a2.remote.hp}`);
// Reconnect: close A's socket; the server keeps the player for the grace period and A rejoins with the same id
const idBefore = await a.evaluate(() => window.strike.myId);
await a.evaluate(() => window.strike.net.ws.close());
await a.waitForFunction(() => window.strike.net.connected, null, { timeout: 20000 });
await a.waitForTimeout(500);
const idAfter = await a.evaluate(() => window.strike.myId);
const bStillSeesA = await b.evaluate(id => window.strike.remotes.has(id), idBefore);
console.log(`reconnect kept id: ${idBefore === idAfter} (${idBefore} -> ${idAfter}); B still sees A: ${bStillSeesA}`);
await a.screenshot({ path: `${out}/a.png` });
await b.screenshot({ path: `${out}/b.png` });
console.log(errs.length ? errs.join('\n') : 'no console errors');
await browser.close();
