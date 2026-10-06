export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
export const BROADCAST_HZ = 20;

export const PLAYER_RADIUS = 28;
export const BARREL_LENGTH = 34;
/**
 * How close a beam has to pass to count. Wider than the collision radius on
 * purpose: it covers the whole drawn fighter, so a beam that visibly crosses a
 * shoulder or a leg is a hit.
 */
export const HIT_RADIUS = 38;

/**
 * Units per second, set so one blackout covers the full width of a stage-one
 * arena: relocation is unrestricted, and nobody is stuck near where they were
 * last seen. Movement is instantaneous — no acceleration curve, no momentum —
 * so the fighter answers the keyboard on the same frame.
 */
export const MOVE_SPEED = 440;

/** Each blackout lasts a random length inside this window, announced as it starts. */
export const BLACKOUT_MIN_MS = 2400;
export const BLACKOUT_MAX_MS = 3000;

/** Warning flicker: two environment-only pulses, always ahead of the snap. */
export const FLICKER_PULSES: readonly [number, number][] = [
  [1900, 1970],
  [2080, 2150],
];

export const LIGHTS_ON_MS = 1400;
export const LIGHTS_ON_SHRINK_MS = 2200;
/** Beams hang in full light before anyone drops, so you can read what hit you. */
export const RESOLVE_DELAY_MS = 250;
export const SHRINK_ANIM_MS = 800;
/** The perimeter flags the doomed ring before the wall actually moves. */
export const SHRINK_WARN_MS = 420;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/** Short, and only once everyone has said they are ready. */
export const LOBBY_COUNTDOWN_MS = 5_000;
export const ROOM_GRACE_MS = 60_000;

/**
 * Compact on purpose. A bigger floor only reads as empty space, and it would
 * put the far wall out of reach during a blackout.
 */
export const ARENA_BASE_SIZE: Record<number, number> = {
  2: 720,
  3: 800,
  4: 880,
  5: 960,
  6: 1040,
};

export const STAGE_SCALE = [1.0, 0.8, 0.62, 0.45, 0.32] as const;
export const STAGE_COUNT = STAGE_SCALE.length;
/** Stage thresholds as a fraction of the starting player count. */
export const STAGE_THRESHOLDS = [0.8, 0.6, 0.4, 0.25] as const;
/** Rounds without an elimination before the arena shrinks anyway. */
export const STALL_ROUNDS = 3;

/**
 * Six suits that stay apart on a cold grey floor without turning the screen
 * into a neon sign: each one is a muted body colour with a brighter trim.
 */
export const PLAYER_COLORS = [
  '#d8433f',
  '#3f86c4',
  '#c9a23c',
  '#56a86b',
  '#b4588e',
  '#c96a33',
] as const;

export const SIGHT_RADIUS = 115;
