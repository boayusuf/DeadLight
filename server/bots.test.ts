import { afterEach, describe, expect, it, vi } from 'vitest';
import { arenaSize, clampToArena, rayToWall } from '../shared/arena.js';
import { BROADCAST_HZ, HIT_RADIUS, PLAYER_RADIUS, TICK_MS } from '../shared/constants.js';
import { openWorld, type MapId, type MapLayout, type Segment, type World } from '../shared/maps.js';
import { stepPlayer } from '../shared/movement.js';
import type { BotDifficulty, LobbyPlayer, ServerMessage } from '../shared/protocol.js';
import { BOT_NAMES, BotBrain } from './bots.js';
import { Room } from './room.js';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fighter {
  id: string;
  x: number;
  y: number;
  aim?: number;
}

const roster = (ids: string[]): LobbyPlayer[] =>
  ids.map((id) => ({ id, name: id, color: '#fff', ready: true, finisher: 'shatter', wins: 0, bot: true }));

/** Introduces a brain to a match and shows it one lights-on reveal. */
function introduce(brain: BotBrain, fighters: Fighter[], map: MapId = 'reactor'): number {
  const size = arenaSize(fighters.length, 0);
  brain.hear({ t: 'match', players: roster(fighters.map((f) => f.id)), startCount: fighters.length, map, gameMode: 'classic' });
  brain.hear({
    t: 'lights',
    round: 0,
    stage: 0,
    size,
    previousSize: size,
    players: fighters.map((f) => ({ id: f.id, x: f.x, y: f.y, aim: f.aim ?? 0, alive: true })),
    resolution: null,
    remaining: fighters.length,
    holdMs: 1400,
    broken: [],
  });
  return size;
}

interface Blackout {
  path: { x: number; y: number }[];
  end: { x: number; y: number };
  aim: number;
}

/** Plays one blackout the way the server does: apply the input, move, report position at 20 Hz. */
function blackout(brain: BotBrain, start: { x: number; y: number }, world: World, durationMs: number): Blackout {
  brain.hear({ t: 'dark', round: 1, durationMs });
  let pos = { ...start };
  let aim = 0;
  let nextSelf = 0;
  const path = [pos];
  for (let t = 0; t <= durationMs; t += TICK_MS) {
    const input = brain.think(1000 + t);
    if (input) {
      aim = input.aim;
      pos = stepPlayer(pos, input.mx, input.my, TICK_MS / 1000, world);
    }
    if (t >= nextSelf) {
      brain.hear({ t: 'self', x: pos.x, y: pos.y, seq: 0 });
      nextSelf += 1000 / BROADCAST_HZ;
    }
    path.push(pos);
  }
  return { path, end: pos, aim };
}

const diff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** Short enough that the bot has no time to walk: the position it fires from is the one it started on. */
const STAND_STILL_MS = 700;

describe('BotBrain before a match', () => {
  it('has nothing to say', () => {
    const brain = new BotBrain('b', 'hard', seeded(1));
    expect(brain.think(0)).toBeNull();
    brain.hear({ t: 'dark', round: 1, durationMs: 2500 });
    expect(brain.think(10)).toBeNull();
  });

  it('goes quiet again once the match is over', () => {
    const brain = new BotBrain('b', 'normal', seeded(1));
    introduce(brain, [{ id: 'b', x: 0, y: 0 }, { id: 'o', x: 200, y: 0 }]);
    brain.hear({ t: 'dark', round: 1, durationMs: 2500 });
    expect(brain.think(0)).not.toBeNull();
    brain.hear({ t: 'over', winner: 'b', rounds: 1, standings: [], wins: {}, gameMode: 'classic' });
    expect(brain.think(100)).toBeNull();
  });

  it('stops acting once its own fighter is eliminated', () => {
    const brain = new BotBrain('b', 'normal', seeded(1));
    introduce(brain, [{ id: 'b', x: 0, y: 0 }, { id: 'o', x: 200, y: 0 }]);
    brain.hear({
      t: 'lights', round: 1, stage: 0, size: 880, previousSize: 880, resolution: null, remaining: 1, holdMs: 1400, broken: [],
      players: [{ id: 'b', x: 0, y: 0, aim: 0, alive: false }, { id: 'o', x: 200, y: 0, aim: 0, alive: true }],
    });
    brain.hear({ t: 'dark', round: 2, durationMs: 2500 });
    expect(brain.think(0)).toBeNull();
  });
});

