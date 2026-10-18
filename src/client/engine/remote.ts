// Remote players: interpolated from 20Hz snapshots, rendered with their skin.
import * as THREE from 'three';
import { PLAYER, type WeaponId } from '../../shared/constants';
import type { PlayerSnapshot, Vec3 } from '../../shared/protocol';
import { buildSkin, makeNameTag, type SkinRig } from '../world/skins';
import { CHARACTERS } from '../../shared/constants';

interface Sample { t: number; p: Vec3; yaw: number; pitch: number; crouch: boolean; moving: boolean }

export class RemotePlayer {
  id: number; name: string; skin: string; team: 0 | 1;
  hp: number; kills = 0; deaths = 0; ping = 0; w: WeaponId;
  bot: boolean;
  rig: SkinRig; tag: THREE.Sprite;
  // latest interpolated values
  p: Vec3; yaw = 0; pitch = 0; crouch = false; moving = false;
  private buf: Sample[] = [];
  private deathT = -1;
  private bob = 0;

  constructor(s: PlayerSnapshot, scene: THREE.Scene) {
    this.id = s.id; this.name = s.name; this.skin = s.skin; this.team = s.team; this.hp = s.hp; this.w = s.w;
    this.kills = s.kills; this.deaths = s.deaths; this.ping = s.ping; this.bot = !!s.bot;
    this.p = [...s.p] as Vec3; this.yaw = s.yaw;
    this.rig = buildSkin(s.skin, s.team);
    const def = CHARACTERS.find(c => c.id === s.skin) ?? CHARACTERS[0];
    this.tag = makeNameTag(s.name, def.color);
    this.rig.group.add(this.tag);
    this.rig.group.position.set(s.p[0], s.p[1], s.p[2]);
    this.rig.group.visible = s.hp > 0;
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
    this.rig.group.position.set(p[0], p[1], p[2]);
    this.rig.group.rotation.set(0, 0, 0);
    this.rig.group.visible = true;
  }

  die(now: number) { this.hp = 0; this.deathT = now; }

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
    if (this.deathT >= 0) {
      const k = Math.min(1, (now - this.deathT) / 400);
      g.rotation.x = -k * Math.PI / 2;
      g.position.y = this.p[1] + k * 0.3;
      if (now - this.deathT > 2500) g.visible = false;
      return;
    }
    g.visible = true;
    g.position.set(this.p[0], this.p[1], this.p[2]);
    g.rotation.y = this.yaw;
    this.rig.head.rotation.x = -this.pitch * 0.8;
    this.rig.gun.rotation.x = -this.pitch;
    this.rig.setCrouch(this.crouch);
    if (this.moving) { this.bob += dt * 10; g.position.y += Math.abs(Math.sin(this.bob)) * 0.04; }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.rig.group);
    (this.tag.material as THREE.SpriteMaterial).map?.dispose();
  }
}

function lerpAngle(a: number, b: number, f: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
