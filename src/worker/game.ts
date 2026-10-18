// Authoritative match state. Pure TypeScript over the shared contracts, so it
// runs inside the Durable Object and inside vitest unchanged.
import { MATCH, MAX_NAME, MAX_PLAYERS, PLAYER, WEAPONS, type WeaponId } from '../shared/constants';
import { MAPS, type MapData } from '../shared/map';
import { bulletBoxes, dist, hasLos } from '../shared/physics';
import type { ClientMsg, GameMode, HitReport, MatchInfo, PlayerSnapshot, ServerMsg, Team, Vec3 } from '../shared/protocol';

export interface ServerPlayer extends PlayerSnapshot {
  lastShot: number;
  diedAt: number;
  lastInput: number;
  rejects: number;
  bot: boolean;
}

export type Outbox = Array<{ to: 'all' | number; msg: ServerMsg }>;

export class Game {
  players = new Map<number, ServerPlayer>();
  match: MatchInfo;
  map: MapData;
  private nextId = 1;
  private solids;
  private rng = Math.random;

  constructor(mapId = 'arcade', now = Date.now(), mode: GameMode = 'ffa') {
    this.map = MAPS[mapId] ?? MAPS.arcade;
    this.solids = bulletBoxes(this.map.boxes);
    this.match = { mode, phase: 'warmup', endsAt: now + MATCH.warmupMs, teamScore: [0, 0] };
  }

  snapshot(p: ServerPlayer): PlayerSnapshot {
    const { lastShot: _a, diedAt: _b, lastInput: _c, rejects: _d, ...rest } = p;
    return rest;
  }

  // ----- lifecycle -------------------------------------------------------

