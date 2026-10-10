import { describe, expect, it } from 'vitest';
import { MOVE_SPEED, PLAYER_RADIUS, TICK_MS } from './constants.js';
import {
  COLLAPSE_WORLD,
  OUTER_RING,
  TILE,
  TILE_GONE,
  TILE_SOLID,
  collapseSpawns,
  ring,
  solidFloor,
  standingOnNothing,
  stepCollapse,
  tileAt,
  tileCentre,
  tileCount,
} from './collapse.js';
import {
  FREEZE_FINISH_Y,
  FREEZE_SPEED,
  FREEZE_WORLD,
  clampToCorridor,
  freezeSpawns,
  isHome,
  stepFreeze,
} from './freeze.js';
import { GAME_IDS, GAME_MIN_PLAYERS, GAME_NAMES, isGameId, isMiniGameId } from './games.js';
import {
  HOLDER_SPEED,
  POTATO_PILLARS,
  POTATO_WORLD,
  bombCount,
  clampToPotato,
  potatoSpawns,
  stepPotato,
} from './potato.js';
import {
  DANCE_RADIUS,
  FLOOR_RADIUS,
  ROOM_COUNT,
  ROOM_SPAN,
  clampToRooms,
  fromRoom,
  roomOf,
  roomsSpawns,
  standable,
  stepRooms,
  type RoomState,
} from './rooms.js';
import {
  DASH_MS,
  DASH_SPEED,
  FLOE_RADIUS,
  FLOE_SEGMENTS,
  MAX_SPEED,
  freshFloe,
  offIce,
  segmentAt,
  stepSumo,
  sumoSpawns,
  type Body,
} from './sumo.js';

const dt = TICK_MS / 1000;
const open = (): RoomState[] =>
  Array.from({ length: ROOM_COUNT }, () => ({ open: true, locked: false, outcome: null }));
const shut = (): RoomState[] =>
  Array.from({ length: ROOM_COUNT }, () => ({ open: false, locked: true, outcome: null }));

describe('the games', () => {
  it('names and sizes every game it lists', () => {
    for (const id of GAME_IDS) {
      expect(GAME_NAMES[id]).toBeTruthy();
      expect(GAME_MIN_PLAYERS[id]).toBeGreaterThanOrEqual(2);
    }
  });

  it('counts DeadLight as a game but not as one of the lit ones', () => {
    expect(isGameId('deadlight')).toBe(true);
    expect(isMiniGameId('deadlight')).toBe(false);
    expect(isMiniGameId('sumo')).toBe(true);
    expect(isGameId('classic')).toBe(false);
  });

  it('needs three for a game of Rooms, since two can only ever answer "two"', () => {
    expect(GAME_MIN_PLAYERS.rooms).toBeGreaterThan(2);
  });
});

