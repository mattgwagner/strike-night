// Headless shots of the join screen, pause menu, scoreboard, and mid-match HUD.
// Usage: node e2e/ui.mjs http://127.0.0.1:5210 e2e/out-ui
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR ?? 'playwright');
const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const out = process.argv[3] ?? 'e2e/out-ui';
mkdirSync(out, { recursive: true });
const room = 'night-pit';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => {
  if (process.env.DBG) console.log(m.type(), m.text().slice(0, 240));
  if (m.type() === 'error') errs.push(m.text().slice(0, 300));
});
page.on('pageerror', e => errs.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem('strike-night', JSON.stringify({
    name: 'Alpha', skin: 'bot', primary: 'semi', sens: 0.0022, fov: 90, volume: 0.5, ambient: true,
    rooms: ['night-pit', 'family', 'slug-yard'],
  }));
});
await page.goto(`${url}/?room=${room}&name=Alpha&skin=bot&w=semi`);
await page.waitForSelector('button.go');
await page.waitForSelector('.join canvas');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/join.png` });

const before = await page.locator('#room').inputValue();
await page.click('button.random');
const after = await page.locator('#room').inputValue();
if (after === before) errs.push('random room did not change the code');
await page.click('.chip[data-room="family"]');
if (await page.locator('#room').inputValue() !== 'family') errs.push('recent room chip did not fill the code');
await page.fill('#room', room);

await page.click('button.go');
await page.waitForFunction(() => window.strike && window.strike.myId > 0, null, { timeout: 20000 });
await page.evaluate(() => { window.strike.input.locked = true; window.strike.setPaused(false); });
await page.waitForTimeout(600);
await page.evaluate(() => {
  const h = window.strike.hud;
  h.kill('Alpha', 'Bravo', 'semi', true, true, undefined, '#ff6a00');
  h.kill('Alpha', 'Charlie', 'auto', false, true, 'paint', '#ff6a00');
  h.kill('Delta', 'Echo', 'pump', false, false, undefined, '#c9c9ff');
  h.kill('Foxtrot', 'Alpha', 'tag', false, false, undefined, '#e03c3c');
  h.setHp(1);
});
await page.waitForTimeout(280);
await page.screenshot({ path: `${out}/hud.png` });

await page.evaluate(() => window.strike.setPaused(true));
await page.waitForSelector('.paused.show');
await page.screenshot({ path: `${out}/pause.png` });

await page.evaluate(() => {
  const g = window.strike;
  g.setPaused(false);
  g.hud.showScoreboard(true, [
    { id: 1, name: 'Alpha', kills: 14, deaths: 3, ping: 22, team: 0, me: true, alive: true, skin: 'bot' },
    { id: 2, name: 'Bravo', kills: 11, deaths: 5, ping: 30, team: 1, me: false, alive: true, skin: 'slugger' },
    { id: 3, name: 'Charlie', kills: 9, deaths: 6, ping: 41, team: 0, me: false, alive: false, skin: 'bear' },
    { id: 4, name: 'Delta', kills: 4, deaths: 8, ping: 28, team: 1, me: false, alive: true, bot: true, skin: 'ghost' },
  ], { mode: 'tdm', phase: 'over', endsAt: 0, teamScore: [23, 15] });
});
await page.waitForSelector('.scoreboard.show .podium');
await page.screenshot({ path: `${out}/scoreboard.png` });

// elimination scoreboard mid-round: rounds won, marks / marked, who is out
await page.evaluate(() => {
  const g = window.strike;
  g.hud.showScoreboard(true, [
    { id: 1, name: 'Alpha', kills: 4, deaths: 2, ping: 22, team: 0, me: true, alive: true, skin: 'bot' },
    { id: 2, name: 'Bravo', kills: 3, deaths: 3, ping: 30, team: 1, me: false, alive: false, skin: 'slugger' },
    { id: 3, name: 'Charlie', kills: 1, deaths: 4, ping: 41, team: 0, me: false, alive: false, skin: 'bear' },
    { id: 4, name: 'Delta', kills: 5, deaths: 1, ping: 28, team: 1, me: false, alive: true, bot: true, skin: 'ghost' },
  ], { mode: 'elim', phase: 'live', endsAt: 0, teamScore: [4, 3], round: { n: 8, stage: 'live' } });
});
await page.waitForFunction(() => document.querySelector('.scoreboard.show h2')?.textContent?.includes('ELIMINATION'));
const elimHead = await page.locator('.scoreboard th').allTextContents();
if (!elimHead.includes('Marks') || !elimHead.includes('Marked') || elimHead.some(t => /K\/D|Ratio/.test(t))) errs.push('elim scoreboard columns: ' + elimHead.join(','));
await page.screenshot({ path: `${out}/scoreboard-elim.png` });

// pause menu offers elimination
const modes = await page.locator('.paused select option').evaluateAll(os => os.map(o => o.value));
if (!modes.includes('elim')) errs.push('pause menu has no elim mode: ' + modes.join(','));
const tagline = await page.evaluate(() => document.title + '|' + (document.querySelector('.join .tag')?.textContent ?? 'gone'));
console.log('modes', modes.join(','), tagline);

console.log(errs.length ? errs.join('\n') : 'no console errors');
await browser.close();
if (errs.length) process.exitCode = 1;
