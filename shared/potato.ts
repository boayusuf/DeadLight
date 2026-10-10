import { MOVE_SPEED, PLAYER_RADIUS } from './constants.js';

/**
 * Hot potato: a live bomb changes hands on contact. Whoever is holding it when
 * the fuse runs out goes, so the floor is a scramble to touch someone else.
 */
export const POTATO_WORLD = { w: 1100, h: 1100 } as const;

/** Pillars to break the chase up: one fat one in the middle, four corners. */
export const POTATO_PILLARS: readonly { x: number; y: number; r: number }[] = [
  { x: 0, y: 0, r: 72 },
  { x: -270, y: -270, r: 52 },
  { x: 270, y: -270, r: 52 },
  { x: -270, y: 270, r: 52 },
  { x: 270, y: 270, r: 52 },
];

/** Holding the bomb makes you faster. It is the only good thing about it. */
export const HOLDER_SPEED = 1.15;

/** How long a fuse burns before it goes off. */
export const FUSE_MS = 1800;

/** After a pass, neither pair of hands can take it back for this long. */
export const PASS_COOLDOWN_MS = 1200;

/** Close enough to shove it into someone else's hands. */
export const PASS_RADIUS = PLAYER_RADIUS * 2 + 10;

/** A bomb changing hands, kept so the client plays the slap once. */
export interface Pass {
  from: string;
  to: string;
  at: number;
}

/** A fuse that ran out on someone. */
export interface Boom {
  id: string;
  at: number;
}

export interface PotatoExtra {
  /** Who is holding each live bomb. */
  holders: string[];
  /** How long each of those fuses has been burning, in milliseconds. */
  heat: number[];
  passes: Pass[];
  booms: Boom[];
  /** Hands that cannot take a bomb yet, and how long for. */
  cooldowns: Record<string, number>;
  dashing: string[];
}

/** Push a point out of the walls and off every pillar. */
export function clampToPotato(p: { x: number; y: number }): { x: number; y: number } {
  const limit = POTATO_WORLD.w / 2 - PLAYER_RADIUS;
  let x = Math.max(-limit, Math.min(limit, p.x));
  let y = Math.max(-limit, Math.min(limit, p.y));
  for (const pillar of POTATO_PILLARS) {
    const dx = x - pillar.x;
    const dy = y - pillar.y;
    const clear = pillar.r + PLAYER_RADIUS;
    const d = Math.hypot(dx, dy);
    if (d >= clear) continue;
    const nx = d > 0 ? dx / d : 1;
    const ny = d > 0 ? dy / d : 0;
    x = pillar.x + nx * clear;
    y = pillar.y + ny * clear;
  }
  return { x, y };
}

/** One movement step. A holder moves faster; everyone else runs. */
export function stepPotato(
  from: { x: number; y: number },
  mx: number,
  my: number,
  dt: number,
  holding: boolean,
): { x: number; y: number } {
  const length = Math.hypot(mx, my);
  if (length === 0 || dt <= 0) return { x: from.x, y: from.y };
  const speed = (length > 1 ? 1 / length : 1) * MOVE_SPEED * (holding ? HOLDER_SPEED : 1) * dt;
  return clampToPotato({ x: from.x + mx * speed, y: from.y + my * speed });
}

/** How many bombs are live at once. Big floors need more than one. */
export const bombCount = (alive: number): number => (alive >= 6 ? 2 : 1);

/** Spawns on a ring wide of the middle pillar. */
export function potatoSpawns(count: number): { x: number; y: number; aim: number }[] {
  const r = POTATO_WORLD.w * 0.33;
  return Array.from({ length: count }, (_, i) => {
    const a = (i * 2 * Math.PI) / count - Math.PI / 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, aim: a + Math.PI };
  });
}
