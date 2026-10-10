import { openWorld, spawnsFor, type MapId } from '../shared/maps.js';
import {
  CONTRACT_KILLS,
  ROUND_CYCLES,
  WIN_SCORE,
  dealContracts,
  huntLine,
  nextFocus,
  pickZone,
  roundCount,
  shuffle,
  zoneStart,
  type Role,
  type RoundModeId,
  type Zone,
} from '../shared/modes.js';
import type { Brief, LobbyPlayer, RoundOutcome, Standing } from '../shared/protocol.js';
import { resolveRound, type Resolution } from '../shared/resolve.js';
import { Match, type Broadcast, type MatchPlayer } from './match.js';

/** Everyone visible, roles on screen, before the first blackout of a round. */
export const ROUND_INTRO_MS = 1800;
/** The reveal between blackouts inside a round. */
export const ROUND_LIGHTS_MS = 1200;
/** The decisive reveal plus the round's result banner. */
export const ROUND_RESULT_MS = 2600;

type ContractStatus = 'live' | 'complete' | 'failed';

/** What the rules make of one reveal. */
interface Verdict {
  /** Fighters actually taken out by it. */
  eliminated: Set<string>;
  /** Kills that count, for the stats on the result card. */
  credited: { shooter: string; target: string }[];
  /** Set when the reveal ends the round. */
  outcome: RoundOutcome | null;
}

/**
 * Hunted, Ghost and Assassin: short rounds of a few blackouts with roles dealt
 * by the server. The blackout cycle, movement, input checking and blackout
 * privacy are all inherited from Classic; what is decided here is who plays
 * what, which hits count, who scores, and who gets to see whom.
 */
export class RoundMatch extends Match {
  readonly rounds: number;
  private roundIndex = 0;
  private cycle = 0;
  private roundOver = false;

  private focus: string | null = null;
  private zone: Zone | null = null;
  private roles = new Map<string, Role>();
  private contracts = new Map<string, string>();
  private previousContracts = new Map<string, string>();
  private progress = new Map<string, number>();
  private status = new Map<string, ContractStatus>();

  private readonly scores = new Map<string, number>();
  private readonly turns = new Map<string, number>();
  private readonly order: string[];

  constructor(
    roster: readonly LobbyPlayer[],
    send: Broadcast,
    now: number,
    map: MapId,
    readonly mode: RoundModeId,
    private readonly rng: () => number = Math.random,
  ) {
    super(roster, send, now, map, false);
    this.rounds = roundCount(mode, roster.length);
    this.order = shuffle(roster.map((p) => p.id), rng);
    for (const p of roster) this.scores.set(p.id, 0);

    this.send({
      t: 'match',
      players: roster.map((p) => ({ ...p })),
      startCount: this.startCount,
      map,
      gameMode: mode,
    });
    this.beginRound(now);
  }

  /** The role of a fighter this round, for tests and the room. */
  roleOf(id: string): Role | undefined {
    return this.roles.get(id);
  }

  scoreOf(id: string): number {
    return this.scores.get(id) ?? 0;
  }

  protected override zoneOf(p: MatchPlayer): Zone | null {
    return this.mode === 'hunted' && p.id === this.focus ? this.zone : null;
  }

  /** Hunted's line stands still: a hunter has an aim and nothing else. */
  protected override canMove(p: MatchPlayer): boolean {
    return this.mode !== 'hunted' || p.id === this.focus;
  }

  /** After a decisive reveal, the next "blackout" is the next round instead. */
  protected override startBlackout(now: number): void {
    if (!this.roundOver) {
      super.startBlackout(now);
      return;
    }
    if (this.roundIndex >= this.rounds || this.won()) this.finish(now);
    else this.beginRound(now);
  }

  // --- a round ------------------------------------------------------------------

