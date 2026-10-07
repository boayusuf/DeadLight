import { GLYPHS, GLYPH_H, GLYPH_W } from './font.js';
import { clamp, createVoice, easeOut, hash, mix, type FinisherView } from './finishers.js';
import type { PixelBuffer } from './pixel.js';
import { SPRITE_H, SPRITE_W, sprite, type Sprite } from './sprites.js';

/** How long the cut-in owns the screen. */
export const KILLSCREEN_MS = 1600;
/** How long the winner's finale card holds before the result card. */
export const FINALE_MS = 1400;

export interface Portrait {
  name: string;
  /** Suit colour, 0xRRGGBB. */
  color: number;
  /** Sprite archetype index, for `sprite()`. */
  archetype: number;
}

/* ---------------------------------------------------------------------------
 * Hot pink and black, halftone dots and speed lines. Everything is a pure
 * function of `t`, so the killcam can run it on any clock.
 * ------------------------------------------------------------------------ */

const PINK = 0xff2e88;
const PINK_DARK = 0xb80f62;
const PINK_DEEP = 0x5e0933;
const PINK_LIGHT = 0xff8cc0;
const INK = 0x12050e;
const WHITE = 0xffffff;
const YELLOW = 0xffe14a;
const SKY = 0x7fdcff;
/** The sprite's eye colour, so the X marks can find the eyes. */
const EYE_COLOR = 0x1a1a24;
const CONFETTI = [PINK, YELLOW, WHITE, SKY, PINK_LIGHT, 0x9dff7a];

/** The diagonal leans this many pixels per row (about 17 degrees off vertical). */
const LEAN = 0.3;
const FLASH_MS = 40;
const OPEN_MS = 120;
const PORTRAIT_FROM = 80;
const PORTRAIT_IN_MS = 260;
const STAMP_FROM = 350;
const HOLD_UNTIL = 1050;
const SHATTER_AT = 1100;
const WIPE_FROM = 1150;

const seamX = (w: number, h: number, y: number): number => w / 2 + (h / 2 - y) * LEAN;
const compact = (buf: PixelBuffer): boolean => buf.width < 400;

/* -------------------------------- backdrop -------------------------------- */

function drawPanels(buf: PixelBuffer, t: number): void {
  const w = buf.width;
  const h = buf.height;
  const open = easeOut(clamp((t - FLASH_MS) / (OPEN_MS - FLASH_MS)));
  buf.clear(open < 1 ? WHITE : PINK);
  for (let y = 0; y < h; y++) {
    const sx = Math.round(seamX(w, h, y));
    if (open < 1) buf.rect(sx - w * open, y, w * open, 1, PINK);
    buf.rect(sx, y, w * open, 1, INK);
  }
}

/** Dots swell towards the diagonal, like a screentone sheet. */
function drawHalftone(buf: PixelBuffer, t: number): void {
  const w = buf.width;
  const h = buf.height;
  const cell = compact(buf) ? 6 : 8;
  const drift = Math.floor(t * 0.04) % cell;
  for (let row = -1; row * cell < h + cell; row++) {
    const cy = row * cell + (cell >> 1) + drift;
    for (let col = -1; col * cell < w + cell; col++) {
      const cx = col * cell + ((row & 1) * cell) / 2 + drift;
      const near = 1 - Math.abs(cx - seamX(w, h, cy)) / (w * 0.5);
      const r = Math.round(cell * 0.62 * clamp(near * 1.1 + 0.05));
      if (r < 1) continue;
      buf.disc(cx, cy, r, cx < seamX(w, h, cy) ? PINK_DARK : PINK_DEEP);
    }
  }
}

/** Radial speed lines that re-roll every few frames, the way anime cels flicker. */
function drawSpeedLines(buf: PixelBuffer, t: number): void {
  const cx = buf.width / 2;
  const cy = buf.height / 2;
  const frame = Math.floor(t / 45);
  const far = Math.hypot(cx, cy) + 4;
  const inner = Math.min(buf.width, buf.height) * 0.3;
  for (let i = 0; i < 32; i++) {
    if (hash(frame, i) < 0.35) continue;
    const a = (i / 32) * Math.PI * 2 + hash(i, 3) * 0.15;
    const near = inner * (0.9 + hash(frame, i + 40) * 0.8);
    const c = Math.cos(a);
    const s = Math.sin(a);
    buf.line(cx + c * near, cy + s * near, cx + c * far, cy + s * far, WHITE, 0.32);
    if (i % 3 === 0) buf.line(cx + c * near + 1, cy + s * near, cx + c * far + 1, cy + s * far, WHITE, 0.2);
  }
}

