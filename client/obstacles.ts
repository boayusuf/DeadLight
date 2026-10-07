import { SIGHT_RADIUS } from '../shared/constants.js';
import { activeObstacles, type Obstacle, type World } from '../shared/maps.js';
import type { PixelBuffer } from './pixel.js';

export interface ObstacleView {
  buffer: PixelBuffer;
  /** World units → buffer pixel. 4 world units are one pixel. */
  px(wx: number): number;
  py(wy: number): number;
}

/** How the room is lit: full light, or a blackout where only your own lamp shows anything. */
export interface Lighting {
  lit: boolean;
  /** Blackout ambient, 0.1 normally and 0.5 during the warning flicker. Ignored when lit. */
  ambient: number;
  /** Your own position during a blackout, for the lamp; null when lit or spectating. */
  lamp: { x: number; y: number } | null;
}

export type Crate = Extract<Obstacle, { kind: 'crate' }>;
type Pillar = Extract<Obstacle, { kind: 'pillar' }>;
type Mirror = Extract<Obstacle, { kind: 'mirror' }>;
type Glass = Extract<Obstacle, { kind: 'glass' }>;
type Teleporter = Extract<Obstacle, { kind: 'teleporter' }>;
type Conveyor = Extract<Obstacle, { kind: 'conveyor' }>;

/* Same cold facility palette as render.ts. Wood is the only warm material, so a
 * crate always reads as the thing that breaks. Violet belongs to machines: no
 * fighter is ever drawn in it. */
const METAL = 0x47525f;
const METAL_LIGHT = 0x6e7b8c;
const METAL_DARK = 0x1b2026;
const PILLAR_FACE = 0x2b323c;
const PILLAR_LIGHT = 0x3e4855;
const PILLAR_DARK = 0x171b21;
const CAP = 0x384250;
const AMBER = 0xd9953a;
const AMBER_DIM = 0x7a5320;
const PALE = 0xccd6e2;
const INK = 0x79849a;
const WOOD = 0x5a4a38;
const WOOD_LIGHT = 0x7a654b;
const WOOD_DARK = 0x35291f;
const MIRROR_FACE = 0xbfd0e0;
const MIRROR_DEEP = 0x86a0b8;
const GLASS = 0xa8dcea;
const TELE = 0x8574d6;
const TELE_LIGHT = 0xcdc4f7;
const BELT = 0x1d232b;

const UNITS_PER_PX = 4;
const PILLAR_HEIGHT = 4;
const CRATE_LIFT = 3;
const PANEL_LIFT = 3;
const CHEVRON_PERIOD = 8;

/* ---------------------------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------------------------ */

/** Blackout visibility: a flat ambient floor plus the pool of your own lamp. */
interface Dim {
  base: number;
  lx: number;
  ly: number;
  /** Lamp reach in buffer pixels; 0 when there is no lamp. */
  reach: number;
}

function dimFor(view: ObstacleView, light: Lighting): Dim | null {
  if (light.lit) return null;
  const lamp = light.lamp;
  return {
    base: 0.07 + light.ambient * 0.3,
    lx: lamp ? view.px(lamp.x) : 0,
    ly: lamp ? view.py(lamp.y) : 0,
    reach: lamp ? (SIGHT_RADIUS * 1.8) / UNITS_PER_PX : 0,
  };
}

/** Alpha of a silhouette pixel at (x, y); the lamp adds up to +0.6 close in. */
function level(dim: Dim, x: number, y: number): number {
  if (dim.reach === 0) return dim.base;
  const near = Math.max(0, 1 - Math.hypot(x - dim.lx, y - dim.ly) / dim.reach);
  return dim.base + near ** 1.2 * 0.6;
}

function hashOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Visits every pixel of a line once, with its position along it in 0..1. */
function eachStep(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  visit: (x: number, y: number, t: number) => void,
): void {
  const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    visit(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t), t);
  }
}

/** A blackout silhouette: one blend per pixel, so overlapping parts never stack brighter. */
function silhouette(
  buffer: PixelBuffer,
  dim: Dim,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: number,
  inside: (x: number, y: number) => boolean,
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (inside(x, y)) buffer.blend(x, y, color, level(dim, x, y));
    }
  }
}

