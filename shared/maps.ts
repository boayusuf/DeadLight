import { clampToArena, inradius, rayToWall, spawnPoints } from './arena.js';
import { PLAYER_RADIUS } from './constants.js';

/**
 * Arenas. Every map is the same octagon; what changes is what stands on the
 * floor. Obstacles are laid out once per match against the starting arena and
 * switch off as the wall closes past them.
 */
export const MAP_IDS = ['reactor', 'pillars', 'mirrors', 'warehouse', 'lab', 'factory'] as const;
export type MapId = (typeof MAP_IDS)[number];
/** What a host can pick in the lobby: a map, or a fresh roll each match. */
export type MapChoice = MapId | 'random';

export const MAP_NAMES: Record<MapId, string> = {
  reactor: 'Reactor',
  pillars: 'Pillar hall',
  mirrors: 'Hall of mirrors',
  warehouse: 'Warehouse',
  lab: 'Lab',
  factory: 'Factory',
};

export const MAP_BLURBS: Record<MapId, string> = {
  reactor: 'Open floor. Nowhere to hide.',
  pillars: 'Pillars stop beams. So who is behind one?',
  mirrors: 'Mirrors bounce beams. Shoot round corners.',
  warehouse: 'Crates take one hit, then break.',
  lab: 'Glass stops you, not beams. Two teleporters.',
  factory: 'Conveyor belts drag you while you move blind.',
};

export const isMapId = (value: unknown): value is MapId => (MAP_IDS as readonly unknown[]).includes(value);
export const isMapChoice = (value: unknown): value is MapChoice => value === 'random' || isMapId(value);

/** Beams reflect off mirrors at most this many times. */
export const MAX_BOUNCES = 2;

/**
 * Everything that can stand on the floor, in world units.
 *  - pillar: round, blocks movement and beams
 *  - mirror: thin wall, blocks movement, reflects beams
 *  - crate: axis-aligned square, blocks movement and beams until a beam breaks it
 *  - glass: thin wall, blocks movement, beams pass straight through
 *  - teleporter: floor pad; walking onto it sends you to the pad named `to`
 *  - conveyor: floor zone (axis-aligned rect centred on x, y) that drags anyone
 *    standing on it at (vx, vy) units per second during a blackout
 */
export type Obstacle =
  | { id: string; kind: 'pillar'; x: number; y: number; r: number }
  | { id: string; kind: 'mirror'; ax: number; ay: number; bx: number; by: number }
  | { id: string; kind: 'crate'; x: number; y: number; half: number }
  | { id: string; kind: 'glass'; ax: number; ay: number; bx: number; by: number }
  | { id: string; kind: 'teleporter'; x: number; y: number; r: number; to: string }
  | { id: string; kind: 'conveyor'; x: number; y: number; w: number; h: number; vx: number; vy: number };

export interface MapLayout {
  id: MapId;
  obstacles: Obstacle[];
}

/** Everything the rules need to know about the room right now. */
export interface World {
  size: number;
  layout: MapLayout;
  /** Crates that have been shot to pieces this match. */
  broken: ReadonlySet<string>;
}

export interface Segment {
  ox: number;
  oy: number;
  ex: number;
  ey: number;
}

export interface BeamPath {
  /** One segment per straight run; a mirror starts a new one. */
  segments: Segment[];
  /** Crates this beam ended on, which break when the round resolves. */
  struck: string[];
}

/** Mirrors and glass are walls this thick for movement; beams treat them as lines. */
export const WALL_THICKNESS = 6;

/** Keeps a bounced beam from re-hitting the mirror it just left. */
const BOUNCE_EPSILON = 0.5;
const EPSILON = 1e-9;

type Point = { x: number; y: number };

/** Authoring helpers: every number is a fraction of the starting inradius. */
type Authored = (k: number) => Obstacle;

const polar = (rho: number, degrees: number): Point => {
  const a = (degrees * Math.PI) / 180;
  return { x: Math.cos(a) * rho, y: Math.sin(a) * rho };
};

const pillar = (id: string, x: number, y: number, r: number) => (k: number): Obstacle =>
  ({ id, kind: 'pillar', x: x * k, y: y * k, r: r * k });

const crate = (id: string, x: number, y: number, half: number) => (k: number): Obstacle =>
  ({ id, kind: 'crate', x: x * k, y: y * k, half: half * k });

