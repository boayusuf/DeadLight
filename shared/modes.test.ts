import { describe, expect, it } from 'vitest';
import { PLAYER_RADIUS } from './constants.js';
import { MAP_IDS, collide, layoutFor, openWorld } from './maps.js';
import {
  MODE_IDS,
  PATH_SHAPES,
  dealContracts,
  nextFocus,
  onPath,
  pickPath,
  roundCount,
  walkable,
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

describe('Hunted paths', () => {
  it('only produces paths a fighter can walk, on every map', () => {
    for (const map of MAP_IDS) {
      const world = { size: 880, layout: layoutFor(map, 880), broken: new Set<string>() };
      for (let seed = 1; seed < 25; seed++) {
        const path = pickPath(world, seeded(seed));
        expect(PATH_SHAPES).toContain(path.shape);
        expect(walkable(path.legs, world)).toBe(true);
      }
    }
  });

  it('keeps every leg straight along an axis or a clean diagonal', () => {
    const world = openWorld(880);
    for (let seed = 1; seed < 60; seed++) {
      for (const leg of pickPath(world, seeded(seed)).legs) {
        const dx = Math.abs(leg.bx - leg.ax);
        const dy = Math.abs(leg.by - leg.ay);
        expect(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6 || Math.abs(dx - 2 * dy) < 1e-6 || Math.abs(dy - 2 * dx) < 1e-6).toBe(true);
      }
    }
  });

  it('snaps any position back onto the path', () => {
    const legs = [{ ax: -100, ay: 0, bx: 100, by: 0 }];
    expect(onPath({ x: 40, y: 90 }, legs)).toEqual({ x: 40, y: 0 });
    expect(onPath({ x: 400, y: -30 }, legs)).toEqual({ x: 100, y: 0 });
  });

  it('turns corners by sliding onto the next leg', () => {
    const legs = [
      { ax: 0, ay: 0, bx: 100, by: 0 },
      { ax: 100, ay: 0, bx: 100, by: 100 },
    ];
    expect(onPath({ x: 110, y: 60 }, legs)).toEqual({ x: 100, y: 60 });
  });

  it('starts the target somewhere it can actually stand', () => {
    const world = openWorld(880);
    const path = pickPath(world, seeded(3));
    const leg = path.legs[0]!;
    const start = { x: (leg.ax + leg.bx) / 2, y: (leg.ay + leg.by) / 2 };
    expect(collide(start, PLAYER_RADIUS, world)).toEqual(start);
  });
});
