import { describe, expect, it } from 'vitest';
import { inradius } from './arena.js';
import { ARENA_BASE_SIZE, MAX_PLAYERS, PLAYER_RADIUS, STAGE_SCALE } from './constants.js';
import {
  MAP_IDS,
  MAX_BOUNCES,
  activeObstacles,
  collide,
  conveyorAt,
  layoutFor,
  maxDrift,
  openWorld,
  padUnder,
  spawnsFor,
  teleportStep,
  traceBeam,
  type MapId,
  type Obstacle,
  type World,
} from './maps.js';

const SIZE = 1200;

function worldWith(obstacles: Obstacle[], broken: string[] = [], size = SIZE): World {
  return { size, layout: { id: 'warehouse', obstacles }, broken: new Set(broken) };
}

const right = { x: 1, y: 0 };

describe('traceBeam', () => {
  it('runs to the wall on an open map', () => {
    const path = traceBeam({ x: 0, y: 0 }, right, openWorld(SIZE));
    expect(path.segments).toHaveLength(1);
    expect(path.segments[0]!.ex).toBeCloseTo(inradius(SIZE), 6);
    expect(path.struck).toEqual([]);
  });

  it('stops at a pillar', () => {
    const world = worldWith([{ id: 'p', kind: 'pillar', x: 200, y: 0, r: 40 }]);
    const path = traceBeam({ x: 0, y: 0 }, right, world);
    expect(path.segments).toHaveLength(1);
    expect(path.segments[0]!.ex).toBeCloseTo(160, 6);
    expect(path.struck).toEqual([]);
  });

  it('passes a pillar it only grazes past', () => {
    const world = worldWith([{ id: 'p', kind: 'pillar', x: 200, y: 60, r: 40 }]);
    expect(traceBeam({ x: 0, y: 0 }, right, world).segments[0]!.ex).toBeCloseTo(inradius(SIZE), 6);
  });

  it('stops at a crate and lists it as struck', () => {
    const world = worldWith([{ id: 'crate-0', kind: 'crate', x: 200, y: 0, half: 30 }]);
    const path = traceBeam({ x: 0, y: 0 }, right, world);
    expect(path.segments[0]!.ex).toBeCloseTo(170, 6);
    expect(path.struck).toEqual(['crate-0']);
  });

  it('flies through a crate that is already broken', () => {
    const world = worldWith([{ id: 'crate-0', kind: 'crate', x: 200, y: 0, half: 30 }], ['crate-0']);
    const path = traceBeam({ x: 0, y: 0 }, right, world);
    expect(path.segments[0]!.ex).toBeCloseTo(inradius(SIZE), 6);
    expect(path.struck).toEqual([]);
  });

  it('passes straight through glass', () => {
    const world = worldWith([{ id: 'g', kind: 'glass', ax: 200, ay: -100, bx: 200, by: 100 }]);
    const path = traceBeam({ x: 0, y: 0 }, right, world);
    expect(path.segments).toHaveLength(1);
    expect(path.segments[0]!.ex).toBeCloseTo(inradius(SIZE), 6);
  });

  it('reflects off a mirror with the angle of incidence equal to the angle of reflection', () => {
    // The mirror lies along x + y = 200, so a beam along +x turns to -y.
    const world = worldWith([{ id: 'm', kind: 'mirror', ax: 100, ay: 100, bx: 300, by: -100 }]);
    const [first, second] = traceBeam({ x: 0, y: 0 }, right, world).segments;
    expect(first!.ex).toBeCloseTo(200, 6);
    expect(first!.ey).toBeCloseTo(0, 6);
    const dx = second!.ex - second!.ox;
    const dy = second!.ey - second!.oy;
    expect(dx / Math.hypot(dx, dy)).toBeCloseTo(0, 6);
    expect(dy / Math.hypot(dx, dy)).toBeCloseTo(-1, 6);
  });

  it('reflects an oblique beam symmetrically about the mirror normal', () => {
    const world = worldWith([{ id: 'm', kind: 'mirror', ax: 200, ay: -300, bx: 200, by: 300 }]);
    const a = Math.PI / 6;
    const [first, second] = traceBeam({ x: 0, y: 0 }, { x: Math.cos(a), y: Math.sin(a) }, world).segments;
    expect(first!.ex).toBeCloseTo(200, 6);
    const outX = second!.ex - second!.ox;
    const outY = second!.ey - second!.oy;
    expect(Math.atan2(outY, outX)).toBeCloseTo(Math.PI - a, 6);
  });

  it('reflects off either face', () => {
    const world = worldWith([{ id: 'm', kind: 'mirror', ax: 200, ay: -300, bx: 200, by: 300 }]);
    const [, second] = traceBeam({ x: 400, y: 0 }, { x: -1, y: 0 }, world).segments;
    expect(second!.ex).toBeGreaterThan(second!.ox);
  });

  it('reflects at most MAX_BOUNCES times, then the next mirror absorbs the beam', () => {
    const world = worldWith(
      [
        { id: 'left', kind: 'mirror', ax: -300, ay: -500, bx: -300, by: 500 },
        { id: 'right', kind: 'mirror', ax: 300, ay: -500, bx: 300, by: 500 },
      ],
      [],
      2400,
    );
    const a = (12 * Math.PI) / 180;
    const path = traceBeam({ x: 0, y: 0 }, { x: Math.cos(a), y: Math.sin(a) }, world);
    expect(path.segments).toHaveLength(MAX_BOUNCES + 1);
    expect(path.segments.at(-1)!.ex).toBeCloseTo(300, 6);
  });

  it('does not bounce a beam straight back into the mirror it just left', () => {
    const world = worldWith([{ id: 'm', kind: 'mirror', ax: 200, ay: -300, bx: 200, by: 300 }]);
    expect(traceBeam({ x: 0, y: 0 }, right, world).segments).toHaveLength(2);
  });

  it('stops a bounced beam at a crate behind the mirror', () => {
    const world = worldWith([
      { id: 'm', kind: 'mirror', ax: 100, ay: 100, bx: 300, by: -100 },
      { id: 'crate-0', kind: 'crate', x: 200, y: -300, half: 30 },
    ]);
    const path = traceBeam({ x: 0, y: 0 }, right, world);
    expect(path.struck).toEqual(['crate-0']);
    expect(path.segments[1]!.ey).toBeCloseTo(-270, 3);
  });
});

