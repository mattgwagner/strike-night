import { describe, expect, it } from 'vitest';
import { ARCADE, type MapBox } from '../src/shared/map';
import { PLAYER } from '../src/shared/constants';
import { bulletBoxes, canStand, hasLos, solidBoxes } from '../src/shared/physics';
import type { Vec3 } from '../src/shared/protocol';

const map = ARCADE;
const H = map.half;
const solids = solidBoxes(map.boxes);
const bullets = bulletBoxes(map.boxes);
const STEP_UP = 0.55;
const DROP = 3;
const MID: Vec3 = [0, 2, 0];

const contains = (b: MapBox, x: number, z: number) => x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2];

/** Standable heights in the 1 m cell centred on (x, z): tops of solids under the centre with room for a player. */
function floorsAt(x: number, z: number): number[] {
  const ys = new Set<number>();
  for (const b of solids) if (contains(b, x, z)) ys.add(+b.max[1].toFixed(3));
  return [...ys].filter(y => canStand([x, y, z], solids));
}

type Node = { x: number; z: number; y: number };
const key = (n: Node) => `${n.x},${n.z},${n.y}`;

function buildGraph() {
  const nodes = new Map<string, Node>();
  for (let x = -H + 0.5; x < H; x++) for (let z = -H + 0.5; z < H; z++) for (const y of floorsAt(x, z)) { const n = { x, z, y }; nodes.set(key(n), n); }
  const byCell = new Map<string, Node[]>();
  for (const n of nodes.values()) { const k = `${n.x},${n.z}`; if (!byCell.has(k)) byCell.set(k, []); byCell.get(k)!.push(n); }
  const neighbours = (n: Node): Node[] => {
    const out: Node[] = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const m of byCell.get(`${n.x + dx},${n.z + dz}`) ?? []) {
        const dy = m.y - n.y;
        if (dy > STEP_UP || dy < -DROP) continue;
        // the swept body between the two cells must be clear too (thin walls)
        const mid: Vec3 = [(n.x + m.x) / 2, Math.max(n.y, m.y) + 0.002, (n.z + m.z) / 2];
        if (!canStand(mid, solids)) continue;
        out.push(m);
      }
    }
    return out;
  };
  return { nodes, byCell, neighbours };
}

const graph = buildGraph();
const cellOf = (v: number) => Math.floor(v) + 0.5;
function nodeAt(p: Vec3): Node | undefined {
  return (graph.byCell.get(`${cellOf(p[0])},${cellOf(p[2])}`) ?? []).find(n => Math.abs(n.y - p[1]) < 0.05);
}
function flood(from: Node): Set<string> {
  const seen = new Set([key(from)]);
  const queue = [from];
  while (queue.length) {
    const n = queue.pop()!;
    for (const m of graph.neighbours(n)) if (!seen.has(key(m))) { seen.add(key(m)); queue.push(m); }
  }
  return seen;
}

describe('map: The Arcade', () => {
  it('has 12 spawns, six per side, each facing the centre', () => {
    expect(map.spawns).toHaveLength(12);
    expect(map.spawns.filter(s => s.team === 0 && s.p[0] < 0)).toHaveLength(6);
    expect(map.spawns.filter(s => s.team === 1 && s.p[0] > 0)).toHaveLength(6);
    for (const s of map.spawns) {
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      const tx = -s.p[0], tz = -s.p[2], l = Math.hypot(tx, tz);
      expect(fx * tx / l + fz * tz / l).toBeGreaterThan(0.99);
    }
  });

  it('no spawn overlaps a solid box and every spawn has floor directly under it', () => {
    for (const s of map.spawns) {
      expect(canStand(s.p, solids), `spawn ${s.p} is inside a box`).toBe(true);
      const under = solids.some(b => contains(b, s.p[0], s.p[2]) && Math.abs(b.max[1] - s.p[1]) < 1e-3);
      expect(under, `spawn ${s.p} has no floor`).toBe(true);
    }
  });

  it('every box is inside the outer walls', () => {
    for (const b of map.boxes) {
      if (b.tag === 'outer-wall') continue;
      expect(b.min[0], JSON.stringify(b)).toBeGreaterThanOrEqual(-H);
      expect(b.min[2], JSON.stringify(b)).toBeGreaterThanOrEqual(-H);
      expect(b.max[0], JSON.stringify(b)).toBeLessThanOrEqual(H);
      expect(b.max[2], JSON.stringify(b)).toBeLessThanOrEqual(H);
      for (let i = 0; i < 3; i++) expect(b.max[i]).toBeGreaterThan(b.min[i]);
    }
  });

  it('all spawns are mutually reachable on foot', () => {
    const start = nodeAt(map.spawns[0].p)!;
    expect(start).toBeDefined();
    const reach = flood(start);
    for (const s of map.spawns) {
      const n = nodeAt(s.p);
      expect(n, `spawn ${s.p} is not on the walk grid`).toBeDefined();
      expect(reach.has(key(n!)), `spawn ${s.p} unreachable`).toBe(true);
    }
    // and it really is a two-way graph: walk back from the last spawn
    const back = flood(nodeAt(map.spawns[11].p)!);
    expect(back.has(key(start))).toBe(true);
  });

  it('every themed area can be walked to (and back out of)', () => {
    const reach = flood(nodeAt(map.spawns[0].p)!);
    const places: Array<[string, Vec3]> = [
      ['mid platform', [0, 1, 0]],
      ['pit floor', [-17, -1.2, -15]],
      ['bleacher top', [18.5, 2, -27]],
      ['stage', [-24.5, 0.5, 19]],
      ['security office', [-12.5, 0, 22.5]],
      ['back corridor', [-20, 0, 26.5]],
      ['trailer', [17.5, 0.5, 18]],
      ['loading dock', [20.5, 1, 26]],
      ['catwalk', [18, 2.5, 12.5]],
      ['batting cage', [24.5, 0, -20]],
    ];
    for (const [name, p] of places) {
      const n = nodeAt(p);
      expect(n, `${name} not standable`).toBeDefined();
      expect(reach.has(key(n!)), `${name} unreachable`).toBe(true);
      expect(flood(n!).has(key(nodeAt(map.spawns[0].p)!)), `${name} is a trap`).toBe(true);
    }
  });

  it('no spawn can see the centre of mid', () => {
    const seen = map.spawns.filter(s => hasLos([s.p[0], s.p[1] + PLAYER.eyeHeight, s.p[2]], MID, bullets)).map(s => s.p.join(','));
    expect(seen, 'spawns that can see mid').toEqual([]);
  });

  it('stays within the light budget', () => {
    expect(map.lights.length).toBeLessThanOrEqual(14);
    for (const l of map.lights) { expect(l.intensity).toBeGreaterThanOrEqual(300); expect(l.intensity).toBeLessThanOrEqual(800); }
  });
});
