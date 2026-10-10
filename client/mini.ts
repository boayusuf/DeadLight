import { PLAYER_RADIUS } from '../shared/constants.js';
import {
  COLLAPSE_COLS,
  COLLAPSE_ROWS,
  COLLAPSE_WORLD,
  FALL_MS,
  TILE,
  TILE_BREAKING,
  TILE_CRACKING,
  TILE_GONE,
} from '../shared/collapse.js';
import { GAME_NAMES, GAME_VIEW, type MiniGameId } from '../shared/games.js';
import { FREEZE_FINISH_Y, FREEZE_WORLD, ZAP_MS } from '../shared/freeze.js';
import { POTATO_PILLARS, POTATO_WORLD, FUSE_MS } from '../shared/potato.js';
import type { MiniExtra, MiniPlayer } from '../shared/protocol.js';
import {
  DANCE_RADIUS,
  FLOOR_RADIUS,
  ROOM_ANGLES,
  ROOM_COUNT,
  ROOM_SPAN,
  fromRoom,
} from '../shared/rooms.js';
import { FLOE_SEGMENTS, SEGMENT_ARC, SUMO_FALL_MS } from '../shared/sumo.js';
import { GLYPH_H } from './font.js';
import { PixelBuffer } from './pixel.js';
import { SPRITE_H, SPRITE_W, facingFor, sprite, type Sprite } from './sprites.js';

/** World units per buffer pixel, the same grid the dark game is drawn on. */
const UNITS_PER_PX = 4;

const BACK = 0x0c0f14;
const FLOOR = 0x1b2029;
const FLOOR_ALT = 0x20262f;
const WALL_C = 0x39424f;
const LINE = 0x7f8b9c;
const INK = 0x9aa6b8;
const PALE = 0xccd6e2;
const WARN = 0xc9a23c;
const DANGER = 0xd8433f;
const SAFE = 0x56a86b;
const ICE = 0x6f93b8;
const ICE_ALT = 0x5c82a6;
const ICE_DEEP = 0x101b26;
const EYE_GREEN = 0x56a86b;
const EYE_WARN = 0xc9a23c;
const EYE_RED = 0xd8433f;
const BOMB = 0x2b2f38;

/** What the renderer needs to know about who is who. */
export interface MiniRoster {
  color: number;
  name: string;
  /** Which of the ten fighter designs this colour wears. */
  archetype: number;
}

export interface MiniScene {
  kind: MiniGameId;
  round: number;
  left: number;
  players: MiniPlayer[];
  scores: Record<string, number>;
  extra: MiniExtra;
  /** Where the session is up to, for the corner of the HUD. */
  label: string;
  selfId: string;
  roster: Map<string, MiniRoster>;
  /** The local fighter's predicted position, which leads the server's by a tick. */
  self: { x: number; y: number; aim: number } | null;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * The lit games, drawn.
 *
 * Each one has its own floor and its own thing to show — an eye at the end of a
 * corridor, a tile about to go, a locked door, a crack in the ice, a fuse — so
 * this draws the arena, then the fighters, then the one number that matters.
 * The dark game keeps its own renderer; nothing here touches it.
 */
export class MiniRenderer {
  private readonly buffer = new PixelBuffer();
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private view = { w: 1200, h: 1200 };
  /** Camera offset in world units; only the long corridor ever moves it. */
  private camera = { x: 0, y: 0 };
  /** Where each fighter was last seen standing, for the walk cycle. */
  private readonly steps = new Map<string, { x: number; y: number; at: number }>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable.');
    this.ctx = ctx;
    this.layout();
    addEventListener('resize', () => this.layout());
  }

  /** Each game is framed to its own arena. */
  configure(kind: MiniGameId): void {
    this.view = GAME_VIEW[kind];
    this.layout();
  }

  private layout(): void {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const deviceW = Math.round(innerWidth * dpr);
    const deviceH = Math.round(innerHeight * dpr);
    const fit = Math.min(
      deviceW / ((this.view.w / UNITS_PER_PX) * 1.06),
      deviceH / ((this.view.h / UNITS_PER_PX) * 1.22),
    );
    this.scale = Math.max(1, Math.floor(fit));
    const width = Math.ceil(deviceW / this.scale);
    const height = Math.ceil(deviceH / this.scale);
    this.buffer.resize(width, height);
    this.canvas.width = width * this.scale;
    this.canvas.height = height * this.scale;
    this.canvas.style.width = `${(width * this.scale) / dpr}px`;
    this.canvas.style.height = `${(height * this.scale) / dpr}px`;
  }

