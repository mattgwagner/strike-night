// Authoritative match state. Pure TypeScript over the shared contracts, so it
// runs inside the Durable Object and inside vitest unchanged.
import { CHARACTERS, DEFAULT_PRIMARY, ELIM, MATCH, MAX_NAME, MAX_PLAYERS, PLAYER, PRIMARY_WEAPONS, WEAPONS, type WeaponId } from '../shared/constants';
import { MAPS, type MapData } from '../shared/map';
import { bulletBoxes, dist, hasLos } from '../shared/physics';
import { GAME_MODES, RECONNECT_GRACE_MS, isTeamMode, type ClientMsg, type GameMode, type HitReport, type MatchInfo, type PlayerSnapshot, type ServerMsg, type Team, type Vec3 } from '../shared/protocol';
import { BOT_NAMES, BotBrain, type BotDifficulty, type NavGrid } from './bots';
import { smokeBlocks, type SmokeVolume } from '../shared/projectiles';
import { Projectiles } from './projectiles';

export interface ServerPlayer extends PlayerSnapshot {
  lastShot: number;
  diedAt: number;
  lastInput: number;
  rejects: number;
  bot: boolean;
  /** Reconnect token handed out in welcome; a rejoin with it keeps this player. */
  token: string;
  /** ms when the socket dropped, 0 while connected. */
  gone: number;
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
    const { lastShot: _a, diedAt: _b, lastInput: _c, rejects: _d, token: _e, gone: _f, ...rest } = p;
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
    const w: WeaponId = bot ? PRIMARY_WEAPONS[Math.floor(this.rng() * PRIMARY_WEAPONS.length)] : DEFAULT_PRIMARY;
    // joining an elimination round in progress: sit it out and spectate
    const sitOut = !this.canRespawn();
    const player: ServerPlayer = {
      id, name: clean, skin, team,
      p: [...spawn.p] as Vec3, yaw: spawn.yaw, pitch: 0,
      hp: sitOut ? 0 : PLAYER.maxHp, w, crouch: false, moving: false, ground: true,
      kills: 0, deaths: 0, ping: 0, bot,
      lastShot: 0, diedAt: sitOut ? now : 0, lastInput: now, rejects: 0,
      token: bot ? '' : this.makeToken(), gone: 0,
    };
    this.players.set(id, player);
    const out: Outbox = [
      this.welcome(player, now),
      { to: 'all', msg: { t: 'join', player: this.snapshot(player) } },
    ];
    // smoke already hanging in the air (a mid-match joiner would otherwise see straight through it)
    for (const sm of this.smokes) if (sm.until > now) out.push({ to: id, msg: { t: 'smoke', id: sm.id, p: sm.p, until: sm.until } });
    return { player, out };
  }

  private welcome(p: ServerPlayer, now: number): { to: number; msg: ServerMsg } {
    return { to: p.id, msg: { t: 'welcome', id: p.id, now, map: this.map.id, players: [...this.players.values()].map(q => this.snapshot(q)), match: this.match, token: p.token } };
  }

  private makeToken(): string {
    let t = '';
    for (let i = 0; i < 24; i++) t += Math.floor(this.rng() * 36).toString(36);
    return t;
  }

  /** The socket dropped: keep the player for RECONNECT_GRACE_MS so a blip keeps id and score. */
  disconnect(id: number, now: number): Outbox {
    const p = this.players.get(id);
    if (!p || p.bot) return [];
    p.gone = now;
    return [];
  }

  /** A join carrying a live token re-attaches to the same player. Null if unknown or expired. */
  rejoin(token: string, now: number): { player: ServerPlayer; out: Outbox } | null {
    if (!token) return null;
    for (const p of this.players.values()) {
      if (p.bot || p.token !== token) continue;
      p.gone = 0; p.lastInput = now; p.rejects = 0;
      const out: Outbox = [this.welcome(p, now)];
      for (const sm of this.smokes) if (sm.until > now) out.push({ to: p.id, msg: { t: 'smoke', id: sm.id, p: sm.p, until: sm.until } });
      return { player: p, out };
    }
    return null;
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
    if (!isTeamMode(this.match.mode)) return false;
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
    if (!isTeamMode(this.match.mode)) return 0;
    let a = 0, b = 0;
    for (const p of this.players.values()) (p.team === 0 ? a++ : b++);
    return a <= b ? 0 : 1;
  }

  /** Spawn point that maximises the distance to the nearest living enemy. */
  pickSpawn(team: Team, selfId = -1) {
    const teams = isTeamMode(this.match.mode);
    const enemies = [...this.players.values()].filter(p => p.id !== selfId && p.hp > 0 && (!teams || p.team !== team));
    const sided = this.map.spawns.filter(s => s.team === team);
    // elimination starts each side at its own end; other modes may also use neutral spawns
    const candidates = !teams ? this.map.spawns
      : this.match.mode === 'elim' && sided.length ? sided
      : this.map.spawns.filter(s => s.team === undefined || s.team === team);
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
      case 'respawn': return p.hp <= 0 && now - p.diedAt >= PLAYER.respawnMs && this.canRespawn() ? this.respawn(p) : [];
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
      case 'throw': return this.canAttack() ? this.nades.throw(this, id, msg, now) : [];
      case 'reload': return [];
      case 'join': return [];
    }
    return [];
  }

  private admin(msg: Extract<ClientMsg, { t: 'admin' }>, now: number): Outbox {
    if (msg.cmd === 'mode' && GAME_MODES.includes(msg.arg as GameMode)) {
      this.match.mode = msg.arg as GameMode;
      const out = this.startWarmup(now);
      // a new mode starts fresh: everyone back in, sides rebalanced for team modes
      if (isTeamMode(this.match.mode)) this.assignTeams();
      for (const p of this.players.values()) out.push(...this.respawn(p));
      out.push(this.scoreMsg());
      return out;
    }
    if (msg.cmd === 'restart') return this.startWarmup(now);
    if (msg.cmd === 'bots') return this.setBots(Number(msg.arg), now);
    if (msg.cmd === 'botdiff' && (msg.arg === 'easy' || msg.arg === 'normal' || msg.arg === 'hard')) { this.setBotDifficulty(msg.arg); return []; }
    return [];
  }

  shoot(p: ServerPlayer, msg: Extract<ClientMsg, { t: 'shoot' }>, now: number): Outbox {
    const w = WEAPONS[msg.w];
    if (!w || p.hp <= 0 || !this.canAttack()) return [];
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
    if (isTeamMode(this.match.mode) && t.team === shooter.team) return 0;
    if (this.match.phase === 'warmup' && false) return 0; // warmup damage is on; it is the fun part
    if (dist(origin, h.point) > w.range + 2) return 0;
    // the claimed hit point must be near where the server thinks the target is
    const dx = h.point[0] - t.p[0], dz = h.point[2] - t.p[2], dy = h.point[1] - t.p[1];
    if (Math.hypot(dx, dz) > 1.6 || dy < -0.6 || dy > PLAYER.height + 0.8) return 0;
    if (w.id !== 'tag' && !hasLos(origin, h.point, this.solids)) return 0;
    if (w.id !== 'tag' && this.smokeBlocks(origin, h.point)) return 0;
    const dmg = Math.round(w.damage * (h.part === 'head' ? w.headshot : 1));
    return dmg;
  }

  /** A player is marked out. `kills`/`deaths` are marks/marked on the scoreboard. */
  private kill(killer: ServerPlayer, victim: ServerPlayer, w: WeaponId, headshot: boolean, now: number, nade?: 'paint'): Outbox {
    victim.deaths++;
    victim.diedAt = now;
    killer.kills++;
    if (this.match.mode === 'tdm') this.match.teamScore[killer.team]++;
    const out: Outbox = [{ to: 'all', msg: { t: 'kill', killer: killer.id, victim: victim.id, w, headshot, ...(nade ? { nade } : {}) } }];
    out.push(this.scoreMsg());
    if (this.match.phase === 'live') {
      if (this.match.mode === 'elim') out.push(...this.checkWipe(now));
      else {
        const top = this.match.mode === 'tdm' ? Math.max(...this.match.teamScore) : killer.kills;
        if (top >= MATCH.killLimit) out.push(...this.endMatch(now));
      }
    }
    return out;
  }

  private respawn(p: ServerPlayer): Outbox {
    const s = this.pickSpawn(p.team, p.id);
    p.p = [...s.p] as Vec3; p.yaw = s.yaw; p.pitch = 0; p.hp = PLAYER.maxHp; p.crouch = false;
    if (WEAPONS[p.w].slot !== 1) p.w = DEFAULT_PRIMARY;
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
    for (const p of [...this.players.values()]) if (p.gone && now - p.gone > RECONNECT_GRACE_MS) out.push(...this.leave(p.id));
    if (this.match.mode === 'elim' && this.match.phase === 'live') out.push(...this.tickRound(now));
    else if (now >= this.match.endsAt) {
      if (this.match.phase === 'warmup') out.push(...this.startLive(now));
      else if (this.match.phase === 'live') out.push(...this.endMatch(now));
      else out.push(...this.startWarmup(now));
    }
    out.push(...this.bots.tick(this, now));
    out.push(...this.nades.tick(this, now));
    if (this.canRespawn()) for (const p of this.players.values()) {
      if (p.hp <= 0 && now - p.diedAt >= PLAYER.respawnMs + 4000) out.push(...this.respawn(p));
    }
    out.push({ to: 'all', msg: { t: 'state', now, players: [...this.players.values()].map(p => ({ id: p.id, p: p.p, yaw: p.yaw, pitch: p.pitch, hp: p.hp, w: p.w, crouch: p.crouch, moving: p.moving, ground: p.ground })) } });
    return out;
  }

  startWarmup(now: number): Outbox {
    this.match.phase = 'warmup';
    this.match.endsAt = now + MATCH.warmupMs;
    delete this.match.round;
    return [{ to: 'all', msg: { t: 'match', match: this.match } }];
  }

  startLive(now: number): Outbox {
    this.match.phase = 'live';
    this.match.endsAt = now + MATCH.durationMs;
    this.match.teamScore = [0, 0];
    delete this.match.round;
    // rebalance teams at the start of every match
    if (isTeamMode(this.match.mode)) this.assignTeams();
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; }
    if (this.match.mode === 'elim') return [...this.startRound(1, now), this.scoreMsg()];
    const out: Outbox = [];
    for (const p of this.players.values()) out.push(...this.respawn(p));
    out.push({ to: 'all', msg: { t: 'match', match: this.match } }, this.scoreMsg());
    return out;
  }

  endMatch(now: number): Outbox {
    this.match.phase = 'over';
    this.match.endsAt = now + MATCH.overMs;
    return [{ to: 'all', msg: { t: 'match', match: this.match } }, this.scoreMsg()];
  }

  private assignTeams() {
    const sorted = [...this.players.values()].sort((a, b) => a.id - b.id);
    sorted.forEach((p, i) => { p.team = (i % 2) as Team; });
  }

  // ----- elimination rounds ----------------------------------------------

  /** Respawning is off while an elimination match is live: marked players sit out the round. */
  canRespawn(): boolean { return !(this.match.mode === 'elim' && this.match.phase === 'live'); }

  /** Shots and grenades count: not after the match, not in an elimination freeze or round-over banner. */
  canAttack(): boolean {
    if (this.match.phase === 'over') return false;
    const r = this.match.round;
    return !(this.match.mode === 'elim' && this.match.phase === 'live' && r && r.stage !== 'live');
  }

  /** Everyone back in at their side's spawns; a freeze where you can move but not shoot. */
  startRound(n: number, now: number): Outbox {
    this.match.round = { n, stage: 'freeze' };
    this.match.endsAt = now + ELIM.freezeMs;
    this.nades.flying = [];
    this.smokes.length = 0;
    const out: Outbox = [];
    for (const p of this.players.values()) out.push(...this.respawn(p));
    out.push({ to: 'all', msg: { t: 'match', match: this.match } });
    return out;
  }

  private endRound(winner: Team | -1, why: 'wipe' | 'time', now: number): Outbox {
    const r = this.match.round;
    if (!r || r.stage === 'over') return [];
    r.stage = 'over'; r.winner = winner; r.why = why;
    if (winner !== -1) this.match.teamScore[winner]++;
    this.match.endsAt = now + ELIM.roundOverMs;
    return [{ to: 'all', msg: { t: 'match', match: this.match } }, this.scoreMsg()];
  }

  /** Living players per side, and whether each side has anyone at all. */
  private sides() {
    const alive: [number, number] = [0, 0], present: [number, number] = [0, 0];
    for (const p of this.players.values()) { present[p.team]++; if (p.hp > 0) alive[p.team]++; }
    return { alive, present };
  }

  /** A side with players and nobody left standing loses the round. A side with nobody in it never "wipes". */
  private checkWipe(now: number): Outbox {
    const r = this.match.round;
    if (!r || r.stage !== 'live') return [];
    const { alive, present } = this.sides();
    if (!present[0] || !present[1]) return [];
    const out0 = alive[0] === 0, out1 = alive[1] === 0;
    if (out0 && out1) return this.endRound(-1, 'wipe', now);
    if (out0) return this.endRound(1, 'wipe', now);
    if (out1) return this.endRound(0, 'wipe', now);
    return [];
  }

  private tickRound(now: number): Outbox {
    const r = this.match.round;
    if (!r) return this.startRound(1, now);
    if (r.stage === 'live') {
      const out = this.checkWipe(now);
      if (out.length) return out;
    }
    if (now < this.match.endsAt) return [];
    if (r.stage === 'freeze') {
      r.stage = 'live';
      this.match.endsAt = now + ELIM.roundMs;
      return [{ to: 'all', msg: { t: 'match', match: this.match } }];
    }
    if (r.stage === 'live') return this.endRound(ELIM.defenders, 'time', now);
    // round-over banner done: next round or the match is decided
    if (Math.max(...this.match.teamScore) >= ELIM.roundsToWin) return this.endMatch(now);
    return this.startRound(r.n + 1, now);
  }

  // ----- grenades workstream additions -----------------------------------

  /** Hits from a validated shot or a paint burst: hp, hit, mark-out, score. `w` defaults to what the attacker holds; `nade` tags a grenade mark. */
  applyDamage(fromId: number, toId: number, dmg: number, head: boolean, now: number, w?: WeaponId, nade?: 'paint'): Outbox {
    const p = this.players.get(fromId), t = this.players.get(toId);
    if (!p || !t || t.hp <= 0 || !this.canAttack()) return [];
    t.hp = Math.max(0, t.hp - dmg);
    const out: Outbox = [{ to: 'all', msg: { t: 'hit', from: p.id, to: t.id, dmg, part: head ? 'head' : 'body', hp: t.hp } }];
    if (t.hp === 0) out.push(...this.kill(p, t, w ?? p.w, head, now, nade));
    return out;
  }

  /** True when an active smoke sphere lies across the segment a→b. */
  smokeBlocks(a: Vec3, b: Vec3): boolean { return smokeBlocks(a, b, this.smokes); }
}
