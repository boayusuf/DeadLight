import { describe, expect, it } from 'vitest';
import { HIT_RADIUS } from './constants.js';
import { openWorld, type Obstacle, type World } from './maps.js';
import { resolveRound, type Shooter } from './resolve.js';

const SIZE = 1200;
const WORLD = openWorld(SIZE);

function at(id: string, x: number, y: number, aim: number): Shooter {
  return { id, x, y, aim };
}

/** Aim `from` at a point, as a player reading the last snapshot would. */
function aimAt(x: number, y: number, tx: number, ty: number) {
  return Math.atan2(ty - y, tx - x);
}

describe('resolveRound', () => {
  it('kills a player the beam crosses', () => {
    const r = resolveRound([at('a', -200, 0, 0), at('b', 200, 0, Math.PI / 2)], WORLD);
    expect(r.eliminated).toEqual(['b']);
    expect(r.kills).toEqual([{ shooter: 'a', target: 'b' }]);
  });

  it('misses a player standing behind the shooter', () => {
    const r = resolveRound([at('a', 0, 0, 0), at('b', -200, 0, Math.PI / 2)], WORLD);
    expect(r.eliminated).toEqual([]);
  });

  it('misses when the aim is off by more than the hit radius', () => {
    const inside = HIT_RADIUS * 0.5;
    const outside = HIT_RADIUS * 2;

    const near = resolveRound(
      [at('a', -200, 0, aimAt(-200, 0, 200, inside)), at('b', 200, 0, Math.PI / 2)],
      WORLD,
    );
    expect(near.eliminated).toEqual(['b']);

    const wide = resolveRound(
      [at('a', -200, 0, aimAt(-200, 0, 200, outside)), at('b', 200, 0, Math.PI / 2)],
      WORLD,
    );
    expect(wide.eliminated).toEqual([]);
  });

  it('pierces: one beam kills everyone on the line', () => {
    const r = resolveRound(
      [at('a', -400, 0, 0), at('b', 0, 0, Math.PI / 2), at('c', 300, 0, Math.PI / 2)],
      WORLD,
    );
    expect(r.eliminated.sort()).toEqual(['b', 'c']);
  });

  it('cancels a mutual hit and spares both players', () => {
    const r = resolveRound([at('a', -200, 0, 0), at('b', 200, 0, Math.PI)], WORLD);
    expect(r.eliminated).toEqual([]);
    expect(r.duels).toEqual([{ a: 'a', b: 'b' }]);
  });

  it('cancels only the duelling pair, not the rest of the beam', () => {
    const r = resolveRound(
      [at('a', -200, 0, 0), at('b', 200, 0, Math.PI), at('c', 400, 0, Math.PI / 2)],
      WORLD,
    );
    expect(r.duels).toEqual([{ a: 'a', b: 'b' }]);
    expect(r.eliminated).toEqual(['c']);
  });

  it('wipes the field when hits form a cycle rather than pairs', () => {
    const ring = [90, 210, 330].map((deg) => {
      const a = (deg * Math.PI) / 180;
      return { x: Math.cos(a) * 300, y: Math.sin(a) * 300 };
    });
    const [p, q, s] = ring as [typeof ring[0], typeof ring[0], typeof ring[0]];
    const r = resolveRound(
      [
        at('a', p.x, p.y, aimAt(p.x, p.y, q.x, q.y)),
        at('b', q.x, q.y, aimAt(q.x, q.y, s.x, s.y)),
        at('c', s.x, s.y, aimAt(s.x, s.y, p.x, p.y)),
      ],
      WORLD,
    );
    expect(r.duels).toEqual([]);
    expect(r.eliminated.sort()).toEqual(['a', 'b', 'c']);
  });

  it('emits one beam per shooter, ending on a wall', () => {
    const r = resolveRound([at('a', 0, 0, 0), at('b', 0, 200, Math.PI / 2)], WORLD);
    expect(r.beams).toHaveLength(2);
    expect(r.beams[0]!.segments[0]!.ex).toBeCloseTo(600, 6);
    expect(r.beams[1]!.segments[0]!.ey).toBeCloseTo(600, 6);
  });
});

