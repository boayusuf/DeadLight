import { GAME_IDS, type GameId } from '../shared/games.js';
import type { ModeId } from '../shared/modes.js';
import { PixelBuffer } from './pixel.js';

/**
 * The little pictures on the game buttons.
 *
 * Each one is drawn in the same pixel buffer the game itself uses, so a button
 * looks like the thing it starts: an eye at the end of a corridor, a tile about
 * to drop, a door with a number on it, a floe, a fuse. They animate slowly, so
 * the menu has a pulse without asking for attention.
 */
const BACK = 0x0d1015;
const PANEL = 0x131820;
const METAL = 0x3a4552;
const PALE = 0xe8eef6;
const INK = 0x9aa6b8;
const PINK = 0xff2e88;
const AMBER = 0xf0a23a;
const RED = 0xe0564e;
const GREEN = 0x56a86b;
const ICE = 0x6f93b8;

/** One buffer, reused for every icon: they are drawn one at a time. */
const buffer = new PixelBuffer();

export type IconName = GameId | ModeId | 'mix' | 'music' | 'muted' | 'leave';

/** Paints an icon at the canvas's own size, which the stylesheet sets. */
export function paintIcon(canvas: HTMLCanvasElement, icon: IconName, now: number): void {
  const side = 22;
  buffer.resize(side, side);
  buffer.clear(BACK);
  const c = side / 2;
  draw(icon, c, c, side, now);
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  buffer.present(ctx, 1);
}

function draw(icon: IconName, cx: number, cy: number, s: number, now: number): void {
  switch (icon) {
    case 'deadlight':
    case 'classic':
      return deadlight(cx, cy, s, now);
    case 'hunted':
      return hunted(cx, cy, s, now);
    case 'ghost':
      return ghost(cx, cy, s, now);
    case 'assassin':
      return assassin(cx, cy, s, now);
    case 'freeze':
      return eye(cx, cy, s, now);
    case 'collapse':
      return tile(cx, cy, s, now);
    case 'rooms':
      return door(cx, cy, s, now);
    case 'sumo':
      return floe(cx, cy, s, now);
    case 'potato':
      return bomb(cx, cy, s, now);
    case 'mix':
      return mix(cx, cy, s, now);
    case 'music':
      return note(cx, cy, s, true);
    case 'muted':
      return note(cx, cy, s, false);
    case 'leave':
      return leave(cx, cy, s);
  }
}

/** DeadLight: a fighter in the dark, with its own beam. */
function deadlight(cx: number, cy: number, s: number, now: number): void {
  const r = s * 0.3;
  buffer.disc(cx, cy, r, 0x1b222c);
  buffer.ring(cx, cy, r, METAL, 0.9);
  const swing = Math.sin(now / 520) * s * 0.1;
  buffer.line(cx, cy + swing, cx + s * 0.44, cy - s * 0.1 + swing, PINK, 0.95, true);
  buffer.glow(cx + s * 0.4, cy - s * 0.1 + swing, s * 0.12, PINK, 0.7);
  buffer.disc(cx - s * 0.06, cy, Math.max(1, s * 0.09), PALE, 0.9);
}

/** Hunted: a fighter held to a path, with everyone else closing in. */
function hunted(cx: number, cy: number, s: number, now: number): void {
  const r = s * 0.3;
  buffer.line(cx - r, cy + r * 0.7, cx + r, cy + r * 0.7, METAL, 0.9);
  buffer.line(cx - r, cy + r * 0.7, cx - r, cy - r * 0.6, METAL, 0.9);
  const along = (now / 1400) % 1;
  const x = cx - r + r * 2 * along;
  buffer.disc(x, cy + r * 0.7, Math.max(1, s * 0.1), AMBER);
  buffer.ring(x, cy + r * 0.7, Math.max(2, s * 0.2), PINK, 0.8);
  buffer.disc(cx + r * 0.6, cy - r * 0.5, Math.max(1, s * 0.08), PINK, 0.9);
  buffer.disc(cx - r * 0.7, cy - r * 0.3, Math.max(1, s * 0.08), PINK, 0.9);
}

