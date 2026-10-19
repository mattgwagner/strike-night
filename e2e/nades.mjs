// One headless page throws a smoke and a paint grenade and screenshots the
// preview arc, the smoke cloud and the paint burst.
// Usage: node e2e/nades.mjs http://127.0.0.1:5192 e2e/out-nades
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR ?? 'playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:5192';
const out = process.argv[3] ?? 'e2e/out-nades';
mkdirSync(out, { recursive: true });
const room = 'nades-' + Math.random().toString(36).slice(2, 7);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];
const p = await browser.newPage({ viewport: { width: 960, height: 600 } });
p.on('console', m => { if (process.env.DBG) console.log(m.type(), m.text().slice(0, 200)); if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
p.on('pageerror', e => errs.push(e.message));
p.setDefaultTimeout(120000);
await p.goto(`${url}/?room=${room}&name=Nader&skin=chef&w=rifle`);
await p.waitForSelector('button.go');
await p.click('button.go', { timeout: 120000 });
await p.waitForFunction(() => window.strike && window.strike.myId > 0, null, { timeout: 60000 });
await p.evaluate(() => {
  window.strike.input.locked = true; window.strike.setPaused(false);
  // record grenade events for the script
  window.__nades = [];
  window.strike.net.on(m => { if (m.t === 'burst' || m.t === 'smoke') window.__nades.push({ t: m.t, p: m.p, at: performance.now() }); });
});
// wait for live so the warmup->live respawn cannot move us mid-test
console.log('waiting for live phase…');
await p.waitForFunction(() => window.strike.match.phase === 'live', null, { timeout: 60000 });
await p.waitForTimeout(800);
await p.evaluate(() => { window.strike.input.locked = true; window.strike.setPaused(false); });
// hop to open floor by the west wall (≤1.5 m steps; the server clamps teleports)
for (let i = 0; i < 80; i++) {
  const done = await p.evaluate(([tx, tz]) => { const g = window.strike; const dx = tx - g.me.body.p[0], dz = tz - g.me.body.p[2]; const d = Math.hypot(dx, dz); if (d < 0.3) return true; const k = Math.min(1.5, d) / d; g.me.body.p[0] += dx * k; g.me.body.p[2] += dz * k; g.me.body.p[1] = 0; return false; }, [-28, 0]);
  if (done) break;
  await p.waitForTimeout(200);
}
await p.waitForTimeout(800);
const look = (yaw, pitch) => p.evaluate(([y, pt]) => { const g = window.strike; g.me.yaw = y; g.me.pitch = pt; }, [yaw, pitch]);
// face east (+X): forward(yaw) = [-sin(yaw), …, -cos(yaw)]
await look(-Math.PI / 2, 0.05);
console.log('hud:', await p.evaluate(() => document.querySelector('.hud .nades')?.textContent));

// 1) paint: a short lob down the lane so it bounces and bursts in view
await p.keyboard.down('KeyG');
await p.waitForTimeout(150);
await p.screenshot({ path: `${out}/preview-paint.png` });
await p.keyboard.up('KeyG');
await p.waitForFunction(() => window.__nades.some(n => n.t === 'burst'), null, { timeout: 30000, polling: 16 });
await p.screenshot({ path: `${out}/burst.png` });
const burst = await p.evaluate(() => window.__nades.find(n => n.t === 'burst'));
console.log('burst at', burst.p.map(n => +n.toFixed(2)));
await p.evaluate(([bx, by, bz]) => { const g = window.strike; const e = g.me.eye(); const dx = bx - e[0], dz = bz - e[2]; g.me.yaw = Math.atan2(-dx, -dz); g.me.pitch = Math.atan2(by - e[1], Math.hypot(dx, dz)); }, burst.p);
await p.waitForTimeout(800);
await p.screenshot({ path: `${out}/splats.png` });

// 2) smoke: hold F for ~0.5 s, screenshot the preview arc on the way
await look(-Math.PI / 2, 0.05);
await p.keyboard.down('KeyF');
await p.waitForTimeout(500);
await p.screenshot({ path: `${out}/preview-smoke.png` });
await p.keyboard.up('KeyF');
await p.waitForFunction(() => window.__nades.some(n => n.t === 'smoke'), null, { timeout: 30000 });
const smoke = await p.evaluate(() => window.__nades.find(n => n.t === 'smoke'));
console.log('smoke at', smoke.p.map(n => +n.toFixed(2)));
await p.waitForTimeout(1500); // let it fill
await p.screenshot({ path: `${out}/smoke.png` });
console.log('clouds on client:', await p.evaluate(() => window.strike.grenades.smoke.count));
console.log('hud after:', await p.evaluate(() => document.querySelector('.hud .nades')?.textContent));
// a third throw must not happen (out of grenades)
await p.keyboard.down('KeyG'); await p.waitForTimeout(100); await p.keyboard.up('KeyG');
await p.waitForTimeout(600);
console.log('in flight after empty throw:', await p.evaluate(() => window.strike.grenades['flying'].size));
console.log(errs.length ? errs.join('\n') : 'no console errors');
await browser.close();
