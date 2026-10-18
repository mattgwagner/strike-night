// Map data. Everything is an axis-aligned box so the same file drives
// rendering (client), collision (client + server) and bot navigation (server).
// Ramps and stairs are stacks of thin boxes. Units are metres, +Y is up,
// -Z is north (yaw 0 looks north).
import type { Vec3 } from './protocol';

export type Zone = 'arena' | 'ballpark' | 'pizzeria' | 'dock' | 'mid' | 'outer';

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
  /** Sub-type for tagged props (e.g. which animatronic, which way a sign faces). */
  variant?: string;
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

/** Tag every box in a list with a zone (and optionally a material). */
function zoned(zone: Zone, list: MapBox[], mat?: string): MapBox[] {
  for (const b of list) { b.zone = zone; if (mat) b.mat = mat; }
  return list;
}

/** Yaw that faces the map centre from (x, z). */
function face(x: number, z: number): number { return Math.atan2(x, z); }

// ---------------------------------------------------------------------------
// The Arcade: a 56 m square. Raised mid with a marquee, four themed quarters:
//   NW The Pit (robot arena)    NE The Yard (ballpark)
//   SW Freddy's (pizzeria)      SE Loading Dock
// Four "arms" (lanes) run from mid to the outer walls between the quarters.
// The strip along z = 0 from the west wall to x = -14 stays open floor: the
// physics/game tests and e2e/two.mjs fight along it.
// ---------------------------------------------------------------------------
const H = 28;
const WALL = 6;

// The sunken robot-arena floor (NW). A hole in the main floor.
const PIT = { x0: -25, x1: -11, z0: -20, z1: -10, y: -1.2 };

const floor: MapBox[] = [
  box([-H, -2.5, -H], [H, 0, PIT.z0], { mat: 'floor', zone: 'outer' }),
  box([-H, -2.5, PIT.z1], [H, 0, H], { mat: 'floor', zone: 'outer' }),
  box([-H, -2.5, PIT.z0], [PIT.x0, 0, PIT.z1], { mat: 'floor', zone: 'outer' }),
  box([PIT.x1, -2.5, PIT.z0], [H, 0, PIT.z1], { mat: 'floor', zone: 'outer' }),
  box([PIT.x0, -2.5, PIT.z0], [PIT.x1, PIT.y, PIT.z1], { mat: 'plate', zone: 'arena', tag: 'pit-floor' }),
  // outer walls
  box([-H - 1, -2.5, -H - 1], [H + 1, WALL, -H], { mat: 'wall', zone: 'outer', tag: 'outer-wall' }),
  box([-H - 1, -2.5, H], [H + 1, WALL, H + 1], { mat: 'wall', zone: 'outer', tag: 'outer-wall' }),
  box([-H - 1, -2.5, -H], [-H, WALL, H], { mat: 'wall', zone: 'outer', tag: 'outer-wall' }),
  box([H, -2.5, -H], [H + 1, WALL, H], { mat: 'wall', zone: 'outer', tag: 'outer-wall' }),
];