/** A spiky burst as a fan of triangles, because fillConvex only does convex shapes. */
function drawBurst(
  buf: PixelBuffer,
  cx: number,
  cy: number,
  outer: number,
  spikes: number,
  spin: number,
  color: number,
  alpha: number,
): void {
  const inner = outer * 0.62;
  for (let i = 0; i < spikes; i++) {
    const a0 = spin + (i / spikes) * Math.PI * 2;
    const a1 = spin + ((i + 0.5) / spikes) * Math.PI * 2;
    const a2 = spin + ((i + 1) / spikes) * Math.PI * 2;
    buf.fillConvex(
      [
        { x: cx + Math.cos(a0) * inner, y: cy + Math.sin(a0) * inner },
        { x: cx + Math.cos(a1) * outer, y: cy + Math.sin(a1) * outer },
        { x: cx + Math.cos(a2) * inner, y: cy + Math.sin(a2) * inner },
        { x: cx, y: cy },
      ],
      color,
      alpha,
    );
  }
}

/* -------------------------------- portraits ------------------------------- */

interface Layout {
  scale: number;
  killer: { x: number; y: number };
  victim: { x: number; y: number };
}

/** Killer upper left on the pink side, victim lower right on the black side. */
function layoutFor(buf: PixelBuffer): Layout {
  const w = buf.width;
  const h = buf.height;
  const scale = clamp(Math.floor(Math.min((w * 0.26) / SPRITE_W, (h * 0.3) / SPRITE_H)), 3, 6);
  return {
    scale,
    killer: { x: Math.round(w * 0.27), y: Math.round(h * 0.26) },
    victim: { x: Math.round(w * 0.73), y: Math.round(h * 0.74) },
  };
}

function toGrey(color: number): number {
  const l = ((color >> 16) & 0xff) * 0.3 + ((color >> 8) & 0xff) * 0.59 + (color & 0xff) * 0.11;
  return mix((Math.round(l) << 16) | (Math.round(l) << 8) | Math.round(l), 0x2a2430, 0.25);
}

/** White sticker rim, then a thick dark outline, then the sprite itself. */
function paintSprite(buf: PixelBuffer, art: Sprite, x0: number, y0: number, scale: number, grey: boolean): void {
  const thick = Math.max(2, Math.round(scale / 2));
  for (const [grow, color] of [[thick + 1, WHITE], [thick, INK]] as const) {
    for (let y = 0; y < art.height; y++) {
      for (let x = 0; x < art.width; x++) {
        if (art.pixels[y * art.width + x]! < 0) continue;
        buf.rect(x0 + x * scale - grow, y0 + y * scale - grow, scale + grow * 2, scale + grow * 2, color);
      }
    }
  }
  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      const color = art.pixels[y * art.width + x]!;
      if (color >= 0) buf.rect(x0 + x * scale, y0 + y * scale, scale, scale, grey ? toGrey(color) : color);
    }
  }
}

/** An X over each eye, found by the sprite's eye colour. */
function drawEyeCrosses(buf: PixelBuffer, art: Sprite, x0: number, y0: number, scale: number): void {
  const cells = [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]] as const;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < art.width; x++) {
      if (art.pixels[y * art.width + x] !== EYE_COLOR) continue;
      for (const [dx, dy] of cells) buf.rect(x0 + (x + dx) * scale, y0 + (y + dy) * scale, scale, scale, INK);
    }
  }
}

function drawDread(buf: PixelBuffer, x0: number, y0: number, scale: number): void {
  const width = Math.max(1, Math.round(scale / 3));
  for (let col = 3; col <= 10; col += 2) {
    buf.rect(x0 + col * scale + 1, y0 + scale, width, scale * 3, 0x4b2c5e, 0.8);
  }
}

function drawSweat(buf: PixelBuffer, x: number, y: number, r: number): void {
  buf.fillConvex([{ x, y: y - r * 2 }, { x: x - r, y }, { x: x + r, y }], SKY);
  buf.disc(x, y, r, SKY);
  buf.blend(x - 1, y - 1, WHITE);
}

function drawKiller(buf: PixelBuffer, p: Portrait, cx: number, cy: number, scale: number, t: number): void {
  const art = sprite('down', 0, p.archetype, p.color);
  const frame = Math.floor(t / 50);
  const jx = t > 340 ? Math.round((hash(frame, 1) - 0.5) * 2) : 0;
  const jy = t > 340 ? Math.round((hash(frame, 2) - 0.5) * 2) : 0;
  const x0 = cx - Math.round((SPRITE_W * scale) / 2) + jx;
  const y0 = cy - Math.round((SPRITE_H * scale) / 2) + jy;
  drawBurst(buf, cx, cy, SPRITE_H * scale * 0.8, 14, t / 900, WHITE, 0.18);
  paintSprite(buf, art, x0, y0, scale, false);
  const glint = Math.sin(t / 130) * 0.5 + 0.5;
  const gx = x0 + SPRITE_W * scale + scale;
  buf.line(gx - 3 - glint * 3, y0 + scale, gx + 3 + glint * 3, y0 + scale, WHITE);
  buf.line(gx, y0 + scale - 3 - glint * 3, gx, y0 + scale + 3 + glint * 3, WHITE);
}

