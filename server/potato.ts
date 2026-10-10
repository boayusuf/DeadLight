import { MOVE_SPEED } from '../shared/constants.js';
import type { MapId } from '../shared/maps.js';
import {
  FUSE_MS,
  PASS_COOLDOWN_MS,
  PASS_RADIUS,
  bombCount,
  clampToPotato,
  potatoSpawns,
  stepPotato,
  type Boom,
  type Pass,
} from '../shared/potato.js';
import type { LobbyPlayer, MiniExtra } from '../shared/protocol.js';
import type { Broadcast } from './match.js';
import { MiniMatch, recent, type MiniMatchPlayer } from './mini.js';

/** A lunge: a short burst to close the last stride and shove the bomb over. */
const LUNGE_MS = 200;
const LUNGE_SPEED = MOVE_SPEED * 2;
const LUNGE_COOLDOWN_MS = 900;

/** The beat between a bang and the next fuse being lit. */
const RELIGHT_MS = 1200;

interface Bomb {
  holder: string;
  /** How long this fuse has burned, in milliseconds. */
  heat: number;
}

/**
 * Hot potato.
 *
 * One or two live bombs, a fuse apiece, and a floor with pillars to lose
 * people behind. Touching someone hands it over — unless their hands are
 * still hot from the last pass. Whoever holds it at the bang is out.
 */
export class PotatoMatch extends MiniMatch {
  readonly kind = 'potato' as const;

  private bombs: Bomb[] = [];
  private passes: Pass[] = [];
  private booms: Boom[] = [];
  /** Hands that cannot take a bomb yet, by id, as a server clock. */
  private cold = new Map<string, number>();
  private lunge = new Map<string, { until: number; ready: number }>();
  private relightAt: number | null = null;

  constructor(roster: readonly LobbyPlayer[], send: Broadcast, now: number, map: MapId) {
    super(roster, send, now, map, potatoSpawns(roster.length));
    this.round = 1;
    this.light();
    this.announce();
  }

  protected advance(now: number, dt: number): void {
    this.move(now, dt);
    this.burn(now, dt);
    this.handOver(now);
    if (this.relightAt !== null && now >= this.relightAt) {
      this.relightAt = null;
      this.round++;
      this.light();
    }
    this.passes = recent(this.passes, now);
    this.booms = recent(this.booms, now);
  }

  /** Hands a fuse to as many fighters as the floor warrants. */
  private light(): void {
    const standing = this.standing();
    if (standing.length <= 1) return;
    const count = Math.min(bombCount(standing.length), standing.length - 1);
    const order = [...standing].sort(() => Math.random() - 0.5);
    this.bombs = order.slice(0, count).map((p) => ({ holder: p.id, heat: 0 }));
    // Nobody is already on cooldown at the moment a fuse is lit.
    this.cold.clear();
  }

  private move(now: number, dt: number): void {
    for (const p of this.standing()) {
      if (p.action) {
        p.action = false;
        const state = this.lunge.get(p.id);
        if (!state || (now >= state.ready && now >= state.until)) {
          this.lunge.set(p.id, { until: now + LUNGE_MS, ready: now + LUNGE_COOLDOWN_MS });
        }
      }
      const holding = this.bombs.some((b) => b.holder === p.id);
      const lunging = (this.lunge.get(p.id)?.until ?? 0) > now;
      const next = lunging
        ? clampToPotato({
            x: p.x + p.mx * LUNGE_SPEED * dt,
            y: p.y + p.my * LUNGE_SPEED * dt,
          })
        : stepPotato(p, p.mx, p.my, dt, holding);
      p.x = next.x;
      p.y = next.y;
    }
    for (const [id, until] of this.cold) if (now >= until) this.cold.delete(id);
  }

  /** Fuses burn down, and a fuse that reaches the end takes its holder. */
  private burn(now: number, dt: number): void {
    const spent: Bomb[] = [];
    for (const bomb of this.bombs) {
      bomb.heat += dt * 1000;
      if (bomb.heat >= FUSE_MS) spent.push(bomb);
    }
    if (spent.length === 0) return;

    for (const bomb of spent) {
      const holder = this.players.find((p) => p.id === bomb.holder);
      this.booms.push({ id: bomb.holder, at: now });
      if (holder) this.eliminate(holder);
    }
    this.bombs = this.bombs.filter((b) => !spent.includes(b));
    // Everyone who survived the bang gets credit for it.
    for (const p of this.standing()) p.score++;
    if (this.standing().length > 1) this.relightAt = now + RELIGHT_MS;
  }

  /** Touch someone with cool hands and the bomb is theirs. */
  private handOver(now: number): void {
    for (const bomb of this.bombs) {
      const holder = this.players.find((p) => p.id === bomb.holder);
      if (!holder?.alive) continue;
      const taker = this.nearest(holder, now);
      if (!taker) continue;
      this.passes.push({ from: holder.id, to: taker.id, at: now });
      bomb.holder = taker.id;
      // Both pairs of hands go cold, so a bomb cannot be volleyed on the spot.
      this.cold.set(holder.id, now + PASS_COOLDOWN_MS);
      this.cold.set(taker.id, now + PASS_COOLDOWN_MS);
      holder.score++;
    }
  }

  /** The closest fighter within reach who could take this bomb. */
  private nearest(holder: MiniMatchPlayer, now: number): MiniMatchPlayer | null {
    let best: MiniMatchPlayer | null = null;
    let bestDistance = PASS_RADIUS;
    for (const p of this.standing()) {
      if (p.id === holder.id) continue;
      if ((this.cold.get(p.id) ?? 0) > now) continue;
      if (this.bombs.some((b) => b.holder === p.id)) continue;
      const d = Math.hypot(p.x - holder.x, p.y - holder.y);
      if (d <= bestDistance) {
        best = p;
        bestDistance = d;
      }
    }
    return best;
  }

  protected override left(): number {
    const hottest = this.bombs.reduce((worst, b) => Math.max(worst, b.heat), 0);
    return Math.max(0, FUSE_MS - hottest);
  }

  protected extra(): MiniExtra {
    const now = this.now;
    return {
      kind: 'potato',
      holders: this.bombs.map((b) => b.holder),
      heat: this.bombs.map((b) => Math.round(b.heat)),
      passes: this.passes,
      booms: this.booms,
      cooldowns: Object.fromEntries(
        [...this.cold].map(([id, until]) => [id, Math.max(0, Math.round(until - now))]),
      ),
      dashing: [...this.lunge].filter(([, l]) => l.until > now).map(([id]) => id),
    };
  }
}
