import { MOVE_SPEED, PLAYER_RADIUS } from './constants.js';
import { collide, conveyorAt, type World } from './maps.js';

/**
 * One movement step.
 *
 * Shared so the client's prediction cannot drift from the server's authority,
 * and so the rules that matter — a diagonal is never faster than a straight
 * line, conveyors drag you whether or not you move, and nobody walks through
 * a wall or an obstacle — are stated exactly once.
 */
export function stepPlayer(
  from: { x: number; y: number },
  mx: number,
  my: number,
  dt: number,
  world: World,
): { x: number; y: number } {
  if (dt <= 0) return { x: from.x, y: from.y };
  const length = Math.hypot(mx, my);
  const drift = conveyorAt(from, world);
  if (length === 0 && drift.vx === 0 && drift.vy === 0) return { x: from.x, y: from.y };

  const speed = length === 0 ? 0 : (length > 1 ? 1 / length : 1) * MOVE_SPEED;
  const next = {
    x: from.x + (mx * speed + drift.vx) * dt,
    y: from.y + (my * speed + drift.vy) * dt,
  };
  return collide(next, PLAYER_RADIUS, world);
}
