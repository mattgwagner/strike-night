// Client weapon state: ammo, reload, fire cadence, spread + hit detection.
import { WEAPONS, type WeaponId, PRIMARY_WEAPONS } from '../../shared/constants';
import type { MapBox } from '../../shared/map';
import { forward, rayPlayer, rayWorld } from '../../shared/physics';
import type { HitReport, Vec3 } from '../../shared/protocol';

export interface Target { id: number; p: Vec3; crouch: boolean; alive: boolean }
export interface ShotResult {
  w: WeaponId; o: Vec3; dirs: Vec3[]; hits: HitReport[]; ends: Vec3[];
  /** Per pellet: the player it hit (with part), or null if it hit the world / nothing. */
  pellet: Array<{ id: number; part: 'head' | 'body' } | null>;
  /** Per pellet: true if it stopped on world geometry inside range. */
  wall: boolean[];
}

/**
 * Client-only recoil feel. Aim offsets are applied to the bullets too, so the
 * crosshair stays honest (what you see is where it goes). The server does not
 * validate direction, only the hit point, so this never desyncs.
 *  climb(i)  pitch added on the i-th shot of a burst (radians)
 *  drift(i)  yaw added on the i-th shot (negative = right)
 *  ret       return speed toward centre when not firing (1/s, exponential)
 *  punch     extra camera-only kick that snaps back fast
 *  fov       FOV punch in degrees
 *  heat      spread added per shot of sustained fire (radians), capped at 6 shots
 */
interface RecoilDef { climb(i: number): number; drift(i: number): number; ret: number; punch: number; fov: number; heat: number; vmKick: number }
const jitter = (a: number) => (Math.random() - 0.5) * a;
const RECOIL: Record<WeaponId, RecoilDef> = {
  knife:   { climb: () => 0, drift: () => 0, ret: 10, punch: 0.01, fov: 0, heat: 0, vmKick: 0.4 },
  pistol:  { climb: () => WEAPONS.pistol.recoil, drift: () => jitter(0.006), ret: 14, punch: 0.012, fov: 0, heat: 0.006, vmKick: 0.5 },
  rifle:   {
    // climbs hard for ~8 shots, then drifts right and wanders
    climb: i => WEAPONS.rifle.recoil * (i < 2 ? 0.55 : i < 9 ? 1 : 0.25),
    drift: i => (i < 4 ? jitter(0.002) : i < 12 ? -0.0055 + jitter(0.003) : Math.sin(i * 0.9) * 0.008),
    ret: 7, punch: 0.006, fov: 0, heat: 0.003, vmKick: 0.35,
  },
  shotgun: { climb: () => WEAPONS.shotgun.recoil, drift: () => jitter(0.01), ret: 6, punch: 0.06, fov: 5, heat: 0, vmKick: 1.6 },
  sniper:  { climb: () => WEAPONS.sniper.recoil, drift: () => jitter(0.008), ret: 2.4, punch: 0.05, fov: 7, heat: 0, vmKick: 1.8 },
};
export function recoilDef(w: WeaponId) { return RECOIL[w]; }

export class Weapons {
  current: WeaponId = 'rifle';
  primary: WeaponId = 'rifle';
  mag: Record<WeaponId, number> = { knife: 0, pistol: WEAPONS.pistol.mag, rifle: WEAPONS.rifle.mag, shotgun: WEAPONS.shotgun.mag, sniper: WEAPONS.sniper.mag };
  reserve: Record<WeaponId, number> = { knife: 0, pistol: WEAPONS.pistol.reserve, rifle: WEAPONS.rifle.reserve, shotgun: WEAPONS.shotgun.reserve, sniper: WEAPONS.sniper.reserve };
  reloadingUntil = 0;
  nextShotAt = 0;
  recoilPitch = 0;      // aim offset added to view pitch (bullets follow it)
  recoilYaw = 0;        // aim offset added to view yaw
  punch = 0;            // camera-only pitch punch, snaps back fast
  fovPunch = 0;         // degrees, decays
  burst = 0;            // shots in the current burst
  spreadHeat = 0;       // grows with sustained fire
  private lastShotAt = 0;
  scoped = false;