  private beginRound(now: number): void {
    this.roundIndex++;
    this.cycle = 0;
    this.roundOver = false;
    this.phase = 'lights';
    this.world.broken.clear();

    // Anyone who has dropped out sits the round out instead of standing frozen.
    const playing = this.players.filter((p) => p.connected);
    for (const p of this.players) {
      p.alive = p.connected;
      p.out = null;
      p.mx = 0;
      p.my = 0;
    }

    this.deal(playing);
    this.place(playing, now);

    this.send({
      t: 'round',
      mode: this.mode,
      round: this.roundIndex,
      rounds: this.rounds,
      focus: this.focus,
      ...(this.zone ? { zone: this.zone } : {}),
      scores: Object.fromEntries(this.scores),
      outcome: null,
    });
    for (const p of this.players) this.send({ t: 'brief', brief: this.briefFor(p.id) }, p.id);

    // The intro shows everyone, the Ghost included: its starting spot is the
    // one clue the hunters get.
    this.send({
      t: 'lights',
      round: this.round,
      stage: 0,
      size: this.size,
      previousSize: this.size,
      players: this.snapshot(playing),
      resolution: null,
      remaining: playing.length,
      holdMs: ROUND_INTRO_MS,
      broken: [],
    });
    this.phaseEndsAt = now + ROUND_INTRO_MS;
  }

  private deal(playing: readonly MatchPlayer[]): void {
    const ids = playing.map((p) => p.id);
    this.roles = new Map();
    this.focus = null;
    this.zone = null;

    if (this.mode === 'assassin') {
      this.contracts = dealContracts(ids, this.previousContracts, this.rng);
      this.previousContracts = this.contracts;
      this.progress = new Map(ids.map((id) => [id, 0]));
      this.status = new Map(ids.map((id) => [id, 'live']));
      for (const id of ids) this.roles.set(id, 'assassin');
      return;
    }

    this.focus = nextFocus(this.order, this.turns, (id) => ids.includes(id));
    if (this.focus) this.turns.set(this.focus, (this.turns.get(this.focus) ?? 0) + 1);
    for (const id of ids) this.roles.set(id, id === this.focus ? (this.mode === 'hunted' ? 'target' : 'ghost') : 'hunter');
    if (this.mode === 'hunted') {
      // A shooting gallery, not a maze: the gallery is cleared of cover so the
      // box is the only thing between the line and the Target.
      this.world.layout = openWorld(this.size).layout;
      this.world.broken.clear();
      this.zone = pickZone(this.world, this.rng);
    }
  }

  private place(playing: readonly MatchPlayer[], now: number): void {
    if (this.mode === 'hunted' && this.zone) {
      const hunters = playing.filter((p) => p.id !== this.focus);
      const line = huntLine(hunters.length, this.world, this.zone);
      hunters.forEach((p, i) => {
        const spot = line[i]!;
        p.x = spot.x;
        p.y = spot.y;
        p.aim = spot.aim;
        p.anchor = { x: spot.x, y: spot.y, at: now };
        p.onPad = null;
      });
      const target = playing.find((p) => p.id === this.focus);
      if (target) {
        const spot = zoneStart(this.zone);
        target.x = spot.x;
        target.y = spot.y;
        target.aim = Math.PI / 2;
        target.anchor = { x: spot.x, y: spot.y, at: now };
        target.onPad = null;
      }
      return;
    }

    const spawns = spawnsFor(playing.length, this.world, this.rng() * Math.PI * 2);
    playing.forEach((p, i) => {
      const spot = spawns[i]!;
      p.x = spot.x;
      p.y = spot.y;
      // Face the middle; a Target on its path faces along it.
      p.aim = Math.atan2(-spot.y, -spot.x);
      p.anchor = { x: spot.x, y: spot.y, at: now };
      p.onPad = null;
    });
  }

  // --- a reveal -----------------------------------------------------------------