describe('Freeze', () => {
  it('runs slower than DeadLight, and no faster on the diagonal', () => {
    const straight = stepFreeze({ x: 0, y: 0 }, 0, 1, dt);
    const diagonal = stepFreeze({ x: 0, y: 0 }, 1, 1, dt);
    expect(straight.y).toBeCloseTo(FREEZE_SPEED * dt, 6);
    expect(FREEZE_SPEED).toBeLessThan(MOVE_SPEED);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(FREEZE_SPEED * dt, 6);
  });

  it('keeps fighters off the corridor walls', () => {
    const out = clampToCorridor({ x: 9000, y: -9000 });
    expect(out.x).toBeCloseTo(FREEZE_WORLD.w / 2 - PLAYER_RADIUS, 6);
    expect(out.y).toBeCloseTo(-(FREEZE_WORLD.h / 2 - PLAYER_RADIUS), 6);
  });

  it('starts the pack behind the line and spread across the corridor', () => {
    const spawns = freezeSpawns(6);
    expect(spawns).toHaveLength(6);
    for (const s of spawns) {
      expect(s.y).toBeLessThan(FREEZE_FINISH_Y);
      expect(isHome(s)).toBe(false);
      expect(Math.abs(s.x)).toBeLessThan(FREEZE_WORLD.w / 2 - PLAYER_RADIUS);
    }
    const xs = spawns.map((s) => s.x);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('is home once a fighter is past the line', () => {
    expect(isHome({ y: FREEZE_FINISH_Y })).toBe(true);
    expect(isHome({ y: FREEZE_FINISH_Y - 1 })).toBe(false);
  });

  it('stands perfectly still with no input', () => {
    const from = { x: 12, y: -34 };
    expect(stepFreeze(from, 0, 0, dt)).toEqual(from);
  });
});

describe('Collapse', () => {
  it('is an odd square, so one tile is the very middle', () => {
    expect(tileCount).toBe(121);
    expect(ring(60)).toBe(0);
    expect(COLLAPSE_WORLD.w).toBe(1100);
  });

  it('rings tiles outward from the middle', () => {
    expect(ring(0)).toBe(OUTER_RING);
    expect(ring(tileCount - 1)).toBe(OUTER_RING);
    expect(ring(60 + 1)).toBe(1);
  });

  it('finds the tile under a point, and nothing past the floor', () => {
    expect(tileAt({ x: 0, y: 0 })).toBe(60);
    const centre = tileCentre(60);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(0, 6);
    expect(tileAt({ x: COLLAPSE_WORLD.w, y: 0 })).toBeNull();
    expect(tileAt({ x: -TILE * 5.5 - 1, y: 0 })).toBeNull();
  });

  it('drops a fighter standing over a hole, and only over a hole', () => {
    const floor = solidFloor();
    expect(standingOnNothing({ x: 0, y: 0 }, floor)).toBe(false);
    const holed = floor.split('');
    holed[60] = TILE_GONE;
    expect(standingOnNothing({ x: 0, y: 0 }, holed.join(''))).toBe(true);
    expect(standingOnNothing({ x: 0, y: 0 }, floor.replace(TILE_SOLID, TILE_SOLID))).toBe(false);
  });

  it('keeps movement inside the floor and off the diagonal advantage', () => {
    const far = stepCollapse({ x: 540, y: 540 }, 1, 1, 1, MOVE_SPEED);
    expect(far.x).toBeLessThanOrEqual(COLLAPSE_WORLD.w / 2);
    expect(far.y).toBeLessThanOrEqual(COLLAPSE_WORLD.h / 2);
    const diagonal = stepCollapse({ x: 0, y: 0 }, 1, 1, dt, MOVE_SPEED);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(MOVE_SPEED * dt, 6);
  });

  it('spawns everyone on the floor, off the middle tile', () => {
    for (const s of collapseSpawns(8)) {
      const tile = tileAt(s);
      expect(tile).not.toBeNull();
      expect(tile).not.toBe(60);
    }
  });
});

describe('Rooms', () => {
  it('lets a fighter stand on the floor and inside a room', () => {
    expect(standable({ x: 0, y: 0 }, open().map((r) => r.open))).toBe(true);
    const inside = fromRoom(0, ROOM_SPAN.at + ROOM_SPAN.depth / 2, 0);
    expect(standable(inside, open().map((r) => r.open))).toBe(true);
    expect(roomOf(inside)).toBe(0);
  });

  it('counts nobody on the dance floor as being in a room', () => {
    expect(roomOf({ x: 0, y: 0 })).toBeNull();
    expect(roomOf({ x: 0, y: -FLOOR_RADIUS + 1 })).toBeNull();
  });

  it('shuts the doorway once the doors are locked', () => {
    const door = fromRoom(2, ROOM_SPAN.at, 0);
    expect(standable(door, open().map((r) => r.open))).toBe(true);
    const closed = clampToRooms(door, shut().map((r) => r.open));
    expect(standable(closed, shut().map((r) => r.open))).toBe(true);
  });

  it('never leaves a fighter inside a wall', () => {
    const doors = open().map((r) => r.open);
    for (let i = 0; i < ROOM_COUNT; i++) {
      const wall = fromRoom(i, ROOM_SPAN.at + ROOM_SPAN.depth / 2, ROOM_SPAN.halfHeight + 40);
      expect(standable(clampToRooms(wall, doors), doors)).toBe(true);
    }
  });

  it('turns the middle of the floor only while the music plays', () => {
    const rooms = open();
    const at = { x: DANCE_RADIUS * 0.5, y: 0 };
    const dancing = stepRooms(at, 0, 0, dt, { phase: 'music', rooms });
    const counting = stepRooms(at, 0, 0, dt, { phase: 'count', rooms });
    expect(Math.hypot(dancing.x - at.x, dancing.y - at.y)).toBeGreaterThan(0);
    expect(counting).toEqual(at);
  });

  it('leaves the far side of the floor still, music or not', () => {
    const rooms = open();
    const edge = { x: FLOOR_RADIUS - 2, y: 0 };
    expect(stepRooms(edge, 0, 0, dt, { phase: 'music', rooms })).toEqual(edge);
  });

  it('walks into a room without crossing the door frame', () => {
    const rooms = open();
    let at = { x: 0, y: 0 };
    const to = ROOM_SPAN.at + ROOM_SPAN.depth / 2;
    for (let i = 0; i < 200; i++) at = stepRooms(at, 0, -1, dt, { phase: 'count', rooms });
    expect(roomOf(at)).toBe(0);
    expect(Math.abs(at.y)).toBeGreaterThan(ROOM_SPAN.at);
    expect(Math.abs(at.y)).toBeLessThanOrEqual(to + ROOM_SPAN.depth);
  });

  it('spawns the pack on the floor, clear of the spinning middle', () => {
    for (const s of roomsSpawns(5)) {
      expect(roomOf(s)).toBeNull();
      expect(Math.hypot(s.x, s.y)).toBeGreaterThan(DANCE_RADIUS);
      expect(Math.hypot(s.x, s.y)).toBeLessThan(FLOOR_RADIUS);
    }
  });
});

describe('Sumo', () => {
  const body = (over: Partial<Body> = {}): Body => ({ x: 0, y: 0, vx: 0, vy: 0, charge: 0, cool: 0, ...over });

  it('builds up speed rather than answering the key at once', () => {
    const first = stepSumo(body(), 1, 0, dt, false);
    expect(first.vx).toBeGreaterThan(0);
    expect(first.vx).toBeLessThan(MAX_SPEED);
  });

  it('settles at a top speed it cannot push past', () => {
    let at = body();
    for (let i = 0; i < 400; i++) at = stepSumo(at, 1, 0, dt, false);
    expect(Math.hypot(at.vx, at.vy)).toBeLessThanOrEqual(MAX_SPEED + 1);
    expect(at.vx).toBeGreaterThan(MAX_SPEED * 0.7);
  });

  it('slides to a stop once nobody is pushing', () => {
    let at = body({ vx: MAX_SPEED });
    for (let i = 0; i < 400; i++) at = stepSumo(at, 0, 0, dt, false);
    expect(Math.hypot(at.vx, at.vy)).toBeLessThan(5);
  });

  it('dashes far faster than a fighter can run, and only on the button', () => {
    const dash = stepSumo(body(), 1, 0, dt, true);
    expect(dash.charge).toBeGreaterThan(0);
    expect(Math.hypot(dash.vx, dash.vy)).toBeGreaterThan(MAX_SPEED);
    expect(Math.hypot(dash.vx, dash.vy)).toBeLessThanOrEqual(DASH_SPEED + 1);
  });

  it('will not dash again until the cooldown has run', () => {
    let at = stepSumo(body(), 1, 0, dt, true);
    const cool = at.cool;
    expect(cool).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) at = stepSumo(at, 1, 0, dt, true);
    expect(at.cool).toBeLessThan(cool);
    expect(at.charge).toBe(0);
  });

  it('runs a dash out after its own length', () => {
    let at = stepSumo(body(), 1, 0, dt, true);
    const steps = Math.ceil(DASH_MS / (dt * 1000)) + 1;
    for (let i = 0; i < steps; i++) at = stepSumo(at, 1, 0, dt, false);
    expect(at.charge).toBe(0);
  });

  it('cuts the ice into wedges and knows which one a fighter is in', () => {
    expect(freshFloe()).toHaveLength(FLOE_SEGMENTS);
    expect(segmentAt(1, 0)).toBe(0);
    expect(segmentAt(-1, 0)).toBe(Math.floor(FLOE_SEGMENTS / 2));
    expect(segmentAt(0, -1)).toBeGreaterThan(Math.floor(FLOE_SEGMENTS / 2));
  });

  it('is off the ice only past the edge of your own wedge', () => {
    const floe = freshFloe();
    expect(offIce({ x: 0, y: 0 }, floe)).toBe(false);
    expect(offIce({ x: FLOE_RADIUS - 1, y: 0 }, floe)).toBe(false);
    expect(offIce({ x: FLOE_RADIUS + 1, y: 0 }, floe)).toBe(true);
    floe[0] = 100;
    expect(offIce({ x: 200, y: 0 }, floe)).toBe(true);
    expect(offIce({ x: -200, y: 0 }, floe)).toBe(false);
  });

  it('spawns everyone on the ice', () => {
    for (const s of sumoSpawns(7)) expect(offIce(s, freshFloe())).toBe(false);
  });
});

describe('Hot potato', () => {
  it('makes the holder faster, which is the only kindness it offers', () => {
    const plain = stepPotato({ x: 0, y: -500 }, 1, 0, dt, false);
    const holding = stepPotato({ x: 0, y: -500 }, 1, 0, dt, true);
    expect(holding.x).toBeCloseTo(plain.x * HOLDER_SPEED, 6);
  });

  it('keeps fighters out of the pillars', () => {
    for (const pillar of POTATO_PILLARS) {
      const inside = clampToPotato({ x: pillar.x + 1, y: pillar.y });
      expect(Math.hypot(inside.x - pillar.x, inside.y - pillar.y)).toBeCloseTo(pillar.r + PLAYER_RADIUS, 6);
    }
  });

  it('keeps fighters off the walls', () => {
    const out = clampToPotato({ x: 9000, y: 0 });
    expect(out.x).toBeCloseTo(POTATO_WORLD.w / 2 - PLAYER_RADIUS, 6);
  });

  it('lights a second fuse only once the floor is busy', () => {
    expect(bombCount(3)).toBe(1);
    expect(bombCount(6)).toBe(2);
  });

  it('spawns everyone clear of the pillars', () => {
    for (const s of potatoSpawns(6)) {
      expect(clampToPotato(s).x).toBeCloseTo(s.x, 6);
      expect(clampToPotato(s).y).toBeCloseTo(s.y, 6);
    }
  });
});
