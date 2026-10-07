import type { FinisherId } from '../shared/constants.js';
import { PixelBuffer } from './pixel.js';
import { SPRITE_H, SPRITE_W, facingFor, sprite, type Sprite } from './sprites.js';

export interface FinisherView {
  buffer: PixelBuffer;
  /** World units → buffer pixel. */
  px(wx: number): number;
  py(wy: number): number;
}

export interface Victim {
  x: number;
  y: number;
  aim: number;
  color: number;
  archetype: number;
  /** Where the killing shot came from (world units), so debris can blow away from it. */
  from: { x: number; y: number } | null;
}

/* ---------------------------------------------------------------------------
 * Every effect is a pure function of (spawn data, now - start). Nothing is
 * stepped frame by frame, so the killcam can run the same code on a slowed
 * clock and get the same picture, only slower.
 * ------------------------------------------------------------------------ */

const WHITE = 0xffffff;
const PALE = 0xccd6e2;
const CYAN = 0x4ff4ff;
const RED = 0xff3b4d;
const EMBER = 0xff8a3c;
const ASH_GREY = 0x4a5058;
const BLACK = 0x000000;
const VOID = 0x0b0d12;

/** Sprite pixel (0, 0) sits at this offset from the fighter's anchor. */
const BODY_LEFT = -(SPRITE_W >> 1);
const BODY_TOP = -11;
const FLOOR_Y = 9;
/** Roughly the chest: where hits land and everything converges. */
const CHEST_Y = -1;

/** A body pixel as an offset from the anchor, flip already applied. */
interface Px {
  x: number;
  y: number;
  color: number;
}

/** One free-flying pixel. Position is closed-form in time, never integrated. */
interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** ms after spawn at which it starts moving. */
  born: number;
  life: number;
  drag: number;
  grav: number;
  size: number;
  c0: number;
  c1: number;
  add: boolean;
}

/** A pixel spiralling into the chest. */
interface Swirl {
  angle: number;
  radius: number;
  delay: number;
  dur: number;
  color: number;
  /** Body pixels are visible from the start; dust only once it is pulled in. */
  body: boolean;
}

/** A polyline of x/y pairs relative to the anchor, shown for one 70 ms frame. */
interface Arc {
  frame: number;
  pts: number[];
}

interface Block {
  x: number;
  y: number;
  w: number;
  h: number;
  born: number;
  life: number;
  color: number;
}

interface Spike {
  angle: number;
  len: number;
}

interface Effect {
  kind: FinisherId;
  start: number;
  victim: Victim;
  killer: number;
  body: Px[];
  /** The body as a SPRITE_W x SPRITE_H colour grid, -1 where empty, for finishers that rescale it. */
  grid: Int32Array;
  dirX: number;
  dirY: number;
  hasDir: boolean;
  bits: Bit[];
  swirls: Swirl[];
  arcs: Arc[];
  blocks: Block[];
  spikes: Spike[];
}

type Range = readonly [number, number];

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
export const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));
export const easeOut = (u: number): number => 1 - (1 - u) * (1 - u);
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

