import { PLAYER_RADIUS } from '../shared/constants.js';
import type { MapId } from '../shared/maps.js';
import type { LobbyPlayer, MiniExtra } from '../shared/protocol.js';
import {
  FLOE_SEGMENTS,
  SUMO_FALL_MS,
  freshFloe,
  offIce,
  stepSumo,
  sumoSpawns,
  type Body,
  type Crack,
  type Hit,
  type Shove,
} from '../shared/sumo.js';
import type { Broadcast } from './match.js';
import { MiniMatch, recent, type MiniMatchPlayer } from './mini.js';

/** How often a wedge of ice starts to go, and how much it loses. */
const CRACK_EVERY_MS = 4200;
const CRACK_WARN_MS = 1600;
const CRACK_SPAN = [2, 5] as const;
const CRACK_BITE = 90;
/** The ice never melts away entirely; it just stops being worth standing on. */
const MIN_FLOE = 150;

/** What a collision does: a shove from a dash hits far harder than a bump. */
const BUMP = 0.9;
const SHOVE_SPEED = 620;

/**
 * Sumo.
 *
 * No weapons, no cover, just momentum. Fighters slide on ice that keeps
 * breaking back in wedges, and a dash turns a fighter into a projectile. Last
 * one still on the ice takes it.
 */
export class SumoMatch extends MiniMatch {
  readonly kind = 'sumo' as const;

  private bodies = new Map<string, Body>();
  private floe = freshFloe();
  private cracking: Crack[] = [];
  private nextCrackAt: number;
  private hits: Hit[] = [];
  private shoves: Shove[] = [];
  private bounces: string[] = [];
  private falls: { id: string; x: number; y: number; at: number }[] = [];

  constructor(roster: readonly LobbyPlayer[], send: Broadcast, now: number, map: MapId) {
    super(roster, send, now, map, sumoSpawns(roster.length));
    this.round = 1;
    for (const p of this.players) this.bodies.set(p.id, { x: p.x, y: p.y, vx: 0, vy: 0, charge: 0, cool: 0 });
    this.nextCrackAt = now + CRACK_EVERY_MS;
    this.announce();
  }

  protected advance(now: number, dt: number): void {
    this.bounces = [];
    this.slide(dt);
    this.collide(now);
    this.melt(now, dt);
    this.drop(now);
    this.hits = recent(this.hits, now);
    this.shoves = recent(this.shoves, now);
    this.falls = recent(this.falls, now);
  }

  private slide(dt: number): void {
    for (const p of this.standing()) {
      const body = this.bodies.get(p.id)!;
      const next = stepSumo(body, p.mx, p.my, dt, p.action);
      p.action = false;
      this.bodies.set(p.id, next);
      p.x = next.x;
      p.y = next.y;
    }
  }

  /**
   * Fighters are solid. They are pushed apart and trade momentum, and a
   * fighter mid-dash puts most of their speed into whoever they caught.
   */
  private collide(now: number): void {
    const standing = this.standing();
    for (let i = 0; i < standing.length; i++) {
      for (let j = i + 1; j < standing.length; j++) {
        const a = standing[i]!;
        const b = standing[j]!;
        const ba = this.bodies.get(a.id)!;
        const bb = this.bodies.get(b.id)!;
        const dx = bb.x - ba.x;
        const dy = bb.y - ba.y;
        const d = Math.hypot(dx, dy);
        const clear = PLAYER_RADIUS * 2;
        if (d >= clear || d === 0) continue;

        const nx = dx / d;
        const ny = dy / d;
        const overlap = (clear - d) / 2;
        ba.x -= nx * overlap;
        ba.y -= ny * overlap;
        bb.x += nx * overlap;
        bb.y += ny * overlap;

        // Closing speed along the line between them is what gets exchanged.
        const closing = (bb.vx - ba.vx) * nx + (bb.vy - ba.vy) * ny;
        const push = -closing * BUMP;
        ba.vx -= nx * push;
        ba.vy -= ny * push;
        bb.vx += nx * push;
        bb.vy += ny * push;

        if (ba.charge > 0) this.shove(a, b, bb, nx, ny, now);
        if (bb.charge > 0) this.shove(b, a, ba, -nx, -ny, now);

        this.hits.push({ a: a.id, b: b.id, at: now });
        this.bounces.push(a.id, b.id);
        a.x = ba.x;
        a.y = ba.y;
        b.x = bb.x;
        b.y = bb.y;
      }
    }
  }

  /** A landed dash: the one who was hit leaves at speed, and it counts. */
  private shove(
    by: MiniMatchPlayer,
    onto: MiniMatchPlayer,
    body: Body,
    nx: number,
    ny: number,
    now: number,
  ): void {
    body.vx = nx * SHOVE_SPEED;
    body.vy = ny * SHOVE_SPEED;
    this.shoves.push({ by: by.id, id: onto.id, at: now });
    by.score++;
  }

  /** Wedges of ice are given a warning, then they break back. */
  private melt(now: number, dt: number): void {
    for (const crack of this.cracking) crack.in -= dt * 1000;
    const gone = this.cracking.filter((c) => c.in <= 0);
    for (const crack of gone) {
      for (let k = 0; k < crack.n; k++) {
        const segment = (crack.s + k) % FLOE_SEGMENTS;
        this.floe[segment] = crack.to[k] ?? this.floe[segment]!;
      }
    }
    if (gone.length > 0) this.cracking = this.cracking.filter((c) => c.in > 0);

    if (now < this.nextCrackAt) return;
    this.nextCrackAt = now + CRACK_EVERY_MS;
    const n = CRACK_SPAN[0] + Math.floor(Math.random() * (CRACK_SPAN[1] - CRACK_SPAN[0] + 1));
    const s = Math.floor(Math.random() * FLOE_SEGMENTS);
    const to = Array.from({ length: n }, (_, k) => {
      const segment = (s + k) % FLOE_SEGMENTS;
      return Math.max(MIN_FLOE, (this.floe[segment] ?? 0) - CRACK_BITE);
    });
    this.cracking.push({ s, n, in: CRACK_WARN_MS, to });
  }

  /** Off the edge of your own wedge and you are in the water. */
  private drop(now: number): void {
    for (const p of this.standing()) {
      if (!offIce(p, this.floe)) continue;
      this.falls.push({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), at: now });
      this.eliminate(p);
    }
  }

  protected override left(): number {
    const next = this.cracking.reduce((soonest, c) => Math.min(soonest, c.in), Infinity);
    return Number.isFinite(next) ? Math.max(0, next) : Math.max(0, this.nextCrackAt - this.now);
  }

  protected extra(): MiniExtra {
    const now = this.now;
    const vel: Record<string, [number, number]> = {};
    const charging: Record<string, number> = {};
    const cooldowns: Record<string, number> = {};
    const dashing: string[] = [];
    for (const p of this.standing()) {
      const body = this.bodies.get(p.id);
      if (!body) continue;
      vel[p.id] = [Math.round(body.vx), Math.round(body.vy)];
      charging[p.id] = Math.round(body.charge);
      cooldowns[p.id] = Math.round(body.cool);
      if (body.charge > 0) dashing.push(p.id);
    }
    return {
      kind: 'sumo',
      floe: this.floe.map((r) => Math.round(r)),
      cracking: this.cracking.map((c) => ({ ...c, in: Math.round(c.in), to: [...c.to] })),
      vel,
      charging,
      cooldowns,
      hits: this.hits,
      shoves: this.shoves,
      bounces: [...new Set(this.bounces)],
      falls: this.falls.filter((f) => now - f.at <= SUMO_FALL_MS * 2),
      dashing,
    };
  }
}