/** Painter's order: whatever stands further down the screen is drawn later. */
function footY(o: Obstacle): number {
  switch (o.kind) {
    case 'mirror':
    case 'glass':
      return Math.max(o.ay, o.by);
    case 'pillar':
    case 'teleporter':
    case 'conveyor':
    case 'crate':
      return o.y;
  }
}

/* ---------------------------------------------------------------------------
 * Floor: teleporters and conveyors
 * ------------------------------------------------------------------------ */

/** Teleporter pads and conveyor belts: drawn on the floor, under scorches, beams and fighters. */
export function drawFloorObstacles(view: ObstacleView, world: World, light: Lighting, now: number): void {
  const dim = dimFor(view, light);
  for (const o of activeObstacles(world)) {
    if (o.kind === 'teleporter') drawTeleporter(view, world, o, dim, now);
    else if (o.kind === 'conveyor') drawConveyor(view, o, dim, now);
  }
}

/** Which linked pair a pad belongs to, so both ends carry the same number of pips. */
function pairIndex(world: World, pad: Teleporter): number {
  const key = pad.id < pad.to ? pad.id : pad.to;
  let index = 0;
  for (const o of world.layout.obstacles) {
    if (o.kind === 'teleporter' && o.id < o.to && o.id < key) index++;
  }
  return index;
}

function drawTeleporter(view: ObstacleView, world: World, o: Teleporter, dim: Dim | null, now: number): void {
  const b = view.buffer;
  const cx = view.px(o.x);
  const cy = view.py(o.y);
  const r = Math.max(5, Math.round(o.r / UNITS_PER_PX));
  const pulse = 0.5 + 0.5 * Math.sin(now / 520);

  if (dim) {
    const a = level(dim, cx, cy);
    b.ring(cx, cy, r, TELE, 0.1 + a * 0.55, true);
    const phase = (now / 1500) % 1;
    b.ring(cx, cy, (r - 1) * (1 - phase), TELE, (0.08 + a * 0.4) * phase, true);
    b.glow(cx, cy, r * 0.6, TELE, 0.05 + a * 0.2);
    return;
  }

  b.disc(cx, cy, r, 0x0c0f14, 0.78);
  b.ring(cx, cy, r, METAL, 1);
  b.ring(cx, cy, r - 1, METAL_DARK, 0.7);
  // Eight ticks on the rim crawl round the pad; both ends of a pair share the same clock.
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + now / 2600;
    b.add(Math.round(cx + Math.cos(angle) * r), Math.round(cy + Math.sin(angle) * r), TELE, 0.55 + pulse * 0.3);
  }
  // Rings fall inward and brighten as they arrive: the pad is pulling.
  for (let k = 0; k < 3; k++) {
    const phase = (now / 1500 + k / 3) % 1;
    b.ring(cx, cy, (r - 1.5) * (1 - phase) + 0.5, TELE, 0.12 + phase * 0.6, true);
  }
  b.glow(cx, cy, r * 0.75, TELE, 0.18 + pulse * 0.16);
  b.disc(cx, cy, 1, TELE_LIGHT, 0.9);

  const pips = pairIndex(world, o) + 1;
  for (let i = 0; i < pips; i++) b.blend(cx - (pips - 1) + i * 2, cy + r + 2, TELE_LIGHT, 0.9);
}

function drawConveyor(view: ObstacleView, o: Conveyor, dim: Dim | null, now: number): void {
  const b = view.buffer;
  const w = Math.max(4, Math.round(o.w / UNITS_PER_PX));
  const h = Math.max(4, Math.round(o.h / UNITS_PER_PX));
  const x0 = view.px(o.x) - (w >> 1);
  const y0 = view.py(o.y) - (h >> 1);
  const speed = Math.hypot(o.vx, o.vy);
  const dx = speed > 0 ? o.vx / speed : 1;
  const dy = speed > 0 ? o.vy / speed : 0;
  // The belt moves exactly as fast as it drags: units per second over units per pixel.
  const scroll = Math.floor(((now / 1000) * speed) / UNITS_PER_PX);
  const flowsAcross = Math.abs(dx) >= Math.abs(dy);
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;

  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const edge = flowsAcross ? y - y0 < 2 || y >= y0 + h - 2 : x - x0 < 2 || x >= x0 + w - 2;
      const along = (x + 0.5 - cx) * dx + (y + 0.5 - cy) * dy;
      const across = -(x + 0.5 - cx) * dy + (y + 0.5 - cy) * dx;
      const phase = Math.floor(along + Math.abs(across)) - scroll;
      const m = ((phase % CHEVRON_PERIOD) + CHEVRON_PERIOD) % CHEVRON_PERIOD;
      if (dim) paintDarkBelt(b, dim, x, y, edge, m);
      else paintLitBelt(b, x, y, edge, m);
    }
  }
}

