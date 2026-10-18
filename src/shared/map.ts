// Map data. Everything is an axis-aligned box so the same file drives
// rendering (client), collision (client + server) and bot navigation (server).
// Ramps and stairs are stacks of thin boxes. Units are metres, +Y is up.
import type { Vec3 } from './protocol';

export type Zone = 'arena' | 'ballpark' | 'pizzeria' | 'mid' | 'outer';

export interface MapBox {
  min: Vec3;
  max: Vec3;
  /** Rendering hint. The world builder maps these to materials. */
  mat?: string;
  /** Hex colour override for the material. */
  color?: string;
  zone?: Zone;
  /** Visual-only (lights, signs, decals): never collides or blocks shots. */
  nocollide?: boolean;
  /** Blocks movement but not bullets (e.g. chain-link fence, glass). */
  shootThrough?: boolean;
  /** Free-form tag for the builder (e.g. 'crate', 'stage', 'pit'). */
  tag?: string;
}

export interface SpawnPoint { p: Vec3; yaw: number; team?: 0 | 1 }

export interface PointLight { p: Vec3; color: string; intensity: number; distance: number; flicker?: boolean }

export interface MapData {
  id: string;
  name: string;
  /** Half extent of the playable square, for the sky dome and bot bounds. */
  half: number;
  boxes: MapBox[];
  spawns: SpawnPoint[];
  lights: PointLight[];
  /** Ambient colour + sky hint for the renderer. */
  sky: { top: string; bottom: string; ambient: string; fog: number };
}

export function box(min: Vec3, max: Vec3, extra: Omit<MapBox, 'min' | 'max'> = {}): MapBox {
  return { min, max, ...extra };
}

/** Convenience: a box from centre-x/z, floor y, size and height. */
export function block(cx: number, floorY: number, cz: number, sx: number, h: number, sz: number, extra: Omit<MapBox, 'min' | 'max'> = {}): MapBox {
  return box([cx - sx / 2, floorY, cz - sz / 2], [cx + sx / 2, floorY + h, cz + sz / 2], extra);
}

// ---------------------------------------------------------------------------
// The Arcade: a 56m square with three themed quarters around a central mid.
// This is the BLOCKOUT. The world workstream replaces the interior with real
// zones but keeps the format, the spawn count and the outer walls.
// ---------------------------------------------------------------------------
const H = 28;
const WALL = 6;

const boxes: MapBox[] = [
  block(0, -1, 0, 2 * H, 1, 2 * H, { mat: 'floor', zone: 'outer' }),
  // outer walls
  box([-H - 1, 0, -H - 1], [H + 1, WALL, -H], { mat: 'wall', zone: 'outer' }),
  box([-H - 1, 0, H], [H + 1, WALL, H + 1], { mat: 'wall', zone: 'outer' }),
  box([-H - 1, 0, -H], [-H, WALL, H], { mat: 'wall', zone: 'outer' }),
  box([H, 0, -H], [H + 1, WALL, H], { mat: 'wall', zone: 'outer' }),
  // mid platform with ramps (stair steps)
  block(0, 0, 0, 10, 1, 10, { mat: 'concrete', zone: 'mid', tag: 'mid-platform' }),
  ...stairs([-5, 0, -2], 'x-', 4, 1, 4),
  ...stairs([5, 0, -2], 'x+', 4, 1, 4),
  // four cover walls around mid
  block(0, 0, -12, 8, 2.2, 0.6, { mat: 'metal', zone: 'mid' }),
  block(0, 0, 12, 8, 2.2, 0.6, { mat: 'metal', zone: 'mid' }),
  block(-12, 0, 0, 0.6, 2.2, 8, { mat: 'metal', zone: 'mid' }),
  block(12, 0, 0, 0.6, 2.2, 8, { mat: 'metal', zone: 'mid' }),
  // arena quarter (NW): crates + a pit wall
  block(-18, 0, -18, 6, 3, 6, { mat: 'crate', zone: 'arena', tag: 'crate' }),
  block(-12, 0, -22, 2, 1.2, 2, { mat: 'crate', zone: 'arena', tag: 'crate' }),
  block(-22, 0, -11, 2, 1.2, 2, { mat: 'crate', zone: 'arena', tag: 'crate' }),
  block(-14, 0, -14, 0.5, 2.5, 8, { mat: 'metal', zone: 'arena' }),
  // ballpark quarter (NE): dugout + bleacher steps
  block(18, 0, -18, 10, 2.6, 0.6, { mat: 'wood', zone: 'ballpark', tag: 'dugout' }),
  ...stairs([22, 0, -8], 'z-', 3, 1.5, 8),
  block(12, 0, -22, 1.2, 1.2, 1.2, { mat: 'crate', zone: 'ballpark' }),
  // pizzeria quarter (SW): stage + tables
  block(-18, 0, 18, 10, 1, 6, { mat: 'stage', zone: 'pizzeria', tag: 'stage' }),
  block(-18, 1, 21, 10, 4, 0.6, { mat: 'curtain', zone: 'pizzeria' }),
  block(-10, 0, 12, 2, 1, 2, { mat: 'wood', zone: 'pizzeria', tag: 'table' }),
  block(-22, 0, 10, 2, 1, 2, { mat: 'wood', zone: 'pizzeria', tag: 'table' }),
  // SE quarter: corridor walls
  block(18, 0, 14, 0.6, 3, 12, { mat: 'wall', zone: 'outer' }),
  block(14, 0, 22, 10, 3, 0.6, { mat: 'wall', zone: 'outer' }),
  block(22, 0, 12, 3, 1.5, 3, { mat: 'crate', zone: 'outer' }),
];