  join(name: string, skin: string, now: number, bot = false): { player: ServerPlayer; out: Outbox } | { error: string } {
    if (this.players.size >= MAX_PLAYERS) return { error: 'room full' };
    const clean = (name || 'Player').replace(/[^\w \-'!?.]/g, '').trim().slice(0, MAX_NAME) || 'Player';
    const id = this.nextId++;
    const team = this.pickTeam();
    const spawn = this.pickSpawn(team);
    const player: ServerPlayer = {
      id, name: clean, skin, team,
      p: [...spawn.p] as Vec3, yaw: spawn.yaw, pitch: 0,
      hp: PLAYER.maxHp, w: 'rifle', crouch: false, moving: false, ground: true,
      kills: 0, deaths: 0, ping: 0, bot,
      lastShot: 0, diedAt: 0, lastInput: now, rejects: 0,
    };
    this.players.set(id, player);
    const out: Outbox = [
      { to: id, msg: { t: 'welcome', id, now, map: this.map.id, players: [...this.players.values()].map(p => this.snapshot(p)), match: this.match } },
      { to: 'all', msg: { t: 'join', player: this.snapshot(player) } },
    ];
    return { player, out };
  }

  leave(id: number): Outbox {
    if (!this.players.delete(id)) return [];
    return [{ to: 'all', msg: { t: 'leave', id } }];
  }

  private pickTeam(): Team {
    if (this.match.mode !== 'tdm') return 0;
    let a = 0, b = 0;
    for (const p of this.players.values()) (p.team === 0 ? a++ : b++);
    return a <= b ? 0 : 1;
  }

  /** Spawn point that maximises the distance to the nearest living enemy. */
  pickSpawn(team: Team, selfId = -1) {
    const enemies = [...this.players.values()].filter(p => p.id !== selfId && p.hp > 0 && (this.match.mode !== 'tdm' || p.team !== team));
    const candidates = this.map.spawns.filter(s => s.team === undefined || this.match.mode !== 'tdm' || s.team === team);
    let best = candidates[0], bestScore = -1;
    for (const s of candidates) {
      let nearest = Infinity;
      for (const e of enemies) nearest = Math.min(nearest, dist(s.p, e.p));
      const score = (enemies.length ? nearest : 1) + this.rng() * 3;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  // ----- messages --------------------------------------------------------

  handle(id: number, msg: ClientMsg, now: number): Outbox {
    const p = this.players.get(id);
    if (!p) return [{ to: id, msg: { t: 'error', msg: 'rejoin' } }];
    switch (msg.t) {
      case 'input': {
        if (p.hp <= 0) return [];
        // Clamp teleports: allow generous slack for lag, reject absurd jumps.
        const dt = Math.max(0.05, (now - p.lastInput) / 1000);
        const maxMove = PLAYER.walkSpeed * 1.5 * dt + 2.5;
        // After a run of rejects (lag spike, fall off a ledge) resync rather than strand the client.
        if (dist(p.p, msg.p) <= maxMove || ++p.rejects > 8) { p.p = [msg.p[0], msg.p[1], msg.p[2]]; p.rejects = 0; }
        p.yaw = msg.yaw; p.pitch = msg.pitch; p.crouch = !!msg.crouch; p.moving = !!msg.moving; p.ground = !!msg.ground;
        if (WEAPONS[msg.w]) p.w = msg.w;
        p.lastInput = now;
        return [];
      }
      case 'shoot': return this.shoot(p, msg, now);
      case 'respawn': return p.hp <= 0 && now - p.diedAt >= PLAYER.respawnMs ? this.respawn(p) : [];
      case 'chat': {
        const text = String(msg.text ?? '').slice(0, 140).trim();
        return text ? [{ to: 'all', msg: { t: 'chat', from: id, name: p.name, text } }] : [];
      }
      case 'ping': {
        p.ping = Math.max(0, Math.min(999, Math.round(msg.rtt ?? 0)));
        return [{ to: id, msg: { t: 'pong', c: msg.c, now } }];
      }
      case 'loadout': {
        if (WEAPONS[msg.primary]?.slot === 1) p.w = msg.primary;
        return [];
      }
      case 'admin': return this.admin(msg, now);
      case 'reload': return [];
      case 'join': return [];
    }
    return [];
  }

  private admin(msg: Extract<ClientMsg, { t: 'admin' }>, now: number): Outbox {
    if (msg.cmd === 'mode' && (msg.arg === 'ffa' || msg.arg === 'tdm')) {
      this.match.mode = msg.arg;
      return this.startWarmup(now);
    }
    if (msg.cmd === 'restart') return this.startWarmup(now);
    return [];
  }

  private shoot(p: ServerPlayer, msg: Extract<ClientMsg, { t: 'shoot' }>, now: number): Outbox {
    const w = WEAPONS[msg.w];
    if (!w || p.hp <= 0 || this.match.phase === 'over') return [];
    if (now - p.lastShot < w.fireMs * 0.75) return [];
    p.lastShot = now;
    p.w = w.id;
    const eye: Vec3 = [p.p[0], p.p[1] + PLAYER.eyeHeight, p.p[2]];
    if (dist(eye, msg.o) > 4) return [];
    const out: Outbox = [{ to: 'all', msg: { t: 'shot', id: p.id, w: w.id, o: msg.o, d: msg.d, hit: msg.hits[0]?.point } }];
    const hits = (msg.hits ?? []).slice(0, w.pellets);
    const damaged = new Map<number, { dmg: number; head: boolean }>();
    for (const h of hits) {
      const dmg = this.validateHit(p, w, msg.o, h);
      if (!dmg) continue;
      const cur = damaged.get(h.id) ?? { dmg: 0, head: false };
      cur.dmg += dmg; cur.head ||= h.part === 'head';
      damaged.set(h.id, cur);
    }
    for (const [tid, { dmg, head }] of damaged) {
      const t = this.players.get(tid)!;
      t.hp = Math.max(0, t.hp - dmg);
      out.push({ to: 'all', msg: { t: 'hit', from: p.id, to: tid, dmg, part: head ? 'head' : 'body', hp: t.hp } });
      if (t.hp === 0) out.push(...this.kill(p, t, w.id, head, now));
    }
    return out;
  }

  private validateHit(shooter: ServerPlayer, w: (typeof WEAPONS)[WeaponId], origin: Vec3, h: HitReport): number {
    const t = this.players.get(h.id);
    if (!t || t.id === shooter.id || t.hp <= 0) return 0;
    if (this.match.mode === 'tdm' && t.team === shooter.team) return 0;
    if (this.match.phase === 'warmup' && false) return 0; // warmup damage is on; it is the fun part
    if (dist(origin, h.point) > w.range + 2) return 0;
    // the claimed hit point must be near where the server thinks the target is
    const dx = h.point[0] - t.p[0], dz = h.point[2] - t.p[2], dy = h.point[1] - t.p[1];
    if (Math.hypot(dx, dz) > 1.6 || dy < -0.6 || dy > PLAYER.height + 0.8) return 0;
    if (w.id !== 'knife' && !hasLos(origin, h.point, this.solids)) return 0;
    const dmg = Math.round(w.damage * (h.part === 'head' ? w.headshot : 1));
    return dmg;
  }

  private kill(killer: ServerPlayer, victim: ServerPlayer, w: WeaponId, headshot: boolean, now: number): Outbox {
    victim.deaths++;
    victim.diedAt = now;
    killer.kills++;
    if (this.match.mode === 'tdm') this.match.teamScore[killer.team]++;
    const out: Outbox = [{ to: 'all', msg: { t: 'kill', killer: killer.id, victim: victim.id, w, headshot } }];
    out.push(this.scoreMsg());
    if (this.match.phase === 'live') {
      const top = this.match.mode === 'tdm' ? Math.max(...this.match.teamScore) : killer.kills;
      if (top >= MATCH.killLimit) out.push(...this.endMatch(now));
    }
    return out;
  }

  private respawn(p: ServerPlayer): Outbox {
    const s = this.pickSpawn(p.team, p.id);
    p.p = [...s.p] as Vec3; p.yaw = s.yaw; p.pitch = 0; p.hp = PLAYER.maxHp; p.crouch = false;
    if (WEAPONS[p.w].slot !== 1) p.w = 'rifle';
    return [{ to: 'all', msg: { t: 'spawn', id: p.id, p: p.p, yaw: p.yaw, hp: p.hp, w: p.w } }];
  }

  scoreMsg(): { to: 'all'; msg: ServerMsg } {
    return { to: 'all', msg: { t: 'score', players: [...this.players.values()].map(p => ({ id: p.id, kills: p.kills, deaths: p.deaths, ping: p.ping, team: p.team })), match: this.match } };
  }

  // ----- clock -----------------------------------------------------------

  /** Called at TICK_RATE. Returns broadcasts (state + any phase changes). */
  tick(now: number): Outbox {
    const out: Outbox = [];
    if (this.players.size === 0) return out;
    if (now >= this.match.endsAt) {
      if (this.match.phase === 'warmup') out.push(...this.startLive(now));
      else if (this.match.phase === 'live') out.push(...this.endMatch(now));
      else out.push(...this.startWarmup(now));
    }
    for (const p of this.players.values()) {
      if (p.hp <= 0 && now - p.diedAt >= PLAYER.respawnMs + 4000) out.push(...this.respawn(p));
    }
    out.push({ to: 'all', msg: { t: 'state', now, players: [...this.players.values()].map(p => ({ id: p.id, p: p.p, yaw: p.yaw, pitch: p.pitch, hp: p.hp, w: p.w, crouch: p.crouch, moving: p.moving, ground: p.ground })) } });
    return out;
  }

  startWarmup(now: number): Outbox {
    this.match.phase = 'warmup';
    this.match.endsAt = now + MATCH.warmupMs;
    return [{ to: 'all', msg: { t: 'match', match: this.match } }];
  }

  startLive(now: number): Outbox {
    this.match.phase = 'live';
    this.match.endsAt = now + MATCH.durationMs;
    this.match.teamScore = [0, 0];
    const out: Outbox = [];
    if (this.match.mode === 'tdm') {
      // rebalance teams at the start of every match
      const sorted = [...this.players.values()].sort((a, b) => a.id - b.id);
      sorted.forEach((p, i) => { p.team = (i % 2) as Team; });
    }
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; out.push(...this.respawn(p)); }
    out.push({ to: 'all', msg: { t: 'match', match: this.match } }, this.scoreMsg());
    return out;
  }

  endMatch(now: number): Outbox {
    this.match.phase = 'over';
    this.match.endsAt = now + MATCH.overMs;
    return [{ to: 'all', msg: { t: 'match', match: this.match } }, this.scoreMsg()];
  }
}