// --- MID ---------------------------------------------------------------------
const mid: MapBox[] = zoned('mid', [
  block(0, 0, 0, 10, 1, 10, { mat: 'concrete', tag: 'mid-platform' }),
  ...stairs([-5, 0, -2], 'x-', 4, 1, 4),
  ...stairs([5, 0, 2], 'x+', 4, 1, 4),
  ...stairs([2.5, 0, -5], 'z-', 4, 1, 4),
  ...stairs([-2.5, 0, 5], 'z+', 4, 1, 4),
  // marquee pillars at the platform corners (cover on top of mid)
  ...[[-4.4, -4.4], [4.4, -4.4], [-4.4, 4.4], [4.4, 4.4]].map(([x, z]) => block(x, 1, z, 0.6, 5.6, 0.6, { mat: 'metal', tag: 'pillar' })),
  block(0, 5.4, 0, 9.4, 1.4, 9.4, { mat: 'neon', nocollide: true, tag: 'marquee' }),
  // neon trim around the platform lip
  box([-5.06, 0.86, -5.06], [5.06, 0.94, -4.94], { mat: 'neon', nocollide: true }),
  box([-5.06, 0.86, 4.94], [5.06, 0.94, 5.06], { mat: 'neon', nocollide: true }),
  box([-5.06, 0.86, -5.06], [-4.94, 0.94, 5.06], { mat: 'neon', nocollide: true }),
  box([4.94, 0.86, -5.06], [5.06, 0.94, 5.06], { mat: 'neon', nocollide: true }),
  // cover walls where the four arms meet mid
  block(0, 0, -12, 8, 2.2, 0.6, { mat: 'metal' }),
  block(0, 0, 12, 8, 2.2, 0.6, { mat: 'metal' }),
  block(-12, 0, 0, 0.6, 2.2, 8, { mat: 'metal' }),
  block(12, 0, 0, 0.6, 2.2, 8, { mat: 'metal' }),
  // low barriers in the mid corners
  block(-7.5, 0, -7.5, 2.2, 1.1, 0.6, { mat: 'hazard' }),
  block(7.5, 0, 7.5, 2.2, 1.1, 0.6, { mat: 'hazard' }),
  block(7.5, 0, -7.5, 0.6, 1.1, 2.2, { mat: 'hazard' }),
  block(-7.5, 0, 7.5, 0.6, 1.1, 2.2, { mat: 'hazard' }),
]);

// --- ARMS (lanes between quarters) -------------------------------------------
const arms: MapBox[] = zoned('outer', [
  // north arm (Pit <-> Yard)
  block(-5, 0, -18, 1.6, 1.3, 1.6, { mat: 'crate', tag: 'crate' }),
  block(5.5, 0, -21, 2, 2.4, 2, { mat: 'crate', tag: 'crate' }),
  block(5.5, 2.4, -21, 1, 1, 1, { mat: 'crate', tag: 'crate', nocollide: true }),
  block(-1, 0, -25, 3.5, 1.1, 1, { mat: 'hazard' }),
  // south arm (Freddy's <-> Dock)
  block(5, 0, 18, 1.6, 1.3, 1.6, { mat: 'crate', tag: 'crate' }),
  block(-5.5, 0, 21, 2, 2.4, 2, { mat: 'crate', tag: 'crate' }),
  block(1, 0, 25, 3.5, 1.1, 1, { mat: 'hazard' }),
  // west arm (Pit <-> Freddy's); z in [-1.5, 1.5] stays clear
  block(-20, 0, -6, 2, 1.3, 1.6, { mat: 'crate', tag: 'crate' }),
  block(-24, 0, 6.5, 2.2, 2.4, 2.2, { mat: 'crate', tag: 'crate' }),
  block(-17, 0, 6, 1.4, 1.1, 1.4, { mat: 'crate', tag: 'crate' }),
  // east arm (Yard <-> Dock)
  block(20, 0, 6, 2, 1.3, 1.6, { mat: 'crate', tag: 'crate' }),
  block(24, 0, -6.5, 2.2, 2.4, 2.2, { mat: 'crate', tag: 'crate' }),
  block(17, 0, -5.5, 1.4, 1.1, 1.4, { mat: 'crate', tag: 'crate' }),
  block(23.5, 0, 1.5, 3, 1.1, 1, { mat: 'hazard' }),
]);

// Corner towers where each quarter meets mid: landmarks, and they keep the
// quarter interiors out of sight of mid.
const towers: MapBox[] = [
  block(-9.5, 0, -9.5, 3, 6, 3, { mat: 'arenawall', zone: 'arena', tag: 'tower' }),
  block(9.5, 0, -9.5, 3, 5, 3, { mat: 'pressbox', zone: 'ballpark', tag: 'tower' }),
  block(-9.5, 0, 9.5, 3, 5.5, 3, { mat: 'pizzawall', zone: 'pizzeria', tag: 'tower' }),
  block(9.5, 0, 9.5, 3, 5, 3, { mat: 'wall', zone: 'dock', tag: 'tower' }),
];