/** Ghost: there, and then not. */
function ghost(cx: number, cy: number, s: number, now: number): void {
  const fade = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(now / 700));
  const r = s * 0.26;
  const body = [
    { x: cx - r, y: cy + r },
    { x: cx - r, y: cy - r * 0.3 },
    { x: cx, y: cy - r * 1.1 },
    { x: cx + r, y: cy - r * 0.3 },
    { x: cx + r, y: cy + r },
  ];
  buffer.fillConvex(body, PALE, fade);
  buffer.polyline([...body, body[0]!], PALE, fade * 0.8);
  buffer.disc(cx - r * 0.4, cy - r * 0.25, 1, BACK, fade + 0.2);
  buffer.disc(cx + r * 0.4, cy - r * 0.25, 1, BACK, fade + 0.2);
}

/** Assassin: a name on a card, and a blade for it. */
function assassin(cx: number, cy: number, s: number, now: number): void {
  const w = s * 0.46;
  const h = s * 0.32;
  buffer.rect(cx - w / 2, cy - h / 2 + 2, w, h, PANEL);
  buffer.rect(cx - w / 2, cy - h / 2 + 2, w, h, METAL, 0.6);
  buffer.rect(cx - w / 2 + 2, cy - 2, w - 6, 1, INK, 0.9);
  buffer.rect(cx - w / 2 + 2, cy + 2, w - 10, 1, INK, 0.7);
  const slide = Math.sin(now / 800) * s * 0.06;
  buffer.line(cx + w * 0.1 + slide, cy - h, cx + w * 0.5 + slide, cy - h * 0.1, PALE, 0.95);
  buffer.line(cx + w * 0.1 + slide, cy - h * 0.9, cx + w * 0.3 + slide, cy - h * 0.5, PINK, 0.8);
}

/** Freeze: the eye, open on green and a slit on red. */
function eye(cx: number, cy: number, s: number, now: number): void {
  const beat = (now / 1800) % 1;
  const shut = beat > 0.62;
  const colour = shut ? RED : beat > 0.5 ? AMBER : GREEN;
  const rx = s * 0.4;
  const ry = s * (shut ? 0.1 : 0.25);
  const lid: { x: number; y: number }[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    lid.push({ x: cx - rx + rx * 2 * t, y: cy - Math.sin(Math.PI * t) * ry });
  }
  for (let i = 12; i >= 0; i--) {
    const t = i / 12;
    lid.push({ x: cx - rx + rx * 2 * t, y: cy + Math.sin(Math.PI * t) * ry });
  }
  buffer.fillConvex(lid, PANEL);
  buffer.polyline(lid, colour, 0.95);
  if (!shut) {
    const look = Math.sin(now / 700) * rx * 0.4;
    buffer.disc(cx + look, cy, Math.max(1, ry * 0.7), colour, 0.95);
  }
  buffer.glow(cx, cy, rx, colour, shut ? 0.6 : 0.3);
}

/** Collapse: a floor tile, cracked, with a crumb falling off it. */
function tile(cx: number, cy: number, s: number, now: number): void {
  const side = Math.round(s * 0.56);
  const x = Math.round(cx - side / 2);
  const y = Math.round(cy - side / 2) - 1;
  buffer.rect(x + 1, y + 2, side, side, BACK, 0.6);
  buffer.rect(x, y, side, side, 0x20262f);
  buffer.rect(x, y, side, 1, INK, 0.5);
  buffer.line(x + 2, y + 1, x + side * 0.6, y + side - 2, AMBER, 0.9);
  buffer.line(x + side * 0.6, y + side * 0.5, x + side - 1, y + side * 0.35, AMBER, 0.7);
  const drop = ((now / 700) % 1) * s * 0.3;
  buffer.rect(x + side * 0.4, y + side + 1 + drop, 2, 2, INK, 1 - drop / (s * 0.3));
}

