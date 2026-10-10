import { describe, expect, it } from 'vitest';
import { DEFAULT_FINISHER, HIT_RADIUS, PLAYER_COLORS, TICK_MS } from '../shared/constants.js';
import { openWorld } from '../shared/maps.js';
import { ROUND_CYCLES, WIN_SCORE, insideZone, type RoundModeId } from '../shared/modes.js';
import type { Brief, LobbyPlayer, ServerMessage, SnapshotPlayer } from '../shared/protocol.js';
import { RoundMatch } from './rounds.js';

type Sent = { msg: ServerMessage; to?: string };
type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;
type Vec = { x: number; y: number };

function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function aimAt(from: Vec, to: Vec): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Distance from `p` to the ray leaving `from` at `angle`. */
function offRay(from: Vec, angle: number, p: Vec): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const t = Math.max(0, (p.x - from.x) * dx + (p.y - from.y) * dy);
  return Math.hypot(from.x + dx * t - p.x, from.y + dy * t - p.y);
}

/** An aim whose beam passes well clear of everyone else. */
function clearAim(from: Vec, others: readonly Vec[]): number {
  let best = 0;
  let bestGap = -1;
  for (let a = -Math.PI; a < Math.PI; a += 0.02) {
    const gap = Math.min(...others.map((o) => offRay(from, a, o)));
    if (gap > bestGap) {
      best = a;
      bestGap = gap;
    }
  }
  expect(bestGap).toBeGreaterThan(HIT_RADIUS * 1.5);
  return best;
}

function setup(ids: string[], mode: RoundModeId, seed = 1) {
  const sent: Sent[] = [];
  let clock = 1000;
  const roster: LobbyPlayer[] = ids.map((id, i) => ({
    id,
    name: id.toUpperCase(),
    color: PLAYER_COLORS[i]!,
    ready: true,
    finisher: DEFAULT_FINISHER,
    wins: 0,
    bot: false,
  }));
  const match = new RoundMatch(roster, (msg, to) => sent.push({ msg, to }), clock, 'reactor', mode, seeded(seed));

  const step = () => {
    clock += TICK_MS;
    match.tick(clock, TICK_MS / 1000);
    match.settle(clock);
  };

  const h = {
    sent,
    match,
    now: () => clock,
    advance(ms: number) {
      const until = clock + ms;
      while (clock < until) step();
    },
    /** Runs until a message of type `t` (optionally to `to`) arrives. */
    runUntil<T extends ServerMessage['t']>(t: T, to?: string): Of<T> {
      const from = sent.length;
      const deadline = clock + 120_000;
      while (clock < deadline) {
        step();
        const found = sent.slice(from).find((s) => s.msg.t === t && (to === undefined || s.to === to || s.to === undefined));
        if (found) return found.msg as Of<T>;
      }
      throw new Error(`no '${t}' arrived`);
    },
    /** Everything delivered to one fighter, in order. */
    inbox(id: string): ServerMessage[] {
      return sent.filter((s) => s.to === undefined || s.to === id).map((s) => s.msg);
    },
    last<T extends ServerMessage['t']>(t: T, id?: string): Of<T> {
      const list = id ? h.inbox(id) : sent.map((s) => s.msg);
      const found = [...list].reverse().find((m) => m.t === t);
      if (!found) throw new Error(`no '${t}' sent`);
      return found as Of<T>;
    },
    brief(id: string): Brief {
      return h.last('brief', id).brief;
    },
    /** Positions as the given fighter last saw them. */
    seen(id: string): SnapshotPlayer[] {
      return h.last('lights', id).players;
    },
    /** Aim everyone standing well away from everybody: a round nobody wins by shooting. */
    holdFire(view: string) {
      const players = h.seen(view).filter((p) => p.alive);
      for (const p of players) {
        h.match.input(p.id, 1, 0, 0, clearAim(p, players.filter((o) => o.id !== p.id)));
      }
    },
  };
  return h;
}

/** Plays a round mode to the end, holding fire every blackout; returns each round's focus. */
function playQuietly(h: ReturnType<typeof setup>): (string | null)[] {
  const focuses: (string | null)[] = [];
  let seenDark = 0;
  let seenRound = 0;
  const deadline = h.now() + 600_000;
  while (h.now() < deadline) {
    h.advance(TICK_MS);
    const rounds = h.sent.filter((s) => s.msg.t === 'round' && (s.msg as Of<'round'>).outcome === null);
    for (const r of rounds.slice(seenRound)) focuses.push((r.msg as Of<'round'>).focus);
    seenRound = rounds.length;
    const darks = h.sent.filter((s) => s.msg.t === 'dark').length;
    if (darks > seenDark) {
      seenDark = darks;
      const round = h.last('round');
      h.holdFire(round.focus ?? h.match.mode === 'assassin' ? round.focus ?? 'a' : 'a');
    }
    if (h.sent.some((s) => s.msg.t === 'over')) return focuses;
  }
  throw new Error('match never ended');
}

