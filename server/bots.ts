import { arenaSize, clampToArena } from '../shared/arena.js';
import { BARREL_LENGTH, HIT_RADIUS, MOVE_SPEED, PLAYER_RADIUS } from '../shared/constants.js';
import {
  activeObstacles,
  collide,
  conveyorAt,
  layoutFor,
  openWorld,
  traceBeam,
  type Obstacle,
  type Segment,
  type World,
} from '../shared/maps.js';
import { stepPlayer } from '../shared/movement.js';
import type { BotDifficulty, ServerMessage } from '../shared/protocol.js';

/** What a bot does this tick: the same three numbers a player's input carries. */
export interface BotInput {
  mx: number;
  my: number;
  aim: number;
}

export const BOT_NAMES: readonly string[] = [
  'Byte',
  'Static',
  'Rivet',
  'Hex',
  'Vandal',
  'Spool',
  'Relay',
  'Fuse',
  'Wraith',
  'Ember',
];

interface Vec {
  x: number;
  y: number;
}
/** A guess at where an opponent will stand when the lights return, and how much to trust it. */
interface Sample extends Vec {
  w: number;
}
type Pad = Extract<Obstacle, { kind: 'teleporter' }>;
/** Where to end the blackout, and the pad to step on to get there (if any). */
interface Spot {
  dest: Vec;
  via: Vec | null;
}
interface Plan extends Spot {
  aim: number;
  /** Stop walking here, so the position the shot is fired from is the one planned for. */
  stopAt: number;
  commitAt: number;
  committed: boolean;
}

interface Profile {
  /** Half-width of the uniform aim error, in radians. */
  aimError: number;
  /** How many destinations are considered. */
  spots: number;
  /** Chance per blackout that hiding behind obstacles is part of the choice. */
  coverChance: number;
  teleportChance: number;
  /** Chance per blackout of standing still. */
  hesitate: number;
}

const PROFILES: Record<BotDifficulty, Profile> = {
  easy: { aimError: 0.35, spots: 3, coverChance: 0, teleportChance: 0.15, hesitate: 0.25 },
  normal: { aimError: 0.15, spots: 10, coverChance: 0.5, teleportChance: 0.3, hesitate: 0 },
  hard: { aimError: 0.05, spots: 24, coverChance: 1, teleportChance: 0.4, hesitate: 0 },
};

/** Walking has to be finished this long before the blackout ends, aim is settled by COMMIT_LEAD_MS. */
const MOVE_MARGIN_MS = 700;
const COMMIT_LEAD_MS = 450;
/** Straight lines are rarely walkable end to end; plan for the detours. */
const REACH_EFFICIENCY = 0.85;
const MIN_TRAVEL = 90;
const WALL_MARGIN = PLAYER_RADIUS + 20;
const ARRIVE = 14;
const SLOW_RADIUS = 30;
const VIA_DONE = 80;
const LOOKAHEAD = 120;
/** Beyond this the opponents' last-seen trend is noise rather than a pattern. */
const MAX_TREND = 350;
/** A beam this close to a spot is a beam that will probably hit it. */
const DANGER_RADIUS = HIT_RADIUS + 40;
const SOFT_HIT = 30;
const SWEEP_STEP = (2 * Math.PI) / 180;

const STILL = { mx: 0, my: 0 };

/**
 * A bot's mind. It sees exactly what a player's client sees — the messages its
 * seat receives — so it never knows more than a human would: last-seen
 * positions from the latest lights, its own position, and the map.
 *
 * All the thinking happens once per blackout (and once more just before the
 * end to settle the aim); the tick itself only steers.
 */
