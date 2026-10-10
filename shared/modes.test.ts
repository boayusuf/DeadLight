import { describe, expect, it } from 'vitest';
import { PLAYER_RADIUS } from './constants.js';
import { openWorld } from './maps.js';
import {
  MODE_IDS,
  clampToZone,
  dealContracts,
  huntLine,
  insideZone,
  nextFocus,
  pickZone,
  roundCount,
  zoneStart,
} from './modes.js';

/** A seeded generator, so random-looking tests are repeatable. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe('modes', () => {
  it('offers the four modes, Classic first', () => {
    expect(MODE_IDS).toEqual(['classic', 'hunted', 'ghost', 'assassin']);
  });

  it('gives every fighter the same number of turns as target', () => {
    for (let players = 2; players <= 10; players++) {
      const rounds = roundCount('hunted', players);
      expect(rounds % players).toBe(0);
      expect(rounds).toBeGreaterThanOrEqual(6);
    }
  });
});

describe('nextFocus', () => {
  it('rotates through everyone before anyone goes twice', () => {
    const order = ['a', 'b', 'c'];
    const turns = new Map<string, number>();
    const picked: string[] = [];
    for (let round = 0; round < 6; round++) {
      const focus = nextFocus(order, turns, () => true)!;
      picked.push(focus);
      turns.set(focus, (turns.get(focus) ?? 0) + 1);
    }
    expect(picked).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('skips a fighter who has dropped out', () => {
    const turns = new Map([['a', 1]]);
    expect(nextFocus(['a', 'b', 'c'], turns, (id) => id !== 'b')).toBe('c');
  });
});

describe('dealContracts', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('gives everyone exactly one target, never themselves, each targeted once', () => {
    for (let seed = 1; seed < 40; seed++) {
      const deal = dealContracts(ids, new Map(), seeded(seed));
      expect([...deal.keys()].sort()).toEqual(ids);
      for (const [id, target] of deal) expect(target).not.toBe(id);
      expect(new Set(deal.values()).size).toBe(ids.length);
    }
  });

  it('never pairs two players onto each other when there are three or more', () => {
    for (let seed = 1; seed < 40; seed++) {
      const deal = dealContracts(ids, new Map(), seeded(seed));
      for (const [id, target] of deal) expect(deal.get(target)).not.toBe(id);
    }
  });

  it('avoids handing out last round’s targets again', () => {
    const rng = seeded(7);
    let previous = dealContracts(ids, new Map(), rng);
    for (let round = 0; round < 10; round++) {
      const next = dealContracts(ids, previous, rng);
      for (const [id, target] of next) expect(previous.get(id)).not.toBe(target);
      previous = next;
    }
  });
});

describe('the hunting ground', () => {
  const world = openWorld(880);

  it('pens the Target in a box inside the arena, up the far end', () => {
    for (let seed = 1; seed < 40; seed++) {
      const zone = pickZone(world, seeded(seed));
      expect(zone.y).toBeLessThan(0);
      expect(zone.w).toBeGreaterThan(PLAYER_RADIUS * 4);
      expect(zone.h).toBeGreaterThan(PLAYER_RADIUS * 2);
      expect(Math.abs(zone.x) + zone.w / 2).toBeLessThanOrEqual(world.size / 2);
    }
  });

  it('starts the Target in the middle of its own box', () => {
    const zone = pickZone(world, seeded(3));
    const start = zoneStart(zone);
    expect(insideZone(start, zone)).toBe(true);
    expect(start).toEqual({ x: zone.x, y: zone.y });
  });

  it('pushes anything outside the box back inside it', () => {
    const zone = { x: 0, y: -200, w: 400, h: 160 };
    const out = clampToZone({ x: 9000, y: 0 }, zone);
    expect(insideZone(out, zone)).toBe(true);
    expect(out.x).toBeCloseTo(200 - PLAYER_RADIUS, 6);
    expect(out.y).toBeCloseTo(-200 + 80 - PLAYER_RADIUS, 6);
  });

  it('leaves a fighter already inside the box exactly where it is', () => {
    const zone = { x: 0, y: -200, w: 400, h: 160 };
    const at = { x: 30, y: -210 };
    expect(clampToZone(at, zone)).toEqual(at);
  });

  it('lines the hunters up across the near end, all facing the box', () => {
    const zone = pickZone(world, seeded(7));
    const line = huntLine(5, world, zone);
    expect(line).toHaveLength(5);
    for (const spot of line) {
      expect(spot.y).toBeGreaterThan(0);
      expect(insideZone(spot, zone)).toBe(false);
      // Facing the box means aiming up the arena, which is a negative y step.
      expect(Math.sin(spot.aim)).toBeLessThan(0);
    }
    const xs = line.map((spot) => spot.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('stands a lone hunter in the middle of the line', () => {
    const zone = pickZone(world, seeded(9));
    expect(huntLine(1, world, zone)[0]!.x).toBe(0);
  });
});
