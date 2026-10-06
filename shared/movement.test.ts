import { describe, expect, it } from 'vitest';
import { inradius } from './arena.js';
import {
  ARENA_BASE_SIZE,
  BLACKOUT_MIN_MS,
  MOVE_SPEED,
  PLAYER_RADIUS,
  TICK_MS,
} from './constants.js';
import { stepPlayer } from './movement.js';

const SIZE = 1200;
const DT = TICK_MS / 1000;

/** Runs the same integration the server loop runs. */
function travel(mx: number, my: number, seconds: number) {
  const steps = Math.round(seconds / DT);
  let at = { x: 0, y: 0 };
  for (let i = 0; i < steps; i++) at = stepPlayer(at, mx, my, DT, SIZE);
  return at;
}

describe('stepPlayer', () => {
  it('stays put without input', () => {
    expect(stepPlayer({ x: 10, y: -4 }, 0, 0, DT, SIZE)).toEqual({ x: 10, y: -4 });
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

  it('covers the widest arena within the shortest blackout', () => {
    // Relocation is meant to be unrestricted: wherever you were seen, you can
    // reach anywhere else before the lights come back.
    const reach = MOVE_SPEED * (BLACKOUT_MIN_MS / 1000);
    const widest = Math.max(...Object.values(ARENA_BASE_SIZE));
    expect(reach).toBeGreaterThanOrEqual(widest);
  });
});
