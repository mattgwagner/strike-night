// Orchestrator: renderer, local player, weapons, remotes, HUD, audio, net.
import * as THREE from 'three';
import { CHARACTERS, PLAYER, WEAPONS, TICK_MS, type WeaponId } from '../shared/constants';
import { MAPS } from '../shared/map';
import { bulletBoxes, solidBoxes } from '../shared/physics';
import type { MatchInfo, PlayerSnapshot, ServerMsg, Vec3 } from '../shared/protocol';
import { Sfx } from './audio/sfx';
import { Input, DEFAULT_BINDINGS } from './engine/input';
import { LocalPlayer } from './engine/player';
import { RemotePlayer } from './engine/remote';
import { Weapons } from './engine/weapons';
import { Net } from './net';
import { Hud } from './ui/hud';
import type { JoinChoice } from './ui/join';
import { buildWorld } from './world/build';
import { buildViewmodel, type Viewmodel } from './world/viewmodel';

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
  tracers: Array<{ line: THREE.Line; until: number }> = [];
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
        if (m.hit) this.addTracer(m.o, m.hit, 0xffd37a);
        if (r) r.rig.gun.position.z = -0.1;
        break;
      }
      case 'hit': {
        if (m.from === this.myId) { this.hud.hit(m.part === 'head'); this.sfx.hitmarker(m.part === 'head'); }
        if (m.to === this.myId) { this.hp = m.hp; this.hud.setHp(this.hp); this.hud.hurt(); this.sfx.hurt(); }
        break;
      }
      case 'kill': {
        const k = this.names.get(m.killer) ?? '?', v = this.names.get(m.victim) ?? '?';
        this.hud.kill(k, v, m.w, m.headshot, m.killer === this.myId || m.victim === this.myId);
        if (m.killer === this.myId) this.sfx.kill();
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
  }

  private dieMe(killer: string, w: WeaponId, headshot: boolean) {
    this.me.alive = false; this.hp = 0; this.diedAt = performance.now(); this.hud.setHp(0); this.sfx.die();
    this.weapons.scoped = false;
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

  private addTracer(a: Vec3, b: Vec3, color: number) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    this.scene.add(line);
    this.tracers.push({ line, until: performance.now() + 60 });
  }

  private fireLocal() {
    const eye = this.me.eye();
    const targets = [...this.remotes.values()].filter(r => r.alive && (this.match.mode !== 'tdm' || r.team !== this.myTeam)).map(r => ({ id: r.id, p: r.p, crouch: r.crouch, alive: r.alive }));
    const res = this.weapons.fire(eye, this.me.yaw, this.me.pitch, this.me.speedFrac, targets, this.me.body.crouch, this.me.body.ground);
    if (!res) return;
    this.net.send({ t: 'shoot', w: res.w, o: res.o, d: res.dirs[0], hits: res.hits });
    this.sfx.shot(res.w);
    this.viewmodel.kick(WEAPONS[res.w].recoil * 20);
    if (res.w !== 'knife') for (const end of res.ends) this.addTracer(this.viewmodel.muzzleWorld(), end, 0xffeeaa);
    if (this.weapons.def.mag > 0 && this.weapons.mag[res.w] === 0 && this.weapons.startReload()) this.sfx.reload();
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
    for (const r of this.remotes.values()) { r.update(renderT, now, dt); if (r.rig.gun.position.z < 0.1) r.rig.gun.position.z += dt * 2; }
    // tracers
    this.tracers = this.tracers.filter(tr => { if (now > tr.until) { this.scene.remove(tr.line); tr.line.geometry.dispose(); return false; } return true; });
    // network send
    if (now - this.lastSend >= TICK_MS && this.me.alive && this.myId >= 0) {
      this.lastSend = now;
      this.net.send({ t: 'input', p: this.me.body.p, yaw: this.me.yaw, pitch: this.me.pitch, crouch: this.me.body.crouch, moving: this.me.moving, ground: this.me.body.ground, w: this.weapons.current });
    }
    // camera
    const eye = this.me.eye();
    const bob = this.me.moving ? Math.sin(this.me.bobPhase) * 0.035 * this.me.speedFrac : 0;
    this.camera.position.set(eye[0], eye[1] + bob, eye[2]);
    this.camera.rotation.set(this.me.pitch + this.weapons.recoilKick, this.me.yaw, 0);
    const targetFov = this.weapons.scoped ? this.baseFov * (this.weapons.def.scope ?? 1) : this.baseFov;
    if (Math.abs(this.camera.fov - targetFov) > 0.1) { this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14); this.camera.updateProjectionMatrix(); }
    this.viewmodel.update(dt, this.me.moving ? this.me.speedFrac : 0, this.me.bobPhase, this.weapons.reloading, this.weapons.scoped, this.me.alive);
    this.world.tick(dt, t / 1000);
    // hud
    this.hud.setWeapon(this.weapons.current, this.weapons.mag[this.weapons.current], this.weapons.reserve[this.weapons.current], this.weapons.reloading, this.weapons.scoped);
    this.hud.setMatch(this.match, this.net.serverNow(), this.myTeam);
    this.renderer.render(this.scene, this.camera);
  }

  destroy() { this.running = false; this.net.close(); this.renderer.dispose(); }
}

export { CHARACTERS };