function withObstacles(obstacles: Obstacle[], broken: string[] = []): World {
  return { size: SIZE, layout: { id: 'warehouse', obstacles }, broken: new Set(broken) };
}

describe('resolveRound with obstacles', () => {
  const mirror: Obstacle = { id: 'm', kind: 'mirror', ax: 100, ay: 100, bx: 300, by: -100 };

  it('kills with a bank shot off a mirror', () => {
    // The mirror turns a beam fired along +x down onto the target below it.
    const shooters = [at('a', 0, 0, 0), at('b', 200, -300, 0)];
    expect(resolveRound(shooters, WORLD).eliminated).toEqual([]);

    const r = resolveRound(shooters, withObstacles([mirror]));
    expect(r.kills).toEqual([{ shooter: 'a', target: 'b' }]);
    expect(r.beams[0]!.segments).toHaveLength(2);
  });

  it('lets a beam hit its own shooter only after a bounce', () => {
    const straight = resolveRound([at('a', 0, 0, 0)], WORLD);
    expect(straight.eliminated).toEqual([]);

    const wall: Obstacle = { id: 'm', kind: 'mirror', ax: 200, ay: -100, bx: 200, by: 100 };
    const back = resolveRound([at('a', 0, 0, 0)], withObstacles([wall]));
    expect(back.eliminated).toEqual(['a']);
    expect(back.kills).toEqual([{ shooter: 'a', target: 'a' }]);
  });

  it('never cancels a self-hit as a duel', () => {
    const wall: Obstacle = { id: 'm', kind: 'mirror', ax: 200, ay: -100, bx: 200, by: 100 };
    const r = resolveRound([at('a', 0, 0, 0), at('b', 0, 300, 0)], withObstacles([wall]));
    expect(r.duels).toEqual([]);
    expect(r.eliminated).toEqual(['a']);
  });

  it('is blocked by a crate, which is then broken', () => {
    const crate: Obstacle = { id: 'crate-0', kind: 'crate', x: 200, y: 0, half: 30 };
    const shooters = [at('a', 0, 0, 0), at('b', 400, 0, Math.PI / 2)];
    const r = resolveRound(shooters, withObstacles([crate]));
    expect(r.eliminated).toEqual([]);
    expect(r.broken).toEqual(['crate-0']);

    const after = resolveRound(shooters, withObstacles([crate], ['crate-0']));
    expect(after.eliminated).toEqual(['b']);
    expect(after.broken).toEqual([]);
  });

  it('is blocked by a pillar', () => {
    const pillar: Obstacle = { id: 'p', kind: 'pillar', x: 200, y: 0, r: 40 };
    const r = resolveRound([at('a', 0, 0, 0), at('b', 400, 0, Math.PI / 2)], withObstacles([pillar]));
    expect(r.eliminated).toEqual([]);
  });

  it('shoots through glass', () => {
    const glass: Obstacle = { id: 'g', kind: 'glass', ax: 200, ay: -100, bx: 200, by: 100 };
    const r = resolveRound([at('a', 0, 0, 0), at('b', 400, 0, Math.PI / 2)], withObstacles([glass]));
    expect(r.eliminated).toEqual(['b']);
  });

  it('lets an unarmed fighter be hit without firing a beam of its own', () => {
    const shooters = [at('ghost', -200, 0, 0), at('hunter', 200, 0, Math.PI)];
    const r = resolveRound(shooters, WORLD, new Set(["ghost"]));
    expect(r.beams.map((b) => b.id)).toEqual(['hunter']);
    expect(r.duels).toEqual([]);
    expect(r.eliminated).toEqual(['ghost']);
  });
});
