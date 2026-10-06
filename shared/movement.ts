import { clampToArena } from './arena.js';
import { MOVE_SPEED, PLAYER_RADIUS } from './constants.js';

/**
 * One movement step.
 *
 * Shared so the client's prediction cannot drift from the server's authority,
 * and so the rules that matter — a diagonal is never faster than a straight
 * line, and nobody leaves the octagon — are stated exactly once.
 */
export function stepPlayer(
  from: { x: number; y: number },
  mx: number,
  my: number,
  dt: number,
  size: number,
): { x: number; y: number } {
  const length = Math.hypot(mx, my);
  if (length === 0 || dt <= 0) return { x: from.x, y: from.y };

  const speed = (length > 1 ? 1 / length : 1) * MOVE_SPEED * dt;
  return clampToArena({ x: from.x + mx * speed, y: from.y + my * speed }, size, PLAYER_RADIUS);
}
