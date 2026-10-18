import './ui/style.css';
import { Game } from './game';
import { showJoin } from './ui/join';
import { el } from './ui/hud';
import type { WeaponId } from '../shared/constants';

declare global { const __BUILD__: string; interface Window { strike?: Game } }

const app = document.getElementById('app')!;
const saved = JSON.parse(localStorage.getItem('strike-night') ?? '{}') as { name?: string; skin?: string; primary?: WeaponId; sens?: number };
const params = new URLSearchParams(location.search);

async function boot() {
  const choice = await showJoin(app, { name: params.get('name') ?? saved.name, skin: params.get('skin') ?? saved.skin, primary: (params.get('w') as WeaponId) ?? saved.primary, room: params.get('room') ?? 'family' });
  localStorage.setItem('strike-night', JSON.stringify({ ...saved, name: choice.name, skin: choice.skin, primary: choice.primary }));
  history.replaceState(null, '', `?room=${choice.room}`);
  const game = new Game(app, choice);
  window.strike = game;
  if (saved.sens) game.input.sensitivity = saved.sens;
  // pause menu
  const pause = el('div', 'paused');
  pause.innerHTML = `<div class="card"><h2>PAUSED</h2><p>Click resume to lock the mouse again.</p>
    <button class="resume">RESUME</button><button class="alt leave">LEAVE</button>
    <div class="opts"><label>Sensitivity <input type="range" min="0.0005" max="0.006" step="0.0001" value="${game.input.sensitivity}" /></label><label>Mode <select><option value="ffa">Deathmatch</option><option value="tdm">Team deathmatch</option></select></label><button class="alt restart">RESTART MATCH</button></div></div>`;
  app.appendChild(pause);
  pause.querySelector('.resume')!.addEventListener('click', () => game.resume());
  pause.querySelector('.leave')!.addEventListener('click', () => location.reload());
  pause.querySelector('.restart')!.addEventListener('click', () => { game.net.send({ t: 'admin', cmd: 'restart' }); game.resume(); });
  const sel = pause.querySelector('select') as HTMLSelectElement;
  sel.addEventListener('change', () => { game.net.send({ t: 'admin', cmd: 'mode', arg: sel.value }); });
  const range = pause.querySelector('input[type=range]') as HTMLInputElement;
  range.addEventListener('input', () => { game.input.sensitivity = Number(range.value); localStorage.setItem('strike-night', JSON.stringify({ ...JSON.parse(localStorage.getItem('strike-night') ?? '{}'), sens: game.input.sensitivity })); });
  game.onPause = p => { pause.classList.toggle('show', p); sel.value = game.match.mode; };
}

boot();
