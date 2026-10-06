import { describe, expect, it } from 'vitest';
import { arenaSize, clampToArena, inradius, rayToWall, spawnPoints } from './arena.js';
import { PLAYER_RADIUS } from './constants.js';

const SIZE = 1200;

/** Largest distance from the centre that is still inside the octagon, per direction. */
function insideWithMargin(p: { x: number; y: number }, size: number, margin: number) {
  const limit = inradius(size) - margin + 1e-6;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    if (p.x * Math.cos(a) + p.y * Math.sin(a) > limit) return false;
  }
  return true;
}

describe('arena', () => {
  it('leaves interior points untouched', () => {
    expect(clampToArena({ x: 100, y: -50 }, SIZE)).toEqual({ x: 100, y: -50 });
  });

  it('pulls outside points back in, including at corners', () => {
    for (const p of [
      { x: 5000, y: 0 },
      { x: 700, y: 700 },
      { x: -2000, y: 1500 },
    ]) {
      expect(insideWithMargin(clampToArena(p, SIZE, PLAYER_RADIUS), SIZE, PLAYER_RADIUS)).toBe(true);
    }
  });

  it('measures the wall distance across the flats', () => {
    expect(rayToWall({ x: 0, y: 0 }, { x: 1, y: 0 }, SIZE)).toBeCloseTo(600, 6);
    expect(rayToWall({ x: 300, y: 0 }, { x: 1, y: 0 }, SIZE)).toBeCloseTo(300, 6);
  });

  it('shrinks across four stages', () => {
    expect(arenaSize(6, 0)).toBe(1040);
    expect(arenaSize(6, 3)).toBeCloseTo(468, 6);
    expect(arenaSize(2, 0)).toBe(720);
  });

  it('spawns everyone inside the arena, facing the centre', () => {
    const spawns = spawnPoints(6, SIZE, 0.3);
    expect(spawns).toHaveLength(6);
    for (const s of spawns) {
      expect(insideWithMargin(s, SIZE, PLAYER_RADIUS)).toBe(true);
      const toCentre = Math.atan2(-s.y, -s.x);
      expect(Math.cos(s.aim - toCentre)).toBeCloseTo(1, 6);
    }
  });
});
