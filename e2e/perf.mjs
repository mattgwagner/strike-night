// Graphics quality profile: one headless page per quality level (High, then Low), same spot,
// two easy bots, a smoke cloud in view. Reports renderer.info.render (draw calls, triangles),
// the lights the scene renders with, and mean frame time over ~100 frames. Screenshots each
// quality from the same spots (west wall looking east, the pizza room, the animatronic room).
// Exits 1 unless Low has fewer draw calls and fewer lights than High. Last, a first-run page with no
// choice saved must auto-switch to Low (headless frame rate is far under the threshold) and show the
// note, and picking High in the pause menu must apply and be saved.
// Usage: node e2e/perf.mjs http://127.0.0.1:5192 e2e/out-perf
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR ?? 'playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:5192';
const out = process.argv[3] ?? 'e2e/out-perf';
const FRAMES = Number(process.env.FRAMES ?? 100);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];

async function profile(quality) {
  const room = `perf-${quality}-` + Math.random().toString(36).slice(2, 7);
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  // an explicit choice, so the first-run auto-detect stays out of it
  await ctx.addInitScript(q => { try { localStorage.setItem('strike-night', JSON.stringify({ quality: q })); } catch {} }, quality);
  const p = await ctx.newPage();
  p.on('console', m => { if (process.env.DBG) console.log(quality, m.type(), m.text().slice(0, 200)); if (m.type() === 'error') errs.push(`${quality}: ${m.text().slice(0, 300)}`); });
  p.on('pageerror', e => errs.push(`${quality}: ${e.message}`));
  p.setDefaultTimeout(120000);
  await p.goto(`${url}/?room=${room}&name=Perf&skin=chef&w=semi`);
  await p.waitForSelector('button.go');
  await p.click('button.go');
  await p.waitForFunction(() => window.strike && window.strike.myId > 0, null, { timeout: 60000 });
  await p.evaluate(() => {
    const g = window.strike;
    g.input.locked = true; g.setPaused(false);
    g.net.send({ t: 'admin', cmd: 'botdiff', arg: 'easy' });
    g.net.send({ t: 'admin', cmd: 'bots', arg: 2 });
  });
  await p.waitForFunction(() => window.strike.match.phase === 'live', null, { timeout: 60000 });
  await p.waitForTimeout(800);
  await p.evaluate(() => { window.strike.input.locked = true; window.strike.setPaused(false); });
  const hop = async (tx, tz) => {
    for (let i = 0; i < 80; i++) {
      const done = await p.evaluate(([tx, tz]) => { const g = window.strike; if (!g.me.alive) return true; const dx = tx - g.me.body.p[0], dz = tz - g.me.body.p[2]; const d = Math.hypot(dx, dz); if (d < 0.3) return true; const k = Math.min(1.5, d) / d; g.me.body.p[0] += dx * k; g.me.body.p[2] += dz * k; g.me.body.p[1] = 0; return false; }, [tx, tz]);
      if (done) break;
      await p.waitForTimeout(200);
    }
  };
  const look = (yaw, pitch = 0.05) => p.evaluate(([y, pt]) => { const g = window.strike; g.me.yaw = y; g.me.pitch = pt; }, [yaw, pitch]);
  await hop(-28, 0);
  await p.waitForTimeout(800);
  // same spots, both qualities: east down the map, the pizza room, the animatronic room
  const views = { east: -Math.PI / 2, pizza: Math.atan2(-10, 15), animatronic: Math.atan2(-9, -18) };
  for (const [name, yaw] of Object.entries(views)) {
    await look(yaw);
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${out}/${quality}-${name}.png` });
  }
  // a smoke cloud down the lane, in view
  await look(-Math.PI / 2);
  await p.keyboard.down('KeyF'); await p.waitForTimeout(400); await p.keyboard.up('KeyF');
  await p.waitForFunction(() => window.strike.grenades.smoke.count > 0, null, { timeout: 30000 });
  await p.waitForTimeout(1200);
  await look(-Math.PI / 2);
  await p.screenshot({ path: `${out}/${quality}-smoke.png` });
  // a controlled snapshot for draw calls: the cloud in view from a fixed offset, bots hidden
  const snap = await p.evaluate(() => {
    const g = window.strike;
    const hidden = [];
    for (const r of g.remotes.values()) if (r.rig.group.visible) { r.rig.group.visible = false; hidden.push(r.rig.group); }
    // look at the cloud from 10 m west of it, wherever the throw landed
    const c = g.grenades.smoke.volumes()[0]?.p ?? [-18, 0, 0];
    g.camera.position.set(c[0] - 10, 1.6, c[2]); g.camera.lookAt(c[0], 1.6, c[2]); g.camera.updateMatrixWorld();
    g.renderer.render(g.scene, g.camera);
    const { calls, triangles } = g.renderer.info.render;
    for (const o of hidden) o.visible = true;
    return { calls, triangles, smoke: g.grenades.smoke.count };
  });
  // sample: frame interval from rAF, and renderer.info of the frame just drawn
  const stats = await p.evaluate(n => new Promise(resolve => {
    const g = window.strike;
    const info = g.renderer.info.render;
    const dts = [], calls = [], tris = [], smokeCalls = [];
    let last = 0;
    const tick = t => {
      if (last) { dts.push(t - last); calls.push(info.calls); tris.push(info.triangles); if (g.grenades.smoke.count) smokeCalls.push(info.calls); }
      last = t;
      if (dts.length < n) requestAnimationFrame(tick);
      else {
        let lights = 0, pointLights = 0;
        g.scene.traverseVisible(o => { if (o.isLight && !o.isAmbientLight && !o.isHemisphereLight) { lights++; if (o.isPointLight) pointLights++; } });
        const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
        const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
        resolve({
          quality: g.quality,
          frames: dts.length,
          meanMs: +mean(dts).toFixed(1), medianMs: +med(dts).toFixed(1), fps: +(1000 / mean(dts)).toFixed(1),
          calls: med(calls), smokeCalls: smokeCalls.length ? med(smokeCalls) : null, triangles: med(tris), lights, pointLights,
          pixelRatio: g.renderer.getPixelRatio(), antialias: !!g.renderer.getContextAttributes()?.antialias,
          smoke: g.grenades.smoke.count, alive: g.me.alive, bots: g.remotes.size,
        });
      }
    };
    requestAnimationFrame(tick);
  }), FRAMES);
  await ctx.close();
  return { ...stats, snapCalls: snap.calls, snapTriangles: snap.triangles, snapSmoke: snap.smoke };
}

const load = (await import('node:fs')).readFileSync('/proc/loadavg', 'utf8').split(' ')[0];
console.log('load', load);
const high = await profile('high');
console.log('HIGH', JSON.stringify(high));
const low = await profile('low');
console.log('LOW ', JSON.stringify(low));
// first run, no choice made: a slow frame rate once live picks Low with a note; picking High in the menu sticks
async function autoCheck() {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(`auto: ${e.message}`));
  p.setDefaultTimeout(120000);
  await p.goto(`${url}/?room=perf-auto-${Math.random().toString(36).slice(2, 7)}&name=Auto&skin=chef&w=semi`);
  await p.click('button.go');
  await p.waitForFunction(() => window.strike && window.strike.myId > 0, null, { timeout: 60000 });
  const start = await p.evaluate(() => window.strike.quality);
  await p.evaluate(() => { window.strike.input.locked = true; window.strike.setPaused(false); });
  await p.waitForFunction(() => window.strike.match.phase === 'live', null, { timeout: 60000 });
  await p.waitForFunction(() => window.strike.quality === 'low', null, { timeout: 90000 }).catch(() => {});
  const r = await p.evaluate(() => ({
    quality: window.strike.quality,
    prefs: JSON.parse(localStorage.getItem('strike-night') ?? '{}'),
    note: [...document.querySelectorAll('.hud *')].some(e => e.children.length === 0 && /Graphics set to Low/.test(e.parentElement?.textContent ?? '')),
  }));
  // the player picks High in the menu: applies live and is remembered as their choice
  await p.evaluate(() => { const s = document.querySelector('.paused .gfx select'); s.value = 'high'; s.dispatchEvent(new Event('change')); });
  const after = await p.evaluate(() => ({ quality: window.strike.quality, prefs: JSON.parse(localStorage.getItem('strike-night') ?? '{}') }));
  await ctx.close();
  return { start, ...r, after };
}
const auto = await autoCheck();
console.log('AUTO', JSON.stringify(auto));
await browser.close();
const fails = [];
if (auto.quality !== 'low' || auto.prefs.autoQuality !== 'low' || auto.prefs.quality) fails.push(`auto-detect did not pick Low on a slow first run: ${JSON.stringify(auto)}`);
if (!auto.note) fails.push('no "Graphics set to Low" note after auto-switch');
if (auto.after.quality !== 'high' || auto.after.prefs.quality !== 'high') fails.push(`menu choice not applied/saved: ${JSON.stringify(auto.after)}`);
if (high.quality !== 'high' || low.quality !== 'low') fails.push(`quality pref not applied (${high.quality}/${low.quality})`);
if (!high.snapSmoke || !low.snapSmoke) fails.push('smoke cloud was not up for the draw-call snapshot');
if (!(low.snapCalls < high.snapCalls)) fails.push(`draw calls (fixed view, smoke up): low ${low.snapCalls} !< high ${high.snapCalls}`);
if (!(low.lights < high.lights)) fails.push(`lights: low ${low.lights} !< high ${high.lights}`);
if (errs.length) fails.push(...errs);
console.log(`frame ${high.meanMs} ms -> ${low.meanMs} ms (${high.fps} -> ${low.fps} fps); fixed view with smoke: calls ${high.snapCalls} -> ${low.snapCalls}, triangles ${high.snapTriangles} -> ${low.snapTriangles}; lights ${high.lights} -> ${low.lights}; live-sample median calls ${high.calls} -> ${low.calls}`);
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS');
process.exit(fails.length ? 1 : 0);
