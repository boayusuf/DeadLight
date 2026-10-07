import { arenaSize } from '../shared/arena.js';
import {
  collide,
  layoutFor,
  maxDrift,
  padUnder,
  spawnsFor,
  teleportStep,
  type MapId,
  type World,
} from '../shared/maps.js';
import { stepPlayer } from '../shared/movement.js';
import {
  BLACKOUT_MAX_MS,
  BLACKOUT_MIN_MS,
  KILLCAM_MS,
  LIGHTS_ON_MS,
  LIGHTS_ON_SHRINK_MS,
  MOVE_SPEED,
  PLAYER_RADIUS,
  REPLAY_HZ,
  SNAP_GRACE_MS,
  STALL_ROUNDS,
} from '../shared/constants.js';
import type {
  LobbyPlayer,
  ReplayTrack,
  ServerMessage,
  SnapshotPlayer,
  Standing,
} from '../shared/protocol.js';
import { resolveRound, type Resolution } from '../shared/resolve.js';
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
  /** Latest input sequence number received from this player. */
  seq: number;
  /** Last position the client reported and the server accepted, and when. */
  anchor: { x: number; y: number; at: number };
  /** Teleporter pad this player stands on and has used; it fires again only after they step off. */
  onPad: string | null;
  kills: number;
  longest: number;
  killedBy: string | null;
  /** Path through the current blackout, for the killcam. */
  trail: [number, number, number][];
}

const SAMPLE_MS = 1000 / REPLAY_HZ;