  protected override endBlackout(now: number): void {
    this.phase = 'lights';
    this.cycle++;

    const contenders = this.players.filter((p) => p.alive);
    // Neither the Ghost nor the Target carries a weapon: both only dodge.
    const unarmed = new Set(this.focus && this.mode !== 'assassin' ? [this.focus] : []);
    const resolution = resolveRound(contenders, this.world, unarmed);
    for (const id of resolution.broken) this.world.broken.add(id);

    const verdict = this.judge(resolution, contenders);
    this.credit(verdict.credited, contenders);

    // Drawn before anyone is removed, from the positions the shots came from.
    const shown = contenders.map((p) => ({ ...p, alive: !verdict.eliminated.has(p.id) }));
    for (const p of contenders) {
      if (verdict.eliminated.has(p.id)) {
        p.alive = false;
        p.out = this.round;
      }
    }
    // Assassins who completed their contract leave the arena after this reveal.
    if (this.mode === 'assassin') {
      for (const p of contenders) if (this.status.get(p.id) === 'complete') p.alive = false;
    }

    const outcome = verdict.outcome ?? this.timeUp();
    if (outcome) {
      this.roundOver = true;
      this.award(outcome);
    }

    const hold = outcome ? ROUND_RESULT_MS : ROUND_LIGHTS_MS;
    const remaining = this.players.filter((p) => p.alive).length;
    for (const viewer of this.players) {
      this.send(
        {
          t: 'lights',
          round: this.round,
          stage: 0,
          size: this.size,
          previousSize: this.size,
          players: this.snapshot(shown.filter((p) => this.sees(viewer.id, p.id, outcome !== null))),
          resolution,
          remaining,
          holdMs: hold,
          broken: [...this.world.broken],
        },
        viewer.id,
      );
    }

    if (this.mode === 'assassin') {
      for (const p of this.players) this.send({ t: 'brief', brief: this.briefFor(p.id) }, p.id);
    }
    if (outcome) {
      this.send({
        t: 'round',
        mode: this.mode,
        round: this.roundIndex,
        rounds: this.rounds,
        focus: this.focus,
        ...(this.zone ? { zone: this.zone } : {}),
        scores: Object.fromEntries(this.scores),
        outcome,
      });
    }
    this.phaseEndsAt = now + hold;
  }

  /**
   * Whether `viewer` is shown `subject` at a mid-round reveal. Only the Ghost
   * is ever withheld: hunters never receive its position until the round is
   * over, so there is nothing in their client to find.
   */
  private sees(viewer: string, subject: string, roundOver: boolean): boolean {
    if (this.mode !== 'ghost' || roundOver || subject !== this.focus) return true;
    return viewer === this.focus;
  }

  /** Which of the reveal's hits count under this mode's rules. */
  private judge(resolution: Resolution, contenders: readonly MatchPlayer[]): Verdict {
    const eliminated = new Set<string>();
    const credited: Verdict['credited'] = [];

    if (this.mode === 'assassin') {
      for (const id of resolution.eliminated) eliminated.add(id);
      for (const kill of resolution.kills) {
        if (kill.shooter === kill.target) continue;
        credited.push(kill);
        if (this.status.get(kill.shooter) !== 'live') continue;
        const count = (this.progress.get(kill.shooter) ?? 0) + (this.contracts.get(kill.shooter) === kill.target ? 0 : 1);
        this.progress.set(kill.shooter, count);
        if (this.contracts.get(kill.shooter) === kill.target || count >= CONTRACT_KILLS) {
          // Scored on the spot: a completed contract cannot be taken back.
          this.status.set(kill.shooter, 'complete');
          this.scores.set(kill.shooter, (this.scores.get(kill.shooter) ?? 0) + 1);
        }
      }
      // A contract finished in the same instant its owner is hit still counts:
      // the shot landed. Anyone else hit with a live contract has failed it.
      for (const id of eliminated) if (this.status.get(id) === 'live') this.status.set(id, 'failed');

      const left = contenders.filter((p) => !eliminated.has(p.id) && this.status.get(p.id) === 'live');
      const outcome: RoundOutcome | null =
        left.length <= 1 ? { kind: 'contracts', winners: this.contractsThisRound() } : null;
      return { eliminated, credited, outcome };
    }

    const focus = this.focus;
    if (!focus) return { eliminated, credited, outcome: { kind: 'escaped', focus: '' } };

    const winners = new Set<string>();
    for (const kill of resolution.kills) {
      if (kill.target === focus) {
        eliminated.add(focus);
        // A Target caught by its own bounce goes down, but nobody earns it.
        if (kill.shooter !== focus) {
          winners.add(kill.shooter);
          credited.push(kill);
        }
      }
      // Hunters hitting hunters do nothing: they are on the same side, and the
      // Target has nothing to shoot back with.
    }

    if (eliminated.has(focus)) {
      return { eliminated, credited, outcome: { kind: 'caught', focus, winners: [...winners] } };
    }
    const hunters = contenders.filter((p) => p.id !== focus && !eliminated.has(p.id));
    if (hunters.length === 0) return { eliminated, credited, outcome: { kind: 'escaped', focus } };
    return { eliminated, credited, outcome: null };
  }

