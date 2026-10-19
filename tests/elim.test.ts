import { describe, expect, it } from 'vitest';
import { ELIM, MATCH, PLAYER, type WeaponId } from '../src/shared/constants';
import type { ServerMsg, Vec3 } from '../src/shared/protocol';
import { Game, type ServerPlayer } from '../src/worker/game';

const LIVE = MATCH.warmupMs + 1;

/** Elimination room with four humans (teams 0,1,0,1), ticked into round 1's freeze. */
function elim() {
  const g = new Game('arcade', 0, 'elim');
  const ps = ['A', 'B', 'C', 'D'].map(n => { const r = g.join(n, 'astro', 0); if ('error' in r) throw new Error(r.error); return r.player; });
  g.tick(LIVE);
  return { g, a: ps[0], b: ps[1], c: ps[2], d: ps[3], t0: LIVE };
}

/** Open floor along the west wall: shooter at x=-26, target 10 m east. */
function lineUp(shooter: ServerPlayer, target: ServerPlayer) { shooter.p = [-26, 0, 0]; target.p = [-16, 0, 0]; }

function shoot(g: Game, s: ServerPlayer, t: ServerPlayer, now: number, w: WeaponId = 'pump') {
  const o: Vec3 = [s.p[0], s.p[1] + PLAYER.eyeHeight, s.p[2]];
  const point: Vec3 = [t.p[0], t.p[1] + 0.9, t.p[2]];
  return g.handle(s.id, { t: 'shoot', w, o, d: [1, 0, 0], hits: [{ id: t.id, part: 'body', point }] }, now);
}

const kinds = (out: Array<{ msg: ServerMsg }>) => out.map(o => o.msg.t);

/** End the freeze: the round goes live. Returns the live start time. */
function goLive(g: Game, t0: number) { const t = t0 + ELIM.freezeMs; g.tick(t); return t; }

/** Mark out both players on team 1 (b and d) from a (team 0). */
function wipeDay(g: Game, a: ServerPlayer, b: ServerPlayer, d: ServerPlayer, now: number) {
  lineUp(a, b); shoot(g, a, b, now);
  lineUp(a, d); return shoot(g, a, d, now + 1100);
}