const wall = (kind: 'mirror' | 'glass', id: string, ax: number, ay: number, bx: number, by: number) =>
  (k: number): Obstacle => ({ id, kind, ax: ax * k, ay: ay * k, bx: bx * k, by: by * k });

/** A mirror given by its centre, the angle it lies at, and its length. */
const mirrorAt = (id: string, centre: Point, degrees: number, length: number) => {
  const a = (degrees * Math.PI) / 180;
  const dx = (Math.cos(a) * length) / 2;
  const dy = (Math.sin(a) * length) / 2;
  return wall('mirror', id, centre.x - dx, centre.y - dy, centre.x + dx, centre.y + dy);
};

const pad = (id: string, x: number, y: number, r: number, to: string) => (k: number): Obstacle =>
  ({ id, kind: 'teleporter', x: x * k, y: y * k, r: r * k, to });

const belt = (id: string, x: number, y: number, w: number, h: number, vx: number, vy: number) =>
  (k: number): Obstacle => ({ id, kind: 'conveyor', x: x * k, y: y * k, w: w * k, h: h * k, vx, vy });

/**
 * Two loose rings. Inner pillars outlast the last shrink stages, the outer
 * ones are gone by stage 2, so late rounds keep some cover but lose most.
 */
const PILLARS: Authored[] = [
  ...[
    [0.3, 8],
    [0.3, 97],
    [0.3, 186],
    [0.3, 275],
  ].map(([rho, deg], i) => {
    const c = polar(rho!, deg!);
    return pillar(`pillar-${i}`, c.x, c.y, 0.08);
  }),
  ...[
    [0.7, 40],
    [0.7, 128],
    [0.7, 221],
    [0.7, 310],
  ].map(([rho, deg], i) => {
    const c = polar(rho!, deg!);
    return pillar(`pillar-${i + 4}`, c.x, c.y, 0.09);
  }),
];

/** Five mirrors on a ring, each turned a different way so every one offers a bank shot. */
const MIRRORS: Authored[] = [
  [0, 52],
  [72, 118],
  [144, 20],
  [216, 100],
  [288, 160],
].map(([place, lean], i) => mirrorAt(`mirror-${i}`, polar(0.44, place!), lean!, 0.34));

/** Small clusters of crates with open lanes between them. */
const CRATES: Authored[] = [
  [0.4, -0.44],
  [0.55, -0.44],
  [0.4, -0.29],
  [0.46, 0.38],
  [0.46, 0.53],
  [-0.42, 0.44],
  [-0.57, 0.44],
  [-0.57, 0.29],
  [-0.44, -0.4],
  [-0.44, -0.55],
].map(([x, y], i) => crate(`crate-${i}`, x!, y!, 0.07));

const LAB: Authored[] = [
  wall('glass', 'glass-0', -0.3, -0.55, -0.3, 0.15),
  wall('glass', 'glass-1', 0.3, -0.15, 0.3, 0.55),
  wall('glass', 'glass-2', -0.12, 0, 0.12, 0),
  pad('pad-0', -0.68, 0.18, 0.085, 'pad-1'),
  pad('pad-1', 0.68, -0.18, 0.085, 'pad-0'),
];

const FACTORY: Authored[] = [
  belt('belt-0', 0, -0.45, 0.6, 0.16, 200, 0),
  belt('belt-1', 0, 0.45, 0.6, 0.16, -200, 0),
  belt('belt-2', -0.58, 0, 0.16, 0.6, 0, -170),
  pillar('pillar-0', 0.2, 0.12, 0.08),
  pillar('pillar-1', -0.2, -0.12, 0.08),
];

const AUTHORED: Record<MapId, Authored[]> = {
  reactor: [],
  pillars: PILLARS,
  mirrors: MIRRORS,
  warehouse: CRATES,
  lab: LAB,
  factory: FACTORY,
};

/** Concrete obstacles for a match, scaled to its starting arena. Same inputs, same layout. */
export function layoutFor(id: MapId, baseSize: number): MapLayout {
  const k = inradius(baseSize);
  return { id, obstacles: AUTHORED[id].map((make) => make(k)) };
}

export function openWorld(size: number): World {
  return { size, layout: { id: 'reactor', obstacles: [] }, broken: new Set() };
}

