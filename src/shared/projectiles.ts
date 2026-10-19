// Thrown grenades: definitions and the deterministic arc/bounce sim. The Room
// steps projectiles with this at the 20 Hz tick, and the client runs the same
// code for its preview arc, so what you aim is where it lands.
// Pure functions on plain arrays only (shared by client and worker).
import { PLAYER, TICK_MS } from './constants';
import type { MapBox } from './map';
import type { Vec3 } from './protocol';

export type GrenadeKind = 'paint' | 'smoke';
export const GRENADE_KINDS: GrenadeKind[] = ['paint', 'smoke'];

export const GRENADE = {
  radius: 0.12,          // collision sphere (m)
  speed: 14,             // m/s at full power
  minPower: 0.4,         // a tap still lobs it a few metres
  holdMs: 1000,          // hold this long for full power
  lift: 0.12,            // aim a little above the crosshair (radians of pitch)
  restitution: 0.45,     // normal velocity kept on a bounce
  friction: 0.7,         // tangential velocity kept on a bounce
  gravity: PLAYER.gravity,
  dt: TICK_MS / 1000,    // one server tick
  maxStep: 0.06,         // substep so a fast grenade cannot tunnel a thin wall
  bounceSpeed: 1.0,      // normal speed above this counts as a bounce
  lifeMs: 6000,          // safety: anything still flying after this resolves
} as const;

export const PAINT = {
  fuseMs: 2500,
  bounces: 3,            // bursts on this bounce if the fuse has not gone yet
  radius: 4,             // marks players within this distance with line of sight
  /** One hit, same as a body mark (PLAYER.maxHp = 3 hits). */
  damage: 1,
} as const;

export const SMOKE = {
  radius: 5,
  durationMs: 12_000,
  fuseMs: 3000,          // pops on landing, or after this if it never lands
} as const;

/** Each player carries this many per life. */
export const GRENADES_PER_LIFE: Record<GrenadeKind, number> = { paint: 1, smoke: 1 };

export interface ProjState {
  p: Vec3;
  v: Vec3;
  bounces: number;
  /** Set on the substep that hit a floor (normal pointing up). */
  landed: boolean;
}

export interface SmokeVolume { id: number; p: Vec3; until: number }

/** Initial velocity for a throw along unit direction `d` at power 0..1. */
export function throwVelocity(d: Vec3, power: number): Vec3 {
  const k = Math.max(0, Math.min(1, Number.isFinite(power) ? power : 1));
  const speed = GRENADE.speed * (GRENADE.minPower + (1 - GRENADE.minPower) * k);
  // tilt the direction up a little: grenades are lobbed, not fired
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const n: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
  const h = Math.hypot(n[0], n[2]);
  const pitch = Math.min(Math.PI / 2 - 0.01, Math.atan2(n[1], h) + GRENADE.lift);
  const yawX = h > 1e-6 ? n[0] / h : 0, yawZ = h > 1e-6 ? n[2] / h : -1;
  const cp = Math.cos(pitch);
  return [yawX * cp * speed, Math.sin(pitch) * speed, yawZ * cp * speed];
}

/** Closest point on a box to p. */
function clampToBox(p: Vec3, b: MapBox): Vec3 {
  return [
    Math.max(b.min[0], Math.min(b.max[0], p[0])),
    Math.max(b.min[1], Math.min(b.max[1], p[1])),
    Math.max(b.min[2], Math.min(b.max[2], p[2])),
  ];
}

/**
 * Push the sphere out of one box. Returns the contact normal or null when
 * there is no overlap.
 */
function resolveSphereBox(s: ProjState, r: number, b: MapBox): Vec3 | null {
  const c = clampToBox(s.p, b);
  const dx = s.p[0] - c[0], dy = s.p[1] - c[1], dz = s.p[2] - c[2];
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return null;
  let n: Vec3;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    n = [dx / d, dy / d, dz / d];
    const push = r - d + 1e-4;
    s.p[0] += n[0] * push; s.p[1] += n[1] * push; s.p[2] += n[2] * push;
  } else {
    // centre inside the box: leave by the shallowest face, preferring the one we came in through
    let best = Infinity, axis = 0, sign = 1;
    for (let i = 0; i < 3; i++) {
      const lo = s.p[i] - b.min[i], hi = b.max[i] - s.p[i];
      // weight by velocity so a fast grenade exits back the way it came
      const wLo = lo - (s.v[i] > 0 ? 0.05 : 0), wHi = hi - (s.v[i] < 0 ? 0.05 : 0);
      if (wLo < best) { best = wLo; axis = i; sign = -1; }
      if (wHi < best) { best = wHi; axis = i; sign = 1; }
    }
    n = [0, 0, 0]; n[axis] = sign;
    s.p[axis] = sign > 0 ? b.max[axis] + r + 1e-4 : b.min[axis] - r - 1e-4;
  }
  return n;
}