export function mix(a: number, b: number, t: number): number {
  const k = clamp(t);
  const r = ((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k;
  const g = ((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k;
  const bl = (a & 0xff) + ((b & 0xff) - (a & 0xff)) * k;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/** Cheap integer hash → 0..1, so flicker is stable within a frame. */
export function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function bodyPixels(art: Sprite, flip: boolean): Px[] {
  const out: Px[] = [];
  for (let sy = 0; sy < art.height; sy++) {
    for (let sx = 0; sx < art.width; sx++) {
      const color = art.pixels[sy * art.width + sx]!;
      if (color < 0) continue;
      out.push({
        x: (flip ? art.width - 1 - sx : sx) + BODY_LEFT,
        y: sy + BODY_TOP,
        color,
      });
    }
  }
  return out;
}

function makeBit(fields: Pick<Bit, 'x' | 'y' | 'c0' | 'c1' | 'life'> & Partial<Bit>): Bit {
  return { vx: 0, vy: 0, born: 0, drag: 0, grav: 0, size: 1, add: false, ...fields };
}

interface RadialOptions {
  count: number;
  speed: Range;
  life: Range;
  drag: number;
  grav: number;
  born: number;
  colors: readonly number[];
  end: number;
  add: boolean;
}

/** Bits thrown outward from a point: embers, sparks, pops. */
function radialBits(out: Bit[], ox: number, oy: number, o: RadialOptions): void {
  for (let i = 0; i < o.count; i++) {
    const angle = rand(0, Math.PI * 2);
    const speed = rand(o.speed[0], o.speed[1]);
    out.push(
      makeBit({
        x: ox,
        y: oy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        born: o.born + rand(0, 40),
        life: rand(o.life[0], o.life[1]),
        drag: o.drag,
        grav: o.grav,
        c0: pick(o.colors),
        c1: o.end,
        add: o.add,
      }),
    );
  }
}

/** Draws and ages bits; `floor` makes shards bounce once and settle. */
function drawBits(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number, floor: boolean): void {
  const bits = fx.bits;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i]!;
    const age = t - b.born;
    if (age < 0 || age > b.life) continue;
    const u = age / b.life;
    const s = age / 1000;
    const f = b.drag > 0 ? (1 - Math.exp(-b.drag * s)) / b.drag : s;
    let y = b.y + b.vy * f + 0.5 * b.grav * s * s;
    if (floor && y > FLOOR_Y) {
      const over = y - FLOOR_Y;
      y = over < 6 ? FLOOR_Y - over * 0.4 : FLOOR_Y;
    }
    const x = Math.round(ax + b.x + b.vx * f);
    const py = Math.round(ay + y);
    const color = mix(b.c0, b.c1, u);
    const alpha = 1 - u * u;
    if (b.add) buf.add(x, py, color, alpha * 0.9);
    else if (b.size > 1) buf.rect(x, py, b.size, b.size, color, alpha);
    else buf.blend(x, py, color, alpha);
  }
}

function addRect(buf: PixelBuffer, x: number, y: number, w: number, h: number, color: number, alpha: number): void {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) buf.add(x + xx, y + yy, color, alpha);
  }
}

/* ------------------------------ 1. shatter ------------------------------- */

function buildShatter(fx: Effect): void {
  const radialK = fx.hasDir ? 1 : 3.5;
  for (const p of fx.body) {
    const rx = p.x;
    const ry = p.y - CHEST_Y;
    const len = Math.hypot(rx, ry) || 1;
    const speed = rand(35, 95);
    fx.bits.push(
      makeBit({
        x: p.x,
        y: p.y,
        vx: fx.dirX * speed + (rx / len) * rand(8, 22) * radialK,
        vy: fx.dirY * speed + (ry / len) * rand(8, 22) * radialK - rand(15, 45),
        life: rand(650, 950),
        drag: 1.4,
        grav: 90,
        size: Math.random() < 0.2 ? 2 : 1,
        c0: p.color,
        c1: mix(p.color, VOID, 0.55),
      }),
    );
  }
}

/** White cracks race across the body for a blink before it lets go. */
function drawShatter(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  if (t < 110) {
    const u = t / 110;
    const hitX = ax - fx.dirX * 6;
    const hitY = ay + CHEST_Y - fx.dirY * 6;
    buf.glow(hitX, hitY, 8 * (1 - u) + 2, WHITE, 1 - u);
    for (let i = 0; i < 6; i++) {
      const a = hash(i, 7) * Math.PI * 2;
      const reach = (6 + hash(i, 9) * 6) * easeOut(u * 1.6);
      buf.line(hitX, hitY, hitX + Math.cos(a) * reach, hitY + Math.sin(a) * reach, WHITE, 1 - u, true);
    }
  }
  drawBits(buf, fx, ax, ay, t, true);
  const bits = fx.bits;
  for (let i = 0; i < bits.length; i += 3) {
    const b = bits[i]!;
    const age = t - b.born;
    if (age < 80 || age > b.life * 0.8 || (Math.floor(age / 60) + i) % 7 !== 0) continue;
    const s = age / 1000;
    const f = (1 - Math.exp(-b.drag * s)) / b.drag;
    const y = Math.min(b.y + b.vy * f + 0.5 * b.grav * s * s, FLOOR_Y);
    buf.add(Math.round(ax + b.x + b.vx * f), Math.round(ay + y), PALE, 0.8);
  }
}

/* ----------------------------- 2. supernova ------------------------------ */

function buildSupernova(fx: Effect): void {
  for (let i = 0; i < 10; i++) {
    fx.spikes.push({ angle: (i / 10) * Math.PI * 2 + rand(-0.15, 0.15), len: rand(10, 24) });
  }
  radialBits(fx.bits, 0, CHEST_Y, {
    count: 70,
    speed: [18, 85],
    life: [550, 1000],
    drag: 2.2,
    grav: -8,
    born: 60,
    colors: [fx.killer, fx.killer, mix(fx.killer, WHITE, 0.6), WHITE],
    end: mix(fx.killer, VOID, 0.7),
    add: true,
  });
}

function drawSupernova(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const cy = ay + CHEST_Y;
  if (t < 260) {
    const u = t / 260;
    const r = t < 90 ? 2 + (t / 90) * 6 : 8 * (1 - (t - 90) / 170);
    buf.glow(ax, cy, 18 * (1 - u) + 5, mix(fx.killer, WHITE, 0.5), 1 - u * 0.5);
    buf.disc(ax, cy, r, WHITE, 1 - u * 0.4, true);
  }
  for (let i = 0; i < 2; i++) {
    const age = t - i * 90;
    if (age < 0 || age > 650) continue;
    const u = age / 650;
    const r = easeOut(u) * (i === 0 ? 36 : 26);
    const color = i === 0 ? WHITE : mix(fx.killer, WHITE, 0.4);
    buf.ring(ax, cy, r, color, 1 - u, true);
    buf.ring(ax, cy, Math.max(0, r - 1), fx.killer, (1 - u) * 0.6, true);
  }
  if (t < 300) {
    const u = t / 300;
    for (const spike of fx.spikes) {
      const c = Math.cos(spike.angle);
      const s = Math.sin(spike.angle);
      const far = 4 + spike.len * easeOut(u);
      buf.line(ax + c * 4, cy + s * 4, ax + c * far, cy + s * far, WHITE, 1 - u, true);
    }
  }
  drawBits(buf, fx, ax, ay, t, false);
}

/* ------------------------------- 3. glitch ------------------------------- */

const GLITCH_BLOCK_COLORS = [CYAN, RED, WHITE, PALE];

function buildGlitch(fx: Effect): void {
  for (let i = 0; i < 18; i++) {
    fx.blocks.push({
      x: Math.round(rand(-11, 9)),
      y: Math.round(rand(-12, 8)),
      w: Math.round(rand(2, 6)),
      h: Math.round(rand(1, 3)),
      born: rand(0, 480),
      life: rand(60, 170),
      color: i % 3 === 0 ? fx.killer : pick(GLITCH_BLOCK_COLORS),
    });
  }
}

/** Rows are shoved sideways in bands; red and cyan ghosts trail the real pixels. */
function drawGlitchBody(buf: PixelBuffer, fx: Effect, ax: number, ay: number, frame: number, squash: number): void {
  const intensity = 1 + frame * 0.04;
  for (const p of fx.body) {
    const row = p.y - BODY_TOP;
    const band = row >> 1;
    const shift = hash(frame, band) > 0.62 ? Math.round((hash(frame, band + 50) - 0.5) * 14 * intensity) : 0;
    const y = ay + Math.round(BODY_TOP + 10 + (row - 10) * squash);
    const x = ax + p.x + shift;
    buf.add(x - 2, y, RED, 0.55);
    buf.add(x + 2, y, CYAN, 0.55);
    buf.blend(x, y, p.color, 1);
  }
}

function drawGlitch(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const frame = Math.floor(t / 50);
  if (t < 650) {
    const squash = 1 - clamp((t - 500) / 150);
    if (t < 120 || hash(frame, 3) > 0.28) drawGlitchBody(buf, fx, ax, ay, frame, squash);
  } else if (Math.floor(t / 40) % 2 === 0) {
    const half = Math.round(7 * (1 - (t - 650) / 150));
    buf.line(ax - half, ay, ax + half, ay, WHITE, 1, true);
  }
  for (const b of fx.blocks) {
    const age = t - b.born;
    if (age < 0 || age > b.life) continue;
    addRect(buf, ax + b.x, ay + b.y, b.w, b.h, b.color, 0.8 * (1 - age / b.life));
  }
}

/* --------------------------------- 4. ash -------------------------------- */

function buildAsh(fx: Effect): void {
  for (const p of fx.body) {
    fx.bits.push(
      makeBit({
        x: p.x,
        y: p.y,
        vx: rand(-14, 14) + 8,
        vy: -rand(10, 38),
        born: 200 + ((p.y - BODY_TOP) / 20) * 650 + rand(0, 70),
        life: rand(500, 900),
        drag: 0.8,
        grav: -6,
        c0: EMBER,
        c1: ASH_GREY,
        add: Math.random() < 0.3,
      }),
    );
  }
  for (let i = 0; i < 40; i++) {
    const p = pick(fx.body);
    fx.bits.push(
      makeBit({
        x: p.x,
        y: p.y,
        vx: rand(-8, 14),
        vy: -rand(15, 30),
        born: rand(300, 900),
        life: rand(600, 900),
        drag: 0.8,
        c0: 0x8a9098,
        c1: 0x2a2f36,
      }),
    );
  }
}

/** Pixels bleach to white, then burn away top-down from a glowing front. */
function drawAsh(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const bleach = clamp(t / 250);
  for (let i = 0; i < fx.body.length; i++) {
    const p = fx.body[i]!;
    if (t >= fx.bits[i]!.born) continue;
    buf.blend(ax + p.x, ay + p.y, mix(p.color, 0xf2f0ec, bleach), 1);
  }
  if (t > 200 && t < 900) {
    const front = Math.round(BODY_TOP + ((t - 200) / 650) * 20);
    for (let x = -6; x <= 6; x++) buf.add(ax + x, ay + front, EMBER, 0.45);
  }
  drawBits(buf, fx, ax, ay, t, false);
}

/* ----------------------------- 5. singularity ---------------------------- */

const POP_AT = 650;

function buildSingularity(fx: Effect): void {
  for (const p of fx.body) {
    fx.swirls.push({
      angle: Math.atan2(p.y - CHEST_Y, p.x),
      radius: Math.hypot(p.x, p.y - CHEST_Y),
      delay: rand(0, 250),
      dur: rand(380, 450),
      color: p.color,
      body: true,
    });
  }
  for (let i = 0; i < 60; i++) {
    fx.swirls.push({
      angle: rand(0, Math.PI * 2),
      radius: rand(12, 30),
      delay: rand(0, 450),
      dur: rand(350, 500),
      color: i % 3 === 0 ? WHITE : fx.killer,
      body: false,
    });
  }
  radialBits(fx.bits, 0, CHEST_Y, {
    count: 45,
    speed: [35, 110],
    life: [300, 450],
    drag: 2.6,
    grav: 0,
    born: POP_AT,
    colors: [WHITE, fx.killer],
    end: mix(fx.killer, VOID, 0.7),
    add: true,
  });
}

function drawSwirls(buf: PixelBuffer, fx: Effect, ax: number, cy: number, t: number): void {
  for (const s of fx.swirls) {
    const age = t - s.delay;
    if (s.body ? age > s.dur : age < 0 || age > s.dur) continue;
    const p = clamp(age / s.dur);
    const r = s.radius * (1 - p) ** 1.6;
    const a = s.angle + p * 3.2;
    const x = Math.round(ax + Math.cos(a) * r);
    const y = Math.round(cy + Math.sin(a) * r);
    if (s.body) buf.blend(x, y, mix(s.color, fx.killer, p * 0.6), 1);
    else buf.add(x, y, s.color, 0.45 + p * 0.55);
  }
}

function singularityRadius(t: number): number {
  if (t < 250) return 5 * easeOut(t / 250);
  if (t < POP_AT - 10) return 5;
  return Math.max(0, 5 * (1 - (t - (POP_AT - 10)) / 80));
}

function drawSingularity(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const cy = ay + CHEST_Y;
  drawSwirls(buf, fx, ax, cy, t);
  const r = singularityRadius(t);
  if (r > 0.5) {
    buf.glow(ax, cy, r + 7, fx.killer, 0.4);
    buf.disc(ax, cy, r, BLACK, 1);
    buf.ring(ax, cy, r + 1, mix(fx.killer, WHITE, 0.5), 0.95, true);
    buf.ring(ax, cy, r + 2, fx.killer, 0.35, true);
  }
  const age = t - POP_AT;
  if (age >= 0 && age < 420) {
    const u = age / 420;
    if (age < 110) buf.disc(ax, cy, 8 * (1 - age / 110), WHITE, 0.9, true);
    buf.ring(ax, cy, easeOut(u) * 30, WHITE, 1 - u, true);
    buf.ring(ax, cy, Math.max(0, easeOut(u) * 30 - 1), fx.killer, (1 - u) * 0.6, true);
  }
  drawBits(buf, fx, ax, ay, t, false);
}

/* --------------------------------- 6. storm ------------------------------ */

const ARC_FRAME_MS = 70;
const ARC_FRAMES = 9;

/** Midpoint-free jagged path: even steps along the line, shoved sideways. */
function jaggedArc(frame: number, angle: number, reach: number, steps: number, ox: number, oy: number): Arc {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const pts = [ox, oy];
  for (let i = 1; i <= steps; i++) {
    const along = (i / steps) * reach;
    const side = i === steps ? 0 : rand(-4, 4);
    pts.push(ox + c * along - s * side, oy + s * along + c * side);
  }
  return { frame, pts };
}

function buildStorm(fx: Effect): void {
  for (let frame = 0; frame < ARC_FRAMES; frame++) {
    const count = frame < 3 ? 4 : 2;
    for (let i = 0; i < count; i++) {
      const angle = rand(0, Math.PI * 2);
      const main = jaggedArc(frame, angle, rand(12, 30), 6, 0, CHEST_Y);
      fx.arcs.push(main);
      if (Math.random() < 0.6) {
        const at = 2 * (2 + Math.floor(Math.random() * 3));
        fx.arcs.push(jaggedArc(frame, angle + rand(-1, 1), rand(7, 13), 3, main.pts[at]!, main.pts[at + 1]!));
      }
    }
  }
  radialBits(fx.bits, 0, CHEST_Y, {
    count: 50,
    speed: [40, 120],
    life: [250, 600],
    drag: 3,
    grav: 120,
    born: 0,
    colors: [fx.killer, WHITE, WHITE],
    end: mix(fx.killer, VOID, 0.6),
    add: true,
  });
}

function drawArc(buf: PixelBuffer, arc: Arc, ax: number, ay: number, color: number, fade: number): void {
  const pts = arc.pts;
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = ax + pts[i - 2]!;
    const y0 = ay + pts[i - 1]!;
    const x1 = ax + pts[i]!;
    const y1 = ay + pts[i + 1]!;
    buf.line(x0 + 1, y0, x1 + 1, y1, color, 0.5 * fade, true);
    buf.line(x0, y0, x1, y1, WHITE, 0.95 * fade, true);
  }
  buf.glow(ax + pts[pts.length - 2]!, ay + pts[pts.length - 1]!, 3, color, fade);
}

