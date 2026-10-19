// DOM HUD. The game pushes state in; nothing here reads the engine directly.
import { CHARACTERS, ELIM, PLAYER, WEAPONS, type WeaponId } from '../../shared/constants';
import type { MatchInfo } from '../../shared/protocol';

export interface ScoreRow { id: number; name: string; kills: number; deaths: number; ping: number; team: 0 | 1; me: boolean; bot?: boolean; alive: boolean; skin?: string }

const STREAK_WINDOW = 4000;

// Chunky side-view silhouettes in a 32×32 box (aria labels carry the names).
const WEAPON_PATH: Record<WeaponId, string> = {
  // open hand
  tag: 'M9 30v-9l-4-6 2-2 4 4V5h3v10h1V3h3v12h1V5h3v11h1V8h3v13l-3 9H9z',
  // sidearm: body, grip, tank
  pistol: 'M3 10h17v5h9v3H20v1h-4v8h-5v-8H8v-1H3v-8z',
  // semi: body, hopper, barrel, tank
  semi: 'M11 3h8v6h-2v2h13v3H17v3h-4v6H9v-6H1v-6h10V9h-2V3z',
  // auto: big hopper
  auto: 'M9 1h12v8h-3v2h12v3H17v3h-4v6H9v-6H1v-6h10V9H9V1z',
  // pump: long barrel, scope, pump handle
  pump: 'M11 5h8v4h-2v2h15v3h-6v3h-5v-3h-4v3h-4v6H9v-6H1v-6h10V9h-2V5h2z',
};
/** Paint splat (the "marked" verb in the feed). */
const SPLAT_PATH = 'M16 4c2 0 2 4 4 4s3-3 5-1-1 4 0 6 5 1 5 3-4 2-4 4 3 4 1 6-4-1-6 0-1 4-5 4-2-4-4-4-4 3-6 1 1-4 0-6-5-1-5-3 4-1 4-3-3-4-1-6 4 1 6 0 2-4 5-4zM27 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM4 25a2 2 0 1 1 0 4 2 2 0 0 1 0-4z';
/** Paint grenade: a ball with a pin. */
const NADE_PATH = 'M14 2h4v3h-4zM12 5h8v3h-8zM16 8a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-4 6a3 3 0 1 0 0 .1z';

