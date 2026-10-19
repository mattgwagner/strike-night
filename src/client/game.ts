// Orchestrator: renderer, local player, weapons, remotes, HUD, audio, net.
import * as THREE from 'three';
import { CHARACTERS, ELIM, MATCH, PLAYER, WEAPONS, TICK_MS, type WeaponId } from '../shared/constants';
import { MAPS } from '../shared/map';
import { bulletBoxes, rayWorld, solidBoxes } from '../shared/physics';
import type { MapBox } from '../shared/map';
import { isTeamMode, type MatchInfo, type PlayerSnapshot, type ServerMsg, type Vec3 } from '../shared/protocol';
import { smokeBlocks } from '../shared/projectiles';
import { Sfx } from './audio/sfx';
import { Input, DEFAULT_BINDINGS } from './engine/input';
import { LocalPlayer } from './engine/player';
import { RemotePlayer } from './engine/remote';
import { Weapons, recoilDef } from './engine/weapons';
import { Net } from './net';
import { Hud } from './ui/hud';
import type { JoinChoice } from './ui/join';
import { buildWorld } from './world/build';
import { buildViewmodel, type Viewmodel } from './world/viewmodel';
import { Fx } from './world/fx';
import { buildSkin, type SkinRig } from './world/skins';
import { Grenades } from './engine/grenades';

