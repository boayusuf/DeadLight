import { describe, expect, it } from 'vitest';
import { inradius } from './arena.js';
import {
  BLACKOUT_MIN_MS,
  MOVE_SPEED,
  PLAYER_RADIUS,
  STANDARD_ARENA,
  TICK_MS,
} from './constants.js';
import { openWorld, type Obstacle, type World } from './maps.js';
import { stepPlayer } from './movement.js';

const SIZE = 1200;
const WORLD = openWorld(SIZE);
const DT = TICK_MS / 1000;

/** Runs the same integration the server loop runs. */
function travel(mx: number, my: number, seconds: number) {
  const steps = Math.round(seconds / DT);
  let at = { x: 0, y: 0 };
  for (let i = 0; i < steps; i++) at = stepPlayer(at, mx, my, DT, WORLD);
  return at;
}

describe('stepPlayer', () => {
  it('stays put without input', () => {
    expect(stepPlayer({ x: 10, y: -4 }, 0, 0, DT, WORLD)).toEqual({ x: 10, y: -4 });
  });

  it('covers move speed over one second', () => {
    const end = travel(1, 0, 1);
    expect(end.x).toBeCloseTo(MOVE_SPEED, 0);
  });

  it('gives diagonals no speed advantage', () => {
    const straight = travel(1, 0, 1);
    const diagonal = travel(1, 1, 1);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(Math.hypot(straight.x, straight.y), 6);
  });

  it('ignores an oversized input vector from a client', () => {
    const honest = travel(1, 0, 1);
    const cheating = travel(40, 0, 1);
    expect(cheating.x).toBeCloseTo(honest.x, 6);
  });

  it('keeps a player inside the wall, including into a corner', () => {
    for (const [mx, my] of [
      [1, 0],
      [1, 1],
      [-1, 1],
    ] as const) {
      const end = travel(mx, my, 20);
      const limit = inradius(SIZE) - PLAYER_RADIUS + 1e-6;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        expect(end.x * Math.cos(a) + end.y * Math.sin(a)).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('crosses the standard arena within the shortest blackout', () => {
    // In a match of up to six, wherever you were seen you can reach the far
    // wall before the lights come back. Bigger lobbies get a bigger room.
    const reach = MOVE_SPEED * (BLACKOUT_MIN_MS / 1000);
    expect(reach).toBeGreaterThanOrEqual(STANDARD_ARENA);
  });

  describe('with obstacles', () => {
    const world = (...obstacles: Obstacle[]): World => ({
      size: SIZE,
      layout: { id: 'factory', obstacles },
      broken: new Set(),
    });

    it('cannot walk through a pillar', () => {
      const w = world({ id: 'p', kind: 'pillar', x: 200, y: 0, r: 50 });
      let at = { x: 0, y: 0 };
      for (let i = 0; i < 60; i++) at = stepPlayer(at, 1, 0, DT, w);
      expect(at.x).toBeLessThanOrEqual(200 - 50 - PLAYER_RADIUS + 1e-6);
    });

    it('cannot walk through glass', () => {
      const w = world({ id: 'g', kind: 'glass', ax: 200, ay: -300, bx: 200, by: 300 });
      let at = { x: 0, y: 0 };
      for (let i = 0; i < 60; i++) at = stepPlayer(at, 1, 0, DT, w);
      expect(at.x).toBeLessThan(200);
    });

    it('drags someone who is not moving', () => {
      const w = world({ id: 'b', kind: 'conveyor', x: 0, y: 0, w: 400, h: 200, vx: 0, vy: 200 });
      const at = stepPlayer({ x: 0, y: 0 }, 0, 0, 0.5, w);
      expect(at.x).toBeCloseTo(0, 6);
      expect(at.y).toBeCloseTo(100, 6);
    });

    it('adds the drag to the walking speed', () => {
      const w = world({ id: 'b', kind: 'conveyor', x: 0, y: 0, w: 400, h: 200, vx: 100, vy: 0 });
      expect(stepPlayer({ x: 0, y: 0 }, 1, 0, 1, w).x).toBeCloseTo(MOVE_SPEED + 100, 6);
    });
  });
});