/**
 * Stairs that DESCEND from `start` (the top edge, flush with the platform)
 * in direction `dir`. The first step is the tallest.
 */
export function stairs(start: Vec3, dir: 'x+' | 'x-' | 'z+' | 'z-', steps: number, rise: number, width: number, mat = 'concrete'): MapBox[] {
  const out: MapBox[] = [];
  const run = 1.0;
  for (let i = 0; i < steps; i++) {
    const h = (rise / steps) * (steps - i);
    const [x, y, z] = start;
    let min: Vec3, max: Vec3;
    if (dir === 'x+') { min = [x + i * run, y, z - width / 2]; max = [x + (i + 1) * run, y + h, z + width / 2]; }
    else if (dir === 'x-') { min = [x - (i + 1) * run, y, z - width / 2]; max = [x - i * run, y + h, z + width / 2]; }
    else if (dir === 'z+') { min = [x - width / 2, y, z + i * run]; max = [x + width / 2, y + h, z + (i + 1) * run]; }
    else { min = [x - width / 2, y, z - (i + 1) * run]; max = [x + width / 2, y + h, z - i * run]; }
    out.push({ min, max, mat, tag: 'stair' });
  }
  return out;
}

export const ARCADE: MapData = {
  id: 'arcade',
  name: 'The Arcade',
  half: H,
  boxes,
  spawns: [
    { p: [-22, 0, -22], yaw: Math.PI * 0.25 },
    { p: [22, 0, -22], yaw: Math.PI * 0.75 },
    { p: [-22, 0, 22], yaw: -Math.PI * 0.25 },
    { p: [22, 0, 22], yaw: -Math.PI * 0.75 },
    { p: [0, 0, -24], yaw: 0 },
    { p: [0, 0, 24], yaw: Math.PI },
    { p: [-24, 0, 0], yaw: Math.PI / 2 },
    { p: [24, 0, 0], yaw: -Math.PI / 2 },
    { p: [-16, 0, -5], yaw: Math.PI * 0.5 },
    { p: [16, 0, 5], yaw: -Math.PI * 0.5 },
  ],
  lights: [
    { p: [0, 6, 0], color: '#ffffff', intensity: 600, distance: 50 },
    { p: [-18, 5, -18], color: '#ff6a00', intensity: 350, distance: 36 },
    { p: [18, 5, -18], color: '#9ad0ff', intensity: 350, distance: 36 },
    { p: [-18, 4, 18], color: '#ff2a2a', intensity: 300, distance: 30, flicker: true },
    { p: [18, 5, 18], color: '#ffd37a', intensity: 300, distance: 34 },
  ],
  sky: { top: '#0b0f2a', bottom: '#1b2550', ambient: '#5a5f7a', fog: 90 },
};

export const MAPS: Record<string, MapData> = { arcade: ARCADE };
