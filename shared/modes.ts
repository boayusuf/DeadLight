import { PLAYER_RADIUS } from './constants.js';
import { collide, type World } from './maps.js';

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

// --- Hunted paths -------------------------------------------------------------

/** One straight leg of a Target's path. A path is a connected set of legs. */
export interface Leg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export const PATH_SHAPES = ['line', 'l', 't', 'z', 'zigzag', 'square'] as const;
export type PathShape = (typeof PATH_SHAPES)[number];

export const PATH_NAMES: Record<PathShape, string> = {
  line: 'Straight line',
  l: 'L shape',
  t: 'T shape',
  z: 'Z shape',
  zigzag: 'Zigzag',
  square: 'Square',
};

export interface TargetPath {
  shape: PathShape;
  legs: Leg[];
}

/** Legs of each shape around the origin, for a shape `s` units across. */
function sketch(shape: PathShape, s: number): [number, number][][] {
  const h = s / 2;
  switch (shape) {
    case 'line':
      return [[[-h, 0], [h, 0]]];
    case 'l':
      return [[[-h, -h], [-h, h], [h, h]]];
    case 't':
      return [[[-h, -h], [h, -h]], [[0, -h], [0, h]]];
    case 'z':
      return [[[-h, -h], [h, -h], [-h, h], [h, h]]];
    case 'zigzag': {
      const q = s / 4;
      return [[[-h, q], [-q, -q], [0, q], [q, -q], [h, q]]];
    }
    case 'square':
      return [[[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]]];
  }
}

function toLegs(strokes: [number, number][][], cx: number, cy: number, turn: number): Leg[] {
  const cos = Math.round(Math.cos(turn));
  const sin = Math.round(Math.sin(turn));
  const place = ([x, y]: [number, number]) => [cx + x * cos - y * sin, cy + x * sin + y * cos] as const;
  const legs: Leg[] = [];
  for (const stroke of strokes) {
    for (let i = 0; i + 1 < stroke.length; i++) {
      const [ax, ay] = place(stroke[i]!);
      const [bx, by] = place(stroke[i + 1]!);
      legs.push({ ax, ay, bx, by });
    }
  }
  return legs;
}

/** True when a fighter could stand on every part of the path. */
export function walkable(legs: readonly Leg[], world: World): boolean {
  for (const leg of legs) {
    const length = Math.hypot(leg.bx - leg.ax, leg.by - leg.ay);
    const steps = Math.max(1, Math.ceil(length / 14));
    for (let i = 0; i <= steps; i++) {
      const p = { x: leg.ax + ((leg.bx - leg.ax) * i) / steps, y: leg.ay + ((leg.by - leg.ay) * i) / steps };
      const free = collide(p, PLAYER_RADIUS, world);
      if (Math.hypot(free.x - p.x, free.y - p.y) > 0.5) return false;
    }
  }
  return true;
}

/**
 * A random walkable path of a random shape. Shapes are axis-aligned and turned
 * in quarter turns, so a "horizontal line" reads as one. Falls back to smaller
 * paths, then to a short line, on cramped maps.
 */
export function pickPath(world: World, rng: () => number = Math.random): TargetPath {
  const r = world.size / 2;
  for (const scale of [0.62, 0.5, 0.4, 0.3]) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const shape = PATH_SHAPES[Math.floor(rng() * PATH_SHAPES.length)]!;
      const across = r * (scale + rng() * 0.15);
      const spread = Math.max(0, r - across / 2 - PLAYER_RADIUS * 2) * 0.8;
      const cx = (rng() * 2 - 1) * spread;
      const cy = (rng() * 2 - 1) * spread;
      const turn = Math.floor(rng() * 4) * (Math.PI / 2);
      const legs = toLegs(sketch(shape, across), cx, cy, turn);
      if (walkable(legs, world)) return { shape, legs };
    }
  }
  return { shape: 'line', legs: toLegs(sketch('line', r * 0.3), 0, r * 0.6, 0) };
}

/** The point on the path nearest to `p`: where a Target trying to stand at `p` ends up. */
export function onPath(p: { x: number; y: number }, legs: readonly Leg[]): { x: number; y: number } {
  let best = { x: p.x, y: p.y };
  let bestDistance = Infinity;
  for (const leg of legs) {
    const dx = leg.bx - leg.ax;
    const dy = leg.by - leg.ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - leg.ax) * dx + (p.y - leg.ay) * dy) / len2));
    const x = leg.ax + dx * t;
    const y = leg.ay + dy * t;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestDistance) {
      best = { x, y };
      bestDistance = d;
    }
  }
  return best;
}

/** Where a Target starts: the middle of its first leg. */
export function pathStart(path: TargetPath): { x: number; y: number } {
  const leg = path.legs[0]!;
  return { x: (leg.ax + leg.bx) / 2, y: (leg.ay + leg.by) / 2 };
}
