// Visual check for the feel workstream: screenshots mid-burst (mouse held),
// wall impacts/decals, the victim's view (remote muzzle flash, damage arc,
// kill cam) and the sniper scope. Usage: node e2e/fire.mjs <url> [e2e/out-fx]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR ?? 'playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const out = process.argv[3] ?? 'e2e/out-fx';
mkdirSync(out, { recursive: true });
const room = 'fx-' + Math.random().toString(36).slice(2, 7);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];
const mk = async (tag) => {
  const p = await browser.newPage({ viewport: { width: 960, height: 600 } });
  p.on('console', m => { if (m.type() === 'error') errs.push(`${tag}: ${m.text().slice(0, 300)}`); });
  p.on('pageerror', e => errs.push(`${tag}: ${e.message}`));
  return p;
};
const join = async (p, name, skin, w) => {
  await p.goto(`${url}/?room=${room}&name=${name}&skin=${skin}&w=${w}`);
  await p.waitForSelector('button.go');
  await p.click('button.go');
  await p.waitForFunction(() => window.strike && window.strike.myId > 0, null, { timeout: 15000 });
  await p.evaluate(() => { window.strike.input.locked = true; window.strike.setPaused(false); });
};
const hopTo = async (p, tx, tz) => {
  for (let i = 0; i < 60; i++) {
    const done = await p.evaluate(([tx, tz]) => { const g = window.strike; const dx = tx - g.me.body.p[0], dz = tz - g.me.body.p[2]; const d = Math.hypot(dx, dz); if (d < 0.3) return true; const k = Math.min(2, d) / d; g.me.body.p[0] += dx * k; g.me.body.p[2] += dz * k; g.me.body.p[1] = 0; return false; }, [tx, tz]);
    if (done) break;
    await p.waitForTimeout(120);
  }
};
const aimAt = (p, pitch = -0.05) => p.evaluate((pitch) => { const g = window.strike; const r = [...g.remotes.values()][0]; const dx = r.p[0] - g.me.body.p[0], dz = r.p[2] - g.me.body.p[2]; g.me.yaw = Math.atan2(-dx, -dz); g.me.pitch = pitch; }, pitch);
const shot = (p, name) => p.screenshot({ path: `${out}/${name}.png` }).then(() => console.log('saved', `${out}/${name}.png`));

const a = await mk('A'), b = await mk('B');
await join(a, 'Alpha', 'bot', 'rifle');
await join(b, 'Bravo', 'chef', 'shotgun');
await a.waitForFunction(() => window.strike.remotes.size === 1, null, { timeout: 10000 });
await b.waitForFunction(() => window.strike.remotes.size === 1, null, { timeout: 10000 });
// warmup -> live respawns everyone; wait it out so positions hold
await a.waitForFunction(() => window.strike.match.phase === 'live', null, { timeout: 30000 }).catch(() => console.log('still warmup'));
await a.waitForTimeout(1500);
await Promise.all([hopTo(a, -26, 0), hopTo(b, -19, 1.5)]);
await a.waitForTimeout(800);

// 1) wall burst: impacts, sparks, decals, tracers, flash, casings
await a.evaluate(() => { const g = window.strike; g.me.yaw = Math.PI / 2 + 0.25; g.me.pitch = -0.15; });
await a.mouse.down();
await a.waitForTimeout(1200);
await shot(a, 'a-wall-burst-held');
await a.waitForTimeout(300);
await a.mouse.up();
await a.waitForTimeout(400);
await shot(a, 'a-wall-decals');

// 2) burst at the other player: puffs, hit marker, crosshair bloom; victim sees flash + damage arc
// B faces A (checks remote facing + remote muzzle flash), then turns a little so the arc is off-centre
await aimAt(b, 0);
await aimAt(a, -0.12);
await a.waitForTimeout(500);
await shot(a, 'a-sees-b-facing');
await b.evaluate(() => { window.strike.me.yaw -= 0.6; });
await a.mouse.down();
await a.waitForTimeout(500);
await Promise.all([shot(a, 'a-player-burst-held'), shot(b, 'b-hit-sees-a-firing')]);
await b.waitForFunction(() => !window.strike.me.alive, null, { timeout: 4000 }).catch(() => console.log('B did not die'));
await a.mouse.up();
await b.waitForTimeout(1200);
await shot(b, 'b-killcam');
await shot(a, 'a-body-falling');

// 3) sniper scope
await a.evaluate(() => { const g = window.strike; g.weapons.setPrimary('sniper'); g.weapons.current = 'sniper'; g.me.weapon = 'sniper'; g.viewmodel.setWeapon('sniper'); g.input.aim = true; g.me.yaw = Math.PI / 2 - 0.6; g.me.pitch = 0; });
await a.waitForTimeout(1200);
await shot(a, 'a-scoped');
await a.mouse.down(); await a.waitForTimeout(250); await a.mouse.up();
await a.waitForTimeout(150);
await shot(a, 'a-scoped-after-shot');
await a.evaluate(() => { window.strike.input.aim = false; });
await a.waitForTimeout(800);
await shot(a, 'a-sniper-unscoped');

console.log(errs.length ? errs.join('\n') : 'no console errors');
await browser.close();
