import { beforeEach, describe, expect, it } from 'vitest';
import { inradius } from '../shared/arena.js';
import { BARREL_LENGTH, PLAYER_RADIUS, TICK_MS } from '../shared/constants.js';
import type { LobbyPlayer, ServerMessage, SnapshotPlayer } from '../shared/protocol.js';
import { Match } from './match.js';

const ROSTER: LobbyPlayer[] = [
  { id: 'a', name: 'A', color: '#ff0000', ready: true },
  { id: 'b', name: 'B', color: '#00ff00', ready: true },
];

describe('Match', () => {
  let sent: ServerMessage[];
  let match: Match;
  let clock: number;

  /**
   * Blackout length is deliberately jittered, so the tests wait on messages
   * rather than on wall-clock arithmetic.
   */
  function runUntil<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> {
    const from = sent.length;
    const deadline = clock + 20_000;
    while (clock < deadline) {
      clock += TICK_MS;
      match.tick(clock, TICK_MS / 1000);
      match.settle(clock);
      const found = sent.slice(from).find((m) => m.t === t);
      if (found) return found as Extract<ServerMessage, { t: T }>;
    }
    throw new Error(`No '${t}' message arrived`);
  }

  function advance(ms: number): void {
    const until = clock + ms;
    while (clock < until) {
      clock += TICK_MS;
      match.tick(clock, TICK_MS / 1000);
      match.settle(clock);
    }
  }

  function last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> {
    const found = [...sent].reverse().find((m) => m.t === t);
    if (!found) throw new Error(`No '${t}' message was sent`);
    return found as Extract<ServerMessage, { t: T }>;
  }

  function find(id: string): SnapshotPlayer {
    const p = last('lights').players.find((x) => x.id === id);
    if (!p) throw new Error(`${id} is not in the snapshot`);
    return p;
  }

  /** The angle that puts `from`'s beam straight through `to`. */
  function aimAt(from: SnapshotPlayer, to: SnapshotPlayer): number {
    return Math.atan2(to.y - from.y, to.x - from.x);
  }

  beforeEach(() => {
    sent = [];
    clock = 1000;
    match = new Match(ROSTER, (msg) => sent.push(msg), clock);
  });

  it('opens on a fully lit arena with nothing to resolve', () => {
    const lights = last('lights');
    expect(match.phase).toBe('lights');
    expect(lights.resolution).toBeNull();
    expect(lights.players).toHaveLength(2);
    expect(lights.stage).toBe(0);
    expect(lights.size).toBe(720);
  });

  it('goes dark after the lights-on beat', () => {
    expect(runUntil('dark').round).toBe(1);
    expect(match.phase).toBe('dark');
  });

  it('cancels the opening duel: both spawns face the centre, so neither dies', () => {
    runUntil('dark');
    const resolution = runUntil('lights').resolution!;
    expect(resolution.duels).toHaveLength(1);
    expect(resolution.eliminated).toEqual([]);
  });

  it('only moves players while the lights are out', () => {
    const start = find('a');

    match.input('a', 0, 1, 0, 0);
    advance(TICK_MS * 10);
    expect(find('a').x).toBeCloseTo(start.x, 6);

    runUntil('dark');
    match.input('a', 0, 1, 0, 0);
    runUntil('lights');
    expect(find('a').x).toBeGreaterThan(start.x + 100);
  });

  it('ends with a winner once one player aims and the other looks away', () => {
    runUntil('dark');
    runUntil('lights');
    const a = find('a');
    const b = find('b');

    runUntil('dark');
    match.input('a', 0, 0, 0, aimAt(a, b));
    match.input('b', 0, 0, 0, aimAt(b, a) + Math.PI / 2);
    const lights = runUntil('lights');

    expect(lights.resolution!.eliminated).toEqual(['b']);
    expect(lights.remaining).toBe(1);
    expect(runUntil('over').winner).toBe('a');
    expect(match.finished).toBe(true);
  });

  it('shrinks the arena on its own when a stand-off drags on', () => {
    // Nobody is eliminated while both players simply duel, so the stall
    // trigger has to be what forces the arena in.
    for (let round = 1; round <= 2; round++) {
      runUntil('dark');
      expect(runUntil('lights').size).toBe(720);
    }

    runUntil('dark');
    const lights = runUntil('lights');
    expect(lights.previousSize).toBe(720);
    expect(lights.size).toBeCloseTo(576, 6);
    expect(lights.stage).toBe(1);
  });

  it('shows players where they fired from, and only then pushes them inside the new wall', () => {
    for (let round = 1; round <= 2; round++) {
      runUntil('dark');
      runUntil('lights');
    }

    // Run into the wall on the round that shrinks the arena.
    const a = find('a');
    const out = Math.hypot(a.x, a.y);
    runUntil('dark');
    match.input('a', 1, a.x / out, a.y / out, a.aim);
    const lights = runUntil('lights');
    expect(lights.size).toBeLessThan(lights.previousSize);

    // Distance in the octagon's own measure: flat sides, not a circle.
    const reach = (p: { x: number; y: number }) =>
      Math.max(Math.abs(p.x), Math.abs(p.y), (Math.abs(p.x) + Math.abs(p.y)) * Math.SQRT1_2);
    const fired = find('a');
    const beam = lights.resolution!.beams.find((b) => b.id === 'a')!;
    const muzzle = Math.hypot(beam.ox - fired.x, beam.oy - fired.y);
    expect(muzzle).toBeCloseTo(BARREL_LENGTH, 6);
    expect(reach(fired)).toBeGreaterThan(inradius(lights.size) - PLAYER_RADIUS);

    runUntil('dark');
    runUntil('lights');
    expect(reach(find('a'))).toBeLessThanOrEqual(inradius(lights.size) - PLAYER_RADIUS + 1e-6);
  });

  it('keeps a dropped player on the field as a frozen target', () => {
    runUntil('dark');
    runUntil('lights');
    const a = find('a');
    const b = find('b');

    runUntil('dark');
    // Look away first, so the frozen aim cannot cancel the incoming shot.
    match.input('b', 0, 1, 1, aimAt(b, a) + Math.PI / 2);
    match.disconnect('b');
    match.input('a', 0, 0, 0, aimAt(a, b));
    const lights = runUntil('lights');

    expect(find('b').x).toBeCloseTo(b.x, 6);
    expect(lights.resolution!.eliminated).toEqual(['b']);
  });
});