function drawStorm(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  if (t < 500) {
    const flash = Math.floor(t / 45) % 2 === 0 ? WHITE : fx.killer;
    const alpha = 0.7 * (1 - t / 500);
    for (const p of fx.body) buf.add(ax + p.x, ay + p.y, flash, alpha);
  }
  const frame = Math.floor(t / ARC_FRAME_MS);
  const fade = 1 - frame / (ARC_FRAMES + 3);
  for (const arc of fx.arcs) {
    if (arc.frame === frame) drawArc(buf, arc, ax, ay, fx.killer, fade);
  }
  drawBits(buf, fx, ax, ay, t, false);
}

/* ----------------------------- cartoon helpers ---------------------------- */

const INK = 0x14161c;
const SUN = 0xffd84a;
const easeInOut = (u: number): number => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));

function grey(color: number): number {
  const l = Math.round(((color >> 16) & 0xff) * 0.3 + ((color >> 8) & 0xff) * 0.59 + (color & 0xff) * 0.11);
  return (l << 16) | (l << 8) | l;
}

function bodyGrid(body: readonly Px[]): Int32Array {
  const grid = new Int32Array(SPRITE_W * SPRITE_H).fill(-1);
  for (const p of body) grid[(p.y - BODY_TOP) * SPRITE_W + (p.x - BODY_LEFT)] = p.color;
  return grid;
}

interface Pose {
  /** Buffer x of the horizontal centre and y of the feet edge. */
  cx: number;
  bottom: number;
  /** Stretch factors; samples nearest-neighbour so the result stays on the pixel grid. */
  sx: number;
  sy: number;
  alpha?: number;
  /** u, v run -1..1 across the drawn box. Return false to cut the pixel. */
  mask?: (u: number, v: number) => boolean;
  paint?: (color: number, u: number, v: number) => number;
}

/** The victim's own sprite pixels, squashed, stretched or shrunk. */
function drawPose(buf: PixelBuffer, fx: Effect, pose: Pose): void {
  const w = Math.max(1, Math.round(SPRITE_W * pose.sx));
  const h = Math.max(1, Math.round(SPRITE_H * pose.sy));
  const x0 = Math.round(pose.cx - w / 2);
  const y0 = Math.round(pose.bottom - h);
  const alpha = pose.alpha ?? 1;
  for (let y = 0; y < h; y++) {
    // Sampling row centres keeps a pancake from landing on empty headroom rows.
    const gy = Math.min(SPRITE_H - 1, Math.floor(((y + 0.5) * SPRITE_H) / h));
    const v = ((y + 0.5) / h) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(SPRITE_W - 1, Math.floor(((x + 0.5) * SPRITE_W) / w));
      const color = fx.grid[gy * SPRITE_W + gx]!;
      if (color < 0) continue;
      const u = ((x + 0.5) / w) * 2 - 1;
      if (pose.mask && !pose.mask(u, v)) continue;
      buf.blend(x0 + x, y0 + y, pose.paint ? pose.paint(color, u, v) : color, alpha);
    }
  }
}

/** Pixel art from rows of palette keys; unknown keys are transparent. */
function paintRows(
  buf: PixelBuffer,
  rows: readonly string[],
  x: number,
  y: number,
  palette: Record<string, number>,
  alpha = 1,
): void {
  for (let ry = 0; ry < rows.length; ry++) {
    const row = rows[ry]!;
    for (let rx = 0; rx < row.length; rx++) {
      const color = palette[row[rx]!];
      if (color !== undefined) buf.blend(x + rx, y + ry, color, alpha);
    }
  }
}

/** A four-point twinkle; `size` is the arm length. */
function drawTwinkle(buf: PixelBuffer, x: number, y: number, size: number, alpha: number): void {
  buf.line(x - size, y, x + size, y, WHITE, alpha, true);
  buf.line(x, y - size, x, y + size, WHITE, alpha, true);
  buf.add(x, y, WHITE, alpha);
}

/** Flat ellipse of shade on the floor under the anchor. */
function drawFloorShadow(buf: PixelBuffer, ax: number, ay: number, rx: number, alpha: number): void {
  const ry = Math.max(1, Math.round(rx * 0.28));
  for (let dx = -rx; dx <= rx; dx++) {
    const reach = Math.round(Math.sqrt(Math.max(0, 1 - (dx / rx) ** 2)) * ry);
    for (let dy = -reach; dy <= reach; dy++) buf.blend(ax + dx, ay + FLOOR_Y + dy, BLACK, alpha);
  }
}

/* -------------------------------- 7. anvil ------------------------------- */

const ANVIL_FALL_FROM = 150;
const ANVIL_HIT = 480;
const ANVIL_LIFT = 680;
const ANVIL_FADE_FROM = 1050;
const ANVIL_W = 24;
const ANVIL_H = 14;
/** Plate, horn, waist and foot as x, y, w, h. Rects keep the outline cheap and exact. */
const ANVIL_RECTS: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 24, 4],
  [0, 4, 7, 2],
  [7, 4, 12, 6],
  [4, 10, 16, 4],
];

