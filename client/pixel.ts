import { GLYPHS, GLYPH_H, GLYPH_W } from './font.js';

/**
 * A software framebuffer.
 *
 * The whole game is drawn into a small pixel grid and blown up with
 * nearest-neighbour scaling, which is the only way to get pixel art that stays
 * on the grid: canvas strokes anti-alias, and anti-aliased pixel art is just
 * blurry art. Every primitive here writes whole pixels and nothing else.
 */
export class PixelBuffer {
  width = 0;
  height = 0;

  private image!: ImageData;
  private data!: Uint8ClampedArray;
  private words!: Uint32Array;
  private scratch = new Uint32Array(0);
  private readonly surface = document.createElement('canvas');
  private readonly surfaceCtx: CanvasRenderingContext2D;

  constructor() {
    const ctx = this.surface.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable.');
    this.surfaceCtx = ctx;
    this.resize(1, 1);
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.surface.width = this.width;
    this.surface.height = this.height;
    this.image = this.surfaceCtx.createImageData(this.width, this.height);
    this.data = this.image.data;
    this.words = new Uint32Array(this.data.buffer);
  }

  clear(color: number): void {
    // 0xAABBGGRR on little-endian, which is every platform we care about.
    this.words.fill(
      0xff000000 | ((color & 0xff) << 16) | (color & 0xff00) | ((color >> 16) & 0xff),
    );
  }

