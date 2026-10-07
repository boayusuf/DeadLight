import { arenaVertices, clampToArena, rayToWall } from '../shared/arena.js';
import { traceBeam, type World } from '../shared/maps.js';
import {
  BARREL_LENGTH,
  PLAYER_RADIUS,
  RESOLVE_DELAY_MS,
  SHRINK_ANIM_MS,
  SHRINK_WARN_MS,
  SIGHT_RADIUS,
  STAGE_COUNT,
  STAGE_SCALE,
} from '../shared/constants.js';
import type { FinisherId } from '../shared/constants.js';
import type { ReplayTrack, ServerMessage, SnapshotPlayer } from '../shared/protocol.js';
import type { Resolution } from '../shared/resolve.js';
import { killerOf } from './callouts.js';
import { Finishers, type FinisherView } from './finishers.js';
import {
  KILLCAM_BEATS,
  KILLCAM_SLOWMO,
  beatAt,
  frameAround,
  poseAt,
  type Framing,
  type KillcamBeat,
} from './killcam.js';
import { drawFinale, drawKillscreen, Splats, type Portrait } from './killscreen.js';
import {
  drawFloorObstacles,
  drawSolidObstacles,
  ObstacleFx,
  type Crate,
  type Lighting,
} from './obstacles.js';
import { ambientAt } from './lighting.js';
import { PixelBuffer } from './pixel.js';
import { SPRITE_H, SPRITE_W, facingFor, sprite, type Sprite } from './sprites.js';

type Lights = Extract<ServerMessage, { t: 'lights' }>;

export interface Fighter {
  name: string;
  color: number;
  archetype: number;
  finisher: FinisherId;
}

/** The match-ending round, replayed. Starts the moment its lights arrive. */
export interface Killcam {
  startedAt: number;
  lights: Lights;
  /** The room as it stood during the replayed blackout, before this round broke anything. */
  world: World;
  /** Set once the finishers have gone off, so they spawn exactly once. */
  spawned: boolean;
  frames?: KillcamFrames;
}

interface KillcamFrames {
  wide: Framing;
  tight: Framing;
  punch: Framing;
}

export interface Trace {
  ox: number;
  oy: number;
  ex: number;
  ey: number;
}

export interface Scene {
  selfId: string;
  roster: Map<string, Fighter>;
  baseSize: number;
  phase: 'lights' | 'dark';
  lights: Lights | null;
  lightsAt: number;
  darkAt: number;
  darkEndsAt: number;
  /** Null while spectating: a living client only ever knows where it is itself. */
  self: { x: number; y: number; aim: number } | null;
  watch: SnapshotPlayer[];
  scorches: Trace[];
  spectating: boolean;
  inMatch: boolean;
  /** Two fighters left: the room runs on emergency light until the end. */
  showdown: boolean;
  killcam: Killcam | null;
  /** The map and its state, as of the last lights. */
  world: World;
}

/* ---------------------------------------------------------------------------
 * Palette: a cold, decommissioned facility. Greys and steel carry the room,
 * amber is reserved for warnings, and saturated colour belongs to the fighters
 * and their beams so the eye always finds them first.
 * ------------------------------------------------------------------------ */
const VOID = 0x0b0d12;
const DEAD_FLOOR = 0x171b22;
const DEAD_SEAM = 0x10141a;
const FLOOR_A = 0x323c49;
const FLOOR_B = 0x2a333e;
const SEAM = 0x1e252d;
const PANEL_LIP = 0x44505f;
const METAL = 0x47525f;
const METAL_LIGHT = 0x6e7b8c;
const METAL_DARK = 0x1b2026;
const PILLAR_FACE = 0x2b323c;
const PILLAR_LIGHT = 0x3e4855;
const PILLAR_DARK = 0x171b21;
const AMBER = 0xd9953a;
const AMBER_DIM = 0x7a5320;
const EMERGENCY = 0x8f2420;
const KILLCAM_RED = 0xd8433f;
const NIGHT = 0x05070b;
const EMITTER = 0x7fc9b0;
const PALE = 0xccd6e2;
const INK = 0x79849a;

/**
 * One muted tint per stage band, outermost first. Each shrink
 * switches the outer colour off, so the floor itself shows how far the match
 * has gone and where it will close next. Kept low in saturation so the
 * fighters stay the brightest thing in the room.
 */
const RING_TINTS = [0x2c6e6a, 0x7a3a2c, 0x5f6a2c, 0x3b4a7e, 0x6e5a3a] as const;
const RING_MIX = 0.3;

const PANEL = 14;
const DEATH_FADE_MS = 460;
const BEAM_FADE_MS = 320;
const MATERIALIZE_MS = 150;
const FLASH_MS = 110;
const MARKER_MS = 2400;
const IMPACT_MARK_MS = 1600;
const WALK_FRAME_MS = 120;
const SPRITE_FOOT = 8;
const MUZZLE_LIFT = 2;
const UNITS_PER_PX = 4;

/** A beat of stillness on the killing hit, before anything goes off. */
export const HIT_STOP_MS = 70;
const CALLOUT_MS = 900;
export const INTRO_MS = 1100;
const FEED_MS = 5000;
const FEED_MAX = 4;
const LETTERBOX = 0.12;
const SPEED_LABEL: Record<KillcamBeat, string> = {
  intro: '<<',
  replay: '1.6X',
  shot: '0.2X',
  freeze: 'HOLD',
  cutin: '!!',
  boom: '0.5X',
  finale: 'END',
};
/** When the finisher goes off, ms into the killcam; its slowed clock starts here. */
const BOOM_AT = KILLCAM_BEATS.slice(0, KILLCAM_BEATS.findIndex(([beat]) => beat === 'boom')).reduce(
  (sum, [, ms]) => sum + ms,
  0,
);

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;
const between = (a: Framing, b: Framing, t: number): Framing => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  zoom: lerp(a.zoom, b.zoom, t),
});

function mix(a: number, b: number, t: number): number {
  const r = lerp((a >> 16) & 0xff, (b >> 16) & 0xff, t);
  const g = lerp((a >> 8) & 0xff, (b >> 8) & 0xff, t);
  const bl = lerp(a & 0xff, b & 0xff, t);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  ttl: number;
  color: number;
}

interface Marker {
  x: number;
  y: number;
  aim: number;
  color: number;
  archetype: number;
  born: number;
}

interface Impact {
  x: number;
  y: number;
  color: number;
  born: number;
}

interface Callout {
  title: string;
  by: string | null;
  color: number;
  born: number;
}

interface FeedEntry {
  killer: Fighter;
  victim: Fighter;
  born: number;
}

export class Renderer {
  private readonly buffer = new PixelBuffer();
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private baseSize = 900;

  /** Floor colours per band, as [even, odd] panels, mixed once up front. */
  private readonly ringFloor = RING_TINTS.map((tint) => [
    mix(FLOOR_B, tint, RING_MIX),
    mix(FLOOR_A, tint, RING_MIX),
  ]);

  private particles: Particle[] = [];
  private markers: Marker[] = [];
  private impacts: Impact[] = [];
  private flashAt = -1;
  private shake = 0;
  private moving = false;
  private impactedRound = -1;

  private readonly finishers = new Finishers();
  /** The killcam runs its finishers on a slowed clock, so they get their own set. */
  private readonly replayFinishers = new Finishers();
  private readonly splats = new Splats();
  private readonly obstacleFx = new ObstacleFx();
  private readonly view: FinisherView = {
    buffer: this.buffer,
    px: (wx) => this.px(wx),
    py: (wy) => this.py(wy),
  };
  private callout: Callout | null = null;
  private intro: { a: Fighter; b: Fighter; born: number } | null = null;
  private feed: FeedEntry[] = [];
  private holdUntil = 0;
  /** This frame's shake, so the crisp-text layer can follow the world. */
  private shift = { x: 0, y: 0 };

