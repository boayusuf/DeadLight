import { describe, expect, it } from 'vitest';
import { HIT_RADIUS } from './constants.js';
import { resolveRound, type Shooter } from './resolve.js';

const SIZE = 1200;

function at(id: string, x: number, y: number, aim: number): Shooter {
  return { id, x, y, aim };
}

/** Aim `from` at a point, as a player reading the last snapshot would. */
function aimAt(x: number, y: number, tx: number, ty: number) {
  return Math.atan2(ty - y, tx - x);
}

describe('resolveRound', () => {
  it('kills a player the beam crosses', () => {
    const r = resolveRound([at('a', -200, 0, 0), at('b', 200, 0, Math.PI / 2)], SIZE);
    expect(r.eliminated).toEqual(['b']);
    expect(r.kills).toEqual([{ shooter: 'a', target: 'b' }]);
  });

  it('misses a player standing behind the shooter', () => {
    const r = resolveRound([at('a', 0, 0, 0), at('b', -200, 0, Math.PI / 2)], SIZE);
    expect(r.eliminated).toEqual([]);
  });

  it('misses when the aim is off by more than the hit radius', () => {
    const inside = HIT_RADIUS * 0.5;
    const outside = HIT_RADIUS * 2;

    const near = resolveRound(
      [at('a', -200, 0, aimAt(-200, 0, 200, inside)), at('b', 200, 0, Math.PI / 2)],
      SIZE,
    );
    expect(near.eliminated).toEqual(['b']);

    const wide = resolveRound(
      [at('a', -200, 0, aimAt(-200, 0, 200, outside)), at('b', 200, 0, Math.PI / 2)],
      SIZE,
    );
    expect(wide.eliminated).toEqual([]);
  });

  it('pierces: one beam kills everyone on the line', () => {
    const r = resolveRound(
      [at('a', -400, 0, 0), at('b', 0, 0, Math.PI / 2), at('c', 300, 0, Math.PI / 2)],
      SIZE,
    );
    expect(r.eliminated.sort()).toEqual(['b', 'c']);
  });

  it('cancels a mutual hit and spares both players', () => {
    const r = resolveRound([at('a', -200, 0, 0), at('b', 200, 0, Math.PI)], SIZE);
    expect(r.eliminated).toEqual([]);
    expect(r.duels).toEqual([{ a: 'a', b: 'b' }]);
  });

  it('cancels only the duelling pair, not the rest of the beam', () => {
    const r = resolveRound(
      [at('a', -200, 0, 0), at('b', 200, 0, Math.PI), at('c', 400, 0, Math.PI / 2)],
      SIZE,
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
      SIZE,
    );
    expect(r.duels).toEqual([]);
    expect(r.eliminated.sort()).toEqual(['a', 'b', 'c']);
  });

  it('emits one beam per shooter, ending on a wall', () => {
    const r = resolveRound([at('a', 0, 0, 0), at('b', 0, 200, Math.PI / 2)], SIZE);
    expect(r.beams).toHaveLength(2);
    expect(r.beams[0]!.ex).toBeCloseTo(600, 6);
    expect(r.beams[1]!.ey).toBeCloseTo(600, 6);
  });
});
