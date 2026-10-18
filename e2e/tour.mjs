// Headless map tour: screenshots from fixed vantage points + a skin line-up.
// Usage: node e2e/tour.mjs http://127.0.0.1:5190 docs/sheets   (dev server: the skin sheet imports /src)
// Env: PLAYWRIGHT_DIR, CHROMIUM (see e2e/two.mjs). Only=<name> to shoot one view.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR ?? 'playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const out = process.argv[3] ?? 'docs/sheets';
mkdirSync(out, { recursive: true });

// [name, [x, y, z] feet position, look-at [x, y, z]]
const VIEWS = [
  ['overview', [-14, 9, 24], [2, 0, -2]],
  ['mid', [6.5, 0, 15], [0, 3.5, 0]],
  ['pit', [-17, 1.2, -26], [-17, -1.2, -12]],
  ['pit-floor', [-12.5, -1.2, -11.5], [-22, -0.5, -18]],
  ['yard', [13, 0, -12.5], [24, 1.5, -24]],
  ['bleachers', [18.5, 2, -27], [16, 0, -12]],
  ['freddys', [-12.5, 0, 12.5], [-26, 1.4, 19]],
  ['corridor', [-11, 0, 26.5], [-26, 1.4, 26.5]],
  ['dock', [12, 0, 13.5], [24, 1.5, 24]],
  ['catwalk', [16, 2.5, 12], [0, 1.5, 0]],
];
const only = process.env.ONLY;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errs = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errs.push(e.message));
await page.goto(`${url}/?room=tour-${Math.random().toString(36).slice(2, 7)}&name=Tour&skin=astro&w=rifle`);
await page.waitForSelector('button.go');
await page.click('button.go');
await page.waitForFunction(() => window.strike && window.strike.myId > 0, null, { timeout: 20000 });
await page.evaluate(() => {
  const g = window.strike;
  g.net.close();               // no server corrections while we teleport
  g.me.update = () => {};      // freeze local physics so elevated views hold
  g.input.locked = true; g.setPaused(false);
  document.querySelectorAll('body > div, #hud, .hud').forEach(el => { if (!el.querySelector('canvas')) el.style.visibility = 'hidden'; });
});
await page.waitForTimeout(1500);
const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r()))); };

let i = 1;
for (const [name, p, look] of VIEWS) {
  const n = String(i++).padStart(2, '0');
  if (only && only !== name) continue;
  const info = await page.evaluate(([p, look]) => {
    const g = window.strike;
    const eye = [p[0], p[1] + 1.62, p[2]];
    const dx = look[0] - eye[0], dy = look[1] - eye[1], dz = look[2] - eye[2];
    g.me.body.p = [...p]; g.me.body.v = [0, 0, 0];
    g.me.yaw = Math.atan2(-dx, -dz);
    g.me.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return null;
  }, [p, look]);
  void info;
  await frames(4);
  const calls = await page.evaluate(() => window.strike.renderer.info.render.calls);
  await page.screenshot({ path: `${out}/01-tour-${n}-${name}.png` });
  console.log(`${n} ${name} draw calls ${calls}`);
}

// skin line-up (needs the vite dev server so /src modules can be imported)
if (!only || only === 'skins') {
  const ok = await page.evaluate(async () => {
    try {
      const m = await import('/src/client/world/skins.ts');
      const c = await import('/src/shared/constants.ts');
      const g = window.strike;
      window.__rigs = c.CHARACTERS.map((ch, k) => {
        const rig = m.buildSkin(ch.id, k % 2);
        rig.group.position.set(-3.75 + k * 1.5, 1, 0.5);
        rig.group.rotation.y = Math.PI; // rigs face -Z at yaw 0; turn them toward the camera
        g.scene.add(rig.group);
        return rig;
      });
      g.me.body.p = [0, 1, 4.4]; g.me.yaw = 0; g.me.pitch = -0.12;
      return true;
    } catch (e) { return String(e); }
  });
  if (ok !== true) errs.push('skins: ' + ok);
  await frames(4);
  await page.screenshot({ path: `${out}/02-skins-front.png` });
  await page.evaluate(() => { for (const r of window.__rigs) r.group.rotation.y = 0.35; });
  await frames(4);
  await page.screenshot({ path: `${out}/02-skins-back.png` });
  console.log('skins', ok === true ? 'ok' : ok);
}
console.log(errs.length ? errs.join('\n') : 'no console errors');
await browser.close();