describe('BotBrain movement', () => {
  const me = { x: -250, y: 120 };
  const others: Fighter[] = [{ id: 'o', x: 300, y: -100 }];

  for (const difficulty of ['easy', 'normal', 'hard'] as BotDifficulty[]) {
    it(`${difficulty} moves in a blackout and stays inside the wall`, () => {
      let moved = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const brain = new BotBrain('b', difficulty, seeded(seed));
        const size = introduce(brain, [{ id: 'b', ...me }, ...others]);
        const run = blackout(brain, me, openWorld(size), 2700);
        for (const p of run.path) {
          const inside = clampToArena(p, size, 0);
          expect(Math.hypot(inside.x - p.x, inside.y - p.y)).toBeLessThan(1e-6);
        }
        if (Math.hypot(run.end.x - me.x, run.end.y - me.y) > 80) moved++;
      }
      // Easy sometimes hesitates; the others always go somewhere.
      expect(moved).toBeGreaterThanOrEqual(difficulty === 'easy' ? 5 : 12);
    });
  }

  it('keeps clear of the wall as the arena shrinks', () => {
    const brain = new BotBrain('b', 'hard', seeded(7));
    introduce(brain, [{ id: 'b', x: 0, y: 0 }, { id: 'o', x: 100, y: 0 }, { id: 'p', x: 0, y: 100 }]);
    const size = arenaSize(3, 3);
    brain.hear({
      t: 'lights', round: 3, stage: 3, size, previousSize: 800, resolution: null, remaining: 3, holdMs: 2200, broken: [],
      players: [
        { id: 'b', x: 380, y: 0, aim: 0, alive: true },
        { id: 'o', x: -300, y: 0, aim: 0, alive: true },
        { id: 'p', x: 0, y: 200, aim: 0, alive: true },
      ],
    });
    const run = blackout(brain, clampToArena({ x: 380, y: 0 }, size, PLAYER_RADIUS), openWorld(size), 2500);
    const inside = clampToArena(run.end, size, PLAYER_RADIUS);
    expect(Math.hypot(inside.x - run.end.x, inside.y - run.end.y)).toBeLessThan(1e-6);
  });
});

describe('BotBrain aim', () => {
  const me = { x: -250, y: 120 };
  const target = { x: 300, y: -100 };

  it('a normal bot aims within 0.3 rad of a stationary target on an open map', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const brain = new BotBrain('b', 'normal', seeded(seed));
      const size = introduce(brain, [{ id: 'b', ...me }, { id: 'o', ...target }]);
      const run = blackout(brain, me, openWorld(size), 2700);
      expect(diff(run.aim, Math.atan2(target.y - run.end.y, target.x - run.end.x))).toBeLessThan(0.3);
    }
  });

  it('easy is measurably noisier than hard', () => {
    const meanError = (difficulty: BotDifficulty) => {
      let total = 0;
      const runs = 60;
      for (let seed = 1; seed <= runs; seed++) {
        const brain = new BotBrain('b', difficulty, seeded(seed));
        const size = introduce(brain, [{ id: 'b', ...me }, { id: 'o', ...target }]);
        const run = blackout(brain, me, openWorld(size), STAND_STILL_MS);
        total += diff(run.aim, Math.atan2(target.y - me.y, target.x - me.x));
      }
      return total / runs;
    };

    const easy = meanError('easy');
    const hard = meanError('hard');
    expect(hard).toBeLessThan(0.06);
    expect(easy).toBeGreaterThan(hard * 3);
  });

  it('a normal bot leads an opponent that was seen moving', () => {
    let toPrediction = 0;
    let toLastSeen = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const brain = new BotBrain('b', 'normal', seeded(seed));
      const size = introduce(brain, [{ id: 'b', ...me }, { id: 'o', x: 0, y: -300 }]);
      brain.hear({
        t: 'lights', round: 1, stage: 0, size, previousSize: size, resolution: null, remaining: 2, holdMs: 1400, broken: [],
        players: [{ id: 'b', ...me, aim: 0, alive: true }, { id: 'o', x: 0, y: -100, aim: 0, alive: true }],
      });
      const run = blackout(brain, me, openWorld(size), STAND_STILL_MS);
      toPrediction += diff(run.aim, Math.atan2(0 - me.y, 0 - me.x));
      toLastSeen += diff(run.aim, Math.atan2(-100 - me.y, 0 - me.x));
    }
    expect(toPrediction).toBeLessThan(toLastSeen);
  });
});