/** Rooms: a door with the number called over it. */
function door(cx: number, cy: number, s: number, now: number): void {
  const w = Math.round(s * 0.42);
  const h = Math.round(s * 0.52);
  const x = Math.round(cx - w / 2);
  const y = Math.round(cy - h / 2) + 2;
  buffer.rect(x - 1, y - 1, w + 2, h + 2, METAL);
  buffer.rect(x, y, w, h, 0x1b222c);
  const swing = 0.3 + 0.18 * Math.sin(now / 760);
  const open = Math.round(w * swing);
  buffer.fillConvex(
    [
      { x, y },
      { x: x + open, y: y + 2 },
      { x: x + open, y: y + h - 2 },
      { x, y: y + h },
    ],
    AMBER,
    0.85,
  );
  const count = (Math.floor(now / 900) % 3) + 2;
  buffer.text(String(count), cx - 1, y - 7, PALE, 1);
}

/** Sumo: a floe with a bite out of it. */
function floe(cx: number, cy: number, s: number, now: number): void {
  const r = s * 0.36;
  const points: { x: number; y: number }[] = [];
  const bite = Math.floor(now / 900) % 6;
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI * 2) / 6 - Math.PI / 2;
    const reach = i === bite ? r * 0.55 : r;
    points.push({ x: cx + Math.cos(a) * reach, y: cy + Math.sin(a) * reach });
  }
  buffer.fillConvex(points, ICE, 0.9);
  buffer.polyline([...points, points[0]!], PALE, 0.8);
  buffer.disc(cx + r * 0.3, cy - r * 0.2, Math.max(1, s * 0.07), PINK, 0.9);
  buffer.disc(cx - r * 0.3, cy + r * 0.15, Math.max(1, s * 0.07), AMBER, 0.9);
}

/** Hot potato: a bomb with a lit fuse. */
function bomb(cx: number, cy: number, s: number, now: number): void {
  const r = s * 0.27;
  const y = cy + s * 0.06;
  buffer.disc(cx, y, r + 1, BACK, 0.6);
  buffer.disc(cx, y, r, 0x2b2f38);
  buffer.ring(cx, y, r, METAL, 0.8);
  buffer.disc(cx - r * 0.35, y - r * 0.35, Math.max(1, r * 0.25), PALE, 0.7);
  buffer.rect(cx - 1, y - r - 2, 2, 2, METAL);
  const flick = Math.sin(now / 90) * 1;
  buffer.line(cx, y - r - 2, cx + 2 + flick, y - r - 5, INK, 0.9);
  buffer.glow(cx + 2 + flick, y - r - 5, s * 0.14, AMBER, 0.9);
  buffer.disc(cx + 2 + flick, y - r - 5, 1, PALE);
}

/** Mix: a different game every round, so the icon cycles through them. */
function mix(cx: number, cy: number, s: number, now: number): void {
  const order: GameId[] = GAME_IDS.filter((g): g is GameId => g !== 'deadlight');
  const which = order[Math.floor(now / 1200) % order.length]!;
  draw(which, cx, cy, s * 0.9, now);
  buffer.rect(cx - s * 0.45, cy + s * 0.34, s * 0.9, 1, AMBER, 0.8);
}

/** The music button. */
function note(cx: number, cy: number, s: number, on: boolean): void {
  const colour = on ? AMBER : METAL;
  buffer.rect(cx - 1, cy - s * 0.3, 2, s * 0.44, colour);
  buffer.rect(cx - 1, cy - s * 0.3, s * 0.26, 2, colour);
  buffer.disc(cx - s * 0.12, cy + s * 0.16, Math.max(1, s * 0.11), colour);
  if (on) return;
  buffer.line(cx - s * 0.34, cy - s * 0.34, cx + s * 0.34, cy + s * 0.34, RED, 0.95);
}

/** The leave button: a door and a way out of it. */
function leave(cx: number, cy: number, s: number): void {
  const w = s * 0.3;
  const h = s * 0.46;
  buffer.rect(cx - w, cy - h / 2, w, h, METAL, 0.9);
  buffer.rect(cx - w + 1, cy - h / 2 + 1, w - 2, h - 2, PANEL);
  buffer.line(cx - 1, cy, cx + w * 0.9, cy, PALE, 0.95);
  buffer.line(cx + w * 0.3, cy - w * 0.4, cx + w * 0.9, cy, PALE, 0.95);
  buffer.line(cx + w * 0.3, cy + w * 0.4, cx + w * 0.9, cy, PALE, 0.95);
}