/** Obstacles still in play: not broken, and fully inside the current wall. */
export function activeObstacles(world: World): Obstacle[] {
  const limit = inradius(world.size);
  return world.layout.obstacles.filter((o) => !world.broken.has(o.id) && reach(o) <= limit);
}

/** Furthest an obstacle extends from the centre, in the octagon's own measure. */
function reach(o: Obstacle): number {
  const measure = (x: number, y: number) =>
    Math.max(Math.abs(x), Math.abs(y), (Math.abs(x) + Math.abs(y)) * Math.SQRT1_2);
  switch (o.kind) {
    case 'mirror':
    case 'glass':
      return Math.max(measure(o.ax, o.ay), measure(o.bx, o.by));
    case 'pillar':
    case 'teleporter':
      return measure(o.x, o.y) + o.r;
    case 'crate':
      return measure(o.x, o.y) + o.half * Math.SQRT2;
    case 'conveyor':
      return measure(o.x, o.y) + Math.hypot(o.w, o.h) / 2;
  }
}

interface Hit {
  t: number;
  obstacle: Obstacle;
}

/** Distance along a unit ray to a circle, or null. Starting inside counts as a hit at 0. */
function rayCircle(o: Point, d: Point, c: Point, r: number): number | null {
  const fx = o.x - c.x;
  const fy = o.y - c.y;
  const b = fx * d.x + fy * d.y;
  const disc = b * b - (fx * fx + fy * fy - r * r);
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const near = -b - root;
  const far = -b + root;
  if (far < 0) return null;
  return Math.max(near, 0);
}

/** Distance along a unit ray to an axis-aligned square (slab test), or null. */
function rayBox(o: Point, d: Point, c: Point, half: number): number | null {
  let enter = -Infinity;
  let exit = Infinity;
  for (const [origin, dir, centre] of [
    [o.x, d.x, c.x],
    [o.y, d.y, c.y],
  ] as const) {
    if (Math.abs(dir) < EPSILON) {
      if (Math.abs(origin - centre) > half) return null;
      continue;
    }
    const t1 = (centre - half - origin) / dir;
    const t2 = (centre + half - origin) / dir;
    enter = Math.max(enter, Math.min(t1, t2));
    exit = Math.min(exit, Math.max(t1, t2));
  }
  if (exit < Math.max(enter, 0)) return null;
  return Math.max(enter, 0);
}

/** Distance along a unit ray to a segment, or null when parallel or missed. */
function raySegment(o: Point, d: Point, a: Point, b: Point): number | null {
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denom = d.x * sy - d.y * sx;
  if (Math.abs(denom) < EPSILON) return null;
  const t = ((a.x - o.x) * sy - (a.y - o.y) * sx) / denom;
  const u = ((a.x - o.x) * d.y - (a.y - o.y) * d.x) / denom;
  return t > EPSILON && u >= 0 && u <= 1 ? t : null;
}

/** The nearest thing in the way that stops or turns a beam. Glass and floor pads are invisible to it. */
function firstHit(o: Point, d: Point, obstacles: readonly Obstacle[], skip: string | null): Hit | null {
  let best: Hit | null = null;
  for (const obstacle of obstacles) {
    if (obstacle.id === skip) continue;
    let t: number | null = null;
    if (obstacle.kind === 'pillar') t = rayCircle(o, d, obstacle, obstacle.r);
    else if (obstacle.kind === 'crate') t = rayBox(o, d, obstacle, obstacle.half);
    else if (obstacle.kind === 'mirror') {
      t = raySegment(o, d, { x: obstacle.ax, y: obstacle.ay }, { x: obstacle.bx, y: obstacle.by });
    }
    if (t !== null && (best === null || t < best.t)) best = { t, obstacle };
  }
  return best;
}