describe('BotBrain on the mirrors map', () => {
  afterEach(() => {
    vi.doUnmock('../shared/maps.js');
    vi.resetModules();
  });

  /** A pillar between the shooter and the target, and a mirror that bounces a beam round it. */
  const layout: MapLayout = {
    id: 'mirrors',
    obstacles: [
      { id: 'p', kind: 'pillar', x: 0, y: 200, r: 70 },
      { id: 'm', kind: 'mirror', ax: -100, ay: -300, bx: 100, by: -300 },
    ],
  };

  /** Stands in for the real tracer: stops at the pillar, reflects off the one mirror, ends at the wall. */
  function trace(origin: { x: number; y: number }, dir: { x: number; y: number }, world: World) {
    const segments: Segment[] = [];
    let o = { ...origin };
    let d = { ...dir };
    for (let bounce = 0; bounce <= 2; bounce++) {
      const wall = rayToWall(o, d, world.size);
      const pillarT = hitPillar(o, d);
      const mirrorT = hitMirror(o, d);
      const t = Math.min(wall, pillarT, mirrorT);
      segments.push({ ox: o.x, oy: o.y, ex: o.x + d.x * t, ey: o.y + d.y * t });
      if (t !== mirrorT) break;
      o = { x: o.x + d.x * t, y: o.y + d.y * t };
      d = { x: d.x, y: -d.y };
    }
    return { segments, struck: [] as string[] };
  }

  const hitPillar = (o: { x: number; y: number }, d: { x: number; y: number }) => {
    const along = (0 - o.x) * d.x + (200 - o.y) * d.y;
    const off = Math.hypot(o.x + d.x * along, o.y + d.y * along - 200);
    return along > 0 && off < 70 ? along - Math.sqrt(70 * 70 - off * off) : Infinity;
  };

  const hitMirror = (o: { x: number; y: number }, d: { x: number; y: number }) => {
    if (d.y >= -1e-9) return Infinity;
    const t = (-300 - o.y) / d.y;
    const x = o.x + d.x * t;
    return t > 1e-6 && x >= -100 && x <= 100 ? t : Infinity;
  };

  it('a hard bot finds the bank shot when the direct line is blocked', async () => {
    vi.resetModules();
    vi.doMock('../shared/maps.js', async (original) => ({
      ...(await original<typeof import('../shared/maps.js')>()),
      layoutFor: () => layout,
      traceBeam: trace,
    }));
    const { BotBrain: Mirrored } = await import('./bots.js');

    const shooter = { x: -300, y: 200 };
    const target = { x: 300, y: 200 };
    for (let seed = 1; seed <= 10; seed++) {
      const brain = new Mirrored('b', 'hard', seeded(seed));
      const size = introduce(brain as BotBrain, [{ id: 'b', ...shooter }, { id: 'o', ...target }], 'mirrors');
      const run = blackout(brain as BotBrain, shooter, { size, layout, broken: new Set() }, STAND_STILL_MS);

      const dir = { x: Math.cos(run.aim), y: Math.sin(run.aim) };
      const path = trace({ x: shooter.x + dir.x * 34, y: shooter.y + dir.y * 34 }, dir, { size, layout, broken: new Set() });
      expect(path.segments.length).toBeGreaterThanOrEqual(2);
      const closest = Math.min(...path.segments.map((s) => distanceToSegment(target, s)));
      expect(closest).toBeLessThan(HIT_RADIUS + 30);
    }
  });
});