function drawVictim(buf: PixelBuffer, p: Portrait, cx: number, cy: number, scale: number, t: number): void {
  const art = sprite('down', 0, p.archetype, p.color);
  const x0 = cx - Math.round((SPRITE_W * scale) / 2);
  const y0 = cy - Math.round((SPRITE_H * scale) / 2);
  drawBurst(buf, cx, cy, SPRITE_H * scale * 0.8, 12, -t / 1100, PINK_DEEP, 0.5);
  paintSprite(buf, art, x0, y0, scale, true);
  drawEyeCrosses(buf, art, x0, y0, scale);
  drawDread(buf, x0, y0, scale);
  const fall = ((t / 420) % 1) * scale * 2;
  drawSweat(buf, x0 + (SPRITE_W + 1) * scale, Math.round(y0 + scale * 2 + fall), Math.max(2, scale >> 1));
}

/** The double-KO stand-in for the killer: a comic impact burst with "KO". */
function drawImpactBurst(buf: PixelBuffer, cx: number, cy: number, scale: number, t: number): void {
  const r = SPRITE_H * scale * 0.6;
  drawBurst(buf, cx, cy, r, 12, t / 600, INK, 1);
  drawBurst(buf, cx, cy, r * 0.88, 12, t / 600, YELLOW, 1);
  const s = Math.max(2, scale);
  const x = cx - Math.round(buf.textWidth('KO', s) / 2);
  const y = cy - Math.round((GLYPH_H * s) / 2);
  for (const [dx, dy] of [[-s, 0], [s, 0], [0, -s], [0, s], [s, s]] as const) buf.text('KO', x + dx, y + dy, INK, 1, s);
  buf.text('KO', x, y, PINK, 1, s);
}

function drawLabel(buf: PixelBuffer, text: string, cx: number, y: number, fg: number, bg: number): void {
  const label = text.slice(0, 10);
  const sc = compact(buf) ? 1 : 2;
  const pad = 3 * sc;
  const w = buf.textWidth(label, sc) + pad * 2;
  const h = GLYPH_H * sc + sc * 3;
  const skew = Math.round(h * LEAN) + 1;
  const x = Math.round(cx - w / 2);
  const shape = [
    { x: x + skew, y },
    { x: x + w + skew, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
  buf.fillConvex(shape, bg);
  buf.polyline(shape, WHITE);
  buf.text(label, x + pad + (skew >> 1), y + Math.round(sc * 1.5), fg, 1, sc);
}

function drawPortraits(buf: PixelBuffer, killer: Portrait | null, victim: Portrait, t: number): void {
  if (t < PORTRAIT_FROM) return;
  const lay = layoutFor(buf);
  const slide = 1 - easeOut(clamp((t - PORTRAIT_FROM) / PORTRAIT_IN_MS));
  const off = Math.round(slide * buf.width * 0.7);
  const half = Math.round((SPRITE_H * lay.scale) / 2);
  const kx = lay.killer.x - off;
  const vx = lay.victim.x + off;
  if (killer) drawKiller(buf, killer, kx, lay.killer.y, lay.scale, t);
  else drawImpactBurst(buf, kx, lay.killer.y, lay.scale, t);
  drawVictim(buf, victim, vx, lay.victim.y, lay.scale, t);
  if (killer) drawLabel(buf, killer.name, kx, lay.killer.y - half - (compact(buf) ? 14 : 22), WHITE, PINK_DARK);
  drawLabel(buf, victim.name, vx, lay.victim.y + half + 6, 0xc9c4d0, INK);
}

/* -------------------------------- caption --------------------------------- */

/**
 * The caption as a cached pixel grid: 0 empty, 1 outline, 2 fill. Built from
 * the font by hand because buffer.text can not slant, and one grid serves the
 * stamp, the hold and the shatter, which needs to know every pixel it moves.
 */
interface CaptionArt {
  w: number;
  h: number;
  pad: number;
  cells: Uint8Array;
  shard: Uint8Array | null;
}

const captionCache = new Map<string, CaptionArt>();

function fillGlyphs(art: CaptionArt, text: string, scale: number): void {
  let cursor = art.pad;
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char];
    for (let gy = 0; glyph && gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (!glyph[gy]![gx]) continue;
        for (let sy = 0; sy < scale; sy++) {
          const row = gy * scale + sy;
          const shift = Math.round((GLYPH_H * scale - 1 - row) * LEAN);
          for (let sx = 0; sx < scale; sx++) art.cells[(art.pad + row) * art.w + cursor + shift + gx * scale + sx] = 2;
        }
      }
    }
    cursor += (GLYPH_W + 1) * scale;
  }
}