function paintLitBelt(b: PixelBuffer, x: number, y: number, edge: boolean, m: number): void {
  if (edge) {
    // Diagonal hazard tape along the long edges.
    const stripe = (x + y) % 4 < 2;
    b.blend(x, y, stripe ? AMBER : METAL_DARK, stripe ? 0.85 : 0.9);
    return;
  }
  b.blend(x, y, BELT, 0.95);
  if (m === 0) b.blend(x, y, PALE, 0.55);
  else if (m === 1) b.blend(x, y, INK, 0.5);
}

function paintDarkBelt(b: PixelBuffer, dim: Dim, x: number, y: number, edge: boolean, m: number): void {
  const a = level(dim, x, y);
  if (edge) b.blend(x, y, METAL, a * 0.5);
  else if (m < 2) b.add(x, y, AMBER_DIM, 0.1 + a * 0.45);
}

/* ---------------------------------------------------------------------------
 * Solids: pillars, crates, mirrors, glass
 * ------------------------------------------------------------------------ */

/** Pillars, crates, mirrors and glass: drawn after the floor, before beams and fighters. */
export function drawSolidObstacles(view: ObstacleView, world: World, light: Lighting, now: number): void {
  const dim = dimFor(view, light);
  const solids = activeObstacles(world)
    .filter((o) => o.kind !== 'teleporter' && o.kind !== 'conveyor')
    .sort((p, q) => footY(p) - footY(q));
  for (const o of solids) {
    switch (o.kind) {
      case 'pillar':
        drawPillar(view, o, dim, now);
        break;
      case 'crate':
        drawCrate(view, o, dim);
        break;
      case 'mirror':
        drawMirror(view, o, dim, now);
        break;
      case 'glass':
        drawGlass(view, o, dim, now);
        break;
      default:
        break;
    }
  }
}

function drawPillar(view: ObstacleView, o: Pillar, dim: Dim | null, now: number): void {
  const b = view.buffer;
  const cx = view.px(o.x);
  const cy = view.py(o.y);
  const r = Math.max(3, Math.round(o.r / UNITS_PER_PX));
  const top = cy - PILLAR_HEIGHT;

  if (dim) {
    const reach2 = r * r;
    silhouette(b, dim, cx - r, top - r, r * 2 + 1, r * 2 + PILLAR_HEIGHT + 1, METAL_LIGHT, (x, y) => {
      const dx = (x - cx) ** 2;
      return dx + (y - cy) ** 2 <= reach2 || dx + (y - top) ** 2 <= reach2;
    });
    b.ring(cx, top, r, METAL_LIGHT, level(dim, cx, top) * 0.8);
    return;
  }

  b.disc(cx + 1, cy + 1, r + 1, 0x000000, 0.3);
  b.disc(cx, cy, r, PILLAR_DARK);
  // Stacked discs build the side wall; the offset between foot and cap is the height.
  for (let k = 1; k <= PILLAR_HEIGHT; k++) b.disc(cx, cy - k, r, PILLAR_FACE);
  const bulge = Math.round(r * 0.62);
  b.line(cx - bulge, top, cx - bulge, cy, PILLAR_LIGHT, 0.9);
  b.line(cx + bulge, top, cx + bulge, cy, PILLAR_DARK, 0.9);
  b.disc(cx, top, r, CAP);
  b.disc(cx - 1, top - 1, Math.max(1, r - 3), PILLAR_LIGHT);
  b.ring(cx, top, r, METAL_LIGHT, 0.85);

  // Only some columns carry a status lamp, and it winks rather than glows.
  const seed = hashOf(o.id);
  if (seed % 3 === 0 && Math.floor(now / 900 + seed) % 5 !== 0) {
    const lx = cx + Math.round(r * 0.3);
    b.blend(lx, cy - 1, AMBER, 0.9);
    b.glow(lx, cy - 1, 2, AMBER, 0.2);
  }
}