/** Follows a beam: stops at walls, pillars and crates, reflects off mirrors, passes glass. */
export function traceBeam(origin: Point, dir: Point, world: World): BeamPath {
  const obstacles = activeObstacles(world);
  const segments: Segment[] = [];
  const struck: string[] = [];
  let o = { x: origin.x, y: origin.y };
  let d = { x: dir.x, y: dir.y };
  let last: string | null = null;

  for (let bounces = 0; ; bounces++) {
    const wallT = rayToWall(o, d, world.size);
    const hit = firstHit(o, d, obstacles, last);
    const t = hit && hit.t < wallT ? hit.t : wallT;
    const end = { x: o.x + d.x * t, y: o.y + d.y * t };
    segments.push({ ox: o.x, oy: o.y, ex: end.x, ey: end.y });

    if (!hit || hit.t >= wallT) break;
    if (hit.obstacle.kind === 'crate') struck.push(hit.obstacle.id);
    if (hit.obstacle.kind !== 'mirror' || bounces >= MAX_BOUNCES) break;

    d = reflect(d, hit.obstacle);
    o = { x: end.x + d.x * BOUNCE_EPSILON, y: end.y + d.y * BOUNCE_EPSILON };
    last = hit.obstacle.id;
  }
  return { segments, struck };
}

/** Angle of incidence equals angle of reflection, whichever face was hit. */
function reflect(d: Point, mirror: Extract<Obstacle, { kind: 'mirror' }>): Point {
  const len = Math.hypot(mirror.bx - mirror.ax, mirror.by - mirror.ay);
  const nx = -(mirror.by - mirror.ay) / len;
  const ny = (mirror.bx - mirror.ax) / len;
  const dot = d.x * nx + d.y * ny;
  return { x: d.x - 2 * dot * nx, y: d.y - 2 * dot * ny };
}

/** Pushes a circle out of a disc, if they overlap. */
function pushFromPoint(p: Point, c: Point, reachDist: number): Point {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= reachDist) return p;
  if (dist < EPSILON) return { x: c.x + reachDist, y: c.y };
  return { x: c.x + (dx / dist) * reachDist, y: c.y + (dy / dist) * reachDist };
}

function pushFromBox(p: Point, c: Point, half: number, radius: number): Point {
  const cx = Math.min(Math.max(p.x, c.x - half), c.x + half);
  const cy = Math.min(Math.max(p.y, c.y - half), c.y + half);
  if (cx !== p.x || cy !== p.y) return pushFromPoint(p, { x: cx, y: cy }, radius);

  // Centre inside the box: leave through the nearest face.
  const faces = [
    { d: p.x - (c.x - half), x: c.x - half - radius, y: p.y },
    { d: c.x + half - p.x, x: c.x + half + radius, y: p.y },
    { d: p.y - (c.y - half), x: p.x, y: c.y - half - radius },
    { d: c.y + half - p.y, x: p.x, y: c.y + half + radius },
  ];
  const nearest = faces.reduce((a, b) => (b.d < a.d ? b : a));
  return { x: nearest.x, y: nearest.y };
}

function pushFromWall(p: Point, a: Point, b: Point, radius: number): Point {
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const lenSq = sx * sx + sy * sy;
  const u = lenSq === 0 ? 0 : Math.min(Math.max(((p.x - a.x) * sx + (p.y - a.y) * sy) / lenSq, 0), 1);
  const closest = { x: a.x + sx * u, y: a.y + sy * u };
  const reachDist = radius + WALL_THICKNESS / 2;
  if (Math.hypot(p.x - closest.x, p.y - closest.y) >= EPSILON) return pushFromPoint(p, closest, reachDist);

  // Dead centre on the wall: step off along its normal.
  const len = Math.sqrt(lenSq) || 1;
  return { x: closest.x - (sy / len) * reachDist, y: closest.y + (sx / len) * reachDist };
}

function pushFrom(p: Point, o: Obstacle, radius: number): Point {
  switch (o.kind) {
    case 'pillar':
      return pushFromPoint(p, o, o.r + radius);
    case 'crate':
      return pushFromBox(p, o, o.half, radius);
    case 'mirror':
    case 'glass':
      return pushFromWall(p, { x: o.ax, y: o.ay }, { x: o.bx, y: o.by }, radius);
    case 'teleporter':
    case 'conveyor':
      return p;
  }
}

/**
 * Pushes a circle out of solid obstacles and back inside the wall. Repeated,
 * because leaving one thing can press you into the next or into the wall;
 * the wall has the last word each pass.
 */
export function collide(p: Point, radius: number, world: World): Point {
  const solids = activeObstacles(world);
  let at = clampToArena(p, world.size, radius);
  for (let pass = 0; pass < 4; pass++) {
    const before = at;
    for (const o of solids) at = pushFrom(at, o, radius);
    at = clampToArena(at, world.size, radius);
    if (at.x === before.x && at.y === before.y) break;
  }
  return at;
}

