import { describe, expect, it } from 'vitest';
import { nextStage } from './stages.js';

describe('nextStage', () => {
  it('walks a six-player match through all five stages as players die', () => {
    expect(nextStage(0, 6, 6, 0)).toBe(0);
    expect(nextStage(0, 6, 5, 0)).toBe(1);
    expect(nextStage(1, 6, 4, 0)).toBe(2);
    expect(nextStage(2, 6, 3, 0)).toBe(3);
    expect(nextStage(3, 6, 2, 0)).toBe(4);
  });

  it('never advances more than one stage in a round', () => {
    expect(nextStage(0, 6, 2, 0)).toBe(1);
  });

  it('shrinks on a stalled round even though nobody has died', () => {
    expect(nextStage(0, 2, 2, 2)).toBe(0);
    expect(nextStage(0, 2, 2, 3)).toBe(1);
    expect(nextStage(1, 2, 2, 3)).toBe(2);
  });

  it('stops at the final stage', () => {
    expect(nextStage(4, 6, 2, 9)).toBe(4);
  });

  it('never un-shrinks', () => {
    expect(nextStage(2, 6, 6, 0)).toBe(2);
  });
});
