// DOM HUD. The game pushes state in; nothing here reads the engine directly.
import { WEAPONS, type WeaponId } from '../../shared/constants';
import type { MatchInfo } from '../../shared/protocol';

export interface ScoreRow { id: number; name: string; kills: number; deaths: number; ping: number; team: 0 | 1; me: boolean; bot?: boolean; alive: boolean }

export class Hud {
  root: HTMLElement;
  private hp: HTMLElement; private ammo: HTMLElement; private wname: HTMLElement; private reloading: HTMLElement;
  private timer: HTMLElement; private phase: HTMLElement; private teams: HTMLElement;
  private feed: HTMLElement; private hitmarker: HTMLElement; private vignette: HTMLElement;
  private center: HTMLElement; private chatlog: HTMLElement; private chatbox: HTMLElement; chatInput: HTMLInputElement;
  private status: HTMLElement; private scoreboard: HTMLElement; private crosshair: HTMLElement;
  private hitTimer = 0;
  onChat: (text: string) => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    this.root.innerHTML = `
      <div class="status"></div>
      <div class="crosshair"><div class="dot"></div></div>
      <div class="hitmarker"><span></span><span></span><span></span><span></span></div>
      <div class="vignette"></div>
      <div class="top"><div class="teams"></div><div class="timer">--:--</div><div class="phase"></div></div>
      <div class="killfeed"></div>
      <div class="center"></div>
      <div class="chatlog"></div>
      <div class="chatbox"><input maxlength="140" placeholder="say something…" /></div>
      <div class="bottom-left"><div class="hp">100</div><small>HP</small></div>
      <div class="bottom-right"><div class="ammo">30 <span>/ 90</span></div><div class="wname">Rifle</div><div class="reloading"></div></div>
      <div class="scoreboard"></div>
      <div class="build">build ${__BUILD__}</div>`;
    parent.appendChild(this.root);
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.hp = q('.hp'); this.ammo = q('.ammo'); this.wname = q('.wname'); this.reloading = q('.reloading');
    this.timer = q('.timer'); this.phase = q('.phase'); this.teams = q('.teams');
    this.feed = q('.killfeed'); this.hitmarker = q('.hitmarker'); this.vignette = q('.vignette');
    this.center = q('.center'); this.chatlog = q('.chatlog'); this.chatbox = q('.chatbox'); this.chatInput = q('.chatbox input') as HTMLInputElement;
    this.status = q('.status'); this.scoreboard = q('.scoreboard'); this.crosshair = q('.crosshair');
    this.chatInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = this.chatInput.value.trim(); if (t) this.onChat(t); this.closeChat(); }
      if (e.key === 'Escape') this.closeChat();
    });
  }

  setStatus(s: string) { this.status.textContent = s; }
  setHp(hp: number) { this.hp.textContent = String(Math.max(0, Math.round(hp))); this.hp.classList.toggle('low', hp <= 30); }
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
    this.phase.textContent = m.phase === 'warmup' ? 'warmup' : m.phase === 'over' ? 'match over' : m.mode === 'tdm' ? 'team deathmatch' : 'deathmatch';
    if (m.mode === 'tdm') {
      this.teams.innerHTML = `<span class="t0">${m.teamScore[0]}</span><span class="t1">${m.teamScore[1]}</span>`;
      this.teams.style.display = '';
      this.teams.children[myTeam].textContent = `${m.teamScore[myTeam]}`;
    } else this.teams.style.display = 'none';
  }
  kill(killer: string, victim: string, w: WeaponId, headshot: boolean, involvesMe: boolean) {
    const d = el('div', involvesMe ? 'me' : '');
    d.innerHTML = `<span>${esc(killer)}</span> <span class="${headshot ? 'hs' : ''}">${w === 'knife' ? '🔪' : headshot ? '🎯' : '🔫'}</span> <span>${esc(victim)}</span>`;
    this.feed.prepend(d);
    while (this.feed.children.length > 6) this.feed.lastChild?.remove();
    setTimeout(() => d.remove(), 6000);
  }
  hit(head: boolean) {
    this.hitmarker.classList.add('show'); this.hitmarker.classList.toggle('head', head);
    clearTimeout(this.hitTimer); this.hitTimer = window.setTimeout(() => this.hitmarker.classList.remove('show'), 80);
  }
  hurt() { this.vignette.classList.add('hurt'); requestAnimationFrame(() => requestAnimationFrame(() => this.vignette.classList.remove('hurt'))); }
  setCenter(big: string, sub = '') { this.center.innerHTML = big ? `<div class="big">${esc(big)}</div><div class="sub">${esc(sub)}</div>` : ''; }
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
    const sorted = [...rows].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    this.scoreboard.innerHTML = `<h2>${match?.mode === 'tdm' ? 'TEAM DEATHMATCH' : 'DEATHMATCH'}</h2>
      <table><tr><th>Player</th><th class="num">K</th><th class="num">D</th><th class="num">K/D</th><th class="num">Ping</th></tr>
      ${sorted.map(r => `<tr class="${r.me ? 'me' : ''} ${match?.mode === 'tdm' ? 't' + r.team : ''}"><td>${esc(r.name)}${r.bot ? ' 🤖' : ''}${r.alive ? '' : ' 💀'}</td><td class="num">${r.kills}</td><td class="num">${r.deaths}</td><td class="num">${(r.kills / Math.max(1, r.deaths)).toFixed(2)}</td><td class="num">${r.ping}</td></tr>`).join('')}</table>`;
  }
}

export function el(tag: string, cls = ''): HTMLElement { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
export function esc(s: string) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