describe('Hunted', () => {
  it('makes exactly one Target and tells everyone where the box is', () => {
    const h = setup(['a', 'b', 'c'], 'hunted');
    const roles = ['a', 'b', 'c'].map((id) => h.brief(id));
    expect(roles.filter((b) => b.role === 'target')).toHaveLength(1);
    expect(roles.filter((b) => b.role === 'hunter')).toHaveLength(2);
    const round = h.last('round');
    expect(round.focus).toBe(['a', 'b', 'c'].find((id) => h.brief(id).role === 'target'));
    // The hunters are firing into the box, so the box is public.
    expect(round.zone).toBeDefined();
  });

  it('starts the Target in its box and the hunters in a line outside it', () => {
    const h = setup(['a', 'b', 'c'], 'hunted', 5);
    const round = h.last('round');
    const focus = round.focus!;
    const zone = round.zone!;
    const seen = h.seen(focus);
    expect(insideZone(seen.find((p) => p.id === focus)!, zone)).toBe(true);
    for (const id of ['a', 'b', 'c'].filter((x) => x !== focus)) {
      const hunter = seen.find((p) => p.id === id)!;
      expect(insideZone(hunter, zone)).toBe(false);
      // The line stands on the near side; the box is up the far end.
      expect(hunter.y).toBeGreaterThan(zone.y);
    }
  });

  it('keeps the Target in its box however it moves, and the line standing still', () => {
    const h = setup(['a', 'b', 'c'], 'hunted', 2);
    const round = h.last('round');
    const focus = round.focus!;
    const zone = round.zone!;
    const hunter = ['a', 'b', 'c'].find((id) => id !== focus)!;
    const startHunter = h.seen(hunter).find((p) => p.id === hunter)!;

    h.runUntil('dark');
    h.holdFire(focus);
    h.match.input(focus, 2, 0.3, -1, 0);
    h.match.input(hunter, 2, 0, 1, 0);
    h.advance(500);
    // A report from outside the box is pulled back into it, never taken as is.
    const target = h.seen(focus).find((p) => p.id === focus)!;
    h.match.input(focus, 3, 0, 0, 0, { x: target.x + 400, y: target.y + 700 }, h.now());
    const lights = h.runUntil('lights', focus);

    expect(insideZone(lights.players.find((p) => p.id === focus)!, zone)).toBe(true);
    const held = lights.players.find((p) => p.id === hunter)!;
    expect(Math.hypot(held.x - startHunter.x, held.y - startHunter.y)).toBeLessThan(1e-6);
  });

  it('awards the hunter who shoots the Target and ends the round', () => {
    const h = setup(['a', 'b', 'c'], 'hunted', 3);
    const focus = h.last('round').focus!;
    const [shooter, other] = ['a', 'b', 'c'].filter((id) => id !== focus) as [string, string];

    h.runUntil('dark');
    h.holdFire(focus);
    const seen = h.seen(shooter);
    h.match.input(shooter, 2, 0, 0, aimAt(seen.find((p) => p.id === shooter)!, seen.find((p) => p.id === focus)!));
    const round = h.runUntil('round');

    expect(round.outcome).toEqual({ kind: 'caught', focus, winners: [shooter] });
    expect(h.match.scoreOf(shooter)).toBe(1);
    expect(h.match.scoreOf(focus)).toBe(0);
    expect(h.match.scoreOf(other)).toBe(0);
  });

  it('awards the Target for lasting out the round', () => {
    const h = setup(['a', 'b', 'c'], 'hunted', 4);
    const focus = h.last('round').focus!;
    for (let cycle = 0; cycle < ROUND_CYCLES.hunted; cycle++) {
      h.runUntil('dark');
      h.holdFire(focus);
    }
    const round = h.runUntil('round');
    expect(round.outcome).toEqual({ kind: 'escaped', focus });
    expect(h.match.scoreOf(focus)).toBe(1);
  });

  it('gives the Target nothing to shoot back with', () => {
    const h = setup(['a', 'b', 'c'], 'hunted', 6);
    const focus = h.last('round').focus!;
    const hunter = ['a', 'b', 'c'].find((id) => id !== focus)!;

    h.runUntil('dark');
    h.holdFire(focus);
    const seen = h.seen(focus);
    h.match.input(focus, 2, 0, 0, aimAt(seen.find((p) => p.id === focus)!, seen.find((p) => p.id === hunter)!));
    const lights = h.runUntil('lights', hunter);

    expect(lights.resolution!.beams.some((beam) => beam.id === focus)).toBe(false);
    expect(h.match.alive(hunter)).toBe(true);
  });

  it('rotates the Target so everyone is hunted equally often', () => {
    const h = setup(['a', 'b', 'c'], 'hunted', 8);
    const focuses = playQuietly(h);
    expect(focuses).toHaveLength(h.match.rounds);
    for (const id of ['a', 'b', 'c']) expect(focuses.filter((f) => f === id)).toHaveLength(h.match.rounds / 3);
  });

  it('never tells the Target where the hunters are during a blackout', () => {
    const h = setup(['a', 'b', 'c'], 'hunted', 9);
    const focus = h.last('round').focus!;
    h.runUntil('dark');
    const from = h.sent.length;
    h.match.input(focus, 2, 1, 0, 0);
    for (let i = 0; i < 20; i++) {
      h.advance(100);
      h.match.pushState([]);
    }
    const during = h.sent.slice(from).filter((s) => s.to === undefined || s.to === focus).map((s) => s.msg);
    for (const msg of during.filter((m) => m.t !== 'lights')) {
      expect(['self', 'dark']).toContain(msg.t);
    }
  });
});

