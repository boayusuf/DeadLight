import {
  FREEZE_FINISH_Y,
  FREEZE_TWITCH,
  ZAP_MS,
  freezeSpawns,
  isHome,
  stepFreeze,
  type EyeLight,
  type Zap,
} from '../shared/freeze.js';
import type { LobbyPlayer, MiniExtra } from '../shared/protocol.js';
import type { MapId } from '../shared/maps.js';
import type { Broadcast } from './match.js';
import { MiniMatch, recent, type MiniMatchPlayer } from './mini.js';

/** How long the eye looks away, how long it is turning, and how long it stares. */
const GREEN_MS = [1500, 3200] as const;
const TURNING_MS = 520;
const RED_MS = [1200, 2200] as const;

/** A race is called off if the pack dawdles; the field is thinned either way. */
const RACE_LIMIT_MS = 60_000;

const span = ([lo, hi]: readonly [number, number]): number => lo + Math.random() * (hi - lo);

/**
 * Freeze.
 *
 * A corridor, a line at the far end, and an eye that turns to watch. While it
 * looks away anyone can run; while it looks, the smallest movement is fatal.
 * Each race takes whoever is still short of the line when the rest are home.
 */
export class FreezeMatch extends MiniMatch {
  readonly kind = 'freeze' as const;

  private light: EyeLight = 'green';
  private lightEndsAt: number;
  private zaps: Zap[] = [];
  private raceEndsAt: number;
  /** Who has crossed this race, in the order they did it. */
  private home = new Set<string>();

  constructor(roster: readonly LobbyPlayer[], send: Broadcast, now: number, map: MapId) {
    super(roster, send, now, map, freezeSpawns(roster.length));
    this.round = 1;
    this.lightEndsAt = now + span(GREEN_MS);
    this.raceEndsAt = now + RACE_LIMIT_MS;
    this.announce();
  }

  protected advance(now: number, dt: number): void {
    this.turnEye(now);

    for (const p of this.standing()) {
      if (this.home.has(p.id)) continue;
      const from = { x: p.x, y: p.y };
      const to = stepFreeze(from, p.mx, p.my, dt);
      const moved = Math.hypot(to.x - from.x, to.y - from.y);
      p.x = to.x;
      p.y = to.y;
      p.action = false;

      // The eye does not care how slowly you creep, only that you moved at all.
      if (this.light === 'red' && moved > FREEZE_TWITCH) {
        this.zaps.push({ id: p.id, at: now });
        this.eliminate(p);
        continue;
      }
      if (isHome(p)) {
        this.home.add(p.id);
        p.score++;
      }
    }

    this.zaps = recent(this.zaps, now);
    this.judgeRace(now);
  }

  /** Green, a moment of turning as the only warning, then the stare. */
  private turnEye(now: number): void {
    if (now < this.lightEndsAt) return;
    if (this.light === 'green') {
      this.light = 'turning';
      this.lightEndsAt = now + TURNING_MS;
      return;
    }
    if (this.light === 'turning') {
      this.light = 'red';
      this.lightEndsAt = now + span(RED_MS);
      return;
    }
    this.light = 'green';
    this.lightEndsAt = now + span(GREEN_MS);
  }

  /**
   * A race ends when everyone still in it is home, or when the clock runs out.
   * The last fighter short of the line is out, and the rest line up again.
   */
  private judgeRace(now: number): void {
    const racing = this.standing().filter((p) => !this.home.has(p.id));
    if (racing.length > 0 && now < this.raceEndsAt) return;

    if (racing.length > 0) {
      // Out of time: the one with the furthest still to run is out.
      const last = racing.reduce((worst, p) => (p.y < worst.y ? p : worst), racing[0]!);
      this.eliminate(last);
    } else {
      // Everyone made it: the last one across is still the one that goes.
      const order = [...this.home];
      const trailing = this.players.find((p) => p.alive && p.id === order[order.length - 1]);
      if (trailing && this.standing().length > 1) this.eliminate(trailing);
    }

    if (this.standing().length <= 1) return;
    this.lineUp(now);
  }

  private lineUp(now: number): void {
    this.round++;
    this.home.clear();
    this.light = 'green';
    this.lightEndsAt = now + span(GREEN_MS);
    this.raceEndsAt = now + RACE_LIMIT_MS;
    const spawns = freezeSpawns(this.standing().length);
    this.standing().forEach((p: MiniMatchPlayer, i: number) => {
      p.x = spawns[i]!.x;
      p.y = spawns[i]!.y;
      p.aim = spawns[i]!.aim;
      p.mx = 0;
      p.my = 0;
    });
  }

  protected override left(): number {
    return Math.max(0, this.lightEndsAt - this.now);
  }

  protected extra(): MiniExtra {
    return {
      kind: 'freeze',
      light: this.light,
      phaseLeft: Math.round(this.left()),
      zaps: this.zaps.filter((z) => this.now - z.at <= ZAP_MS * 4),
    };
  }

  /** Home is past the line; the client draws it so fighters stop there. */
  static readonly FINISH_Y = FREEZE_FINISH_Y;
}
