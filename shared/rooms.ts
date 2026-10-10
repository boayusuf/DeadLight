import { MOVE_SPEED, PLAYER_RADIUS } from './constants.js';

/**
 * Rooms: eight side rooms off a round floor. The music plays, a number is
 * called, and a room only saves the fighters inside it if exactly that many
 * made it in.
 */
export const ROOMS_WORLD = { w: 1200, h: 1200 } as const;
export const ROOM_COUNT = 8;

/** Geometry along a room's spoke, measured from the middle of the floor. */
const DOOR_AT = 370;
const ROOM_DEPTH = 190;
const ROOM_HALF_HEIGHT = 100;
const DOOR_HALF_HEIGHT = 70;
/** How far into the floor a doorway reaches, so it can be stepped into. */
const DOOR_LIP = 60;
export const WALL = 16;
const MARGIN = PLAYER_RADIUS;
const EPS = 1e-6;

export const ROOM_SPAN = { at: DOOR_AT, depth: ROOM_DEPTH, halfHeight: ROOM_HALF_HEIGHT, doorHalfHeight: DOOR_HALF_HEIGHT };

/** The spinning floor reaches this far out from the middle. */
export const DANCE_RADIUS = 130;
/** Radians per second the floor turns under anyone standing on it. */
export const SPIN_RATE = 0.55;

/** The open floor is a disc that stops short of the doors. */
export const FLOOR_RADIUS = DOOR_AT - MARGIN;

/** Room `i` lies along this direction, the first one straight up. */
export const ROOM_ANGLES = Array.from({ length: ROOM_COUNT }, (_, i) => {
  const angle = -Math.PI / 2 + (i * Math.PI * 2) / ROOM_COUNT;
  return { angle, cos: Math.cos(angle), sin: Math.sin(angle) };
});

/** Where a room is in the phase: open to walk into, or locked for the reveal. */
export interface RoomState {
  open: boolean;
  locked: boolean;
  /** Set once the reveal has judged it. */
  outcome: 'ok' | 'wrong' | null;
}

export type RoomsPhase = 'music' | 'announce' | 'count' | 'reveal';

export interface RoomsExtra {
  phase: RoomsPhase;
  phaseLeft: number;
  /** The number called this round, during and after `announce`. */
  target: number | null;
  rooms: RoomState[];
}

/** A box along a spoke, in that room's own coordinates. */
interface Box {
  u0: number;
  u1: number;
  vh: number;
}

const ROOM_BOX: Box = { u0: DOOR_AT + MARGIN, u1: DOOR_AT + ROOM_DEPTH - MARGIN, vh: ROOM_HALF_HEIGHT - MARGIN };
const DOOR_BOX: Box = { u0: DOOR_AT - DOOR_LIP, u1: DOOR_AT + MARGIN, vh: DOOR_HALF_HEIGHT - MARGIN };

/** A world point in room `i`'s frame: `x` out along the spoke, `y` across it. */
export function toRoom(p: { x: number; y: number }, i: number): { x: number; y: number } {
  const a = ROOM_ANGLES[i]!;
  return { x: p.x * a.cos + p.y * a.sin, y: -p.x * a.sin + p.y * a.cos };
}

/** Back to world coordinates from room `i`'s frame. */
export function fromRoom(i: number, u: number, v: number): { x: number; y: number } {
  const a = ROOM_ANGLES[i]!;
  return { x: u * a.cos - v * a.sin, y: u * a.sin + v * a.cos };
}

const inBox = (p: { x: number; y: number }, i: number, box: Box): boolean => {
  const q = toRoom(p, i);
  return q.x >= box.u0 - EPS && q.x <= box.u1 + EPS && Math.abs(q.y) <= box.vh + EPS;
};

const ontoBox = (p: { x: number; y: number }, i: number, box: Box): { x: number; y: number } => {
  const q = toRoom(p, i);
  return fromRoom(i, Math.max(box.u0, Math.min(box.u1, q.x)), Math.max(-box.vh, Math.min(box.vh, q.y)));
};

