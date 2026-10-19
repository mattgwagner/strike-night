// Orchestrator: renderer, local player, weapons, remotes, HUD, audio, net.
import * as THREE from 'three';
import { CHARACTERS, PLAYER, WEAPONS, TICK_MS, type WeaponId } from '../shared/constants';
import { MAPS } from '../shared/map';
import { bulletBoxes, forward, rayWorld, solidBoxes } from '../shared/physics';
import type { MapBox } from '../shared/map';
import type { MatchInfo, PlayerSnapshot, ServerMsg, Vec3 } from '../shared/protocol';
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
    this.fx.warm(this.renderer, this.camera);
    this.input = new Input(this.renderer.domElement);
    this.me = new LocalPlayer(this.input, solidBoxes(map.boxes));
    this.weapons = new Weapons(bulletBoxes(map.boxes));
    this.weapons.setPrimary(choice.primary);
    this.weapons.refill();
    this.hud = new Hud(root);
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
        for (const p of m.players) { this.names.set(p.id, p.name); this.scores.set(p.id, { kills: p.kills, deaths: p.deaths, ping: p.ping, team: p.team }); if (p.id === m.id) { this.myTeam = p.team; this.spawnMe(p.p, p.yaw); } else this.addRemote(p); }
        this.net.send({ t: 'loadout', primary: this.weapons.primary });
        break;
      }
      case 'join': this.names.set(m.player.id, m.player.name); this.scores.set(m.player.id, { kills: 0, deaths: 0, ping: 0, team: m.player.team }); if (m.player.id !== this.myId) { this.addRemote(m.player); this.hud.chat('·', `${m.player.name} joined`); } break;
      case 'leave': { const r = this.remotes.get(m.id); if (r) { r.dispose(this.scene); this.remotes.delete(m.id); this.hud.chat('·', `${r.name} left`); } this.scores.delete(m.id); break; }
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
        this.hud.kill(k, v, m.w, m.headshot, m.killer === this.myId || m.victim === this.myId);
        if (m.killer === this.myId) { this.sfx.kill(); this.remotes.get(m.victim)?.flash(1.6); }
        if (m.victim === this.myId) this.dieMe(k, m.w, m.headshot);
        else this.remotes.get(m.victim)?.die(performance.now());
        break;
      }
      case 'score': {
        for (const p of m.players) { this.scores.set(p.id, { kills: p.kills, deaths: p.deaths, ping: p.ping, team: p.team }); if (p.id === this.myId) this.myTeam = p.team; const r = this.remotes.get(p.id); if (r) { r.kills = p.kills; r.deaths = p.deaths; r.ping = p.ping; r.team = p.team; } }
        this.match = m.match;
        break;
      }
      case 'match': {
        const prev = this.match.phase;
        this.match = m.match;
        if (m.match.phase === 'live' && prev !== 'live') { this.sfx.matchStart(); this.flash('FIGHT!', `first to ${30} or best in ${Math.round((m.match.endsAt - this.net.serverNow()) / 60000)} min`); }
        if (m.match.phase === 'over') { this.sfx.matchOver(); this.flash(this.winnerText(), 'next round soon'); this.hud.showScoreboard(true, this.scoreRows(), this.match); setTimeout(() => this.hud.showScoreboard(false), 8000); }
        if (m.match.phase === 'warmup' && prev === 'over') this.flash('WARMUP', 'match starts soon');
        break;
      }
      case 'chat': this.hud.chat(m.name, m.text); break;
      case 'error': if (m.msg !== 'rejoin') this.hud.setCenter('Error', m.msg); break;
      case 'pong': break;
    }
  }

  private winnerText() {
    if (this.match.mode === 'tdm') { const [a, b] = this.match.teamScore; return a === b ? 'DRAW' : `${a > b ? 'NIGHT' : 'DAY'} TEAM WINS`; }
    let best = -1, name = '';
    for (const [id, s] of this.scores) if (s.kills > best) { best = s.kills; name = this.names.get(id) ?? '?'; }
    return best > 0 ? `${name} WINS` : 'MATCH OVER';
  }

  private flash(big: string, sub: string) { this.hud.setCenter(big, sub); setTimeout(() => { if (this.me.alive && !this.paused) this.hud.setCenter(''); }, 2500); }

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
  }

  private dieMe(killer: string, w: WeaponId, headshot: boolean) {
    this.me.alive = false; this.hp = 0; this.diedAt = performance.now(); this.hud.setHp(0); this.sfx.die();
    this.weapons.scoped = false;
    this.deathPos = [...this.me.body.p] as Vec3; this.deathYaw = this.me.yaw;
    this.orbitStart = this.openOrbitAngle();
    this.showCorpse();
    this.hud.setCenter(`${headshot ? 'HEADSHOT by' : 'Killed by'} ${killer}`, `${WEAPONS[w].name} · respawning…`);
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
    const targets = [...this.remotes.values()].filter(r => r.alive && (this.match.mode !== 'tdm' || r.team !== this.myTeam)).map(r => ({ id: r.id, p: r.p, crouch: r.crouch, alive: r.alive }));
    const res = this.weapons.fire(eye, this.me.yaw, this.me.pitch, this.me.speedFrac, targets, this.me.body.crouch, this.me.body.ground);
    if (!res) return;
    this.net.send({ t: 'shoot', w: res.w, o: res.o, d: res.dirs[0], hits: res.hits });
    this.sfx.shot(res.w);
    this.viewmodel.kick(recoilDef(res.w).vmKick);
    if (res.w !== 'knife') {
      this.viewmodel.flash();
      const muzzle = this.viewmodel.muzzleWorld();
      this.fx.light(muzzle, res.w === 'shotgun' || res.w === 'sniper' ? 7 : 4);
      for (let i = 0; i < res.ends.length; i++) {
        // pellets after the first get a dimmer tracer so a shotgun blast is not a white sheet
        if (i < 4) this.fx.tracer(muzzle, res.ends[i], i ? 0x997a40 : 0xffe7a0);
      }
      if (res.w === 'rifle' || res.w === 'pistol') {
        const e = this.viewmodel.ejectWorld();
        const cy = Math.cos(this.me.yaw), sy = Math.sin(this.me.yaw);
        const side = 1.6 + Math.random() * 0.8;
        this.fx.casing(e, [cy * side + this.me.body.v[0], 1.6 + Math.random() * 0.8, -sy * side + this.me.body.v[2]], this.me.body.p[1]);
      }
    }
    for (let i = 0; i < res.ends.length; i++) {
      const hit = res.pellet[i];
      if (hit) { const r = this.remotes.get(hit.id); if (r) this.fx.puff(res.ends[i], r.color, hit.part === 'head'); }
      else if (res.wall[i]) this.fx.impact(res.ends[i], res.dirs[i], res.w === 'shotgun' || res.w === 'knife');
    }
    if (this.weapons.def.mag > 0 && this.weapons.mag[res.w] === 0 && this.weapons.startReload()) this.sfx.reload();
  }

  /** Effects for someone else's shot: muzzle flash at their gun, tracer, impact or puff. */
  private remoteShotFx(w: WeaponId, o: Vec3, d: Vec3, hit: Vec3 | undefined, r: RemotePlayer | undefined) {
    if (w === 'knife') return;
    const from = r && r.alive ? r.muzzleWorld(this.tmpV) : new THREE.Vector3(o[0], o[1] - 0.25, o[2]);
    this.fx.muzzle(from, w === 'shotgun' || w === 'sniper' ? 1.4 : w === 'pistol' ? 0.8 : 1);
    const pellets = w === 'shotgun' ? 5 : 1;
    const range = Math.min(WEAPONS[w].range, 80);
    for (let i = 0; i < pellets; i++) {
      let dir = d;
      if (i > 0) { const yaw = Math.atan2(-d[0], -d[2]), pitch = Math.asin(Math.max(-1, Math.min(1, d[1]))); dir = forward(yaw + (Math.random() - 0.5) * 0.12, pitch + (Math.random() - 0.5) * 0.12); }
      if (i === 0 && hit) {
        this.fx.tracer(from, hit, 0xffd37a);
        const v = this.victimAt(hit);
        if (v) this.fx.puff(hit, v.color);
        continue;
      }
      const t = rayWorld(o, dir, this.bullets, range);
      const end: Vec3 = [o[0] + dir[0] * (t ?? range), o[1] + dir[1] * (t ?? range), o[2] + dir[2] * (t ?? range)];
      if (i < 3) this.fx.tracer(from, end, 0xffd37a);
      if (t !== null) this.fx.impact(end, dir, pellets > 1);
    }
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

  private updateKillCam(now: number) {
    const t = now - this.diedAt;
    if (this.corpse) {
      const k = Math.min(1, t / 380);
      const g = this.corpse.group;
      g.rotation.x = (k * k * Math.PI / 2 - (t > 380 ? Math.sin(Math.min(1, (t - 380) / 260) * Math.PI) * 0.12 : 0));
      g.position.y = this.deathPos[1] + 0.1 * k;
    }
    const c: Vec3 = [this.deathPos[0], this.deathPos[1] + 0.5, this.deathPos[2]];
    const ease = Math.min(1, t / 600);
    const ang = this.orbitStart + (t / 1000) * 0.45;
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
      if (this.weapons.canFire(this.input.fire, take.fireQueued)) this.fireLocal();
    }
    // fixed-step physics
    this.stepT += dt;
    const step = 1 / 120;
    while (this.stepT >= step) { this.me.update(step, canAct); this.stepT -= step; }
    this.weapons.update(dt);
    // respawn request
    if (!this.me.alive && performance.now() - this.diedAt > PLAYER.respawnMs && canAct) this.net.send({ t: 'respawn' });
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
    } else this.updateKillCam(now);
    const scopeFov = this.weapons.scoped ? this.baseFov * (this.weapons.def.scope ?? 1) : this.baseFov;
    const targetFov = scopeFov + this.weapons.fovPunch * (this.weapons.scoped ? 0.3 : 1);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) { this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * (this.weapons.fovPunch > 0.5 ? 30 : 14)); this.camera.updateProjectionMatrix(); }
    const pxPerRad = innerHeight / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    this.fx.update(dt, pxPerRad);
    this.grenades.update(dt);
    this.viewmodel.update(dt, this.me.moving ? this.me.speedFrac : 0, this.me.bobPhase, this.weapons.reloading, this.weapons.scoped, this.me.alive);
    this.world.tick(dt, t / 1000);
    // hud
    this.hud.setWeapon(this.weapons.current, this.weapons.mag[this.weapons.current], this.weapons.reserve[this.weapons.current], this.weapons.reloading, this.weapons.scoped);
    const scope = this.weapons.scoped && this.me.alive;
    if (scope !== this.scopeShown) { this.scopeShown = scope; this.hud.setScope(scope); }
    const airborne = !this.me.body.ground;
    const spread = this.weapons.current === 'knife' ? 0 : this.weapons.effectiveSpread(this.me.speedFrac, this.me.body.crouch, !airborne);
    this.shownSpread += (spread - this.shownSpread) * Math.min(1, dt * 18);
    this.hud.setSpread(Math.tan(this.shownSpread) * pxPerRad);
    this.hud.setMatch(this.match, this.net.serverNow(), this.myTeam);
    this.renderer.render(this.scene, this.camera);
  }

  destroy() { this.running = false; this.net.close(); this.fx.dispose(); this.renderer.dispose(); }
}

export { CHARACTERS };