function buildAnvil(fx: Effect): void {
  for (let i = 0; i < 14; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    fx.bits.push(
      makeBit({
        x: dir * rand(2, 9),
        y: FLOOR_Y - 1,
        vx: dir * rand(25, 80),
        vy: -rand(4, 26),
        born: ANVIL_HIT,
        life: rand(300, 460),
        drag: 3,
        grav: 40,
        size: 2,
        c0: 0xd6dae2,
        c1: 0x5a5f69,
      }),
    );
  }
}

function drawAnvilShape(buf: PixelBuffer, cx: number, top: number): void {
  const x = cx - (ANVIL_W >> 1);
  for (const [rx, ry, rw, rh] of ANVIL_RECTS) buf.rect(x + rx - 1, top + ry - 1, rw + 2, rh + 2, INK);
  for (const [rx, ry, rw, rh] of ANVIL_RECTS) buf.rect(x + rx, top + ry, rw, rh, 0x5a6270);
  buf.rect(x, top, ANVIL_W, 1, 0xa3aebe);
  buf.rect(x + 1, top + 3, ANVIL_W - 2, 1, 0x3a414c);
  buf.rect(x + 5, top + 12, 14, 1, 0x3a414c);
  buf.text('16T', x + 8, top + 5, 0xf2f4f8);
}

function anvilTop(ay: number, t: number): number {
  const rest = ay + FLOOR_Y - ANVIL_H;
  const above = -ANVIL_H - 2;
  if (t < ANVIL_HIT) return Math.round(above + (rest - above) * clamp((t - ANVIL_FALL_FROM) / (ANVIL_HIT - ANVIL_FALL_FROM)) ** 2);
  if (t < ANVIL_LIFT) return rest - Math.round(Math.sin(clamp((t - ANVIL_HIT) / 90) * Math.PI) * 4);
  return Math.round(rest - (rest - above + 4) * clamp((t - ANVIL_LIFT) / 260) ** 2);
}

function drawPancake(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number, alpha: number): void {
  const since = t - ANVIL_LIFT;
  const jelly = since > 0 ? Math.sin(since / 45) * Math.exp(-since / 140) * 0.06 : 0;
  const sy = 0.18 + jelly;
  drawPose(buf, fx, { cx: ax, bottom: ay + FLOOR_Y, sx: 1.9, sy, alpha });
  if (since < 40) return;
  const popped = since - 40;
  const lift = easeOut(clamp(popped / 110)) * 3 + Math.sin(popped / 60) * 0.8;
  const eyeY = Math.round(ay + FLOOR_Y - Math.round(SPRITE_H * sy) - 2 - lift);
  for (const side of [-1, 1]) {
    const ex = ax + side * 4;
    buf.disc(ex, eyeY, 3, INK, alpha);
    buf.disc(ex, eyeY, 2, WHITE, alpha);
    buf.blend(ex + Math.round(Math.sin(popped / 50 + side)), eyeY, INK, alpha);
  }
  const wheel = since + 200;
  for (let i = 0; i < 3; i++) {
    const a = wheel / 170 + i * 2.094;
    const bx = Math.round(ax + Math.cos(a) * 10);
    const by = Math.round(eyeY - 4 + Math.sin(a) * 3);
    buf.rect(bx - 1, by, 3, 1, SUN, alpha);
    buf.rect(bx, by - 1, 1, 3, SUN, alpha);
    buf.blend(bx, by, WHITE, alpha);
  }
}

function drawAnvilImpact(buf: PixelBuffer, ax: number, ay: number, t: number): void {
  const age = t - ANVIL_HIT;
  if (age < 0 || age > 140) return;
  const u = age / 140;
  const y = ay + FLOOR_Y - 1;
  for (let i = 0; i < 6; i++) {
    const dir = i < 3 ? 1 : -1;
    const reach = (8 + (i % 3) * 5) * easeOut(u);
    buf.line(ax + dir * 12, y - (i % 3) * 2, ax + dir * (12 + reach), y - (i % 3) * 3 - 2, WHITE, 1 - u, true);
  }
}

function drawAnvil(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const alpha = 1 - clamp((t - ANVIL_FADE_FROM) / 200);
  const grow = clamp(t / ANVIL_HIT);
  drawFloorShadow(buf, ax, ay, Math.round(3 + 10 * grow), (0.18 + 0.4 * grow) * alpha);
  if (t < ANVIL_HIT) drawPose(buf, fx, { cx: ax, bottom: ay + FLOOR_Y, sx: 1, sy: 1 });
  else drawPancake(buf, fx, ax, ay, t, alpha);
  if (t >= ANVIL_FALL_FROM && t < ANVIL_LIFT + 260) drawAnvilShape(buf, ax, anvilTop(ay, t));
  drawAnvilImpact(buf, ax, ay, t);
  drawBits(buf, fx, ax, ay, t, false);
}

/* ------------------------------- 8. rocket ------------------------------- */

const IGNITE = 200;
const LIFTOFF = 320;
const RISE_MS = 600;
const PING_Y = 4;
const ROCKET_ROWS = [
  '...o...',
  '..oRo..',
  '..oRo..',
  '.oRRRo.',
  '.owwwo.',
  '.owcwo.',
  '.owwwo.',
  '.okkko.',
  '.owwwo.',
  'RowwwoR',
  'RRoooRR',
  'oR.o.Ro',
];

/** Distance risen at time t; quadratic so it reads as accelerating. */
function rocketLift(t: number, travel: number): number {
  return travel * clamp((t - LIFTOFF) / RISE_MS) ** 2;
}

function drawSmoke(buf: PixelBuffer, ax: number, ay: number, t: number, travel: number): void {
  const fade = 1 - clamp((t - 1000) / 200);
  for (let k = 1; k <= 14; k++) {
    const tk = t - k * 36;
    if (tk < IGNITE) break;
    const y = Math.round(ay + 20 - rocketLift(tk, travel));
    const x = ax + Math.round((hash(k, 5) - 0.5) * k * 0.8);
    buf.disc(x, y, 1 + k * 0.32, mix(0xf4f0e8, 0x6b7078, k / 14), 0.75 * (1 - k / 15) * fade);
  }
}

function drawFlame(buf: PixelBuffer, x: number, y: number, t: number, extra: number): void {
  const flick = hash(Math.floor(t / 35), 11);
  const len = Math.round(5 + flick * 4 + extra);
  const wid = flick > 0.5 ? 3 : 2;
  buf.glow(x, y + 3, 9, EMBER, 0.55);
  buf.fillConvex([{ x: x - wid, y }, { x: x + wid, y }, { x, y: y + len }], EMBER);
  buf.fillConvex([{ x: x - 1, y }, { x: x + 1, y }, { x, y: y + len - 3 }], 0xffe27a);
  buf.add(x, y, WHITE, 0.8);
}

/** The "ting" where the victim leaves the top of the screen. */
function drawPing(buf: PixelBuffer, ax: number, ay: number, t: number, travel: number): void {
  const at = LIFTOFF + RISE_MS * Math.sqrt(clamp((ay - PING_Y) / travel));
  const age = t - at;
  if (age < 0 || age > 260) return;
  const u = age / 260;
  buf.glow(ax, PING_Y, 8, CYAN, 0.6 * (1 - u));
  drawTwinkle(buf, ax, PING_Y, Math.round(2 + 7 * Math.sin(u * Math.PI)), 1 - u * u);
}

function drawRocket(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const travel = ay + 34;
  const lift = rocketLift(t, travel);
  const rumble = t > IGNITE && lift < 1 ? Math.round((hash(Math.floor(t / 28), 2) - 0.5) * 2) : 0;
  const x = ax + rumble;
  const top = Math.round(ay + FLOOR_Y - lift + (1 - easeOut(clamp(t / 150))) * 14);
  if (t >= IGNITE) drawSmoke(buf, ax, ay, t, travel);
  paintRows(buf, ROCKET_ROWS, x - 3, top, { o: INK, R: RED, w: 0xe9edf2, c: 0x5fd8ff, k: fx.killer });
  drawPose(buf, fx, { cx: x, bottom: ay + FLOOR_Y - lift, sx: 1, sy: lift > 0 ? 1.15 : 1 });
  if (t >= IGNITE) drawFlame(buf, x, top + ROCKET_ROWS.length, t, lift > 0 ? 5 : 0);
  drawPing(buf, ax, ay, t, travel);
}