function drawCrate(view: ObstacleView, o: Crate, dim: Dim | null): void {
  const b = view.buffer;
  const half = Math.max(3, Math.round(o.half / UNITS_PER_PX));
  const w = half * 2;
  const x0 = view.px(o.x) - half;
  const y0 = view.py(o.y) - half - CRATE_LIFT;

  if (dim) {
    silhouette(b, dim, x0, y0, w, w + CRATE_LIFT, METAL_LIGHT, () => true);
    b.rect(x0, y0, w, 1, METAL_LIGHT, level(dim, x0 + half, y0) * 0.7);
    return;
  }

  b.rect(x0 + 2, y0 + CRATE_LIFT + 2, w, w, 0x000000, 0.3);
  b.rect(x0, y0 + w, w, CRATE_LIFT, WOOD_DARK);
  b.rect(x0, y0, w, w, WOOD);
  for (let y = y0 + 3; y < y0 + w; y += 3) b.rect(x0, y, w, 1, WOOD_DARK, 0.55);
  b.rect(x0, y0, w, 1, WOOD_LIGHT);
  b.rect(x0, y0, 1, w, WOOD_LIGHT, 0.8);
  paintCrateBands(b, x0, y0, w);
  paintCrateWear(b, x0, y0, w, hashOf(o.id));
}

/** Steel straps and rivets, plus a stencilled cross: the cross is what says "shoot me". */
function paintCrateBands(b: PixelBuffer, x0: number, y0: number, w: number): void {
  const strap = w >= 10 ? 2 : 1;
  const height = w + CRATE_LIFT;
  for (const sx of [x0 + 1, x0 + w - 1 - strap]) {
    b.rect(sx, y0, strap, height, METAL);
    b.rect(sx, y0, 1, height, METAL_LIGHT, 0.6);
    b.blend(sx, y0 + 2, PALE, 0.8);
    b.blend(sx, y0 + w - 3, PALE, 0.8);
  }
  b.rect(x0, y0 + w - 1, w, 1, METAL, 0.9);
  b.rect(x0 + w - 1, y0, 1, w, METAL_DARK, 0.9);

  const inner = w - 2 * (strap + 2);
  if (inner < 3) return;
  const sx = x0 + strap + 2;
  const sy = y0 + Math.floor((w - inner) / 2);
  b.line(sx, sy, sx + inner - 1, sy + inner - 1, INK, 0.7);
  b.line(sx + inner - 1, sy, sx, sy + inner - 1, INK, 0.7);
}

/** Cracks and chipped edges; fixed per crate so they never shimmer. */
function paintCrateWear(b: PixelBuffer, x0: number, y0: number, w: number, seed: number): void {
  for (let i = 0; i < 4; i++) {
    const at = (Math.imul(seed, i + 3) >>> 0) % w;
    const bottom = (i & 1) === 0;
    b.blend(x0 + at, bottom ? y0 + w + CRATE_LIFT - 1 : y0, METAL_DARK, 0.85);
  }
  if (w < 10) return;
  const sx = x0 + 3 + (seed % 3);
  b.polyline(
    [
      { x: sx, y: y0 + 2 },
      { x: sx + 1, y: y0 + 4 },
      { x: sx, y: y0 + 6 },
      { x: sx + 2, y: y0 + 8 },
    ],
    WOOD_DARK,
    0.9,
  );
}

function drawMirror(view: ObstacleView, o: Mirror, dim: Dim | null, now: number): void {
  const b = view.buffer;
  const ax = view.px(o.ax);
  const ay = view.py(o.ay);
  const bx = view.px(o.bx);
  const by = view.py(o.by);

  if (dim) {
    paintDarkPanel(b, dim, ax, ay, bx, by, METAL_LIGHT, 1.1);
    return;
  }

  const vertical = Math.abs(bx - ax) < Math.abs(by - ay);
  b.line(ax + 1, ay + 1, bx + 1, by + 1, 0x000000, 0.35);
  if (vertical) {
    b.line(ax, ay, bx, by, METAL_DARK);
    b.line(ax, ay - PANEL_LIFT, bx, by - PANEL_LIFT, MIRROR_FACE);
    b.line(ax + 1, ay - PANEL_LIFT, bx + 1, by - PANEL_LIFT, MIRROR_DEEP);
    b.line(ax - 1, ay - PANEL_LIFT, bx - 1, by - PANEL_LIFT, METAL_LIGHT);
    const lowY = Math.max(ay, by);
    const lowX = ay > by ? ax : bx;
    b.rect(lowX - 1, lowY - PANEL_LIFT, 3, PANEL_LIFT, MIRROR_DEEP);
  } else {
    b.line(ax, ay, bx, by, METAL_DARK);
    b.line(ax, ay - 1, bx, by - 1, MIRROR_DEEP);
    b.line(ax, ay - 2, bx, by - 2, MIRROR_FACE);
    b.line(ax, ay - PANEL_LIFT, bx, by - PANEL_LIFT, METAL_LIGHT);
  }
  // Frame posts at both ends.
  for (const [x, y] of [[ax, ay], [bx, by]] as const) {
    b.rect(x - 1, y - PANEL_LIFT - 1, 2, PANEL_LIFT + 2, METAL);
    b.blend(x - 1, y - PANEL_LIFT - 1, PALE, 0.7);
  }
  paintGlint(b, o.id, ax, ay, bx, by, vertical, now);
}