describe('collide', () => {
  const R = PLAYER_RADIUS;

  it('leaves a free circle alone', () => {
    expect(collide({ x: 10, y: 20 }, R, openWorld(SIZE))).toEqual({ x: 10, y: 20 });
  });

  it('pushes out of a pillar', () => {
    const world = worldWith([{ id: 'p', kind: 'pillar', x: 0, y: 0, r: 50 }]);
    const out = collide({ x: 30, y: 0 }, R, world);
    expect(out.x).toBeCloseTo(50 + R, 6);
    expect(out.y).toBeCloseTo(0, 6);
  });

  it('pushes out of a pillar when dead centre', () => {
    const world = worldWith([{ id: 'p', kind: 'pillar', x: 0, y: 0, r: 50 }]);
    expect(Math.hypot(collide({ x: 0, y: 0 }, R, world).x, 0)).toBeCloseTo(50 + R, 6);
  });

  it('pushes out of a crate, face and corner', () => {
    const world = worldWith([{ id: 'c', kind: 'crate', x: 0, y: 0, half: 40 }]);
    expect(collide({ x: 50, y: 0 }, R, world).x).toBeCloseTo(40 + R, 6);
    const corner = collide({ x: 45, y: 45 }, R, world);
    expect(Math.hypot(corner.x - 40, corner.y - 40)).toBeCloseTo(R, 6);
  });

  it('pushes out from inside a crate through the nearest face', () => {
    const world = worldWith([{ id: 'c', kind: 'crate', x: 0, y: 0, half: 40 }]);
    const out = collide({ x: 30, y: 5 }, R, world);
    expect(out.x).toBeCloseTo(40 + R, 6);
    expect(out.y).toBeCloseTo(5, 6);
  });

  it('pushes out of a mirror, which is a thin wall', () => {
    const world = worldWith([{ id: 'm', kind: 'mirror', ax: 0, ay: -100, bx: 0, by: 100 }]);
    expect(collide({ x: 10, y: 0 }, R, world).x).toBeCloseTo(R + 3, 6);
    expect(collide({ x: -10, y: 0 }, R, world).x).toBeCloseTo(-(R + 3), 6);
    expect(collide({ x: 0, y: 0 }, R, world).x).toBeCloseTo(-(R + 3), 6);
  });

  it('is solid past the end of a mirror only as far as its rounded tip', () => {
    const world = worldWith([{ id: 'm', kind: 'mirror', ax: 0, ay: -100, bx: 0, by: 100 }]);
    expect(collide({ x: 0, y: 140 }, R, world)).toEqual({ x: 0, y: 140 });
  });

  it('blocks movement through glass', () => {
    const world = worldWith([{ id: 'g', kind: 'glass', ax: 0, ay: -100, bx: 0, by: 100 }]);
    expect(collide({ x: 5, y: 10 }, R, world).x).toBeCloseTo(R + 3, 6);
  });

  it('pushes back inside the wall', () => {
    const out = collide({ x: 5000, y: 0 }, R, openWorld(SIZE));
    expect(out.x).toBeCloseTo(inradius(SIZE) - R, 6);
  });

  it('settles between a wall and an obstacle', () => {
    const limit = inradius(SIZE) - R;
    const world = worldWith([{ id: 'p', kind: 'pillar', x: limit - 90, y: 0, r: 50 }]);
    const out = collide({ x: limit, y: 30 }, R, world);
    expect(out.x).toBeLessThanOrEqual(limit + 1e-6);
    expect(Math.hypot(out.x - (limit - 90), out.y)).toBeGreaterThanOrEqual(50 + R - 1e-6);
  });

  it('ignores a broken crate', () => {
    const world = worldWith([{ id: 'c', kind: 'crate', x: 0, y: 0, half: 40 }], ['c']);
    expect(collide({ x: 10, y: 0 }, R, world)).toEqual({ x: 10, y: 0 });
  });
});