// --- NW: THE PIT ---------------------------------------------------------------
function lexan(x0: number, z0: number, x1: number, z1: number): MapBox[] {
  return [
    box([x0, 0, z0], [x1, 0.3, z1], { mat: 'hazard' }),
    box([x0, 0.3, z0], [x1, 1.6, z1], { mat: 'glass', shootThrough: true }),
    box([x0, 1.6, z0], [x1, 1.7, z1], { mat: 'metal' }),
  ];
}
const pit: MapBox[] = zoned('arena', [
  // lexan rim (gaps where the stairs come up)
  ...lexan(-25.3, -20.3, -17, -20),
  ...lexan(-13, -20.3, -10.7, -20),
  ...lexan(-25.3, -10, -22, -9.7),
  ...lexan(-18, -10, -10.7, -9.7),
  ...lexan(-25.3, -20, -25, -10),
  ...lexan(-11, -20, -10.7, -16),
  ...lexan(-11, -12, -10.7, -10),
  // stairs down into the pit
  ...stairs([-15, PIT.y, -20], 'z+', 3, 1.2, 4, 'plate'),
  ...stairs([-11, PIT.y, -14], 'x-', 3, 1.2, 4, 'plate'),
  ...stairs([-20, PIT.y, -10], 'z-', 3, 1.2, 4, 'plate'),
  // octagon chamfers in the corners
  box([-25, PIT.y, -20], [-23.5, 0, -18.5], { mat: 'hazard' }),
  box([-25, PIT.y, -11.5], [-23.5, 0, -10], { mat: 'hazard' }),
  box([-12.5, PIT.y, -11.5], [-11, 0, -10], { mat: 'hazard' }),
  // pulverizer hammers (base is solid, the arm animates)
  block(-24.4, PIT.y, -15, 1.2, 1.6, 1.6, { mat: 'metal', tag: 'hammer', variant: 'x+' }),
  block(-18.5, PIT.y, -19.4, 1.6, 1.6, 1.2, { mat: 'metal', tag: 'hammer', variant: 'z+' }),
  // spinner hazards (low, the blade spins over them)
  block(-21, PIT.y, -12.5, 1.4, 0.45, 1.4, { mat: 'hazard', tag: 'spinner' }),
  block(-12.2, PIT.y, -18.8, 1.4, 0.45, 1.4, { mat: 'hazard', tag: 'spinner' }),
  // wrecked bots as cover on the arena floor
  block(-19.5, PIT.y, -15.5, 1.8, 1.1, 1.3, { mat: 'metal', tag: 'wreck', color: '#5a5f6e' }),
  block(-15, PIT.y, -12.5, 1.3, 1.1, 1.8, { mat: 'metal', tag: 'wreck', color: '#6e4a3a' }),
  // concourse: scoring-screen wall, tool carts, team tables
  block(-17.5, 0, -27.6, 13, 5, 0.6, { mat: 'arenawall' }),
  box([-23.8, 1.4, -27.32], [-11.2, 4.6, -27.28], { mat: 'screen', nocollide: true, tag: 'scorescreen' }),
  block(-12.5, 0, -24.5, 2.4, 1.1, 1.2, { mat: 'metal', tag: 'cart', color: '#c0392b' }),
  block(-26.4, 0, -22.5, 1.2, 1.1, 2.4, { mat: 'metal', tag: 'cart', color: '#c0392b' }),
  block(-20, 0, -25.5, 1.4, 1.4, 1.4, { mat: 'crate', tag: 'crate' }),
  // a solid control booth by the south rim breaks the long sightline to mid
  block(-15, 0, -8.5, 3, 3, 1.4, { mat: 'arenawall', tag: 'booth' }),
  box([-16.3, 1.4, -9.25], [-13.7, 2.4, -9.19], { mat: 'screen', nocollide: true }),
]);

