// Server-side grenades: who carries what, projectiles in flight, and how they
// resolve. Game owns one of these and calls it from handle/tick/respawn.
import { PLAYER } from '../shared/constants';
import type { MapData } from '../shared/map';
import { bulletBoxes, dist, hasLos, solidBoxes } from '../shared/physics';
import {
  GRENADE, GRENADE_KINDS, GRENADES_PER_LIFE, PAINT, SMOKE, stepProjectile,
  throwVelocity, type GrenadeKind, type ProjState, type SmokeVolume,
} from '../shared/projectiles';
import type { ClientMsg, ServerMsg, Vec3 } from '../shared/protocol';

type Out = Array<{ to: 'all' | number; msg: ServerMsg }>;

/** The parts of Game this module needs (keeps the import one-way). */
export interface NadeHost {
  players: Map<number, { id: number; p: Vec3; hp: number; team: 0 | 1; crouch: boolean }>;
  match: { mode: string; phase: string };
  smokes: SmokeVolume[];
  /** The same damage path a validated shot uses (hp, hit, kill, score). */
  applyDamage(fromId: number, toId: number, dmg: number, head: boolean, now: number): Out;
}

export interface Projectile extends ProjState { id: number; kind: GrenadeKind; owner: number; bornAt: number }

export class Projectiles {
  flying: Projectile[] = [];
  private carry = new Map<number, Record<GrenadeKind, number>>();
  private nextId = 1;
  private solids;
  private blockers;
  private half: number;

  constructor(map: MapData) {
    this.solids = solidBoxes(map.boxes);
    this.blockers = bulletBoxes(map.boxes);
    this.half = map.half;
  }

  /** What a player has left this life. */
  left(id: number): Record<GrenadeKind, number> {
    let c = this.carry.get(id);
    if (!c) { c = { ...GRENADES_PER_LIFE }; this.carry.set(id, c); }
    return c;
  }

  /** New life, full pouch. */
  refill(id: number) { this.carry.set(id, { ...GRENADES_PER_LIFE }); }

  forget(id: number) { this.carry.delete(id); }

  throw(host: NadeHost, id: number, msg: Extract<ClientMsg, { t: 'throw' }>, now: number): Out {
    const p = host.players.get(id);
    if (!p || p.hp <= 0 || host.match.phase === 'over') return [];
    if (!GRENADE_KINDS.includes(msg.kind)) return [];
    const ok = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
    if (!ok(msg.o) || !ok(msg.d) || Math.hypot(msg.d[0], msg.d[1], msg.d[2]) < 1e-6) return [];
    const eye: Vec3 = [p.p[0], p.p[1] + PLAYER.eyeHeight, p.p[2]];
    if (dist(eye, msg.o) > 4) return [];
    const c = this.left(id);
    if (c[msg.kind] <= 0) return [];
    c[msg.kind]--;
    const pr: Projectile = {
      id: this.nextId++, kind: msg.kind, owner: id, bornAt: now,
      p: [msg.o[0], msg.o[1], msg.o[2]], v: throwVelocity(msg.d, Number(msg.power)), bounces: 0, landed: false,
    };
    this.flying.push(pr);
    return [{ to: 'all', msg: this.projMsg(pr, now) }];
  }

  private projMsg(pr: Projectile, now: number): ServerMsg {
    return { t: 'proj', id: pr.id, kind: pr.kind, p: [...pr.p] as Vec3, v: [...pr.v] as Vec3, owner: pr.owner, now };
  }

  /** One server tick: step everything, resolve what is done, drop stale smoke. */
  tick(host: NadeHost, now: number): Out {
    const out: Out = [];
    if (host.smokes.length) host.smokes.splice(0, host.smokes.length, ...host.smokes.filter(s => s.until > now));
    const still: Projectile[] = [];
    for (const pr of this.flying) {
      stepProjectile(pr, GRENADE.dt, this.solids, this.half);
      const age = now - pr.bornAt;
      if (pr.kind === 'paint' && (age >= PAINT.fuseMs || pr.bounces >= PAINT.bounces || age >= GRENADE.lifeMs)) {
        out.push(...this.burst(host, pr, now));
      } else if (pr.kind === 'smoke' && (pr.landed || age >= SMOKE.fuseMs)) {
        const s: SmokeVolume = { id: pr.id, p: [pr.p[0], pr.p[1], pr.p[2]], until: now + SMOKE.durationMs };
        host.smokes.push(s);
        out.push({ to: 'all', msg: { t: 'smoke', id: s.id, p: s.p, until: s.until } });
      } else {
        still.push(pr);
        out.push({ to: 'all', msg: this.projMsg(pr, now) });
      }
    }
    this.flying = still;
    return out;
  }

  /** Who a paint burst at `at` marks: within range, line of sight, not a teammate (owner too in team modes). */
  marks(host: NadeHost, owner: number, at: Vec3): number[] {
    const thrower = host.players.get(owner);
    const from: Vec3 = [at[0], at[1] + 0.15, at[2]];
    const hit: number[] = [];
    for (const t of host.players.values()) {
      if (t.hp <= 0) continue;
      if (host.match.mode === 'tdm' && thrower && t.team === thrower.team) continue;
      const h = t.crouch ? PLAYER.crouchHeight : PLAYER.height;
      // nearest point of the player's box
      const r = PLAYER.radius;
      const near: Vec3 = [
        Math.max(t.p[0] - r, Math.min(t.p[0] + r, from[0])),
        Math.max(t.p[1], Math.min(t.p[1] + h, from[1])),
        Math.max(t.p[2] - r, Math.min(t.p[2] + r, from[2])),
      ];
      if (dist(from, near) > PAINT.radius) continue;
      const targets: Vec3[] = [[t.p[0], t.p[1] + h * 0.5, t.p[2]], [t.p[0], t.p[1] + h - 0.15, t.p[2]], near];
      if (targets.some(q => hasLos(from, q, this.blockers))) hit.push(t.id);
    }
    return hit;
  }

  private burst(host: NadeHost, pr: Projectile, now: number): Out {
    const at: Vec3 = [pr.p[0], pr.p[1], pr.p[2]];
    const marked = host.match.phase === 'over' ? [] : this.marks(host, pr.owner, at);
    const out: Out = [{ to: 'all', msg: { t: 'burst', id: pr.id, kind: pr.kind, p: at, owner: pr.owner, marked } }];
    // a thrower who left the room cannot score; the paint still lands
    if (host.players.has(pr.owner)) for (const id of marked) out.push(...host.applyDamage(pr.owner, id, PAINT.damage, false, now));
    return out;
  }
}