describe('conveyors', () => {
  const belt: Obstacle = { id: 'b', kind: 'conveyor', x: 0, y: 0, w: 200, h: 100, vx: 150, vy: 0 };

  it('drags inside the belt and not outside it', () => {
    const world = worldWith([belt]);
    expect(conveyorAt({ x: 90, y: 40 }, world)).toEqual({ vx: 150, vy: 0 });
    expect(conveyorAt({ x: 110, y: 0 }, world)).toEqual({ vx: 0, vy: 0 });
    expect(conveyorAt({ x: 0, y: 60 }, world)).toEqual({ vx: 0, vy: 0 });
  });

  it('adds up overlapping belts', () => {
    const world = worldWith([belt, { ...belt, id: 'b2', vx: 0, vy: -60 }]);
    expect(conveyorAt({ x: 0, y: 0 }, world)).toEqual({ vx: 150, vy: -60 });
  });

  it('reports the fastest belt of a layout', () => {
    expect(maxDrift({ id: 'factory', obstacles: [belt, { ...belt, id: 'b2', vx: 30, vy: -40 }] })).toBe(150);
    expect(maxDrift({ id: 'reactor', obstacles: [] })).toBe(0);
  });

  it('stops dragging once the wall has closed past the belt', () => {
    const layout = layoutFor('factory', 1280);
    const world: World = { size: 1280 * 0.32, layout, broken: new Set() };
    expect(conveyorAt({ x: 0, y: -0.45 * inradius(1280) }, world)).toEqual({ vx: 0, vy: 0 });
  });
});

describe('teleporters', () => {
  const pads: Obstacle[] = [
    { id: 'a', kind: 'teleporter', x: -300, y: 0, r: 40, to: 'b' },
    { id: 'b', kind: 'teleporter', x: 300, y: 0, r: 40, to: 'a' },
  ];
  const world = worldWith(pads);

  it('finds the pad under a point', () => {
    expect(padUnder({ x: -290, y: 10 }, world)).toBe('a');
    expect(padUnder({ x: 300, y: 0 }, world)).toBe('b');
    expect(padUnder({ x: 0, y: 0 }, world)).toBeNull();
  });

  it('sends you to the linked pad when you step on', () => {
    const step = teleportStep({ x: -290, y: 0 }, world, null);
    expect(step).toEqual({ x: 300, y: 0, onPad: 'b', jumped: true });
  });

  it('fires once: standing on the destination does nothing until you step off', () => {
    const first = teleportStep({ x: -290, y: 0 }, world, null);
    const again = teleportStep(first, world, first.onPad);
    expect(again.jumped).toBe(false);
    expect(again.onPad).toBe('b');

    const off = teleportStep({ x: 200, y: 0 }, world, again.onPad);
    expect(off).toEqual({ x: 200, y: 0, onPad: null, jumped: false });
    expect(teleportStep({ x: 290, y: 0 }, world, off.onPad).jumped).toBe(true);
  });

  it('does not fire for someone who started the blackout on the pad', () => {
    const start = padUnder({ x: -300, y: 0 }, world);
    expect(teleportStep({ x: -300, y: 0 }, world, start).jumped).toBe(false);
  });

  it('does nothing once either pad has been swallowed by the wall', () => {
    const small: World = { ...world, size: 500 };
    expect(padUnder({ x: -300, y: 0 }, small)).toBeNull();
    expect(teleportStep({ x: -300, y: 0 }, small, null).jumped).toBe(false);
  });
});

