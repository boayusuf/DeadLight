import { FLICKER_PULSES } from '../shared/constants.js';

export const DARK_AMBIENT = 0.1;
export const FLICKER_AMBIENT = 0.5;

/**
 * Ambient light during a blackout. The pulses near the end are the only
 * warning that the lights are about to return — and because ambient light
 * touches nothing but the floor and walls, the warning never reveals a player.
 */
export function ambientAt(elapsed: number): number {
  for (const pulse of FLICKER_PULSES) {
    if (elapsed >= pulse[0] && elapsed <= pulse[1]) return FLICKER_AMBIENT;
  }
  return DARK_AMBIENT;
}