/* ------------------------------ 9. confetti ------------------------------ */

const CONFETTI_POP = 90;
const PARTY_COLORS = [0xffd23f, 0x3ddc97, 0x4ecbff, 0xff5fa2, 0xffffff, 0xb78cff];

function buildConfetti(fx: Effect): void {
  const colors = [fx.killer, fx.killer, mix(fx.killer, WHITE, 0.5), ...PARTY_COLORS];
  for (let i = 0; i < 70; i++) {
    const angle = -Math.PI / 2 + rand(-1.6, 1.6);
    const speed = rand(50, 170);
    const color = pick(colors);
    fx.bits.push(
      makeBit({
        x: 0,
        y: CHEST_Y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        born: CONFETTI_POP + rand(0, 30),
        life: rand(750, 1000),
        drag: 3.2,
        grav: 38,
        c0: color,
        c1: color,
      }),
    );
  }
  for (let i = 0; i < 5; i++) fx.spikes.push({ angle: -Math.PI / 2 + rand(-0.9, 0.9), len: rand(18, 32) });
}

/** Strips tumble edge-on and flat; drag plus a gentle fall gives a terminal velocity, so they flutter. */
function drawStrips(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  for (let i = 0; i < fx.bits.length; i++) {
    const b = fx.bits[i]!;
    const age = t - b.born;
    if (age < 0 || age > b.life) continue;
    const u = age / b.life;
    const s = age / 1000;
    const f = (1 - Math.exp(-b.drag * s)) / b.drag;
    const x = Math.round(ax + b.x + b.vx * f + Math.sin(age / 70 + i * 1.7) * 2 * u);
    const y = Math.round(ay + b.y + b.vy * f + (b.grav / b.drag) * (s - f));
    const turn = (Math.floor(age / 90) + i) % 3;
    const alpha = 1 - u ** 3;
    if (turn === 0) buf.rect(x, y, 2, 1, b.c0, alpha);
    else if (turn === 1) buf.rect(x, y, 1, 2, b.c0, alpha);
    else buf.blend(x, y, mix(b.c0, WHITE, 0.4), alpha);
  }
}

function drawStreamers(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const age = t - CONFETTI_POP;
  if (age < 0) return;
  const fade = 1 - clamp((age - 500) / 400);
  const drop = clamp((age - 150) / 600) ** 2 * 26;
  for (let i = 0; i < fx.spikes.length; i++) {
    const sp = fx.spikes[i]!;
    const reach = easeOut(clamp(age / 320)) * sp.len;
    let px = ax;
    let py = ay + CHEST_Y;
    for (let k = 1; k <= 8; k++) {
      const s = k / 8;
      const x = ax + Math.cos(sp.angle) * reach * s + Math.sin(s * 7 + age / 90 + i) * 2 * s;
      const y = ay + CHEST_Y + Math.sin(sp.angle) * reach * s + drop * s * s;
      buf.line(px, py, x, y, PARTY_COLORS[(i + (k >> 1)) % PARTY_COLORS.length]!, fade);
      px = x;
      py = y;
    }
  }
}

function drawConfetti(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  if (t < CONFETTI_POP) {
    drawPose(buf, fx, { cx: ax, bottom: ay + FLOOR_Y - Math.round(2 * (t / CONFETTI_POP)), sx: 1, sy: 1 });
  } else {
    const u = clamp((t - CONFETTI_POP) / 120);
    buf.glow(ax, ay + CHEST_Y, 14 * (1 - u) + 4, WHITE, 1 - u);
    buf.ring(ax, ay + CHEST_Y, easeOut(u) * 16, WHITE, 1 - u, true);
    buf.ring(ax, ay + CHEST_Y, easeOut(u) * 11, fx.killer, 1 - u, true);
  }
  drawStreamers(buf, fx, ax, ay, t);
  drawStrips(buf, fx, ax, ay, t);
}

/* ------------------------------ 10. balloon ------------------------------ */

const INFLATE_FROM = 40;
const INFLATE_TO = 480;
const BALLOON_POP = 820;
const BALLOON_RX = 23;
const BALLOON_RY = 31;

function buildBalloon(fx: Effect): void {
  const colors = [fx.killer, mix(fx.killer, WHITE, 0.4), fx.victim.color];
  for (let i = 0; i < 24; i++) {
    const a = rand(0, Math.PI * 2);
    const speed = rand(30, 95);
    fx.bits.push(
      makeBit({
        x: Math.cos(a) * BALLOON_RX * 0.9,
        y: CHEST_Y + Math.sin(a) * BALLOON_RY * 0.9 - balloonLift(BALLOON_POP),
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 15,
        born: BALLOON_POP + rand(0, 20),
        life: rand(280, 420),
        drag: 1.2,
        grav: 130,
        size: Math.random() < 0.5 ? 2 : 1,
        c0: pick(colors),
        c1: mix(fx.killer, VOID, 0.5),
      }),
    );
  }
}

function balloonLift(t: number): number {
  return 22 * clamp((t - 380) / 440) ** 1.4;
}

/** Whole-pixel half steps, so the swelling reads as a stop-motion inflate. */
function balloonSize(t: number): number {
  return 1 + Math.floor(easeOut(clamp((t - INFLATE_FROM) / (INFLATE_TO - INFLATE_FROM))) * 4.99) / 2;
}

/** The latex: a filled ellipse with a dark rim, so the stretched sprite reads as sitting inside a round balloon. */
function drawLatex(buf: PixelBuffer, cx: number, cy: number, rx: number, ry: number, color: number): void {
  for (let dy = -ry; dy <= ry; dy++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2)));
    buf.rect(cx - half, cy + dy, half * 2 + 1, 1, mix(color, WHITE, 0.15 * (1 - (dy + ry) / (2 * ry))));
    buf.blend(cx - half, cy + dy, mix(color, VOID, 0.6));
    buf.blend(cx + half, cy + dy, mix(color, VOID, 0.6));
  }
}

function drawBalloonBody(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const k = balloonSize(t);
  const strain = clamp((t - INFLATE_TO) / (BALLOON_POP - INFLATE_TO));
  const wobble = Math.sin(t / 45) * (0.04 + 0.06 * strain);
  const sx = k * (1 + wobble);
  const sy = k * (1 - wobble);
  const cx = ax + Math.round(Math.sin(t / 130) * 1.5);
  const cy = Math.round(ay + CHEST_Y - balloonLift(t));
  const rx = Math.round(SPRITE_W * sx * 0.55);
  const ry = Math.round(SPRITE_H * sy * 0.52);
  drawLatex(buf, cx, cy, rx, ry, fx.killer);
  drawPose(buf, fx, {
    cx,
    bottom: Math.round(cy + (SPRITE_H * sy) / 2),
    sx,
    sy,
    alpha: 0.6,
    mask: (u, v) => u * u + v * v <= 1.1,
  });
  buf.disc(cx - Math.round(rx * 0.45), cy - Math.round(ry * 0.5), Math.max(1, Math.round(rx * 0.14)), WHITE, 0.85);
  const knotY = cy + ry;
  buf.fillConvex([{ x: cx - 2, y: knotY + 3 }, { x: cx + 2, y: knotY + 3 }, { x: cx, y: knotY }], fx.killer);
  for (let i = 0; i < 9; i++) buf.blend(cx + Math.round(Math.sin(i * 0.9 + t / 90) * 1.5), knotY + 3 + i, PALE, 0.8);
}

