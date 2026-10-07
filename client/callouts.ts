import type { Resolution } from '../shared/resolve.js';

export interface Callout {
  title: string;
  /** Who earned it, shown under the title; null when nobody did. */
  by: string | null;
}

const STREAKS: Record<number, string> = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'MULTI KILL' };

/**
 * The one thing about a round worth shouting about. Loudest first and never
 * more than one, so a busy round cannot stack banners over the arena.
 */
export function calloutFor(resolution: Resolution, firstBlood: boolean): Callout | null {
  const tally = new Map<string, number>();
  for (const kill of resolution.kills) tally.set(kill.shooter, (tally.get(kill.shooter) ?? 0) + 1);

  let top: { id: string; kills: number } | null = null;
  for (const [id, kills] of tally) {
    if (!top || kills > top.kills) top = { id, kills };
  }

  if (top && top.kills >= 2) return { title: STREAKS[Math.min(top.kills, 4)]!, by: top.id };
  if (top && firstBlood) return { title: 'FIRST BLOOD', by: top.id };
  if (resolution.duels.length > 0) return { title: 'CLASH', by: null };
  return null;
}

/** Whose finisher plays on a victim: the first beam that took them counts. */
export function killerOf(resolution: Resolution, victim: string): string | null {
  return resolution.kills.find((k) => k.target === victim)?.shooter ?? null;
}