/** Headroom for network jitter when checking how far a report has moved. */
const REPORT_TOLERANCE = 1.3;
const REPORT_SLACK = 24;

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
  private readonly world: World & { broken: Set<string> };
  private phaseEndsAt: number;
  private roundsWithoutElimination = 0;
  /** Rounds the last two have gone without a hit; enough of them and the cover goes. */
  private showdownStall = 0;
  private nextSampleAt = 0;

  constructor(
    roster: readonly LobbyPlayer[],
    private readonly send: Broadcast,
    now: number,
    readonly map: MapId = 'reactor',
  ) {
    this.startCount = roster.length;
    this.size = arenaSize(this.startCount, 0);
    this.world = { size: this.size, layout: layoutFor(map, this.size), broken: new Set() };

    const spawns = spawnsFor(roster.length, this.world, Math.random() * Math.PI * 2);
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
      seq: 0,
      anchor: { x: spawns[i]!.x, y: spawns[i]!.y, at: now },
      onPad: null,
      kills: 0,
      longest: 0,
      killedBy: null,
      trail: [],
    }));

    this.phaseEndsAt = now + LIGHTS_ON_MS;
    this.send({ t: 'match', players: roster.map((p) => ({ ...p })), startCount: this.startCount, map });
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
      broken: [],
    });
  }

  /**
   * `report` is where the client says it is. It is accepted only if that spot
   * was reachable at full speed since the last accepted report, so the server
   * still decides who can be where — it just stops lagging behind the player.
   */
  input(
    id: string,
    seq: number,
    mx: number,
    my: number,
    aim: number,
    report?: { x: number; y: number },
    now = Date.now(),
  ): void {
    if (this.phase !== 'dark') return;
    const p = this.players.find((x) => x.id === id);
    if (!p?.alive || !p.connected) return;

    p.mx = mx;
    p.my = my;
    p.seq = Math.max(p.seq, seq);
    if (Number.isFinite(aim)) p.aim = aim;

    if (!report || !Number.isFinite(report.x) || !Number.isFinite(report.y)) return;
    const inside = collide(report, PLAYER_RADIUS, this.world);
    const speed = MOVE_SPEED + maxDrift(this.world.layout);
    const reach = ((speed * Math.max(0, now - p.anchor.at)) / 1000) * REPORT_TOLERANCE + REPORT_SLACK;
    if (Math.hypot(inside.x - p.anchor.x, inside.y - p.anchor.y) > reach) return;

    p.x = inside.x;
    p.y = inside.y;
    p.anchor = { x: inside.x, y: inside.y, at: now };
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
    if (this.phase === 'dark') {
      this.move(now, dt);
      this.sample(now);
    }
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
      if (p.alive && p.connected) this.send({ t: 'self', x: p.x, y: p.y, seq: p.seq }, p.id);
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
    // The room outlives the match and owns the running tally, so it fills `wins` in.
    this.send({ t: 'over', winner: this.winner, rounds: this.round, standings: this.standings(), wins: {} });
  }

  private move(now: number, dt: number): void {
    for (const p of this.players) {
      // Belts drag everyone still standing, input or not, connected or not.
      if (!p.alive) continue;
      const moved = stepPlayer(p, p.mx, p.my, dt, this.world);
      const tele = teleportStep(moved, this.world, p.onPad);
      p.x = tele.x;
      p.y = tele.y;
      p.onPad = tele.onPad;
      // Reports from the new spot must be judged from there, not from the pad left behind.
      if (tele.jumped) p.anchor = { x: tele.x, y: tele.y, at: now };
    }
  }

  /** Records where everyone is, a few times a second, for the killcam. */
  private sample(now: number): void {
    if (now < this.nextSampleAt) return;
    this.nextSampleAt = now + SAMPLE_MS;
    for (const p of this.players) {
      if (p.alive) p.trail.push(trailPoint(p));
    }
  }

  private startBlackout(now: number): void {
    this.phase = 'dark';
    this.round++;
    for (const p of this.players) {
      p.mx = 0;
      p.my = 0;
      p.anchor = { x: p.x, y: p.y, at: now };
      p.onPad = padUnder(p, this.world);
      p.trail = p.alive ? [trailPoint(p)] : [];
    }
    this.nextSampleAt = now + SAMPLE_MS;
    const duration = Math.round(BLACKOUT_MIN_MS + Math.random() * (BLACKOUT_MAX_MS - BLACKOUT_MIN_MS));
    this.phaseEndsAt = now + duration + SNAP_GRACE_MS;
    this.send({ t: 'dark', round: this.round, durationMs: duration });
  }

  private endBlackout(now: number): void {
    this.phase = 'lights';

    const contenders = this.players.filter((p) => p.alive);
    const resolution = resolveRound(contenders, this.world);
    for (const id of resolution.broken) this.world.broken.add(id);
    this.tally(resolution, contenders);
    const eliminated = new Set(resolution.eliminated);
    for (const p of contenders) {
      if (!eliminated.has(p.id)) continue;
      p.alive = false;
      p.out = this.round;
    }

    const survivors = this.players.filter((p) => p.alive);
    const previousSize = this.size;
    // Taken before any shrink moves people, so everyone sees the positions the
    // shots were actually fired from; the client animates the push inward.
    const players = this.snapshot(contenders);
    let shrank = false;

    if (survivors.length > 1) {
      this.roundsWithoutElimination = eliminated.size > 0 ? 0 : this.roundsWithoutElimination + 1;
      const stage = nextStage(this.stage, this.startCount, survivors.length, this.roundsWithoutElimination);
      if (stage !== this.stage) {
        this.stage = stage;
        this.size = arenaSize(this.startCount, stage);
        this.world.size = this.size;
        this.roundsWithoutElimination = 0;
        shrank = true;
        for (const p of survivors) {
          const moved = collide(p, PLAYER_RADIUS, this.world);
          p.x = moved.x;
          p.y = moved.y;
        }
      }
    }

    if (survivors.length === 2) {
      this.showdownStall = eliminated.size > 0 ? 0 : this.showdownStall + 1;
      if (this.showdownStall >= STALL_ROUNDS) this.cutCover();
    }

    const ending = survivors.length <= 1;
    // The final reveal is played as the killcam instead of the usual beat.
    const holdMs = ending ? KILLCAM_MS : shrank ? LIGHTS_ON_SHRINK_MS : LIGHTS_ON_MS;
    this.send({
      t: 'lights',
      round: this.round,
      stage: this.stage,
      size: this.size,
      previousSize,
      players,
      resolution,
      remaining: survivors.length,
      holdMs,
      broken: [...this.world.broken],
      ...(ending ? { replay: this.replay(contenders) } : {}),
    });

    this.phaseEndsAt = now + holdMs;
    if (ending) {
      this.phase = 'over';
      this.winner = survivors[0]?.id ?? null;
    }
  }

  /**
   * Sudden death: two fighters hiding behind pillars can stall forever, so the
   * room cuts power to every bit of cover. Floor machinery keeps running.
   */
  private cutCover(): void {
    for (const o of this.world.layout.obstacles) {
      if (o.kind !== 'teleporter' && o.kind !== 'conveyor') this.world.broken.add(o.id);
    }
  }

  /** Kill counts, the longest shot, and who took each player out first. */
  private tally(resolution: Resolution, contenders: readonly MatchPlayer[]): void {
    for (const kill of resolution.kills) {
      const shooter = contenders.find((p) => p.id === kill.shooter);
      const target = contenders.find((p) => p.id === kill.target);
      if (!shooter || !target) continue;
      target.killedBy ??= shooter.id;
      // A beam that bounced back onto its own shooter is a death, not a kill.
      if (shooter === target) continue;
      shooter.kills++;
      shooter.longest = Math.max(shooter.longest, Math.hypot(target.x - shooter.x, target.y - shooter.y));
    }
  }

  /** The final blackout, closed with the positions the shots were fired from. */
  private replay(contenders: readonly MatchPlayer[]): ReplayTrack[] {
    return contenders.map((p) => ({ id: p.id, points: [...p.trail, trailPoint(p)] }));
  }

  /** Survivors first, then whoever lasted longest. */
  private standings(): Standing[] {
    return [...this.players]
      .sort((a, b) => (b.out ?? Infinity) - (a.out ?? Infinity))
      .map((p) => ({
        id: p.id,
        roundsSurvived: p.out ?? this.round,
        kills: p.kills,
        longest: Math.round(p.longest),
        killedBy: p.killedBy,
      }));
  }

  /** Only the players who were standing when the lights came on. */
  private snapshot(source: readonly MatchPlayer[]): SnapshotPlayer[] {
    return source.map((p) => ({ id: p.id, x: p.x, y: p.y, aim: p.aim, alive: p.alive }));
  }
}

/** Whole units and centiradians are plenty for a replay, and keep it small. */
function trailPoint(p: { x: number; y: number; aim: number }): [number, number, number] {
  return [Math.round(p.x), Math.round(p.y), Math.round(p.aim * 100) / 100];
}