export class BotBrain {
  private world: World = openWorld(arenaSize(2, 0));
  private alive = false;
  private dark = false;
  /** Opponents as last seen (kept inside the current wall), and the raw positions their trend comes from. */
  private sight = new Map<string, Vec>();
  private seenRaw = new Map<string, Vec>();
  private trend = new Map<string, Vec>();
  /** Where this bot stood when the lights last came on: what everyone else is aiming at. */
  private lastSelf: Vec = { x: 0, y: 0 };
  /** Best guess of the current position: the server's word, dead-reckoned between reports. */
  private me: Vec = { x: 0, y: 0 };
  private fresh = false;
  private durationMs = 0;
  private darkStart: number | null = null;
  private lastThink = 0;
  private plan: Plan | null = null;
  private move = STILL;

  constructor(
    readonly id: string,
    readonly difficulty: BotDifficulty,
    private readonly rng: () => number = Math.random,
  ) {}

  private get profile(): Profile {
    return PROFILES[this.difficulty];
  }

  /** Every server message sent to the bot's seat. */
  hear(msg: ServerMessage): void {
    switch (msg.t) {
      case 'match':
        this.onMatch(msg.startCount, msg.map);
        break;
      case 'lights':
        this.onLights(msg);
        break;
      case 'dark':
        this.dark = this.alive;
        this.durationMs = msg.durationMs;
        this.darkStart = null;
        this.plan = null;
        this.me = { ...this.lastSelf };
        break;
      case 'self':
        if (this.dark) {
          this.me = { x: msg.x, y: msg.y };
          this.fresh = true;
        }
        break;
      case 'over':
        this.alive = false;
        this.dark = false;
        break;
      default:
        break;
    }
  }

  /** Called every server tick; the input to apply, or null to leave the last one standing. */
  think(now: number): BotInput | null {
    if (!this.alive || !this.dark) return null;
    if (this.darkStart === null) this.beginBlackout(now);
    const plan = this.plan;
    if (!plan) return null;

    this.advance(now);
    if (!plan.committed && now >= plan.commitAt) this.commit(plan);
    this.move = now < plan.stopAt ? this.steer(plan) : STILL;
    return { ...this.move, aim: plan.aim };
  }

  private onMatch(startCount: number, map: Parameters<typeof layoutFor>[0]): void {
    const size = arenaSize(startCount, 0);
    this.world = { size, layout: layoutFor(map, size), broken: new Set() };
    this.alive = true;
    this.dark = false;
    this.sight = new Map();
    this.seenRaw = new Map();
    this.trend = new Map();
    this.plan = null;
  }

  /** The reveal: everyone's position when the shots were fired, then the wall may have moved. */
  private onLights(msg: Extract<ServerMessage, { t: 'lights' }>): void {
    this.world = { size: msg.size, layout: this.world.layout, broken: new Set(msg.broken) };
    this.dark = false;
    const before = this.seenRaw;
    this.sight = new Map();
    this.seenRaw = new Map();
    this.trend = new Map();

    let seenSelf = false;
    for (const p of msg.players) {
      if (p.id === this.id) {
        seenSelf = true;
        this.alive = p.alive;
        this.lastSelf = clampToArena(p, msg.size, PLAYER_RADIUS);
      } else if (p.alive) {
        this.sight.set(p.id, clampToArena(p, msg.size, PLAYER_RADIUS));
        this.seenRaw.set(p.id, { x: p.x, y: p.y });
        const old = before.get(p.id);
        if (old) this.trend.set(p.id, { x: p.x - old.x, y: p.y - old.y });
      }
    }
    if (!seenSelf) this.alive = false;
    this.me = { ...this.lastSelf };
  }

  private beginBlackout(now: number): void {
    this.darkStart = now;
    this.lastThink = now;
    this.move = STILL;
    const reach = Math.max(0, ((this.durationMs - MOVE_MARGIN_MS) / 1000) * MOVE_SPEED * REACH_EFFICIENCY);
    const spot = this.chooseSpot(reach);
    this.plan = {
      ...spot,
      aim: this.chooseAim(spot.dest),
      stopAt: now + this.durationMs - MOVE_MARGIN_MS,
      commitAt: now + this.durationMs - COMMIT_LEAD_MS,
      committed: false,
    };
  }

