import { describe, expect, it } from 'vitest';
import type { Resolution } from '../shared/resolve.js';
import { calloutFor, killerOf } from './callouts.js';

const round = (kills: [string, string][], duels = 0): Resolution => ({
  beams: [],
  kills: kills.map(([shooter, target]) => ({ shooter, target })),
  duels: Array.from({ length: duels }, () => ({ a: 'x', b: 'y' })),
  eliminated: [...new Set(kills.map(([, t]) => t))],
  broken: [],
});

describe('calloutFor', () => {
  it('names a streak after whoever got it', () => {
    expect(calloutFor(round([['a', 'b'], ['a', 'c']]), false)).toEqual({ title: 'DOUBLE KILL', by: 'a' });
    expect(calloutFor(round([['a', 'b'], ['a', 'c'], ['a', 'd']]), false)?.title).toBe('TRIPLE KILL');
    expect(calloutFor(round([['a', 'b'], ['a', 'c'], ['a', 'd'], ['a', 'e'], ['a', 'f']]), false)?.title).toBe(
      'MULTI KILL',
    );
  });

  it('calls first blood only on the first kill of the match', () => {
    expect(calloutFor(round([['a', 'b']]), true)).toEqual({ title: 'FIRST BLOOD', by: 'a' });
    expect(calloutFor(round([['a', 'b']]), false)).toBeNull();
  });

  it('lets a streak outrank first blood', () => {
    expect(calloutFor(round([['a', 'b'], ['a', 'c']]), true)?.title).toBe('DOUBLE KILL');
  });

  it('laughs at a beam that came back off a mirror into its shooter', () => {
    expect(calloutFor(round([['a', 'a'], ['b', 'c'], ['b', 'd']]), true)).toEqual({ title: 'OOPS!', by: 'a' });
  });

  it('does not turn a self-hit plus one kill into a double', () => {
    expect(calloutFor(round([['a', 'a'], ['a', 'b']]), false)?.title).toBe('OOPS!');
  });

  it('marks a clash when nobody died', () => {
    expect(calloutFor(round([], 1), false)).toEqual({ title: 'CLASH', by: null });
  });

  it('stays quiet on an empty round', () => {
    expect(calloutFor(round([]), true)).toBeNull();
  });
});

describe('killerOf', () => {
  it('credits the first beam that hit', () => {
    expect(killerOf(round([['a', 'c'], ['b', 'c']]), 'c')).toBe('a');
    expect(killerOf(round([]), 'c')).toBeNull();
  });
});