/**
 * Advance one projectile by dt (seconds) against solid boxes. Mutates and
 * returns `s`. Substeps internally so the result is independent of frame rate
 * for a fixed dt.
 */
export function stepProjectile(s: ProjState, dt: number, boxes: MapBox[], half = Infinity): ProjState {
  const r = GRENADE.radius;
  const speed = Math.hypot(s.v[0], s.v[1], s.v[2]);
  const n = Math.max(1, Math.ceil((speed * dt) / GRENADE.maxStep));
  const h = dt / n;
  s.landed = false;
  for (let k = 0; k < n; k++) {
    s.v[1] -= GRENADE.gravity * h;
    s.p[0] += s.v[0] * h; s.p[1] += s.v[1] * h; s.p[2] += s.v[2] * h;
    let bounced = false;
    for (const b of boxes) {
      // cheap reject
      if (s.p[0] + r < b.min[0] || s.p[0] - r > b.max[0] || s.p[1] + r < b.min[1] || s.p[1] - r > b.max[1] || s.p[2] + r < b.min[2] || s.p[2] - r > b.max[2]) continue;
      const nrm = resolveSphereBox(s, r, b);
      if (!nrm) continue;
      const vn = s.v[0] * nrm[0] + s.v[1] * nrm[1] + s.v[2] * nrm[2];
      if (vn >= 0) continue; // already separating
      // split into normal and tangent parts
      const tx = s.v[0] - vn * nrm[0], ty = s.v[1] - vn * nrm[1], tz = s.v[2] - vn * nrm[2];
      const hard = -vn > GRENADE.bounceSpeed;
      const keepN = hard ? GRENADE.restitution : 0;
      const keepT = hard ? GRENADE.friction : Math.max(0, 1 - 6 * h); // rolling friction when resting
      s.v[0] = tx * keepT - vn * keepN * nrm[0];
      s.v[1] = ty * keepT - vn * keepN * nrm[1];
      s.v[2] = tz * keepT - vn * keepN * nrm[2];
      if (hard) bounced = true;
      if (nrm[1] > 0.7) s.landed = true;
    }
    // the outer walls go up forever for grenades: nothing leaves the map
    for (const ax of [0, 2] as const) {
      const lim = half - r;
      if (Math.abs(s.p[ax]) > lim) {
        const sign = Math.sign(s.p[ax]);
        s.p[ax] = sign * lim;
        if (s.v[ax] * sign > 0) {
          if (s.v[ax] * sign > GRENADE.bounceSpeed) bounced = true;
          s.v[ax] = -s.v[ax] * GRENADE.restitution;
        }
      }
    }
    if (bounced) s.bounces++;
    // world floor safety net
    if (s.p[1] < -5) { s.p[1] = -5; s.v = [0, 0, 0]; s.landed = true; }
  }
  return s;
}

export interface ArcResult { points: Vec3[]; end: Vec3; landedAt: number | null; bounces: number }

/**
 * Simulate a throw with the server's tick and return a sample per tick until
 * `maxMs` or (for smoke) landing — what the preview arc draws.
 */
export function simulateArc(o: Vec3, d: Vec3, power: number, boxes: MapBox[], kind: GrenadeKind, maxMs: number = PAINT.fuseMs, half = Infinity): ArcResult {
  const s: ProjState = { p: [o[0], o[1], o[2]], v: throwVelocity(d, power), bounces: 0, landed: false };
  const points: Vec3[] = [[...s.p] as Vec3];
  let landedAt: number | null = null;
  for (let t = 0; t < maxMs; t += TICK_MS) {
    stepProjectile(s, GRENADE.dt, boxes, half);
    points.push([s.p[0], s.p[1], s.p[2]]);
    if (s.landed && landedAt === null) landedAt = t + TICK_MS;
    if (kind === 'smoke' && s.landed) break;
    if (kind === 'paint' && s.bounces >= PAINT.bounces) break;
  }
  return { points, end: points[points.length - 1], landedAt, bounces: s.bounces };
}

/** Does segment a→b pass within r of c? */
export function segmentHitsSphere(a: Vec3, b: Vec3, c: Vec3, r: number): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 1e-12 ? ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy + (c[2] - a[2]) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + dx * t - c[0], py = a[1] + dy * t - c[1], pz = a[2] + dz * t - c[2];
  return px * px + py * py + pz * pz < r * r;
}

/** True when any active smoke sphere lies across a→b. */
export function smokeBlocks(a: Vec3, b: Vec3, smokes: readonly SmokeVolume[], now = -Infinity): boolean {
  for (const s of smokes) if (s.until > now && segmentHitsSphere(a, b, s.p, SMOKE.radius)) return true;
  return false;
}
