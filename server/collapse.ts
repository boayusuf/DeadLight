import { MOVE_SPEED } from '../shared/constants.js';
import {
  CRACK_MS,
  FALL_MS,
  OUTER_RING,
  TILE_BREAKING,
  TILE_CRACKING,
  TILE_GONE,
  TILE_SOLID,
  collapseSpawns,
  ring,
  solidFloor,
  standingOnNothing,
  stateMs,
  stepCollapse,
  tileCount,
  type Fall,
} from '../shared/collapse.js';
import type { MapId } from '../shared/maps.js';
import type { LobbyPlayer, MiniExtra } from '../shared/protocol.js';
import type { Broadcast } from './match.js';
import { MiniMatch, recent } from './mini.js';

/** How often a fresh tile starts to go, and how that quickens. */
const FIRST_BITE_MS = 1400;
const BITE_FLOOR_MS = 260;
const BITE_STEP = 0.93;

/** How long the outer ring lasts before the floor starts eating the next one. */
const RING_MS = 7000;

/** A dash: a short burst of speed, and then a wait. */
const DASH_MS = 220;
const DASH_SPEED = MOVE_SPEED * 2.1;
const DASH_COOLDOWN_MS = 1100;

/**
 * Collapse.
 *
 * The floor is eleven by eleven tiles and it goes from the outside in. A tile
 * cracks, then breaks, then is not there, and whoever is standing on it drops
 * through. The middle lasts longest, which is exactly where everyone ends up.
 */
export class CollapseMatch extends MiniMatch {
  readonly kind = 'collapse' as const;

  private tiles: string[] = new Array(tileCount).fill(TILE_SOLID);
  /** When each tile moves to its next state. */
  private due: number[] = new Array(tileCount).fill(0);
  /** The innermost ring the floor has started on. */
  private edge = OUTER_RING;
  private edgeAt: number;
  private biteEvery = FIRST_BITE_MS;
  private nextBiteAt: number;
  private falls: Fall[] = [];
  private broke: number[] = [];
  private dash = new Map<string, { until: number; ready: number }>();

  constructor(roster: readonly LobbyPlayer[], send: Broadcast, now: number, map: MapId) {
    super(roster, send, now, map, collapseSpawns(roster.length));
    this.round = 1;
    this.edgeAt = now + RING_MS;
    this.nextBiteAt = now + FIRST_BITE_MS;
    this.announce();
  }

  protected advance(now: number, dt: number): void {
    this.bite(now);
    this.age(now);
    this.move(now, dt);
    this.drop(now);
    this.falls = recent(this.falls, now);
  }

  /** Start another tile cracking, a little sooner each time. */
  private bite(now: number): void {
    if (now >= this.edgeAt && this.edge > 0) {
      this.edge--;
      this.edgeAt = now + RING_MS;
    }
    if (now < this.nextBiteAt) return;
    this.biteEvery = Math.max(BITE_FLOOR_MS, this.biteEvery * BITE_STEP);
    this.nextBiteAt = now + this.biteEvery;

    const ready: number[] = [];
    for (let i = 0; i < tileCount; i++) {
      if (this.tiles[i] !== TILE_SOLID) continue;
      // Only the rings the floor has reached, outermost first.
      if (ring(i) < this.edge) continue;
      ready.push(i);
    }
    if (ready.length === 0) return;
    const outer = Math.max(...ready.map(ring));
    const pick = ready.filter((i) => ring(i) === outer);
    const tile = pick[Math.floor(Math.random() * pick.length)]!;
    this.tiles[tile] = TILE_CRACKING;
    this.due[tile] = now + stateMs(TILE_CRACKING) + Math.random() * CRACK_MS * 0.5;
  }

  /** Walk every warning tile along to its next state. */
  private age(now: number): void {
    this.broke = [];
    for (let i = 0; i < tileCount; i++) {
      const state = this.tiles[i]!;
      if (state === TILE_SOLID || state === TILE_GONE) continue;
      if (now < this.due[i]!) continue;
      if (state === TILE_CRACKING) {
        this.tiles[i] = TILE_BREAKING;
        this.due[i] = now + stateMs(TILE_BREAKING);
      } else {
        this.tiles[i] = TILE_GONE;
        this.broke.push(i);
      }
    }
  }

  private move(now: number, dt: number): void {
    for (const p of this.standing()) {
      const dash = this.dash.get(p.id);
      if (p.action) {
        p.action = false;
        if (!dash || (now >= dash.ready && now >= dash.until)) {
          this.dash.set(p.id, { until: now + DASH_MS, ready: now + DASH_COOLDOWN_MS });
        }
      }
      const dashing = (this.dash.get(p.id)?.until ?? 0) > now;
      const next = stepCollapse(p, p.mx, p.my, dt, dashing ? DASH_SPEED : MOVE_SPEED);
      p.x = next.x;
      p.y = next.y;
    }
  }

  /** Anyone over a hole goes through it. */
  private drop(now: number): void {
    for (const p of this.standing()) {
      if (!standingOnNothing(p, this.tiles.join(''))) continue;
      this.falls.push({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), at: now });
      this.eliminate(p);
    }
  }

  protected override left(): number {
    return Math.max(0, this.edgeAt - this.now);
  }

  protected extra(): MiniExtra {
    const now = this.now;
    return {
      kind: 'collapse',
      tiles: this.tiles.join(''),
      edge: this.edge,
      falls: this.falls.filter((f) => now - f.at <= FALL_MS * 2),
      broke: this.broke,
      dashing: [...this.dash]
        .filter(([, d]) => d.until > now)
        .map(([id]) => id),
    };
  }
}