const INTERP_MS = 100;

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  input: Input;
  me: LocalPlayer;
  weapons: Weapons;
  remotes = new Map<number, RemotePlayer>();
  hud: Hud;
  sfx = new Sfx();
  net: Net;
  myId = -1;
  myTeam: 0 | 1 = 0;
  match: MatchInfo = { mode: 'ffa', phase: 'warmup', endsAt: 0, teamScore: [0, 0] };
  scores = new Map<number, { kills: number; deaths: number; ping: number; team: 0 | 1 }>();
  names = new Map<number, string>();
  hp: number = PLAYER.maxHp;
  diedAt = 0;
  baseFov = 80;
  world;
  viewmodel: Viewmodel;
  fx: Fx;
  grenades: Grenades;
  private bullets: MapBox[];
  private skin: string;
  // camera feel
  private camDip = 0; private camDipV = 0;
  private shownSpread = 0;
  private scopeShown = false;
  // kill cam + local corpse
  private corpse: SkinRig | null = null;
  private deathPos: Vec3 = [0, 0, 0];
  private deathYaw = 0;
  private orbitStart = 0;
  /** Elimination spectating: the teammate the marked cam follows (null = orbit where you were marked). */
  private specId: number | null = null;
  private orbitYaw = 0;
  /** Your paint colour (skin colour): your shots, splats and the marks you leave. */
  myColor: string;
  /** Fired when players join or leave (the pause menu reads the bot count from this). */
  onRoster: () => void = () => {};
  private tmpV = new THREE.Vector3();
  private lastSend = 0;
  private lastT = performance.now();
  private running = true;
  private paused = false;
  private stepT = 0;
  onPause: (paused: boolean) => void = () => {};

  constructor(root: HTMLElement, choice: JoinChoice) {
    const map = MAPS.arcade;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    root.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(this.baseFov, innerWidth / innerHeight, 0.05, 300);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.world = buildWorld(map, this.scene);
    this.viewmodel = buildViewmodel(this.camera);
    this.bullets = bulletBoxes(map.boxes);
    this.fx = new Fx(this.scene, this.bullets);
    this.skin = choice.skin;
    this.myColor = (CHARACTERS.find(c => c.id === choice.skin) ?? CHARACTERS[0]).color;
    this.fx.warm(this.renderer, this.camera);
    this.input = new Input(this.renderer.domElement);
    this.me = new LocalPlayer(this.input, solidBoxes(map.boxes));
    this.weapons = new Weapons(bulletBoxes(map.boxes));
    this.weapons.setPrimary(choice.primary);
    this.weapons.refill();
    this.hud = new Hud(root);
    this.hud.setPaintColor(this.myColor);
    this.hud.onChat = text => this.net.send({ t: 'chat', text });
    this.net = new Net(choice.room);
    this.net.onStatus = s => this.hud.setStatus(s === 'open' ? `room ${choice.room}` : s === 'connecting' ? 'connecting…' : 'disconnected — retrying');
    this.net.on(m => this.onMsg(m));
    this.net.connect(choice.name, choice.skin);
    this.names.set(-1, choice.name);
    this.grenades = new Grenades(this, choice.skin);
    this.input.onKey = (code, down) => this.onKey(code, down);
    this.input.onLockChange = locked => { if (!locked && !this.hud.chatOpen) this.setPaused(true); };
    this.renderer.domElement.addEventListener('click', () => { if (!this.input.locked) this.resume(); });
    addEventListener('resize', () => this.onResize());
    this.me.spawn(map.spawns[0].p, map.spawns[0].yaw);
    this.hud.setCenter('Click to play', 'pointer lock gives you mouse aim');
    requestAnimationFrame(t => this.frame(t));
  }

  resume() { this.sfx.init(); this.input.lock(); this.setPaused(false); }
  setPaused(p: boolean) { this.paused = p; this.onPause(p); if (!p) this.hud.setCenter(''); }

  private onResize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  private onKey(code: string, down: boolean) {
    if (this.hud.chatOpen) return;
    const b = DEFAULT_BINDINGS;
    if (b.scoreboard.includes(code)) { this.hud.showScoreboard(down, this.scoreRows(), this.match); return; }
    if (!down) return;
    if (b.chat.includes(code) && this.input.locked) { this.hud.openChat(); return; }
    if (b.menu.includes(code)) { if (this.input.locked) this.input.unlock(); return; }
    if (!this.me.alive) return;
    if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3') { if (this.weapons.switchSlot(Number(code[5]) as 1 | 2 | 3)) this.onSwitch(); }
    if (code === 'KeyQ') { this.weapons.switchSlot(WEAPONS[this.weapons.current].slot === 1 ? 2 : 1); this.onSwitch(); }
    if (b.reload.includes(code) && this.weapons.startReload()) this.sfx.reload();
  }

  private onSwitch() { this.me.weapon = this.weapons.current; this.sfx.switchWeapon(); this.viewmodel.setWeapon(this.weapons.current); }

  // ----- network ---------------------------------------------------------

  private onMsg(m: ServerMsg) {
    switch (m.t) {
      case 'welcome': {
        this.myId = m.id; this.match = m.match;
        for (const r of this.remotes.values()) r.dispose(this.scene);
        this.remotes.clear();
        for (const p of m.players) { this.names.set(p.id, p.name); this.scores.set(p.id, { kills: p.kills, deaths: p.deaths, ping: p.ping, team: p.team }); if (p.id === m.id) { this.myTeam = p.team; this.spawnMe(p.p, p.yaw); if (p.hp <= 0) this.sitOut(p.p, p.yaw); } else this.addRemote(p); }
        this.net.send({ t: 'loadout', primary: this.weapons.primary });
        this.onRoster();
        break;
      }
      case 'join': this.names.set(m.player.id, m.player.name); this.scores.set(m.player.id, { kills: 0, deaths: 0, ping: 0, team: m.player.team }); if (m.player.id !== this.myId) { this.addRemote(m.player); this.hud.chat('·', `${m.player.name} joined`); } this.onRoster(); break;
      case 'leave': { const r = this.remotes.get(m.id); if (r) { r.dispose(this.scene); this.remotes.delete(m.id); this.hud.chat('·', `${r.name} left`); } this.scores.delete(m.id); if (this.specId === m.id) this.specId = null; this.onRoster(); break; }
      case 'state': {
        for (const s of m.players) {
          if (s.id === this.myId) { if (s.hp !== this.hp) { this.hp = s.hp; this.hud.setHp(this.hp); } continue; }
          const r = this.remotes.get(s.id);
          if (r) r.push(m.now, { p: s.p, yaw: s.yaw, pitch: s.pitch, hp: s.hp, w: s.w, crouch: s.crouch, moving: s.moving });
        }
        break;
      }
      case 'spawn': {
        if (m.id === this.myId) { this.spawnMe(m.p, m.yaw); this.sfx.spawn(); }
        else this.remotes.get(m.id)?.spawnAt(m.p, m.yaw);
        break;
      }
      case 'shot': {
        if (m.id === this.myId) break;
        const r = this.remotes.get(m.id);
        const eye = this.me.eye();
        const d = Math.hypot(m.o[0] - eye[0], m.o[1] - eye[1], m.o[2] - eye[2]);
        this.sfx.shot(m.w, d, this.panTo(m.o));
        this.remoteShotFx(m.w, m.o, m.d, m.hit, r);
        if (r) r.rig.gun.position.z = -0.1;
        break;
      }
      case 'hit': {
        if (m.from === this.myId) { this.hud.hit(m.part === 'head'); this.sfx.hitmarker(m.part === 'head'); this.remotes.get(m.to)?.flash(m.part === 'head' ? 1 : 0.7); }
        if (m.to === this.myId) {
          this.hp = m.hp; this.hud.setHp(this.hp); this.hud.hurt(); this.sfx.hurt();
          const a = this.remotes.get(m.from);
          if (a) this.hud.damageFrom(this.screenAngleTo(a.p));
        } else this.remotes.get(m.to)?.flinch(m.part === 'head');
        break;
      }
      case 'kill': {
        const k = this.names.get(m.killer) ?? '?', v = this.names.get(m.victim) ?? '?';
        const paint = this.colorOf(m.killer);
        this.hud.kill(k, v, m.w, m.headshot, m.killer === this.myId || m.victim === this.myId, m.nade, paint);
        if (m.killer === this.myId) { this.sfx.kill(); this.remotes.get(m.victim)?.flash(1.6); }
        if (m.victim === this.myId) this.dieMe(k, m.w, m.headshot, m.nade, paint);
        else this.remotes.get(m.victim)?.die(performance.now(), paint);
        if (this.specId === m.victim) this.specId = null;
        break;
      }
      case 'score': {
        for (const p of m.players) { this.scores.set(p.id, { kills: p.kills, deaths: p.deaths, ping: p.ping, team: p.team }); if (p.id === this.myId) this.myTeam = p.team; const r = this.remotes.get(p.id); if (r) { r.kills = p.kills; r.deaths = p.deaths; r.ping = p.ping; r.team = p.team; } }
        this.match = m.match;
        break;
      }
      case 'match': {
        const prev = this.match.phase;
        const prevRound = this.match.round;
        this.match = m.match;
        if (m.match.mode === 'elim' && m.match.phase === 'live' && m.match.round) { this.onRound(m.match.round, prevRound); break; }
        if (m.match.phase === 'live' && prev !== 'live') { this.sfx.matchStart(); this.flash('GAME ON!', `first to ${MATCH.killLimit} marks or best in ${Math.round((m.match.endsAt - this.net.serverNow()) / 60000)} min`); }
        if (m.match.phase === 'over') { this.sfx.matchOver(); this.flash(this.winnerText(), 'next round soon'); this.hud.showScoreboard(true, this.scoreRows(), this.match); setTimeout(() => this.hud.showScoreboard(false), 8000); }
        if (m.match.phase === 'warmup' && prev === 'over') this.flash('WARMUP', 'match starts soon');
        break;
      }
      case 'chat': this.hud.chat(m.name, m.text); break;
      case 'error': if (m.msg !== 'rejoin') this.hud.setCenter('Error', m.msg); break;
      case 'pong': break;
    }
  }

  /** Elimination round transitions: freeze banner, go, round-over banner (who won and why). */
  private onRound(r: NonNullable<MatchInfo['round']>, prev: MatchInfo['round']) {
    if (prev && prev.n === r.n && prev.stage === r.stage) return;
    if (r.stage === 'freeze') {
      this.specId = null;
      if (r.n === 1) this.sfx.matchStart();
      const [a, b] = this.match.teamScore;
      this.flash(`ROUND ${r.n}`, `get ready · NIGHT ${a} – ${b} DAY · first to ${ELIM.roundsToWin}`, ELIM.freezeMs);
    } else if (r.stage === 'live') {
      this.sfx.spawn();
      this.flash('GO!', 'last side standing takes the round', 1200);
    } else if (r.stage === 'over') {
      const side = (t: 0 | 1) => (t === 0 ? 'NIGHT' : 'DAY');
      const big = r.winner === -1 || r.winner === undefined ? 'ROUND DRAW' : `${side(r.winner)} TAKES ROUND ${r.n}`;
      const why = r.why === 'time'
        ? `time ran out · ${side(ELIM.defenders)} held on`
        : r.winner === -1 ? 'both sides marked out' : `${side(r.winner === 0 ? 1 : 0)} all marked out`;
      const mine = r.winner === this.myTeam;
      if (mine) this.sfx.kill(); else this.sfx.hurt();
      this.hud.setCenter(big, why);
      setTimeout(() => { if (this.match.round?.stage === 'over' && this.match.round.n === r.n) this.hud.setCenter(''); }, ELIM.roundOverMs - 200);
    }
  }

  /** Whose paint: a player's skin colour. */
  colorOf(id: number): string {
    if (id === this.myId) return this.myColor;
    return this.remotes.get(id)?.color ?? '#ff3bd5';
  }

  /** In an elimination freeze or round-over banner nobody can shoot. */
  get frozen() {
    const r = this.match.round;
    return this.match.mode === 'elim' && this.match.phase === 'live' && !!r && r.stage !== 'live';
  }

  /** Elimination round in progress: marked players stay out until the next round. */
  get noRespawn() { return this.match.mode === 'elim' && this.match.phase === 'live'; }

  private winnerText() {
    if (this.match.mode === 'tdm' || this.match.mode === 'elim') { const [a, b] = this.match.teamScore; return a === b ? 'DRAW' : `${a > b ? 'NIGHT' : 'DAY'} TEAM WINS`; }
    let best = -1, name = '';
    for (const [id, s] of this.scores) if (s.kills > best) { best = s.kills; name = this.names.get(id) ?? '?'; }
    return best > 0 ? `${name} WINS` : 'MATCH OVER';
  }

  private flash(big: string, sub: string, ms = 2500) { this.hud.setCenter(big, sub); setTimeout(() => { if (this.me.alive && !this.paused) this.hud.setCenter(''); }, ms); }

  private addRemote(p: PlayerSnapshot) {
    this.remotes.get(p.id)?.dispose(this.scene);
    this.remotes.set(p.id, new RemotePlayer(p, this.scene));
  }

  private spawnMe(p: Vec3, yaw: number) {
    this.me.spawn(p, yaw); this.hp = PLAYER.maxHp; this.hud.setHp(this.hp);
    this.weapons.refill(); this.me.weapon = this.weapons.current; this.viewmodel.setWeapon(this.weapons.current);
    if (!this.paused) this.hud.setCenter('');
    this.camDip = 0; this.camDipV = 0;
    if (this.corpse) this.corpse.group.visible = false;
    this.specId = null;
  }

  private dieMe(killer: string, w: WeaponId, headshot: boolean, nade?: 'paint', paint?: string) {
    this.me.alive = false; this.hp = 0; this.diedAt = performance.now(); this.hud.setHp(0); this.sfx.die();
    this.weapons.scoped = false;
    this.deathPos = [...this.me.body.p] as Vec3; this.deathYaw = this.me.yaw;
    this.orbitStart = this.openOrbitAngle(); this.orbitYaw = 0;
    this.specId = null;
    this.showCorpse();
    this.corpse?.mark(paint ?? '#ff3bd5');
    const how = nade ? 'Paint grenade' : WEAPONS[w].name;
    const next = this.noRespawn ? 'out this round · click to watch a teammate' : 'back in soon…';
    this.hud.setCenter(`${headshot ? 'HEAD MARK by' : 'Marked by'} ${killer}`, `${how} · ${next}`);
  }

  /** Joined an elimination round in progress: watch until the next round. */
  private sitOut(p: Vec3, yaw: number) {
    this.me.alive = false; this.hp = 0; this.diedAt = performance.now() - PLAYER.respawnMs; this.hud.setHp(0);
    this.deathPos = [...p] as Vec3; this.deathYaw = yaw;
    this.orbitStart = this.openOrbitAngle(); this.orbitYaw = 0;
    if (this.corpse) this.corpse.group.visible = false;
    this.hud.setCenter('Round in progress', 'you are in next round · click to watch a teammate');
  }

  /** Next living teammate after the one being watched (elimination spectating). */
  private cycleSpectate() {
    const mates = [...this.remotes.values()].filter(r => r.alive && r.team === this.myTeam).sort((a, b) => a.id - b.id);
    if (!mates.length) { this.specId = null; return; }
    const i = mates.findIndex(r => r.id === this.specId);
    const next = mates[(i + 1) % mates.length];
    this.specId = next.id;
    this.orbitYaw = 0;
    this.hud.setCenter(`Watching ${next.name}`, 'click for the next teammate');
  }

  private panTo(p: Vec3) {
    const eye = this.me.eye();
    const dx = p[0] - eye[0], dz = p[2] - eye[2];
    const right = [Math.cos(this.me.yaw), -Math.sin(this.me.yaw)];
    const len = Math.hypot(dx, dz) || 1;
    return Math.max(-1, Math.min(1, (dx * right[0] + dz * right[1]) / len));
  }

  private scoreRows() {
    const rows = [] as import('./ui/hud').ScoreRow[];
    for (const [id, s] of this.scores) rows.push({ id, name: this.names.get(id) ?? '?', kills: s.kills, deaths: s.deaths, ping: id === this.myId ? Math.round(this.net.rtt) : s.ping, team: s.team, me: id === this.myId, bot: this.remotes.get(id)?.bot, alive: id === this.myId ? this.me.alive : (this.remotes.get(id)?.alive ?? true) });
    return rows;
  }

  // ----- frame -------------------------------------------------------------

  private fireLocal() {
    const eye = this.me.eye();
    const targets = [...this.remotes.values()].filter(r => r.alive && (!isTeamMode(this.match.mode) || r.team !== this.myTeam)).map(r => ({ id: r.id, p: r.p, crouch: r.crouch, alive: r.alive }));
    const res = this.weapons.fire(eye, this.me.yaw, this.me.pitch, this.me.speedFrac, targets, this.me.body.crouch, this.me.body.ground);
    if (!res) return;
    this.net.send({ t: 'shoot', w: res.w, o: res.o, d: res.dirs[0], hits: res.hits });
    this.sfx.shot(res.w);
    this.viewmodel.kick(recoilDef(res.w).vmKick);
    const paint = new THREE.Color(this.myColor).getHex();
    if (res.w !== 'tag') {
      this.viewmodel.flash();
      const muzzle = this.viewmodel.muzzleWorld();
      this.fx.light(muzzle, res.w === 'pump' ? 3 : 1.5);
      // the ball's streak, in your paint
      for (let i = 0; i < Math.min(4, res.ends.length); i++) this.fx.tracer(muzzle, res.ends[i], paint);
    }
    const smokes = this.grenades.smoke.volumes();
    for (let i = 0; i < res.ends.length; i++) {
      const hit = res.pellet[i];
      if (hit) {
        // the server drops hits through smoke; do not show a splat that will not count
        if (res.w !== 'tag' && smokeBlocks(res.o, res.ends[i], smokes)) continue;
        if (this.remotes.has(hit.id)) this.fx.puff(res.ends[i], this.myColor, hit.part === 'head');
      } else if (res.wall[i] && res.w !== 'tag') this.fx.impact(res.ends[i], res.dirs[i], res.w === 'pistol', this.myColor);
    }
    if (this.weapons.def.mag > 0 && this.weapons.mag[res.w] === 0 && this.weapons.startReload()) this.sfx.reload();
  }

  /** Effects for someone else's shot: air puff at their marker, the ball's streak, a splat on the wall or on the player. */
  private remoteShotFx(w: WeaponId, o: Vec3, d: Vec3, hit: Vec3 | undefined, r: RemotePlayer | undefined) {
    if (w === 'tag') return;
    const from = r && r.alive ? r.muzzleWorld(this.tmpV) : new THREE.Vector3(o[0], o[1] - 0.25, o[2]);
    const paint = r?.color ?? '#ff3bd5';
    const hex = new THREE.Color(paint).getHex();
    this.fx.muzzle(from, w === 'pump' ? 0.6 : 0.4, false);
    if (hit) {
      this.fx.tracer(from, hit, hex);
      if (this.victimAt(hit)) this.fx.puff(hit, paint);
      else this.fx.impact(hit, d, w === 'pistol', paint);
      return;
    }
    const range = Math.min(WEAPONS[w].range, 80);
    const t = rayWorld(o, d, this.bullets, range);
    const end: Vec3 = [o[0] + d[0] * (t ?? range), o[1] + d[1] * (t ?? range), o[2] + d[2] * (t ?? range)];
    this.fx.tracer(from, end, hex);
    if (t !== null) this.fx.impact(end, d, w === 'pistol', paint);
  }

  private victimAt(p: Vec3): RemotePlayer | null {
    let best: RemotePlayer | null = null, bd = 1.6;
    for (const r of this.remotes.values()) {
      if (!r.alive) continue;
      const dd = Math.hypot(p[0] - r.p[0], p[2] - r.p[2]);
      if (dd < bd && p[1] > r.p[1] - 0.6 && p[1] < r.p[1] + PLAYER.height + 0.8) { bd = dd; best = r; }
    }
    return best;
  }

  /** Screen-space angle to a world point: 0 = ahead, +π/2 = right. */
  private screenAngleTo(p: Vec3) {
    const dx = p[0] - this.me.body.p[0], dz = p[2] - this.me.body.p[2];
    let a = -(Math.atan2(-dx, -dz) - this.me.yaw);
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  private footstepSfx(gain: number, pan = 0) {
    // Sfx.footstep() takes no position; use its noise voice directly when it exists.
    const s = this.sfx as unknown as { noise?: (dur: number, gain: number, lp: number, hp: number, pan: number, decay: number) => void };
    if (typeof s.noise === 'function') s.noise.call(this.sfx, 0.06, 0.13 * gain, 650, 70, pan, 3);
    else if (gain > 0.5) this.sfx.footstep();
  }

  private showCorpse() {
    if (this.corpse) { this.scene.remove(this.corpse.group); this.corpse.group.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } }); }
    this.corpse = buildSkin(this.skin, this.myTeam);
    const g = this.corpse.group;
    g.rotation.order = 'YXZ';
    g.position.set(...this.deathPos);
    g.rotation.y = this.deathYaw;
    this.scene.add(g);
  }

  /** Pick the kill-cam start angle with the most open space around the body. */
  private openOrbitAngle() {
    const c: Vec3 = [this.deathPos[0], this.deathPos[1] + 0.5, this.deathPos[2]];
    let best = this.deathYaw, bestD = -1;
    for (let i = 0; i < 12; i++) {
      const a = this.deathYaw + (i / 12) * Math.PI * 2;
      // score the arc we will sweep over the next ~1.5 s, not just the start
      let d = 0;
      for (const da of [0, 0.35, 0.7]) {
        const dir: Vec3 = [Math.sin(a + da) * 0.94, 0.33, Math.cos(a + da) * 0.94];
        d += rayWorld(c, dir, this.bullets, 3.4) ?? 3.4;
      }
      if (d > bestD) { bestD = d; best = a; }
    }
    return best;
  }

  /** Marked cam: orbit where you were marked, or (elimination) the teammate you are watching. Mouse turns the orbit. */
  private updateKillCam(now: number, dx = 0) {
    const t = now - this.diedAt;
    if (this.corpse) {
      // rock back from the hit, then sink to a knee (same as remote players)
      const k = Math.min(1, t / 380);
      const g = this.corpse.group;
      g.rotation.x = Math.sin(Math.min(1, t / 260) * Math.PI) * 0.22 + 0.08 * k;
      g.scale.y = 1 - 0.32 * k * k;
      g.position.y = this.deathPos[1];
    }
    this.orbitYaw -= dx * this.input.sensitivity;
    const watch = this.specId !== null ? this.remotes.get(this.specId) : undefined;
    if (watch && !watch.alive) this.specId = null;
    const focus = watch && watch.alive ? watch.p : this.deathPos;
    const c: Vec3 = [focus[0], focus[1] + (watch ? 1.1 : 0.5), focus[2]];
    const ease = watch ? 1 : Math.min(1, t / 600);
    const ang = (watch ? watch.yaw + Math.PI * 0.85 : this.orbitStart + (t / 1000) * 0.45) + this.orbitYaw;
    const h = 1.2 + 0.9 * ease;
    const dir: Vec3 = [Math.sin(ang), h / 3.2, Math.cos(ang)];
    const dl = Math.hypot(dir[0], dir[1], dir[2]);
    dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;
    let dist = 1 + 2.4 * ease;
    const hitT = rayWorld(c, dir, this.bullets, dist);
    if (hitT !== null) dist = Math.max(0.4, hitT - 0.25);
    this.camera.position.set(c[0] + dir[0] * dist, c[1] + dir[1] * dist, c[2] + dir[2] * dist);
    this.camera.lookAt(c[0], c[1], c[2]);
  }

  private frame(t: number) {
    if (!this.running) return;
    requestAnimationFrame(tt => this.frame(tt));
    let dt = (t - this.lastT) / 1000; this.lastT = t;
    if (dt > 0.1) dt = 0.1;
    const take = this.input.take();
    const canAct = this.input.locked && !this.hud.chatOpen && !this.paused;
    if (canAct && this.me.alive) {
      this.me.look(take.dx, take.dy, this.weapons.scoped ? 0.35 : 1);
      this.viewmodel.sway(take.dx, take.dy);
      if (take.wheel) { this.weapons.cycle(take.wheel); this.onSwitch(); }
      if (this.weapons.def.scope) this.weapons.scoped = this.input.aim && !this.weapons.reloading; else this.weapons.scoped = false;
      if (!this.frozen && this.weapons.canFire(this.input.fire, take.fireQueued)) this.fireLocal();
    } else if (canAct && !this.me.alive && this.noRespawn && take.fireQueued) this.cycleSpectate();
    // fixed-step physics
    this.stepT += dt;
    const step = 1 / 120;
    while (this.stepT >= step) { this.me.update(step, canAct); this.stepT -= step; }
    this.weapons.update(dt);
    // respawn request
    if (!this.me.alive && !this.noRespawn && performance.now() - this.diedAt > PLAYER.respawnMs && canAct) this.net.send({ t: 'respawn' });
    // remotes
    const now = performance.now();
    const renderT = this.net.serverNow() - INTERP_MS;
    const ear = this.me.eye();
    for (const r of this.remotes.values()) {
      r.update(renderT, now, dt);
      if (r.rig.gun.position.z < 0.1) r.rig.gun.position.z += dt * 2;
      if (r.footstep) {
        r.footstep = false;
        const d = Math.hypot(r.p[0] - ear[0], r.p[1] - ear[1], r.p[2] - ear[2]);
        if (d < 35) this.footstepSfx(1 / (1 + d * 0.15), this.panTo(r.p));
      }
    }
    // local footsteps + landing
    if (this.me.footstep) { this.footstepSfx(this.me.footstep * 0.7); this.me.footstep = 0; }
    if (this.me.landImpact) { this.camDipV -= this.me.landImpact * 1.4; this.viewmodel.land(this.me.landImpact); this.me.landImpact = 0; }
    // network send
    if (now - this.lastSend >= TICK_MS && this.me.alive && this.myId >= 0) {
      this.lastSend = now;
      this.net.send({ t: 'input', p: this.me.body.p, yaw: this.me.yaw, pitch: this.me.pitch, crouch: this.me.body.crouch, moving: this.me.moving, ground: this.me.body.ground, w: this.weapons.current });
    }
    // camera
    this.camDipV += (-this.camDip * 120 - this.camDipV * 15) * dt; this.camDip += this.camDipV * dt;
    if (this.me.alive) {
      const eye = this.me.viewEyePos();
      const bob = this.me.moving ? Math.sin(this.me.bobPhase) * 0.035 * this.me.speedFrac : 0;
      this.camera.position.set(eye[0], eye[1] + bob + this.camDip * 0.12, eye[2]);
      this.camera.rotation.set(this.me.pitch + this.weapons.recoilPitch + this.weapons.punch, this.me.yaw + this.weapons.recoilYaw, 0);
    } else this.updateKillCam(now, canAct ? take.dx : 0);
    const scopeFov = this.weapons.scoped ? this.baseFov * (this.weapons.def.scope ?? 1) : this.baseFov;
    const targetFov = scopeFov + this.weapons.fovPunch * (this.weapons.scoped ? 0.3 : 1);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) { this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * (this.weapons.fovPunch > 0.5 ? 30 : 14)); this.camera.updateProjectionMatrix(); }
    const pxPerRad = innerHeight / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    this.fx.update(dt, pxPerRad);
    this.grenades.update(dt);
    this.viewmodel.update(dt, this.me.moving ? this.me.speedFrac : 0, this.me.bobPhase, this.weapons.reloading, this.weapons.scoped, this.me.alive);
    this.world.tick(dt, t / 1000);
    // hud
    // crosshair off while scoped and during the marked cam
    this.hud.setWeapon(this.weapons.current, this.weapons.mag[this.weapons.current], this.weapons.reserve[this.weapons.current], this.weapons.reloading, this.weapons.scoped || !this.me.alive);
    const scope = this.weapons.scoped && this.me.alive;
    if (scope !== this.scopeShown) { this.scopeShown = scope; this.hud.setScope(scope); }
    const airborne = !this.me.body.ground;
    const spread = this.weapons.current === 'tag' ? 0 : this.weapons.effectiveSpread(this.me.speedFrac, this.me.body.crouch, !airborne);
    this.shownSpread += (spread - this.shownSpread) * Math.min(1, dt * 18);
    this.hud.setSpread(Math.tan(this.shownSpread) * pxPerRad);
    this.hud.setMatch(this.match, this.net.serverNow(), this.myTeam);
    this.renderer.render(this.scene, this.camera);
  }

  destroy() { this.running = false; this.net.close(); this.fx.dispose(); this.renderer.dispose(); }
}

export { CHARACTERS };