function drawBalloonPop(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const age = t - BALLOON_POP;
  if (age < 0 || age > 300) return;
  const u = age / 300;
  const cy = ay + CHEST_Y - balloonLift(BALLOON_POP);
  buf.disc(ax, cy, 11 * (1 - clamp(age / 70)), WHITE, 0.9, true);
  buf.ring(ax, cy, easeOut(u) * 26, WHITE, 1 - u, true);
  for (let i = 0; i < 4; i++) {
    const a = i * 1.6 + 0.4;
    const r = easeOut(u) * (8 + i * 3);
    buf.disc(ax + Math.cos(a) * r, cy + Math.sin(a) * r, 3 - u * 2, 0xe9edf2, 0.8 * (1 - u));
  }
}

function drawBalloon(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  if (t < BALLOON_POP) drawBalloonBody(buf, fx, ax, ay, t);
  drawBalloonPop(buf, fx, ax, ay, t);
  drawBits(buf, fx, ax, ay, t, false);
}

/* ------------------------------ 11. deleted ------------------------------ */

const DEL_SNAP = 170;
const DEL_GRAB = 420;
const DEL_DROP = 800;
const CURSOR_ROWS = [
  'o........',
  'oo.......',
  'owo......',
  'owwo.....',
  'owwwo....',
  'owwwwo...',
  'owwwwwo..',
  'owwwwwwo.',
  'owwwwooo.',
  'owowwo...',
  'oo.owwo..',
  'o..owwo..',
  '....oo...',
];
const CAN_ROWS = [
  '.ooooooo.',
  '.oGdGdGo.',
  '.oGdGdGo.',
  '.oGdGdGo.',
  '.oGdGdGo.',
  '.oGdGdGo.',
  '..oGdGo..',
  '..ooooo..',
];
const LID_ROWS = ['....ooo....', 'ooooooooooo', 'oLLLLLLLLLo'];
const CAN_COLORS = { o: INK, G: 0x8a94a3, d: 0x5b6572, L: 0xaab4c2 };

/** Marching ants: the border flips between black and white as the phase advances. */
function drawMarquee(buf: PixelBuffer, x: number, y: number, w: number, h: number, t: number): void {
  const shift = Math.floor(t / 60);
  buf.rect(x, y, w, h, 0x4aa3ff, 0.22);
  const dot = (px: number, py: number, i: number): void => buf.blend(px, py, ((i + shift) & 3) < 2 ? BLACK : WHITE);
  for (let i = 0; i < w; i++) {
    dot(x + i, y, i);
    dot(x + w - 1 - i, y + h - 1, i + w + h);
  }
  for (let i = 0; i < h; i++) {
    dot(x + w - 1, y + i, i + w);
    dot(x, y + h - 1 - i, i + 2 * w + h);
  }
}

function lidLift(t: number): number {
  if (t < DEL_DROP) return t > DEL_GRAB + 100 ? 3 : 0;
  const age = t - DEL_DROP;
  return Math.round(Math.abs(Math.sin(age / 55)) * 4 * Math.exp(-age / 160));
}

function drawCan(buf: PixelBuffer, x: number, bottom: number, t: number): void {
  const appear = easeOut(clamp((t - 100) / 140));
  const y = bottom - 11 + Math.round((1 - appear) * 12);
  paintRows(buf, CAN_ROWS, x - 4, y + 3, CAN_COLORS);
  paintRows(buf, LID_ROWS, x - 5, y - lidLift(t), CAN_COLORS);
}

function drawDeletedTag(buf: PixelBuffer, canX: number, top: number, t: number): void {
  const age = t - (DEL_DROP + 40);
  if (age < 0) return;
  const fade = 1 - clamp((t - 1170) / 80);
  const w = buf.textWidth('DELETED') + 6;
  const x = clamp(Math.round(canX - w / 2), 1, buf.width - w - 1);
  const y = Math.round(top - 12 - (1 - easeOut(clamp(age / 90))) * 6);
  buf.rect(x - 1, y - 1, w + 2, 11, INK, fade);
  buf.rect(x, y, w, 9, 0xe0283c, fade);
  buf.text('DELETED', x + 3, y + 2, WHITE, fade);
}

function drawCursor(buf: PixelBuffer, fx: Effect, tipX: number, tipY: number, t: number): void {
  const press = t > DEL_GRAB - 30 && t < DEL_GRAB + 60 ? 1 : 0;
  buf.glow(tipX, tipY, 7, fx.killer, 0.5);
  const click = t - DEL_GRAB;
  if (click > 0 && click < 160) buf.ring(tipX, tipY, easeOut(click / 160) * 9, WHITE, 1 - click / 160, true);
  paintRows(buf, CURSOR_ROWS, tipX + press, tipY + press, { o: BLACK, w: WHITE });
}

function drawDeleted(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const side = ax + 28 < buf.width - 8 ? 1 : -1;
  const canX = ax + side * 28;
  const canTop = ay + FLOOR_Y - 11;
  const p = easeInOut(clamp((t - DEL_GRAB) / (DEL_DROP - DEL_GRAB)));
  const s = 1 - 0.72 * p;
  const vx = Math.round(ax + (canX - ax) * p);
  const bottom = Math.round(ay + FLOOR_Y - 7 * p - Math.sin(p * Math.PI) * 12);
  const centerY = bottom - Math.round((SPRITE_H * s) / 2);
  if (t < DEL_DROP) {
    drawPose(buf, fx, { cx: vx, bottom, sx: s, sy: s });
    const snap = Math.round(14 * (1 - easeOut(clamp(t / DEL_SNAP))));
    const w = Math.round(SPRITE_W * s) + 4 + snap;
    const h = Math.round(SPRITE_H * s) + 4 + snap;
    drawMarquee(buf, vx - (w >> 1), centerY - (h >> 1), w, h, t);
  }
  drawCan(buf, canX, ay + FLOOR_Y, t);
  drawDeletedTag(buf, canX, canTop, t);
  const grab = easeOut(clamp((t - 120) / (DEL_GRAB - 120)));
  const tipX = t < DEL_GRAB ? Math.round(ax - side * 20 + (ax + 1 - (ax - side * 20)) * grab) : vx + 1;
  const tipY = t < DEL_GRAB ? Math.round(ay + 26 + (ay - 1 - (ay + 26)) * grab) : centerY - 1;
  if (t >= 120 && t < DEL_DROP + 120) drawCursor(buf, fx, tipX, tipY, t);
}

/* ------------------------------- 12. ghost ------------------------------- */

const SLUMP_MS = 280;
const GHOST_FROM = 250;
const GHOST_ROWS_A = [
  '...ooooo...',
  '..owwwwwo..',
  '.owwwwwwwo.',
  '.owwwwwwwo.',
  '.owkwwwkwo.',
  '.owkwwwkwo.',
  '.owwwowwwo.',
  '.owwwwwwwo.',
  '.owwwwwwwo.',
  '.owwwwwwwo.',
  '.owwwwwwwo.',
  '.owwwwwwwo.',
  '.owwowwowo.',
  '..o.o.o.o..',
];
const GHOST_ROWS_B = [...GHOST_ROWS_A.slice(0, 12), '.oowwowwoo.', '...o.o.o...'];
const GHOST_COLORS = { o: 0x9fc0ff, w: 0xf4f8ff, k: INK };
const HARP_NOTES = [392, 440, 523, 587, 659, 784, 880, 1047, 1175, 1319];

function ghostLift(t: number): number {
  if (t < 700) return 16 * easeOut(clamp((t - GHOST_FROM) / 450));
  const s = (t - 700) / 1000;
  return 16 + 20 * s + 45 * s * s;
}

function drawSlump(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  const u = easeOut(clamp(t / SLUMP_MS));
  const alpha = 1 - 0.7 * clamp((t - 1000) / 300);
  drawPose(buf, fx, {
    cx: ax,
    bottom: ay + FLOOR_Y,
    sx: 1 + 0.06 * u,
    sy: 1 - 0.2 * u,
    alpha,
    paint: (color) => mix(color, mix(grey(color), 0x3a3f48, 0.3), u),
  });
}

function drawGhostWave(buf: PixelBuffer, x: number, y: number, t: number): void {
  const up = Math.floor(t / 130) % 2 === 0;
  const handY = up ? y + 2 : y + 5;
  buf.line(x + 10, y + 8, x + 13, handY + 1, 0x9fc0ff, 0.8);
  buf.rect(x + 13, handY, 2, 2, 0xf4f8ff, 0.9);
}

