/**
 * Collapse: a tiled floor that gives way from the outside in. Tiles crack,
 * then break, then are gone, and a fighter standing on nothing goes with them.
 */
export const COLLAPSE_COLS = 11;
export const COLLAPSE_ROWS = 11;
export const TILE = 100;
export const COLLAPSE_WORLD = { w: COLLAPSE_COLS * TILE, h: COLLAPSE_ROWS * TILE } as const;

/**
 * A tile's life, as one character per tile so a whole floor fits in a short
 * string on the wire.
 */
export const TILE_SOLID = '0';
export const TILE_CRACKING = '1';
export const TILE_BREAKING = '2';
export const TILE_GONE = '3';
export type TileState = typeof TILE_SOLID | typeof TILE_CRACKING | typeof TILE_BREAKING | typeof TILE_GONE;

/** How long a tile spends in each warning state before the next one. */
export const CRACK_MS = 450;
export const BREAK_MS = 500;

/** How long a fighter takes to drop out of sight once the floor goes. */
export const FALL_MS = 500;

/** A fighter on the way down: where they slipped, and when. */
export interface Fall {
  id: string;
  x: number;
  y: number;
  at: number;
}

export interface CollapseExtra {
  /** One character per tile, row by row. */
  tiles: string;
  /** The innermost ring the floor has started eating into. */
  edge: number;
  falls: Fall[];
  /** Tiles that went this round, for the sound of it. */
  broke: number[];
  /** Fighters mid-dash, so everyone sees the lunge. */
  dashing: string[];
}

export const tileCount = COLLAPSE_COLS * COLLAPSE_ROWS;
export const solidFloor = (): string => TILE_SOLID.repeat(tileCount);

const CENTRE_COL = Math.floor(COLLAPSE_COLS / 2);
const CENTRE_ROW = Math.floor(COLLAPSE_ROWS / 2);

/**
 * Which ring a tile sits on: 0 is the middle tile, and the outer edge is the
 * highest. The floor breaks ring by ring, so the safe ground shrinks evenly.
 */
export function ring(index: number): number {
  const col = index % COLLAPSE_COLS;
  const row = Math.floor(index / COLLAPSE_COLS);
  return Math.max(Math.abs(col - CENTRE_COL), Math.abs(row - CENTRE_ROW));
}

export const OUTER_RING = Math.max(CENTRE_COL, CENTRE_ROW);

/** The tile under a point, or null past the edge of the floor. */
export function tileAt(p: { x: number; y: number }): number | null {
  const col = Math.floor((p.x + COLLAPSE_WORLD.w / 2) / TILE);
  const row = Math.floor((p.y + COLLAPSE_WORLD.h / 2) / TILE);
  if (col < 0 || col >= COLLAPSE_COLS || row < 0 || row >= COLLAPSE_ROWS) return null;
  return row * COLLAPSE_COLS + col;
}

/** The middle of a tile, where a fighter standing on it is drawn. */
export function tileCentre(index: number): { x: number; y: number } {
  const col = index % COLLAPSE_COLS;
  const row = Math.floor(index / COLLAPSE_COLS);
  return {
    x: -COLLAPSE_WORLD.w / 2 + col * TILE + TILE / 2,
    y: -COLLAPSE_WORLD.h / 2 + row * TILE + TILE / 2,
  };
}

/** How long a tile stays in a state before moving to the next one. */
export function stateMs(state: string): number {
  if (state === TILE_CRACKING) return CRACK_MS;
  if (state === TILE_BREAKING) return BREAK_MS;
  return 1000;
}

/** Standing on a tile that is gone, or off the floor entirely, is a fall. */
export function standingOnNothing(p: { x: number; y: number }, tiles: string): boolean {
  const index = tileAt(p);
  if (index === null) return true;
  return tiles[index] === TILE_GONE;
}

/**
 * One movement step. The whole floor is reachable and the walls are only
 * there to stop a fighter running off into nothing on purpose.
 */
export function stepCollapse(
  from: { x: number; y: number },
  mx: number,
  my: number,
  dt: number,
  speed: number,
): { x: number; y: number } {
  const length = Math.hypot(mx, my);
  if (length === 0 || dt <= 0) return { x: from.x, y: from.y };
  const step = (length > 1 ? 1 / length : 1) * speed * dt;
  const x = COLLAPSE_WORLD.w / 2;
  const y = COLLAPSE_WORLD.h / 2;
  return {
    x: Math.max(-x, Math.min(x, from.x + mx * step)),
    y: Math.max(-y, Math.min(y, from.y + my * step)),
  };
}

/** Where the pack starts: spread around the middle, which goes last. */
export function collapseSpawns(count: number): { x: number; y: number; aim: number }[] {
  const r = TILE * 2.2;
  return Array.from({ length: count }, (_, i) => {
    const a = (i * 2 * Math.PI) / count - Math.PI / 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, aim: a + Math.PI };
  });
}