// --- NE: THE YARD --------------------------------------------------------------
const yard: MapBox[] = zoned('ballpark', [
  // turf, infield dirt, bases (decals)
  box([10, 0, -H], [H, 0.02, -10], { mat: 'turf', nocollide: true }),
  box([13, 0.02, -22], [22, 0.04, -13], { mat: 'dirt', nocollide: true }),
  ...[[21, -14], [21, -21], [14, -21]].map(([x, z]) => block(x, 0.04, z, 0.45, 0.06, 0.45, { mat: 'chalk', nocollide: true })),
  block(14, 0.04, -14, 0.5, 0.05, 0.5, { mat: 'chalk', nocollide: true, tag: 'home' }),
  // foul lines
  box([14.3, 0.04, -14.05], [27.4, 0.05, -13.95], { mat: 'chalk', nocollide: true }),
  box([13.95, 0.04, -27.4], [14.05, 0.05, -14.3], { mat: 'chalk', nocollide: true }),
  // pitcher's mound
  block(17.5, 0, -17.5, 2.4, 0.25, 2.4, { mat: 'dirt', tag: 'mound' }),
  // dugouts
  block(19, 0, -10.6, 7, 2.4, 0.3, { mat: 'wood', tag: 'dugout' }),
  block(19, 2.4, -11.5, 7.2, 0.2, 2.2, { mat: 'metal', tag: 'roof' }),
  block(19, 0, -11.1, 6, 0.45, 0.5, { mat: 'wood', tag: 'bench' }),
  block(10.6, 0, -18.5, 0.3, 2.4, 7, { mat: 'wood', tag: 'dugout' }),
  block(11.5, 2.4, -18.5, 2.2, 0.2, 7.2, { mat: 'metal', tag: 'roof' }),
  block(11.1, 0, -18.5, 0.5, 0.45, 6, { mat: 'wood', tag: 'bench' }),
  // batting cage (walk through it, shoot through the netting)
  box([23, 0, -26], [23.1, 3, -16], { mat: 'chainlink', shootThrough: true }),
  box([25.9, 0, -26], [26, 3, -16], { mat: 'chainlink', shootThrough: true }),
  box([23, 3, -26], [26, 3.05, -16], { mat: 'chainlink', nocollide: true }),
  block(24.5, 0, -24.8, 0.8, 1.2, 0.8, { mat: 'metal', tag: 'pitching-machine', color: '#2c6e3f' }),
  // bleachers along the north wall (the whole face is a staircase)
  block(18.5, 0, -27, 7, 2, 2, { mat: 'bleacher' }),
  ...stairs([18.5, 0, -26], 'z+', 4, 2, 7, 'bleacher'),
  // foul poles + scoreboard
  block(14, 0, -27.4, 0.3, 9, 0.3, { mat: 'foulpole', tag: 'foulpole' }),
  block(27.4, 0, -14, 0.3, 9, 0.3, { mat: 'foulpole', tag: 'foulpole' }),
  box([27.7, 2.4, -26], [27.98, 6.5, -17], { mat: 'scoreboard', nocollide: true, tag: 'scoreboard' }),
  // floodlight poles
  block(11, 0, -27, 0.3, 8, 0.3, { mat: 'metal', nocollide: true }),
  block(11, 8, -27, 2, 1, 0.5, { mat: 'lamp', nocollide: true }),
  block(27, 0, -11, 0.3, 8, 0.3, { mat: 'metal', nocollide: true }),
  block(27, 8, -11, 0.5, 1, 2, { mat: 'lamp', nocollide: true }),
  // cover on the field
  block(25, 0, -12.6, 3, 0.95, 1.1, { mat: 'tarp', tag: 'tarp' }),
  block(13, 0, -25.5, 1.5, 1.5, 1.5, { mat: 'crate', tag: 'crate' }),
  block(20.5, 0, -17.5, 1, 0.9, 1, { mat: 'metal', tag: 'ballcart', color: '#d0d4dc' }),
  block(16, 0, -22.5, 2.4, 1.1, 0.8, { mat: 'wood', tag: 'bench' }),
]);