describe('elimination rounds', () => {
  it('starts round 1 in a freeze with teams on their own spawns', () => {
    const { g, a, b } = elim();
    expect(g.match.phase).toBe('live');
    expect(g.match.round).toMatchObject({ n: 1, stage: 'freeze' });
    expect([a.team, b.team]).toEqual([0, 1]);
    for (const p of g.players.values()) {
      const s = g.map.spawns.find(sp => sp.p[0] === p.p[0] && sp.p[2] === p.p[2]);
      expect(s?.team).toBe(p.team);
    }
  });

  it('freeze: you can move but shots and grenades do nothing', () => {
    const { g, a, b, t0 } = elim();
    lineUp(a, b);
    expect(shoot(g, a, b, t0 + 100)).toEqual([]);
    expect(b.hp).toBe(PLAYER.maxHp);
    expect(g.handle(a.id, { t: 'throw', kind: 'paint', o: [-26, PLAYER.eyeHeight, 0], d: [1, 0, 0], power: 1 }, t0 + 200)).toEqual([]);
    expect(g.nades.flying.length).toBe(0);
    // movement still goes through
    g.handle(a.id, { t: 'input', p: [-25, 0, 0], yaw: 0, pitch: 0, crouch: false, moving: true, ground: true, w: 'semi' }, t0 + 300);
    expect(a.p[0]).toBe(-25);
    const live = goLive(g, t0);
    expect(g.match.round?.stage).toBe('live');
    expect(g.match.endsAt).toBe(live + ELIM.roundMs);
    lineUp(a, b);
    expect(kinds(shoot(g, a, b, live + 100))).toContain('kill');
  });

  it('a team wipe ends the round, scores it, and the next round puts everyone back in', () => {
    const { g, a, b, d, t0 } = elim();
    const live = goLive(g, t0);
    const out = wipeDay(g, a, b, d, live + 100);
    expect(kinds(out)).toContain('match');
    expect(g.match.round).toMatchObject({ n: 1, stage: 'over', winner: 0, why: 'wipe' });
    expect(g.match.teamScore).toEqual([1, 0]);
    // no shooting during the round-over banner
    lineUp(a, b); b.hp = PLAYER.maxHp;
    expect(shoot(g, a, b, live + 2500)).toEqual([]);
    b.hp = 0;
    g.tick(live + 1200 + ELIM.roundOverMs);
    expect(g.match.round).toMatchObject({ n: 2, stage: 'freeze' });
    for (const p of g.players.values()) expect(p.hp).toBe(PLAYER.maxHp);
  });

  it('a side with one player standing keeps the round going', () => {
    const { g, a, b, t0 } = elim();
    const live = goLive(g, t0);
    lineUp(a, b); shoot(g, a, b, live + 100);
    expect(g.match.round?.stage).toBe('live');
    g.tick(live + 200);
    expect(g.match.round?.stage).toBe('live');
  });

  it('on timeout the defending side (Day, team 1) takes the round', () => {
    const { g, t0 } = elim();
    const live = goLive(g, t0);
    g.tick(live + ELIM.roundMs - 50);
    expect(g.match.round?.stage).toBe('live');
    g.tick(live + ELIM.roundMs);
    expect(g.match.round).toMatchObject({ stage: 'over', winner: ELIM.defenders, why: 'time' });
    expect(g.match.teamScore[ELIM.defenders]).toBe(1);
  });

  it('first side to 7 rounds wins the match', () => {
    const { g, a, b, d, t0 } = elim();
    const live = goLive(g, t0);
    g.match.teamScore = [ELIM.roundsToWin - 1, 3];
    wipeDay(g, a, b, d, live + 100);
    expect(g.match.teamScore[0]).toBe(ELIM.roundsToWin);
    expect(g.match.phase).toBe('live'); // the round-over banner shows first
    g.tick(live + 1200 + ELIM.roundOverMs);
    expect(g.match.phase).toBe('over');
    expect(g.match.round?.winner).toBe(0);
  });

  it('6 rounds is not enough: the match goes on to round 7', () => {
    const { g, a, b, d, t0 } = elim();
    const live = goLive(g, t0);
    g.match.teamScore = [ELIM.roundsToWin - 2, 0];
    wipeDay(g, a, b, d, live + 100);
    g.tick(live + 1200 + ELIM.roundOverMs);
    expect(g.match.phase).toBe('live');
    expect(g.match.round?.n).toBe(2);
  });

  it('no respawn mid-round, by request or by the auto-respawn', () => {
    const { g, a, b, t0 } = elim();
    const live = goLive(g, t0);
    lineUp(a, b); shoot(g, a, b, live + 100);
    expect(b.hp).toBe(0);
    expect(g.handle(b.id, { t: 'respawn' }, live + 100 + PLAYER.respawnMs + 10)).toEqual([]);
    for (let t = live + 150; t <= live + 100 + PLAYER.respawnMs + 6000; t += 50) g.tick(t);
    expect(g.match.round?.stage).toBe('live');
    expect(b.hp).toBe(0);
  });

  it('bots do not respawn mid-round (they do in team paintball)', () => {
    for (const mode of ['elim', 'tdm'] as const) {
      const g = new Game('arcade', 0, mode);
      g.join('Host', 'astro', 0);
      g.setBots(3, 0);
      g.tick(LIVE);
      let t = mode === 'elim' ? goLive(g, LIVE) : LIVE;
      const bot = [...g.players.values()].find(p => p.bot && p.team === 1)!;
      bot.hp = 0; bot.diedAt = t;
      let watched = 0;
      for (let i = 0; i < 120; i++) {
        t += 50;
        g.tick(t);
        if (mode === 'elim' && g.match.round?.n !== 1) break;
        watched += 50;
        if (mode === 'elim') expect(bot.hp, `t+${watched}`).toBe(0);
      }
      if (mode === 'elim') expect(watched).toBeGreaterThan(PLAYER.respawnMs + 500);
      else expect(bot.hp).toBe(PLAYER.maxHp);
    }
  });

  it('someone joining mid-round sits out until the next round', () => {
    const { g, t0 } = elim();
    const live = goLive(g, t0);
    const r = g.join('Late', 'chef', live + 500);
    if ('error' in r) throw new Error(r.error);
    expect(r.player.hp).toBe(0);
    g.tick(live + ELIM.roundMs);
    g.tick(live + ELIM.roundMs + ELIM.roundOverMs);
    expect(g.match.round?.n).toBe(2);
    expect(r.player.hp).toBe(PLAYER.maxHp);
  });

  it('marks still count on the scoreboard, but team score is rounds, not marks', () => {
    const { g, a, b, t0 } = elim();
    const live = goLive(g, t0);
    lineUp(a, b); shoot(g, a, b, live + 100);
    expect(a.kills).toBe(1);
    expect(b.deaths).toBe(1);
    expect(g.match.teamScore).toEqual([0, 0]);
  });

  it('mode switch from the pause menu accepts elim and starts a warmup', () => {
    const g = new Game('arcade', 0);
    const r = g.join('Host', 'astro', 0);
    if ('error' in r) throw new Error(r.error);
    expect(g.match.mode).toBe('ffa');
    g.handle(r.player.id, { t: 'admin', cmd: 'mode', arg: 'elim' }, 100);
    expect(g.match.mode).toBe('elim');
    expect(g.match.phase).toBe('warmup');
    g.handle(r.player.id, { t: 'admin', cmd: 'mode', arg: 'nope' }, 200);
    expect(g.match.mode).toBe('elim');
  });
});