/** A bright spot that sweeps along the panel, then rests off the end for a beat. */
function paintGlint(
  b: PixelBuffer,
  id: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  vertical: boolean,
  now: number,
): void {
  const sweep = ((now / 2600 + (hashOf(id) % 7) / 7) % 1.5) - 0.25;
  const lift = vertical ? PANEL_LIFT : 2;
  const span = Math.max(3, Math.hypot(bx - ax, by - ay) * 0.14);
  const length = Math.max(Math.hypot(bx - ax, by - ay), 1);
  eachStep(ax, ay, bx, by, (x, y, t) => {
    const near = 1 - Math.abs(t - sweep) * (length / span);
    if (near > 0) b.add(x, y - lift, 0xffffff, near * 0.85);
  });
}

function drawGlass(view: ObstacleView, o: Glass, dim: Dim | null, now: number): void {
  const b = view.buffer;
  const ax = view.px(o.ax);
  const ay = view.py(o.ay);
  const bx = view.px(o.bx);
  const by = view.py(o.by);

  if (dim) {
    paintDarkPanel(b, dim, ax, ay, bx, by, GLASS, 0.5);
    return;
  }

  const vertical = Math.abs(bx - ax) < Math.abs(by - ay);
  b.line(ax, ay, bx, by, METAL_DARK, 0.55);
  if (vertical) {
    b.line(ax - 1, ay - PANEL_LIFT, bx - 1, by - PANEL_LIFT, GLASS, 0.5);
    b.line(ax, ay - PANEL_LIFT, bx, by - PANEL_LIFT, GLASS, 0.14);
    b.line(ax + 1, ay - PANEL_LIFT, bx + 1, by - PANEL_LIFT, GLASS, 0.3);
  } else {
    b.line(ax, ay - PANEL_LIFT, bx, by - PANEL_LIFT, GLASS, 0.55);
    b.line(ax, ay - 1, bx, by - 1, GLASS, 0.13);
    b.line(ax, ay - 2, bx, by - 2, GLASS, 0.13);
  }
  for (const [x, y] of [[ax, ay], [bx, by]] as const) {
    b.rect(x, y - PANEL_LIFT - 1, 1, PANEL_LIFT + 2, METAL, 0.8);
  }
  paintStreaks(b, o.id, ax, ay, bx, by, now);
}

/** Two short diagonal highlights that shimmer slowly; the only thing that says "pane". */
function paintStreaks(b: PixelBuffer, id: string, ax: number, ay: number, bx: number, by: number, now: number): void {
  const seed = hashOf(id) % 10;
  eachStep(ax, ay, bx, by, (x, y, t) => {
    const slot = Math.round(t * 20);
    if (slot % 7 !== seed % 7) return;
    const shimmer = 0.3 + 0.25 * Math.sin(now / 700 + slot);
    b.add(x, y - 2, PALE, shimmer);
    b.add(x + 1, y - 3, PALE, shimmer * 0.7);
  });
}

/** Blackout panel: the rail and body as a faint line, brighter under your lamp. */
function paintDarkPanel(
  b: PixelBuffer,
  dim: Dim,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  color: number,
  gain: number,
): void {
  const vertical = Math.abs(bx - ax) < Math.abs(by - ay);
  eachStep(ax, ay, bx, by, (x, y) => {
    const a = level(dim, x, y) * gain;
    if (vertical) {
      b.blend(x, y - PANEL_LIFT, color, a);
      b.blend(x + 1, y - PANEL_LIFT, color, a);
      return;
    }
    for (let k = 0; k <= PANEL_LIFT; k++) b.blend(x, y - k, color, a);
  });
}

