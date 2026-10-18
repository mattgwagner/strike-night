import { describe, expect, it } from 'vitest';
import { ARCADE } from '../src/shared/map';
import { PLAYER } from '../src/shared/constants';
import { forward, hasLos, rayPlayer, rayWorld, solidBoxes, stepBody, type Body } from '../src/shared/physics';

const solids = solidBoxes(ARCADE.boxes);

function run(body: Body, wish: [number, number], seconds: number, jump = false) {
  const dt = 1 / 60;
  for (let i = 0; i < seconds * 60; i++) stepBody(body, wish, dt, solids, jump && i === 0);
  return body;
}

describe('stepBody', () => {
  it('lands on the floor and stays there', () => {
    const b = run({ p: [-22, 3, -22], v: [0, 0, 0], crouch: false, ground: false }, [0, 0], 2);
    expect(b.p[1]).toBeCloseTo(0, 3);
    expect(b.ground).toBe(true);
  });
  it('walks at walkSpeed on flat ground', () => {
    const b = run({ p: [-22, 0, -22], v: [0, 0, 0], crouch: false, ground: true }, [PLAYER.walkSpeed, 0], 1);
    expect(b.p[0]).toBeGreaterThan(-22 + PLAYER.walkSpeed * 0.95);
  });
  it('cannot walk through the outer wall', () => {
    const b = run({ p: [-26, 0, 0], v: [0, 0, 0], crouch: false, ground: true }, [-PLAYER.walkSpeed, 0], 2);
    expect(b.p[0]).toBeGreaterThanOrEqual(-ARCADE.half + PLAYER.radius - 0.01);
  });
  it('climbs the mid stairs onto the platform', () => {
    const b = run({ p: [-10, 0, -2], v: [0, 0, 0], crouch: false, ground: true }, [PLAYER.walkSpeed, 0], 2);
    expect(b.p[1]).toBeCloseTo(1, 1);
    expect(Math.abs(b.p[0])).toBeLessThan(5);
  });
  it('jump leaves the ground and comes back', () => {
    const b: Body = { p: [0, 1, 0], v: [0, 0, 0], crouch: false, ground: true };
    stepBody(b, [0, 0], 1 / 60, solids, true);
    expect(b.ground).toBe(false);
    expect(b.v[1]).toBeGreaterThan(0);
    run(b, [0, 0], 2);
    expect(b.ground).toBe(true);
    expect(b.p[1]).toBeCloseTo(1, 2);
  });
});

describe('rays', () => {
  it('rayWorld hits the outer wall at the expected distance', () => {
    const t = rayWorld([0, 2, 0], [0, 0, -1], solids);
    // mid cover wall at z=-12 (half thickness 0.3), 2.2 tall, blocks a ray at eye height 2
    expect(t).toBeCloseTo(11.7, 1);
  });
  it('rayPlayer distinguishes head from body', () => {
    const p = [0, 0, -10] as const;
    const head = rayPlayer([0, PLAYER.height - 0.1, 0], [0, 0, -1], [...p], false);
    const body = rayPlayer([0, 0.9, 0], [0, 0, -1], [...p], false);
    expect(head?.part).toBe('head');
    expect(body?.part).toBe('body');
    expect(rayPlayer([0, 0.9, 0], [1, 0, 0], [...p], false)).toBeNull();
  });
  it('forward(0,0) looks down -Z and hasLos respects walls', () => {
    expect(forward(0, 0)).toEqual([-0, 0, -1]);
    expect(hasLos([-22, 1, -22], [-20, 1, -22], solids)).toBe(true);
    expect(hasLos([-26, 1, 0], [-30, 1, 0], solids)).toBe(false);
  });
});