function distanceToSegment(p: { x: number; y: number }, s: Segment): number {
  const dx = s.ex - s.ox;
  const dy = s.ey - s.oy;
  const t = Math.min(1, Math.max(0, ((p.x - s.ox) * dx + (p.y - s.oy) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(s.ox + dx * t - p.x, s.oy + dy * t - p.y);
}

describe('BotBrain in a real room', () => {
  it('plays a match against a silent human to a result', () => {
    const seen: ServerMessage[] = [];
    const room = new Room('BOTS');
    room.join('human', 'Human', { send: (raw) => seen.push(JSON.parse(raw) as ServerMessage) });
    for (let i = 0; i < 3; i++) room.addBot('human', 'normal');
    expect(room.members.filter((m) => m.bot)).toHaveLength(3);

    let clock = 1000;
    let nextPush = clock;
    room.requestStart('human', clock);
    for (let i = 0; i < 30_000 && !seen.some((m) => m.t === 'over'); i++) {
      clock += TICK_MS;
      room.tick(clock, TICK_MS / 1000);
      if (clock >= nextPush) {
        room.pushState();
        nextPush += 1000 / BROADCAST_HZ;
      }
    }

    const over = seen.find((m) => m.t === 'over');
    expect(over?.t).toBe('over');
    if (over?.t !== 'over') return;
    const ids = ['human', 'bot1', 'bot2', 'bot3'];
    expect(over.winner === null || ids.includes(over.winner)).toBe(true);
    expect(over.rounds).toBeGreaterThan(0);
  });
});

describe('BOT_NAMES', () => {
  it('has enough distinct short names for a full room', () => {
    expect(new Set(BOT_NAMES).size).toBe(BOT_NAMES.length);
    expect(BOT_NAMES.length).toBeGreaterThanOrEqual(9);
    for (const name of BOT_NAMES) expect(name.length).toBeLessThanOrEqual(10);
  });
});

describe('BotBrain in the round modes', () => {
  const size = arenaSize(3, 0);
  const world = openWorld(size);

  /** Seats a bot in a round mode and gives it its orders. */
  function brief(brain: BotBrain, mode: 'hunted' | 'ghost', focus: string, fighters: Fighter[]): void {
    brain.hear({ t: 'match', players: roster(fighters.map((f) => f.id)), startCount: fighters.length, map: 'reactor', gameMode: mode });
    brain.hear({ t: 'round', mode, round: 1, rounds: 6, focus, scores: {}, outcome: null });
    brain.hear({ t: 'brief', brief: { role: 'hunter' } });
    brain.hear({
      t: 'lights',
      round: 0,
      stage: 0,
      size,
      previousSize: size,
      players: fighters.map((f) => ({ id: f.id, x: f.x, y: f.y, aim: 0, alive: true })),
      resolution: null,
      remaining: fighters.length,
      holdMs: 1800,
      broken: [],
    });
  }

  it('aims at the target, not at the hunter standing closer', () => {
    const brain = new BotBrain('b', 'hard', seeded(4));
    const target = { id: 't', x: 0, y: 260 };
    brief(brain, 'hunted', 't', [{ id: 'b', x: 0, y: -260 }, { id: 'h', x: 120, y: -200 }, target]);
    const { end, aim } = blackout(brain, { x: 0, y: -260 }, world, STAND_STILL_MS);
    expect(diff(aim, Math.atan2(target.y - end.y, target.x - end.x))).toBeLessThan(0.3);
  });

  it('keeps hunting a Ghost from where it was last seen once it vanishes', () => {
    const brain = new BotBrain('b', 'hard', seeded(5));
    const ghost = { id: 'g', x: -250, y: 0 };
    brief(brain, 'ghost', 'g', [{ id: 'b', x: 250, y: 0 }, { id: 'h', x: 0, y: 250 }, ghost]);
    // A mid-round reveal: the Ghost is not in it.
    brain.hear({
      t: 'lights',
      round: 1,
      stage: 0,
      size,
      previousSize: size,
      players: [
        { id: 'b', x: 250, y: 0, aim: 0, alive: true },
        { id: 'h', x: 0, y: 250, aim: 0, alive: true },
      ],
      resolution: { beams: [], kills: [], duels: [], eliminated: [], broken: [] },
      remaining: 3,
      holdMs: 1200,
      broken: [],
    });
    const { end, aim } = blackout(brain, { x: 250, y: 0 }, world, STAND_STILL_MS);
    expect(diff(aim, Math.atan2(ghost.y - end.y, ghost.x - end.x))).toBeLessThan(0.3);
  });
});
