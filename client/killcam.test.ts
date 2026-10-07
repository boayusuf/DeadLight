import { describe, expect, it } from 'vitest';
import { KILLCAM_MS } from '../shared/constants.js';
import { KILLCAM_BEATS, beatAt, frameAround, poseAt } from './killcam.js';

describe('killcam timeline', () => {
  it('fits exactly inside the time the server holds the final lights', () => {
    expect(KILLCAM_BEATS.reduce((sum, [, ms]) => sum + ms, 0)).toBe(KILLCAM_MS);
  });

  it('walks through the beats in order', () => {
    expect(beatAt(0)).toEqual({ beat: 'intro', p: 0, start: 0 });
    expect(beatAt(300).beat).toBe('replay');
    expect(beatAt(1150).p).toBeCloseTo(0.5, 6);
    expect(beatAt(2000).beat).toBe('shot');
    expect(beatAt(2900).beat).toBe('freeze');
    expect(beatAt(3200).beat).toBe('boom');
  });

  it('rests on the end of the last beat once time runs out', () => {
    expect(beatAt(KILLCAM_MS + 5000)).toMatchObject({ beat: 'boom', p: 1 });
  });
});

describe('poseAt', () => {
  const track = { id: 'a', points: [[0, 0, 0], [100, 0, 0], [100, 100, 0]] as [number, number, number][] };

  it('interpolates between samples', () => {
    expect(poseAt(track, 0.25)).toMatchObject({ x: 50, y: 0 });
    expect(poseAt(track, 0.75)).toMatchObject({ x: 100, y: 50 });
    expect(poseAt(track, 1)).toMatchObject({ x: 100, y: 100 });
  });

  it('clamps outside the replay', () => {
    expect(poseAt(track, -1)).toMatchObject({ x: 0, y: 0 });
    expect(poseAt(track, 2)).toMatchObject({ x: 100, y: 100 });
  });

  it('turns the short way across ±π', () => {
    const flick = { id: 'a', points: [[0, 0, 3.1], [0, 0, -3.1]] as [number, number, number][] };
    const mid = poseAt(flick, 0.5).aim;
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(0.05);
  });

  it('copes with a single sample', () => {
    expect(poseAt({ id: 'a', points: [[5, 6, 1]] }, 0.5)).toEqual({ x: 5, y: 6, aim: 1 });
  });
});

describe('frameAround', () => {
  it('centres on the points', () => {
    const frame = frameAround([{ x: -100, y: 0 }, { x: 300, y: 0 }], 1000, 800, 3);
    expect(frame.x).toBe(100);
    expect(frame.y).toBe(0);
  });

  it('zooms in on a tight group, up to the limit', () => {
    expect(frameAround([{ x: 0, y: 0 }, { x: 10, y: 10 }], 1000, 800, 2.5).zoom).toBe(2.5);
  });

  it('never zooms out past the whole arena', () => {
    expect(frameAround([{ x: -2000, y: 0 }, { x: 2000, y: 0 }], 1000, 800, 3).zoom).toBe(1);
  });
});