// --- SW: FREDDY'S --------------------------------------------------------------
const PW = 3.5; // pizzeria wall height
const pizza: MapBox[] = zoned('pizzeria', [
  box([-H, 0, 10.3], [-10.3, 0.02, 24.7], { mat: 'tile', nocollide: true }),
  // north wall with two doors
  box([-H, 0, 10], [-26, PW, 10.3], { mat: 'pizzawall' }),
  box([-23, 0, 10], [-17, PW, 10.3], { mat: 'pizzawall' }),
  box([-14, 0, 10], [-11, PW, 10.3], { mat: 'pizzawall' }),
  box([-26, 2.6, 10], [-23, PW, 10.3], { mat: 'pizzawall' }),
  box([-17, 2.6, 10], [-14, PW, 10.3], { mat: 'pizzawall' }),
  // east wall with a door
  box([-10.3, 0, 11], [-10, PW, 13], { mat: 'pizzawall' }),
  box([-10.3, 0, 16], [-10, PW, 21.5], { mat: 'pizzawall' }),
  box([-10.3, 2.6, 13], [-10, PW, 16], { mat: 'pizzawall' }),
  // stage, curtains, the band
  block(-25.5, 0, 19, 5, 0.5, 9, { mat: 'stage', tag: 'stage' }),
  box([-27.95, 0.5, 14.5], [-27.7, 4.2, 23.5], { mat: 'curtain', nocollide: true }),
  box([-28, 3.6, 14.5], [-23, 4.2, 14.8], { mat: 'curtain', nocollide: true }),
  box([-28, 3.6, 23.2], [-23, 4.2, 23.5], { mat: 'curtain', nocollide: true }),
  box([-28, 0.5, 14.5], [-26.6, 3.6, 14.8], { mat: 'curtain' }),
  box([-28, 0.5, 23.2], [-26.6, 3.6, 23.5], { mat: 'curtain' }),
  block(-26.6, 0.5, 16.6, 0.9, 2.1, 0.9, { tag: 'animatronic', variant: 'bunny' }),
  block(-26.4, 0.5, 19, 0.9, 2.1, 0.9, { tag: 'animatronic', variant: 'bear' }),
  block(-26.6, 0.5, 21.4, 0.9, 2.1, 0.9, { tag: 'animatronic', variant: 'chicken' }),
  // party tables + chairs
  ...[[-19, 13.8], [-19, 18.6], [-14.2, 16.2]].flatMap(([x, z]) => [
    block(x, 0, z, 2.6, 0.8, 1.2, { mat: 'table', tag: 'table' }),
    block(x - 0.8, 0, z - 1.0, 0.45, 0.45, 0.45, { mat: 'chair' }),
    block(x + 0.8, 0, z - 1.0, 0.45, 0.45, 0.45, { mat: 'chair' }),
    block(x - 0.8, 0, z + 1.0, 0.45, 0.45, 0.45, { mat: 'chair' }),
    block(x + 0.8, 0, z + 1.0, 0.45, 0.45, 0.45, { mat: 'chair' }),
    block(x, 0.8, z, 0.5, 0.04, 0.5, { mat: 'pizza', nocollide: true }),
  ]),
  // arcade cabinets along the north wall, screens face south
  ...[-22.3, -21.3, -20.3, -18.3].flatMap(x => [
    block(x, 0, 10.75, 0.8, 1.9, 0.8, { mat: 'cabinet', tag: 'cabinet' }),
    box([x - 0.3, 1.1, 11.15], [x + 0.3, 1.55, 11.18], { mat: 'screen', nocollide: true }),
    box([x - 0.38, 1.75, 11.15], [x + 0.38, 1.88, 11.18], { mat: 'neon', nocollide: true, color: '#33e0ff' }),
  ]),
  block(-11.2, 0, 19, 0.8, 1.9, 0.8, { mat: 'cabinet', tag: 'cabinet' }),
  box([-11.63, 1.1, 18.7], [-11.6, 1.55, 19.3], { mat: 'screen', nocollide: true }),
  // back corridor (dark) with the security office window
  box([-26, 0, 24.7], [-20, PW, 25], { mat: 'pizzawall' }),
  box([-18, 0, 24.7], [-15, PW, 25], { mat: 'pizzawall' }),
  box([-15, 0, 24.7], [-10.3, 1, 25], { mat: 'pizzawall' }),
  box([-15, 1, 24.7], [-10.3, 2.2, 25], { mat: 'glass', shootThrough: true, tag: 'office-window' }),
  box([-15, 2.2, 24.7], [-10.3, PW, 25], { mat: 'pizzawall' }),
  box([-20, 2.6, 24.7], [-18, PW, 25], { mat: 'pizzawall' }),
  box([-H, PW, 25], [-10, PW + 0.2, H], { mat: 'dark', nocollide: true, tag: 'roof' }),
  // security office: two doors so it is never a dead end
  box([-15.3, 0, 21.5], [-15, PW, 24.7], { mat: 'pizzawall' }),
  box([-15.3, 0, 21.2], [-12.5, PW, 21.5], { mat: 'pizzawall' }),
  box([-11, 0, 21.2], [-10.3, PW, 21.5], { mat: 'pizzawall' }),
  box([-10.3, 0, 21.5], [-10, PW, 22], { mat: 'pizzawall' }), // door to the south arm at z 22..24.7
  box([-10.3, 2.6, 22], [-10, PW, 24.7], { mat: 'pizzawall' }),
  block(-13.2, 0, 24.1, 2.6, 0.8, 0.8, { mat: 'table', tag: 'desk', color: '#3a3a44' }),
  ...[-14, -12.4].map(x => block(x, 0.8, 24.15, 0.7, 0.5, 0.08, { mat: 'screen', nocollide: true })),
  // pizza-slice sign on the corner tower, two faces so it reads from both arms
  ...pizzaSign(-9.5, 5.5, 9.5),
]);

