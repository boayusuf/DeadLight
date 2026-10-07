import { FINISHER_MAX_MS, KILLCAM_MS } from '../shared/constants.js';
import type { ReplayTrack } from '../shared/protocol.js';
import { FINALE_MS, KILLSCREEN_MS } from './killscreen.js';

/** The finisher plays at this speed in the killcam, so it gets twice its time. */
export const KILLCAM_SLOWMO = 0.5;

/**
 * The killcam's beats, in order: the blackout replayed, the snap in slow
 * motion, a freeze on the hit, the anime cut-in, the finisher played out in
 * full, and the winner's card. They add up to KILLCAM_MS, the time the server
 * holds the final lights before announcing the result.
 */
export const KILLCAM_BEATS = [
  ['intro', 300],
  ['replay', 1700],
  ['shot', 900],
  ['freeze', 300],
  ['cutin', KILLSCREEN_MS],
  ['boom', FINISHER_MAX_MS / KILLCAM_SLOWMO],
  ['finale', FINALE_MS],
] as const;

export type KillcamBeat = (typeof KILLCAM_BEATS)[number][0];

export interface Pose {
  x: number;
  y: number;
  aim: number;
}

export interface Framing {
  /** World point at the centre of the screen. */
  x: number;
  y: number;
  zoom: number;
}

/** Which beat `t` ms into the killcam falls in, and how far through it. */
export function beatAt(t: number): { beat: KillcamBeat; p: number; start: number } {
  let start = 0;
  for (const [beat, length] of KILLCAM_BEATS) {
    if (t < start + length) return { beat, p: Math.max(0, (t - start) / length), start };
    start += length;
  }
  return { beat: 'finale', p: 1, start: start - KILLCAM_BEATS[KILLCAM_BEATS.length - 1]![1] };
}

/** Where a fighter was `u` of the way (0..1) through the replayed blackout. */
export function poseAt(track: ReplayTrack, u: number): Pose {
  const points = track.points;
  const last = points.length - 1;
  if (last <= 0) {
    const only = points[0] ?? [0, 0, 0];
    return { x: only[0], y: only[1], aim: only[2] };
  }
  const at = Math.min(Math.max(u, 0), 1) * last;
  const i = Math.min(Math.floor(at), last - 1);
  const t = at - i;
  const [x0, y0, a0] = points[i]!;
  const [x1, y1, a1] = points[i + 1]!;
  // Turn the short way round, or a flick across ±π spins the whole circle.
  const turn = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
  return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, aim: a0 + turn * t };
}

/**
 * Centre and zoom that keep every point on screen with some breathing room.
 * `viewW`/`viewH` are the world units visible at zoom 1.
 */
export function frameAround(
  points: readonly { x: number; y: number }[],
  viewW: number,
  viewH: number,
  maxZoom: number,
  margin = 140,
): Framing {
  if (points.length === 0) return { x: 0, y: 0, zoom: 1 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const left = Math.min(...xs) - margin;
  const right = Math.max(...xs) + margin;
  const top = Math.min(...ys) - margin;
  const bottom = Math.max(...ys) + margin;
  const fit = Math.min(viewW / (right - left), viewH / (bottom - top));
  return { x: (left + right) / 2, y: (top + bottom) / 2, zoom: Math.min(Math.max(fit, 1), maxZoom) };
}
