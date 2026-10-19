import { describe, expect, it } from 'vitest';
import { PLAYER, TICK_MS } from '../src/shared/constants';
import { MAPS, type MapBox, type MapData } from '../src/shared/map';
import {
  GRENADE, PAINT, SMOKE, segmentHitsSphere, simulateArc, stepProjectile, throwVelocity, type ProjState,
} from '../src/shared/projectiles';
import type { ServerMsg, Vec3 } from '../src/shared/protocol';
import { Game } from '../src/worker/game';

const floor: MapBox = { min: [-50, -1, -50], max: [50, 0, 50] };

// A flat test arena: open floor plus one wall at x = 5..5.4 from z = -3 to 3.
const wall: MapBox = { min: [5, 0, -3], max: [5.4, 3, 3] };
const ARENA: MapData = {
  id: 'nade-test', name: 'Nade test', half: 50,
  boxes: [floor, wall],
  spawns: [{ p: [-20, 0, -20], yaw: 0 }, { p: [20, 0, 20], yaw: 0 }],
  lights: [], sky: { top: '#000', bottom: '#000', ambient: '#000', fog: 0 },
};
MAPS[ARENA.id] = ARENA;

function arena(now = 1000, mode: 'ffa' | 'tdm' = 'ffa') {
  const g = new Game(ARENA.id, now, mode);
  const ids = ['Alice', 'Bob', 'Cat'].map(n => { const r = g.join(n, 'bot', now); if ('error' in r) throw new Error(r.error); return r.player; });
  return { g, a: ids[0], b: ids[1], c: ids[2] };
}

const eyeOf = (p: { p: Vec3 }): Vec3 => [p.p[0], p.p[1] + PLAYER.eyeHeight, p.p[2]];
const types = (out: Array<{ msg: ServerMsg }>) => out.map(o => o.msg.t);

/** Tick the game until a predicate on the outbox holds (or give up). */
function runUntil(g: Game, start: number, pred: (msgs: ServerMsg[]) => boolean, maxMs = 8000) {
  for (let t = start; t < start + maxMs; t += TICK_MS) {
    const msgs = g.tick(t).map(o => o.msg);
    if (pred(msgs)) return { t, msgs };
  }
  throw new Error('never happened');
}

describe('grenade arc', () => {
  it('lands where ballistics says on flat ground', () => {
    // throw level (the lift adds a little pitch) from 1.62 m
    const o: Vec3 = [0, PLAYER.eyeHeight, 0];
    const d: Vec3 = [0, 0, -1];
    const v = throwVelocity(d, 1);
    const speed = Math.hypot(v[0], v[1], v[2]);
    expect(speed).toBeCloseTo(GRENADE.speed, 5);
    // time to fall from o.y - r to 0 with vertical speed vy: y(t) = y0 + vy t - g t²/2
    const y0 = o[1] - GRENADE.radius, g = GRENADE.gravity, vy = v[1];
    const t = (vy + Math.sqrt(vy * vy + 2 * g * y0)) / g;
    const expectZ = v[2] * t;
    const arc = simulateArc(o, d, 1, [floor], 'smoke', 4000);
    expect(arc.landedAt).not.toBeNull();
    expect(arc.end[1]).toBeGreaterThan(GRENADE.radius - 1e-3);
    expect(arc.end[1]).toBeLessThan(0.5);
    expect(Math.abs(arc.end[0])).toBeLessThan(1e-6);
    // first contact within one tick of travel of the analytic landing point
    expect(Math.abs(arc.end[2] - expectZ)).toBeLessThan(Math.hypot(v[0], v[2]) * GRENADE.dt + 0.05);
    // more power goes further
    const short = simulateArc(o, d, 0, [floor], 'smoke', 4000);
    expect(-short.end[2]).toBeLessThan(-arc.end[2] * 0.6);
  });

  it('bounces back off a wall with reduced speed', () => {
    const s: ProjState = { p: [3, 1.5, 0], v: [10, 0, 0], bounces: 0, landed: false };
    for (let i = 0; i < 5; i++) stepProjectile(s, GRENADE.dt, [floor, wall]); // 0.25 s: hits the wall before the floor
    expect(s.p[0]).toBeLessThan(5 - GRENADE.radius + 1e-3);
    expect(s.v[0]).toBeLessThan(0);
    expect(Math.abs(s.v[0])).toBeCloseTo(10 * GRENADE.restitution, 1);
    expect(s.bounces).toBeGreaterThanOrEqual(1);
  });

  it('does not tunnel a thin wall at full speed', () => {
    const thin: MapBox = { min: [2, 0, -3], max: [2.1, 3, 3] };
    const s: ProjState = { p: [0, 1.5, 0], v: [40, 0, 0], bounces: 0, landed: false };
    for (let i = 0; i < 10; i++) stepProjectile(s, GRENADE.dt, [floor, thin]);
    expect(s.p[0]).toBeLessThan(2);
  });

  it('segment-sphere test', () => {
    expect(segmentHitsSphere([-10, 1, 0], [10, 1, 0], [0, 0, 0], 5)).toBe(true);
    expect(segmentHitsSphere([-10, 6, 0], [10, 6, 0], [0, 0, 0], 5)).toBe(false);
    expect(segmentHitsSphere([-10, 0, 0], [-6, 0, 0], [0, 0, 0], 5)).toBe(false);
  });
});

