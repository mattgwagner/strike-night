import { describe, expect, it } from 'vitest';
import { Game } from '../src/worker/game';
import { MATCH, PLAYER, WEAPONS, type WeaponId } from '../src/shared/constants';
import type { Vec3 } from '../src/shared/protocol';

function twoPlayers(now = 1000) {
  const g = new Game('arcade', now);
  const a = g.join('Alice', 'bot', now);
  const b = g.join('Bob', 'bear', now);
  if ('error' in a || 'error' in b) throw new Error('join failed');
  // 10m apart on open floor along the west wall, nothing between them
  a.player.p = [-26, 0, 0]; b.player.p = [-16, 0, 0];
  return { g, a: a.player, b: b.player };
}

function shotAt(g: Game, from: number, to: { id: number; p: Vec3 }, part: 'head' | 'body', now: number, w: WeaponId = 'semi') {
  const s = g.players.get(from)!;
  const o: Vec3 = [s.p[0], s.p[1] + PLAYER.eyeHeight, s.p[2]];
  const y = part === 'head' ? PLAYER.height - 0.1 : 0.9;
  const point: Vec3 = [to.p[0], to.p[1] + y, to.p[2]];
  const d: Vec3 = [point[0] - o[0], point[1] - o[1], point[2] - o[2]];
  return g.handle(from, { t: 'shoot', w, o, d, hits: [{ id: to.id, part, point }] }, now);
}