/** Somewhere a fighter is allowed to stand, given which doors are open. */
export function standable(p: { x: number; y: number }, open: readonly boolean[]): boolean {
  if (Math.hypot(p.x, p.y) <= FLOOR_RADIUS + EPS) return true;
  for (let i = 0; i < ROOM_COUNT; i++) {
    if (inBox(p, i, ROOM_BOX)) return true;
    if (open[i] && inBox(p, i, DOOR_BOX)) return true;
  }
  return false;
}

/** The nearest spot a fighter could actually be, if `p` is inside a wall. */
export function clampToRooms(p: { x: number; y: number }, open: readonly boolean[]): { x: number; y: number } {
  if (standable(p, open)) return { x: p.x, y: p.y };
  const d = Math.hypot(p.x, p.y) || 1;
  let best = { x: (p.x / d) * FLOOR_RADIUS, y: (p.y / d) * FLOOR_RADIUS };
  let bestDistance = Math.hypot(p.x - best.x, p.y - best.y);
  for (let i = 0; i < ROOM_COUNT; i++) {
    for (const box of open[i] ? [ROOM_BOX, DOOR_BOX] : [ROOM_BOX]) {
      const spot = ontoBox(p, i, box);
      const distance = Math.hypot(p.x - spot.x, p.y - spot.y);
      if (distance < bestDistance - EPS) {
        best = spot;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** Walk in small steps so a doorway cannot be crossed through its frame. */
const SUBSTEP = 10;
export function slide(
  from: { x: number; y: number },
  dx: number,
  dy: number,
  open: readonly boolean[],
): { x: number; y: number } {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / SUBSTEP));
  let at = from;
  for (let i = 0; i < steps; i++) {
    at = clampToRooms({ x: at.x + dx / steps, y: at.y + dy / steps }, open);
  }
  return at;
}

/** Turn a point about the middle, for the floor that spins to the music. */
function spin(p: { x: number; y: number }, dt: number, open: readonly boolean[]): { x: number; y: number } {
  const a = SPIN_RATE * dt;
  const x = p.x * Math.cos(a) - p.y * Math.sin(a);
  const y = p.x * Math.sin(a) + p.y * Math.cos(a);
  return slide(p, x - p.x, y - p.y, open);
}

/**
 * One movement step. While the music plays, the middle of the floor turns
 * under anyone standing on it, so nobody simply waits on the spot.
 */
export function stepRooms(
  from: { x: number; y: number },
  mx: number,
  my: number,
  dt: number,
  extra: { phase: RoomsPhase; rooms: readonly RoomState[] },
): { x: number; y: number } {
  if (dt <= 0) return { x: from.x, y: from.y };
  const open = extra.rooms.map((r) => r.open);
  let at = clampToRooms(from, open);
  const length = Math.hypot(mx, my);
  if (length > 0) {
    const step = (length > 1 ? 1 / length : 1) * MOVE_SPEED * dt;
    at = slide(at, mx * step, my * step, open);
  }
  if (extra.phase === 'music' && Math.hypot(at.x, at.y) < DANCE_RADIUS) at = spin(at, dt, open);
  return at;
}

/** Which room a fighter is counted in at the reveal, or null for the floor. */
export function roomOf(p: { x: number; y: number }): number | null {
  for (let i = 0; i < ROOM_COUNT; i++) {
    const q = toRoom(p, i);
    if (q.x >= DOOR_AT && q.x <= DOOR_AT + ROOM_DEPTH && Math.abs(q.y) <= ROOM_HALF_HEIGHT) return i;
  }
  return null;
}

/** Spawns on the dance floor, clear of the spinning middle. */
export function roomsSpawns(count: number): { x: number; y: number; aim: number }[] {
  const r = (DANCE_RADIUS + FLOOR_RADIUS) / 2;
  return Array.from({ length: count }, (_, i) => {
    const a = (i * 2 * Math.PI) / count - Math.PI / 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, aim: a + Math.PI };
  });
}