/** Two sweeps per axis grow the outline in O(pixels) instead of O(pixels * radius^2). */
function growOutline(art: CaptionArt): void {
  const { w, h, pad, cells } = art;
  const reach = new Uint8Array(cells.length);
  for (let y = 0; y < h; y++) {
    for (const dir of [1, -1]) {
      let last = -1000;
      for (let i = 0; i < w; i++) {
        const x = dir > 0 ? i : w - 1 - i;
        if (cells[y * w + x] === 2) last = i;
        if (i - last <= pad) reach[y * w + x] = 1;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (const dir of [1, -1]) {
      let last = -1000;
      for (let i = 0; i < h; i++) {
        const y = dir > 0 ? i : h - 1 - i;
        if (reach[y * w + x]) last = i;
        if (i - last <= pad && cells[y * w + x] === 0) cells[y * w + x] = 1;
      }
    }
  }
}

function captionArt(text: string, scale: number): CaptionArt {
  const key = `${text}|${scale}`;
  const hit = captionCache.get(key);
  if (hit) return hit;
  const pad = Math.max(2, Math.round(scale * 0.45));
  const w = text.length * (GLYPH_W + 1) * scale + Math.round(GLYPH_H * scale * LEAN) + pad * 2 + 1;
  const h = GLYPH_H * scale + pad * 2;
  const art: CaptionArt = { w, h, pad, cells: new Uint8Array(w * h), shard: null };
  fillGlyphs(art, text, scale);
  growOutline(art);
  if (captionCache.size > 24) captionCache.clear();
  captionCache.set(key, art);
  return art;
}

/** Biggest scale that keeps the caption inside the buffer, capped so it never swallows the portraits. */
function captionScale(buf: PixelBuffer, text: string): number {
  const units = text.length * (GLYPH_W + 1) + 2;
  return clamp(Math.floor((buf.width * 0.92) / units), 2, Math.max(2, Math.floor((buf.height * 0.12) / GLYPH_H)));
}

function captionFill(art: CaptionArt, row: number): number {
  return row < (art.h >> 1) ? WHITE : 0xffc9e2;
}

function blitCaption(buf: PixelBuffer, art: CaptionArt, x0: number, y0: number): void {
  const drop = Math.max(2, art.pad >> 1);
  for (let y = 0; y < art.h; y++) {
    for (let x = 0; x < art.w; x++) {
      if (art.cells[y * art.w + x]) buf.blend(x0 + x + drop, y0 + y + drop, PINK_DEEP, 0.85);
    }
  }
  for (let y = 0; y < art.h; y++) {
    for (let x = 0; x < art.w; x++) {
      const kind = art.cells[y * art.w + x]!;
      if (kind) buf.blend(x0 + x, y0 + y, kind === 1 ? INK : captionFill(art, y));
    }
  }
}

/** Integer scales only, so the stamp slams from huge to settled in whole-pixel steps. */
function stampScale(t: number, base: number): number {
  if (t < 400) return base + 3;
  if (t < 440) return base + 1;
  if (t < 490) return base + 2;
  return base;
}

function drawShockwave(buf: PixelBuffer, t: number): void {
  for (const at of [400, 490]) {
    const age = t - at;
    if (age < 0 || age > 200) continue;
    const u = age / 200;
    buf.ring(buf.width / 2, buf.height / 2, easeOut(u) * buf.width * 0.45, WHITE, 1 - u);
  }
}

/* -------------------------------- shatter --------------------------------- */

const SHARD_COLS = 8;
const SHARD_ROWS = 3;

interface Seed {
  x: number;
  y: number;
}

function shardSeeds(art: CaptionArt): Seed[] {
  const seeds: Seed[] = [];
  for (let r = 0; r < SHARD_ROWS; r++) {
    for (let c = 0; c < SHARD_COLS; c++) {
      seeds.push({
        x: ((c + 0.5 + (hash(c, r) - 0.5) * 0.7) / SHARD_COLS) * art.w,
        y: ((r + 0.5 + (hash(r, c + 9) - 0.5) * 0.7) / SHARD_ROWS) * art.h,
      });
    }
  }
  return seeds;
}

/** Every caption pixel joins the shard of its nearest seed, a Voronoi cut. */
function assignShards(art: CaptionArt, seeds: readonly Seed[]): Uint8Array {
  const shard = new Uint8Array(art.cells.length);
  for (let y = 0; y < art.h; y++) {
    for (let x = 0; x < art.w; x++) {
      if (!art.cells[y * art.w + x]) continue;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const d = (seeds[i]!.x - x) ** 2 + (seeds[i]!.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      shard[y * art.w + x] = best;
    }
  }
  return shard;
}

interface ShardMotion {
  dx: number;
  dy: number;
  cos: number;
  sin: number;
}

function shardMotion(i: number, seed: Seed, art: CaptionArt, ts: number, k: number): ShardMotion {
  const ax = seed.x - art.w / 2;
  const ay = seed.y - art.h / 2;
  const len = Math.hypot(ax, ay) || 1;
  const speed = (60 + hash(i, 1) * 140) * k;
  const vx = (ax / len) * speed + (hash(i, 2) - 0.5) * 30 * k;
  const vy = (ay / len) * speed - 40 * k;
  const angle = (hash(i, 3) - 0.5) * 3.2 * ts;
  return {
    dx: vx * ts,
    dy: vy * ts + 150 * k * ts * ts,
    cos: Math.cos(angle),
    sin: Math.sin(angle),
  };
}

function drawGlassFacets(
  buf: PixelBuffer,
  seeds: readonly Seed[],
  motions: readonly ShardMotion[],
  x0: number,
  y0: number,
  alpha: number,
  size: number,
): void {
  for (let i = 0; i < seeds.length; i++) {
    const m = motions[i]!;
    const pts = [0, 2.1, 4.2].map((a) => {
      const ang = a + hash(i, 4) * 6;
      const r = size * (0.7 + hash(i, 5) * 0.5);
      const lx = Math.cos(ang) * r;
      const ly = Math.sin(ang) * r;
      return {
        x: x0 + seeds[i]!.x + lx * m.cos - ly * m.sin + m.dx,
        y: y0 + seeds[i]!.y + lx * m.sin + ly * m.cos + m.dy,
      };
    });
    buf.fillConvex(pts, WHITE, 0.2 * alpha);
    buf.polyline(pts, WHITE, 0.55 * alpha);
  }
}

function drawShards(buf: PixelBuffer, art: CaptionArt, x0: number, y0: number, t: number): void {
  const seeds = shardSeeds(art);
  art.shard ??= assignShards(art, seeds);
  const ts = (t - SHATTER_AT) / 1000;
  const k = clamp(buf.width / 190, 1, 2.5);
  const alpha = 1 - clamp((ts - 0.28) / 0.22);
  if (alpha <= 0) return;
  const motions = seeds.map((seed, i) => shardMotion(i, seed, art, ts, k));
  drawGlassFacets(buf, seeds, motions, x0, y0, alpha, art.h / 2);
  for (let y = 0; y < art.h; y++) {
    for (let x = 0; x < art.w; x++) {
      const kind = art.cells[y * art.w + x]!;
      if (!kind) continue;
      const i = art.shard[y * art.w + x]!;
      const m = motions[i]!;
      const rx = x - seeds[i]!.x;
      const ry = y - seeds[i]!.y;
      const px = Math.round(x0 + seeds[i]!.x + rx * m.cos - ry * m.sin + m.dx);
      const py = Math.round(y0 + seeds[i]!.y + rx * m.sin + ry * m.cos + m.dy);
      buf.blend(px, py, kind === 1 ? INK : captionFill(art, y), alpha);
    }
  }
}

/** White cracks spread from the middle of the caption just before it lets go. */
function drawCracks(buf: PixelBuffer, art: CaptionArt, x0: number, y0: number, u: number): void {
  const cx = x0 + art.w / 2;
  const cy = y0 + art.h / 2;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + hash(i, 6) * 0.4;
    const reach = (art.w * 0.4 * (0.4 + hash(i, 7))) * u;
    buf.line(cx, cy, cx + Math.cos(a) * reach, cy + Math.sin(a) * reach * 0.6, WHITE);
  }
}

function drawCaption(buf: PixelBuffer, text: string, t: number): void {
  if (t < STAMP_FROM) return;
  const base = captionScale(buf, text);
  const art = captionArt(text, t < HOLD_UNTIL ? stampScale(t, base) : base);
  const tremble = t > 500 && t < SHATTER_AT;
  const jx = tremble ? Math.round((hash(Math.floor(t / 70), 8) - 0.5) * 2) : 0;
  const jy = tremble ? Math.round((hash(Math.floor(t / 70), 9) - 0.5) * 2) : 0;
  const x0 = Math.round((buf.width - art.w) / 2) + jx;
  const y0 = Math.round((buf.height - art.h) / 2) + jy;
  drawShockwave(buf, t);
  if (t >= SHATTER_AT) {
    drawShards(buf, art, x0, y0, t);
    return;
  }
  blitCaption(buf, art, x0, y0);
  if (t >= HOLD_UNTIL) drawCracks(buf, art, x0, y0, (t - HOLD_UNTIL) / (SHATTER_AT - HOLD_UNTIL));
}

/* ---------------------------------- wipe ---------------------------------- */

/** Diagonal stripes alternately sweep down and up until the screen is pink and black bars. */
function drawWipe(buf: PixelBuffer, t: number): void {
  if (t < WIPE_FROM) return;
  const w = buf.width;
  const h = buf.height;
  const p = clamp((t - WIPE_FROM) / (KILLSCREEN_MS - WIPE_FROM));
  const band = Math.max(10, Math.round(w / 14));
  const span = h * LEAN;
  const count = Math.ceil((w + span) / band) + 1;
  for (let i = 0; i < count; i++) {
    const local = clamp(p * 1.6 - (i / count) * 0.6);
    if (local <= 0) continue;
    const ya = i % 2 === 0 ? 0 : h * (1 - local);
    const yb = i % 2 === 0 ? h * local : h;
    const ua = -span / 2 + i * band;
    const ub = ua + band + 1;
    const at = (u: number, y: number): number => u + (h / 2 - y) * LEAN;
    buf.fillConvex(
      [
        { x: at(ua, ya), y: ya },
        { x: at(ub, ya), y: ya },
        { x: at(ub, yb), y: yb },
        { x: at(ua, yb), y: yb },
      ],
      i % 2 === 0 ? PINK : INK,
    );
  }
}

/** Screen kicks at each stamp landing and at the shatter, as whole-pixel offsets. */
function joltAt(buf: PixelBuffer, t: number): void {
  const big = compact(buf) ? 3 : 6;
  let ox = 0;
  let oy = 0;
  for (const [at, mag] of [[400, 1], [440, 1], [490, 1.6], [SHATTER_AT, 2]] as const) {
    const age = t - at;
    if (age < 0 || age > 110) continue;
    const decay = (1 - age / 110) * big * mag;
    ox += Math.round(Math.sin(age / 9) * decay);
    oy += Math.round(Math.cos(age / 7) * decay);
  }
  if (ox !== 0 || oy !== 0) buf.camera(buf.width / 2, buf.height / 2, 1, ox, oy, INK);
}

/**
 * The anime cut-in on the final kill. Takes over the whole buffer for its
 * duration. `t` is ms since it started, 0..KILLSCREEN_MS. `killer` is null when
 * nobody survived (double KO); `caption` is e.g. "EXECUTED!" or "DOUBLE KO!".
 */
export function drawKillscreen(
  buffer: PixelBuffer,
  killer: Portrait | null,
  victim: Portrait,
  caption: string,
  t: number,
): void {
  if (t < FLASH_MS) {
    buffer.clear(WHITE);
    return;
  }
  drawPanels(buffer, t);
  drawHalftone(buffer, t);
  drawSpeedLines(buffer, t);
  drawPortraits(buffer, killer, victim, t);
  drawCaption(buffer, caption, t);
  drawWipe(buffer, t);
  if (t < OPEN_MS) buffer.tint(WHITE, 0.8 * (1 - t / OPEN_MS));
  joltAt(buffer, t);
}

/* --------------------------------- finale --------------------------------- */

const FINALE_IN_MS = 300;

/** Halftone dots along every edge, shrinking inwards. */
function drawDotBorder(buf: PixelBuffer, ease: number): void {
  const w = buf.width;
  const h = buf.height;
  const cell = compact(buf) ? 6 : 8;
  for (let ring = 0; ring < 3; ring++) {
    const r = Math.round((3 - ring) * (cell / 6) * ease);
    if (r < 1) continue;
    const inset = ring * cell + (cell >> 1);
    for (let x = inset; x < w - inset + cell; x += cell) {
      buf.disc(x, inset, r, PINK);
      buf.disc(x, h - inset, r, PINK);
    }
    for (let y = inset + cell; y < h - inset; y += cell) {
      buf.disc(inset, y, r, PINK);
      buf.disc(w - inset, y, r, PINK);
    }
  }
}

function drawFlecks(buf: PixelBuffer, t: number, ease: number): void {
  for (let i = 0; i < 36; i++) {
    const x = Math.round(hash(i, 1) * buf.width + Math.sin(t / 200 + i) * 3);
    const y = Math.round((hash(i, 2) * buf.height + t * (0.04 + hash(i, 3) * 0.06)) % buf.height);
    const color = CONFETTI[i % CONFETTI.length]!;
    const flat = (Math.floor(t / 110) + i) % 2 === 0;
    buf.rect(x, y, flat ? 3 : 1, flat ? 1 : 3, color, ease);
  }
}

/** Banner with the slanted title on a hot pink band. */
function drawBanner(buf: PixelBuffer, text: string, y: number, slide: number): void {
  const art = captionArt(text, captionScale(buf, text));
  const h = art.h + 6;
  const skew = Math.round(h * LEAN);
  const off = Math.round(slide * buf.width);
  const band = [
    { x: -10 + skew + off, y },
    { x: buf.width + 10 + off, y },
    { x: buf.width + 10 - skew + off, y: y + h },
    { x: -10 + off, y: y + h },
  ];
  buf.fillConvex(band, PINK);
  buf.polyline(band, INK);
  buf.line(-10 + off, y + h + 1, buf.width + 10 - skew + off, y + h + 1, INK);
  blitCaption(buf, art, Math.round((buf.width - art.w) / 2) + off, y + 3);
}

function drawDrawSign(buf: PixelBuffer, cx: number, cy: number, scale: number): void {
  const w = SPRITE_W * scale * 0.9;
  const bar = Math.max(3, scale * 2);
  for (const dy of [-bar, bar]) {
    buf.rect(cx - w / 2 - 2, cy + dy - bar / 2 - 2, w + 4, bar + 4, INK);
    buf.rect(cx - w / 2, cy + dy - bar / 2, w, bar, WHITE);
  }
}

/** The winner's portrait dropping in, or a pair of bars when nobody won. */
function drawWinnerFigure(buf: PixelBuffer, winner: Portrait | null, cx: number, cy: number, scale: number, t: number): void {
  const p = clamp(t / FINALE_IN_MS);
  const bob = t > FINALE_IN_MS ? Math.sin(t / 220) * 1.5 : 0;
  const y = cy + Math.round(-(1 - p * p) * buf.height * 0.6 + bob);
  if (!winner) {
    drawDrawSign(buf, cx, y, scale);
    return;
  }
  const art = sprite('down', 0, winner.archetype, winner.color);
  paintSprite(buf, art, cx - Math.round((SPRITE_W * scale) / 2), y - Math.round((SPRITE_H * scale) / 2), scale, false);
}

/** The winner's card over the arena once the finisher has played. Interface layer, never zoomed. */
export function drawFinale(buffer: PixelBuffer, winner: Portrait | null, title: string, t: number): void {
  const w = buffer.width;
  const h = buffer.height;
  const ease = easeOut(clamp(t / FINALE_IN_MS));
  buffer.rect(0, 0, w, h, INK, 0.5 * ease);
  drawDotBorder(buffer, ease);
  const scale = clamp(Math.floor(Math.min((w * 0.34) / SPRITE_W, (h * 0.28) / SPRITE_H)), 3, 7);
  const cx = Math.round(w / 2);
  const cy = Math.round(h * 0.36);
  const reach = Math.min(w, h) * ease;
  drawBurst(buffer, cx, cy, reach * 0.36, 16, t / 1400, INK, 0.9);
  drawBurst(buffer, cx, cy, reach * 0.32, 16, t / 1400, PINK, 1);
  drawWinnerFigure(buffer, winner, cx, cy, scale, t);
  const bannerText = winner ? title || 'WINNER' : 'DRAW';
  const bannerY = cy + Math.round((SPRITE_H * scale) / 2) + 6;
  drawBanner(buffer, bannerText, bannerY, 1 - ease);
  const sub = winner ? winner.name : title;
  if (sub) {
    const bannerH = captionArt(bannerText, captionScale(buffer, bannerText)).h + 6;
    drawLabel(buffer, sub, cx, bannerY + bannerH + 8, WHITE, INK);
  }
  drawFlecks(buffer, t, ease);
}

/* --------------------------------- sound ---------------------------------- */

const STINGER_ROOT = 233;
/** Minor triad plus octave, as ratios over the root. */
const STINGER_CHORD = [1, 1.189, 1.498, 2];

export function killscreenSound(ctx: AudioContext, out: AudioNode): void {
  const v = createVoice(ctx, out, 1);
  v.hiss('bandpass', 7000, 1400, 0, 0.12, 0.16, 0.002);
  v.tone('sawtooth', 3200, 400, 0, 0.1, 0.05, 0.002);
  v.tone('sine', 110, 48, 0.08, 0.35, 0.18, 0.004);
  for (const ratio of STINGER_CHORD) {
    const f = STINGER_ROOT * ratio;
    for (const cents of [0.993, 1, 1.007]) v.tone('sawtooth', f * cents * 1.12, f * cents * 0.75, 0.08, 0.9, 0.022, 0.03);
  }
  v.hiss('highpass', 3500, 8000, 1.1, 0.5, 0.14, 0.002);
  v.tone('sine', 190, 60, 1.1, 0.12, 0.12, 0.002);
  for (let i = 0; i < 14; i++) {
    const f = 2400 + hash(i, 31) * 4400;
    v.tone('sine', f, f, 1.1 + hash(i, 32) * 0.4, 0.14, 0.035, 0.002);
  }
}

const FANFARE: readonly (readonly [number, number, number])[] = [
  [523, 0, 0.12],
  [659, 0.12, 0.12],
  [784, 0.24, 0.12],
  [1047, 0.36, 0.5],
];

export function finaleSound(ctx: AudioContext, out: AudioNode, won: boolean): void {
  const v = createVoice(ctx, out, 1);
  if (won) {
    for (const [f, at, dur] of FANFARE) {
      v.tone('square', f, f, at, dur, 0.07, 0.008);
      v.tone('sawtooth', f * 1.004, f * 1.004, at, dur, 0.05, 0.008);
    }
    for (const f of [523, 659, 784]) v.tone('triangle', f, f, 0.36, 0.5, 0.05, 0.01);
    return;
  }
  const wah: readonly (readonly [number, number, number, number])[] = [
    [311, 293, 0, 0.26],
    [293, 277, 0.3, 0.26],
    [277, 262, 0.6, 0.26],
    [262, 175, 0.9, 0.7],
  ];
  for (const [f0, f1, at, dur] of wah) {
    v.tone('sawtooth', f0, f1, at, dur, 0.09, 0.03);
    v.tone('square', f0 / 2, f1 / 2, at, dur, 0.05, 0.03);
  }
}

/* --------------------------------- splats --------------------------------- */

const SPLAT_LIFE_MS = 2100;
const SPLAT_FADE_MS = 600;
const DROPLET_FLIGHT_MS = 180;
const SPLAT_TONES = [PINK, PINK, PINK_DARK, PINK_LIGHT] as const;

interface Blob {
  /** Landing spot as a buffer-pixel offset from the splat's origin. */
  dx: number;
  dy: number;
  radius: number;
  delay: number;
  tone: number;
  /** Height of the droplet's arc in pixels. */
  arc: number;
}

interface SplatGroup {
  x: number;
  y: number;
  born: number;
  blobs: Blob[];
}

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

function makeBlobs(count: number): Blob[] {
  const blobs: Blob[] = [{ dx: 0, dy: 0, radius: 4, delay: 0, tone: PINK, arc: 0 }];
  for (let i = 0; i < count; i++) {
    const angle = rand(0, Math.PI * 2);
    const dist = rand(4, 18);
    blobs.push({
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist * 0.6,
      radius: Math.random() < 0.3 ? 3 : Math.random() < 0.5 ? 2 : 1,
      delay: rand(0, 60),
      tone: SPLAT_TONES[Math.floor(Math.random() * SPLAT_TONES.length)]!,
      arc: rand(6, 16),
    });
  }
  return blobs;
}

function drawBlob(buf: PixelBuffer, x: number, y: number, blob: Blob, alpha: number): void {
  buf.disc(x, y, blob.radius, mix(blob.tone, INK, 0.35), alpha);
  buf.disc(x, y - (blob.radius > 1 ? 1 : 0), Math.max(0, blob.radius - 1), blob.tone, alpha);
  if (blob.radius > 1) buf.blend(x - 1, y - 1, PINK_LIGHT, alpha);
}

/** Pink comic splats for the execution. Driven by the same clock as the finishers. */
export class Splats {
  private groups: SplatGroup[] = [];

  spawn(x: number, y: number, now: number, count = 7): void {
    this.groups.push({ x, y, born: now, blobs: makeBlobs(count) });
  }

  draw(view: FinisherView, now: number): void {
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const group = this.groups[i]!;
      const age = now - group.born;
      if (age > SPLAT_LIFE_MS) {
        this.groups.splice(i, 1);
        continue;
      }
      if (age < 0) continue;
      const ox = view.px(group.x);
      const oy = view.py(group.y);
      const fade = 1 - clamp((age - (SPLAT_LIFE_MS - SPLAT_FADE_MS)) / SPLAT_FADE_MS);
      for (const blob of group.blobs) this.drawOne(view.buffer, ox, oy, blob, age - blob.delay, fade);
    }
  }

  private drawOne(buf: PixelBuffer, ox: number, oy: number, blob: Blob, age: number, fade: number): void {
    if (age < 0) return;
    if (age < DROPLET_FLIGHT_MS) {
      const u = age / DROPLET_FLIGHT_MS;
      const x = Math.round(ox + blob.dx * u);
      const y = Math.round(oy + blob.dy * u - Math.sin(u * Math.PI) * blob.arc);
      buf.rect(x, y, 2, 2, blob.tone, fade);
      return;
    }
    drawBlob(buf, Math.round(ox + blob.dx), Math.round(oy + blob.dy), blob, fade);
  }

  clear(): void {
    this.groups.length = 0;
  }
}