export class Hud {
  root: HTMLElement;
  private hp: HTMLElement; private ammo: HTMLElement; private wname: HTMLElement; private reloading: HTMLElement;
  private timer: HTMLElement; private phase: HTMLElement; private teams: HTMLElement;
  private feed: HTMLElement; private hitmarker: HTMLElement; private vignette: HTMLElement;
  private center: HTMLElement; private chatlog: HTMLElement; private chatbox: HTMLElement; chatInput: HTMLInputElement;
  private status: HTMLElement; private scoreboard: HTMLElement; private crosshair: HTMLElement;
  private streak: HTMLElement;
  private hitTimer = 0;
  private pipColor = '#ff3bd5';
  private streakAt: number[] = [];
  private suppressStreak = false;
  onChat: (text: string) => void = () => {};
  /** Fired from setHp so audio can follow health without a new game.ts call site. */
  onHp: (hp: number) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    this.root.innerHTML = `
      <div class="status"></div>
      <div class="crosshair"><div class="dot"></div></div>
      <div class="hitmarker"><span></span><span></span><span></span><span></span></div>
      <div class="vignette"></div>
      <div class="top"><div class="teams"></div><div class="timer">--:--</div><div class="phase"></div></div>
      <div class="streak" aria-live="polite"></div>
      <div class="killfeed"></div>
      <div class="center"></div>
      <div class="chatlog"></div>
      <div class="chatbox"><input maxlength="140" placeholder="say something…" /></div>
      <div class="bottom-left"><div class="hp" role="img"></div><small>HITS</small></div>
      <div class="bottom-right"><div class="ammo">20 <span>/ 120</span></div><div class="wname">Semi Marker</div><div class="reloading"></div></div>
      <div class="scoreboard"></div>
      <div class="build">build ${__BUILD__}</div>`;
    parent.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.hp = q('.hp'); this.ammo = q('.ammo'); this.wname = q('.wname'); this.reloading = q('.reloading');
    this.timer = q('.timer'); this.phase = q('.phase'); this.teams = q('.teams');
    this.feed = q('.killfeed'); this.hitmarker = q('.hitmarker'); this.vignette = q('.vignette');
    this.center = q('.center'); this.chatlog = q('.chatlog'); this.chatbox = q('.chatbox'); this.chatInput = q('.chatbox input') as HTMLInputElement;
    this.status = q('.status'); this.scoreboard = q('.scoreboard'); this.crosshair = q('.crosshair');
    this.streak = q('.streak');
    const css = el('style');
    css.textContent = `
      .hud .bottom-left .hp { display: flex; gap: 6px; align-items: center; }
      .hud .bottom-left .hp svg { width: 40px; height: 40px; filter: drop-shadow(0 2px 3px #000); transition: transform 0.15s, opacity 0.2s; }
      .hud .bottom-left .hp svg.gone { opacity: 0.22; transform: scale(0.8); }
      .hud .bottom-left .hp.low svg:not(.gone) { animation: pulse 0.8s infinite; }
      .hud .killfeed .gun .splat { width: 18px; height: 18px; display: block; }
      .hud .killfeed .gun .nade { width: 18px; height: 18px; display: block; }`;
    this.root.appendChild(css);
    this.pipColor = mySkinColor();
    this.setHp(PLAYER.maxHp);
    this.chatInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = this.chatInput.value.trim(); if (t) this.onChat(t); this.closeChat(); }
      if (e.key === 'Escape') this.closeChat();
    });
  }

  setStatus(s: string) { this.status.textContent = s; }
  /** Your paint colour for the hit pips. */
  setPaintColor(c: string) { this.pipColor = c; this.setHp(Number(this.hp.dataset.hp ?? PLAYER.maxHp)); }
  /** Hits left as three paint-splat pips. */
  setHp(hp: number) {
    const n = Math.max(0, Math.round(hp));
    const pip = (on: boolean) => `<svg viewBox="0 0 32 32" class="${on ? '' : 'gone'}" aria-hidden="true"><path fill="${on ? this.pipColor : '#8a8f9c'}" d="${SPLAT_PATH}"/></svg>`;
    this.hp.innerHTML = Array.from({ length: PLAYER.maxHp }, (_, i) => pip(i < n)).join('');
    this.hp.setAttribute('aria-label', `${n} hit${n === 1 ? '' : 's'} left`);
    this.hp.dataset.hp = String(n);
    const low = n === 1;
    this.hp.classList.toggle('low', low);
    this.vignette.classList.toggle('low', low);
    if (n <= 0) this.streakAt = [];
    this.onHp(n);
  }
  setWeapon(w: WeaponId, mag: number, reserve: number, reloading: boolean, scoped: boolean) {
    const d = WEAPONS[w];
    this.wname.textContent = d.name;
    this.ammo.innerHTML = d.mag === 0 ? '—' : `${mag} <span>/ ${reserve}</span>`;
    this.reloading.textContent = reloading ? 'RELOADING' : (d.mag > 0 && mag === 0 ? (reserve > 0 ? 'PRESS R' : 'EMPTY') : '');
    this.crosshair.style.display = scoped ? 'none' : '';
  }
  setMatch(m: MatchInfo, serverNow: number, myTeam: 0 | 1) {
    const left = Math.max(0, m.endsAt - serverNow);
    const s = Math.ceil(left / 1000);
    this.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const r = m.round;
    this.phase.textContent = m.phase === 'warmup' ? 'warmup' : m.phase === 'over' ? 'match over'
      : m.mode === 'elim' ? (r ? `round ${r.n}${r.stage === 'freeze' ? ' · get ready' : r.stage === 'over' ? ' · over' : ''} · first to ${ELIM.roundsToWin}` : 'elimination')
      : m.mode === 'tdm' ? 'team paintball' : 'free-for-all';
    if (m.mode === 'tdm' || m.mode === 'elim') {
      this.teams.innerHTML = `<span class="t0">${m.teamScore[0]}</span><span class="t1">${m.teamScore[1]}</span>`;
      this.teams.style.display = '';
      this.teams.children[myTeam].textContent = `${m.teamScore[myTeam]}`;
    } else this.teams.style.display = 'none';
  }
  /** Feed row: "<marker> [marker or grenade icon][splat] <marked>". */
  kill(killer: string, victim: string, w: WeaponId, headshot: boolean, involvesMe: boolean, nade?: 'paint', color?: string) {
    const d = el('div', [involvesMe ? 'me' : '', headshot ? 'hs-row' : ''].filter(Boolean).join(' '));
    const how = nade ? 'paint grenade' : WEAPONS[w].name;
    d.setAttribute('aria-label', `${killer} marked ${victim} with ${how}${headshot ? ', head mark' : ''}`);
    const icon = nade ? `<svg class="nade" viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${NADE_PATH}"/></svg>` : weaponIcon(w);
    const splat = `<svg class="splat" viewBox="0 0 32 32" aria-hidden="true"><path fill="${color ?? '#ff3bd5'}" d="${SPLAT_PATH}"/></svg>`;
    d.innerHTML = `<span class="who">${esc(killer)}</span> <span class="gun${headshot ? ' hs' : ''}">${icon}${splat}${headshot ? '<em>HEAD</em>' : ''}</span> <span class="who">${esc(victim)}</span>`;
    this.feed.prepend(d);
    while (this.feed.children.length > 6) this.feed.lastChild?.remove();
    setTimeout(() => d.remove(), 6000);
    if (!involvesMe) return;
    queueMicrotask(() => {
      if (this.suppressStreak) { this.suppressStreak = false; return; }
      this.noteMyKill();
    });
  }
  hit(head: boolean) {
    this.hitmarker.classList.add('show'); this.hitmarker.classList.toggle('head', head);
    clearTimeout(this.hitTimer); this.hitTimer = window.setTimeout(() => this.hitmarker.classList.remove('show'), 80);
  }
  hurt() { this.vignette.classList.add('hurt'); requestAnimationFrame(() => requestAnimationFrame(() => this.vignette.classList.remove('hurt'))); }
  setCenter(big: string, sub = '') {
    if (/^(head mark by|marked by)\b/i.test(big.trim())) {
      this.suppressStreak = true;
      this.streakAt = [];
      this.streak.classList.remove('show');
      this.streak.textContent = '';
    }
    this.center.innerHTML = big ? `<div class="big">${esc(big)}</div><div class="sub">${esc(sub)}</div>` : '';
  }
  chat(name: string, text: string) {
    const d = el('div'); d.innerHTML = `<b>${esc(name)}:</b> ${esc(text)}`;
    this.chatlog.appendChild(d); while (this.chatlog.children.length > 8) this.chatlog.firstChild?.remove();
    setTimeout(() => d.remove(), 10000);
  }
  openChat() { this.chatbox.classList.add('open'); this.chatInput.value = ''; this.chatInput.focus(); }
  closeChat() { this.chatbox.classList.remove('open'); this.chatInput.blur(); }
  get chatOpen() { return this.chatbox.classList.contains('open'); }
  showScoreboard(show: boolean, rows?: ScoreRow[], match?: MatchInfo) {
    this.scoreboard.classList.toggle('show', show);
    if (!show || !rows) return;
    const elim = match?.mode === 'elim';
    const teamed = match?.mode === 'tdm' || elim;
    // elimination groups by side so you can see who is still in
    const sorted = [...rows].sort((a, b) => (elim ? a.team - b.team : 0) || b.kills - a.kills || a.deaths - b.deaths);
    const best = [...rows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
    const mvpId = best && best.kills > 0 ? best.id : -1;
    const title = match?.phase === 'over' ? 'MATCH OVER' : elim ? `ELIMINATION${match?.round ? ` · ROUND ${match.round.n}` : ''}` : match?.mode === 'tdm' ? 'TEAM PAINTBALL' : 'FREE-FOR-ALL';
    const teams = teamed && match
      ? `<div class="tscores"><span class="t0">NIGHT ${match.teamScore[0]}</span><span class="t1">DAY ${match.teamScore[1]}</span></div>${elim ? `<div class="tsub" style="text-align:center;font-size:11px;letter-spacing:0.14em;opacity:0.65;margin-top:2px">ROUNDS WON · FIRST TO ${ELIM.roundsToWin}</div>` : ''}`
      : '';
    const podium = match?.phase === 'over' ? renderPodium([...rows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)) : '';
    this.scoreboard.innerHTML = `<h2>${title}</h2>${teams}${podium}
      <table><tr><th>Player</th><th class="num">Marks</th><th class="num">Marked</th>${elim ? '' : '<th class="num">Ratio</th>'}<th class="num">Ping</th></tr>
      ${sorted.map(r => `<tr class="${r.me ? 'me' : ''} ${teamed ? 't' + r.team : ''}"><td><i class="pip t${r.team}"></i><span class="nm t${r.team}">${esc(r.name)}</span>${r.bot ? ' <span class="tag bot">BOT</span>' : ''}${r.alive ? '' : ' <span class="tag dead">OUT</span>'}${r.id === mvpId ? ' <span class="tag mvp">MVP</span>' : ''}</td><td class="num">${r.kills}</td><td class="num">${r.deaths}</td>${elim ? '' : `<td class="num">${(r.kills / Math.max(1, r.deaths)).toFixed(2)}</td>`}<td class="num">${r.ping}</td></tr>`).join('')}</table>`;
  }

  // ----- feel workstream additions (scope, dynamic crosshair, damage direction) -----
  private feelEls: { scope: HTMLElement; dmg: HTMLElement[]; dmgNext: number; spread: number } | null = null;
  private feel() {
    if (this.feelEls) return this.feelEls;
    const css = el('style');
    css.textContent = `
      .hud .hitmarker.head span { background: #ff3b3b; box-shadow: 0 0 4px #ff3b3b; }
      .hud .crosshair { --gap: 6px; -webkit-mask: linear-gradient(#000 0 0) center / calc(2 * var(--gap)) calc(2 * var(--gap)) no-repeat, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask: linear-gradient(#000 0 0) center / calc(2 * var(--gap)) calc(2 * var(--gap)) no-repeat exclude, linear-gradient(#000 0 0); }
      .hud .feel-scope { position: absolute; inset: 0; display: none; background: radial-gradient(circle at 50% 50%, transparent 0, transparent 39vmin, rgba(0,0,0,0.85) 39.4vmin, #000 41vmin); }
      .hud .feel-scope.on { display: block; }
      .hud .feel-scope::before { content: ""; position: absolute; left: 50%; top: 50%; width: 78vmin; height: 78vmin; transform: translate(-50%, -50%); border-radius: 50%; box-shadow: inset 0 0 6vmin rgba(0,0,0,0.65); }
      .hud .feel-scope i { position: absolute; background: #000; }
      .hud .feel-scope i.h { left: 0; right: 0; top: 50%; height: 2px; transform: translateY(-50%); }
      .hud .feel-scope i.v { top: 0; bottom: 0; left: 50%; width: 2px; transform: translateX(-50%); }
      .hud .feel-scope i.c { left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%; background: #ff3b3b; }
      .hud .feel-dmg { position: absolute; left: 50%; top: 50%; width: 220px; height: 220px; margin: -110px 0 0 -110px; border-radius: 50%; border: 8px solid transparent; border-top-color: rgba(255, 40, 40, 0.9); filter: drop-shadow(0 0 6px rgba(255,0,0,0.8)); opacity: 0; transition: opacity 0.9s ease-in; }
      .hud .feel-dmg.on { opacity: 1; transition: none; }`;
    this.root.appendChild(css);
    const scope = el('div', 'feel-scope');
    scope.innerHTML = '<i class="h"></i><i class="v"></i><i class="c"></i>';
    this.root.prepend(scope);
    const dmg = [0, 1, 2, 3].map(() => { const d = el('div', 'feel-dmg'); this.root.appendChild(d); return d; });
    return (this.feelEls = { scope, dmg, dmgNext: 0, spread: -1 });
  }
  /** Pump-marker scope overlay on/off (also hides the crosshair). */
  setScope(on: boolean) {
    const f = this.feel();
    f.scope.classList.toggle('on', on);
    if (on) this.crosshair.style.display = 'none';
  }
  /** Crosshair gap in pixels from the current effective spread. */
  setSpread(px: number) {
    const f = this.feel();
    const gap = Math.round(Math.max(5, Math.min(90, px)));
    if (gap === f.spread) return;
    f.spread = gap;
    this.crosshair.style.setProperty('--gap', `${gap}px`);
    this.crosshair.style.width = this.crosshair.style.height = `${2 * gap + 16}px`;
  }
  /** Red arc pointing at the attacker. angleRad: 0 = ahead, +π/2 = to the right. */
  damageFrom(angleRad: number) {
    const f = this.feel();
    const d = f.dmg[f.dmgNext]; f.dmgNext = (f.dmgNext + 1) % f.dmg.length;
    d.style.transform = `rotate(${angleRad}rad)`;
    d.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => d.classList.remove('on')));
  }

  private noteMyKill() {
    const now = performance.now();
    this.streakAt = this.streakAt.filter(t => now - t < STREAK_WINDOW);
    this.streakAt.push(now);
    const n = this.streakAt.length;
    const label = n >= 4 ? 'PAINT STORM' : n === 3 ? 'TRIPLE MARK' : n === 2 ? 'DOUBLE MARK' : '';
    if (!label) return;
    this.streak.textContent = label;
    this.streak.classList.remove('show');
    void this.streak.offsetWidth;
    this.streak.classList.add('show');
  }

  // ----- grenades workstream addition -----
  private nadeEl: HTMLElement | null = null;
  /** Grenades left this life, shown under the ammo: G paint, F smoke. */
  setGrenades(paint: number, smoke: number) {
    if (!this.nadeEl) {
      this.nadeEl = el('div', 'nades');
      this.nadeEl.style.cssText = 'font-size:13px;letter-spacing:0.08em;margin-top:4px;opacity:0.9;display:flex;gap:12px;justify-content:flex-end';
      (this.root.querySelector('.bottom-right') ?? this.root).appendChild(this.nadeEl);
    }
    const chip = (key: string, label: string, n: number, color: string) =>
      `<span style="opacity:${n > 0 ? 1 : 0.35}"><b style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:5px;vertical-align:0"></b>${label} ${n} <small style="opacity:0.6">[${key}]</small></span>`;
    this.nadeEl.innerHTML = chip('G', 'PAINT', paint, '#ff3bd5') + chip('F', 'SMOKE', smoke, '#9a9ca2');
  }
}

