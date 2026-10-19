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
  maxHp: 3,           // hits: a body mark takes 1, a head mark 2, pump and tag take all 3
  respawnMs: 3000,
} as const;

// Paintball markers. Ids are what goes on the wire; names are what players see.
export type WeaponId = 'tag' | 'pistol' | 'semi' | 'auto' | 'pump';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  slot: 1 | 2 | 3;        // 1 primary marker, 2 sidearm, 3 hand tag
  damage: number;         // hits taken off per ball (PLAYER.maxHp = 3)
  headshot: number;       // multiplier for a head mark (rounded)
  pellets: number;        // balls per trigger pull
  fireMs: number;         // min time between shots
  auto: boolean;
  mag: number;            // hopper size, 0 = no ammo
  reserve: number;        // balls in pods
  reloadMs: number;
  spread: number;         // base cone (radians) when standing still
  moveSpread: number;     // added when moving at full speed
  range: number;          // m, server rejects hits past this
  speedMul: number;       // movement speed multiplier while held
  recoil: number;         // pitch kick per shot (radians)
  scope?: number;         // FOV multiplier when scoped
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  tag:    { id: 'tag',    name: 'Hand Tag',    slot: 3, damage: 3, headshot: 1, pellets: 1, fireMs: 400,  auto: false, mag: 0,  reserve: 0,   reloadMs: 0,    spread: 0,      moveSpread: 0,    range: 2.2, speedMul: 1.08, recoil: 0 },
  pistol: { id: 'pistol', name: 'Sidearm',     slot: 2, damage: 1, headshot: 2, pellets: 1, fireMs: 220,  auto: false, mag: 8,  reserve: 40,  reloadMs: 1400, spread: 0.008,  moveSpread: 0.03, range: 80,  speedMul: 1.0,  recoil: 0.012 },
  semi:   { id: 'semi',   name: 'Semi Marker', slot: 1, damage: 1, headshot: 2, pellets: 1, fireMs: 200,  auto: false, mag: 20, reserve: 120, reloadMs: 2000, spread: 0.004,  moveSpread: 0.04, range: 120, speedMul: 0.95, recoil: 0.012 },
  auto:   { id: 'auto',   name: 'Auto Marker', slot: 1, damage: 1, headshot: 2, pellets: 1, fireMs: 100,  auto: true,  mag: 30, reserve: 150, reloadMs: 2400, spread: 0.012,  moveSpread: 0.06, range: 100, speedMul: 0.92, recoil: 0.014 },
  pump:   { id: 'pump',   name: 'Pump Marker', slot: 1, damage: 3, headshot: 1, pellets: 1, fireMs: 1000, auto: false, mag: 10, reserve: 60,  reloadMs: 3000, spread: 0.0015, moveSpread: 0.12, range: 200, speedMul: 0.88, recoil: 0.05, scope: 0.3 },
};

export const PRIMARY_WEAPONS: WeaponId[] = ['semi', 'auto', 'pump'];
export const DEFAULT_PRIMARY: WeaponId = 'semi';

// Playable characters. Purely cosmetic; the world agent gives each a mesh.
export interface CharacterDef { id: string; name: string; color: string; blurb: string }
export const CHARACTERS: CharacterDef[] = [
  { id: 'bot',     name: 'Killsaw',   color: '#ff6a00', blurb: 'Combat robot. Spinner included.' },
  { id: 'slugger', name: 'Slugger',   color: '#1e6fff', blurb: 'Cleanup hitter. Swings for the fences.' },
  { id: 'bear',    name: 'Night Bear', color: '#7a4a1e', blurb: 'Animatronic. Only moves when you blink.' },
  { id: 'ghost',   name: 'Phantom',   color: '#c9c9ff', blurb: 'Quiet. Patient. Always behind you.' },
  { id: 'astro',   name: 'Astro',     color: '#f2f2f2', blurb: 'Zero-G trained. Lands every jump.' },
  { id: 'chef',    name: 'Pizza Chef', color: '#e03c3c', blurb: 'Delivers in 30 seconds or you get marked.' },
];

export const MATCH = {
  warmupMs: 15_000,
  durationMs: 6 * 60_000,
  killLimit: 30,         // marks to win FFA / team marks to win TDM
  overMs: 12_000,
} as const;

/** Elimination: rounds, no respawn mid-round, first to `roundsToWin`. */
export const ELIM = {
  roundMs: 150_000,      // 2:30; on timeout the defending side (team 1, Day) takes the round
  freezeMs: 5_000,       // move but not shoot at the start of each round
  roundOverMs: 4_000,    // banner between rounds
  roundsToWin: 7,
  defenders: 1 as 0 | 1,
} as const;

export const MAX_NAME = 14;
export const MAX_PLAYERS = 12;