function drawGhost(buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number): void {
  drawSlump(buf, fx, ax, ay, t);
  if (t < GHOST_FROM) return;
  const lift = ghostLift(t);
  const alpha = 0.8 * clamp((t - GHOST_FROM) / 150) * (1 - clamp((t - 1050) / 250));
  const sway = Math.round(Math.sin(t / 160) * 2 * clamp((t - 400) / 300));
  const x = ax - 5 + sway;
  const y = Math.round(ay - 10 - lift);
  const rows = Math.floor(t / 150) % 2 === 0 ? GHOST_ROWS_A : GHOST_ROWS_B;
  paintRows(buf, rows, x, y, GHOST_COLORS, alpha);
  if (t > 520 && t < 1050) drawGhostWave(buf, x, y, t);
  for (let i = 0; i < 3; i++) {
    const age = (t + i * 190) % 560;
    if (age < 200) drawTwinkle(buf, x + 5 + Math.round((hash(i, 21) - 0.5) * 22), y + Math.round(hash(i, 22) * 14), 2, Math.sin((age / 200) * Math.PI) * alpha);
  }
}

/* ------------------------------ registry --------------------------------- */

type Draw = (buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number) => void;

const BUILD: Record<FinisherId, (fx: Effect) => void> = {
  shatter: buildShatter,
  supernova: buildSupernova,
  glitch: buildGlitch,
  ash: buildAsh,
  singularity: buildSingularity,
  storm: buildStorm,
  anvil: buildAnvil,
  rocket: () => undefined,
  confetti: buildConfetti,
  balloon: buildBalloon,
  deleted: () => undefined,
  ghost: () => undefined,
};

const DRAW: Record<FinisherId, Draw> = {
  shatter: drawShatter,
  supernova: drawSupernova,
  glitch: drawGlitch,
  ash: drawAsh,
  singularity: drawSingularity,
  storm: drawStorm,
  anvil: drawAnvil,
  rocket: drawRocket,
  confetti: drawConfetti,
  balloon: drawBalloon,
  deleted: drawDeleted,
  ghost: drawGhost,
};

const DURATION: Record<FinisherId, number> = {
  shatter: 1000,
  supernova: 1050,
  glitch: 800,
  ash: 1300,
  singularity: 1100,
  storm: 800,
  anvil: 1250,
  rocket: 1200,
  confetti: 1100,
  balloon: 1250,
  deleted: 1250,
  ghost: 1300,
};

const SHAKE: Record<FinisherId, number> = {
  shatter: 2,
  supernova: 4,
  glitch: 1,
  ash: 0.5,
  singularity: 3,
  storm: 2,
  anvil: 3.5,
  rocket: 0,
  confetti: 0,
  balloon: 0,
  deleted: 1,
  ghost: 0,
};

/**
 * Ms after spawn at which the shake should kick in: the anvil lands and the can
 * lid slams well after the effect starts, and a shake at t=0 would miss them.
 */
export function finisherShakeDelay(kind: FinisherId): number {
  return SHAKE_DELAY[kind] ?? 0;
}

const SHAKE_DELAY: Partial<Record<FinisherId, number>> = { anvil: ANVIL_HIT, deleted: DEL_DROP };

export class Finishers {
  private live: Effect[] = [];

  /** Starts an effect at `now`. Returns a suggested screen-shake strength 0..4. */
  spawn(kind: FinisherId, victim: Victim, killerColor: number, now: number): number {
    const { facing, flip } = facingFor(victim.aim);
    const art = sprite(facing, 0, victim.archetype, victim.color);

    let dirX = 0;
    let dirY = 0;
    let hasDir = false;
    if (victim.from) {
      const dx = victim.x - victim.from.x;
      const dy = victim.y - victim.from.y;
      const len = Math.hypot(dx, dy);
      if (len > 0.001) {
        dirX = dx / len;
        dirY = dy / len;
        hasDir = true;
      }
    }

    const body = bodyPixels(art, flip);
    const fx: Effect = {
      kind,
      start: now,
      victim,
      killer: killerColor,
      body,
      grid: bodyGrid(body),
      dirX,
      dirY,
      hasDir,
      bits: [],
      swirls: [],
      arcs: [],
      blocks: [],
      spikes: [],
    };
    BUILD[kind](fx);
    this.live.push(fx);
    return SHAKE[kind];
  }

  /** Draws all live effects and drops finished ones. */
  draw(view: FinisherView, now: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const fx = this.live[i]!;
      const t = now - fx.start;
      if (t > DURATION[fx.kind]) {
        this.live.splice(i, 1);
        continue;
      }
      if (t < 0) continue;
      DRAW[fx.kind](view.buffer, fx, view.px(fx.victim.x), view.py(fx.victim.y), t);
    }
  }

  clear(): void {
    this.live.length = 0;
  }

  get active(): boolean {
    return this.live.length > 0;
  }
}

/* --------------------------------- sound --------------------------------- */

const noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();

function noiseFor(ctx: AudioContext): AudioBuffer {
  const hit = noiseBuffers.get(ctx);
  if (hit) return hit;
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffers.set(ctx, buffer);
  return buffer;
}

export interface Voice {
  tone(type: OscillatorType, f0: number, f1: number, at: number, dur: number, gain: number, attack?: number): void;
  hiss(type: BiquadFilterType, f0: number, f1: number, at: number, dur: number, gain: number, attack?: number): void;
}

/**
 * Times are authored for rate 1; slow motion stretches them and drops pitch,
 * so a killcam finisher sounds like the same sound played on a slow tape.
 */
export function createVoice(ctx: AudioContext, out: AudioNode, rate: number): Voice {
  const r = Math.max(0.1, rate);
  const stretch = 1 / r;
  const base = ctx.currentTime;

  const envelope = (gain: GainNode, t: number, dur: number, peak: number, attack: number): number => {
    const end = t + dur * stretch;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + attack * stretch);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    return end;
  };

  return {
    tone(type, f0, f1, at, dur, gain, attack = 0.004) {
      const t = base + at * stretch;
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0 * r, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * r), t + dur * stretch);
      const end = envelope(amp, t, dur, gain, attack);
      osc.connect(amp).connect(out);
      osc.start(t);
      osc.stop(end + 0.02);
    },
    hiss(type, f0, f1, at, dur, gain, attack = 0.004) {
      const t = base + at * stretch;
      const source = ctx.createBufferSource();
      const filter = ctx.createBiquadFilter();
      const amp = ctx.createGain();
      source.buffer = noiseFor(ctx);
      source.loop = true;
      filter.type = type;
      filter.frequency.setValueAtTime(f0 * r, t);
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * r), t + dur * stretch);
      const end = envelope(amp, t, dur, gain, attack);
      source.connect(filter).connect(amp).connect(out);
      source.start(t, Math.random() * 0.5);
      source.stop(end + 0.02);
    },
  };
}

function shatterSound(v: Voice): void {
  v.hiss('highpass', 3200, 5200, 0, 0.28, 0.16);
  v.tone('sine', 220, 70, 0, 0.12, 0.12);
  for (let i = 0; i < 7; i++) {
    const f = rand(2400, 6400);
    v.tone('sine', f, f, rand(0, 0.4), 0.14, 0.04);
  }
}

function supernovaSound(v: Voice): void {
  v.tone('sine', 95, 26, 0, 0.9, 0.2, 0.01);
  v.hiss('lowpass', 500, 70, 0, 0.8, 0.16, 0.01);
  v.hiss('highpass', 5000, 7000, 0.1, 0.7, 0.05, 0.05);
}

function glitchSound(v: Voice): void {
  for (let i = 0; i < 14; i++) {
    const f = rand(200, 2400);
    v.tone('square', f, f, i * 0.045, 0.04, 0.06, 0.002);
  }
  v.hiss('bandpass', 3000, 1200, 0, 0.5, 0.06);
}

function ashSound(v: Voice): void {
  v.hiss('bandpass', 700, 200, 0, 0.95, 0.1, 0.25);
  for (let i = 0; i < 12; i++) v.hiss('highpass', 2500, 2500, rand(0.1, 0.9), 0.015, 0.08, 0.001);
}

