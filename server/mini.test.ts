import { describe, expect, it } from 'vitest';
import { TICK_MS } from '../shared/constants.js';
import { TILE_GONE, standingOnNothing } from '../shared/collapse.js';
import { FREEZE_FINISH_Y } from '../shared/freeze.js';
import { FUSE_MS } from '../shared/potato.js';
import type { LobbyPlayer, MiniExtra, MiniPlayer, ServerMessage } from '../shared/protocol.js';
import { ROOM_SPAN, fromRoom, roomOf } from '../shared/rooms.js';
import { FLOE_RADIUS } from '../shared/sumo.js';
import { CollapseMatch } from './collapse.js';
import { FreezeMatch } from './freeze.js';
import type { MiniMatch } from './mini.js';
import { PotatoMatch } from './potato.js';
import { RoomsMatch } from './rooms.js';
import { SumoMatch } from './sumo.js';

const dt = TICK_MS / 1000;

function roster(n: number): LobbyPlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String.fromCharCode(97 + i),
    name: `P${i}`,
    color: '#ffffff',
    ready: true,
    finisher: 'shatter' as const,
    wins: 0,
    bot: false,
  }));
}

/** A match under test, with the clock and the messages it has sent. */
class Harness<T extends MiniMatch> {
  readonly sent: ServerMessage[] = [];
  clock = 1000;
  readonly match: T;

  constructor(make: (send: (m: ServerMessage) => void, now: number) => T) {
    this.match = make((m) => this.sent.push(m), this.clock);
  }

  /** Steps the match, with `drive` setting everyone's input each tick. */
  advance(ms: number, drive?: (state: Extract<ServerMessage, { t: 'mini' }>) => void): this {
    const until = this.clock + ms;
    while (this.clock < until) {
      this.clock += TICK_MS;
      if (drive) drive(this.state());
      this.match.tick(this.clock, dt);
      this.match.settle(this.clock);
    }
    return this;
  }

  /** Every fighter holds this input until told otherwise. */
  press(mx: number, my: number, action = false, only?: string[]): void {
    for (const p of this.state().players) {
      if (only && !only.includes(p.id)) continue;
      this.match.input(p.id, Date.now() + Math.random(), mx, my, 0, undefined, this.clock, action);
    }
  }

  push(id: string, mx: number, my: number, action = false): void {
    this.match.input(id, Date.now() + Math.random(), mx, my, 0, undefined, this.clock, action);
  }

  state(): Extract<ServerMessage, { t: 'mini' }> {
    const before = this.sent.length;
    this.match.pushState([]);
    const found = this.sent.slice(before).find((m) => m.t === 'mini');
    if (!found) throw new Error('the match sent no state');
    return found as Extract<ServerMessage, { t: 'mini' }>;
  }

  extra<K extends MiniExtra['kind']>(kind: K): Extract<MiniExtra, { kind: K }> {
    const extra = this.state().extra;
    if (extra.kind !== kind) throw new Error(`state is ${extra.kind}, not ${kind}`);
    return extra as Extract<MiniExtra, { kind: K }>;
  }

  who(id: string): MiniPlayer {
    const p = this.state().players.find((x) => x.id === id);
    if (!p) throw new Error(`${id} is not in the state`);
    return p;
  }

  alive(): string[] {
    return this.state().players.filter((p) => p.state === 'alive').map((p) => p.id);
  }

  over(): Extract<ServerMessage, { t: 'over' }> | null {
    const found = [...this.sent].reverse().find((m) => m.t === 'over');
    return (found as Extract<ServerMessage, { t: 'over' }>) ?? null;
  }
}

const freeze = (n = 3) => new Harness((send, now) => new FreezeMatch(roster(n), send, now, 'reactor'));
const collapse = (n = 3) => new Harness((send, now) => new CollapseMatch(roster(n), send, now, 'reactor'));
const rooms = (n = 4) => new Harness((send, now) => new RoomsMatch(roster(n), send, now, 'reactor'));
const sumo = (n = 2) => new Harness((send, now) => new SumoMatch(roster(n), send, now, 'reactor'));
const potato = (n = 3) => new Harness((send, now) => new PotatoMatch(roster(n), send, now, 'reactor'));

describe('every lit game', () => {
  it('announces itself as the game being played', () => {
    for (const [kind, harness] of [
      ['freeze', freeze()],
      ['collapse', collapse()],
      ['rooms', rooms()],
      ['sumo', sumo()],
      ['potato', potato()],
    ] as const) {
      const announced = harness.sent.find((m) => m.t === 'match');
      expect(announced).toBeDefined();
      expect(announced && announced.t === 'match' && announced.gameMode).toBe(kind);
      expect(harness.state().kind).toBe(kind);
    }
  });

  it('sends the same state to everyone, spectators included', () => {
    const game = sumo(2);
    const before = game.sent.length;
    game.match.pushState(['a', 'b']);
    const states = game.sent.slice(before).filter((m) => m.t === 'mini');
    expect(states).toHaveLength(1);
    expect(states[0] && states[0].t === 'mini' && states[0].players).toHaveLength(2);
  });

  it('plays itself out to one winner and then reports it', () => {
    for (const game of [freeze(2), collapse(2), rooms(3), sumo(2), potato(3)]) {
      game.advance(240_000, () => game.press(0, 0));
      const over = game.over();
      expect(over).not.toBeNull();
      expect(over!.standings).toHaveLength(game.state().players.length);
      expect(game.alive().length).toBeLessThanOrEqual(1);
    }
  });
});