describe('Ghost', () => {
  it('makes exactly one Ghost and everyone else a hunter', () => {
    const h = setup(['a', 'b', 'c', 'd'], 'ghost');
    const roles = ['a', 'b', 'c', 'd'].map((id) => h.brief(id).role);
    expect(roles.filter((r) => r === 'ghost')).toHaveLength(1);
    expect(roles.filter((r) => r === 'hunter')).toHaveLength(3);
  });

  it('gives the Ghost no beam to fire', () => {
    const h = setup(['a', 'b'], 'ghost', 2);
    const ghost = h.last('round').focus!;
    const hunter = ghost === 'a' ? 'b' : 'a';

    h.runUntil('dark');
    const seen = h.seen(ghost);
    h.match.input(ghost, 2, 0, 0, aimAt(seen.find((p) => p.id === ghost)!, seen.find((p) => p.id === hunter)!));
    h.match.input(hunter, 2, 0, 0, clearAim(seen.find((p) => p.id === hunter)!, [seen.find((p) => p.id === ghost)!]));
    const lights = h.runUntil('lights', ghost);

    expect(lights.resolution!.beams.map((b) => b.id)).toEqual([hunter]);
    expect(h.match.alive(hunter)).toBe(true);
  });

  it('lets the Ghost move anywhere', () => {
    const h = setup(['a', 'b'], 'ghost', 3);
    const ghost = h.last('round').focus!;
    const start = h.seen(ghost).find((p) => p.id === ghost)!;
    h.runUntil('dark');
    h.holdFire(ghost);
    h.match.input(ghost, 2, 0.6, 0.8, 0);
    const lights = h.runUntil('lights', ghost);
    const moved = lights.players.find((p) => p.id === ghost)!;
    expect(Math.hypot(moved.x - start.x, moved.y - start.y)).toBeGreaterThan(200);
  });

  it('shows hunters the Ghost at the intro, then never again until the round is over', () => {
    const h = setup(['a', 'b', 'c'], 'ghost', 4);
    const ghost = h.last('round').focus!;
    const hunter = ['a', 'b', 'c'].find((id) => id !== ghost)!;
    expect(h.seen(hunter).map((p) => p.id)).toContain(ghost);

    h.runUntil('dark');
    const from = h.sent.length;
    h.holdFire(ghost);
    // The Ghost moves off its starting spot, so its new position is something
    // only the server and the Ghost could know.
    h.match.input(ghost, 2, 0.6, 0.8, h.seen(ghost).find((p) => p.id === ghost)!.aim);
    h.runUntil('lights', hunter);
    expect(h.seen(hunter).map((p) => p.id)).not.toContain(ghost);
    expect(h.seen(ghost).map((p) => p.id)).toContain(hunter);

    const position = h.seen(ghost).find((p) => p.id === ghost)!;
    const toHunter = h.sent.slice(from).filter((s) => s.to === undefined || s.to === hunter);
    for (const s of toHunter) {
      const json = JSON.stringify(s.msg);
      expect(json).not.toContain(`"x":${position.x}`);
      expect(json).not.toContain(`"${ghost}"`);
    }
  });

  it('awards the hunter who finds the Ghost', () => {
    const h = setup(['a', 'b'], 'ghost', 5);
    const ghost = h.last('round').focus!;
    const hunter = ghost === 'a' ? 'b' : 'a';
    h.runUntil('dark');
    const seen = h.seen(hunter);
    h.match.input(hunter, 2, 0, 0, aimAt(seen.find((p) => p.id === hunter)!, seen.find((p) => p.id === ghost)!));
    const round = h.runUntil('round');
    expect(round.outcome).toEqual({ kind: 'caught', focus: ghost, winners: [hunter] });
    expect(h.match.scoreOf(hunter)).toBe(1);
    // Caught: now everyone may see where it was.
    expect(h.seen(hunter).map((p) => p.id)).toContain(ghost);
  });

  it('awards the Ghost for surviving and hands the role on', () => {
    const h = setup(['a', 'b', 'c'], 'ghost', 6);
    const first = h.last('round').focus!;
    for (let cycle = 0; cycle < ROUND_CYCLES.ghost; cycle++) {
      h.runUntil('dark');
      h.holdFire(first);
    }
    expect(h.runUntil('round').outcome).toEqual({ kind: 'escaped', focus: first });
    expect(h.match.scoreOf(first)).toBe(1);
    const next = h.runUntil('round');
    expect(next.focus).not.toBe(first);
  });
});

