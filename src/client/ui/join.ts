// Join screen: name, character, primary weapon, room code.
import { CHARACTERS, PRIMARY_WEAPONS, WEAPONS, type WeaponId } from '../../shared/constants';
import { el, esc } from './hud';

export interface JoinChoice { name: string; skin: string; primary: WeaponId; room: string }

export function showJoin(parent: HTMLElement, defaults: Partial<JoinChoice>): Promise<JoinChoice> {
  return new Promise(resolve => {
    const root = el('div', 'join');
    let skin = defaults.skin ?? CHARACTERS[0].id;
    let primary: WeaponId = defaults.primary ?? 'rifle';
    root.innerHTML = `<div class="card">
      <h1>STRIKE <span>NIGHT</span></h1>
      <p class="tag">family deathmatch · browser · no install</p>
      <label>Your name</label>
      <input type="text" id="name" maxlength="14" placeholder="Name" value="${esc(defaults.name ?? '')}" />
      <label>Character</label>
      <div class="skins">${CHARACTERS.map(c => `<button class="skin ${c.id === skin ? 'sel' : ''}" data-skin="${c.id}" style="--skin:${c.color}"><div class="sw"></div><b>${esc(c.name)}</b><small>${esc(c.blurb)}</small></button>`).join('')}</div>
      <label>Primary weapon</label>
      <div class="weapons">${PRIMARY_WEAPONS.map(w => `<button class="weapon ${w === primary ? 'sel' : ''}" data-w="${w}">${WEAPONS[w].name}</button>`).join('')}</div>
      <label>Room</label>
      <div class="room"><input type="text" id="room" maxlength="24" value="${esc(defaults.room ?? 'family')}" /></div>
      <button class="go">PLAY</button>
      <div class="help"><kbd>WASD</kbd> move · <kbd>Mouse</kbd> aim · <kbd>Click</kbd> shoot · <kbd>R</kbd> reload · <kbd>1 2 3</kbd> weapons · <kbd>Ctrl</kbd> crouch · <kbd>Space</kbd> jump · <kbd>Tab</kbd> scores · <kbd>Enter</kbd> chat · <kbd>Right click</kbd> scope (sniper)</div>
    </div>`;
    parent.appendChild(root);
    const name = root.querySelector('#name') as HTMLInputElement;
    const room = root.querySelector('#room') as HTMLInputElement;
    root.querySelectorAll<HTMLButtonElement>('.skin').forEach(b => b.addEventListener('click', () => {
      skin = b.dataset.skin!; root.querySelectorAll('.skin').forEach(x => x.classList.toggle('sel', x === b));
    }));
    root.querySelectorAll<HTMLButtonElement>('.weapon').forEach(b => b.addEventListener('click', () => {
      primary = b.dataset.w as WeaponId; root.querySelectorAll('.weapon').forEach(x => x.classList.toggle('sel', x === b));
    }));
    const go = () => {
      const n = name.value.trim() || 'Player';
      const r = (room.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'family').slice(0, 24);
      root.remove();
      resolve({ name: n, skin, primary, room: r });
    };
    root.querySelector('.go')!.addEventListener('click', go);
    name.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    if (!name.value) name.focus();
  });
}
