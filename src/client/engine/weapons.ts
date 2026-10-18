// Client weapon state: ammo, reload, fire cadence, spread + hit detection.
import { WEAPONS, type WeaponId, PRIMARY_WEAPONS } from '../../shared/constants';
import type { MapBox } from '../../shared/map';
import { forward, rayPlayer, rayWorld } from '../../shared/physics';
import type { HitReport, Vec3 } from '../../shared/protocol';

export interface Target { id: number; p: Vec3; crouch: boolean; alive: boolean }
export interface ShotResult { w: WeaponId; o: Vec3; dirs: Vec3[]; hits: HitReport[]; ends: Vec3[] }

export class Weapons {
  current: WeaponId = 'rifle';
  primary: WeaponId = 'rifle';
  mag: Record<WeaponId, number> = { knife: 0, pistol: WEAPONS.pistol.mag, rifle: WEAPONS.rifle.mag, shotgun: WEAPONS.shotgun.mag, sniper: WEAPONS.sniper.mag };
  reserve: Record<WeaponId, number> = { knife: 0, pistol: WEAPONS.pistol.reserve, rifle: WEAPONS.rifle.reserve, shotgun: WEAPONS.shotgun.reserve, sniper: WEAPONS.sniper.reserve };
  reloadingUntil = 0;
  nextShotAt = 0;
  recoilKick = 0;       // pitch offset decaying to 0
  spreadHeat = 0;       // grows with sustained fire
  scoped = false;

  constructor(private bullets: MapBox[]) {}

  get def() { return WEAPONS[this.current]; }
  get reloading() { return performance.now() < this.reloadingUntil; }

  /** Full refill (on spawn). */
  refill() {
    for (const w of Object.keys(WEAPONS) as WeaponId[]) { this.mag[w] = WEAPONS[w].mag; this.reserve[w] = WEAPONS[w].reserve; }
    this.reloadingUntil = 0; this.current = this.primary; this.scoped = false; this.spreadHeat = 0;
  }

  setPrimary(w: WeaponId) { if (PRIMARY_WEAPONS.includes(w)) { this.primary = w; if (WEAPONS[this.current].slot === 1) this.current = w; } }

  switchSlot(slot: 1 | 2 | 3) {
    const w: WeaponId = slot === 1 ? this.primary : slot === 2 ? 'pistol' : 'knife';
    if (w === this.current) return false;
    this.current = w; this.reloadingUntil = 0; this.scoped = false;
    this.nextShotAt = Math.max(this.nextShotAt, performance.now() + 250);
    return true;
  }

  cycle(dir: number) {
    const order: Array<1 | 2 | 3> = [1, 2, 3];
    const i = order.indexOf(WEAPONS[this.current].slot);
    this.switchSlot(order[(i + (dir > 0 ? 1 : 2)) % 3]);
  }

  startReload(): boolean {
    const d = this.def;
    if (d.mag === 0 || this.reloading || this.mag[d.id] >= d.mag || this.reserve[d.id] <= 0) return false;
    this.reloadingUntil = performance.now() + d.reloadMs;
    this.scoped = false;
    return true;
  }

  /** Call every frame to finish reloads and decay recoil. */
  update(dt: number) {
    const d = this.def;
    if (this.reloadingUntil && !this.reloading && this.mag[d.id] < d.mag) {
      const need = d.mag - this.mag[d.id];
      const take = Math.min(need, this.reserve[d.id]);
      this.mag[d.id] += take; this.reserve[d.id] -= take;
      this.reloadingUntil = 0;
    }
    this.recoilKick *= Math.exp(-dt * 12);
    this.spreadHeat = Math.max(0, this.spreadHeat - dt * 1.5);
  }

  canFire(held: boolean, queued: boolean) {
    const d = this.def;
    if (this.reloading) return false;
    if (performance.now() < this.nextShotAt) return false;
    if (d.mag > 0 && this.mag[d.id] <= 0) return false;
    return queued || (d.auto && held);
  }

  /**
   * Fire from `eye` looking along yaw/pitch. Returns per-pellet directions and
   * the hits found against `targets` (world-occluded). Null if it can't fire.
   */
  fire(eye: Vec3, yaw: number, pitch: number, moveFrac: number, targets: Target[], crouch: boolean, ground: boolean): ShotResult | null {
    const d = this.def;
    const now = performance.now();
    this.nextShotAt = now + d.fireMs;
    if (d.mag > 0) this.mag[d.id]--;
    let spread = d.spread + d.moveSpread * moveFrac + this.spreadHeat * 0.01;
    if (crouch) spread *= 0.7;
    if (!ground) spread *= 2.5;
    if (this.scoped) spread *= 0.2;
    if (d.id === 'sniper' && !this.scoped) spread += 0.08;
    this.spreadHeat = Math.min(6, this.spreadHeat + 1);
    this.recoilKick += d.recoil;
    const dirs: Vec3[] = [];
    const hits: HitReport[] = [];
    const ends: Vec3[] = [];
    for (let i = 0; i < d.pellets; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      const dir = forward(yaw + Math.cos(a) * r, pitch + Math.sin(a) * r);
      dirs.push(dir);
      const wall = rayWorld(eye, dir, this.bullets, d.range) ?? d.range;
      let best: { t: number; id: number; part: 'head' | 'body' } | null = null;
      for (const tg of targets) {
        if (!tg.alive) continue;
        const h = rayPlayer(eye, dir, tg.p, tg.crouch, wall);
        if (h && (!best || h.t < best.t)) best = { t: h.t, id: tg.id, part: h.part };
      }
      const t = best ? best.t : wall;
      const end: Vec3 = [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
      ends.push(end);
      if (best) hits.push({ id: best.id, part: best.part, point: end });
    }
    return { w: d.id, o: eye, dirs, hits, ends };
  }
}
