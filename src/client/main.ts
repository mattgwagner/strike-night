import './ui/style.css';
import { Game } from './game';
import { showJoin } from './ui/join';
import { el } from './ui/hud';
import { PRIMARY_WEAPONS, type WeaponId } from '../shared/constants';

declare global { const __BUILD__: string; interface Window { strike?: Game } }

interface Prefs {
  name?: string;
  skin?: string;
  primary?: WeaponId;
  sens?: number;
  fov?: number;
  volume?: number;
  ambient?: boolean;
  rooms?: string[];
}

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

function loadPrefs(): Prefs {
  try { return JSON.parse(localStorage.getItem('strike-night') ?? '{}') as Prefs; }
  catch { return {}; }
}
function savePrefs(p: Partial<Prefs>) {
  localStorage.setItem('strike-night', JSON.stringify({ ...loadPrefs(), ...p }));
}
function clamp(n: number, a: number, b: number) { return Math.min(b, Math.max(a, n)); }

async function boot() {
  const saved = loadPrefs();
  const fromUrl = params.get('w') as WeaponId | null;
  const choice = await showJoin(app, {
    name: params.get('name') ?? saved.name,
    skin: params.get('skin') ?? saved.skin,
    primary: fromUrl && PRIMARY_WEAPONS.includes(fromUrl) ? fromUrl : saved.primary,
    room: params.get('room') ?? saved.rooms?.[0] ?? 'family',
    rooms: saved.rooms ?? [],
  });
  const rooms = [choice.room, ...(saved.rooms ?? []).filter(r => r !== choice.room)].slice(0, 5);
  savePrefs({ name: choice.name, skin: choice.skin, primary: choice.primary, rooms });
  history.replaceState(null, '', `?room=${choice.room}`);
  const game = new Game(app, choice);
  window.strike = game;
  if (saved.sens) game.input.sensitivity = saved.sens;
  if (saved.fov) game.baseFov = clamp(saved.fov, 70, 110);
  if (typeof saved.volume === 'number') game.sfx.setVolume(clamp(saved.volume, 0, 1));
  if (saved.ambient === false) game.sfx.setAmbient(false);
  game.hud.onHp = hp => game.sfx.setLowHealth(hp === 1);
  mountPause(game);
}

