// Wire protocol between the client and the Room Durable Object. JSON for now.
import type { WeaponId } from './constants';
import type { GrenadeKind } from './projectiles';

export type Vec3 = [number, number, number];
export type Team = 0 | 1;           // 0 = Night, 1 = Day (used by team modes)
export type GameMode = 'ffa' | 'tdm' | 'elim';
export const GAME_MODES: GameMode[] = ['ffa', 'tdm', 'elim'];
/** Modes with two sides (no friendly fire, team spawns). */
export const isTeamMode = (m: GameMode | string) => m === 'tdm' || m === 'elim';
export type MatchPhase = 'warmup' | 'live' | 'over';

export interface PlayerSnapshot {
  id: number;
  name: string;
  skin: string;
  team: Team;
  p: Vec3;            // feet position
  yaw: number;
  pitch: number;
  hp: number;         // hits left; 0 = marked out
  w: WeaponId;        // held weapon
  crouch: boolean;
  moving: boolean;
  ground: boolean;
  kills: number;
  deaths: number;
  ping: number;
  bot?: boolean;
}

export interface MatchInfo {
  mode: GameMode;
  phase: MatchPhase;
  endsAt: number;       // server ms when the phase ends
  teamScore: [number, number];   // tdm: team marks; elim: rounds won
  /** Elimination round state (only while mode is 'elim' and phase is 'live'). endsAt is the end of the current stage. */
  round?: RoundInfo;
}

export interface RoundInfo {
  n: number;                                 // 1-based round number
  stage: 'freeze' | 'live' | 'over';         // freeze: move, no shooting; over: banner before the next round
  winner?: Team | -1;                        // set in 'over'; -1 = draw (both sides out together)
  why?: 'wipe' | 'time';
}

export interface HitReport { id: number; part: 'head' | 'body'; point: Vec3 }

export type ClientMsg =
  | { t: 'join'; name: string; skin: string; v: number }
  | { t: 'input'; p: Vec3; yaw: number; pitch: number; crouch: boolean; moving: boolean; ground: boolean; w: WeaponId }
  | { t: 'shoot'; w: WeaponId; o: Vec3; d: Vec3; hits: HitReport[] }
  | { t: 'reload' }
  | { t: 'respawn' }
  | { t: 'chat'; text: string }
  | { t: 'ping'; c: number; rtt: number }
  | { t: 'loadout'; primary: WeaponId }
  | { t: 'admin'; cmd: 'mode' | 'restart' | 'bots' | 'botdiff'; arg?: string | number }
  // grenades: o = eye, d = unit view direction, power 0..1 (hold time)
  | { t: 'throw'; kind: GrenadeKind; o: Vec3; d: Vec3; power: number };

export type ServerMsg =
  | { t: 'welcome'; id: number; now: number; map: string; players: PlayerSnapshot[]; match: MatchInfo }
  | { t: 'state'; now: number; players: Array<Pick<PlayerSnapshot, 'id' | 'p' | 'yaw' | 'pitch' | 'hp' | 'w' | 'crouch' | 'moving' | 'ground'>> }
  | { t: 'join'; player: PlayerSnapshot }
  | { t: 'leave'; id: number }
  | { t: 'spawn'; id: number; p: Vec3; yaw: number; hp: number; w: WeaponId }
  | { t: 'shot'; id: number; w: WeaponId; o: Vec3; d: Vec3; hit?: Vec3 }
  | { t: 'hit'; from: number; to: number; dmg: number; part: 'head' | 'body'; hp: number }
  | { t: 'kill'; killer: number; victim: number; w: WeaponId; headshot: boolean; nade?: 'paint' }
  | { t: 'score'; players: Array<Pick<PlayerSnapshot, 'id' | 'kills' | 'deaths' | 'ping' | 'team'>>; match: MatchInfo }
  | { t: 'match'; match: MatchInfo }
  | { t: 'chat'; from: number; name: string; text: string }
  | { t: 'pong'; c: number; now: number }
  | { t: 'error'; msg: string }
  // grenades: 'proj' every tick while in flight (now = server tick time), then 'burst' (paint) or 'smoke'
  | { t: 'proj'; id: number; kind: GrenadeKind; p: Vec3; v: Vec3; owner: number; now?: number }
  | { t: 'burst'; id: number; kind: GrenadeKind; p: Vec3; owner: number; marked: number[] }
  | { t: 'smoke'; id: number; p: Vec3; until: number };

export const PROTOCOL_VERSION = 1;
