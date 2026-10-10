import { BROADCAST_HZ } from '../shared/constants.js';
import type { MiniGameId } from '../shared/games.js';
import type { MapId } from '../shared/maps.js';
import type {
  LobbyPlayer,
  MiniExtra,
  MiniPlayer,
  ServerMessage,
  Standing,
} from '../shared/protocol.js';
import type { Broadcast } from './match.js';

export interface MiniMatchPlayer extends LobbyPlayer {
  x: number;
  y: number;
  aim: number;
  alive: boolean;
  connected: boolean;
  mx: number;
  my: number;
  /** The action button: a dash, a shove, a lunge — whatever the game has. */
  action: boolean;
  /** Round this fighter went out on, or null while still in. */
  out: number | null;
  seq: number;
  /** Rounds survived, bombs passed, shoves landed: whatever the game counts. */
  score: number;
}

/**
 * The lit games.
 *
 * Everything DeadLight does in the dark — hidden positions, one snapshot a
 * round, beams resolved from it — these games do not do. The floor is lit, the
 * state goes out to everyone several times a second, and fighters are
 * eliminated by the arena rather than by a shot. What they do share is the
 * lobby, the fighters and the shape of a match, so this base holds the parts
 * the room already knows how to drive: `input`, `tick`, `pushState`, `settle`.
 */
export abstract class MiniMatch {
  abstract readonly kind: MiniGameId;

  round = 0;
  winner: string | null = null;
  finished = false;
  /** Set once the last elimination has happened; the result follows after a beat. */
  protected over = false;
  protected overAt = 0;

  protected readonly players: MiniMatchPlayer[];
  protected readonly startCount: number;
  /** Server clock the state carries, so clients can age effects correctly. */
  protected now = 0;

  constructor(
    roster: readonly LobbyPlayer[],
    protected readonly send: Broadcast,
    now: number,
    readonly map: MapId,
    spawns: readonly { x: number; y: number; aim: number }[],
  ) {
    this.startCount = roster.length;
    this.now = now;
    this.players = roster.map((p, i) => ({
      ...p,
      x: spawns[i]?.x ?? 0,
      y: spawns[i]?.y ?? 0,
      aim: spawns[i]?.aim ?? 0,
      alive: true,
      connected: true,
      mx: 0,
      my: 0,
      action: false,
      out: null,
      seq: 0,
      score: 0,
    }));
  }

  /** Sent once the subclass has its own state ready to describe. */
  protected announce(): void {
    this.send({
      t: 'match',
      players: this.players.map(({ id, name, color, ready, finisher, wins, bot }) => ({
        id,
        name,
        color,
        ready,
        finisher,
        wins,
        bot,
      })),
      startCount: this.startCount,
      map: this.map,
      gameMode: this.kind,
    });
  }

  input(
    id: string,
    seq: number,
    mx: number,
    my: number,
    aim: number,
    _report?: { x: number; y: number },
    _now?: number,
    action = false,
  ): void {
    const p = this.players.find((x) => x.id === id);
    if (!p?.alive || !p.connected || this.over) return;
    if (seq < p.seq) return;
    p.seq = seq;
    p.mx = Number.isFinite(mx) ? Math.max(-1, Math.min(1, mx)) : 0;
    p.my = Number.isFinite(my) ? Math.max(-1, Math.min(1, my)) : 0;
    if (Number.isFinite(aim)) p.aim = aim;
    // Held across ticks until the client lets go, so a tap is never missed.
    p.action = p.action || action;
  }

  /** A dropped fighter stops moving but stays in the game until the arena takes them. */
  disconnect(id: string): void {
    const p = this.players.find((x) => x.id === id);
    if (!p) return;
    p.connected = false;
    p.mx = 0;
    p.my = 0;
    p.action = false;
  }

  alive(id: string): boolean {
    return this.players.some((p) => p.id === id && p.alive);
  }

  tick(now: number, dt: number): void {
    this.now = now;
    if (this.over) return;
    this.advance(now, dt);
    this.checkEnd(now);
  }

  /** One step of this game. Subclasses move fighters and judge the arena. */
  protected abstract advance(now: number, dt: number): void;

  /** Everything public about the floor right now. */
  protected abstract extra(): MiniExtra;

  /** How long is left of whatever the game is counting down, in milliseconds. */
  protected left(): number {
    return 0;
  }

  /**
   * These games are lit, so there is nothing to hide: everyone gets the same
   * state, spectators included.
   */
  pushState(_spectators: readonly string[]): void {
    this.send({
      t: 'mini',
      kind: this.kind,
      round: this.round,
      time: this.now,
      left: Math.round(this.left()),
      players: this.snapshot(),
      scores: Object.fromEntries(this.players.map((p) => [p.id, p.score])),
      extra: this.extra(),
    });
  }

  /** The beat between the last elimination and the result card. */
  protected static readonly SETTLE_MS = 1600;

  settle(now: number): void {
    if (!this.over || this.finished || now < this.overAt + MiniMatch.SETTLE_MS) return;
    this.finished = true;
    this.send({
      t: 'over',
      winner: this.winner,
      rounds: this.round,
      standings: this.standings(),
      wins: {},
      gameMode: this.kind,
    });
  }

  protected eliminate(p: MiniMatchPlayer): void {
    if (!p.alive) return;
    p.alive = false;
    p.out = this.round;
    p.mx = 0;
    p.my = 0;
    p.action = false;
  }

  protected standing(): MiniMatchPlayer[] {
    return this.players.filter((p) => p.alive);
  }

  /** One fighter left, or none: the game is done. */
  private checkEnd(now: number): void {
    const left = this.standing();
    if (left.length > 1) return;
    this.over = true;
    this.overAt = now;
    this.winner = left[0]?.id ?? null;
    for (const p of left) p.score++;
  }

  protected snapshot(): MiniPlayer[] {
    return this.players.map((p) => ({
      id: p.id,
      x: Math.round(p.x),
      y: Math.round(p.y),
      aim: Math.round(p.aim * 100) / 100,
      state: p.alive ? ('alive' as const) : ('out' as const),
    }));
  }

  /** Survivors first, then whoever lasted longest. */
  protected standings(): Standing[] {
    return [...this.players]
      .sort((a, b) => (b.out ?? Infinity) - (a.out ?? Infinity) || b.score - a.score)
      .map((p) => ({
        id: p.id,
        roundsSurvived: p.out ?? this.round,
        kills: 0,
        longest: 0,
        killedBy: null,
        score: p.score,
      }));
  }
}

/** Effects older than this are dropped from the state; the client has seen them. */
export const EFFECT_TTL_MS = Math.ceil(3000 / BROADCAST_HZ) * 10;

/** Keeps a list of timestamped effects short. */
export function recent<T extends { at: number }>(items: T[], now: number): T[] {
  return items.filter((item) => now - item.at <= EFFECT_TTL_MS);
}