  /** Dead reckoning between the server's position reports. */
  private advance(now: number): void {
    const dt = Math.min((now - this.lastThink) / 1000, 0.1);
    this.lastThink = now;
    if (this.fresh) this.fresh = false;
    else this.me = stepPlayer(this.me, this.move.mx, this.move.my, dt, this.world);
  }

  /** Walking rarely ends exactly where it was planned; if it did not, aim from where it did. */
  private commit(plan: Plan): void {
    plan.committed = true;
    if (dist(this.me, plan.dest) > 20) plan.aim = this.chooseAim(this.me);
  }

  // --- movement -----------------------------------------------------------------

  private steer(plan: Plan): { mx: number; my: number } {
    const target = plan.via && dist(this.me, plan.dest) > VIA_DONE ? plan.via : plan.dest;
    const d = dist(this.me, target);
    if (target === plan.dest && d <= ARRIVE) return STILL;

    const heading = this.freeHeading(Math.atan2(target.y - this.me.y, target.x - this.me.x), Math.min(d, LOOKAHEAD));
    const power = target === plan.dest ? Math.min(1, d / SLOW_RADIUS) : 1;
    return { mx: Math.cos(heading) * power, my: Math.sin(heading) * power };
  }

  /** The wanted heading, or the nearest one that does not walk into a solid, so the bot curves round pillars. */
  private freeHeading(wanted: number, look: number): number {
    if (this.clearAhead(wanted, look)) return wanted;
    for (let k = 1; k <= 6; k++) {
      for (const sign of [1, -1]) {
        const h = wanted + sign * k * 0.3;
        if (this.clearAhead(h, look)) return h;
      }
    }
    return wanted;
  }

  private clearAhead(heading: number, look: number): boolean {
    const to = { x: this.me.x + Math.cos(heading) * look, y: this.me.y + Math.sin(heading) * look };
    return this.pathClear(this.me, to, LOOKAHEAD / 4);
  }

  private walkable(p: Vec): boolean {
    return dist(collide(p, PLAYER_RADIUS, this.world), p) < 1;
  }

