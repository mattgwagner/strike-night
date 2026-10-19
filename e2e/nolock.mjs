// iPad-style run: the Pointer Lock API is removed before the page loads, so the game must fall back to its
// soft lock. Joins, clicks the canvas and checks (without touching input.locked) that keys move, mouse looks,
// a click fires, Escape pauses and RESUME re-locks. Exits 1 on any failure.
// Usage: node e2e/nolock.mjs http://127.0.0.1:5192 e2e/out   (PW_BROWSER=webkit to use Playwright's WebKit)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_DIR ?? 'playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:5192';
const out = process.argv[3] ?? 'e2e/out';
mkdirSync(out, { recursive: true });
const room = 'e2e-' + Math.random().toString(36).slice(2, 7);
const kind = process.env.PW_BROWSER ?? 'chromium';
const browser = kind === 'webkit'
  ? await pw.webkit.launch()
  : await pw.chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];
const fails = [];
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' ' + detail : ''}`); if (!ok) fails.push(label); };
const p = await browser.newPage({ viewport: { width: 960, height: 600 } });
p.on('console', m => { if (process.env.DBG) console.log(m.type(), m.text().slice(0, 200)); if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
p.on('pageerror', e => errs.push(e.message));
await p.addInitScript(() => { delete HTMLElement.prototype.requestPointerLock; delete Element.prototype.requestPointerLock; });
await p.goto(`${url}/?room=${room}&name=Ipad&skin=bot&w=semi`);
await p.waitForSelector('button.go');
await p.click('button.go', { timeout: 90000 });
await p.waitForFunction(() => window.strike && window.strike.myId > 0, null, { timeout: 15000 });
check(await p.evaluate(() => typeof document.querySelector('canvas').requestPointerLock === 'undefined'), 'pointer lock API removed');
const st = () => p.evaluate(() => { const g = window.strike; return { locked: g.input.locked, soft: g.input.soft, paused: g.paused, pos: g.me.body.p.map(n => +n.toFixed(3)), yaw: +g.me.yaw.toFixed(4), pitch: +g.me.pitch.toFixed(4), mag: g.weapons.mag[g.weapons.current], alive: g.me.alive }; });
const s0 = await st();
check(!s0.locked, 'starts unlocked', JSON.stringify(s0));
// click the canvas (the HUD is pointer-events: none)
await p.mouse.click(480, 300);
await p.waitForTimeout(200);
const s1 = await st();
check(s1.locked === true && s1.soft === true && !s1.paused, '(a) canvas click soft-locks', JSON.stringify(s1));
check(await p.evaluate(() => getComputedStyle(document.querySelector('canvas')).cursor === 'none'), 'cursor hidden');
check(s1.mag === s0.mag, 'the locking click did not fire', `${s0.mag} -> ${s1.mag}`);
// (b) hold W
await p.keyboard.down('KeyW'); await p.waitForTimeout(1000); await p.keyboard.up('KeyW');
await p.waitForTimeout(200);
const s2 = await st();
const moved = Math.hypot(s2.pos[0] - s1.pos[0], s2.pos[2] - s1.pos[2]);
check(moved > 0.5, '(b) KeyW moves the player', `${moved.toFixed(2)} m`);
// (c) mouse look: move right in steps
await p.mouse.move(480, 300);
for (let i = 1; i <= 10; i++) { await p.mouse.move(480 + i * 20, 300 + i * 5); await p.waitForTimeout(30); }
await p.waitForTimeout(200);
const s3 = await st();
check(s3.yaw !== s2.yaw, '(c) mouse move turns the view', `yaw ${s2.yaw} -> ${s3.yaw}, pitch ${s2.pitch} -> ${s3.pitch}`);
// (c2) browsers that report no movementX: look comes from the clientX/Y change
const yawC = await p.evaluate(async () => {
  const c = document.querySelector('canvas'); const g = window.strike; const y0 = g.me.yaw;
  for (let i = 0; i < 8; i++) { c.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300 - i * 25, clientY: 300 })); await new Promise(r => setTimeout(r, 30)); }
  await new Promise(r => setTimeout(r, 200));
  return [y0, g.me.yaw];
});
check(yawC[1] > yawC[0], '(c2) clientX fallback turns the view', `yaw ${yawC[0].toFixed(4)} -> ${yawC[1].toFixed(4)}`);
// (d) click fires
await p.mouse.down(); await p.waitForTimeout(80); await p.mouse.up();
await p.waitForTimeout(300);
const s4 = await st();
check(s4.mag < s3.mag, '(d) click fires', `mag ${s3.mag} -> ${s4.mag}`);
// right click must not open a context menu while locked
check(await p.evaluate(() => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); document.querySelector('canvas').dispatchEvent(e); return e.defaultPrevented; }), 'contextmenu suppressed');
// (e) Escape unlocks and pauses
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
const s5 = await st();
check(!s5.locked && !s5.soft && s5.paused, '(e) Escape unlocks and pauses', JSON.stringify(s5));
check(await p.evaluate(() => document.querySelector('.paused').classList.contains('show')), 'pause menu shown');
check(await p.evaluate(() => getComputedStyle(document.querySelector('canvas')).cursor !== 'none'), 'cursor restored');
await p.screenshot({ path: `${out}/nolock-paused.png` });
await p.click('.paused .resume', { timeout: 5000 }).catch(() => check(false, 'RESUME clickable'));
await p.waitForTimeout(200);
const s6 = await st();
check(s6.locked && s6.soft && !s6.paused, '(e) RESUME re-locks', JSON.stringify(s6));
check(s6.mag === s4.mag, 'menu click did not fire', `${s4.mag} -> ${s6.mag}`);
await p.screenshot({ path: `${out}/nolock.png` });
check(errs.length === 0, 'no console errors', errs.join(' | '));
await browser.close();
console.log(fails.length ? `${fails.length} FAILED: ${fails.join(', ')}` : `all passed (${kind})`);
process.exit(fails.length ? 1 : 0);