/** Conveyor drag at a point, in units per second. */
export function conveyorAt(p: Point, world: World): { vx: number; vy: number } {
  let vx = 0;
  let vy = 0;
  for (const o of activeObstacles(world)) {
    if (o.kind !== 'conveyor') continue;
    if (Math.abs(p.x - o.x) <= o.w / 2 && Math.abs(p.y - o.y) <= o.h / 2) {
      vx += o.vx;
      vy += o.vy;
    }
  }
  return { vx, vy };
}

/** The fastest any conveyor on this layout can drag someone, for the server's reach check. */
export function maxDrift(layout: MapLayout): number {
  let fastest = 0;
  for (const o of layout.obstacles) {
    if (o.kind === 'conveyor') fastest = Math.max(fastest, Math.hypot(o.vx, o.vy));
  }
  return fastest;
}

/**
 * Teleporter pads. `onPad` is the pad the fighter is standing on and has
 * already used (or arrived on); they must step off it before it fires again.
 */
export function teleportStep(
  p: Point,
  world: World,
  onPad: string | null,
): { x: number; y: number; onPad: string | null; jumped: boolean } {
  const under = padUnder(p, world);
  if (under === null) return { x: p.x, y: p.y, onPad: null, jumped: false };
  if (under === onPad) return { x: p.x, y: p.y, onPad, jumped: false };

  const pads = activeObstacles(world).filter((o) => o.kind === 'teleporter');
  const from = pads.find((o) => o.id === under);
  const dest = from?.kind === 'teleporter' ? pads.find((o) => o.id === from.to) : undefined;
  if (dest?.kind !== 'teleporter') return { x: p.x, y: p.y, onPad: under, jumped: false };

  const landed = collide({ x: dest.x, y: dest.y }, PLAYER_RADIUS, world);
  return { x: landed.x, y: landed.y, onPad: dest.id, jumped: true };
}

/** The teleporter pad under a point, if any. A blackout starts with this as `onPad`. */
export function padUnder(p: Point, world: World): string | null {
  for (const o of activeObstacles(world)) {
    if (o.kind === 'teleporter' && Math.hypot(p.x - o.x, p.y - o.y) <= o.r) return o.id;
  }
  return null;
}

const SPAWN_MARGIN = 6;
const SPAWN_STEP = 14;
const SPAWN_ANGLES = 16;

/** True when a fighter standing here touches no solid, no pad, no wall and no earlier spawn. */
function spawnIsClear(p: Point, world: World, placed: readonly Point[]): boolean {
  const radius = PLAYER_RADIUS + SPAWN_MARGIN;
  const settled = collide(p, radius, world);
  if (Math.hypot(settled.x - p.x, settled.y - p.y) > 1e-6) return false;
  for (const o of activeObstacles(world)) {
    if (o.kind === 'teleporter' && Math.hypot(p.x - o.x, p.y - o.y) < o.r + PLAYER_RADIUS) return false;
  }
  return placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= PLAYER_RADIUS * 2 + SPAWN_MARGIN);
}

/** The clear spot nearest to `want`, searched in widening rings. Deterministic. */
function nearestClear(want: Point, world: World, placed: readonly Point[]): Point {
  if (spawnIsClear(want, world, placed)) return want;
  const reachLimit = inradius(world.size);
  for (let ring = SPAWN_STEP; ring < reachLimit; ring += SPAWN_STEP) {
    for (let i = 0; i < SPAWN_ANGLES; i++) {
      const a = (i * 2 * Math.PI) / SPAWN_ANGLES;
      const cand = { x: want.x + Math.cos(a) * ring, y: want.y + Math.sin(a) * ring };
      if (spawnIsClear(cand, world, placed)) return cand;
    }
  }
  return want;
}

/**
 * Like `spawnPoints`, but every spawn is moved clear of solids and pads, and
 * still faces the centre. The ring itself is unchanged on an open map.
 */
export function spawnsFor(count: number, world: World, spin: number) {
  const placed: { x: number; y: number; aim: number }[] = [];
  for (const want of spawnPoints(count, world.size, spin)) {
    const at = nearestClear(want, world, placed);
    placed.push({ x: at.x, y: at.y, aim: Math.atan2(-at.y, -at.x) });
  }
  return placed;
}
