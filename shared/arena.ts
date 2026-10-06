import { ARENA_BASE_SIZE, MAX_PLAYERS, STAGE_SCALE } from './constants.js';

export const SIDES = 8;

/** Outward normal of each wall, flat sides facing the cardinal directions. */
const NORMALS: readonly { x: number; y: number }[] = Array.from({ length: SIDES }, (_, i) => {
  const a = (i * 2 * Math.PI) / SIDES;
  return { x: Math.cos(a), y: Math.sin(a) };
});

const HALF_ANGLE = Math.PI / SIDES;

/** `size` is the wall-to-wall distance across the flats. */
export function inradius(size: number): number {
  return size / 2;
}

export function arenaSize(playerCount: number, stage: number): number {
  const base = ARENA_BASE_SIZE[Math.min(Math.max(playerCount, 2), MAX_PLAYERS)] ?? ARENA_BASE_SIZE[6]!;
  return base * (STAGE_SCALE[stage] ?? STAGE_SCALE[STAGE_SCALE.length - 1]!);
}

export function arenaVertices(size: number): { x: number; y: number }[] {
  const r = inradius(size) / Math.cos(HALF_ANGLE);
  return Array.from({ length: SIDES }, (_, i) => {
    const a = (i * 2 * Math.PI) / SIDES + HALF_ANGLE;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
}

/**
 * Push a point back inside the octagon, keeping `margin` clear of the walls.
 * Repeated because correcting against one wall can violate its neighbour at a corner.
 */
export function clampToArena(
  p: { x: number; y: number },
  size: number,
  margin = 0,
): { x: number; y: number } {
  const limit = inradius(size) - margin;
  let { x, y } = p;
  for (let pass = 0; pass < 3; pass++) {
    let corrected = false;
    for (const n of NORMALS) {
      const d = x * n.x + y * n.y;
      if (d > limit) {
        x -= n.x * (d - limit);
        y -= n.y * (d - limit);
        corrected = true;
      }
    }
    if (!corrected) break;
  }
  return { x, y };
}

/** Distance from `o` along `dir` to the first wall. */
export function rayToWall(
  o: { x: number; y: number },
  dir: { x: number; y: number },
  size: number,
): number {
  const limit = inradius(size);
  let best = Infinity;
  for (const n of NORMALS) {
    const denom = dir.x * n.x + dir.y * n.y;
    if (denom <= 1e-9) continue;
    const t = (limit - (o.x * n.x + o.y * n.y)) / denom;
    if (t >= 0 && t < best) best = t;
  }
  return Number.isFinite(best) ? best : 0;
}

/** Evenly spaced ring of spawns, each facing the centre. `spin` varies per match. */
export function spawnPoints(count: number, size: number, spin: number) {
  const r = inradius(size) * 0.62;
  return Array.from({ length: count }, (_, i) => {
    const a = spin + (i * 2 * Math.PI) / count;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, aim: a + Math.PI };
  });
}
