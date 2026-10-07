import type { FinisherId } from '../shared/constants.js';
import { PixelBuffer } from './pixel.js';
import { SPRITE_W, facingFor, sprite, type Sprite } from './sprites.js';

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
const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));
const easeOut = (u: number): number => 1 - (1 - u) * (1 - u);
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

function mix(a: number, b: number, t: number): number {
  const k = clamp(t);
  const r = ((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k;
  const g = ((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k;
  const bl = (a & 0xff) + ((b & 0xff) - (a & 0xff)) * k;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/** Cheap integer hash → 0..1, so flicker is stable within a frame. */
function hash(a: number, b: number): number {
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

/* ------------------------------ registry --------------------------------- */

type Draw = (buf: PixelBuffer, fx: Effect, ax: number, ay: number, t: number) => void;

const BUILD: Record<FinisherId, (fx: Effect) => void> = {
  shatter: buildShatter,
  supernova: buildSupernova,
  glitch: buildGlitch,
  ash: buildAsh,
  singularity: buildSingularity,
  storm: buildStorm,
};

const DRAW: Record<FinisherId, Draw> = {
  shatter: drawShatter,
  supernova: drawSupernova,
  glitch: drawGlitch,
  ash: drawAsh,
  singularity: drawSingularity,
  storm: drawStorm,
};

const DURATION: Record<FinisherId, number> = {
  shatter: 1000,
  supernova: 1050,
  glitch: 800,
  ash: 1300,
  singularity: 1100,
  storm: 800,
};

const SHAKE: Record<FinisherId, number> = {
  shatter: 2,
  supernova: 4,
  glitch: 1,
  ash: 0.5,
  singularity: 3,
  storm: 2,
};

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

    const fx: Effect = {
      kind,
      start: now,
      victim,
      killer: killerColor,
      body: bodyPixels(art, flip),
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

interface Voice {
  tone(type: OscillatorType, f0: number, f1: number, at: number, dur: number, gain: number, attack?: number): void;
  hiss(type: BiquadFilterType, f0: number, f1: number, at: number, dur: number, gain: number, attack?: number): void;
}

/**
 * Times are authored for rate 1; slow motion stretches them and drops pitch,
 * so a killcam finisher sounds like the same sound played on a slow tape.
 */
function createVoice(ctx: AudioContext, out: AudioNode, rate: number): Voice {
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

const SOUNDS: Record<FinisherId, (v: Voice) => void> = {
  shatter: shatterSound,
  supernova: supernovaSound,
  glitch: glitchSound,
  ash: ashSound,
  singularity: singularitySound,
  storm: stormSound,
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
