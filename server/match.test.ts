import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inradius } from '../shared/arena.js';
import { BARREL_LENGTH, KILLCAM_MS, PLAYER_RADIUS, STALL_ROUNDS, TICK_MS } from '../shared/constants.js';
import type { LobbyPlayer, ServerMessage, SnapshotPlayer } from '../shared/protocol.js';
import { layoutFor, type MapId } from '../shared/maps.js';
import { Match } from './match.js';

const ROSTER: LobbyPlayer[] = [
  { id: 'a', name: 'A', color: '#ff0000', ready: true, finisher: 'shatter', wins: 0, bot: false },
  { id: 'b', name: 'B', color: '#00ff00', ready: true, finisher: 'storm', wins: 0, bot: false },
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
    const beam = lights.resolution!.beams.find((b) => b.id === 'a')!.segments[0]!;
    const muzzle = Math.hypot(beam.ox - fired.x, beam.oy - fired.y);
    expect(muzzle).toBeCloseTo(BARREL_LENGTH, 6);
    expect(reach(fired)).toBeGreaterThan(inradius(lights.size) - PLAYER_RADIUS);

    runUntil('dark');
    runUntil('lights');
    expect(reach(find('a'))).toBeLessThanOrEqual(inradius(lights.size) - PLAYER_RADIUS + 1e-6);
  });

  it('takes the position a client reports when it could really have got there', () => {
    const a = find('a');
    runUntil('dark');
    advance(500);
    match.input('a', 1, 0, 0, a.aim, { x: a.x + 100, y: a.y }, clock);
    runUntil('lights');
    expect(find('a').x).toBeCloseTo(a.x + 100, 6);
  });

  it('refuses a report that would mean moving faster than anyone can', () => {
    const a = find('a');
    runUntil('dark');
    advance(100);
    match.input('a', 1, 0, 0, a.aim, { x: a.x + 300, y: a.y }, clock);
    runUntil('lights');
    expect(find('a').x).toBeCloseTo(a.x, 6);
  });

  it('still counts the last aim sent just after the announced end of the blackout', () => {
    runUntil('dark');
    runUntil('lights');
    const a = find('a');
    const b = find('b');

    const dark = runUntil('dark');
    match.input('b', 1, 0, 0, aimAt(b, a) + Math.PI / 2);
    advance(dark.durationMs + 120);
    expect(match.phase).toBe('dark');
    match.input('a', 1, 0, 0, aimAt(a, b));

    expect(runUntil('lights').resolution!.eliminated).toEqual(['b']);
  });

  /** Plays the first round out as a duel, then has `a` shoot `b` while `b` looks away. */
  function finishWithAKill(): Extract<ServerMessage, { t: 'lights' }> {
    runUntil('dark');
    runUntil('lights');
    const a = find('a');
    const b = find('b');
    runUntil('dark');
    match.input('a', 0, 0, 0, aimAt(a, b));
    match.input('b', 0, 0, 0, aimAt(b, a) + Math.PI / 2);
    return runUntil('lights');
  }

  it('sends the final blackout as a replay only with the round that ends the match', () => {
    runUntil('dark');
    expect(runUntil('lights').replay).toBeUndefined();

    // Walking straight at the target keeps the aim on it while the path grows.
    const a = find('a');
    const b = find('b');
    const aim = aimAt(a, b);
    runUntil('dark');
    match.input('a', 0, Math.cos(aim), Math.sin(aim), aim);
    match.input('b', 0, 0, 0, aimAt(b, a) + Math.PI / 2);
    advance(500);
    match.input('a', 1, 0, 0, aim);
    const final = runUntil('lights');

    expect(final.remaining).toBe(1);
    const tracks = final.replay!;
    expect(tracks.map((t) => t.id).sort()).toEqual(['a', 'b']);
    const path = tracks.find((t) => t.id === 'a')!.points;
    expect(path.length).toBeGreaterThan(20);
    // Starts where the blackout began and ends where the shot was fired from.
    const fired = final.players.find((p) => p.id === 'a')!;
    expect(path[0]![0]).toBeCloseTo(a.x, 0);
    expect(path.at(-1)![0]).toBeCloseTo(fired.x, 0);
    expect(path.at(-1)![1]).toBeCloseTo(fired.y, 0);
    expect(Math.hypot(fired.x - a.x, fired.y - a.y)).toBeGreaterThan(150);
  });

  it('holds the final lights long enough for the killcam', () => {
    const final = finishWithAKill();
    expect(final.remaining).toBe(1);
    expect(final.replay).toBeDefined();
    expect(final.holdMs).toBe(KILLCAM_MS);
  });

  it('reports kills, the longest shot and who took each player out', () => {
    finishWithAKill();
    const over = runUntil('over');
    const [first, second] = over.standings;
    expect(first).toMatchObject({ id: 'a', kills: 1, killedBy: null });
    expect(first!.longest).toBeGreaterThan(300);
    expect(second).toMatchObject({ id: 'b', kills: 0, longest: 0, killedBy: 'a' });
  });

  it('cuts power to all cover when the last two stall, but keeps floor machinery', () => {
    const pillars = new Match(ROSTER, (msg) => sent.push(msg), clock, 'pillars');
    match = pillars;
    sent.length = 0;
    // Both spawns face the centre and cancel each other: a stall every round.
    for (let round = 1; round < STALL_ROUNDS; round++) {
      runUntil('dark');
      expect(runUntil('lights').broken).toEqual([]);
    }
    runUntil('dark');
    const cut = runUntil('lights').broken;
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.every((id) => id.startsWith('pillar'))).toBe(true);
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

  /** Starts a fresh match on `map`, with the spawn ring turned to `spin` radians. */
  function startOn(map: MapId, spin: number): void {
    sent = [];
    clock = 1000;
    vi.spyOn(Math, 'random').mockReturnValueOnce(spin / (Math.PI * 2));
    match = new Match(ROSTER, (msg) => sent.push(msg), clock, map);
    vi.restoreAllMocks();
  }

  describe('on a map with obstacles', () => {
    it('announces the map', () => {
      startOn('warehouse', 0);
      expect(sent.find((m) => m.t === 'match')).toMatchObject({ map: 'warehouse' });
    });

    it('keeps broken crates broken across rounds', () => {
      startOn('warehouse', 0);
      const crate = layoutFor('warehouse', 720).obstacles.find((o) => o.id === 'crate-1')!;
      if (crate.kind !== 'crate') throw new Error('crate-1 is not a crate');

      runUntil('dark');
      runUntil('lights');
      const a = find('a');
      runUntil('dark');
      match.input('a', 0, 0, 0, Math.atan2(crate.y - a.y, crate.x - a.x));
      match.input('b', 0, 0, 0, Math.PI / 2);
      const first = runUntil('lights');
      expect(first.resolution!.broken).toContain('crate-1');
      expect(first.broken).toContain('crate-1');

      runUntil('dark');
      const second = runUntil('lights');
      expect(second.broken).toContain('crate-1');
      expect(second.resolution!.broken).not.toContain('crate-1');
    });

    it('drags an idle player along a conveyor during the blackout', () => {
      // A spawn at (-0.62 R, 0) lies on the vertical belt that runs towards -y.
      startOn('factory', Math.PI);
      const start = find('a');
      expect(start.x).toBeLessThan(-200);
      runUntil('dark');
      const lights = runUntil('lights');
      const after = lights.players.find((p) => p.id === 'a')!;
      expect(after.y).toBeLessThan(start.y - 60);
      expect(after.x).toBeCloseTo(start.x, 3);
    });

    it('drags a disconnected body too', () => {
      startOn('factory', Math.PI);
      const start = find('a');
      runUntil('dark');
      match.disconnect('a');
      const after = runUntil('lights').players.find((p) => p.id === 'a')!;
      expect(after.y).toBeLessThan(start.y - 60);
    });

    it('does not drag anyone on an open map', () => {
      startOn('reactor', Math.PI);
      const start = find('a');
      runUntil('dark');
      const after = runUntil('lights').players.find((p) => p.id === 'a')!;
      expect(after.y).toBeCloseTo(start.y, 6);
    });

    it('teleports a player who walks onto a pad, and accepts reports from the far side', () => {
      startOn('lab', Math.PI);
      const start = find('a');
      const pad0 = layoutFor('lab', 720).obstacles.find((o) => o.id === 'pad-0')!;
      const pad1 = layoutFor('lab', 720).obstacles.find((o) => o.id === 'pad-1')!;
      if (pad0.kind !== 'teleporter' || pad1.kind !== 'teleporter') throw new Error('pads expected');
      expect(Math.hypot(start.x - pad0.x, start.y - pad0.y)).toBeGreaterThan(pad0.r);

      runUntil('dark');
      const heading = Math.atan2(pad0.y - start.y, pad0.x - start.x);
      match.input('a', 1, Math.cos(heading), Math.sin(heading), start.aim);
      advance(160);
      match.input('a', 2, 0, 0, start.aim, { x: pad1.x, y: pad1.y }, clock);
      const after = runUntil('lights').players.find((p) => p.id === 'a')!;
      expect(Math.hypot(after.x - pad1.x, after.y - pad1.y)).toBeLessThan(1);
    });

    it('does not fire the pad a player starts a blackout standing on', () => {
      startOn('lab', Math.PI);
      const pads = layoutFor('lab', 720).obstacles.filter((o) => o.kind === 'teleporter');
      const pad0 = pads.find((o) => o.id === 'pad-0')!;
      const pad1 = pads.find((o) => o.id === 'pad-1')!;
      if (pad0.kind !== 'teleporter' || pad1.kind !== 'teleporter') throw new Error('pads expected');

      // Reporting a spot on pad-0 sends a to pad-1 during the first blackout.
      runUntil('dark');
      advance(100);
      match.input('a', 1, 0, 0, 0, { x: pad0.x, y: pad0.y }, clock);
      const first = runUntil('lights').players.find((p) => p.id === 'a')!;
      expect(Math.hypot(first.x - pad1.x, first.y - pad1.y)).toBeLessThan(1);

      // The next blackout begins on pad-1: idling there must not bounce a back.
      runUntil('dark');
      const second = runUntil('lights').players.find((p) => p.id === 'a')!;
      expect(Math.hypot(second.x - pad1.x, second.y - pad1.y)).toBeLessThan(1);
    });

    it('counts a beam that bounces back as a death, not a kill', () => {
      // a stands on the normal of mirror-0 and fires at its centre, so the beam returns to a.
      startOn('mirrors', -0.2127);
      const mirror = layoutFor('mirrors', 720).obstacles.find((o) => o.id === 'mirror-0')!;
      if (mirror.kind !== 'mirror') throw new Error('mirror expected');
      const a = find('a');
      const centre = { x: (mirror.ax + mirror.bx) / 2, y: (mirror.ay + mirror.by) / 2 };

      runUntil('dark');
      match.input('a', 0, 0, 0, Math.atan2(centre.y - a.y, centre.x - a.x));
      match.input('b', 0, 0, 0, Math.PI / 2 + 0.3);
      const lights = runUntil('lights');
      expect(lights.resolution!.kills).toContainEqual({ shooter: 'a', target: 'a' });

      const over = runUntil('over');
      expect(over.standings.find((x) => x.id === 'a')).toMatchObject({ kills: 0, killedBy: 'a' });
    });
  });
});
