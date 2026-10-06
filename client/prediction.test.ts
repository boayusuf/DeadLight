import { describe, expect, it } from 'vitest';
import { MOVE_SPEED, TICK_MS } from '../shared/constants.js';
import { Prediction } from './prediction.js';

const STEP = (MOVE_SPEED * TICK_MS) / 1000;

describe('Prediction', () => {
  it('does not pull a moving fighter back just because the server is behind', () => {
    const prediction = new Prediction();
    const sent: { seq: number; x: number }[] = [];
    let x = 0;

    // Run right for a second while reports arrive six inputs late — about a
    // 200ms round trip at full speed.
    for (let i = 0; i < 30; i++) {
      x += STEP;
      sent.push({ seq: prediction.record(x, 0), x });
      const late = sent[i - 6];
      if (!late) continue;
      // The server has applied that input for one extra tick before reporting.
      const corrected = prediction.reconcile({ x: late.x + STEP, y: 0, seq: late.seq }, { x, y: 0 });
      expect(corrected.x).toBe(x);
    }
  });

  it('eases back towards the server when the client has genuinely drifted', () => {
    const prediction = new Prediction();
    const seq = prediction.record(100, 0);
    const corrected = prediction.reconcile({ x: 160, y: 0, seq }, { x: 100, y: 0 });
    expect(corrected.x).toBeGreaterThan(100);
    expect(corrected.x).toBeLessThan(160);
  });

  it('snaps when the two are far apart', () => {
    const prediction = new Prediction();
    const seq = prediction.record(0, 0);
    expect(prediction.reconcile({ x: 400, y: 0, seq }, { x: 10, y: 0 })).toEqual({ x: 410, y: 0 });
  });

  it('ignores reports for inputs it has already forgotten', () => {
    const prediction = new Prediction();
    prediction.record(0, 0);
    prediction.reset();
    expect(prediction.reconcile({ x: 500, y: 0, seq: 1 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });
});