describe('paint grenade', () => {
  it('bursts and marks a player in range with LoS, not one behind a wall', () => {
    const { g, a, b, c } = arena();
    // burst at (4, 0, 0): b at (3, 0, 3) has open sight, c at (6.5, 0, 0) is 2.5 m away behind the wall
    a.p = [-2, 0, 0]; b.p = [3, 0, 3]; c.p = [6.5, 0, 0];
    const out = g.handle(a.id, { t: 'throw', kind: 'paint', o: eyeOf(a), d: [1, 0, 0], power: 0 }, 1000);
    expect(types(out)).toEqual(['proj']);
    const pr = g.nades.flying[0];
    pr.p = [4, GRENADE.radius, 0]; pr.v = [0, 0, 0]; // pin the burst point for the test
    const { msgs, t } = runUntil(g, 1050, m => m.some(x => x.t === 'burst'));
    expect(t - 1000).toBeGreaterThanOrEqual(PAINT.fuseMs - TICK_MS);
    const burst = msgs.find(x => x.t === 'burst') as Extract<ServerMsg, { t: 'burst' }>;
    expect(burst.marked).toContain(b.id);
    expect(burst.marked).not.toContain(c.id);
    expect(b.hp).toBe(PLAYER.maxHp - PAINT.damage);
    expect(c.hp).toBe(PLAYER.maxHp);
    // same damage path as shots: a hit message from the thrower
    expect(msgs.some(x => x.t === 'hit' && x.from === a.id && x.to === b.id)).toBe(true);
    expect(g.nades.flying.length).toBe(0);
  });

  it('bursts on the third bounce before the fuse', () => {
    const { g, a } = arena();
    a.p = [-20, 0, -20];
    g.handle(a.id, { t: 'throw', kind: 'paint', o: [-20, PLAYER.eyeHeight, -20], d: [0, -1, 0], power: 1 }, 1000);
    // straight down hard: bounces quickly
    const { t } = runUntil(g, 1050, m => m.some(x => x.t === 'burst'));
    expect(t - 1000).toBeLessThan(PAINT.fuseMs);
  });

  it('teammates are immune in team mode; the thrower is not immune in FFA', () => {
    const tdm = arena(1000, 'tdm');
    const mate = [tdm.b, tdm.c].find(p => p.team === tdm.a.team)!;
    tdm.a.p = [-30, 0, 0]; mate.p = [-29, 0, 1];
    const other = [tdm.b, tdm.c].find(p => p !== mate)!; other.p = [30, 0, 30];
    expect(tdm.g.nades.marks(tdm.g, tdm.a.id, [-30, 0.12, 0])).toEqual([]);
    const ffa = arena();
    ffa.a.p = [-30, 0, 0];
    expect(ffa.g.nades.marks(ffa.g, ffa.a.id, [-30, 0.12, 1])).toContain(ffa.a.id);
  });
});