  blend(x: number, y: number, color: number, alpha = 1): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) << 2;
    const d = this.data;
    if (alpha >= 1) {
      d[i] = color >> 16;
      d[i + 1] = (color >> 8) & 0xff;
      d[i + 2] = color & 0xff;
      return;
    }
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    d[i] = r + ((color >> 16) - r) * alpha;
    d[i + 1] = g + (((color >> 8) & 0xff) - g) * alpha;
    d[i + 2] = b + ((color & 0xff) - b) * alpha;
  }

  /** Additive, for anything that is meant to read as light. */
  add(x: number, y: number, color: number, alpha = 1): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) << 2;
    const d = this.data;
    d[i] = d[i]! + (color >> 16) * alpha;
    d[i + 1] = d[i + 1]! + ((color >> 8) & 0xff) * alpha;
    d[i + 2] = d[i + 2]! + (color & 0xff) * alpha;
  }

  /** Additive wash over the whole buffer — the lights-on flash. */
  tint(color: number, strength: number): void {
    if (strength <= 0) return;
    const r = (color >> 16) * strength;
    const g = ((color >> 8) & 0xff) * strength;
    const b = (color & 0xff) * strength;
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i]! + r;
      d[i + 1] = d[i + 1]! + g;
      d[i + 2] = d[i + 2]! + b;
    }
  }

  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.width, (x + w) | 0);
    const y1 = Math.min(this.height, (y + h) | 0);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.blend(px, py, color, alpha);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: number, alpha = 1, additive = false): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;

    for (let guard = 0; guard < 8192; guard++) {
      if (additive) this.add(ax, ay, color, alpha);
      else this.blend(ax, ay, color, alpha);
      if (ax === bx && ay === by) return;
      const e2 = err * 2;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  polyline(points: readonly { x: number; y: number }[], color: number, alpha = 1, additive = false): void {
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      this.line(a.x, a.y, b.x, b.y, color, alpha, additive);
    }
  }

  /** Scanline fill for a convex polygon â€” the arena floor and its platforms. */
  fillConvex(points: readonly { x: number; y: number }[], color: number, alpha = 1): void {
    let top = Infinity;
    let bottom = -Infinity;
    for (const p of points) {
      if (p.y < top) top = p.y;
      if (p.y > bottom) bottom = p.y;
    }
    const y0 = Math.max(0, Math.ceil(top));
    const y1 = Math.min(this.height - 1, Math.floor(bottom));

    for (let y = y0; y <= y1; y++) {
      let left = Infinity;
      let right = -Infinity;
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        const b = points[(i + 1) % points.length]!;
        if (a.y === b.y) continue;
        const lo = Math.min(a.y, b.y);
        const hi = Math.max(a.y, b.y);
        if (y < lo || y > hi) continue;
        const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (x < left) left = x;
        if (x > right) right = x;
      }
      if (left > right) continue;
      const px0 = Math.max(0, Math.round(left));
      const px1 = Math.min(this.width - 1, Math.round(right));
      for (let x = px0; x <= px1; x++) this.blend(x, y, color, alpha);
    }
  }

  disc(cx: number, cy: number, radius: number, color: number, alpha = 1, additive = false): void {
    const r = Math.round(radius);
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    for (let dy = -r; dy <= r; dy++) {
      const span = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      for (let dx = -span; dx <= span; dx++) {
        if (additive) this.add(x0 + dx, y0 + dy, color, alpha);
        else this.blend(x0 + dx, y0 + dy, color, alpha);
      }
    }
  }

  ring(cx: number, cy: number, radius: number, color: number, alpha = 1, additive = false): void {
    const steps = Math.max(12, Math.round(radius * 6));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * radius);
      const y = Math.round(cy + Math.sin(a) * radius);
      if (additive) this.add(x, y, color, alpha);
      else this.blend(x, y, color, alpha);
    }
  }

  /** A soft point light. Cheap because the radius is only ever a few pixels. */
  glow(cx: number, cy: number, radius: number, color: number, strength = 1): void {
    const r = Math.ceil(radius);
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > radius) continue;
        const falloff = (1 - d / radius) ** 2;
        this.add(x0 + dx, y0 + dy, color, falloff * strength);
      }
    }
  }

  /** Pixel text. `scale` doubles whole pixels, never interpolates. */
  text(
    value: string,
    x: number,
    y: number,
    color: number,
    alpha = 1,
    scale = 1,
    tracking = 1,
  ): void {
    let cursor = Math.round(x);
    const top = Math.round(y);
    for (const char of value.toUpperCase()) {
      const glyph = GLYPHS[char];
      if (glyph) {
        for (let gy = 0; gy < GLYPH_H; gy++) {
          const row = glyph[gy]!;
          for (let gx = 0; gx < GLYPH_W; gx++) {
            if (!row[gx]) continue;
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                this.blend(cursor + gx * scale + sx, top + gy * scale + sy, color, alpha);
              }
            }
          }
        }
      }
      cursor += (GLYPH_W + tracking) * scale;
    }
  }

  textWidth(value: string, scale = 1, tracking = 1): number {
    return value.length * (GLYPH_W + tracking) * scale - tracking * scale;
  }

  /**
   * Re-frames what has been drawn so far: magnifies around buffer point
   * (cx, cy) and nudges by (ox, oy) whole pixels. Runs between the world and
   * the HUD, so shake and the killcam zoom never touch the interface.
   */
  camera(cx: number, cy: number, zoom: number, ox: number, oy: number, fill: number): void {
    if (zoom === 1 && ox === 0 && oy === 0 && cx === this.width / 2 && cy === this.height / 2) return;
    if (this.scratch.length !== this.words.length) this.scratch = new Uint32Array(this.words.length);
    this.scratch.set(this.words);
    const empty = 0xff000000 | ((fill & 0xff) << 16) | (fill & 0xff00) | ((fill >> 16) & 0xff);
    const w = this.width;
    const h = this.height;
    for (let y = 0; y < h; y++) {
      const sy = Math.floor(cy + (y - h / 2) / zoom) - oy;
      const row = y * w;
      if (sy < 0 || sy >= h) {
        this.words.fill(empty, row, row + w);
        continue;
      }
      for (let x = 0; x < w; x++) {
        const sx = Math.floor(cx + (x - w / 2) / zoom) - ox;
        this.words[row + x] = sx < 0 || sx >= w ? empty : this.scratch[sy * w + sx]!;
      }
    }
  }

  /** Blits the finished frame onto the visible canvas, pixels intact. */
  present(target: CanvasRenderingContext2D, scale: number): void {
    this.surfaceCtx.putImageData(this.image, 0, 0);
    target.imageSmoothingEnabled = false;
    target.drawImage(this.surface, 0, 0, this.width * scale, this.height * scale);
  }
}