  /** Assassins who completed a contract during the current round. */
  private contractsThisRound(): string[] {
    return [...this.status].filter(([, s]) => s === 'complete').map(([id]) => id);
  }

  /** The round's last blackout passed without a decision. */
  private timeUp(): RoundOutcome | null {
    if (this.cycle < ROUND_CYCLES[this.mode]) return null;
    if (this.mode === 'assassin') return { kind: 'contracts', winners: this.contractsThisRound() };
    return { kind: 'escaped', focus: this.focus ?? '' };
  }

  /** Hunted and Ghost score when the round is decided; Assassin already scored each contract. */
  private award(outcome: RoundOutcome): void {
    if (outcome.kind === 'contracts') return;
    const winners = outcome.kind === 'escaped' ? (outcome.focus ? [outcome.focus] : []) : outcome.winners;
    for (const id of winners) this.scores.set(id, (this.scores.get(id) ?? 0) + 1);
  }

  /** Kill stats for the result card, counting only hits the mode accepted. */
  private credit(kills: Verdict['credited'], contenders: readonly MatchPlayer[]): void {
    for (const kill of kills) {
      const shooter = contenders.find((p) => p.id === kill.shooter);
      const target = contenders.find((p) => p.id === kill.target);
      if (!shooter || !target) continue;
      target.killedBy ??= shooter.id;
      shooter.kills++;
      shooter.longest = Math.max(shooter.longest, Math.hypot(target.x - shooter.x, target.y - shooter.y));
    }
  }

  /** One fighter's private orders: nothing here may describe anyone else's. */
  private briefFor(id: string): Brief {
    const role = this.roles.get(id) ?? 'hunter';
    if (this.mode === 'assassin') {
      return {
        role,
        contract: this.contracts.get(id),
        progress: this.progress.get(id) ?? 0,
        status: this.status.get(id) ?? 'failed',
      };
    }
    return { role };
  }

  // --- the end ------------------------------------------------------------------

  /** Whether anyone has taken the match on points, in a mode played to a score. */
  private won(): boolean {
    const target = WIN_SCORE[this.mode];
    if (target === undefined) return false;
    return [...this.scores.values()].some((score) => score >= target);
  }

  private finish(now: number): void {
    this.phase = 'over';
    this.phaseEndsAt = now;
    const ranked = this.ranked();
    const [first, second] = ranked;
    const tied = second && second.score === first?.score && second.kills === first.kills;
    this.winner = first && !tied ? first.id : null;
  }

  override settle(now: number): void {
    if (this.phase !== 'over' || this.finished || now < this.phaseEndsAt) return;
    this.finished = true;
    this.send({
      t: 'over',
      winner: this.winner,
      rounds: this.roundIndex,
      standings: this.ranked(),
      wins: {},
      gameMode: this.mode,
    });
  }

  /** Highest score first; most kills breaks a tie. */
  private ranked(): (Standing & { score: number })[] {
    return this.players
      .map((p) => ({
        id: p.id,
        roundsSurvived: this.roundIndex,
        kills: p.kills,
        longest: Math.round(p.longest),
        killedBy: null,
        score: this.scores.get(p.id) ?? 0,
      }))
      .sort((a, b) => b.score - a.score || b.kills - a.kills);
  }
}
