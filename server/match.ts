import { arenaSize, clampToArena, spawnPoints } from '../shared/arena.js';
import { stepPlayer } from '../shared/movement.js';
import {
  BLACKOUT_MAX_MS,
  BLACKOUT_MIN_MS,
  LIGHTS_ON_MS,
  LIGHTS_ON_SHRINK_MS,
  PLAYER_RADIUS,
} from '../shared/constants.js';
import type { LobbyPlayer, ServerMessage, SnapshotPlayer, Standing } from '../shared/protocol.js';
import { resolveRound } from '../shared/resolve.js';
import { nextStage } from '../shared/stages.js';

interface MatchPlayer extends LobbyPlayer {
  x: number;
  y: number;
  aim: number;
  alive: boolean;
  connected: boolean;
  mx: number;
  my: number;
  /** Round this player went out on, or null while still standing. */
  out: number | null;
}

type Phase = 'lights' | 'dark' | 'over';

export type Broadcast = (message: ServerMessage, to?: string) => void;

/**
 * One match, driven by `tick`. The phases alternate lights-on and blackout;
 * every round is resolved from the single snapshot taken the instant the
 * lights come back.
 */
export class Match {
  phase: Phase = 'lights';
  round = 0;
  stage = 0;
  size: number;
  winner: string | null = null;
  finished = false;

  private readonly players: MatchPlayer[];
  private readonly startCount: number;
  private phaseEndsAt: number;
  private roundsWithoutElimination = 0;

  constructor(
    roster: readonly LobbyPlayer[],
    private readonly send: Broadcast,
    now: number,
  ) {
    this.startCount = roster.length;
    this.size = arenaSize(this.startCount, 0);

    const spawns = spawnPoints(roster.length, this.size, Math.random() * Math.PI * 2);
    this.players = roster.map((p, i) => ({
      ...p,
      x: spawns[i]!.x,
      y: spawns[i]!.y,
      aim: spawns[i]!.aim,
      alive: true,
      connected: true,
      mx: 0,
      my: 0,
      out: null,
    }));

    this.phaseEndsAt = now + LIGHTS_ON_MS;
    this.send({ t: 'match', players: roster.map((p) => ({ ...p })), startCount: this.startCount });
    this.send({
      t: 'lights',
      round: 0,
      stage: 0,
      size: this.size,
      previousSize: this.size,
      players: this.snapshot(this.players),
      resolution: null,
      remaining: this.startCount,
      holdMs: LIGHTS_ON_MS,
    });
  }

  input(id: string, mx: number, my: number, aim: number): void {
    if (this.phase !== 'dark') return;
    const p = this.players.find((x) => x.id === id);
    if (!p?.alive || !p.connected) return;

    p.mx = mx;
    p.my = my;
    if (Number.isFinite(aim)) p.aim = aim;
  }

  /** A dropped player leaves a frozen body that can still be hit. */
  disconnect(id: string): void {
    const p = this.players.find((x) => x.id === id);
    if (!p) return;
    p.connected = false;
    p.mx = 0;
    p.my = 0;
  }

  tick(now: number, dt: number): void {
    if (this.phase === 'dark') this.move(dt);
    if (this.phase === 'over' || now < this.phaseEndsAt) return;

    if (this.phase === 'lights') this.startBlackout(now);
    else if (this.phase === 'dark') this.endBlackout(now);
  }

  /**
   * On the broadcast clock during blackout: a living client is told only where
   * it is itself, so no client in the match ever holds an opponent's position.
   */
  pushState(spectators: readonly string[]): void {
    if (this.phase !== 'dark') return;

    for (const p of this.players) {
      if (p.alive && p.connected) this.send({ t: 'self', x: p.x, y: p.y }, p.id);
    }

    if (spectators.length === 0) return;
    const view = this.snapshot(this.players.filter((p) => p.alive));
    for (const id of spectators) this.send({ t: 'watch', players: view }, id);
  }

  alive(id: string): boolean {
    return this.players.some((p) => p.id === id && p.alive);
  }

  /** Announces the result once the final lights-on beat has played out. */
  settle(now: number): void {
    if (this.phase !== 'over' || this.finished || now < this.phaseEndsAt) return;
    this.finished = true;
    this.send({ t: 'over', winner: this.winner, rounds: this.round, standings: this.standings() });
  }

  private move(dt: number): void {
    for (const p of this.players) {
      if (!p.alive || !p.connected || (p.mx === 0 && p.my === 0)) continue;
      const moved = stepPlayer(p, p.mx, p.my, dt, this.size);
      p.x = moved.x;
      p.y = moved.y;
    }
  }

  private startBlackout(now: number): void {
    this.phase = 'dark';
    this.round++;
    for (const p of this.players) {
      p.mx = 0;
      p.my = 0;
    }
    this.phaseEndsAt = now + BLACKOUT_MIN_MS + Math.random() * (BLACKOUT_MAX_MS - BLACKOUT_MIN_MS);
    this.send({ t: 'dark', round: this.round });
  }

  private endBlackout(now: number): void {
    this.phase = 'lights';

    const contenders = this.players.filter((p) => p.alive);
    const resolution = resolveRound(contenders, this.size);
    const eliminated = new Set(resolution.eliminated);
    for (const p of contenders) {
      if (!eliminated.has(p.id)) continue;
      p.alive = false;
      p.out = this.round;
    }

    const survivors = this.players.filter((p) => p.alive);
    const previousSize = this.size;
    let shrank = false;

    if (survivors.length > 1) {
      this.roundsWithoutElimination = eliminated.size > 0 ? 0 : this.roundsWithoutElimination + 1;
      const stage = nextStage(this.stage, this.startCount, survivors.length, this.roundsWithoutElimination);
      if (stage !== this.stage) {
        this.stage = stage;
        this.size = arenaSize(this.startCount, stage);
        this.roundsWithoutElimination = 0;
        shrank = true;
        for (const p of survivors) {
          const moved = clampToArena(p, this.size, PLAYER_RADIUS);
          p.x = moved.x;
          p.y = moved.y;
        }
      }
    }

    const holdMs = shrank ? LIGHTS_ON_SHRINK_MS : LIGHTS_ON_MS;
    this.send({
      t: 'lights',
      round: this.round,
      stage: this.stage,
      size: this.size,
      previousSize,
      players: this.snapshot(contenders),
      resolution,
      remaining: survivors.length,
      holdMs,
    });

    this.phaseEndsAt = now + holdMs;
    if (survivors.length <= 1) {
      this.phase = 'over';
      this.winner = survivors[0]?.id ?? null;
    }
  }

  /** Survivors first, then whoever lasted longest. */
  private standings(): Standing[] {
    return [...this.players]
      .sort((a, b) => (b.out ?? Infinity) - (a.out ?? Infinity))
      .map((p) => ({ id: p.id, roundsSurvived: p.out ?? this.round }));
  }

  /** Only the players who were standing when the lights came on. */
  private snapshot(source: readonly MatchPlayer[]): SnapshotPlayer[] {
    return source.map((p) => ({ id: p.id, x: p.x, y: p.y, aim: p.aim, alive: p.alive }));
  }
}
