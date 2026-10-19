// Deterministic regression check: after a respawn pop the remote rig must be back at full scale.
// Steps the remote's update() by hand (10 frames at 15 ms), so it does not depend on headless fps.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR ?? 'playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:5192';
const room = 'e2e-' + Math.random().toString(36).slice(2, 7);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto(`${url}/?room=${room}&name=Solo&skin=astro&w=rifle`);
await p.click('button.go', { timeout: 90000 });
await p.waitForFunction(() => window.strike && window.strike.myId > 0, null, { timeout: 30000 });
await p.evaluate(() => { window.strike.input.locked = true; window.strike.setPaused(false); window.strike.net.send({ t: 'admin', cmd: 'bots', arg: 1 }); });
await p.waitForFunction(() => window.strike.remotes.size === 1, null, { timeout: 15000 });
const res = await p.evaluate(() => {
  const g = window.strike; const r = [...g.remotes.values()][0];
  const out = [];
  for (let respawn = 0; respawn < 3; respawn++) {
    r.spawnAt(r.p, r.yaw);
    const t0 = performance.now();
    for (let i = 1; i <= 10; i++) r.update(g.net.serverNow() - 100, t0 + i * 15, 0.015);
    out.push(r.rig.group.scale.toArray().map(n => +n.toFixed(3)));
  }
  return out;
});
const ok = res.every(s => s[0] > 0.99 && s[2] > 0.99);
console.log('scale after 3 respawns (10 frames each):', JSON.stringify(res), ok ? 'OK' : 'BAD');
console.log(errs.length ? errs.join('\n') : 'no page errors');
await browser.close();
process.exit(ok ? 0 : 1);