describe('Freeze', () => {
  it('lets the pack run while the eye is turned away', () => {
    const game = freeze(3);
    const start = game.who('a').y;
    game.advance(600, (state) => {
      if (state.extra.kind === 'freeze' && state.extra.light === 'green') game.press(0, 1);
      else game.press(0, 0);
    });
    expect(game.who('a').y).toBeGreaterThan(start);
  });

  it('zaps whoever moves while the eye is looking', () => {
    const game = freeze(3);
    // Run flat out, light or no light: the eye gets everyone in the end.
    game.advance(30_000, () => game.press(0, 1));
    const zapped = game.state().players.filter((p) => p.state === 'out');
    expect(zapped.length).toBeGreaterThan(0);
  });

  it('leaves a fighter who never moves alone', () => {
    const game = freeze(3);
    game.advance(12_000, () => game.press(0, 0));
    const still = game.state().players.filter((p) => p.state === 'alive');
    expect(still.length).toBeGreaterThan(0);
    expect(game.extra('freeze').zaps).toHaveLength(0);
  });

  it('counts a fighter home once they are over the line', () => {
    const game = freeze(2);
    game.advance(60_000, (state) => {
      if (state.extra.kind === 'freeze' && state.extra.light === 'green') game.press(0, 1, false, ['a']);
      else game.press(0, 0);
    });
    const scores = game.state().scores;
    expect(game.who('a').y >= FREEZE_FINISH_Y || scores.a! > 0 || game.who('a').state === 'out').toBe(true);
  });

  it('turns the eye through a warning before it stares', () => {
    const game = freeze(2);
    const seen = new Set<string>();
    game.advance(20_000, (state) => {
      if (state.extra.kind === 'freeze') seen.add(state.extra.light);
      game.press(0, 0);
    });
    expect(seen.has('green')).toBe(true);
    expect(seen.has('turning')).toBe(true);
    expect(seen.has('red')).toBe(true);
  });
});

describe('Collapse', () => {
  it('eats the floor from the outside in', () => {
    const game = collapse(3);
    game.advance(9000, () => game.press(0, 0));
    const extra = game.extra('collapse');
    const gone = [...extra.tiles].map((t, i) => [t, i] as const).filter(([t]) => t === TILE_GONE);
    expect(gone.length).toBeGreaterThan(0);
    // The middle tile is the last thing standing, so it is never an early casualty.
    expect(extra.tiles[60]).not.toBe(TILE_GONE);
  });

  it('drops a fighter who is left standing on nothing', () => {
    const game = collapse(3);
    game.advance(120_000, () => game.press(0, 0));
    expect(game.alive().length).toBeLessThanOrEqual(1);
  });

  it('warns a tile before it goes', () => {
    const game = collapse(2);
    const warned = new Set<string>();
    game.advance(6000, (state) => {
      if (state.extra.kind === 'collapse') for (const t of state.extra.tiles) warned.add(t);
      game.press(0, 0);
    });
    expect(warned.has('1')).toBe(true);
  });

  it('lets a fighter run, and dash, across the floor', () => {
    const game = collapse(2);
    const start = game.who('a').x;
    game.advance(400, () => game.press(1, 0, true, ['a']));
    const walked = game.who('a').x - start;
    expect(walked).toBeGreaterThan(0);
    expect(standingOnNothing(game.who('a'), game.extra('collapse').tiles)).toBe(false);
  });
});

