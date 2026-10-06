import { STAGE_COUNT, STAGE_THRESHOLDS, STALL_ROUNDS } from './constants.js';

/**
 * The arena shrinks on eliminations, or on its own if nobody has died for a
 * while — the second trigger is what stops a cagey endgame from stalling, and
 * what gives small matches all four stages. At most one stage per round.
 */
export function nextStage(
  current: number,
  startCount: number,
  remaining: number,
  roundsWithoutElimination: number,
): number {
  let crossed = 0;
  if (remaining < startCount) {
    for (const t of STAGE_THRESHOLDS) {
      if (remaining <= Math.ceil(startCount * t)) crossed++;
    }
  }

  let target = Math.max(current, crossed);
  if (roundsWithoutElimination >= STALL_ROUNDS) target = Math.max(target, current + 1);

  return Math.min(STAGE_COUNT - 1, target, current + 1);
}
