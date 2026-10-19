// Authoritative match state. Pure TypeScript over the shared contracts, so it
// runs inside the Durable Object and inside vitest unchanged.
import { CHARACTERS, MATCH, MAX_NAME, MAX_PLAYERS, PLAYER, PRIMARY_WEAPONS, WEAPONS, type WeaponId } from '../shared/constants';
import { MAPS, type MapData } from '../shared/map';
import { bulletBoxes, dist, hasLos } from '../shared/physics';
import type { ClientMsg, GameMode, HitReport, MatchInfo, PlayerSnapshot, ServerMsg, Team, Vec3 } from '../shared/protocol';
import { BOT_NAMES, BotBrain, type BotDifficulty, type NavGrid } from './bots';
import { smokeBlocks, type SmokeVolume } from '../shared/projectiles';
import { Projectiles } from './projectiles';

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
  private bots = new BotBrain();
  /** Active smoke spheres; they block line of sight for shots and bots. */
  smokes: SmokeVolume[] = [];
  nades: Projectiles;

  constructor(mapId = 'arcade', now = Date.now(), mode: GameMode = 'ffa') {
    this.map = MAPS[mapId] ?? MAPS.arcade;
    this.solids = bulletBoxes(this.map.boxes);
    this.nades = new Projectiles(this.map);
    this.match = { mode, phase: 'warmup', endsAt: now + MATCH.warmupMs, teamScore: [0, 0] };
  }

  snapshot(p: ServerPlayer): PlayerSnapshot {
    const { lastShot: _a, diedAt: _b, lastInput: _c, rejects: _d, ...rest } = p;
    return rest;
  }

  /** Humans in the room. Bots do not keep a match alive. */
  humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot) n++;
    return n;
  }

  /** Nav grid for this match, built once. */
  nav(): NavGrid { return this.bots.nav(this.map); }

  setBotDifficulty(d: BotDifficulty) { this.bots.difficulty = d; }

  // ----- lifecycle -------------------------------------------------------

  join(name: string, skin: string, now: number, bot = false): { player: ServerPlayer; out: Outbox } | { error: string } {
    if (this.players.size >= MAX_PLAYERS) return { error: 'room full' };
    const clean = (name || 'Player').replace(/[^\w \-'!?.]/g, '').trim().slice(0, MAX_NAME) || 'Player';
    const id = this.nextId++;
    const team = this.pickTeam();
    const spawn = this.pickSpawn(team);
    const w: WeaponId = bot ? PRIMARY_WEAPONS[Math.floor(this.rng() * PRIMARY_WEAPONS.length)] : 'rifle';
    const player: ServerPlayer = {
      id, name: clean, skin, team,
      p: [...spawn.p] as Vec3, yaw: spawn.yaw, pitch: 0,
      hp: PLAYER.maxHp, w, crouch: false, moving: false, ground: true,
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
    const p = this.players.get(id);
    if (!p) return [];
    this.players.delete(id);
    this.bots.forget(id);
    const out: Outbox = [{ to: 'all', msg: { t: 'leave', id } }];
    if (!p.bot && this.humanCount() === 0) out.push(...this.setBots(0, 0));
    return out;
  }

  /** Add or remove bots so the match has `n` of them (0..6). Names are fixed. */
  setBots(n: number, now: number): Outbox {
    const raw = Math.round(Number(n));
    const want = Number.isFinite(raw) ? Math.max(0, Math.min(BOT_NAMES.length, raw)) : 0;
    const out: Outbox = [];
    const existing = [...this.players.values()].filter(p => p.bot);
    for (let i = existing.length - 1; i >= want; i--) out.push(...this.leave(existing[i].id));
    while ([...this.players.values()].filter(p => p.bot).length < want) {
      const used = new Set([...this.players.values()].map(p => p.name));
      const name = BOT_NAMES.find(nm => !used.has(nm));
      if (!name) break;
      const skin = CHARACTERS[this.players.size % CHARACTERS.length].id;
      const r = this.join(name, skin, now, true);
      if ('error' in r) break;
      out.push(...r.out);
    }
    if (this.balanceBotTeams()) out.push(this.scoreMsg());
    return out;
  }

  /** Shift bots until the two sides differ by at most one. Returns whether a team changed. */
  private balanceBotTeams(): boolean {
    if (this.match.mode !== 'tdm') return false;
    const all = [...this.players.values()];
    const count = (t: Team) => all.reduce((n, p) => n + (p.team === t ? 1 : 0), 0);
    let changed = false;
    for (let guard = 0; guard < 8 && Math.abs(count(0) - count(1)) > 1; guard++) {
      const big: Team = count(0) > count(1) ? 0 : 1;
      const bot = all.find(p => p.bot && p.team === big);
      if (!bot) break;
      bot.team = big === 0 ? 1 : 0;
      changed = true;
    }
    return changed;
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
        if (p.bot || p.hp <= 0) return [];
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
      case 'throw': return this.nades.throw(this, id, msg, now);
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
    if (msg.cmd === 'bots') return this.setBots(Number(msg.arg), now);
    return [];
  }

  shoot(p: ServerPlayer, msg: Extract<ClientMsg, { t: 'shoot' }>, now: number): Outbox {
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
    for (const [tid, { dmg, head }] of damaged) out.push(...this.applyDamage(p.id, tid, dmg, head, now, w.id));
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
    if (w.id !== 'knife' && this.smokeBlocks(origin, h.point)) return 0;
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
    this.nades.refill(p.id);
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
    out.push(...this.bots.tick(this, now));
    out.push(...this.nades.tick(this, now));
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

  // ----- grenades workstream additions -----------------------------------

  /** Damage from a validated shot or a paint burst: hp, hit, kill, score. `w` defaults to what the attacker holds. */
  applyDamage(fromId: number, toId: number, dmg: number, head: boolean, now: number, w?: WeaponId): Outbox {
    const p = this.players.get(fromId), t = this.players.get(toId);
    if (!p || !t || t.hp <= 0) return [];
    t.hp = Math.max(0, t.hp - dmg);
    const out: Outbox = [{ to: 'all', msg: { t: 'hit', from: p.id, to: t.id, dmg, part: head ? 'head' : 'body', hp: t.hp } }];
    if (t.hp === 0) out.push(...this.kill(p, t, w ?? p.w, head, now));
    return out;
  }

  /** True when an active smoke sphere lies across the segment a→b. */
  smokeBlocks(a: Vec3, b: Vec3): boolean { return smokeBlocks(a, b, this.smokes); }
}
