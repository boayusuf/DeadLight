import { describe, expect, it } from 'vitest';
import { BLACKOUT_MAX_MS, BLACKOUT_MIN_MS, FLICKER_PULSES } from '../shared/constants.js';
import { DARK_AMBIENT, FLICKER_AMBIENT, ambientAt } from './lighting.js';

describe('ambientAt', () => {
  it('holds the arena dark for most of the blackout', () => {
    expect(ambientAt(0)).toBe(DARK_AMBIENT);
    expect(ambientAt(1200)).toBe(DARK_AMBIENT);
  });

  it('pulses inside each warning window', () => {
    for (const pulse of FLICKER_PULSES) {
      expect(ambientAt(pulse[0] + 1)).toBe(FLICKER_AMBIENT);
      expect(ambientAt(pulse[1] + 1)).toBe(DARK_AMBIENT);
    }
  });

  it('always warns before the earliest possible snap, and never after the latest', () => {
    const first = FLICKER_PULSES[0]![0];
    const last = FLICKER_PULSES[FLICKER_PULSES.length - 1]![1];
    expect(first).toBeLessThan(BLACKOUT_MIN_MS);
    expect(last).toBeLessThan(BLACKOUT_MIN_MS);
    expect(BLACKOUT_MAX_MS - last).toBeGreaterThan(BLACKOUT_MIN_MS - last);
  });
});