describe('activeObstacles', () => {
  it('drops obstacles that the shrunken wall has closed past', () => {
    const layout = layoutFor('pillars', ARENA_BASE_SIZE[MAX_PLAYERS]!);
    const full = { size: ARENA_BASE_SIZE[MAX_PLAYERS]!, layout, broken: new Set<string>() };
    const late = { ...full, size: full.size * STAGE_SCALE[2] };
    expect(activeObstacles(full)).toHaveLength(layout.obstacles.length);
    const kept = activeObstacles(late);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(layout.obstacles.length);
  });

  it('drops broken crates', () => {
    const world = worldWith([{ id: 'c', kind: 'crate', x: 0, y: 0, half: 20 }], ['c']);
    expect(activeObstacles(world)).toEqual([]);
  });
});

describe('layoutFor', () => {
  const counts: Record<MapId, [number, number]> = {
    reactor: [0, 0],
    pillars: [6, 8],
    mirrors: [4, 6],
    warehouse: [8, 12],
    lab: [5, 9],
    factory: [4, 7],
  };

  it.each(MAP_IDS)('builds a sound %s layout at every lobby size', (id) => {
    for (const base of Object.values(ARENA_BASE_SIZE)) {
      const layout = layoutFor(id, base);
      const [min, max] = counts[id];
      expect(layout.obstacles.length).toBeGreaterThanOrEqual(min);
      expect(layout.obstacles.length).toBeLessThanOrEqual(max);
      expect(new Set(layout.obstacles.map((o) => o.id)).size).toBe(layout.obstacles.length);
      expect(layoutFor(id, base)).toEqual(layout);
      const world: World = { size: base, layout, broken: new Set() };
      expect(activeObstacles(world)).toHaveLength(layout.obstacles.length);
    }
  });

  it('links the lab teleporters to each other', () => {
    const pads = layoutFor('lab', 1000).obstacles.filter((o) => o.kind === 'teleporter');
    expect(pads).toHaveLength(2);
    const [a, b] = pads;
    if (a?.kind !== 'teleporter' || b?.kind !== 'teleporter') throw new Error('pads expected');
    expect(a.to).toBe(b.id);
    expect(b.to).toBe(a.id);
    expect(a.x * b.x).toBeLessThan(0);
  });

  it('scales with the arena', () => {
    const small = layoutFor('pillars', 720).obstacles[0]!;
    const big = layoutFor('pillars', 1440).obstacles[0]!;
    if (small.kind === 'pillar' && big.kind === 'pillar') expect(big.r).toBeCloseTo(small.r * 2, 6);
  });

  it('gives the factory belts between 160 and 220 units per second', () => {
    const speeds = layoutFor('factory', 1000).obstacles.flatMap((o) =>
      o.kind === 'conveyor' ? [Math.hypot(o.vx, o.vy)] : [],
    );
    expect(speeds.length).toBeGreaterThanOrEqual(2);
    for (const s of speeds) {
      expect(s).toBeGreaterThanOrEqual(160);
      expect(s).toBeLessThanOrEqual(220);
    }
  });
});

describe('spawnsFor', () => {
  const spins = [0, 0.4, 1.3, 2.9, 4.4];

  it.each(MAP_IDS)('keeps spawns clear on %s for 2 to 10 players', (id) => {
    for (let count = 2; count <= MAX_PLAYERS; count++) {
      const size = ARENA_BASE_SIZE[count]!;
      const world: World = { size, layout: layoutFor(id, size), broken: new Set() };
      for (const spin of spins) {
        const spawns = spawnsFor(count, world, spin);
        expect(spawns).toHaveLength(count);
        spawns.forEach((s, i) => {
          const settled = collide(s, PLAYER_RADIUS, world);
          expect(Math.hypot(settled.x - s.x, settled.y - s.y)).toBeLessThan(1e-6);
          expect(padUnder(s, world)).toBeNull();
          expect(Math.cos(s.aim) * s.x + Math.sin(s.aim) * s.y).toBeLessThanOrEqual(1e-6);
          for (const other of spawns.slice(i + 1)) {
            expect(Math.hypot(s.x - other.x, s.y - other.y)).toBeGreaterThanOrEqual(PLAYER_RADIUS * 2);
          }
        });
      }
    }
  });

  it('leaves the ring untouched on an open map', () => {
    const spawns = spawnsFor(4, openWorld(1000), 0);
    expect(spawns[0]!.x).toBeCloseTo(0.62 * 500, 6);
    expect(spawns[0]!.y).toBeCloseTo(0, 6);
  });
});
