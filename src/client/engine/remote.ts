// Remote players: interpolated from 20Hz snapshots, rendered with their skin.
import * as THREE from 'three';
import { PLAYER, type WeaponId } from '../../shared/constants';
import type { PlayerSnapshot, Vec3 } from '../../shared/protocol';
import { buildSkin, makeNameTag, type SkinRig } from '../world/skins';
import { CHARACTERS } from '../../shared/constants';

interface Sample { t: number; p: Vec3; yaw: number; pitch: number; crouch: boolean; moving: boolean }

const FALL_MS = 380, FADE_FROM = 1900, FADE_MS = 600, POP_MS = 150;
const STRIDE = 2.1;
const RED = new THREE.Color(0xff2020);

export class RemotePlayer {
  id: number; name: string; skin: string; team: 0 | 1;
  hp: number; kills = 0; deaths = 0; ping = 0; w: WeaponId;
  bot: boolean;
  rig: SkinRig; tag: THREE.Sprite;
  /** Skin colour, for hit puffs. */
  color: string;
  // latest interpolated values
  p: Vec3; yaw = 0; pitch = 0; crouch = false; moving = false;
  /** Set when a footstep is due (consumer clears it). */
  footstep = false;
  private buf: Sample[] = [];
  private deathT = -1;
  private spawnT = -1;
  private bob = 0;
  private flinchT = -1; private flinchK = 0;
  private flashT = -1; private flashK = 0;
  private stepDist = 0;
  private lastP: Vec3;
  private mats: Array<{ m: THREE.Material & { opacity: number; transparent: boolean }; emissive?: THREE.Color; base?: THREE.Color; baseOpacity: number; baseTransparent: boolean }> = [];
  private faded = false;
  private legs: THREE.Object3D[] = [];
  private muzzleLocal = new THREE.Vector3(0, 0, 0.6);