function mountPause(game: Game) {
  const pause = el('div', 'paused');
  const sens = game.input.sensitivity;
  const fov = Math.round(game.baseFov);
  const vol = game.sfx.volume;
  pause.innerHTML = `<div class="card">
    <h2>PAUSED</h2>
    <p>Resume locks the mouse so you can aim.</p>
    <div class="menu">
      <div class="stack">
        <label>Look <b class="sens-n"></b><input class="sens" type="range" min="0.0005" max="0.006" step="0.0001" value="${sens}" /></label>
        <label>FOV <b class="fov-n"></b><input class="fov" type="range" min="70" max="110" step="1" value="${fov}" /></label>
        <label>Volume <b class="vol-n"></b><input class="vol" type="range" min="0" max="1" step="0.05" value="${vol}" /></label>
        <label class="check"><input class="ambient" type="checkbox" ${game.sfx.ambient ? 'checked' : ''} /> Ambient hum</label>
        <div class="bots"><span>Bots</span><button type="button" class="alt bots-dec" aria-label="Fewer bots">−</button><b class="bots-n">0</b><button type="button" class="alt bots-inc" aria-label="More bots">+</button><select class="bots-diff" aria-label="Bot difficulty"><option value="easy">Easy</option><option value="normal">Normal</option><option value="hard">Hard</option></select></div>
        <label class="mode">Mode <select><option value="ffa">Free-for-all</option><option value="tdm">Team paintball</option><option value="elim">Elimination (rounds)</option></select></label>
        <button type="button" class="alt restart">RESTART MATCH</button>
      </div>
      <ul class="cheatsheet">
        <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move</li>
        <li><kbd>Mouse</kbd> Aim</li>
        <li><kbd>Click</kbd> Shoot</li>
        <li><kbd>R</kbd> Reload</li>
        <li><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> Marker · sidearm · tag</li>
        <li><kbd>Q</kbd> Swap marker</li>
        <li><kbd>G</kbd> Paint grenade · <kbd>F</kbd> Smoke</li>
        <li><kbd>Space</kbd> Jump</li>
        <li><kbd>Ctrl</kbd> Crouch</li>
        <li><kbd>Tab</kbd> Scores</li>
        <li><kbd>Enter</kbd> Chat</li>
        <li><kbd>Right click</kbd> Scope (pump)</li>
        <li><kbd>Esc</kbd> Pause</li>
      </ul>
    </div>
    <div class="actions"><button type="button" class="resume">RESUME</button><button type="button" class="alt leave">LEAVE</button></div>
  </div>`;
  app.appendChild(pause);

  const sensInput = pause.querySelector('.sens') as HTMLInputElement;
  const fovInput = pause.querySelector('.fov') as HTMLInputElement;
  const volInput = pause.querySelector('.vol') as HTMLInputElement;
  const sensN = pause.querySelector('.sens-n') as HTMLElement;
  const fovN = pause.querySelector('.fov-n') as HTMLElement;
  const volN = pause.querySelector('.vol-n') as HTMLElement;
  const botsN = pause.querySelector('.bots-n') as HTMLElement;
  const sel = pause.querySelector('.mode select') as HTMLSelectElement;
  const ambient = pause.querySelector('.ambient') as HTMLInputElement;
  // read the bot count back from the room: the server is the truth, not what this menu last asked for
  const countBots = () => [...game.remotes.values()].filter(r => r.bot).length;
  let bots = countBots();
  const paintBots = () => { bots = countBots(); botsN.textContent = String(bots); };
  game.onRoster = paintBots;
  const paintSens = () => { sensN.textContent = `${(game.input.sensitivity / 0.0022).toFixed(1)}×`; };
  const paintFov = () => { fovN.textContent = String(Math.round(game.baseFov)); };
  const paintVol = () => { volN.textContent = `${Math.round(game.sfx.volume * 100)}`; };
  paintSens(); paintFov(); paintVol();

  pause.querySelector('.resume')!.addEventListener('click', () => game.resume());
  // Input installs window listeners with no remove. A second Game would double them, so Leave reloads.
  pause.querySelector('.leave')!.addEventListener('click', () => location.reload());
  pause.querySelector('.restart')!.addEventListener('click', () => { game.net.send({ t: 'admin', cmd: 'restart' }); game.resume(); });
  sel.addEventListener('change', () => { game.net.send({ t: 'admin', cmd: 'mode', arg: sel.value }); });
  const setBots = (n: number) => {
    bots = clamp(n, 0, 6);
    botsN.textContent = String(bots);
    game.net.send({ t: 'admin', cmd: 'bots', arg: bots });
  };
  pause.querySelector('.bots-dec')!.addEventListener('click', () => setBots(bots - 1));
  pause.querySelector('.bots-inc')!.addEventListener('click', () => setBots(bots + 1));
  const botsDiff = pause.querySelector('.bots-diff') as HTMLSelectElement;
  botsDiff.addEventListener('change', () => game.net.send({ t: 'admin', cmd: 'botdiff', arg: botsDiff.value }));
  sensInput.addEventListener('input', () => {
    game.input.sensitivity = Number(sensInput.value);
    paintSens();
    savePrefs({ sens: game.input.sensitivity });
  });
  fovInput.addEventListener('input', () => {
    game.baseFov = clamp(Number(fovInput.value), 70, 110);
    paintFov();
    savePrefs({ fov: game.baseFov });
  });
  volInput.addEventListener('input', () => {
    game.sfx.setVolume(Number(volInput.value));
    paintVol();
    savePrefs({ volume: game.sfx.volume });
  });
  ambient.addEventListener('change', () => {
    game.sfx.setAmbient(ambient.checked);
    savePrefs({ ambient: ambient.checked });
  });
  game.onPause = p => {
    pause.classList.toggle('show', p);
    game.hud.root.classList.toggle('away', p);
    sel.value = game.match.mode;
    paintBots();
    fovInput.value = String(Math.round(game.baseFov));
    paintFov();
  };
}

boot();
