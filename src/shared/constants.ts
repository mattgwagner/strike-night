// Shared tuning. Both the client and the Durable Object import this file, so
// keep it free of DOM/three/workers types.

export const TICK_RATE = 20;              // server broadcast + client input rate (Hz)
export const TICK_MS = 1000 / TICK_RATE;

export const PLAYER = {
  radius: 0.35,        // half-width of the AABB (m)
  height: 1.8,         // standing height (m)
  crouchHeight: 1.2,
  eyeHeight: 1.62,     // camera above feet when standing
  crouchEyeHeight: 1.05,
  headHeight: 0.3,     // top slice of the box that counts as a headshot
  walkSpeed: 5.2,      // m/s
  crouchSpeed: 2.6,
  jumpSpeed: 6.2,
  gravity: 20,
  maxHp: 100,
  respawnMs: 3000,
} as const;

export type WeaponId = 'knife' | 'pistol' | 'rifle' | 'shotgun' | 'sniper';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  slot: 1 | 2 | 3;        // 1 primary, 2 pistol, 3 knife
  damage: number;         // per pellet / per hit
  headshot: number;       // multiplier
  pellets: number;        // >1 means shotgun
  fireMs: number;         // min time between shots
  auto: boolean;
  mag: number;            // 0 = no ammo
  reserve: number;
  reloadMs: number;
  spread: number;         // base cone (radians) when standing still
  moveSpread: number;     // added when moving at full speed
  range: number;          // m, server rejects hits past this
  speedMul: number;       // movement speed multiplier while held
  recoil: number;         // pitch kick per shot (radians)
  scope?: number;         // FOV multiplier when scoped
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife:   { id: 'knife',   name: 'Knife',   slot: 3, damage: 55,  headshot: 1,   pellets: 1, fireMs: 400,  auto: false, mag: 0,  reserve: 0,  reloadMs: 0,    spread: 0,     moveSpread: 0,     range: 2.2, speedMul: 1.08, recoil: 0 },
  pistol:  { id: 'pistol',  name: 'Pistol',  slot: 2, damage: 26,  headshot: 3.5, pellets: 1, fireMs: 170,  auto: false, mag: 13, reserve: 52, reloadMs: 1500, spread: 0.006, moveSpread: 0.03,  range: 120, speedMul: 1.0,  recoil: 0.012 },
  rifle:   { id: 'rifle',   name: 'Rifle',   slot: 1, damage: 30,  headshot: 3.4, pellets: 1, fireMs: 100,  auto: true,  mag: 30, reserve: 90, reloadMs: 2300, spread: 0.004, moveSpread: 0.05,  range: 200, speedMul: 0.93, recoil: 0.016 },
  shotgun: { id: 'shotgun', name: 'Shotgun', slot: 1, damage: 12,  headshot: 1.8, pellets: 9, fireMs: 850,  auto: false, mag: 7,  reserve: 28, reloadMs: 2800, spread: 0.06,  moveSpread: 0.03,  range: 28,  speedMul: 0.95, recoil: 0.05 },
  sniper:  { id: 'sniper',  name: 'Sniper',  slot: 1, damage: 95,  headshot: 2.5, pellets: 1, fireMs: 1400, auto: false, mag: 5,  reserve: 20, reloadMs: 3200, spread: 0.0015, moveSpread: 0.12, range: 400, speedMul: 0.85, recoil: 0.06, scope: 0.3 },
};

export const PRIMARY_WEAPONS: WeaponId[] = ['rifle', 'shotgun', 'sniper'];

// Playable characters. Purely cosmetic; the world agent gives each a mesh.
export interface CharacterDef { id: string; name: string; color: string; blurb: string }
export const CHARACTERS: CharacterDef[] = [
  { id: 'bot',     name: 'Killsaw',   color: '#ff6a00', blurb: 'Combat robot. Spinner included.' },
  { id: 'slugger', name: 'Slugger',   color: '#1e6fff', blurb: 'Cleanup hitter. Swings for the fences.' },
  { id: 'bear',    name: 'Night Bear', color: '#7a4a1e', blurb: 'Animatronic. Only moves when you blink.' },
  { id: 'ghost',   name: 'Phantom',   color: '#c9c9ff', blurb: 'Quiet. Patient. Always behind you.' },
  { id: 'astro',   name: 'Astro',     color: '#f2f2f2', blurb: 'Zero-G trained. Lands every jump.' },
  { id: 'chef',    name: 'Pizza Chef', color: '#e03c3c', blurb: 'Delivers in 30 seconds or you die.' },
];

export const MATCH = {
  warmupMs: 15_000,
  durationMs: 6 * 60_000,
  killLimit: 30,
  overMs: 12_000,
} as const;

export const MAX_NAME = 14;
export const MAX_PLAYERS = 12;