function weaponIcon(w: WeaponId): string {
  return `<svg class="wicon" viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="${WEAPON_PATH[w]}"/></svg>`;
}

function mySkinColor(): string {
  try {
    const saved = JSON.parse(localStorage.getItem('strike-night') ?? '{}') as { skin?: string };
    const def = CHARACTERS.find(c => c.id === saved.skin);
    if (def) return def.color;
  } catch { /* ignore bad prefs */ }
  return '#ff3bd5';
}

function characterColor(row: ScoreRow): string {
  const id = row.skin ?? skinFor(row);
  const def = id ? CHARACTERS.find(c => c.id === id) : undefined;
  if (def) return def.color;
  return row.team === 1 ? '#ffb300' : '#7f5cff';
}

function skinFor(row: ScoreRow): string | undefined {
  if (row.me) {
    try {
      const saved = JSON.parse(localStorage.getItem('strike-night') ?? '{}') as { skin?: string };
      if (saved.skin) return saved.skin;
    } catch { /* ignore bad prefs */ }
  }
  const remotes = (window.strike as { remotes?: { get(id: number): { skin?: string } | undefined } } | undefined)?.remotes;
  return remotes?.get(row.id)?.skin;
}

function renderPodium(sorted: ScoreRow[]): string {
  const slots = [
    { row: sorted[1], place: 2 },
    { row: sorted[0], place: 1 },
    { row: sorted[2], place: 3 },
  ].filter((s): s is { row: ScoreRow; place: number } => !!s.row);
  if (!slots.length) return '';
  return `<div class="podium">${slots.map(s => {
    const team = s.row.team === 1 ? 'var(--gold)' : 'var(--accent2)';
    return `<div class="pod p${s.place}" style="--c:${characterColor(s.row)};--team:${team}">
      ${s.place === 1 ? '<span class="mvp">MVP</span>' : `<span class="place">${s.place}</span>`}
      <span class="pname">${esc(s.row.name)}</span>
      <span class="pk">${s.row.kills} marks</span>
      <i></i>
    </div>`;
  }).join('')}</div>`;
}

export function el(tag: string, cls = ''): HTMLElement { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
export function esc(s: string) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