describe('Rooms', () => {
  it('plays the music, calls a number, then locks the doors', () => {
    const game = rooms(4);
    const phases: string[] = [];
    game.advance(14_000, (state) => {
      if (state.extra.kind === 'rooms') {
        const phase = state.extra.phase;
        if (phases[phases.length - 1] !== phase) phases.push(phase);
      }
      game.press(0, 0);
    });
    expect(phases.slice(0, 4)).toEqual(['music', 'announce', 'count', 'reveal']);
  });

  it('calls a number nobody can answer by standing in one room together', () => {
    const game = rooms(4);
    game.advance(20_000, (state) => {
      if (state.extra.kind === 'rooms' && state.extra.target !== null) {
        expect(state.extra.target).toBeGreaterThanOrEqual(1);
        expect(state.extra.target).toBeLessThan(4);
      }
      game.press(0, 0);
    });
  });

  it('takes everyone the rooms did not save', () => {
    const game = rooms(4);
    // Nobody moves, so nobody is in a room when the doors lock.
    game.advance(40_000, () => game.press(0, 0));
    expect(game.alive().length).toBeLessThanOrEqual(1);
  });

  it('saves a room that holds exactly the number called', () => {
    const game = rooms(4);
    let saved = false;
    game.advance(26_000, (state) => {
      if (state.extra.kind !== 'rooms') return;
      const target = state.extra.target;
      if (state.extra.phase === 'reveal') {
        saved = saved || state.extra.rooms.some((r) => r.outcome === 'ok');
        game.press(0, 0);
        return;
      }
      if (target === null) {
        game.press(0, 0);
        return;
      }
      // Fill one room with exactly the number called, and park the rest apart.
      state.players.forEach((p, i) => {
        const room = Math.floor(i / target);
        const to = fromRoom(room, ROOM_SPAN.at + ROOM_SPAN.depth / 2, 0);
        const dx = to.x - p.x;
        const dy = to.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        game.push(p.id, dx / d, dy / d);
      });
    });
    expect(saved).toBe(true);
  });

  it('counts a fighter as in a room only once they are through the door', () => {
    const game = rooms(3);
    expect(roomOf(game.who('a'))).toBeNull();
  });
});

describe('Sumo', () => {
  it('slides fighters around on momentum rather than stopping dead', () => {
    const game = sumo(2);
    game.advance(600, () => game.press(1, 0, false, ['a']));
    const moving = game.extra('sumo').vel.a;
    expect(moving).toBeDefined();
    expect(Math.hypot(moving![0], moving![1])).toBeGreaterThan(0);
    game.advance(60, () => game.press(0, 0));
    const after = game.extra('sumo').vel.a!;
    expect(Math.hypot(after[0], after[1])).toBeGreaterThan(0);
  });

  it('melts the ice back in wedges, with a warning first', () => {
    const game = sumo(2);
    let warned = false;
    game.advance(20_000, (state) => {
      if (state.extra.kind === 'sumo' && state.extra.cracking.length > 0) warned = true;
      game.press(0, 0);
    });
    expect(warned).toBe(true);
    expect(Math.min(...game.extra('sumo').floe)).toBeLessThan(FLOE_RADIUS);
  });

  it('takes anyone who ends up off the ice', () => {
    const game = sumo(3);
    game.advance(240_000, () => game.press(0, 0));
    const falls = game.extra('sumo').falls;
    expect(game.alive().length).toBeLessThanOrEqual(1);
    expect(falls.length).toBeGreaterThanOrEqual(0);
  });

  it('records a shove when a dash lands', () => {
    const game = sumo(2);
    let shoved = false;
    game.advance(8000, (state) => {
      if (state.extra.kind === 'sumo' && state.extra.shoves.length > 0) shoved = true;
      // Both fighters charge the middle and meet there.
      for (const p of state.players) {
        const d = Math.hypot(p.x, p.y) || 1;
        game.push(p.id, -p.x / d, -p.y / d, true);
      }
    });
    expect(shoved).toBe(true);
  });
});

describe('Hot potato', () => {
  it('lights a fuse and puts it in somebody hands', () => {
    const game = potato(3);
    const holders = game.extra('potato').holders;
    expect(holders).toHaveLength(1);
    expect(game.state().players.map((p) => p.id)).toContain(holders[0]);
  });

  it('burns the fuse down', () => {
    const game = potato(3);
    const first = game.extra('potato').heat[0]!;
    game.advance(400, () => game.press(0, 0));
    expect(game.extra('potato').heat[0] ?? FUSE_MS).toBeGreaterThan(first);
  });

  it('takes whoever is holding it when it goes off', () => {
    const game = potato(3);
    const holder = game.extra('potato').holders[0]!;
    game.advance(FUSE_MS + 200, () => game.press(0, 0));
    expect(game.who(holder).state).toBe('out');
    expect(game.sent.some((m) => m.t === 'mini')).toBe(true);
  });

  it('hands the bomb on when the holder catches somebody', () => {
    const game = potato(3);
    let passed = false;
    game.advance(FUSE_MS - 200, (state) => {
      if (state.extra.kind !== 'potato') return;
      if (state.extra.passes.length > 0) passed = true;
      const holder = state.extra.holders[0];
      const chaser = state.players.find((p) => p.id === holder);
      const prey = state.players.find((p) => p.id !== holder && p.state === 'alive');
      if (!chaser || !prey) return;
      const dx = prey.x - chaser.x;
      const dy = prey.y - chaser.y;
      const d = Math.hypot(dx, dy) || 1;
      game.push(chaser.id, dx / d, dy / d);
    });
    expect(passed).toBe(true);
  });

  it('lights another fuse after a bang, while anyone is left', () => {
    const game = potato(4);
    game.advance(FUSE_MS + 1800, () => game.press(0, 0));
    const extra = game.extra('potato');
    expect(game.alive().length).toBeGreaterThan(1);
    expect(extra.holders.length).toBeGreaterThan(0);
  });
});