  /** Row spans of the octagon, rebuilt whenever the size changes. */
  private spanSize = -1;
  private spanTop = 0;
  private spans: Int32Array = new Int32Array(0);

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable.');
    this.ctx = ctx;
    this.layout();
    addEventListener('resize', () => this.layout());
  }

  configure(baseSize: number): void {
    this.baseSize = baseSize;
    this.layout();
  }

  private layout(): void {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const deviceW = Math.round(innerWidth * dpr);
    const deviceH = Math.round(innerHeight * dpr);
    // The HUD sits above and below the arena, so only the height needs room for
    // it. Fitting the two separately lets a portrait phone use its full width.
    const arenaPx = this.baseSize / UNITS_PER_PX;
    const fit = Math.min(deviceW / (arenaPx * 1.06), deviceH / (arenaPx * 1.3));
    this.scale = Math.max(1, Math.floor(fit));
    const width = Math.ceil(deviceW / this.scale);
    const height = Math.ceil(deviceH / this.scale);
    this.buffer.resize(width, height);
    this.spanSize = -1;

    this.canvas.width = width * this.scale;
    this.canvas.height = height * this.scale;
    this.canvas.style.width = `${(width * this.scale) / dpr}px`;
    this.canvas.style.height = `${(height * this.scale) / dpr}px`;
  }

  worldFromScreen(sx: number, sy: number): { x: number; y: number } {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const px = (sx * dpr) / this.scale;
    const py = (sy * dpr) / this.scale;
    return {
      x: (px - this.buffer.width / 2) * UNITS_PER_PX,
      y: (py - this.buffer.height / 2) * UNITS_PER_PX,
    };
  }

  private px(wx: number): number {
    return Math.round(this.buffer.width / 2 + wx / UNITS_PER_PX);
  }

  private py(wy: number): number {
    return Math.round(this.buffer.height / 2 + wy / UNITS_PER_PX);
  }

  private units(value: number): number {
    return value / UNITS_PER_PX;
  }

  setMoving(moving: boolean): void {
    this.moving = moving;
  }

  reveal(now: number): void {
    this.flashAt = now;
  }

  /** Two beams cancelling throw sparks where they meet. */
  sparks(x: number, y: number, now: number): void {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 14 + Math.random() * 34;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        born: now,
        ttl: 220 + Math.random() * 320,
        color: i % 3 === 0 ? AMBER : PALE,
      });
    }
    this.shake = Math.max(this.shake, 1.4);
  }

  /** A death: the killer's finisher goes off, and a ghost marks the spot. */
  eliminate(
    resolution: Resolution,
    victim: SnapshotPlayer,
    players: readonly SnapshotPlayer[],
    roster: Map<string, Fighter>,
    now: number,
  ): void {
    const fighter = roster.get(victim.id);
    if (!fighter) return;
    const shake = this.spawnFinisher(this.finishers, resolution, victim, players, roster, now);
    this.shake = Math.max(this.shake, shake);
    this.mark(victim, fighter, now);
  }

  crateBroken(crate: Crate, now: number): void {
    this.obstacleFx.crateBroken(crate, now);
    this.shake = Math.max(this.shake, 1.2);
  }

  teleported(from: { x: number; y: number }, to: { x: number; y: number }, color: number, now: number): void {
    this.obstacleFx.teleported(from, to, color, now);
  }

  private drawObstacles(world: World, light: Lighting, now: number, layer: 'floor' | 'solid'): void {
    if (layer === 'floor') drawFloorObstacles(this.view, world, light, now);
    else drawSolidObstacles(this.view, world, light, now);
  }

  /** Freezes the picture on the current frame, the way a heavy hit lands. */
  hitStop(now: number, ms: number): void {
    this.holdUntil = now + ms;
  }

  announce(title: string, by: Fighter | null, now: number): void {
    this.callout = { title, by: by?.name ?? null, color: by ? mix(by.color, PALE, 0.3) : PALE, born: now };
  }

  feedKill(killer: Fighter, victim: Fighter, now: number): void {
    this.feed.unshift({ killer, victim, born: now });
    this.feed.length = Math.min(this.feed.length, FEED_MAX);
  }

  /** The last two, face to face across the screen. */
  showdown(a: Fighter, b: Fighter, now: number): void {
    this.intro = { a, b, born: now };
  }

  private spawnFinisher(
    into: Finishers,
    resolution: Resolution,
    victim: SnapshotPlayer,
    players: readonly SnapshotPlayer[],
    roster: Map<string, Fighter>,
    now: number,
  ): number {
    const fighter = roster.get(victim.id);
    if (!fighter) return 0;
    const killerId = killerOf(resolution, victim.id);
    const killer = killerId ? roster.get(killerId) : undefined;
    const from = players.find((p) => p.id === killerId);
    return into.spawn(
      killer?.finisher ?? fighter.finisher,
      {
        x: victim.x,
        y: victim.y,
        aim: victim.aim,
        color: fighter.color,
        archetype: fighter.archetype,
        from: from ? { x: from.x, y: from.y } : null,
      },
      killer?.color ?? fighter.color,
      now,
    );
  }

  private mark(player: SnapshotPlayer, fighter: Fighter, now: number): void {
    this.markers.push({
      x: player.x,
      y: player.y,
      aim: player.aim,
      color: fighter.color,
      archetype: fighter.archetype,
      born: now,
    });
  }

  clearEffects(): void {
    this.particles = [];
    this.markers = [];
    this.impacts = [];
    this.flashAt = -1;
    this.shake = 0;
    this.impactedRound = -1;
    this.finishers.clear();
    this.replayFinishers.clear();
    this.splats.clear();
    this.obstacleFx.clear();
    this.callout = null;
    this.intro = null;
    this.feed = [];
    this.holdUntil = 0;
  }

  // ------------------------------------------------------------- geometry ---

  private buildSpans(size: number): void {
    if (size === this.spanSize) return;
    this.spanSize = size;

    const hull = this.octagon(size);
    let top = Infinity;
    let bottom = -Infinity;
    for (const p of hull) {
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
    }
    this.spanTop = Math.max(0, Math.floor(top));
    const last = Math.min(this.buffer.height - 1, Math.ceil(bottom));
    const rows = Math.max(0, last - this.spanTop + 1);
    this.spans = new Int32Array(rows * 2);

    for (let i = 0; i < rows; i++) {
      const y = this.spanTop + i;
      let left = Infinity;
      let right = -Infinity;
      for (let e = 0; e < hull.length; e++) {
        const a = hull[e]!;
        const b = hull[(e + 1) % hull.length]!;
        if (a.y === b.y) continue;
        if (y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) continue;
        const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
      this.spans[i * 2] = left === Infinity ? 1 : Math.ceil(left);
      this.spans[i * 2 + 1] = right === -Infinity ? 0 : Math.floor(right);
    }
  }

  /** Walks each scanline inside the octagon. */
  private eachRow(size: number, fn: (y: number, x0: number, x1: number) => void): void {
    this.buildSpans(size);
    const rows = this.spans.length / 2;
    for (let i = 0; i < rows; i++) {
      const y = this.spanTop + i;
      if (y < 0 || y >= this.buffer.height) continue;
      const x0 = Math.max(0, this.spans[i * 2]!);
      const x1 = Math.min(this.buffer.width - 1, this.spans[i * 2 + 1]!);
      if (x1 >= x0) fn(y, x0, x1);
    }
  }

  private octagon(size: number): { x: number; y: number }[] {
    return arenaVertices(size).map((v) => ({ x: this.px(v.x), y: this.py(v.y) }));
  }

  // --------------------------------------------------------------- drawing ---

  frame(scene: Scene, now: number): void {
    // Hit-stop: the last frame stays up, so the killing hit lands as a still.
    if (now < this.holdUntil) return;
    if (scene.killcam) {
      this.drawKillcam(scene, scene.killcam, now);
      return;
    }

    const buffer = this.buffer;
    const lit = scene.phase === 'lights' || !scene.inMatch;
    const ambient = lit ? 1 : ambientAt(now - scene.darkAt);
    const size = this.currentSize(scene, now);

    this.shake = Math.max(0, this.shake - 0.12);

    buffer.clear(VOID);
    this.drawDeadZone(lit, ambient);

    if (lit) this.drawFacility(scene, size, now);
    else this.drawDarkFacility(scene, size, ambient);

    const light: Lighting = { lit, ambient, lamp: lit ? null : scene.self };
    if (scene.inMatch) this.drawObstacles(scene.world, light, now, 'floor');
    this.drawScorches(scene, size, lit);
    if (scene.inMatch) this.drawObstacles(scene.world, light, now, 'solid');

    if (scene.inMatch) {
      if (lit) this.drawLitRound(scene, size, now);
      else this.drawBlackout(scene, size, now);
      this.drawMarkers(now);
      this.drawImpacts(now);
      this.drawParticles(now);
      this.obstacleFx.draw(this.view, now);
      this.finishers.draw(this.view, now);
      this.drawFlash(now);
      if (scene.showdown) this.drawEmergency(lit, now);
    }

    // The world shakes; the interface drawn after this stays put.
    this.shift = this.shakeOffset(Math.round(this.shake));
    buffer.camera(buffer.width / 2, buffer.height / 2, 1, this.shift.x, this.shift.y, VOID);

    if (scene.inMatch) {
      this.drawHud(scene, now);
      this.drawCallout(now);
      this.drawIntro(now);
    }

    buffer.present(this.ctx, this.scale);
    if (scene.inMatch && lit) this.drawNameplates(scene, size);
    if (scene.inMatch) this.drawFeed(now);
  }

  private shakeOffset(strength: number): { x: number; y: number } {
    if (strength <= 0) return { x: 0, y: 0 };
    const jitter = () => Math.round((Math.random() * 2 - 1) * strength);
    return { x: jitter(), y: jitter() };
  }

  /**
   * Emergency power: a slow red pulse over everything. Uniform, so in the
   * dark it gives nothing away about where anyone is.
   */
  private drawEmergency(lit: boolean, now: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(now / 280);
    this.buffer.tint(EMERGENCY, (lit ? 0.07 : 0.05) + pulse * 0.06);
  }

  private currentSize(scene: Scene, now: number): number {
    if (!scene.lights) return this.baseSize;
    const lights = scene.lights;
    if (lights.size === lights.previousSize) return lights.size;
    const start = scene.lightsAt + RESOLVE_DELAY_MS + SHRINK_WARN_MS;
    return lerp(lights.previousSize, lights.size, easeOut(clamp01((now - start) / SHRINK_ANIM_MS)));
  }

  /**
   * The arena's original footprint stays on screen as a powered-down husk, so a
   * shrink reads as floor being switched off rather than the world ending.
   */
  private drawDeadZone(lit: boolean, ambient: number): void {
    const buffer = this.buffer;
    const alpha = lit ? 1 : 0.4 + ambient * 0.3;
    this.eachRow(this.baseSize, (y, x0, x1) => {
      const onRow = y % PANEL === 0;
      for (let x = x0; x <= x1; x++) {
        buffer.blend(x, y, onRow || x % PANEL === 0 ? DEAD_SEAM : DEAD_FLOOR, alpha);
      }
    });
    buffer.polyline(this.octagon(this.baseSize), METAL_DARK, lit ? 0.85 : 0.3);
  }

  private drawFacility(scene: Scene, size: number, now: number): void {
    const buffer = this.buffer;

    // Plated floor: alternating panels with recessed seams, tinted by stage band.
    const half = this.baseSize / 2;
    const ox = buffer.width / 2;
    const oy = buffer.height / 2;
    this.eachRow(size, (y, x0, x1) => {
      const row = Math.floor(y / PANEL);
      const onRow = y % PANEL === 0;
      const lip = y % PANEL === 1;
      const wy = Math.abs((y - oy) * UNITS_PER_PX);
      for (let x = x0; x <= x1; x++) {
        if (onRow || x % PANEL === 0) {
          buffer.blend(x, y, SEAM, 1);
          continue;
        }
        const wx = Math.abs((x - ox) * UNITS_PER_PX);
        // Distance in the octagon's own measure, so bands follow its walls.
        const reach = Math.max(wx, wy, (wx + wy) * Math.SQRT1_2) / half;
        let band = 0;
        while (band < STAGE_COUNT - 1 && reach <= STAGE_SCALE[band + 1]!) band++;
        const checker = (Math.floor(x / PANEL) + row) & 1;
        buffer.blend(x, y, this.ringFloor[band]![checker]!, 1);
        if (lip) buffer.blend(x, y, PANEL_LIP, 0.3);
      }
    });

    // Where the wall will stop next, scored into the floor.
    for (let stage = 1; stage < STAGE_COUNT; stage++) {
      const line = this.baseSize * STAGE_SCALE[stage]!;
      if (line >= size - 1) continue;
      buffer.polyline(this.octagon(line), METAL_DARK, 0.7);
    }

    this.drawHazardBands(scene, size, now);
    this.drawCables(size);
    this.drawPlatform(size, now, true, 1);
    this.drawPerimeter(size, now);
    this.drawPillars(size, true, 1);
  }

  private drawDarkFacility(scene: Scene, size: number, ambient: number): void {
    const buffer = this.buffer;

    this.eachRow(size, (y, x0, x1) => {
      for (let x = x0; x <= x1; x++) buffer.blend(x, y, 0x101319, 0.9);
    });

    // Only what the fighter's own lamp touches: panel seams fading out with range.
    if (scene.self) {
      const cx = this.px(scene.self.x);
      const cy = this.py(scene.self.y);
      const reach = this.units(SIGHT_RADIUS) * 1.8;
      this.eachRow(size, (y, x0, x1) => {
        const dy = y - cy;
        if (Math.abs(dy) > reach) return;
        const onRow = y % PANEL === 0;
        for (let x = x0; x <= x1; x++) {
          if (!onRow && x % PANEL !== 0) continue;
          const d = Math.hypot(x - cx, dy);
          if (d > reach) continue;
          buffer.blend(x, y, PANEL_LIP, (1 - d / reach) * 0.45 * (0.7 + ambient));
        }
      });
    }

    this.drawPillars(size, false, ambient);
    this.drawPlatform(size, 0, false, ambient);
    buffer.polyline(this.octagon(size), METAL, 0.12 + ambient * 0.4);
  }

  /** A stencilled sector mark, off-centre because real rooms are not symmetrical. */
  private drawHazardBands(scene: Scene, size: number, now: number): void {
    const buffer = this.buffer;
    const hull = this.octagon(size);
    const inner = this.octagon(size * 0.9);
    const lights = scene.lights;

    // The ring about to be switched off flashes before the wall actually moves.
    const warning =
      lights !== null &&
      lights.size !== lights.previousSize &&
      now - scene.lightsAt >= RESOLVE_DELAY_MS &&
      now - scene.lightsAt < RESOLVE_DELAY_MS + SHRINK_WARN_MS;
    const blink = warning && Math.floor(now / 90) % 2 === 0;

    // Three walls carry markings; a full ring would read as decoration.
    for (const edge of [0, 3, 5]) {
      const a = hull[edge]!;
      const b = hull[(edge + 1) % hull.length]!;
      const ia = inner[edge]!;
      const ib = inner[(edge + 1) % inner.length]!;
      const steps = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x0 = lerp(a.x, b.x, t);
        const y0 = lerp(a.y, b.y, t);
        const x1 = lerp(ia.x, ib.x, t);
        const y1 = lerp(ia.y, ib.y, t);
        if (Math.floor(s / 5) % 2 !== 0) continue;
        buffer.line(
          lerp(x0, x1, 0.35), lerp(y0, y1, 0.35),
          lerp(x0, x1, 0.62), lerp(y0, y1, 0.62),
          blink ? PALE : AMBER_DIM,
          blink ? 0.9 : 0.42,
        );
      }
    }
  }

  /**
   * Conduit runs hug the wall between columns. They deliberately never cross
   * the open floor, where a straight line would be mistaken for someone's aim.
   */
  private drawCables(size: number): void {
    const buffer = this.buffer;
    const run = this.octagon(size * 0.82);
    for (const edge of [1, 2, 6]) {
      const a = run[edge]!;
      const b = run[(edge + 1) % run.length]!;
      buffer.line(a.x, a.y + 1, b.x, b.y + 1, METAL_DARK, 0.85);
      buffer.line(a.x, a.y, b.x, b.y, METAL, 0.5);

      // Brackets pinning the run to the floor.
      const steps = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 9));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        buffer.rect(Math.round(lerp(a.x, b.x, t)), Math.round(lerp(a.y, b.y, t)) - 1, 1, 3, METAL_LIGHT, 0.4);
      }
    }
  }

  private drawPlatform(size: number, now: number, lit: boolean, ambient: number): void {
    const buffer = this.buffer;
    const base = this.octagon(size * 0.24);
    const top = base.map((p) => ({ x: p.x, y: p.y - 3 }));

    if (!lit) {
      buffer.polyline(top, METAL, 0.1 + ambient * 0.28);
      buffer.disc(this.px(0), this.py(0) - 3, 0, EMITTER, 0.25 + ambient * 0.2);
      return;
    }

    buffer.fillConvex(base, PILLAR_DARK, 1);
    // The three-pixel offset between base and top is the entire sense of height.
    for (let i = 0; i < base.length; i++) {
      buffer.line(base[i]!.x, base[i]!.y, top[i]!.x, top[i]!.y, PILLAR_FACE, 1);
    }
    buffer.fillConvex(top, FLOOR_A, 1);
    buffer.polyline(top, METAL_LIGHT, 0.7);

    const pulse = 0.5 + 0.5 * Math.sin(now / 620);
    buffer.glow(this.px(0), this.py(0) - 3, 6, EMITTER, 0.2 + pulse * 0.18);
    buffer.disc(this.px(0), this.py(0) - 3, 1, mix(EMITTER, PALE, 0.5), 0.85);
  }

  /** Eight columns at the vertices, with real height so the floor has depth. */
  private drawPillars(size: number, lit: boolean, ambient: number): void {
    const buffer = this.buffer;
    const feet = this.octagon(size * 0.9);
    const w = 3;
    const h = 11;

    feet.forEach((foot, index) => {
      if (!lit) {
        buffer.rect(foot.x - w, foot.y - h, w * 2, h, PILLAR_FACE, 0.16 + ambient * 0.24);
        return;
      }

      buffer.rect(foot.x - w - 1, foot.y - 2, w * 2 + 2, 3, 0x000000, 0.35);
      buffer.rect(foot.x - w, foot.y - h, w * 2, h, PILLAR_FACE, 1);
      buffer.rect(foot.x - w, foot.y - h, 1, h, PILLAR_LIGHT, 1);
      buffer.rect(foot.x + w - 1, foot.y - h, 1, h, PILLAR_DARK, 1);
      buffer.rect(foot.x - w, foot.y - h - 2, w * 2, 2, METAL, 1);
      buffer.rect(foot.x - w, foot.y - h - 2, w * 2, 1, METAL_LIGHT, 1);

      // Only some columns carry a status lamp.
      if (index % 3 === 0) buffer.blend(foot.x, foot.y - h + 2, AMBER, 0.85);
    });
  }

  private drawPerimeter(size: number, now: number): void {
    const buffer = this.buffer;
    const hull = this.octagon(size);
    const inner = this.octagon(size * 0.95);

    for (let edge = 0; edge < hull.length; edge++) {
      const a = hull[edge]!;
      const b = hull[(edge + 1) % hull.length]!;
      const ia = inner[edge]!;
      const ib = inner[(edge + 1) % inner.length]!;
      const steps = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 3));

      // Vent slats running back from the wall: machinery, not a neon strip.
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        buffer.line(
          lerp(a.x, b.x, t), lerp(a.y, b.y, t),
          lerp(ia.x, ib.x, t), lerp(ia.y, ib.y, t),
          METAL_DARK, 0.5,
        );
      }
      buffer.line(ia.x, ia.y, ib.x, ib.y, METAL, 0.65);
    }

    buffer.polyline(hull, METAL_LIGHT, 0.9);
    const pacer = Math.floor(now / 160) % hull.length;
    buffer.disc(hull[pacer]!.x, hull[pacer]!.y, 1, AMBER, 0.8);
  }

  private drawScorches(scene: Scene, size: number, lit: boolean): void {
    if (scene.scorches.length === 0) return;
    const limit = size / 2;
    for (const mark of scene.scorches) {
      if (Math.hypot(mark.ox, mark.oy) > limit && Math.hypot(mark.ex, mark.ey) > limit) continue;
      this.buffer.line(
        this.px(mark.ox), this.py(mark.oy),
        this.px(mark.ex), this.py(mark.ey),
        METAL_DARK, lit ? 0.35 : 0.1,
      );
    }
  }

  // ----------------------------------------------------------------- round ---

  private drawLitRound(scene: Scene, size: number, now: number): void {
    const lights = scene.lights;
    if (!lights) return;
    const elapsed = now - scene.lightsAt;
    const resolution = lights.resolution;

    if (resolution) {
      const grow = clamp01(elapsed / MATERIALIZE_MS);
      const settling = elapsed < MATERIALIZE_MS;
      const fade = 1 - 0.5 * clamp01((elapsed - RESOLVE_DELAY_MS) / BEAM_FADE_MS);

      if (!settling && this.impactedRound !== lights.round) {
        this.impactedRound = lights.round;
        for (const beam of resolution.beams) {
          // Every bounce and the final stop leave a mark.
          for (const seg of this.clipPath(beam.segments, size)) {
            this.impacts.push({ x: seg.ex, y: seg.ey, color: scene.roster.get(beam.id)?.color ?? PALE, born: now });
          }
        }
        this.shake = Math.max(this.shake, 1.1);
      }

      for (const beam of resolution.beams) {
        const color = scene.roster.get(beam.id)?.color ?? PALE;
        this.drawPath(this.clipPath(beam.segments, size), color, fade, now, easeOut(grow), settling);
      }

      for (const duel of resolution.duels) {
        const a = lights.players.find((p) => p.id === duel.a);
        const b = lights.players.find((p) => p.id === duel.b);
        if (!a || !b) continue;
        const pulse = 0.45 + 0.4 * Math.sin(elapsed / 60);
        this.drawBeam({ ox: a.x, oy: a.y, ex: b.x, ey: b.y }, PALE, pulse, now, easeOut(grow), settling);
      }
    }

    for (const shown of lights.players) {
      const fighter = scene.roster.get(shown.id);
      if (!fighter) continue;
      // Snapshots hold where each shot was fired from; the shrinking wall then
      // visibly pushes anyone caught outside it.
      const player = { ...shown, ...clampToArena(shown, size, PLAYER_RADIUS) };

      if (player.alive) {
        this.drawFighter(player, fighter, now, { walking: false });
        continue;
      }
      const dying = clamp01((elapsed - RESOLVE_DELAY_MS - HIT_STOP_MS) / DEATH_FADE_MS);
      if (dying >= 1) continue;
      this.drawFighter(player, fighter, now, {
        walking: false,
        dissolve: dying,
        whiten: dying < 0.18 ? 1 : 0,
      });
    }
  }

  private drawBlackout(scene: Scene, size: number, now: number): void {
    if (scene.self) {
      const fighter = scene.roster.get(scene.selfId);
      if (!fighter) return;
      this.buffer.glow(
        this.px(scene.self.x),
        this.py(scene.self.y),
        this.units(SIGHT_RADIUS),
        mix(fighter.color, PALE, 0.5),
        0.1,
      );
      this.drawPath(this.traceFrom(scene.self, scene.world), fighter.color, 0.95, now, 1, false);
      this.drawFighter({ ...scene.self, id: scene.selfId, alive: true }, fighter, now, {
        walking: this.moving,
      });
      return;
    }

    for (const player of scene.watch) {
      const fighter = scene.roster.get(player.id);
      if (!fighter) continue;
      this.drawPath(this.traceFrom(player, scene.world), fighter.color, 0.4, now, 1, false);
      this.drawFighter(player, fighter, now, { walking: false, alpha: 0.8 });
    }
  }

  /**
   * Cuts a path off where the shrinking wall now stands. A beam is fired before
   * the shrink, so once the wall has moved, anything past it is gone.
   */
  private clipPath(segments: readonly Trace[], size: number): Trace[] {
    const kept: Trace[] = [];
    for (const seg of segments) {
      const dx = seg.ex - seg.ox;
      const dy = seg.ey - seg.oy;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      const dir = { x: dx / length, y: dy / length };
      const reach = Math.min(length, rayToWall({ x: seg.ox, y: seg.oy }, dir, size));
      kept.push({ ox: seg.ox, oy: seg.oy, ex: seg.ox + dir.x * reach, ey: seg.oy + dir.y * reach });
      if (reach < length - 0.5) break;
    }
    return kept;
  }

  /** Where a fighter's beam would go right now, bounces and all. */
  private traceFrom(p: { x: number; y: number; aim: number }, world: World): Trace[] {
    const dir = { x: Math.cos(p.aim), y: Math.sin(p.aim) };
    const origin = { x: p.x + dir.x * BARREL_LENGTH, y: p.y + dir.y * BARREL_LENGTH };
    return traceBeam(origin, dir, world).segments;
  }

  /** A whole beam, growing along its bounces: `reach` is how far along the full path, 0..1. */
  private drawPath(
    segments: readonly Trace[],
    color: number,
    alpha: number,
    now: number,
    reach: number,
    settling: boolean,
  ): void {
    const lengths = segments.map((seg) => Math.hypot(seg.ex - seg.ox, seg.ey - seg.oy));
    let budget = lengths.reduce((sum, l) => sum + l, 0) * reach;
    segments.forEach((seg, i) => {
      if (budget <= 0) return;
      const length = lengths[i]!;
      this.drawBeam(seg, color, alpha, now, length === 0 ? 1 : clamp01(budget / length), settling, i === 0);
      budget -= length;
    });
  }

  /**
   * The beam is walked pixel by pixel rather than stroked, so energy can visibly
   * travel along it and so it can grow out of the muzzle when the lights return.
   * `reach` is the share of this segment drawn so far; only the first segment
   * leaves the muzzle, the rest start where a mirror sent them.
   */
  private drawBeam(
    beam: Trace,
    color: number,
    alpha: number,
    now: number,
    reach: number,
    settling: boolean,
    muzzle = true,
  ): void {
    if (alpha <= 0) return;
    const buffer = this.buffer;
    const x0 = this.px(beam.ox);
    const y0 = this.py(beam.oy) - (muzzle ? MUZZLE_LIFT : 0);
    const x1 = this.px(beam.ex);
    const y1 = this.py(beam.ey);

    const dx = x1 - x0;
    const dy = y1 - y0;
    const span = Math.hypot(dx, dy);
    if (span < 1) return;

    const steps = Math.round(span * reach);
    const ux = dx / span;
    const uy = dy / span;
    const nx = -uy;
    const ny = ux;
    const flicker = settling ? 0.4 + Math.random() * 0.6 : 1;
    const core = mix(color, PALE, 0.55);

    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ux * s);
      const y = Math.round(y0 + uy * s);
      // Energy running outward from the muzzle.
      const wave = 0.72 + 0.28 * Math.sin(s * 0.55 - now * 0.018);
      const a = alpha * flicker * wave;
      buffer.blend(x, y, core, a);
      buffer.add(Math.round(x + nx), Math.round(y + ny), color, a * 0.32);
      buffer.add(Math.round(x - nx), Math.round(y - ny), color, a * 0.32);
      if (s % 2 === 0) {
        buffer.add(Math.round(x + nx * 2), Math.round(y + ny * 2), color, a * 0.1);
        buffer.add(Math.round(x - nx * 2), Math.round(y - ny * 2), color, a * 0.1);
      }
    }

    buffer.glow(x0, y0, muzzle ? 4 : 2, color, alpha * 0.55 * flicker);
    buffer.blend(x0, y0, mix(color, PALE, 0.8), alpha * flicker);
  }

  private drawFighter(
    player: SnapshotPlayer,
    fighter: Fighter,
    now: number,
    opts: { walking: boolean; alpha?: number; rim?: number; dissolve?: number; whiten?: number },
  ): void {
    const buffer = this.buffer;
    const cx = this.px(player.x);
    const cy = this.py(player.y);
    const alpha = opts.alpha ?? 1;

    const { facing, flip } = facingFor(player.aim);
    const phase = Math.floor(now / WALK_FRAME_MS) % 4;
    const frame = opts.walking && (phase === 1 || phase === 3) ? 1 : 0;
    const bob = opts.walking && (phase === 1 || phase === 3) ? -1 : 0;
    const breath = !opts.walking && Math.floor(now / 520) % 2 === 0 ? -1 : 0;
    const art = sprite(facing, frame, fighter.archetype, fighter.color);

    const feetY = cy + SPRITE_FOOT;
    for (let dx = -4; dx <= 4; dx++) {
      const reach = Math.round(Math.sqrt(Math.max(0, 1 - (dx / 5) ** 2)) * 1.6);
      for (let dy = -reach; dy <= reach; dy++) {
        buffer.blend(cx + dx, feetY + dy, 0x000000, 0.32 * alpha);
      }
    }

    const left = cx - (SPRITE_W >> 1);
    const top = cy - 11 + bob + breath;
    this.blitSprite(art, left, top, flip, {
      alpha,
      rim: opts.rim ? mix(fighter.color, PALE, 0.4) : undefined,
      rimAlpha: opts.rim,
      dissolve: opts.dissolve,
      whiten: opts.whiten,
    });

    this.drawWeapon(player, fighter, cx, cy + bob + breath, alpha);
  }

  /**
   * Arm and gun are rasterised along the aim vector: at this size a rotated
   * sprite would smear, and the barrel has to point exactly where the beam goes.
   */
  private drawWeapon(
    player: SnapshotPlayer,
    fighter: Fighter,
    cx: number,
    cy: number,
    alpha: number,
  ): void {
    const buffer = this.buffer;
    const dir = { x: Math.cos(player.aim), y: Math.sin(player.aim) };
    const y = cy - MUZZLE_LIFT;

    const shoulderX = cx + dir.x * 1.5;
    const shoulderY = y + dir.y * 1.5;
    const handX = cx + dir.x * 4;
    const handY = y + dir.y * 4;
    const tipX = cx + dir.x * this.units(BARREL_LENGTH);
    const tipY = y + dir.y * this.units(BARREL_LENGTH);

    buffer.line(shoulderX, shoulderY + 1, handX, handY + 1, 0x12141c, alpha);
    buffer.line(shoulderX, shoulderY, handX, handY, mix(fighter.color, PALE, 0.35), alpha);
    buffer.line(handX, handY + 1, tipX, tipY + 1, 0x12141c, alpha);
    buffer.line(handX, handY, tipX, tipY, METAL_LIGHT, alpha);
  }

  private blitSprite(
    art: Sprite,
    left: number,
    top: number,
    flip: boolean,
    opts: { alpha?: number; rim?: number; rimAlpha?: number; dissolve?: number; whiten?: number },
  ): void {
    const buffer = this.buffer;
    const alpha = opts.alpha ?? 1;
    const dissolve = opts.dissolve ?? 0;
    const whiten = opts.whiten ?? 0;

    const at = (x: number, y: number): number => {
      if (x < 0 || y < 0 || x >= art.width || y >= art.height) return -1;
      return art.pixels[y * art.width + (flip ? art.width - 1 - x : x)]!;
    };

    for (let y = 0; y < art.height; y++) {
      for (let x = 0; x < art.width; x++) {
        const color = at(x, y);

        if (color < 0) {
          if (opts.rim === undefined) continue;
          const touching =
            at(x - 1, y) >= 0 || at(x + 1, y) >= 0 || at(x, y - 1) >= 0 || at(x, y + 1) >= 0;
          // The rim carries its own alpha: a death marker is a rim with no body.
          if (touching) buffer.add(left + x, top + y, opts.rim, opts.rimAlpha ?? 0.6);
          continue;
        }

        if (dissolve > 0) {
          const noise = ((x * 73856093) ^ (y * 19349663)) % 997;
          if (Math.abs(noise) / 997 < dissolve) continue;
        }

        buffer.blend(left + x, top + y, whiten > 0 ? mix(color, PALE, whiten) : color, alpha);
      }
    }
  }

  // --------------------------------------------------------------- effects ---

  private drawMarkers(now: number): void {
    this.markers = this.markers.filter((m) => now - m.born < MARKER_MS);
    for (const marker of this.markers) {
      const age = (now - marker.born) / MARKER_MS;
      const art = sprite(facingFor(marker.aim).facing, 0, marker.archetype, marker.color);
      this.blitSprite(art, this.px(marker.x) - (SPRITE_W >> 1), this.py(marker.y) - 11, false, {
        alpha: 0,
        rim: marker.color,
        rimAlpha: (1 - age) * 0.28,
      });
    }
  }

  private drawImpacts(now: number): void {
    const buffer = this.buffer;
    this.impacts = this.impacts.filter((i) => now - i.born < IMPACT_MARK_MS);
    for (const impact of this.impacts) {
      const age = (now - impact.born) / IMPACT_MARK_MS;
      const x = this.px(impact.x);
      const y = this.py(impact.y);

      if (age < 0.22) {
        const t = age / 0.22;
        buffer.ring(x, y, 1 + t * 7, mix(impact.color, PALE, 0.4), (1 - t) * 0.7, true);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + age * 6;
          buffer.add(
            Math.round(x + Math.cos(a) * (2 + t * 6)),
            Math.round(y + Math.sin(a) * (2 + t * 6)),
            PALE,
            (1 - t) * 0.8,
          );
        }
      }
      buffer.glow(x, y, 3, impact.color, (1 - age) * 0.35);
    }
  }

  private drawParticles(now: number): void {
    this.particles = this.particles.filter((p) => now - p.born < p.ttl);
    for (const p of this.particles) {
      const age = (now - p.born) / p.ttl;
      const t = age * (p.ttl / 1000);
      this.buffer.add(
        this.px(p.x + p.vx * t * 10),
        this.py(p.y + p.vy * t * 10),
        mix(p.color, PALE, 0.3),
        (1 - age) * 0.95,
      );
    }
  }

  private drawFlash(now: number): void {
    if (this.flashAt < 0 || now - this.flashAt > FLASH_MS) return;
    this.buffer.tint(0x8fa2bb, (1 - (now - this.flashAt) / FLASH_MS) * 0.3);
  }

  // ------------------------------------------------------------------- hud ---

  private drawHud(scene: Scene, now: number): void {
    const buffer = this.buffer;
    const lights = scene.lights;
    if (!lights) return;

    const dim = scene.phase === 'dark' ? 0.55 : 1;
    const pad = 7;
    const cx = Math.round(buffer.width / 2);

    buffer.text(`ROUND ${String(Math.max(lights.round, 1)).padStart(2, '0')}`, pad, pad, INK, 0.8 * dim);
    buffer.text(`ALIVE ${String(lights.remaining).padStart(2, '0')}`, pad, pad + 8, INK, 0.8 * dim);

    const stage = `STAGE ${String(lights.stage + 1).padStart(2, '0')}`;
    buffer.text(stage, cx - Math.round(buffer.textWidth(stage, 2) / 2), pad, PALE, 0.95 * dim, 2);

    const pipW = 9;
    const pipsX = cx - Math.round((STAGE_COUNT * pipW - 3) / 2);
    for (let i = 0; i < STAGE_COUNT; i++) {
      const on = i <= lights.stage;
      buffer.rect(pipsX + i * pipW, pad + 13, pipW - 3, 2, on ? AMBER : METAL, (on ? 0.95 : 0.4) * dim);
    }

    // The one timer that matters: how much relocation time is left.
    if (scene.phase === 'dark') {
      const left = Math.max(0, scene.darkEndsAt - now) / 1000;
      const timer = `LIGHTS ON ${left.toFixed(2)}`;
      const urgent = left < 0.6;
      buffer.text(timer, cx - Math.round(buffer.textWidth(timer) / 2), pad + 18, urgent ? AMBER : PALE, 0.9);
    }

    const elapsed = now - scene.lightsAt;

    // Announced only while it is actually happening.
    const shrinking =
      scene.phase === 'lights' &&
      lights.size !== lights.previousSize &&
      elapsed >= RESOLVE_DELAY_MS &&
      elapsed < RESOLVE_DELAY_MS + SHRINK_WARN_MS + SHRINK_ANIM_MS;
    if (shrinking && Math.floor(now / 180) % 2 === 0) {
      const banner = 'PLATFORM SHRINKING';
      buffer.text(banner, cx - Math.round(buffer.textWidth(banner) / 2), pad + 28, AMBER, 0.95);
    }

    const label = scene.spectating ? 'SPECTATING' : scene.phase === 'dark' ? 'BLACKOUT' : 'LIGHTS';
    buffer.text(
      label,
      cx - Math.round(buffer.textWidth(label) / 2),
      buffer.height - 11,
      scene.spectating ? AMBER : INK,
      scene.phase === 'dark' ? 0.45 : 0.6,
    );
  }

  /** Names are interface, not world art, so they stay crisp at a fixed size. */
  private drawNameplates(scene: Scene, size: number): void {
    const lights = scene.lights;
    if (!lights) return;

    const ctx = this.ctx;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    ctx.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.letterSpacing = `${Math.round(2 * dpr)}px`;

    for (const shown of lights.players) {
      if (!shown.alive) continue;
      const fighter = scene.roster.get(shown.id);
      if (!fighter) continue;
      const player = clampToArena(shown, size, PLAYER_RADIUS);
      ctx.fillStyle = shown.id === scene.selfId ? '#ccd6e2' : 'rgba(121,132,154,0.75)';
      ctx.fillText(
        fighter.name.slice(0, 10).toUpperCase(),
        (this.px(player.x) + this.shift.x) * this.scale,
        (this.py(player.y) - 15 + this.shift.y) * this.scale,
      );
    }
    ctx.letterSpacing = '0px';
  }

  /** Who took out whom, top right. Interface, so crisp text like the nameplates. */
  private drawFeed(now: number): void {
    this.feed = this.feed.filter((entry) => now - entry.born < FEED_MS);
    if (this.feed.length === 0) return;

    const ctx = this.ctx;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    ctx.font = `${Math.round(9 * dpr)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'right';
    ctx.letterSpacing = `${Math.round(dpr)}px`;
    const right = this.canvas.width - 10 * dpr;

    this.feed.forEach((entry, i) => {
      const y = (18 + i * 13) * dpr;
      const victim = entry.victim.name.slice(0, 10).toUpperCase();
      const arrow = ' > ';
      ctx.globalAlpha = clamp01((FEED_MS - (now - entry.born)) / 600);
      ctx.fillStyle = hex(entry.victim.color);
      ctx.fillText(victim, right, y);
      const victimW = ctx.measureText(victim).width;
      ctx.fillStyle = hex(INK);
      ctx.fillText(arrow, right - victimW, y);
      const arrowW = ctx.measureText(arrow).width;
      ctx.fillStyle = hex(entry.killer.color);
      ctx.fillText(entry.killer.name.slice(0, 10).toUpperCase(), right - victimW - arrowW, y);
    });
    ctx.globalAlpha = 1;
    ctx.letterSpacing = '0px';
  }

  /** The round's banner: slams in one size up, then settles and fades. */
  private drawCallout(now: number): void {
    const callout = this.callout;
    if (!callout) return;
    const age = now - callout.born;
    if (age > CALLOUT_MS) {
      this.callout = null;
      return;
    }
    const alpha = clamp01((CALLOUT_MS - age) / 220);
    const y = Math.round(this.buffer.height * 0.27);
    const scale = this.shout(callout.title, y, age < 80 ? 4 : 3, callout.color, alpha);
    if (callout.by) this.shout(callout.by.toUpperCase(), y + 6 * scale + 2, 1, PALE, alpha * 0.85);
  }

  /**
   * Centred pixel text with a hard drop shadow, so it reads over any floor.
   * Steps down a size when the screen is too narrow; returns the size used.
   */
  private shout(text: string, y: number, scale: number, color: number, alpha: number): number {
    const buffer = this.buffer;
    const fit = Math.max(1, Math.min(scale, Math.floor((buffer.width - 8) / buffer.textWidth(text, 1))));
    const x = Math.round(buffer.width / 2 - buffer.textWidth(text, fit) / 2);
    buffer.text(text, x + 1, y + 1, 0x000000, alpha * 0.7, fit);
    buffer.text(text, x, y, color, alpha, fit);
    return fit;
  }

  /** "VS": both fighters slide in at triple size on a dark band. */
  private drawIntro(now: number): void {
    const intro = this.intro;
    if (!intro) return;
    const age = now - intro.born;
    if (age > INTRO_MS) {
      this.intro = null;
      return;
    }

    const buffer = this.buffer;
    const fade = clamp01((INTRO_MS - age) / 250);
    const slide = easeOut(clamp01(age / 240));
    const s = 3;
    const w = SPRITE_W * s;
    const h = SPRITE_H * s;
    const cx = Math.round(buffer.width / 2);
    const top = Math.round(buffer.height / 2 - h / 2);

    buffer.rect(0, top - 14, buffer.width, h + 30, 0x000000, 0.62 * fade);
    const leftX = Math.round(lerp(-w, cx - w - 12, slide));
    const rightX = Math.round(lerp(buffer.width, cx + 12, slide));
    this.blitScaled(sprite('side', 0, intro.a.archetype, intro.a.color), leftX, top, s, false, fade);
    this.blitScaled(sprite('side', 0, intro.b.archetype, intro.b.color), rightX, top, s, true, fade);

    this.shout('SHOWDOWN', top - 10, 1, AMBER, fade);
    if (age > 180) this.shout('VS', top + h / 2 - 8, age < 260 ? 4 : 3, PALE, fade);
    const name = (fighter: Fighter, x: number) => {
      const label = fighter.name.slice(0, 10).toUpperCase();
      const left = Math.round(x + w / 2 - buffer.textWidth(label) / 2);
      buffer.text(label, left, top + h + 4, mix(fighter.color, PALE, 0.4), fade);
    };
    name(intro.a, leftX);
    name(intro.b, rightX);
  }

  private blitScaled(art: Sprite, left: number, top: number, scale: number, flip: boolean, alpha: number): void {
    for (let y = 0; y < art.height; y++) {
      for (let x = 0; x < art.width; x++) {
        const color = art.pixels[y * art.width + (flip ? art.width - 1 - x : x)]!;
        if (color >= 0) this.buffer.rect(left + x * scale, top + y * scale, scale, scale, color, alpha);
      }
    }
  }

  // -------------------------------------------------------------- killcam ---

  /**
   * The match-ending round, replayed: the final blackout at speed with every
   * path on show, the snap in slow motion, a freeze on the hit, the anime
   * cut-in, the finisher played out in full at half speed, and the winner's card.
   */
  private drawKillcam(scene: Scene, kc: Killcam, now: number): void {
    const buffer = this.buffer;
    const t = now - kc.startedAt;
    const { beat, p, start } = beatAt(t);
    if (beat === 'cutin') {
      this.drawCutIn(scene, kc, t - start);
      buffer.present(this.ctx, this.scale);
      return;
    }

    const frames = (kc.frames ??= this.killcamFrames(kc));
    const size = kc.lights.size;
    const dark = beat === 'intro' || beat === 'replay';
    const after = beat === 'boom' || beat === 'finale';
    // Crates broken by the final shot only give way once the finisher goes off.
    const world = after ? scene.world : kc.world;

    // The replay is "night vision": the real room under a dark wash, so the
    // paths read against floor the players could not see at the time.
    buffer.clear(VOID);
    this.drawDeadZone(true, 1);
    this.drawFacility(scene, size, now);
    this.drawObstacles(world, { lit: true, ambient: 1, lamp: null }, now, 'floor');
    this.drawObstacles(world, { lit: true, ambient: 1, lamp: null }, now, 'solid');
    if (dark) buffer.rect(0, 0, buffer.width, buffer.height, NIGHT, 0.62);

    if (dark) this.drawReplay(scene, kc, beat === 'replay' ? p : 0, now);
    else this.drawFinalShot(scene, kc, beat, p, now);
    if (after) this.drawReplayBoom(scene, kc, kc.startedAt + BOOM_AT + (t - BOOM_AT) * KILLCAM_SLOWMO);
    if (beat === 'freeze') buffer.tint(PALE, (1 - p) * 0.45);

    const frame = this.killcamFraming(frames, beat, p);
    const kick = beat === 'freeze' || (beat === 'boom' && p < 0.12) ? this.shakeOffset(2) : { x: 0, y: 0 };
    buffer.camera(this.px(frame.x), this.py(frame.y), frame.zoom, kick.x, kick.y, VOID);

    this.drawKillcamOverlay(beat, p, now - kc.startedAt, now);
    if (beat === 'finale') this.drawFinaleCard(scene, kc, t - start);
    buffer.present(this.ctx, this.scale);
  }

  /** Who the cut-in is about: the winner's victim if there is a winner, else the first to fall. */
  private killcamCast(scene: Scene, kc: Killcam): { killer: Portrait | null; victim: Portrait | null; caption: string } {
    const resolution = kc.lights.resolution;
    const winner = kc.lights.players.find((p) => p.alive)?.id ?? null;
    const kill = resolution?.kills.find((k) => k.shooter === winner) ?? resolution?.kills[0];
    const victimId = kill?.target ?? resolution?.eliminated[0] ?? null;
    const portrait = (id: string | null | undefined): Portrait | null => {
      const fighter = id ? scene.roster.get(id) : undefined;
      return fighter ? { name: fighter.name, color: fighter.color, archetype: fighter.archetype } : null;
    };
    if (kill && kill.shooter === kill.target) return { killer: null, victim: portrait(victimId), caption: 'OOPS!' };
    if (!winner) return { killer: null, victim: portrait(victimId), caption: 'DOUBLE KO!' };
    return { killer: portrait(kill?.shooter), victim: portrait(victimId), caption: 'EXECUTED!' };
  }

  private drawCutIn(scene: Scene, kc: Killcam, t: number): void {
    const cast = this.killcamCast(scene, kc);
    if (!cast.victim) return;
    drawKillscreen(this.buffer, cast.killer, cast.victim, cast.caption, t);
  }

  private drawFinaleCard(scene: Scene, kc: Killcam, t: number): void {
    const winnerId = kc.lights.players.find((p) => p.alive)?.id;
    const fighter = winnerId ? scene.roster.get(winnerId) : undefined;
    const winner = fighter ? { name: fighter.name, color: fighter.color, archetype: fighter.archetype } : null;
    // A 3-pixel W reads as an H at banner size, so the card says VICTORY. With
    // nobody left it already says DRAW, and the title becomes its sub-label.
    drawFinale(this.buffer, winner, winner ? 'VICTORY' : 'NO SURVIVORS', t);
  }

  /** Everyone's path through the dark, with their aim, as it happened. */
  private drawReplay(scene: Scene, kc: Killcam, u: number, now: number): void {
    for (const track of kc.lights.replay ?? []) {
      const fighter = scene.roster.get(track.id);
      if (!fighter) continue;
      this.drawTrail(track, fighter.color, u);
      const pose = poseAt(track, u);
      const before = poseAt(track, u - 0.03);
      const walking = Math.hypot(pose.x - before.x, pose.y - before.y) > 4;
      this.drawPath(this.traceFrom(pose, kc.world), fighter.color, 0.35, now, 1, false);
      this.drawFighter({ ...pose, id: track.id, alive: true }, fighter, now, { walking, rim: 0.5 });
    }
  }

  /** Where a fighter went in the dark, traced at their feet and fading with age. */
  private drawTrail(track: ReplayTrack, color: number, u: number): void {
    const points = track.points;
    const upto = Math.floor(u * (points.length - 1));
    for (let i = 1; i <= upto; i++) {
      const [x0, y0] = points[i - 1]!;
      const [x1, y1] = points[i]!;
      const fresh = 0.3 + 0.6 * (i / upto);
      this.buffer.line(
        this.px(x0), this.py(y0) + SPRITE_FOOT,
        this.px(x1), this.py(y1) + SPRITE_FOOT,
        color, fresh, true,
      );
    }
  }

  /** The snap, slowed right down: beams crawl out of the muzzles and land. */
  private drawFinalShot(scene: Scene, kc: Killcam, beat: KillcamBeat, p: number, now: number): void {
    const lights = kc.lights;
    const victims = new Set(lights.resolution?.eliminated ?? []);
    const grow = beat === 'shot' ? p : 1;
    const alpha = beat === 'boom' ? 1 - clamp01(p * 3) : beat === 'finale' ? 0 : 1;

    for (const beam of lights.resolution?.beams ?? []) {
      const color = scene.roster.get(beam.id)?.color ?? PALE;
      this.drawPath(this.clipPath(beam.segments, lights.size), color, alpha, now, grow, beat === 'shot');
    }

    for (const player of lights.players) {
      const fighter = scene.roster.get(player.id);
      if (!fighter) continue;
      if (!victims.has(player.id)) {
        this.drawFighter(player, fighter, now, { walking: false });
        continue;
      }
      // The finisher owns the body from the moment it goes off.
      if (beat === 'boom' || beat === 'finale') continue;
      this.drawFighter(player, fighter, now, { walking: false, whiten: beat === 'freeze' ? 1 : 0 });
    }
  }

  private drawReplayBoom(scene: Scene, kc: Killcam, slow: number): void {
    const { resolution, players } = kc.lights;
    if (!kc.spawned && resolution) {
      kc.spawned = true;
      for (const id of resolution.eliminated) {
        const victim = players.find((p) => p.id === id);
        if (!victim) continue;
        this.spawnFinisher(this.replayFinishers, resolution, victim, players, scene.roster, slow);
        this.splats.spawn(victim.x, victim.y, slow);
      }
    }
    this.splats.draw(this.view, slow);
    this.replayFinishers.draw(this.view, slow);
  }

  /**
   * Wide on the whole chase, cut in on the shooters as the snap lands, punch
   * in on the hit, then ease back so the winner is in shot for the finale.
   */
  private killcamFrames(kc: Killcam): KillcamFrames {
    const viewW = this.buffer.width * UNITS_PER_PX;
    const viewH = this.buffer.height * UNITS_PER_PX * (1 - LETTERBOX * 2);
    const { players, replay, resolution } = kc.lights;
    const victims = new Set(resolution?.eliminated ?? []);
    const involved = new Set([...victims, ...(resolution?.kills.map((k) => k.shooter) ?? [])]);

    const paths = (replay ?? []).flatMap((track) => track.points.map(([x, y]) => ({ x, y })));
    const finals = players.filter((p) => involved.has(p.id));
    const wide = frameAround(paths.length > 0 ? paths : players, viewW, viewH, 2);
    const tight = frameAround(finals.length > 0 ? finals : players, viewW, viewH, 3);
    const punch = frameAround(players.filter((p) => victims.has(p.id)), viewW, viewH, 4, 90);
    // Whole zoom steps keep every pixel the same size once the camera settles.
    const settle = (f: Framing): Framing => ({ ...f, zoom: Math.max(1, Math.floor(f.zoom)) });
    return {
      wide: settle(wide),
      tight: settle(tight),
      punch: settle({ ...punch, zoom: Math.max(punch.zoom, tight.zoom + 1) }),
    };
  }

  private killcamFraming(f: KillcamFrames, beat: KillcamBeat, p: number): Framing {
    switch (beat) {
      case 'intro':
      case 'replay':
        return f.wide;
      case 'shot':
        return between(f.wide, f.tight, easeInOut(clamp01(p * 2)));
      case 'freeze':
      case 'cutin':
        return f.punch;
      case 'boom':
        return between(f.punch, f.tight, easeOut(clamp01((p - 0.55) / 0.45)));
      case 'finale':
        return f.tight;
    }
  }

  /** Letterbox, scanlines and labels: the interface layer, never zoomed. */
  private drawKillcamOverlay(beat: KillcamBeat, p: number, t: number, now: number): void {
    const buffer = this.buffer;
    if (beat === 'intro' || beat === 'replay') {
      for (let y = 0; y < buffer.height; y += 2) buffer.rect(0, y, buffer.width, 1, 0x000000, 0.2);
    }

    // The bars open up for the finale card.
    const open = beat === 'finale' ? 1 - easeOut(clamp01(p * 4)) : 1;
    const bar = Math.round(buffer.height * LETTERBOX * easeOut(clamp01(t / 300)) * open);
    buffer.rect(0, 0, buffer.width, bar, 0x000000, 1);
    buffer.rect(0, buffer.height - bar, buffer.width, bar, 0x000000, 1);
    if (bar < 9) return;

    const labelY = Math.round(bar / 2 - 2);
    if (Math.floor(now / 400) % 2 === 0) buffer.rect(7, labelY + 1, 3, 3, KILLCAM_RED, 1);
    buffer.text('KILLCAM', 13, labelY, PALE, 0.9);
    const speed = SPEED_LABEL[beat];
    buffer.text(speed, buffer.width - 7 - buffer.textWidth(speed), labelY, AMBER, 0.9);
  }
}