/** A triangular slice made of stacked emissive boxes, point down, in an X. */
function pizzaSign(cx: number, y0: number, cz: number): MapBox[] {
  const out: MapBox[] = [];
  const rows = 6;
  for (const along of ['x', 'z'] as const) {
    for (let i = 0; i < rows; i++) {
      const w = 0.45 + i * 0.45;
      const y = y0 + i * 0.5;
      const mat = i === rows - 1 ? 'crust' : 'cheese';
      out.push(along === 'x'
        ? block(cx, y, cz, w, 0.5, 0.16, { mat, nocollide: true, tag: 'sign' })
        : block(cx, y, cz, 0.16, 0.5, w, { mat, nocollide: true, tag: 'sign' }));
    }
    for (const [o, y] of [[-0.5, 1.4], [0.45, 1.75], [0, 0.6]]) {
      out.push(along === 'x'
        ? block(cx + o, y0 + y, cz, 0.36, 0.36, 0.22, { mat: 'pepperoni', nocollide: true, tag: 'sign' })
        : block(cx, y0 + y, cz + o, 0.22, 0.36, 0.36, { mat: 'pepperoni', nocollide: true, tag: 'sign' }));
    }
  }
  return out;
}

// --- SE: LOADING DOCK ----------------------------------------------------------
const dock: MapBox[] = zoned('dock', [
  // raised dock along the south wall with two stairs
  box([12, 0, 24], [H, 1, H], { mat: 'concrete', tag: 'dock' }),
  box([12, 0.98, 23.9], [H, 1.02, 24.1], { mat: 'hazard', nocollide: true }),
  ...stairs([13.75, 0, 24], 'z-', 2, 1, 3.5),
  ...stairs([26, 0, 24], 'z-', 2, 1, 3.5),
  // roll-up doors in the back wall
  box([15.5, 1, 27.8], [19.5, 4.6, 27.98], { mat: 'rollup', nocollide: true, tag: 'rollup' }),
  box([21.5, 1, 27.8], [25.5, 3.0, 27.98], { mat: 'rollup', nocollide: true, tag: 'rollup' }),
  box([21.5, 3.0, 27.9], [25.5, 4.6, 27.99], { mat: 'dark', nocollide: true }),
  // walk-through trailer backed up to the dock
  box([16, 0, 13.5], [19, 0.5, 24], { mat: 'trailer', tag: 'trailer-bed' }),
  box([16, 0.5, 13.5], [16.2, 3.3, 24], { mat: 'trailer' }),
  box([18.8, 0.5, 13.5], [19, 3.3, 24], { mat: 'trailer' }),
  box([16, 3.3, 13.5], [19, 3.5, 24], { mat: 'trailer', tag: 'trailer-roof' }),
  ...[15.2, 16.6].map(z => block(17.5, 0, z, 3.1, 0.5, 0.5, { mat: 'dark', nocollide: true, tag: 'wheels' })),
  // catwalk over the dock floor, looking at mid; stairs at both ends
  box([12, 2.3, 11.2], [24, 2.5, 13], { mat: 'grate', tag: 'catwalk' }),
  box([12, 2.5, 11.2], [24, 2.75, 11.28], { mat: 'hazard', tag: 'rail' }),
  box([12, 2.75, 11.2], [24, 3.4, 11.28], { mat: 'chainlink', shootThrough: true, tag: 'rail' }),
  box([12, 3.4, 11.18], [24, 3.5, 11.3], { mat: 'metal', tag: 'rail' }),
  ...[13, 18, 23].map(x => block(x, 0, 12.9, 0.2, 2.3, 0.2, { mat: 'metal', tag: 'post' })),
  ...stairs([22.75, 0, 13], 'z+', 5, 2.5, 2.5, 'grate'),
  ...stairs([12, 0, 12.1], 'x-', 5, 2.5, 1.8, 'grate'),
  // crates and pallets
  block(13.2, 0, 19, 2, 2, 2, { mat: 'crate', tag: 'crate' }),
  block(13.4, 2, 19.2, 1.1, 1.1, 1.1, { mat: 'crate', tag: 'crate', nocollide: true }),
  block(22.5, 0, 20.5, 1.6, 1.6, 1.6, { mat: 'crate', tag: 'crate' }),
  block(25.8, 0, 16, 2, 1.2, 3, { mat: 'crate', tag: 'crate', color: '#7a5a3a' }),
  block(26.5, 0, 21.5, 1.2, 1.2, 1.2, { mat: 'crate', tag: 'crate' }),
  block(23.5, 1, 26, 1.4, 1.4, 1.4, { mat: 'crate', tag: 'crate' }),
  block(15, 1, 26.6, 1.8, 1.0, 1.4, { mat: 'crate', tag: 'crate', color: '#7a5a3a' }),
]);