/* ---------------------------------------------------------------------------
 * One-off effects
 * ------------------------------------------------------------------------ */

type ParticleKind = 'splinter' | 'dust' | 'plank';

interface Particle {
  kind: ParticleKind;
  /** World units. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Height above the floor in buffer pixels, so planks can bounce. */
  z: number;
  vz: number;
  born: number;
  life: number;
  size: number;
  color: number;
}

interface Pulse {
  kind: 'in' | 'out';
  x: number;
  y: number;
  color: number;
  born: number;
}

const FX_MAX_PARTICLES = 160;
const TELEPORT_MS = 350;
const GRAVITY = 420;

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/** One-off effects the room produces: crates splintering, teleport flashes. */
export class ObstacleFx {
  private particles: Particle[] = [];
  private pulses: Pulse[] = [];
  private last = 0;

  crateBroken(crate: Crate, now: number): void {
    const spread = crate.half * 0.8;
    for (let i = 0; i < 12; i++) this.spawn('splinter', crate, spread, now, 300, 550, 120, 320, 30, 80);
    for (let i = 0; i < 4; i++) this.spawn('plank', crate, spread, now, 520, 640, 60, 170, 60, 110);
    for (let i = 0; i < 8; i++) this.spawn('dust', crate, spread, now, 420, 620, 20, 90, 4, 14);
  }

  teleported(from: { x: number; y: number }, to: { x: number; y: number }, color: number, now: number): void {
    this.pulses.push({ kind: 'in', x: from.x, y: from.y, color, born: now });
    this.pulses.push({ kind: 'out', x: to.x, y: to.y, color, born: now });
  }

  draw(view: ObstacleView, now: number): void {
    this.step(now);
    for (const p of this.particles) paintParticle(view, p, now);
    this.pulses = this.pulses.filter((p) => now - p.born < TELEPORT_MS);
    for (const p of this.pulses) paintPulse(view, p, now);
  }

  clear(): void {
    this.particles = [];
    this.pulses = [];
    this.last = 0;
  }

  private spawn(
    kind: ParticleKind,
    crate: Crate,
    spread: number,
    now: number,
    lifeLo: number,
    lifeHi: number,
    speedLo: number,
    speedHi: number,
    liftLo: number,
    liftHi: number,
  ): void {
    if (this.particles.length >= FX_MAX_PARTICLES) return;
    const angle = rand(0, Math.PI * 2);
    const speed = rand(speedLo, speedHi);
    const flat = kind === 'dust';
    this.particles.push({
      kind,
      x: crate.x + rand(-spread, spread),
      y: crate.y + rand(-spread, spread),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      z: rand(2, 6),
      vz: flat ? rand(4, 14) : rand(liftLo, liftHi),
      born: now,
      life: rand(lifeLo, lifeHi),
      size: kind === 'dust' ? rand(2, 4) : rand(2, 3),
      color: [WOOD, WOOD_LIGHT, WOOD_DARK, METAL][Math.floor(rand(0, 4))]!,
    });
  }

  /** Integrates by the gap between draws, so replays and pauses never fling anything. */
  private step(now: number): void {
    const dt = this.last === 0 ? 0 : Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    let kept = 0;
    for (const p of this.particles) {
      if (now - p.born >= p.life) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.kind !== 'dust') p.vz -= GRAVITY * dt;
      if (p.z < 0) {
        p.z = 0;
        p.vz = p.kind === 'plank' ? -p.vz * 0.45 : 0;
        p.vx *= 0.7;
        p.vy *= 0.7;
      }
      this.particles[kept++] = p;
    }
    this.particles.length = kept;
  }
}

function paintParticle(view: ObstacleView, p: Particle, now: number): void {
  const b = view.buffer;
  const age = Math.max(0, now - p.born) / p.life;
  const x = view.px(p.x);
  const y = view.py(p.y);
  const fade = Math.min(1, (1 - age) * 3);

  if (p.kind === 'dust') {
    b.disc(x, y - Math.round(p.z), 1 + age * p.size, 0x6d7480, (1 - age) * 0.35);
    return;
  }
  const lift = Math.round(p.z);
  if (p.kind === 'plank') {
    if (lift > 0) b.blend(x + 1, y, 0x000000, 0.3 * fade);
    b.rect(x, y - lift, Math.round(p.size) + 1, 2, p.color, fade);
    b.blend(x, y - lift, METAL_LIGHT, 0.7 * fade);
    return;
  }
  const tx = Math.round(p.vx * 0.02 / UNITS_PER_PX);
  const ty = Math.round(p.vy * 0.02 / UNITS_PER_PX);
  b.blend(x, y - lift, p.color, fade);
  b.blend(x - tx, y - ty - lift, p.color, fade * 0.5);
}

