// Server-side bots. The nav grid is built once per Game; paths are cached.
// Movement goes through the same stepBody humans use, at the 20 Hz tick.
import { PLAYER, TICK_MS, WEAPONS } from '../shared/constants';
import type { MapBox, MapData } from '../shared/map';
import {
  bulletBoxes, canStand, dist, eyeHeight, forward, hasLos, rayPlayer, rayWorld, solidBoxes, stepBody,
} from '../shared/physics';
import { isTeamMode, type HitReport, type Vec3 } from '../shared/protocol';
import type { Game, ServerPlayer } from './game';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export const BOT_NAMES = ['Night Guard', 'Umpire', 'Spinner', 'Mascot', 'Rookie', 'Closer'] as const;

const SIGHT = 45;
const STEP_UP = 0.55;
const DROP = 3;

const DIFF: Record<BotDifficulty, { reactionMs: number; aim: number; aimMin: number; shrink: number }> = {
  easy:   { reactionMs: 520, aim: 0.12,  aimMin: 0.04,  shrink: 0.94 },
  normal: { reactionMs: 280, aim: 0.055, aimMin: 0.012, shrink: 0.90 },
  hard:   { reactionMs: 120, aim: 0.025, aimMin: 0.004, shrink: 0.85 },
};

interface Cell { x: number; y: number; z: number; n: number[] }

interface Mind {
  v: Vec3;
  path: Vec3[];
  cursor: number;
  enemy: number;
  seen: number;
  aimYaw: number;
  aimPitch: number;
  aim: number;
  strafe: 1 | -1;
  strafeUntil: number;
  stuck: number;
  lx: number;
  lz: number;
}

/** 1 m grid over standable cells. Neighbours link at <= 0.55 up or <= 3 down. */
export class NavGrid {
  readonly cells: Cell[] = [];
  readonly move: MapBox[];
  readonly block: MapBox[];
  /** Cells reachable from the spawns — wander targets live here. */
  readonly wander: number[] = [];
  private index = new Map<string, number>();
  private cache = new Map<string, number[]>();
  private spawnCell: number[] = [];

  constructor(readonly map: MapData) {
    this.move = solidBoxes(map.boxes);
    this.block = bulletBoxes(map.boxes);
    const min = Math.ceil(-map.half);
    const max = Math.floor(map.half) - 1;
    for (let ix = min; ix <= max; ix++) {
      for (let iz = min; iz <= max; iz++) {
        const x = ix + 0.5, z = iz + 0.5;
        const y = standY(x, z, this.move);
        if (y === null) continue;
        this.index.set(ix + ',' + iz, this.cells.length);
        this.cells.push({ x, y, z, n: [] });
      }
    }
    const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [key, i] of this.index) {
      const [ix, iz] = key.split(',').map(Number);
      const c = this.cells[i];
      for (const [dx, dz] of dirs) {
        const j = this.index.get((ix + dx) + ',' + (iz + dz));
        if (j === undefined) continue;
        const o = this.cells[j];
        const dy = o.y - c.y;
        if (dy > STEP_UP || dy < -DROP) continue;
        if (dx !== 0 && dz !== 0) {
          const a = this.index.get((ix + dx) + ',' + iz);
          const b = this.index.get(ix + ',' + (iz + dz));
          if (a === undefined || b === undefined) continue;
          if (!this.linkOk(c, this.cells[a]) || !this.linkOk(c, this.cells[b])) continue;
        }
        c.n.push(j);
      }
    }
    this.spawnCell = map.spawns.map(s => this.nearest(s.p[0], s.p[2])).filter((i): i is number => i !== null);
    const root = this.spawnCell[0];
    if (root !== undefined) {
      const seen = new Uint8Array(this.cells.length);
      const q = [root];
      seen[root] = 1;
      for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi];
        this.wander.push(u);
        for (const v of this.cells[u].n) if (!seen[v]) { seen[v] = 1; q.push(v); }
      }
    }
  }

  private linkOk(a: Cell, b: Cell): boolean {
    const dy = b.y - a.y;
    return dy <= STEP_UP && dy >= -DROP;
  }

  nearest(x: number, z: number): number | null {
    const ix = Math.floor(x), iz = Math.floor(z);
    const direct = this.index.get(ix + ',' + iz);
    if (direct !== undefined) return direct;
    let best: number | null = null, bestD = Infinity;
    for (let r = 1; r <= 6 && best === null; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const j = this.index.get((ix + dx) + ',' + (iz + dz));
        if (j === undefined) continue;
        const c = this.cells[j];
        const d = (c.x - x) ** 2 + (c.z - z) ** 2;
        if (d < bestD) { bestD = d; best = j; }
      }
    }
    return best;
  }

  /** Indices of cells the spawns snapped to. */
  spawns(): number[] { return this.spawnCell; }

  reaches(a: number, b: number): boolean {
    return a === b || this.pathIdx(a, b).length > 0;
  }

  path(from: number, to: number): Vec3[] {
    return this.pathIdx(from, to).map(i => {
      const c = this.cells[i];
      return [c.x, c.y, c.z] as Vec3;
    });
  }

  private pathIdx(from: number, to: number): number[] {
    if (from === to) return [];
    const key = from + '>' + to;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const parent = new Int32Array(this.cells.length);
    parent.fill(-1);
    const seen = new Uint8Array(this.cells.length);
    const q = [from];
    seen[from] = 1;
    for (let qi = 0; qi < q.length && !seen[to]; qi++) {
      const u = q[qi];
      for (const v of this.cells[u].n) {
        if (seen[v]) continue;
        seen[v] = 1;
        parent[v] = u;
        q.push(v);
        if (v === to) break;
      }
    }
    if (!seen[to]) { this.cache.set(key, []); return []; }
    const idx: number[] = [];
    for (let u = to; u !== from && u >= 0; u = parent[u]) idx.push(u);
    idx.reverse();
    this.cache.set(key, idx);
    return idx;
  }
}