describe('Game', () => {
  it('welcomes the joiner and announces to everyone', () => {
    const { a } = twoPlayers();
    expect(a.id).toBe(1);
    const g = new Game();
    const r = g.join('<script>Eve', 'ghost', 0);
    expect('player' in r && r.player.name).toBe('scriptEve');
    expect('out' in r && r.out.map(o => o.msg.t)).toEqual(['welcome', 'join']);
  });

  it('body mark takes one hit, head mark two, marked out awards a mark', () => {
    const { g, b } = twoPlayers();
    let out = shotAt(g, 1, b, 'body', 2000);
    expect(out.map(o => o.msg.t)).toEqual(['shot', 'hit']);
    expect(b.hp).toBe(2);
    out = shotAt(g, 1, b, 'head', 3000);
    expect(b.hp).toBe(0);
    expect(out.map(o => o.msg.t)).toEqual(['shot', 'hit', 'kill', 'score']);
    expect(g.players.get(1)!.kills).toBe(1);
    expect(b.deaths).toBe(1);
  });

  it('rejects shots that fire faster than the weapon allows', () => {
    const { g, b } = twoPlayers();
    shotAt(g, 1, b, 'body', 2000);
    const out = shotAt(g, 1, b, 'body', 2010);
    expect(out).toEqual([]);
    expect(b.hp).toBe(PLAYER.maxHp - WEAPONS.semi.damage);
  });

  it('rejects hits whose claimed point is far from the target', () => {
    const { g, b } = twoPlayers();
    const out = g.handle(1, { t: 'shoot', w: 'semi', o: [-26, PLAYER.eyeHeight, 0], d: [1, 0, 0], hits: [{ id: 2, part: 'body', point: [-16, 1, 5] }] }, 2000);
    expect(out.map(o => o.msg.t)).toEqual(['shot']);
    expect(b.hp).toBe(PLAYER.maxHp);
  });

  it('rejects hits through walls', () => {
    const { g, a, b } = twoPlayers();
    // target behind the mid cover wall at z=-12 (y 0..2.2); shooter in front of it
    a.p = [0, 0, -8]; b.p = [0, 0, -16];
    const out = g.handle(1, { t: 'shoot', w: 'semi', o: [0, PLAYER.eyeHeight, -8], d: [0, 0, -1], hits: [{ id: 2, part: 'body', point: [0, 0.9, -16] }] }, 2000);
    expect(out.map(o => o.msg.t)).toEqual(['shot']);
    expect(b.hp).toBe(PLAYER.maxHp);
  });

  it('hand tag only reaches 2.2m and marks out instantly', () => {
    const { g, b } = twoPlayers();
    expect(shotAt(g, 1, b, 'body', 2000, 'tag').map(o => o.msg.t)).toEqual(['shot']);
    b.p = [-24.5, 0, 0];
    expect(shotAt(g, 1, b, 'body', 3000, 'tag').map(o => o.msg.t)).toEqual(['shot', 'hit', 'kill', 'score']);
    expect(b.hp).toBe(0);
  });

  it('dead players cannot shoot and respawn after the delay', () => {
    const { g, b } = twoPlayers();
    shotAt(g, 1, b, 'head', 2000, 'pump');
    expect(b.hp).toBe(0);
    expect(g.handle(2, { t: 'shoot', w: 'semi', o: [-16, 1.6, 0], d: [-1, 0, 0], hits: [] }, 2100)).toEqual([]);
    expect(g.handle(2, { t: 'respawn' }, 2500)).toEqual([]);
    const out = g.handle(2, { t: 'respawn' }, 2000 + PLAYER.respawnMs);
    expect(out[0].msg.t).toBe('spawn');
    expect(b.hp).toBe(PLAYER.maxHp);
  });

  it('match flows warmup -> live -> over -> warmup and resets scores', () => {
    const { g, a } = twoPlayers(0);
    expect(g.match.phase).toBe('warmup');
    let out = g.tick(MATCH.warmupMs + 1);
    expect(g.match.phase).toBe('live');
    expect(out.some(o => o.msg.t === 'match')).toBe(true);
    a.kills = 5;
    out = g.tick(MATCH.warmupMs + MATCH.durationMs + 2);
    expect(g.match.phase).toBe('over');
    g.tick(MATCH.warmupMs + MATCH.durationMs + MATCH.overMs + 3);
    expect(g.match.phase).toBe('warmup');
    g.tick(2 * MATCH.warmupMs + MATCH.durationMs + MATCH.overMs + 4);
    expect(g.match.phase).toBe('live');
    expect(a.kills).toBe(0);
  });

  it('kill limit ends a live match', () => {
    const { g, a, b } = twoPlayers(0);
    g.tick(MATCH.warmupMs + 1);
    a.kills = MATCH.killLimit - 1;
    a.p = [-26, 0, 0]; b.p = [-16, 0, 0];
    shotAt(g, 1, b, 'head', MATCH.warmupMs + 500, 'pump');
    expect(g.match.phase).toBe('over');
  });

  it('tdm: no friendly fire, teams balanced, team score counts', () => {
    const g = new Game('arcade', 0, 'tdm');
    const ids = ['A', 'B', 'C', 'D'].map(n => { const r = g.join(n, 'bot', 0); return 'player' in r ? r.player : null!; });
    expect(ids.map(p => p.team)).toEqual([0, 1, 0, 1]);
    ids[0].p = [-26, 0, 0]; ids[2].p = [-16, 0, 0]; ids[1].p = [-21, 0, 0];
    const friendly = g.handle(1, { t: 'shoot', w: 'semi', o: [-26, PLAYER.eyeHeight, 0], d: [1, 0, 0], hits: [{ id: 3, part: 'body', point: [-16, 0.9, 0] }] }, 1000);
    expect(friendly.map(o => o.msg.t)).toEqual(['shot']);
    g.handle(1, { t: 'shoot', w: 'pump', o: [-26, PLAYER.eyeHeight, 0], d: [1, 0, 0], hits: [{ id: 2, part: 'head', point: [-21, 1.7, 0] }] }, 3000);
    expect(g.match.teamScore).toEqual([1, 0]);
  });

  it('spawns away from enemies', () => {
    const { g, a } = twoPlayers();
    a.p = [-22, 0, -22];
    for (let i = 0; i < 10; i++) {
      const s = g.pickSpawn(0, 2);
      expect(Math.hypot(s.p[0] - a.p[0], s.p[2] - a.p[2])).toBeGreaterThan(20);
    }
  });
});