  constructor(private bullets: MapBox[]) {}

  get def() { return WEAPONS[this.current]; }
  get reloading() { return performance.now() < this.reloadingUntil; }

  /** Full refill (on spawn). */
  refill() {
    for (const w of Object.keys(WEAPONS) as WeaponId[]) { this.mag[w] = WEAPONS[w].mag; this.reserve[w] = WEAPONS[w].reserve; }
    this.reloadingUntil = 0; this.current = this.primary; this.scoped = false; this.spreadHeat = 0;
    this.recoilPitch = 0; this.recoilYaw = 0; this.punch = 0; this.fovPunch = 0; this.burst = 0;
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
    const now = performance.now();
    const rc = RECOIL[d.id];
    // recover once the trigger has been quiet for a beat
    const firing = now - this.lastShotAt < d.fireMs + 60;
    if (!firing) {
      const k = Math.exp(-dt * rc.ret);
      this.recoilPitch *= k; this.recoilYaw *= k;
      if (now - this.lastShotAt > d.fireMs + 180) this.burst = 0;
    }
    this.punch *= Math.exp(-dt * 18);
    this.fovPunch *= Math.exp(-dt * 9);
    this.spreadHeat = Math.max(0, this.spreadHeat - dt * 3);
  }

  /** Current cone half-angle (radians) for the held weapon. */
  effectiveSpread(moveFrac: number, crouch: boolean, ground: boolean) {
    const d = this.def;
    let spread = d.spread + d.moveSpread * moveFrac + Math.min(6, this.spreadHeat) * RECOIL[d.id].heat;
    if (crouch) spread *= 0.7;
    if (!ground) spread = spread * 2.5 + 0.02;
    if (this.scoped) spread *= 0.2;
    if (d.id === 'sniper' && !this.scoped) spread += 0.08;
    return spread;
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
    const spread = this.effectiveSpread(moveFrac, crouch, ground);
    // bullets leave along the recoiled aim; the kick from this shot lands after
    const aimYaw = yaw + this.recoilYaw, aimPitch = pitch + this.recoilPitch;
    const rc = RECOIL[d.id];
    this.recoilPitch += rc.climb(this.burst);
    this.recoilYaw += rc.drift(this.burst);
    if (this.recoilPitch > 0.35) this.recoilPitch = 0.35;
    this.punch += rc.punch;
    this.fovPunch += rc.fov;
    this.burst++;
    this.lastShotAt = now;
    this.spreadHeat = Math.min(6, this.spreadHeat + 1);
    const dirs: Vec3[] = [];
    const hits: HitReport[] = [];
    const ends: Vec3[] = [];
    const pellet: ShotResult['pellet'] = [];
    const walls: boolean[] = [];
    for (let i = 0; i < d.pellets; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      const dir = forward(aimYaw + Math.cos(a) * r, aimPitch + Math.sin(a) * r);
      dirs.push(dir);
      const wallT = rayWorld(eye, dir, this.bullets, d.range);
      const wall = wallT ?? d.range;
      let best: { t: number; id: number; part: 'head' | 'body' } | null = null;
      for (const tg of targets) {
        if (!tg.alive) continue;
        const h = rayPlayer(eye, dir, tg.p, tg.crouch, wall);
        if (h && (!best || h.t < best.t)) best = { t: h.t, id: tg.id, part: h.part };
      }
      const t = best ? best.t : wall;
      const end: Vec3 = [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
      ends.push(end);
      pellet.push(best ? { id: best.id, part: best.part } : null);
      walls.push(!best && wallT !== null);
      if (best) hits.push({ id: best.id, part: best.part, point: end });
    }
    return { w: d.id, o: eye, dirs, hits, ends, pellet, wall: walls };
  }
}
