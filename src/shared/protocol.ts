// Wire protocol between the client and the Room Durable Object. JSON for now.
import type { WeaponId } from './constants';

export type Vec3 = [number, number, number];
export type Team = 0 | 1;           // 0 = Night, 1 = Day (used by team modes)
export type GameMode = 'ffa' | 'tdm';
export type MatchPhase = 'warmup' | 'live' | 'over';

export interface PlayerSnapshot {
  id: number;
  name: string;
  skin: string;
  team: Team;
  p: Vec3;            // feet position
  yaw: number;
  pitch: number;
  hp: number;         // 0 = dead
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
  teamScore: [number, number];
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
  | { t: 'admin'; cmd: 'mode' | 'restart' | 'bots'; arg?: string | number };

export type ServerMsg =
  | { t: 'welcome'; id: number; now: number; map: string; players: PlayerSnapshot[]; match: MatchInfo }
  | { t: 'state'; now: number; players: Array<Pick<PlayerSnapshot, 'id' | 'p' | 'yaw' | 'pitch' | 'hp' | 'w' | 'crouch' | 'moving' | 'ground'>> }
  | { t: 'join'; player: PlayerSnapshot }
  | { t: 'leave'; id: number }
  | { t: 'spawn'; id: number; p: Vec3; yaw: number; hp: number; w: WeaponId }
  | { t: 'shot'; id: number; w: WeaponId; o: Vec3; d: Vec3; hit?: Vec3 }
  | { t: 'hit'; from: number; to: number; dmg: number; part: 'head' | 'body'; hp: number }
  | { t: 'kill'; killer: number; victim: number; w: WeaponId; headshot: boolean }
  | { t: 'score'; players: Array<Pick<PlayerSnapshot, 'id' | 'kills' | 'deaths' | 'ping' | 'team'>>; match: MatchInfo }
  | { t: 'match'; match: MatchInfo }
  | { t: 'chat'; from: number; name: string; text: string }
  | { t: 'pong'; c: number; now: number }
  | { t: 'error'; msg: string };

export const PROTOCOL_VERSION = 1;
