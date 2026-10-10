/**
 * Sumo: a melting disc of ice. Nobody has a weapon — fighters slide, build up
 * speed and shove, and the floor itself keeps getting smaller.
 */
export const SUMO_WORLD = { w: 1200, h: 1200 } as const;

/** The ice is one disc cut into wedges, each able to break back on its own. */
export const FLOE_SEGMENTS = 24;
export const SEGMENT_ARC = (Math.PI * 2) / FLOE_SEGMENTS;
export const FLOE_RADIUS = 520;

/** Push, top speed on the ice, and the drag that bleeds it off again. */
export const ACCEL = 1100;
export const MAX_SPEED = 420;
export const FRICTION = 60;
const DRAG = 1.2;

/** A dash: fast, briefly uncontrollable, and the only way to shove hard. */
export const DASH_SPEED = 900;
export const DASH_MS = 280;
export const DASH_COOLDOWN_MS = 1500;
/** How much steering a fighter keeps mid-dash. */
export const DASH_STEER = 0.25;
/** Speed a dash leaves you at once it runs out. */
export const DASH_EXIT_SPEED = 520;

/** How long a fighter spends going over the edge before they are gone. */
export const SUMO_FALL_MS = 950;

/** Two fighters meeting, for the crunch and the dust. */
export interface Hit {
  a: string;
  b: string;
  at: number;
}

/** A shove that landed: who did it, to whom. */
export interface Shove {
  by: string;
  id: string;
  at: number;
}

/** A wedge of ice on the way out: where it starts, how wide, and what is left. */
export interface Crack {
  /** First segment of the run. */
  s: number;
  /** How many segments it covers. */
  n: number;
  /** Milliseconds until it gives. */
  in: number;
  /** Radius each of those segments is headed for. */
  to: number[];
}

export interface SumoExtra {
  /** How far the ice reaches in each wedge. */
  floe: number[];
  cracking: Crack[];
  /** Velocity per fighter, so the client can draw a slide it did not predict. */
  vel: Record<string, [number, number]>;
  charging: Record<string, number>;
  cooldowns: Record<string, number>;
  hits: Hit[];
  shoves: Shove[];
  /** Fighters bounced off each other this tick, by id. */
  bounces: string[];
  falls: { id: string; x: number; y: number; at: number }[];
  dashing: string[];
}

/** A fighter on the ice carries momentum, a dash and its cooldown. */
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Milliseconds of dash left. */
  charge: number;
  /** Milliseconds until another dash is allowed. */
  cool: number;
}

export const freshFloe = (): number[] => new Array(FLOE_SEGMENTS).fill(FLOE_RADIUS);

/** Which wedge a point sits in. */
export function segmentAt(x: number, y: number): number {
  const a = Math.atan2(y, x);
  return Math.min(FLOE_SEGMENTS - 1, Math.floor((a < 0 ? a + Math.PI * 2 : a) / SEGMENT_ARC));
}

/** True once a fighter is out past the ice in their own wedge. */
export function offIce(p: { x: number; y: number }, floe: readonly number[]): boolean {
  const reach = floe[segmentAt(p.x, p.y)] ?? 0;
  return Math.hypot(p.x, p.y) > reach;
}

/** Where a dash goes: where you are pointing, or where you were already sliding. */
function dashDirection(body: Body, mx: number, my: number): { x: number; y: number } | null {
  const held = Math.hypot(mx, my);
  if (held > 0.05) return { x: mx / held, y: my / held };
  const speed = Math.hypot(body.vx, body.vy);
  return speed > 30 ? { x: body.vx / speed, y: body.vy / speed } : null;
}

/**
 * One step of ice physics. Written once and run on both sides: the server
 * decides, and the client predicts its own fighter with the same arithmetic.
 */
export function stepSumo(body: Body, mx: number, my: number, dt: number, action: boolean): Body {
  if (dt <= 0) return { ...body };

  const held = Math.hypot(mx, my);
  const scale = held > 1 ? 1 / held : 1;
  const ix = mx * scale;
  const iy = my * scale;

  let { vx, vy, charge, cool } = body;

  if (action && cool <= 0 && charge <= 0) {
    const dir = dashDirection(body, ix, iy);
    if (dir) {
      vx = dir.x * DASH_SPEED;
      vy = dir.y * DASH_SPEED;
      charge = DASH_MS;
      cool = DASH_COOLDOWN_MS;
    }
  }

  const dashing = charge > 0;
  const before = Math.hypot(vx, vy);
  const push = ACCEL * (dashing ? DASH_STEER : 1) * dt;
  vx += ix * push;
  vy += iy * push;

  // A shove or a dash can leave a fighter over the normal top speed; the cap
  // never slows them below what they already had, it only stops them pushing further.
  const pushed = Math.hypot(vx, vy);
  const cap = Math.max(dashing ? DASH_SPEED : MAX_SPEED, before);
  if (pushed > cap) {
    vx *= cap / pushed;
    vy *= cap / pushed;
  }

  const speed = Math.hypot(vx, vy);
  if (speed > 0) {
    const kept = ((dashing ? speed : Math.max(0, speed - FRICTION * dt)) * Math.exp(-DRAG * (dashing ? DASH_STEER : 1) * dt)) / speed;
    vx *= kept;
    vy *= kept;
  }

  const left = Math.max(0, charge - dt * 1000);
  if (charge > 0 && left === 0) {
    // Coming out of a dash: keep the direction, drop to a speed you can steer.
    const speedNow = Math.hypot(vx, vy);
    if (speedNow > DASH_EXIT_SPEED) {
      vx *= DASH_EXIT_SPEED / speedNow;
      vy *= DASH_EXIT_SPEED / speedNow;
    }
  }

  const limit = SUMO_WORLD.w / 2;
  return {
    x: Math.max(-limit, Math.min(limit, body.x + vx * dt)),
    y: Math.max(-limit, Math.min(limit, body.y + vy * dt)),
    vx,
    vy,
    charge: left,
    cool: Math.max(0, cool - dt * 1000),
  };
}

/** Spawns on a ring well inside the ice. */
export function sumoSpawns(count: number): { x: number; y: number; aim: number }[] {
  const r = FLOE_RADIUS * 0.55;
  return Array.from({ length: count }, (_, i) => {
    const a = (i * 2 * Math.PI) / count - Math.PI / 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, aim: a + Math.PI };
  });
}