function paintPulse(view: ObstacleView, p: Pulse, now: number): void {
  const b = view.buffer;
  const t = Math.min(1, Math.max(0, (now - p.born) / TELEPORT_MS));
  const cx = view.px(p.x);
  const cy = view.py(p.y);

  if (p.kind === 'in') {
    const radius = (1 - t) * 13;
    b.ring(cx, cy, radius, p.color, 0.3 + t * 0.6, true);
    b.ring(cx, cy, radius * 0.55, PALE, 0.25 + t * 0.5, true);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + t * 2;
      b.add(Math.round(cx + Math.cos(angle) * radius), Math.round(cy + Math.sin(angle) * radius), PALE, 0.8);
    }
    b.glow(cx, cy, 4 + t * 3, p.color, t * 0.8);
    return;
  }
  const radius = t * 14;
  b.ring(cx, cy, radius, p.color, 1 - t, true);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + 0.3;
    b.line(
      cx + Math.cos(angle) * radius * 0.4,
      cy + Math.sin(angle) * radius * 0.4,
      cx + Math.cos(angle) * radius,
      cy + Math.sin(angle) * radius,
      PALE,
      (1 - t) * 0.8,
      true,
    );
  }
  b.glow(cx, cy, 3 + (1 - t) * 5, p.color, (1 - t) * 0.9);
}

/* ---------------------------------------------------------------------------
 * Sound
 * ------------------------------------------------------------------------ */

const noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();

function noiseFor(ctx: AudioContext): AudioBuffer {
  const cached = noiseBuffers.get(ctx);
  if (cached) return cached;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffers.set(ctx, buffer);
  return buffer;
}

function decay(ctx: AudioContext, out: AudioNode, at: number, dur: number, peak: number): GainNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(peak, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  gain.connect(out);
  return gain;
}

function tone(
  ctx: AudioContext,
  out: AudioNode,
  type: OscillatorType,
  from: number,
  to: number,
  at: number,
  dur: number,
  peak: number,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + dur);
  osc.connect(decay(ctx, out, at, dur, peak));
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function burst(
  ctx: AudioContext,
  out: AudioNode,
  filter: BiquadFilterType,
  freq: number,
  at: number,
  dur: number,
  peak: number,
): void {
  const source = ctx.createBufferSource();
  const biquad = ctx.createBiquadFilter();
  source.buffer = noiseFor(ctx);
  biquad.type = filter;
  biquad.frequency.value = freq;
  source.connect(biquad).connect(decay(ctx, out, at, dur, peak));
  source.start(at);
  source.stop(at + dur + 0.02);
}

/** Synthesised sounds for the room, on the shared bus. */
export function obstacleSound(kind: 'crate' | 'teleport' | 'bounce', ctx: AudioContext, out: AudioNode): void {
  const t = ctx.currentTime;
  if (kind === 'crate') {
    burst(ctx, out, 'bandpass', 1800, t, 0.09, 0.14);
    burst(ctx, out, 'highpass', 3200, t + 0.035, 0.06, 0.07);
    burst(ctx, out, 'lowpass', 420, t + 0.02, 0.16, 0.1);
    tone(ctx, out, 'sine', 150, 52, t + 0.02, 0.18, 0.15);
  } else if (kind === 'teleport') {
    tone(ctx, out, 'triangle', 280, 1500, t, 0.1, 0.09);
    tone(ctx, out, 'triangle', 1500, 170, t + 0.1, 0.22, 0.08);
    tone(ctx, out, 'square', 560, 3000, t, 0.1, 0.025);
    burst(ctx, out, 'highpass', 4500, t + 0.08, 0.1, 0.05);
  } else {
    tone(ctx, out, 'triangle', 2300, 2150, t, 0.24, 0.1);
    tone(ctx, out, 'sine', 3450, 3300, t, 0.16, 0.05);
    burst(ctx, out, 'highpass', 6500, t, 0.025, 0.05);
  }
}
