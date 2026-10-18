import { describe, expect, it } from 'vitest';
import { ARCADE } from '../src/shared/map';
import { PLAYER, PRIMARY_WEAPONS } from '../src/shared/constants';
import { canStand, solidBoxes } from '../src/shared/physics';
import { BOT_NAMES, NavGrid } from '../src/worker/bots';
import { Game } from '../src/worker/game';

const solids = solidBoxes(ARCADE.boxes);

describe('nav grid', () => {
  const nav = new NavGrid(ARCADE);

  it('reaches every spawn from every other spawn', () => {
    const cells = nav.spawns();
    expect(cells.length).toBe(ARCADE.spawns.length);
    for (const a of cells) for (const b of cells) expect(nav.reaches(a, b)).toBe(true);
  });

  it('is built once per game', () => {
    const g = new Game('arcade', 0);
    expect(g.nav()).toBe(g.nav());
    g.tick(50);
    expect(g.nav()).toBe(g.nav());
  });
});

describe('bots', () => {
  it('admin bots adds named bots and snapshots mark bot: true', () => {
    const g = new Game('arcade', 0);
    const host = g.join('Host', 'astro', 0);
    if (!('player' in host)) throw new Error('join failed');
    const out = g.handle(host.player.id, { t: 'admin', cmd: 'bots', arg: 2 }, 1000);
    const bots = [...g.players.values()].filter(p => p.bot);
    expect(bots.map(b => b.name)).toEqual(['Night Guard', 'Umpire']);
    expect(bots.every(b => PRIMARY_WEAPONS.includes(b.w))).toBe(true);
    expect(g.snapshot(bots[0]).bot).toBe(true);
    expect(out.some(o => o.msg.t === 'join' && o.msg.player.bot === true)).toBe(true);
    g.handle(host.player.id, { t: 'admin', cmd: 'bots', arg: 0 }, 2000);
    expect([...g.players.values()].some(p => p.bot)).toBe(false);
  });

  it('balances teams in tdm', () => {
    const g = new Game('arcade', 0, 'tdm');
    g.join('Host', 'astro', 0);
    g.setBots(5, 0);
    const count = (t: 0 | 1) => [...g.players.values()].filter(p => p.team === t).length;
    expect(Math.abs(count(0) - count(1))).toBeLessThanOrEqual(1);
    for (const p of g.players.values()) if (p.bot) p.team = 0;
    g.setBots(5, 0);
    expect(Math.abs(count(0) - count(1))).toBeLessThanOrEqual(1);
  });

  it('removes bots when the last human leaves', () => {
    const g = new Game('arcade', 0);
    const host = g.join('Host', 'astro', 0);
    if (!('player' in host)) throw new Error('join failed');
    g.setBots(3, 0);
    expect(g.humanCount()).toBe(1);
    g.leave(host.player.id);
    expect(g.players.size).toBe(0);
    expect(g.humanCount()).toBe(0);
  });

  it('kills a stationary target within 10 simulated seconds', () => {
    const g = new Game('arcade', 0);
    const host = g.join('Target', 'astro', 0);
    if (!('player' in host)) throw new Error('join failed');
    g.setBots(1, 0);
    const bot = [...g.players.values()].find(p => p.bot)!;
    bot.w = 'rifle';
    bot.p = [-24, 0, 0];
    host.player.p = [-16, 0, 0];
    let killedAt = -1;
    for (let i = 1; i <= 200; i++) {
      g.tick(i * 50);
      if (host.player.hp <= 0) { killedAt = i * 50; break; }
    }
    expect(killedAt, `target hp ${host.player.hp}`).toBeGreaterThan(0);
    expect(killedAt).toBeLessThanOrEqual(10_000);
  });

  it('keeps 4 bots inside the map and out of solids for 60s', () => {
    const g = new Game('arcade', 0);
    g.setBots(4, 0);
    let travel = 0;
    const prev = new Map<number, [number, number]>();
    for (const p of g.players.values()) prev.set(p.id, [p.p[0], p.p[2]]);
    for (let i = 1; i <= 1200; i++) {
      g.tick(i * 50);
      for (const p of g.players.values()) {
        if (!p.bot) continue;
        const inside = Math.abs(p.p[0]) <= ARCADE.half && Math.abs(p.p[2]) <= ARCADE.half;
        const free = canStand(p.p, solids);
        if (!inside || !free) throw new Error(`${p.name} t=${i} p=${p.p.map(n => n.toFixed(2)).join(',')} inside=${inside} free=${free}`);
        const was = prev.get(p.id)!;
        travel += Math.hypot(p.p[0] - was[0], p.p[2] - was[1]);
        prev.set(p.id, [p.p[0], p.p[2]]);
      }
    }
    expect(travel).toBeGreaterThan(30);
  });

  it('ticks 6 bots in under 3ms on average', () => {
    const g = new Game('arcade', 0);
    g.join('Host', 'astro', 0);
    g.setBots(6, 0);
    for (const p of g.players.values()) if (p.bot) expect(BOT_NAMES).toContain(p.name);
    g.tick(50); // grid is built lazily, before the measured window
    const n = 100;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) g.tick(100 + i * 50);
    const avg = (performance.now() - t0) / n;
    expect(avg).toBeLessThan(3);
  });
});

describe('bot respawn', () => {
  it('comes back after the same delay as a player', () => {
    const g = new Game('arcade', 0);
    g.join('Host', 'astro', 0);
    g.setBots(1, 0);
    const bot = [...g.players.values()].find(p => p.bot)!;
    bot.hp = 0;
    bot.diedAt = 1000;
    g.tick(1000 + PLAYER.respawnMs - 50);
    expect(bot.hp).toBe(0);
    g.tick(1000 + PLAYER.respawnMs);
    expect(bot.hp).toBe(PLAYER.maxHp);
  });
});