  constructor(s: PlayerSnapshot, scene: THREE.Scene) {
    this.id = s.id; this.name = s.name; this.skin = s.skin; this.team = s.team; this.hp = s.hp; this.w = s.w;
    this.kills = s.kills; this.deaths = s.deaths; this.ping = s.ping; this.bot = !!s.bot;
    this.p = [...s.p] as Vec3; this.yaw = s.yaw; this.lastP = [...s.p] as Vec3;
    this.rig = buildSkin(s.skin, s.team);
    const def = CHARACTERS.find(c => c.id === s.skin) ?? CHARACTERS[0];
    this.color = def.color;
    this.tag = makeNameTag(s.name, def.color);
    this.rig.group.add(this.tag);
    this.rig.group.rotation.order = 'YXZ'; // yaw outermost so the death fall is in the body's own frame
    this.rig.group.position.set(s.p[0], s.p[1], s.p[2]);
    this.rig.group.visible = s.hp > 0;
    const seen = new Set<THREE.Material>();
    this.rig.group.traverse(o => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!m || seen.has(m) || o === this.tag) return;
      seen.add(m);
      const em = (m as THREE.MeshStandardMaterial).emissive;
      this.mats.push({ m: m as any, emissive: em, base: em?.clone(), baseOpacity: (m as any).opacity ?? 1, baseTransparent: !!(m as any).transparent });
    });
    // optional leg rig if the skin exposes it
    for (const n of ['legL', 'legR']) { const o = this.rig.group.getObjectByName(n); if (o) this.legs.push(o); }
    scene.add(this.rig.group);
  }

  get alive() { return this.hp > 0; }

  push(t: number, s: Pick<PlayerSnapshot, 'p' | 'yaw' | 'pitch' | 'hp' | 'w' | 'crouch' | 'moving'>) {
    this.buf.push({ t, p: s.p, yaw: s.yaw, pitch: s.pitch, crouch: s.crouch, moving: s.moving });
    if (this.buf.length > 30) this.buf.shift();
    this.hp = s.hp; this.w = s.w;
  }

  spawnAt(p: Vec3, yaw: number) {
    this.buf = [];
    this.p = [...p] as Vec3; this.yaw = yaw; this.hp = PLAYER.maxHp; this.deathT = -1;
    this.lastP = [...p] as Vec3; this.stepDist = 0;
    this.rig.group.position.set(p[0], p[1], p[2]);
    this.rig.group.rotation.set(0, 0, 0);
    this.rig.group.visible = true;
    this.tag.visible = true;
    this.setOpacity(1);
    this.spawnT = performance.now();
  }

  die(now: number) { this.hp = 0; this.deathT = now; this.tag.visible = false; }

  /** Brief recoil of the body when hit. */
  flinch(head: boolean) { this.flinchT = performance.now(); this.flinchK = head ? 1 : 0.6; }

  /** Brief red flash of the body (local hit / kill confirmation). */
  flash(strength = 1) { this.flashT = performance.now(); this.flashK = strength; }

  /** World position of the gun muzzle (writes into `out`). */
  muzzleWorld(out: THREE.Vector3) {
    this.rig.group.updateMatrixWorld();
    return this.rig.gun.localToWorld(out.copy(this.muzzleLocal));
  }

  /** renderT is server-time minus interpolation delay. */
  update(renderT: number, now: number, dt: number) {
    const b = this.buf;
    if (b.length >= 2) {
      let i = b.length - 1;
      while (i > 0 && b[i - 1].t > renderT) i--;
      const a = b[Math.max(0, i - 1)], c = b[i];
      const span = Math.max(1, c.t - a.t);
      const f = Math.max(0, Math.min(1, (renderT - a.t) / span));
      this.p = [a.p[0] + (c.p[0] - a.p[0]) * f, a.p[1] + (c.p[1] - a.p[1]) * f, a.p[2] + (c.p[2] - a.p[2]) * f];
      this.yaw = lerpAngle(a.yaw, c.yaw, f);
      this.pitch = a.pitch + (c.pitch - a.pitch) * f;
      this.crouch = c.crouch; this.moving = c.moving;
    } else if (b.length === 1) {
      this.p = b[0].p; this.yaw = b[0].yaw; this.pitch = b[0].pitch; this.crouch = b[0].crouch; this.moving = b[0].moving;
    }
    const g = this.rig.group;
    this.updateFlash(now);
    if (this.deathT >= 0) {
      const t = now - this.deathT;
      // fall backward, overshoot the floor a touch and bounce once
      let ang: number;
      if (t < FALL_MS) { const k = t / FALL_MS; ang = k * k * (Math.PI / 2); }
      else { const k = Math.min(1, (t - FALL_MS) / 260); ang = Math.PI / 2 - Math.sin(k * Math.PI) * 0.16 * (1 - k * 0.5); }
      g.rotation.x = ang; // +x tips the top toward +Z = backward for a -Z-facing rig
      g.position.y = this.p[1] + 0.1 * Math.min(1, t / FALL_MS);
      if (t > FADE_FROM) this.setOpacity(Math.max(0, 1 - (t - FADE_FROM) / FADE_MS));
      if (t > FADE_FROM + FADE_MS) g.visible = false;
      return;
    }
    if (!this.alive) { g.visible = false; return; }
    g.visible = true;
    g.position.set(this.p[0], this.p[1], this.p[2]);
    // skins.ts turns the model inside the rig so rotation.y = yaw faces forward(yaw)
    g.rotation.y = this.yaw;
    // flinch: snap back then recover
    let fl = 0;
    if (this.flinchT >= 0) { const k = (now - this.flinchT) / 220; if (k >= 1) this.flinchT = -1; else fl = Math.sin(Math.min(1, k) * Math.PI) * (1 - k) * 0.25 * this.flinchK; }
    g.rotation.x = fl;
    this.rig.head.rotation.x = -this.pitch * 0.8 - fl * 1.5;
    this.rig.gun.rotation.x = -this.pitch;
    this.rig.setCrouch(this.crouch);
    // respawn pop. Set the scale absolutely: setCrouch owns scale.y, and a
    // multiplicative pop compounded every frame, which flattened the body.
    const sy = g.scale.y;
    if (this.spawnT >= 0) {
      const k = Math.min(1, (now - this.spawnT) / POP_MS);
      const s = 0.6 + 0.4 * (1 - (1 - k) * (1 - k)) + Math.sin(k * Math.PI) * 0.06;
      g.scale.set(s, sy * s, s);
      if (k >= 1) this.spawnT = -1;
    } else {
      g.scale.set(1, sy, 1);
    }
    // walking: bob + leg scissor + footsteps
    const moved = Math.hypot(this.p[0] - this.lastP[0], this.p[2] - this.lastP[2]);
    this.lastP[0] = this.p[0]; this.lastP[1] = this.p[1]; this.lastP[2] = this.p[2];
    if (this.moving) {
      this.bob += dt * 10;
      g.position.y += Math.abs(Math.sin(this.bob)) * 0.04;
      if (moved < 1) { this.stepDist += moved; if (this.stepDist > STRIDE) { this.stepDist = 0; this.footstep = true; } }
    }
    const swing = this.moving ? Math.sin(this.bob) * 0.5 : 0;
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      l.rotation.x += ((i ? -swing : swing) - l.rotation.x) * Math.min(1, dt * 14);
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.rig.group);
    (this.tag.material as THREE.SpriteMaterial).map?.dispose();
  }

  private updateFlash(now: number) {
    if (this.flashT < 0) return;
    const k = (now - this.flashT) / 160;
    const f = k >= 1 ? 0 : (1 - k) * this.flashK;
    for (const e of this.mats) if (e.emissive && e.base) e.emissive.copy(e.base).lerp(RED, f);
    if (k >= 1) this.flashT = -1;
  }

  private setOpacity(o: number) {
    const want = o < 1;
    if (want === this.faded && !want) return;
    for (const e of this.mats) {
      const tr = want || e.baseTransparent;
      if (e.m.transparent !== tr) { e.m.transparent = tr; e.m.needsUpdate = true; }
      e.m.opacity = want ? e.baseOpacity * o : e.baseOpacity;
    }
    this.faded = want;
  }
}

function lerpAngle(a: number, b: number, f: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