  private px(wx: number): number {
    return Math.round(this.buffer.width / 2 + (wx - this.camera.x) / UNITS_PER_PX);
  }

  private py(wy: number): number {
    return Math.round(this.buffer.height / 2 + (wy - this.camera.y) / UNITS_PER_PX);
  }

  private units(value: number): number {
    return value / UNITS_PER_PX;
  }

  /** Where a screen point lands in the world, for aiming. */
  worldFromScreen(sx: number, sy: number): { x: number; y: number } {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const px = (sx * dpr) / this.scale;
    const py = (sy * dpr) / this.scale;
    return {
      x: (px - this.buffer.width / 2) * UNITS_PER_PX + this.camera.x,
      y: (py - this.buffer.height / 2) * UNITS_PER_PX + this.camera.y,
    };
  }

  frame(scene: MiniScene, now: number): void {
    this.buffer.clear(BACK);
    this.follow(scene);

    switch (scene.extra.kind) {
      case 'freeze':
        this.freeze(scene, scene.extra, now);
        break;
      case 'collapse':
        this.collapse(scene, scene.extra, now);
        break;
      case 'rooms':
        this.rooms(scene, scene.extra, now);
        break;
      case 'sumo':
        this.sumo(scene, scene.extra, now);
        break;
      case 'potato':
        this.potato(scene, scene.extra, now);
        break;
    }

    this.fighters(scene, now);
    this.hud(scene);
    this.buffer.present(this.ctx, this.scale);
  }

  /** Only Freeze is longer than the screen, so only Freeze scrolls. */
  private follow(scene: MiniScene): void {
    if (scene.kind !== 'freeze') {
      this.camera = { x: 0, y: 0 };
      return;
    }
    const me = scene.self ?? scene.players.find((p) => p.id === scene.selfId);
    const room = (FREEZE_WORLD.h - this.view.h) / 2;
    const y = me ? Math.max(-room, Math.min(room, me.y)) : 0;
    this.camera = { x: 0, y };
  }

  // --- Freeze -----------------------------------------------------------------

  private freeze(scene: MiniScene, extra: Extract<MiniExtra, { kind: 'freeze' }>, now: number): void {
    const b = this.buffer;
    const left = this.px(-FREEZE_WORLD.w / 2);
    const right = this.px(FREEZE_WORLD.w / 2);
    const top = this.py(-FREEZE_WORLD.h / 2);
    const bottom = this.py(FREEZE_WORLD.h / 2);
    b.rect(left, top, right - left, bottom - top, FLOOR);

    // Rungs up the corridor, so the run reads as distance covered.
    for (let y = -FREEZE_WORLD.h / 2; y < FREEZE_WORLD.h / 2; y += 200) {
      b.rect(left, this.py(y), right - left, 1, FLOOR_ALT);
    }
    b.rect(left - 2, top, 2, bottom - top, WALL_C);
    b.rect(right, top, 2, bottom - top, WALL_C);

    const line = this.py(FREEZE_FINISH_Y);
    for (let x = left; x < right; x += 8) b.rect(x, line - 1, 4, 2, PALE, 0.9);
    b.text('HOME', left + 6, line + 5, PALE, 0.7);

    this.eye(extra.light, now);

    for (const zap of extra.zaps) {
      const age = clamp01((now - zap.at) / (ZAP_MS * 3));
      const p = scene.players.find((x) => x.id === zap.id);
      if (!p || age >= 1) continue;
      const x = this.px(p.x);
      const y = this.py(p.y);
      b.line(x, this.py(FREEZE_FINISH_Y + 420), x, y, EYE_RED, 1 - age, true);
      b.glow(x, y, this.units(90) * (1 - age), EYE_RED, 0.8);
    }
  }