const boxes: MapBox[] = [...floor, ...mid, ...arms, ...towers, ...pit, ...yard, ...pizza, ...dock];

const spawn = (x: number, y: number, z: number, team: 0 | 1): SpawnPoint => ({ p: [x, y, z], yaw: face(x, z), team });

export const ARCADE: MapData = {
  id: 'arcade',
  name: 'The Arcade',
  half: H,
  boxes,
  spawns: [
    // west: Pit + Freddy's
    spawn(-26.5, 0, -26.5, 0),
    spawn(-21.5, 0, -26, 0),
    spawn(-26.6, 0, -15, 0),
    spawn(-26.5, 0, 26.5, 0),
    spawn(-21, 0, 12.5, 0),
    spawn(-22, 0, 22.5, 0),
    // east: Yard + Dock
    spawn(26.8, 0, -26.8, 1),
    spawn(27, 0, -17, 1),
    spawn(13, 0, -23, 1),
    spawn(26.5, 1, 26.5, 1),
    spawn(20.5, 1, 26.2, 1),
    spawn(26.5, 0, 19.5, 1),
  ],
  lights: [
    { p: [0, 7.5, 0], color: '#ffffff', intensity: 700, distance: 40 },
    { p: [-18, 5.5, -15], color: '#ff7a1a', intensity: 750, distance: 30 },
    { p: [-15, 6, -24], color: '#fff2e0', intensity: 450, distance: 24 },
    { p: [12, 8.5, -26], color: '#cfe4ff', intensity: 800, distance: 40 },
    { p: [26, 8.5, -12], color: '#cfe4ff', intensity: 800, distance: 40 },
    { p: [-23, 4.6, 19], color: '#ff2a3a', intensity: 420, distance: 16, flicker: true },
    { p: [-16, 5, 16], color: '#a040ff', intensity: 300, distance: 16, flicker: true },
    { p: [-22, 3.3, 26.5], color: '#ff3020', intensity: 300, distance: 6, flicker: true },
    { p: [-12.6, 3, 23], color: '#40ff90', intensity: 300, distance: 5 },
    { p: [24, 6, 21], color: '#ffc14a', intensity: 650, distance: 30 },
    { p: [15, 6, 15], color: '#ffc14a', intensity: 550, distance: 28 },
    { p: [0, 5, -20], color: '#8fb0ff', intensity: 350, distance: 22 },
    { p: [0, 5, 20], color: '#8fb0ff', intensity: 350, distance: 22 },
  ],
  sky: { top: '#03040e', bottom: '#141a3a', ambient: '#4a4f6a', fog: 110 },
};

export const MAPS: Record<string, MapData> = { arcade: ARCADE };