function singularitySound(v: Voice): void {
  v.hiss('bandpass', 150, 3000, 0, 0.62, 0.15, 0.55);
  v.tone('sawtooth', 60, 600, 0, 0.62, 0.05, 0.55);
  v.tone('sine', 220, 40, 0.64, 0.25, 0.2);
  v.hiss('lowpass', 2500, 300, 0.64, 0.12, 0.12);
}

function stormSound(v: Voice): void {
  v.tone('square', 140, 90, 0, 0.5, 0.05, 0.01);
  for (let i = 0; i < 12; i++) v.hiss('bandpass', rand(1400, 3200), rand(1400, 3200), i * 0.04, 0.05, 0.08, 0.002);
  v.tone('sawtooth', 2600, 180, 0, 0.14, 0.1, 0.002);
}

function anvilSound(v: Voice): void {
  v.tone('sine', 2300, 850, 0.15, 0.33, 0.07, 0.05);
  v.tone('sine', 2340, 880, 0.15, 0.33, 0.04, 0.05);
  v.tone('sine', 80, 38, 0.48, 0.25, 0.2);
  v.tone('square', 190, 150, 0.48, 0.2, 0.08);
  v.tone('triangle', 520, 400, 0.48, 0.32, 0.1);
  v.tone('sine', 1320, 1320, 0.48, 0.45, 0.04);
  v.hiss('highpass', 4000, 4000, 0.48, 0.05, 0.12);
}

function rocketSound(v: Voice): void {
  v.hiss('bandpass', 250, 3200, 0.2, 0.7, 0.14, 0.15);
  v.tone('sawtooth', 80, 520, 0.28, 0.6, 0.06, 0.2);
  v.hiss('lowpass', 900, 900, 0.2, 0.12, 0.1);
  v.tone('sine', 2900, 2900, 0.82, 0.18, 0.08);
  v.tone('sine', 4350, 4350, 0.84, 0.1, 0.04);
}

function confettiSound(v: Voice): void {
  v.hiss('highpass', 1800, 6000, 0.09, 0.08, 0.14, 0.002);
  v.tone('sine', 380, 70, 0.09, 0.09, 0.16, 0.002);
  v.tone('sawtooth', 294, 247, 0.14, 0.32, 0.06, 0.02);
  v.tone('sawtooth', 298, 249, 0.14, 0.32, 0.05, 0.02);
  v.hiss('bandpass', 1200, 1000, 0.14, 0.3, 0.05, 0.02);
  for (let i = 0; i < 8; i++) v.tone('sine', rand(2500, 5200), rand(2500, 5200), rand(0.25, 0.8), 0.07, 0.03);
}

function balloonSound(v: Voice): void {
  for (let i = 0; i < 5; i++) {
    v.tone('triangle', 420 + i * 150, 620 + i * 200, 0.05 + i * 0.09, 0.08, 0.08, 0.01);
    v.hiss('bandpass', 2400, 2800, 0.05 + i * 0.09, 0.07, 0.03, 0.01);
  }
  v.hiss('highpass', 6000, 6000, 0.82, 0.07, 0.2, 0.001);
  v.tone('square', 220, 60, 0.82, 0.05, 0.1, 0.001);
}

function deletedSound(v: Voice): void {
  v.tone('square', 330, 330, 0.05, 0.12, 0.07, 0.003);
  v.tone('square', 247, 247, 0.17, 0.18, 0.07, 0.003);
  v.hiss('highpass', 3500, 3500, 0.42, 0.015, 0.06, 0.001);
  for (let i = 0; i < 9; i++) v.hiss('highpass', 2500, 1500, 0.8 + i * 0.03, 0.03, 0.08, 0.001);
  v.tone('sine', 150, 60, 0.82, 0.12, 0.14);
}

function ghostSound(v: Voice): void {
  HARP_NOTES.forEach((f, i) => {
    v.tone('sine', f, f, 0.25 + i * 0.07, 0.55, 0.07, 0.005);
    v.tone('triangle', f * 2, f * 2, 0.25 + i * 0.07, 0.35, 0.02, 0.005);
  });
}

const SOUNDS: Record<FinisherId, (v: Voice) => void> = {
  shatter: shatterSound,
  supernova: supernovaSound,
  glitch: glitchSound,
  ash: ashSound,
  singularity: singularitySound,
  storm: stormSound,
  anvil: anvilSound,
  rocket: rocketSound,
  confetti: confettiSound,
  balloon: balloonSound,
  deleted: deletedSound,
  ghost: ghostSound,
};

/** Synthesised sound per finisher on the shared bus. `rate` < 1 = slow motion. */
export function finisherSound(kind: FinisherId, ctx: AudioContext, out: AudioNode, rate = 1): void {
  SOUNDS[kind](createVoice(ctx, out, rate));
}

/* -------------------------------- preview -------------------------------- */

const PREVIEW_PX = 48;
const STAND_MS = 600;
const CYCLE_MS = 2900;
const BODY_FADE_MS = 460;
const PREVIEW_FLOOR = 0x1b2027;
const PREVIEW_SEAM = 0x232a33;

function drawPreviewFloor(buf: PixelBuffer, ax: number, ay: number): void {
  buf.clear(PREVIEW_FLOOR);
  for (let y = 4; y < PREVIEW_PX; y += 8) buf.rect(0, y, PREVIEW_PX, 1, PREVIEW_SEAM);
  for (let dx = -4; dx <= 4; dx++) {
    const reach = Math.round(Math.sqrt(Math.max(0, 1 - (dx / 5) ** 2)) * 1.6);
    for (let dy = -reach; dy <= reach; dy++) buf.blend(ax + dx, ay + 8 + dy, BLACK, 0.32);
  }
}

/** Loops a finisher on a small lobby canvas so players see what they pick. */
export function previewFinisher(
  canvas: HTMLCanvasElement,
  kind: FinisherId,
  color: number,
  archetype: number,
): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => undefined;

  const buffer = new PixelBuffer();
  buffer.resize(PREVIEW_PX, PREVIEW_PX);
  const scale = Math.max(2, Math.round((canvas.clientWidth || PREVIEW_PX * 4) / PREVIEW_PX));
  canvas.width = PREVIEW_PX * scale;
  canvas.height = PREVIEW_PX * scale;

  const aim = Math.PI / 2;
  const { facing, flip } = facingFor(aim);
  const body = bodyPixels(sprite(facing, 0, archetype, color), flip);
  const ax = PREVIEW_PX >> 1;
  const ay = (PREVIEW_PX >> 1) + 2;
  const view: FinisherView = { buffer, px: (wx) => Math.round(wx / 4), py: (wy) => Math.round(wy / 4) };
  const victim: Victim = { x: ax * 4, y: ay * 4, aim, color, archetype, from: { x: ax * 4 - 60, y: ay * 4 - 6 } };
  const effects = new Finishers();

  let raf = 0;
  let stopped = false;
  let origin = -1;
  let cycle = -1;
  let spawnedAt = -1;

  const frame = (ts: number): void => {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    if (!canvas.isConnected) {
      origin = -1;
      return;
    }
    if (origin < 0) {
      origin = ts;
      cycle = -1;
    }
    const elapsed = ts - origin;
    const phase = elapsed % CYCLE_MS;
    if (Math.floor(elapsed / CYCLE_MS) !== cycle) {
      cycle = Math.floor(elapsed / CYCLE_MS);
      effects.clear();
      spawnedAt = -1;
    }
    if (spawnedAt < 0 && phase >= STAND_MS) {
      effects.spawn(kind, victim, color, ts);
      spawnedAt = ts;
    }

    drawPreviewFloor(buffer, ax, ay);
    const alpha = spawnedAt < 0 ? 1 : 1 - clamp((ts - spawnedAt) / BODY_FADE_MS);
    for (const p of body) buffer.blend(ax + p.x, ay + p.y, p.color, alpha);
    effects.draw(view, ts);
    buffer.present(ctx, scale);
  };

  raf = requestAnimationFrame(frame);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    effects.clear();
  };
}