describe('Assassin', () => {
  const five = ['a', 'b', 'c', 'd', 'e'];

  it('gives every fighter exactly one target, never themselves', () => {
    const h = setup(five, 'assassin');
    const targets = five.map((id) => h.brief(id).contract);
    for (const [i, id] of five.entries()) {
      expect(targets[i]).toBeDefined();
      expect(targets[i]).not.toBe(id);
    }
    expect(new Set(targets).size).toBe(five.length);
  });

  it('sends each contract only to its owner and keeps it out of public messages', () => {
    const h = setup(five, 'assassin');
    for (const s of h.sent.filter((s) => s.msg.t === 'brief')) expect(s.to).toBeDefined();
    for (const s of h.sent.filter((s) => s.to === undefined)) {
      expect(JSON.stringify(s.msg)).not.toContain('contract');
    }
    expect(h.last('round').focus).toBeNull();
  });

  it('completes the contract the moment you kill your target', () => {
    const h = setup(five, 'assassin', 2);
    const shooter = 'a';
    const target = h.brief(shooter).contract!;
    h.runUntil('dark');
    h.holdFire('a');
    const seen = h.seen(shooter);
    h.match.input(shooter, 2, 0, 0, aimAt(seen.find((p) => p.id === shooter)!, seen.find((p) => p.id === target)!));
    h.runUntil('lights', shooter);

    // Beams pierce, so the shot may cross a bystander too: completion is what matters.
    expect(h.brief(shooter).status).toBe('complete');
    expect(h.match.scoreOf(shooter)).toBe(1);
    // Done and out of the arena.
    expect(h.match.alive(shooter)).toBe(false);
  });

  it('counts kills of anyone else, and three of them complete the contract', () => {
    const h = setup(five, 'assassin', 3);
    const shooter = 'a';
    const target = h.brief(shooter).contract!;
    const victims = five.filter((id) => id !== shooter && id !== target);

    for (const [i, victim] of victims.entries()) {
      h.runUntil('dark');
      const standing = h.seen(shooter).filter((p) => p.alive);
      for (const p of standing) h.match.input(p.id, 2, 0, 0, clearAim(p, standing.filter((o) => o.id !== p.id)));
      const from = standing.find((p) => p.id === shooter)!;
      const to = standing.find((p) => p.id === victim)!;
      const others = standing.filter((p) => p.id !== shooter && p.id !== victim);
      // Only take the shot if it would hit nobody but the victim.
      const angle = aimAt(from, to);
      expect(Math.min(...others.map((o) => offRay(from, angle, o)))).toBeGreaterThan(HIT_RADIUS);
      h.match.input(shooter, 2, 0, 0, angle);
      h.runUntil('lights', shooter);

      const brief = h.brief(shooter);
      if (i < 2) {
        expect(brief.progress).toBe(i + 1);
        expect(brief.status).toBe('live');
      } else {
        expect(brief.status).toBe('complete');
        expect(h.match.scoreOf(shooter)).toBe(1);
      }
    }
  });

  it('fails the contract of anyone killed before completing it', () => {
    const h = setup(five, 'assassin', 4);
    const shooter = 'a';
    const victim = five.find((id) => id !== shooter && h.brief(shooter).contract !== id)!;
    h.runUntil('dark');
    h.holdFire('a');
    const seen = h.seen(shooter);
    h.match.input(shooter, 2, 0, 0, aimAt(seen.find((p) => p.id === shooter)!, seen.find((p) => p.id === victim)!));
    h.runUntil('lights', victim);
    expect(h.brief(victim).status).toBe('failed');
    expect(h.match.scoreOf(victim)).toBe(0);
  });

  it('does not complete your contract when someone else kills your target', () => {
    const h = setup(five, 'assassin', 5);
    const owner = 'a';
    const target = h.brief(owner).contract!;
    const killer = five.find((id) => id !== owner && id !== target)!;
    h.runUntil('dark');
    h.holdFire('a');
    const seen = h.seen(killer);
    h.match.input(killer, 2, 0, 0, aimAt(seen.find((p) => p.id === killer)!, seen.find((p) => p.id === target)!));
    h.runUntil('lights', owner);
    expect(h.brief(owner).status).toBe('live');
    expect(h.brief(owner).progress).toBe(0);
  });

  it('deals fresh contracts every round', () => {
    const h = setup(five, 'assassin', 6);
    const first = new Map(five.map((id) => [id, h.brief(id).contract]));
    for (let cycle = 0; cycle < ROUND_CYCLES.assassin; cycle++) {
      h.runUntil('dark');
      h.holdFire('a');
    }
    h.runUntil('round');
    h.runUntil('round');
    for (const id of five) {
      expect(h.brief(id).status).toBe('live');
      expect(h.brief(id).contract).not.toBe(first.get(id));
    }
  });
});

