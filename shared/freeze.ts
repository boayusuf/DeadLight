import { MOVE_SPEED, PLAYER_RADIUS } from './constants.js';

/**
 * Freeze: a long corridor with an eye at the far end. Run while it is turned
 * away, stand perfectly still while it looks, and cross the line.
 */
export const FREEZE_WORLD = { w: 900, h: 4200 } as const;

/** Slower than DeadLight: the corridor is long, and a sprint is a liability. */
export const FREEZE_SPEED = MOVE_SPEED * 0.7;

/** Fighters start behind `-FINISH_Y` and are home once they are past `+FINISH_Y`. */
export const FREEZE_FINISH_Y = 1560;

/** How long a zap hangs in the air once the eye has caught someone. */
export const ZAP_MS = 250;

/** What the eye is doing. `turning` is the only warning anyone gets. */
export type EyeLight = 'green' | 'turning' | 'red';

/** Caught by the eye: who, and when, so the client plays it once. */
export interface Zap {
  id: string;
  at: number;
}

export interface FreezeExtra {
  light: EyeLight;
  /** Milliseconds until the light changes again. */
  phaseLeft: number;
  zaps: Zap[];
}

/** Any movement at all gives you away: the eye has no patience for creeping. */
export const FREEZE_TWITCH = 0.5;

export function clampToCorridor(p: { x: number; y: number }): { x: number; y: number } {
  const x = FREEZE_WORLD.w / 2 - PLAYER_RADIUS;
  const y = FREEZE_WORLD.h / 2 - PLAYER_RADIUS;
  return {
    x: Math.max(-x, Math.min(x, p.x)),
    y: Math.max(-y, Math.min(y, p.y)),
  };
}

/** One movement step in the corridor. Walls only; the floor is bare. */
export function stepFreeze(
  from: { x: number; y: number },
  mx: number,
  my: number,
  dt: number,
): { x: number; y: number } {
  const length = Math.hypot(mx, my);
  if (length === 0 || dt <= 0) return { x: from.x, y: from.y };
  const speed = (length > 1 ? 1 / length : 1) * FREEZE_SPEED * dt;
  return clampToCorridor({ x: from.x + mx * speed, y: from.y + my * speed });
}

export const isHome = (p: { y: number }): boolean => p.y >= FREEZE_FINISH_Y;

/** Where the pack lines up: a row across the near end of the corridor. */
export function freezeSpawns(count: number): { x: number; y: number; aim: number }[] {
  const usable = FREEZE_WORLD.w - PLAYER_RADIUS * 4;
  const step = count > 1 ? usable / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => ({
    x: count > 1 ? -usable / 2 + step * i : 0,
    y: -FREEZE_FINISH_Y,
    aim: Math.PI / 2,
  }));
}