  private pathClear(a: Vec, b: Vec, step = 24): boolean {
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (!this.walkable({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
    }
    return true;
  }

  // --- where to stand -----------------------------------------------------------

  private chooseSpot(reach: number): Spot {
    const stay: Spot = { dest: { ...this.me }, via: null };
    if (this.rng() < this.profile.hesitate) return stay;
    const spots = this.candidateSpots(reach);
    if (spots.length === 0) return stay;
    if (this.difficulty === 'easy') return spots[Math.floor(this.rng() * spots.length)]!;

    const ranked = this.rankSpots(spots);
    // Hard picks among its best few so a rival cannot learn where it will stand.
    const pool = this.difficulty === 'hard' ? 3 : 1;
    return ranked[Math.floor(this.rng() ** 2 * Math.min(pool, ranked.length))]!;
  }

  private candidateSpots(reach: number): Spot[] {
    const spots: Spot[] = [];
    // Many throws land outside the wall margin, so keep throwing until there are enough that fit.
    for (let i = 0; i < this.profile.spots * 4 && spots.length < this.profile.spots; i++) {
      const dest = this.randomSpot(reach);
      if (this.usable(dest, this.me)) spots.push({ dest, via: null });
    }
    if (this.rng() < this.profile.teleportChance) {
      const hop = this.teleportSpot(reach);
      if (hop) spots.push(hop);
    }
    return spots;
  }

  private randomSpot(reach: number): Vec {
    const angle = this.rng() * Math.PI * 2;
    const low = Math.min(MIN_TRAVEL, reach);
    const r = low + Math.sqrt(this.rng()) * (reach - low);
    return { x: this.me.x + Math.cos(angle) * r, y: this.me.y + Math.sin(angle) * r };
  }

  /** Inside the wall with a margin, off solids, off conveyors, and walkable from `from`. */
  private usable(d: Vec, from: Vec): boolean {
    if (dist(clampToArena(d, this.world.size, WALL_MARGIN), d) > 1 || !this.walkable(d)) return false;
    const drift = conveyorAt(d, this.world);
    return drift.vx === 0 && drift.vy === 0 && this.pathClear(from, d);
  }

  private teleportSpot(reach: number): Spot | null {
    const pads = activeObstacles(this.world).filter((o): o is Pad => o.kind === 'teleporter');
    const entry = pads[Math.floor(this.rng() * pads.length)];
    const exit = entry && pads.find((p) => p.id === entry.to);
    if (!entry || !exit) return null;

    const via = { x: entry.x, y: entry.y };
    const dest = { x: exit.x, y: exit.y };
    if (dist(this.me, via) > reach || !this.pathClear(this.me, via) || !this.usable(dest, dest)) return null;
    return { dest, via };
  }

  /**
   * Best first. Opponents will fire at where this bot was last seen, so a good
   * spot is far from those lines and, where the map has obstacles, out of sight.
   */
  private rankSpots(spots: Spot[]): Spot[] {
    const threats = this.threats();
    const opponents = [...this.sight.values()];
    const cover = this.world.layout.obstacles.length > 0 && this.rng() < this.profile.coverChance;
    const centre = centroid(opponents);

    const scored = spots.map((spot) => {
      let score = 2 * this.safety(spot.dest, threats) + 0.3 * (1 - Math.min(1, dist(spot.dest, centre) / this.world.size));
      if (cover) score += 1.6 * this.hiddenFraction(spot.dest, opponents);
      return { spot, score: score + this.rng() * 0.05 };
    });
    return scored.sort((a, b) => b.score - a.score).map((s) => s.spot);
  }

  /** The beams opponents would fire if they aimed at this bot's last-seen position. */
  private threats(): Segment[] {
    const out: Segment[] = [];
    for (const from of this.sight.values()) {
      const length = dist(from, this.lastSelf);
      if (length < 1) continue;
      const dir = { x: (this.lastSelf.x - from.x) / length, y: (this.lastSelf.y - from.y) / length };
      out.push(...beamFrom(from, dir, this.world));
    }
    return out;
  }

  private safety(d: Vec, threats: Segment[]): number {
    if (threats.length === 0) return 0;
    const closest = distToSegments(threats, d);
    return Math.min(closest, 220) / 220 - (closest < DANGER_RADIUS ? 1.5 : 0);
  }

  /** Share of opponents whose line to `d` is stopped by an obstacle before it arrives. */
  private hiddenFraction(d: Vec, opponents: Vec[]): number {
    if (opponents.length === 0) return 0;
    let hidden = 0;
    for (const from of opponents) {
      const length = dist(from, d);
      if (length < 1) continue;
      const first = beamFrom(from, { x: (d.x - from.x) / length, y: (d.y - from.y) / length }, this.world)[0];
      if (first && Math.hypot(first.ex - first.ox, first.ey - first.oy) < length - HIT_RADIUS) hidden++;
    }
    return hidden / opponents.length;
  }

  // --- where to shoot -----------------------------------------------------------

  private chooseAim(from: Vec): number {
    const targets = this.targets();
    if (targets.length === 0) return Math.atan2(-from.y, -from.x);

    const error = (this.rng() * 2 - 1) * this.profile.aimError;
    if (this.difficulty === 'easy') {
      const pick = targets[Math.floor(this.rng() * targets.length)]!;
      return angleTo(from, pick[0]!) + error;
    }

    let best = 0;
    let bestScore = -Infinity;
    for (const angle of this.aimCandidates(from, targets)) {
      const score = this.scoreAim(angle, from, targets) + this.rng() * 0.01;
      if (score > bestScore) {
        best = angle;
        bestScore = score;
      }
    }
    return best + error;
  }

  /**
   * Straight shots at each guess. Hard adds lines between neighbouring targets,
   * so one beam can pierce two, and a full sweep when the direct lines fail or
   * mirrors are about: bank shots are found by tracing, not by geometry.
   */
  private aimCandidates(from: Vec, targets: Sample[][]): number[] {
    const hard = this.difficulty === 'hard';
    const primary = targets.map((t) => angleTo(from, t[0]!));
    const angles = (hard ? targets.flat() : targets.map((t) => t[0]!)).map((s) => angleTo(from, s));
    if (!hard) return angles;

    for (let i = 0; i < primary.length; i++) {
      for (let j = i + 1; j < primary.length; j++) {
        const gap = wrap(primary[j]! - primary[i]!);
        if (Math.abs(gap) < 0.6) angles.push(primary[i]! + gap / 2);
      }
    }
    const mirrors = activeObstacles(this.world).some((o) => o.kind === 'mirror');
    const direct = Math.max(...angles.map((a) => this.scoreAim(a, from, targets)));
    if (mirrors || direct < 1) {
      for (let a = -Math.PI; a < Math.PI; a += SWEEP_STEP) angles.push(a);
    }
    return angles;
  }

  /** Expected opponents hit, minus a heavy penalty for a bounce that comes back to the shooter. */
  private scoreAim(angle: number, from: Vec, targets: Sample[][]): number {
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const origin = { x: from.x + dir.x * BARREL_LENGTH, y: from.y + dir.y * BARREL_LENGTH };
    const segments = traceBeam(origin, dir, this.world).segments;

    let score = 0;
    for (const samples of targets) {
      let hit = 0;
      for (const s of samples) {
        const d = distToSegments(segments, s);
        if (d <= HIT_RADIUS) hit += s.w;
        else if (d < HIT_RADIUS + SOFT_HIT) hit += (s.w * (1 - (d - HIT_RADIUS) / SOFT_HIT)) / 2;
      }
      score += Math.min(hit, 1);
    }
    if (distToSegments(segments.slice(1), from) <= HIT_RADIUS) score -= 2;
    return score;
  }

  /** Guesses per opponent, best guess first. */
  private targets(): Sample[][] {
    const size = this.world.size;
    const guess = (p: Vec, t: Vec, k: number, w: number): Sample => ({
      ...clampToArena({ x: p.x + t.x * k, y: p.y + t.y * k }, size, PLAYER_RADIUS),
      w,
    });

    return [...this.sight].map(([id, seen]) => {
      const trend = capLength(this.trend.get(id) ?? { x: 0, y: 0 }, MAX_TREND);
      if (this.difficulty === 'easy') return [guess(seen, trend, 0, 1)];
      if (this.difficulty === 'normal') return [guess(seen, trend, 0.5, 1)];
      return [guess(seen, trend, 0, 0.45), guess(seen, trend, 0.5, 0.35), guess(seen, trend, 1, 0.2)];
    });
  }
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleTo(from: Vec, to: Vec): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function centroid(points: Vec[]): Vec {
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

function capLength(v: Vec, max: number): Vec {
  const length = Math.hypot(v.x, v.y);
  return length > max ? { x: (v.x / length) * max, y: (v.y / length) * max } : v;
}

function beamFrom(from: Vec, dir: Vec, world: World): Segment[] {
  const origin = { x: from.x + dir.x * BARREL_LENGTH, y: from.y + dir.y * BARREL_LENGTH };
  return traceBeam(origin, dir, world).segments;
}

function distToSegments(segments: readonly Segment[], p: Vec): number {
  let best = Infinity;
  for (const s of segments) {
    const dx = s.ex - s.ox;
    const dy = s.ey - s.oy;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - s.ox) * dx + (p.y - s.oy) * dy) / len2));
    best = Math.min(best, Math.hypot(s.ox + dx * t - p.x, s.oy + dy * t - p.y));
  }
  return best;
}