describe('round modes and the network', () => {
  it('keeps every opponent position out of a living fighter’s blackout traffic', () => {
    for (const mode of ['hunted', 'ghost', 'assassin'] as const) {
      const h = setup(['a', 'b', 'c'], mode, 11);
      h.runUntil('dark');
      const from = h.sent.length;
      for (let i = 0; i < 20; i++) {
        h.advance(100);
        h.match.pushState([]);
      }
      for (const s of h.sent.slice(from)) {
        if (s.msg.t === 'lights') continue;
        expect(['self', 'dark']).toContain(s.msg.t);
        if (s.msg.t === 'self') expect(s.to).toBeDefined();
      }
    }
  });

  it('feeds spectators positions but never anybody’s contract', () => {
    const h = setup(['a', 'b', 'c', 'd'], 'assassin', 12);
    h.runUntil('dark');
    const from = h.sent.length;
    h.match.pushState(['late']);
    const watch = h.sent.slice(from).filter((s) => s.msg.t === 'watch');
    expect(watch.map((s) => s.to)).toEqual(['late']);
    for (const s of watch) expect(JSON.stringify(s.msg)).not.toMatch(/contract|role|brief/);
  });

  it('keeps going when the Target drops out, and skips them from then on', () => {
    const h = setup(['a', 'b', 'c'], 'hunted', 13);
    const gone = h.last('round').focus!;
    h.match.disconnect(gone);
    const focuses = playQuietly(h);
    expect(focuses.slice(1)).not.toContain(gone);
    expect(h.last('over').gameMode).toBe('hunted');
  });

  it('ends with standings ranked by score', () => {
    const h = setup(['a', 'b', 'c'], 'ghost', 14);
    playQuietly(h);
    const over = h.last('over');
    const scores = over.standings.map((s) => s.score!);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    // Every round awards exactly one point, and Ghost stops at the winning one.
    expect(scores.reduce((sum, s) => sum + s, 0)).toBe(over.rounds);
    expect(scores[0]).toBe(WIN_SCORE.ghost);
  });

  it('plays Ghost to a score rather than a fixed number of rounds', () => {
    const h = setup(['a', 'b', 'c', 'd'], 'ghost', 15);
    playQuietly(h);
    const over = h.last('over');
    expect(over.standings[0]!.score).toBe(WIN_SCORE.ghost);
    expect(over.rounds).toBeLessThan(h.match.rounds);
  });
});
