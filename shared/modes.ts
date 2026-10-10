import { PLAYER_RADIUS } from './constants.js';
import type { World } from './maps.js';

export const MODE_IDS = ['classic', 'hunted', 'ghost', 'assassin'] as const;
export type ModeId = (typeof MODE_IDS)[number];
/** Every mode except Classic plays in short rounds with roles. */
export type RoundModeId = Exclude<ModeId, 'classic'>;

export const isModeId = (value: unknown): value is ModeId => (MODE_IDS as readonly unknown[]).includes(value);

export const MODE_NAMES: Record<ModeId, string> = {
  classic: 'Classic',
  hunted: 'Hunted',
  ghost: 'Ghost',
  assassin: 'Assassin',
};

export const MODE_BLURBS: Record<ModeId, string> = {
  classic: 'Remember. Aim. Survive the blackout.',
  hunted: 'One target on a fixed path. Everyone else hunts.',
  ghost: 'One unarmed ghost nobody can see. Everyone hunts.',
  assassin: 'Everyone has a secret target. Complete your contract.',
};

/** Fewest fighters a mode makes sense with: a contract needs someone else to chase. */
export const MODE_MIN_PLAYERS: Record<ModeId, number> = {
  classic: 2,
  hunted: 2,
  ghost: 2,
  assassin: 3,
};

/** What a fighter is this round. Classic has no roles. */
export type Role = 'target' | 'hunter' | 'ghost' | 'assassin';

/** Blackouts in one round. Hunted and Ghost end early on a kill; Assassin when one is left. */
export const ROUND_CYCLES: Record<RoundModeId, number> = {
  hunted: 3,
  ghost: 3,
  assassin: 6,
};

/** Kills of anyone but your target that also complete an Assassin contract. */
export const CONTRACT_KILLS = 3;

/**
 * Rounds in a match. Hunted and Ghost give every fighter the same number of
 * turns in the middle, so the count is a multiple of the player count.
 */
export function roundCount(mode: RoundModeId, players: number): number {
  if (mode === 'assassin') return 3;
  const turns = Math.ceil(6 / players);
  return turns * players;
}

/**
 * Who is hunted next: the connected fighter with the fewest turns so far,
 * earliest in the shuffled order on a tie. Fair over a match, and a player who
 * drops out is simply skipped rather than handing out free points.
 */
export function nextFocus(
  order: readonly string[],
  turns: ReadonlyMap<string, number>,
  connected: (id: string) => boolean,
): string | null {
  let best: string | null = null;
  let fewest = Infinity;
  for (const id of order) {
    if (!connected(id)) continue;
    const count = turns.get(id) ?? 0;
    if (count < fewest) {
      best = id;
      fewest = count;
    }
  }
  return best;
}

/**
 * Deals Assassin contracts: everyone gets exactly one target, never
 * themselves, and as few repeats of last round's targets as chance allows.
 */
export function dealContracts(
  ids: readonly string[],
  previous: ReadonlyMap<string, string>,
  rng: () => number = Math.random,
): Map<string, string> {
  if (ids.length < 2) return new Map();
  let best: Map<string, string> | null = null;
  let bestRepeats = Infinity;

  for (let attempt = 0; attempt < 60 && bestRepeats > 0; attempt++) {
    const order = shuffle(ids, rng);
    // Each fighter hunts the next one round a shuffled circle: a derangement
    // with no short loops, so nobody is simply trading shots with their hunter.
    const deal = new Map(order.map((id, i) => [id, order[(i + 1) % order.length]!]));
    let repeats = 0;
    for (const [id, target] of deal) if (previous.get(id) === target) repeats++;
    if (repeats < bestRepeats) {
      best = deal;
      bestRepeats = repeats;
    }
  }
  return best!;
}

export function shuffle<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// --- The hunting ground -------------------------------------------------------

/**
 * Hunted is a shooting gallery. The Target is penned into a small box at the
 * far end of the arena with nothing to shoot back with, and the hunters stand
 * in a line at the near end and fire into the box in the dark. Staying alive is
 * a matter of not being where the shots went.
 */
export interface Zone {
  /** Middle of the box. */
  x: number;
  y: number;
  /** Full width and height, in world units. */
  w: number;
  h: number;
}

/** How wide the box is as a fraction of the arena, and how deep. */
const ZONE_WIDTH = 0.52;
const ZONE_DEPTH = 0.22;
/** How far up the arena the box sits, as a fraction of the half-height. */
const ZONE_UP = 0.52;
/** How far down the hunters' line sits. */
const LINE_DOWN = 0.74;

/** The box this round's Target is held to. */
export function pickZone(world: World, rng: () => number = Math.random): Zone {
  const r = world.size / 2;
  // A little variation round to round, so the same corner is never the answer.
  const w = r * 2 * ZONE_WIDTH * (0.85 + rng() * 0.3);
  const h = r * 2 * ZONE_DEPTH * (0.85 + rng() * 0.3);
  const slack = Math.max(0, r - w / 2 - PLAYER_RADIUS * 2);
  return {
    x: (rng() * 2 - 1) * slack * 0.5,
    y: -r * ZONE_UP,
    w,
    h,
  };
}

/** The Target cannot leave the box: anywhere outside it is pushed back in. */
export function clampToZone(p: { x: number; y: number }, zone: Zone): { x: number; y: number } {
  const x = zone.w / 2 - PLAYER_RADIUS;
  const y = zone.h / 2 - PLAYER_RADIUS;
  return {
    x: zone.x + Math.max(-x, Math.min(x, p.x - zone.x)),
    y: zone.y + Math.max(-y, Math.min(y, p.y - zone.y)),
  };
}

export function insideZone(p: { x: number; y: number }, zone: Zone): boolean {
  return Math.abs(p.x - zone.x) <= zone.w / 2 && Math.abs(p.y - zone.y) <= zone.h / 2;
}

/** Where the Target starts: the middle of its box. */
export const zoneStart = (zone: Zone): { x: number; y: number } => ({ x: zone.x, y: zone.y });

/**
 * The firing line: hunters stand shoulder to shoulder across the near end,
 * facing the box. They do not move all round; all they have is the aim.
 */
export function huntLine(count: number, world: World, zone: Zone): { x: number; y: number; aim: number }[] {
  const r = world.size / 2;
  const y = r * LINE_DOWN;
  const usable = r * 2 - PLAYER_RADIUS * 6;
  const step = count > 1 ? usable / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => {
    const x = count > 1 ? -usable / 2 + step * i : 0;
    return { x, y, aim: Math.atan2(zone.y - y, zone.x - x) };
  });
}