  /** The eye above the line: wide open on green, a slit on red. */
  private eye(light: Extract<MiniExtra, { kind: 'freeze' }>['light'], now: number): void {
    const b = this.buffer;
    const cx = this.px(0);
    const cy = this.py(FREEZE_FINISH_Y + 420);
    const color = light === 'green' ? EYE_GREEN : light === 'turning' ? EYE_WARN : EYE_RED;
    const open = light === 'red' ? 0.35 : light === 'turning' ? 0.7 : 1;
    const rx = this.units(170);
    const ry = this.units(90) * open;

    const lid: { x: number; y: number }[] = [];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18;
      lid.push({ x: cx - rx + rx * 2 * t, y: cy - Math.sin(Math.PI * t) * ry });
    }
    for (let i = 18; i >= 0; i--) {
      const t = i / 18;
      lid.push({ x: cx - rx + rx * 2 * t, y: cy + Math.sin(Math.PI * t) * ry });
    }
    b.fillConvex(lid, 0x0f1319);
    b.polyline(lid, color, 0.95);
    const swing = light === 'green' ? Math.sin(now / 650) * rx * 0.3 : 0;
    b.disc(cx + swing, cy, Math.max(2, ry * 0.6), color, 0.9);
    b.disc(cx + swing, cy, Math.max(1, ry * 0.25), BACK);
    b.glow(cx, cy, rx, color, light === 'red' ? 0.6 : 0.3);
  }

  // --- Collapse ---------------------------------------------------------------

  private collapse(
    scene: MiniScene,
    extra: Extract<MiniExtra, { kind: 'collapse' }>,
    now: number,
  ): void {
    const b = this.buffer;
    const size = this.units(TILE);
    for (let row = 0; row < COLLAPSE_ROWS; row++) {
      for (let col = 0; col < COLLAPSE_COLS; col++) {
        const index = row * COLLAPSE_COLS + col;
        const state = extra.tiles[index];
        if (state === TILE_GONE) continue;
        const x = this.px(-COLLAPSE_WORLD.w / 2 + col * TILE);
        const y = this.py(-COLLAPSE_WORLD.h / 2 + row * TILE);
        const w = Math.max(1, Math.round(size) - 1);
        const shade = (col + row) % 2 === 0 ? FLOOR : FLOOR_ALT;
        b.rect(x, y, w, w, shade);
        if (state === TILE_CRACKING) {
          b.rect(x, y, w, w, WARN, 0.2);
          b.line(x + 2, y + 2, x + w - 2, y + w - 2, WARN, 0.8);
        } else if (state === TILE_BREAKING) {
          const shiver = Math.sin(now / 55 + index) * 1;
          b.rect(x, y + shiver, w, w, DANGER, 0.3);
          b.line(x + 1, y + w / 2 + shiver, x + w - 1, y + 2 + shiver, DANGER, 0.9);
          b.line(x + w / 2, y + 1 + shiver, x + w / 2 + 3, y + w - 1 + shiver, DANGER, 0.9);
        }
        b.rect(x, y, w, 1, PALE, 0.08);
      }
    }

    for (const fall of extra.falls) {
      const age = clamp01((now - fall.at) / FALL_MS);
      if (age >= 1) continue;
      const colour = scene.roster.get(fall.id)?.color ?? PALE;
      const drop = age * this.units(140);
      b.disc(this.px(fall.x), this.py(fall.y) + drop, Math.max(1, this.units(PLAYER_RADIUS) * (1 - age)), colour, 1 - age);
    }
  }

  // --- Rooms ------------------------------------------------------------------

  private rooms(scene: MiniScene, extra: Extract<MiniExtra, { kind: 'rooms' }>, now: number): void {
    const b = this.buffer;
    const cx = this.px(0);
    const cy = this.py(0);

    b.disc(cx, cy, this.units(FLOOR_RADIUS), FLOOR);
    b.ring(cx, cy, this.units(FLOOR_RADIUS), WALL_C, 0.9);

    // The middle turns while the music plays; the pattern shows which way.
    const spin = extra.phase === 'music' ? now / 1000 : 0;
    b.disc(cx, cy, this.units(DANCE_RADIUS), FLOOR_ALT);
    for (let i = 0; i < 8; i++) {
      const a = spin + (i * Math.PI * 2) / 8;
      b.line(
        cx + Math.cos(a) * this.units(DANCE_RADIUS) * 0.3,
        cy + Math.sin(a) * this.units(DANCE_RADIUS) * 0.3,
        cx + Math.cos(a) * this.units(DANCE_RADIUS),
        cy + Math.sin(a) * this.units(DANCE_RADIUS),
        extra.phase === 'music' ? WARN : LINE,
        0.5,
      );
    }

    for (let i = 0; i < ROOM_COUNT; i++) {
      const room = extra.rooms[i];
      if (!room) continue;
      const corners = [
        fromRoom(i, ROOM_SPAN.at, -ROOM_SPAN.halfHeight),
        fromRoom(i, ROOM_SPAN.at + ROOM_SPAN.depth, -ROOM_SPAN.halfHeight),
        fromRoom(i, ROOM_SPAN.at + ROOM_SPAN.depth, ROOM_SPAN.halfHeight),
        fromRoom(i, ROOM_SPAN.at, ROOM_SPAN.halfHeight),
      ].map((p) => ({ x: this.px(p.x), y: this.py(p.y) }));

      const judged = room.outcome === 'ok' ? SAFE : room.outcome === 'wrong' ? DANGER : null;
      b.fillConvex(corners, judged ?? FLOOR, judged ? 0.45 : 1);
      b.polyline([...corners, corners[0]!], room.locked ? WALL_C : LINE, 0.9);

      // The doorway: a gap in the wall while it is open, a slab once locked.
      const door = [
        fromRoom(i, ROOM_SPAN.at, -ROOM_SPAN.doorHalfHeight),
        fromRoom(i, ROOM_SPAN.at, ROOM_SPAN.doorHalfHeight),
      ].map((p) => ({ x: this.px(p.x), y: this.py(p.y) }));
      b.line(door[0]!.x, door[0]!.y, door[1]!.x, door[1]!.y, room.open ? FLOOR : WARN, room.open ? 0.35 : 1);
      if (!room.open) {
        const a = ROOM_ANGLES[i]!;
        b.line(
          door[0]!.x + a.cos * 2,
          door[0]!.y + a.sin * 2,
          door[1]!.x + a.cos * 2,
          door[1]!.y + a.sin * 2,
          WARN,
          0.6,
        );
      }
    }

    if (extra.target !== null) {
      const text = String(extra.target);
      const scale = 3;
      const w = b.textWidth(text, scale);
      b.rect(cx - w / 2 - 4, cy - (GLYPH_H * scale) / 2 - 3, w + 8, GLYPH_H * scale + 6, BACK, 0.8);
      b.text(text, Math.round(cx - w / 2), Math.round(cy - (GLYPH_H * scale) / 2), PALE, 1, scale);
    }
  }

  // --- Sumo -------------------------------------------------------------------

  private sumo(scene: MiniScene, extra: Extract<MiniExtra, { kind: 'sumo' }>, now: number): void {
    const b = this.buffer;
    const cx = this.px(0);
    const cy = this.py(0);
    b.disc(cx, cy, this.units(Math.max(...extra.floe)) + 3, ICE_DEEP);

    // Each wedge is drawn to its own reach, so a bitten-back arc is obvious.
    for (let i = 0; i < FLOE_SEGMENTS; i++) {
      const reach = this.units(extra.floe[i] ?? 0);
      const a0 = i * SEGMENT_ARC;
      const a1 = a0 + SEGMENT_ARC;
      const wedge = [
        { x: cx, y: cy },
        { x: cx + Math.cos(a0) * reach, y: cy + Math.sin(a0) * reach },
        { x: cx + Math.cos((a0 + a1) / 2) * reach, y: cy + Math.sin((a0 + a1) / 2) * reach },
        { x: cx + Math.cos(a1) * reach, y: cy + Math.sin(a1) * reach },
      ];
      b.fillConvex(wedge, i % 2 === 0 ? ICE : ICE_ALT, 1);
    }

    for (const crack of extra.cracking) {
      const warn = clamp01(1 - crack.in / 1600);
      for (let k = 0; k < crack.n; k++) {
        const segment = (crack.s + k) % FLOE_SEGMENTS;
        const from = this.units(crack.to[k] ?? 0);
        const to = this.units(extra.floe[segment] ?? 0);
        const a = (segment + 0.5) * SEGMENT_ARC;
        b.line(
          cx + Math.cos(a) * from,
          cy + Math.sin(a) * from,
          cx + Math.cos(a) * to,
          cy + Math.sin(a) * to,
          DANGER,
          0.3 + warn * 0.6,
        );
      }
    }

    for (const fall of extra.falls) {
      const age = clamp01((now - fall.at) / SUMO_FALL_MS);
      if (age >= 1) continue;
      const colour = scene.roster.get(fall.id)?.color ?? PALE;
      b.ring(this.px(fall.x), this.py(fall.y), this.units(PLAYER_RADIUS) * (1 + age * 2), colour, 1 - age);
    }

    for (const hit of extra.hits) {
      const age = clamp01((now - hit.at) / 260);
      if (age >= 1) continue;
      const a = scene.players.find((p) => p.id === hit.a);
      const bb = scene.players.find((p) => p.id === hit.b);
      if (!a || !bb) continue;
      b.glow(this.px((a.x + bb.x) / 2), this.py((a.y + bb.y) / 2), this.units(70) * (1 - age), PALE, 0.7);
    }
  }

  // --- Hot potato -------------------------------------------------------------

  private potato(scene: MiniScene, extra: Extract<MiniExtra, { kind: 'potato' }>, now: number): void {
    const b = this.buffer;
    const left = this.px(-POTATO_WORLD.w / 2);
    const top = this.py(-POTATO_WORLD.h / 2);
    const side = Math.round(this.units(POTATO_WORLD.w));
    b.rect(left, top, side, side, FLOOR);
    for (let i = 0; i < side; i += 12) {
      b.rect(left, top + i, side, 1, FLOOR_ALT);
    }
    b.rect(left - 2, top - 2, side + 4, 2, WALL_C);
    b.rect(left - 2, top + side, side + 4, 2, WALL_C);
    b.rect(left - 2, top, 2, side, WALL_C);
    b.rect(left + side, top, 2, side, WALL_C);

    for (const pillar of POTATO_PILLARS) {
      const x = this.px(pillar.x);
      const y = this.py(pillar.y);
      b.disc(x, y + 2, this.units(pillar.r), BACK, 0.5);
      b.disc(x, y, this.units(pillar.r), WALL_C);
      b.ring(x, y, this.units(pillar.r), LINE, 0.8);
    }

    // The fuse: a ring that closes on whoever is holding it.
    extra.holders.forEach((id, i) => {
      const p = scene.players.find((x) => x.id === id);
      if (!p) return;
      const heat = clamp01((extra.heat[i] ?? 0) / FUSE_MS);
      const x = this.px(p.x);
      const y = this.py(p.y);
      const r = this.units(PLAYER_RADIUS) + 4;
      b.ring(x, y, r + 2, mixHeat(heat), 0.9);
      b.disc(x, y - r - 3, 2, BOMB);
      b.glow(x, y, r * (1.4 + heat), mixHeat(heat), 0.3 + heat * 0.5);
      if (Math.floor(now / Math.max(90, 320 - heat * 240)) % 2 === 0) {
        b.disc(x, y - r - 5, 1, WARN);
      }
    });

    for (const pass of extra.passes) {
      const age = clamp01((now - pass.at) / 320);
      if (age >= 1) continue;
      const from = scene.players.find((p) => p.id === pass.from);
      const to = scene.players.find((p) => p.id === pass.to);
      if (!from || !to) continue;
      b.line(this.px(from.x), this.py(from.y), this.px(to.x), this.py(to.y), WARN, 1 - age, true);
    }

    for (const boom of extra.booms) {
      const age = clamp01((now - boom.at) / 600);
      if (age >= 1) continue;
      const p = scene.players.find((x) => x.id === boom.id);
      if (!p) continue;
      b.glow(this.px(p.x), this.py(p.y), this.units(180) * age, DANGER, 1 - age);
      b.ring(this.px(p.x), this.py(p.y), this.units(60) + age * this.units(160), WARN, 1 - age);
    }
  }

  // --- Fighters and HUD -------------------------------------------------------

  private fighters(scene: MiniScene, now: number): void {
    const b = this.buffer;
    const dashing = dashingIn(scene.extra);
    // Back to front, so a fighter lower down the floor overlaps the one behind.
    const order = [...scene.players].sort((p, q) => p.y - q.y);
    for (const p of order) {
      if (p.state === 'out') continue;
      const own = p.id === scene.selfId;
      const at = own && scene.self ? scene.self : p;
      const who = scene.roster.get(p.id);
      const colour = who?.color ?? PALE;
      const x = this.px(at.x);
      const y = this.py(at.y);

      if (dashing.has(p.id)) b.glow(x, y, this.units(PLAYER_RADIUS) * 2.2, colour, 0.5);
      // A soft shadow keeps everyone standing on the floor rather than over it.
      b.disc(x, y + 2, Math.max(2, this.units(PLAYER_RADIUS) * 0.8), BACK, 0.45);

      const walking = this.walking(p.id, at, now);
      const { facing, flip } = facingFor(at.aim ?? 0);
      const frame = walking ? Math.floor(now / 110) % 4 : 0;
      const art = sprite(facing, frame, who?.archetype ?? 0, colour);
      this.blit(art, x - (SPRITE_W >> 1), y - SPRITE_H + 4, flip, own ? colour : undefined);
    }
  }

  /** Whether a fighter has moved lately, for the walk cycle. */
  private walking(id: string, at: { x: number; y: number }, now: number): boolean {
    const was = this.steps.get(id);
    const moved = was ? Math.hypot(at.x - was.x, at.y - was.y) > 0.6 : false;
    if (!was || moved) this.steps.set(id, { x: at.x, y: at.y, at: now });
    return moved || (was !== undefined && now - was.at < 160);
  }

  /** One sprite, with an optional rim so a player can find themselves. */
  private blit(art: Sprite, left: number, top: number, flip: boolean, rim?: number): void {
    const b = this.buffer;
    const at = (x: number, y: number): number => {
      if (x < 0 || y < 0 || x >= art.width || y >= art.height) return -1;
      return art.pixels[y * art.width + (flip ? art.width - 1 - x : x)]!;
    };
    for (let y = 0; y < art.height; y++) {
      for (let x = 0; x < art.width; x++) {
        const colour = at(x, y);
        if (colour < 0) {
          if (rim === undefined) continue;
          const touching = at(x - 1, y) >= 0 || at(x + 1, y) >= 0 || at(x, y - 1) >= 0 || at(x, y + 1) >= 0;
          if (touching) b.add(left + x, top + y, rim, 0.5);
          continue;
        }
        b.blend(left + x, top + y, colour, 1);
      }
    }
  }

  private hud(scene: MiniScene): void {
    const b = this.buffer;
    const name = GAME_NAMES[scene.kind].toUpperCase();
    b.text(name, 6, 5, PALE, 0.9);

    const standing = scene.players.filter((p) => p.state === 'alive').length;
    const right = `${standing} LEFT`;
    b.text(right, b.width - 6 - b.textWidth(right), 5, PALE, 0.9);
    if (scene.label) {
      b.text(scene.label, Math.round((b.width - b.textWidth(scene.label)) / 2), 5, INK, 0.9);
    }

    const note = this.caption(scene);
    if (note) {
      const w = b.textWidth(note, 2);
      b.text(note, Math.round((b.width - w) / 2), 14, PALE, 0.95, 2);
    }

    const seconds = Math.ceil(scene.left / 1000);
    if (seconds > 0 && seconds <= 9) {
      const text = String(seconds);
      const w = b.textWidth(text, 2);
      b.text(text, Math.round((b.width - w) / 2), b.height - GLYPH_H * 2 - 6, WARN, 0.9, 2);
    }

    const mine = scene.scores[scene.selfId] ?? 0;
    if (mine > 0) b.text(`${mine}`, 6, b.height - GLYPH_H - 5, WARN, 0.9);
  }

  /** The one line that says what to do right now. */
  private caption(scene: MiniScene): string | null {
    const extra = scene.extra;
    switch (extra.kind) {
      case 'freeze':
        return extra.light === 'green' ? 'RUN' : extra.light === 'turning' ? 'STOP' : 'DO NOT MOVE';
      case 'collapse':
        return 'THE FLOOR IS GOING';
      case 'rooms':
        if (extra.phase === 'music') return 'DANCE';
        if (extra.phase === 'announce') return `ROOMS OF ${extra.target ?? ''}`.trim();
        if (extra.phase === 'count') return `GET IN A ROOM OF ${extra.target ?? ''}`.trim();
        return 'DOORS LOCKED';
      case 'sumo':
        return extra.cracking.length > 0 ? 'ICE CRACKING' : 'SHOVE THEM OFF';
      case 'potato':
        return extra.holders.includes(scene.selfId) ? 'PASS IT ON' : 'KEEP AWAY';
    }
  }
}

/** Fuse colour, cool to hot. */
function mixHeat(heat: number): number {
  return heat > 0.75 ? DANGER : heat > 0.4 ? WARN : LINE;
}

/** Whoever is mid-dash, whichever game it is. */
function dashingIn(extra: MiniExtra): Set<string> {
  if (extra.kind === 'collapse' || extra.kind === 'potato' || extra.kind === 'sumo') {
    return new Set(extra.dashing);
  }
  return new Set();
}