function standY(x: number, z: number, solids: MapBox[]): number | null {
  let best: number | null = null;
  for (const b of solids) {
    if (x <= b.min[0] + 0.02 || x >= b.max[0] - 0.02) continue;
    if (z <= b.min[2] + 0.02 || z >= b.max[2] - 0.02) continue;
    const y = b.max[1];
    if (!canStand([x, y, z], solids)) continue;
    if (best === null || y > best) best = y;
  }
  return best;
}

function eye(p: ServerPlayer): Vec3 {
  return [p.p[0], p.p[1] + eyeHeight(p.crouch), p.p[2]];
}

/**
 * Bot brains for one match. The grid is built on first use and kept.
 * `tick` runs inside Game.tick, before the state broadcast.
 */
export class BotBrain {
  difficulty: BotDifficulty = 'normal';
  private grid: NavGrid | null = null;
  private minds = new Map<number, Mind>();

  nav(map: MapData): NavGrid {
    if (!this.grid || this.grid.map !== map) this.grid = new NavGrid(map);
    return this.grid;
  }

  forget(id: number) { this.minds.delete(id); }

  tick(game: Game, now: number): ReturnType<Game['shoot']> {
    const grid = this.nav(game.map);
    const out: ReturnType<Game['shoot']> = [];
    for (const p of game.players.values()) {
      if (!p.bot || !game.players.has(p.id)) continue;
      out.push(...this.tickOne(game, grid, p, now));
    }
    for (const id of this.minds.keys()) if (!game.players.has(id)) this.minds.delete(id);
    return out;
  }

  private mind(p: ServerPlayer): Mind {
    let m = this.minds.get(p.id);
    if (!m) {
      m = {
        v: [0, 0, 0], path: [], cursor: 0, enemy: 0, seen: 0,
        aimYaw: 0, aimPitch: 0, aim: DIFF[this.difficulty].aim,
        strafe: Math.random() < 0.5 ? 1 : -1, strafeUntil: 0,
        stuck: 0, lx: p.p[0], lz: p.p[2],
      };
      this.minds.set(p.id, m);
    }
    return m;
  }