describe('smoke grenade', () => {
  it('lands, makes a smoke sphere that blocks shots through it and not around it, then clears', () => {
    const { g, a, b } = arena();
    g.handle(a.id, { t: 'throw', kind: 'smoke', o: eyeOf(a), d: [0, -1, 0], power: 0 }, 1000);
    const pr = g.nades.flying[0];
    pr.p = [0, 1.6, -10]; pr.v = [0, 0, 0]; // drop it at a known spot
    a.p = [-10, 0, -10]; b.p = [10, 0, -10];
    const { t, msgs } = runUntil(g, 1050, m => m.some(x => x.t === 'smoke'));
    const sm = msgs.find(x => x.t === 'smoke') as Extract<ServerMsg, { t: 'smoke' }>;
    expect(sm.until).toBe(t + SMOKE.durationMs);
    expect(g.smokes.length).toBe(1);
    // through the cloud: rejected
    const shoot = (to: Vec3, now: number) => g.handle(a.id, { t: 'shoot', w: 'rifle', o: eyeOf(a), d: [1, 0, 0], hits: [{ id: b.id, part: 'body', point: to }] }, now);
    let out = shoot([b.p[0], 0.9, b.p[2]], t + 100);
    expect(types(out)).toEqual(['shot']);
    expect(b.hp).toBe(PLAYER.maxHp);
    // walk b out of line so the shot goes around the cloud: accepted
    b.p = [10, 0, 6];
    a.p = [-10, 0, 6];
    out = shoot([b.p[0], 0.9, b.p[2]], t + 300);
    expect(types(out)).toEqual(['shot', 'hit']);
    // bots cannot see through it either
    expect(g.smokeBlocks([-10, 1.6, -10], [10, 1.6, -10])).toBe(true);
    // after 12 s it is gone
    g.tick(t + SMOKE.durationMs + 1);
    expect(g.smokes.length).toBe(0);
    expect(g.smokeBlocks([-10, 1.6, -10], [10, 1.6, -10])).toBe(false);
  });
});

describe('carrying', () => {
  it('cannot throw more than you carry, and respawn refills', () => {
    const { g, a } = arena();
    const o = eyeOf(a);
    const thr = (kind: 'paint' | 'smoke', now: number) => g.handle(a.id, { t: 'throw', kind, o, d: [0, 0, -1], power: 1 }, now);
    expect(types(thr('paint', 1000))).toEqual(['proj']);
    expect(thr('paint', 1100)).toEqual([]);
    expect(types(thr('smoke', 1200))).toEqual(['proj']);
    expect(thr('smoke', 1300)).toEqual([]);
    expect(g.nades.left(a.id)).toEqual({ paint: 0, smoke: 0 });
    // die and respawn
    a.hp = 0; a.diedAt = 2000;
    g.handle(a.id, { t: 'respawn' }, 2000 + PLAYER.respawnMs);
    expect(a.hp).toBe(PLAYER.maxHp);
    expect(g.nades.left(a.id)).toEqual({ paint: 1, smoke: 1 });
    expect(types(g.handle(a.id, { t: 'throw', kind: 'paint', o: eyeOf(a), d: [0, 0, -1], power: 1 }, 6000))).toEqual(['proj']);
  });

  it('rejects throws from far away or while marked', () => {
    const { g, a } = arena();
    expect(g.handle(a.id, { t: 'throw', kind: 'paint', o: [a.p[0] + 10, 1.6, a.p[2]], d: [0, 0, -1], power: 1 }, 1000)).toEqual([]);
    a.hp = 0;
    expect(g.handle(a.id, { t: 'throw', kind: 'paint', o: eyeOf(a), d: [0, 0, -1], power: 1 }, 1000)).toEqual([]);
  });
});
