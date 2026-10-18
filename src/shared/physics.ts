// Box-world physics shared by the client (movement, hit detection) and the
// Durable Object (validation, bots). Pure functions on plain arrays only.
import { PLAYER } from './constants';
import type { MapBox } from './map';
import type { Vec3 } from './protocol';

export interface Body { p: Vec3; v: Vec3; crouch: boolean; ground: boolean }

export function playerHeight(crouch: boolean) { return crouch ? PLAYER.crouchHeight : PLAYER.height; }
export function eyeHeight(crouch: boolean) { return crouch ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight; }

function overlaps(p: Vec3, h: number, b: MapBox): boolean {
  const r = PLAYER.radius;
  return p[0] + r > b.min[0] && p[0] - r < b.max[0]
    && p[1] + h > b.min[1] && p[1] < b.max[1]
    && p[2] + r > b.min[2] && p[2] - r < b.max[2];
}

export function solidBoxes(boxes: MapBox[]): MapBox[] { return boxes.filter(b => !b.nocollide); }
export function bulletBoxes(boxes: MapBox[]): MapBox[] { return boxes.filter(b => !b.nocollide && !b.shootThrough); }

/** Can a body stand up here without hitting a ceiling? */
export function canStand(p: Vec3, solids: MapBox[]): boolean {
  for (const b of solids) if (overlaps(p, PLAYER.height, b)) return false;
  return true;
}

/**
 * Move-and-slide one axis at a time. `wish` is the desired horizontal velocity
 * (m/s). Mutates and returns the body. Steps up ledges <= 0.55m.
 */
export function stepBody(body: Body, wish: [number, number], dt: number, solids: MapBox[], jump: boolean): Body {
  const h = playerHeight(body.crouch);
  body.v[0] = wish[0];
  body.v[2] = wish[1];
  if (jump && body.ground) { body.v[1] = PLAYER.jumpSpeed; body.ground = false; }
  body.v[1] -= PLAYER.gravity * dt;
  if (body.v[1] < -40) body.v[1] = -40;

  // horizontal X with step-up
  moveAxis(body, 0, body.v[0] * dt, h, solids);
  moveAxis(body, 2, body.v[2] * dt, h, solids);
  // vertical
  const dy = body.v[1] * dt;
  body.p[1] += dy;
  body.ground = false;
  for (const b of solids) {
    if (!overlaps(body.p, h, b)) continue;
    if (dy < 0) { body.p[1] = b.max[1]; body.ground = true; body.v[1] = 0; }
    else { body.p[1] = b.min[1] - h; body.v[1] = 0; }
  }
  // world floor safety net
  if (body.p[1] < -5) { body.p[1] = -5; body.ground = true; body.v[1] = 0; }
  return body;
}

const STEP = 0.55;

function moveAxis(body: Body, axis: 0 | 2, d: number, h: number, solids: MapBox[]) {
  if (d === 0) return;
  body.p[axis] += d;
  for (const b of solids) {
    if (!overlaps(body.p, h, b)) continue;
    // try stepping up onto it
    const top = b.max[1];
    if (top - body.p[1] <= STEP && top - body.p[1] > 0) {
      const probe: Vec3 = [body.p[0], top + 0.001, body.p[2]];
      let free = true;
      for (const o of solids) if (overlaps(probe, h, o)) { free = false; break; }
      if (free) { body.p[1] = top + 0.001; continue; }
    }
    // slide back out
    const r = PLAYER.radius;
    if (d > 0) body.p[axis] = b.min[axis] - r - 0.001;
    else body.p[axis] = b.max[axis] + r + 0.001;
    body.v[axis] = 0;
  }
}

/** Ray vs AABB (slab). Returns distance along dir or null. */
export function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxDist = Infinity): number | null {
  let tmin = 0, tmax = maxDist;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / d[i];
    let t1 = (min[i] - o[i]) * inv;
    let t2 = (max[i] - o[i]) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Nearest world hit along a ray. */
export function rayWorld(o: Vec3, d: Vec3, boxes: MapBox[], maxDist = 1000): number | null {
  let best: number | null = null;
  for (const b of boxes) {
    const t = rayBox(o, d, b.min, b.max, best ?? maxDist);
    if (t !== null && t >= 0 && (best === null || t < best)) best = t;
  }
  return best;
}

/** Ray vs a player at feet position p. Returns {t, part} or null. */
export function rayPlayer(o: Vec3, d: Vec3, p: Vec3, crouch: boolean, maxDist = 1000): { t: number; part: 'head' | 'body' } | null {
  const r = PLAYER.radius;
  const h = playerHeight(crouch);
  const headMin: Vec3 = [p[0] - r * 0.6, p[1] + h - PLAYER.headHeight, p[2] - r * 0.6];
  const headMax: Vec3 = [p[0] + r * 0.6, p[1] + h, p[2] + r * 0.6];
  const th = rayBox(o, d, headMin, headMax, maxDist);
  if (th !== null && th >= 0) return { t: th, part: 'head' };
  const bodyMin: Vec3 = [p[0] - r, p[1], p[2] - r];
  const bodyMax: Vec3 = [p[0] + r, p[1] + h - PLAYER.headHeight, p[2] + r];
  const tb = rayBox(o, d, bodyMin, bodyMax, maxDist);
  if (tb !== null && tb >= 0) return { t: tb, part: 'body' };
  return null;
}

export function dist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Forward unit vector from yaw/pitch (yaw 0 = -Z, right-handed like three.js). */
export function forward(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

/** Line of sight between two points through bullet-blocking boxes. */
export function hasLos(a: Vec3, b: Vec3, boxes: MapBox[]): boolean {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-4) return true;
  const n: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  const t = rayWorld(a, n, boxes, len);
  return t === null || t >= len - 1e-3;
}