  private tickOne(game: Game, grid: NavGrid, bot: ServerPlayer, now: number) {
    const out: ReturnType<Game['shoot']> = [];
    const m = this.mind(bot);
    if (bot.hp <= 0) {
      m.enemy = 0;
      m.path = [];
      m.v[0] = m.v[1] = m.v[2] = 0;
      // same gate as a human: no respawn while an elimination round is on
      if (now - bot.diedAt >= PLAYER.respawnMs && game.canRespawn()) out.push(...game.handle(bot.id, { t: 'respawn' }, now));
      return out;
    }

    const diff = DIFF[this.difficulty];
    const foe = this.visibleEnemy(game, grid, bot);
    const speed = PLAYER.walkSpeed * (WEAPONS[bot.w]?.speedMul ?? 1);
    let wish: [number, number] = [0, 0];

    if (foe) {
      if (m.enemy !== foe.id) {
        m.enemy = foe.id;
        m.seen = now;
        m.aim = diff.aim;
        m.aimYaw = Math.random() * 2 - 1;
        m.aimPitch = (Math.random() * 2 - 1) * 0.55;
      } else {
        m.aim = Math.max(diff.aimMin, m.aim * diff.shrink);
      }
      const from = eye(bot);
      const aimAt: Vec3 = [foe.p[0], foe.p[1] + 0.9, foe.p[2]];
      const dx = aimAt[0] - from[0], dy = aimAt[1] - from[1], dz = aimAt[2] - from[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const pitch0 = Math.asin(Math.max(-1, Math.min(1, dy / len)));
      const yaw0 = Math.atan2(-dx, -dz);
      bot.yaw = yaw0 + m.aimYaw * m.aim;
      bot.pitch = Math.max(-1.15, Math.min(1.15, pitch0 + m.aimPitch * m.aim));
      if (now >= m.strafeUntil) {
        m.strafe = (m.strafe === 1 ? -1 : 1);
        m.strafeUntil = now + 700 + Math.random() * 700;
      }
      const yaw = bot.yaw;
      const rx = -Math.cos(yaw), rz = Math.sin(yaw);
      const distH = Math.hypot(foe.p[0] - bot.p[0], foe.p[2] - bot.p[2]);
      if (distH > 16) {
        const fx = -Math.sin(yaw0), fz = -Math.cos(yaw0);
        const wx = fx * 0.85 + rx * m.strafe * 0.4;
        const wz = fz * 0.85 + rz * m.strafe * 0.4;
        const wl = Math.hypot(wx, wz) || 1;
        wish = [wx / wl * speed, wz / wl * speed];
      } else {
        wish = [rx * m.strafe * speed * 0.45, rz * m.strafe * speed * 0.45];
      }
      const wpn = WEAPONS[bot.w];
      if (wpn && game.canAttack() && now - m.seen >= diff.reactionMs && now - bot.lastShot >= wpn.fireMs) {
        out.push(...this.fire(game, grid, bot, now));
      }
    } else {
      m.enemy = 0;
      wish = this.wander(grid, bot, m, speed);
    }

    this.move(grid, bot, m, wish);
    return out;
  }

  private visibleEnemy(game: Game, grid: NavGrid, bot: ServerPlayer): ServerPlayer | null {
    const from = eye(bot);
    let best: ServerPlayer | null = null;
    let bestD = SIGHT;
    const prefer = this.minds.get(bot.id)?.enemy ?? 0;
    for (const o of game.players.values()) {
      if (o.id === bot.id || o.hp <= 0) continue;
      if (isTeamMode(game.match.mode) && o.team === bot.team) continue;
      const to = eye(o);
      const d = dist(from, to);
      if (d > SIGHT) continue;
      if (!hasLos(from, to, grid.block)) continue;
      if (game.smokeBlocks(from, to)) continue;
      if (o.id === prefer) return o;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  private wander(grid: NavGrid, bot: ServerPlayer, m: Mind, speed: number): [number, number] {
    const here = grid.nearest(bot.p[0], bot.p[2]);
    if (m.cursor >= m.path.length) {
      m.path = [];
      m.cursor = 0;
      if (here !== null && grid.wander.length) {
        const roll = Math.random();
        let goal = grid.wander[Math.floor(Math.random() * grid.wander.length)];
        if (roll < 0.5 && grid.spawns().length) {
          const s = grid.spawns()[Math.floor(Math.random() * grid.spawns().length)];
          if (grid.reaches(here, s)) goal = s;
        }
        if (goal !== here) m.path = grid.path(here, goal);
      }
    }
    while (m.cursor < m.path.length && Math.hypot(m.path[m.cursor][0] - bot.p[0], m.path[m.cursor][2] - bot.p[2]) < 0.65) m.cursor++;
    if (m.cursor >= m.path.length) return [0, 0];
    const wp = m.path[m.cursor];
    const dx = wp[0] - bot.p[0], dz = wp[2] - bot.p[2];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return [0, 0];
    bot.yaw = Math.atan2(-dx, -dz);
    bot.pitch = 0;
    return [dx / len * speed, dz / len * speed];
  }

  private move(grid: NavGrid, bot: ServerPlayer, m: Mind, wish: [number, number]) {
    const prev: Vec3 = [bot.p[0], bot.p[1], bot.p[2]];
    const body = stepBody({ p: bot.p, v: m.v, crouch: false, ground: bot.ground }, wish, TICK_MS / 1000, grid.move, false);
    const h = grid.map.half;
    if (body.p[0] < -h) body.p[0] = -h;
    else if (body.p[0] > h) body.p[0] = h;
    if (body.p[2] < -h) body.p[2] = -h;
    else if (body.p[2] > h) body.p[2] = h;
    if (!canStand(body.p, grid.move)) {
      body.p[0] = prev[0]; body.p[1] = prev[1]; body.p[2] = prev[2];
      m.v[0] = m.v[2] = 0;
      m.path = [];
      m.cursor = 0;
    }
    const moved = Math.hypot(body.p[0] - m.lx, body.p[2] - m.lz);
    if (moved < 0.02 && (wish[0] !== 0 || wish[1] !== 0)) {
      if (++m.stuck > 12) { m.path = []; m.cursor = 0; m.stuck = 0; }
    } else m.stuck = 0;
    m.lx = body.p[0]; m.lz = body.p[2];
    bot.crouch = false;
    bot.ground = body.ground;
    bot.moving = Math.hypot(wish[0], wish[1]) > 0.3;
  }

  private fire(game: Game, grid: NavGrid, bot: ServerPlayer, now: number) {
    const w = WEAPONS[bot.w];
    if (!w) return [];
    const o = eye(bot);
    const base = forward(bot.yaw, bot.pitch);
    const hits: HitReport[] = [];
    const pellets = Math.max(1, w.pellets);
    for (let i = 0; i < pellets; i++) {
      const spread = w.spread * (i === 0 ? 0.25 : 1);
      const jy = (Math.random() * 2 - 1) * spread;
      const jp = (Math.random() * 2 - 1) * spread * 0.5;
      const dir = i === 0 && spread < 1e-4 ? base : forward(bot.yaw + jy, bot.pitch + jp);
      const worldT = rayWorld(o, dir, grid.block, w.range);
      let best: { id: number; part: 'head' | 'body'; t: number } | null = null;
      for (const other of game.players.values()) {
        if (other.id === bot.id || other.hp <= 0) continue;
        if (isTeamMode(game.match.mode) && other.team === bot.team) continue;
        const hit = rayPlayer(o, dir, other.p, other.crouch, w.range);
        if (!hit) continue;
        if (worldT !== null && hit.t >= worldT - 1e-3) continue;
        if (!best || hit.t < best.t) best = { id: other.id, part: hit.part, t: hit.t };
      }
      if (!best) continue;
      const point: Vec3 = [o[0] + dir[0] * best.t, o[1] + dir[1] * best.t, o[2] + dir[2] * best.t];
      hits.push({ id: best.id, part: best.part, point });
    }
    return game.shoot(bot, { t: 'shoot', w: w.id, o, d: base, hits }, now);
  }
}