describe('hits model', () => {
  it('three body marks with the semi take you out', () => {
    expect(PLAYER.maxHp).toBe(3);
    const { g, b } = twoPlayers();
    const hp: number[] = [];
    for (let i = 0; i < 3; i++) { shotAt(g, 1, b, 'body', 2000 + i * 500, 'semi'); hp.push(b.hp); }
    expect(hp).toEqual([2, 1, 0]);
    expect(b.deaths).toBe(1);
  });

  it('auto and sidearm body marks are one hit too', () => {
    const { g, b } = twoPlayers();
    shotAt(g, 1, b, 'body', 2000, 'auto');
    expect(b.hp).toBe(2);
    shotAt(g, 1, b, 'body', 3000, 'pistol');
    expect(b.hp).toBe(1);
  });

  it('two head marks take you out (2 hits each, clamped at 0)', () => {
    const { g, b } = twoPlayers();
    const out = shotAt(g, 1, b, 'head', 2000, 'semi');
    expect(b.hp).toBe(1);
    const hit = out.find(o => o.msg.t === 'hit')!.msg;
    expect(hit.t === 'hit' && hit.dmg).toBe(2);
    shotAt(g, 1, b, 'head', 3000, 'semi');
    expect(b.hp).toBe(0);
  });

  it('the pump marks out in one, body or head', () => {
    for (const part of ['body', 'head'] as const) {
      const { g, b } = twoPlayers();
      const out = shotAt(g, 1, b, part, 2000, 'pump');
      expect(b.hp).toBe(0);
      const k = out.find(o => o.msg.t === 'kill')!.msg;
      expect(k.t === 'kill' && k.w).toBe('pump');
      expect(k.t === 'kill' && k.nade).toBeUndefined();
    }
  });

  it('respawn restores all three hits', () => {
    const { g, b } = twoPlayers();
    shotAt(g, 1, b, 'body', 2000, 'pump');
    g.handle(2, { t: 'respawn' }, 2000 + PLAYER.respawnMs);
    expect(b.hp).toBe(3);
  });
});

describe('reconnect grace', () => {
  it('a dropped socket keeps the player for the grace period, then leaves', async () => {
    const { RECONNECT_GRACE_MS } = await import('../src/shared/protocol');
    const g = new Game('arcade', 0);
    const r = g.join('Amy', 'ghost', 0);
    if (!('player' in r)) throw new Error('join failed');
    r.player.kills = 4;
    expect(g.disconnect(r.player.id, 1000)).toEqual([]);
    g.tick(1000 + RECONNECT_GRACE_MS - 1);
    expect(g.players.has(r.player.id)).toBe(true);
    const out = g.tick(1000 + RECONNECT_GRACE_MS + 1);
    expect(g.players.has(r.player.id)).toBe(false);
    expect(out.some(o => o.msg.t === 'leave')).toBe(true);
  });

  it('rejoining with the welcome token keeps id and score; a bad token does not', () => {
    const g = new Game('arcade', 0);
    const r = g.join('Amy', 'ghost', 0);
    if (!('player' in r)) throw new Error('join failed');
    const welcome = r.out[0].msg;
    if (welcome.t !== 'welcome') throw new Error('no welcome');
    expect(welcome.token).toHaveLength(24);
    r.player.kills = 4;
    g.disconnect(r.player.id, 1000);
    const back = g.rejoin(welcome.token, 2000);
    expect(back?.player.id).toBe(r.player.id);
    expect(back?.player.kills).toBe(4);
    expect(back?.player.gone).toBe(0);
    expect(back?.out[0].msg.t).toBe('welcome');
    expect(g.rejoin('nope', 2000)).toBeNull();
    expect(g.rejoin('', 2000)).toBeNull();
    // bots never carry a token
    g.setBots(1, 0);
    const bot = [...g.players.values()].find(p => p.bot)!;
    expect(bot.token).toBe('');
  });
});
