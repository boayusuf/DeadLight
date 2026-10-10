import { PLAYER_RADIUS } from '../shared/constants.js';
import { TILE_GONE, standingOnNothing, tileAt } from '../shared/collapse.js';
import type { MiniGameId } from '../shared/games.js';
import { FREEZE_FINISH_Y } from '../shared/freeze.js';
import { PASS_RADIUS } from '../shared/potato.js';
import type { MiniExtra, MiniPlayer, ServerMessage } from '../shared/protocol.js';
import { DANCE_RADIUS, ROOM_ANGLES, ROOM_COUNT, ROOM_SPAN, roomOf } from '../shared/rooms.js';
import { FLOE_RADIUS, offIce, segmentAt } from '../shared/sumo.js';
import type { BotInput } from './bots.js';

/** What the bot presses: a player's three numbers plus the one button. */
export type MiniBotInput = BotInput & { action: boolean };

const face = (dx: number, dy: number): number => Math.atan2(dy, dx);

/**
 * A bot's mind for the lit games.
 *
 * It reads the same state message a player's client does and answers with the
 * same inputs. Each game is a short rule — run while the eye is away, stand on
 * floor that is still there, get into a room with the right number in it,
 * shove whoever is nearest the edge, give the bomb to somebody else — which is
 * about what a person does on their first go, and loses to one who has worked
 * the game out.
 */
export class MiniBrain {
  private me: MiniPlayer | null = null;
  private others: MiniPlayer[] = [];
  private extra: MiniExtra | null = null;
  /** The room this bot has settled on, and the round it settled for. */
  private pick: number | null = null;
  private pickedFor: number | null = null;

  constructor(
    readonly id: string,
    readonly kind: MiniGameId,
    private readonly rng: () => number = Math.random,
  ) {}

  hear(msg: ServerMessage): void {
    if (msg.t !== 'mini') return;
    this.extra = msg.extra;
    this.me = msg.players.find((p) => p.id === this.id) ?? null;
    this.others = msg.players.filter((p) => p.id !== this.id && p.state === 'alive');
    if (msg.round !== this.pickedFor) {
      this.pick = null;
      this.pickedFor = msg.round;
    }
  }

  think(): MiniBotInput | null {
    const me = this.me;
    const extra = this.extra;
    if (!me || me.state === 'out' || !extra) return null;
    switch (extra.kind) {
      case 'freeze':
        return this.freeze(me, extra);
      case 'collapse':
        return this.collapse(me, extra);
      case 'rooms':
        return this.rooms(me, extra);
      case 'sumo':
        return this.sumo(me, extra);
      case 'potato':
        return this.potato(me, extra);
    }
  }

  /** Run on green, stand still otherwise. The turning light is the cue to stop. */
  private freeze(me: MiniPlayer, extra: Extract<MiniExtra, { kind: 'freeze' }>): MiniBotInput {
    const aim = Math.PI / 2;
    if (me.y >= FREEZE_FINISH_Y || extra.light !== 'green') return this.go(0, 0, aim);
    // A little sideways drift, so the pack does not run as one column.
    return this.go(Math.sin((me.x + me.y) / 220) * 0.25, 1, aim);
  }

  /** Head for the middle, which goes last, and never stand over a hole. */
  private collapse(me: MiniPlayer, extra: Extract<MiniExtra, { kind: 'collapse' }>): MiniBotInput {
    const here = tileAt(me);
    const falling = here === null || extra.tiles[here] === TILE_GONE || standingOnNothing(me, extra.tiles);
    const d = Math.hypot(me.x, me.y) || 1;
    const mx = (-me.x / d) * (falling ? 1 : 0.8);
    const my = (-me.y / d) * (falling ? 1 : 0.8);
    return this.go(mx, my, face(mx, my), falling);
  }

  /** While the music plays, keep off the spinning middle; once a number is called, commit. */
  private rooms(me: MiniPlayer, extra: Extract<MiniExtra, { kind: 'rooms' }>): MiniBotInput {
    if (extra.phase === 'music' || extra.target === null) {
      const middle = Math.hypot(me.x, me.y) < DANCE_RADIUS + PLAYER_RADIUS;
      const dir = middle ? { x: me.x || 1, y: me.y } : { x: -me.y, y: me.x };
      const d = Math.hypot(dir.x, dir.y) || 1;
      return this.go(dir.x / d, dir.y / d, face(dir.x, dir.y));
    }

    this.pick ??= this.choose(me, extra);
    const room = ROOM_ANGLES[this.pick]!;
    const reach = ROOM_SPAN.at + ROOM_SPAN.depth * 0.6;
    const dx = room.cos * reach - me.x;
    const dy = room.sin * reach - me.y;
    const d = Math.hypot(dx, dy) || 1;
    if (roomOf(me) === this.pick && d < ROOM_SPAN.depth) return this.go(0, 0, face(dx, dy));
    return this.go(dx / d, dy / d, face(dx, dy));
  }

  /** The nearest room that is not already over the called number. */
  private choose(me: MiniPlayer, extra: Extract<MiniExtra, { kind: 'rooms' }>): number {
    const target = extra.target ?? 1;
    const heads = new Array<number>(ROOM_COUNT).fill(0);
    for (const p of this.others) {
      const room = roomOf(p);
      if (room !== null) heads[room]!++;
    }
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i < ROOM_COUNT; i++) {
      if (extra.rooms[i]?.locked) continue;
      const a = ROOM_ANGLES[i]!;
      const walk = Math.hypot(a.cos * ROOM_SPAN.at - me.x, a.sin * ROOM_SPAN.at - me.y);
      // A room already at the number is no use; one short of it is the prize.
      const heading = heads[i]!;
      const crowd = heading >= target ? 2000 : -heading * 120;
      const cost = walk + crowd + this.rng() * 80;
      if (cost < bestCost) {
        best = i;
        bestCost = cost;
      }
    }
    return best;
  }

  /** Shove the nearest fighter, and treat the edge of the ice as the real enemy. */
  private sumo(me: MiniPlayer, extra: Extract<MiniExtra, { kind: 'sumo' }>): MiniBotInput {
    const reach = extra.floe[segmentAt(me.x, me.y)] ?? FLOE_RADIUS;
    const out = Math.hypot(me.x, me.y);
    if (out > reach - PLAYER_RADIUS * 2.5 || offIce(me, extra.floe)) {
      const d = out || 1;
      return this.go(-me.x / d, -me.y / d, face(-me.x, -me.y));
    }
    const prey = this.closest(me);
    if (!prey) return this.go(0, 0, me.aim);
    const dx = prey.x - me.x;
    const dy = prey.y - me.y;
    const d = Math.hypot(dx, dy) || 1;
    // Worth a dash only when it pushes them towards the water, not across the ice.
    const dash = d < PLAYER_RADIUS * 5 && Math.hypot(prey.x, prey.y) > out && (extra.cooldowns[this.id] ?? 0) <= 0;
    return this.go(dx / d, dy / d, face(dx, dy), dash);
  }

  /** Holding it: chase. Not holding it: keep away from whoever is. */
  private potato(me: MiniPlayer, extra: Extract<MiniExtra, { kind: 'potato' }>): MiniBotInput {
    if (extra.holders.includes(this.id)) {
      const prey = this.closest(
        me,
        (p) => !extra.holders.includes(p.id) && (extra.cooldowns[p.id] ?? 0) <= 0,
      );
      if (!prey) return this.go(0, 0, me.aim);
      const dx = prey.x - me.x;
      const dy = prey.y - me.y;
      const d = Math.hypot(dx, dy) || 1;
      return this.go(dx / d, dy / d, face(dx, dy), d < PASS_RADIUS * 2);
    }

    const threat = this.closest(me, (p) => extra.holders.includes(p.id));
    if (!threat) return this.go(0, 0, me.aim);
    const dx = me.x - threat.x;
    const dy = me.y - threat.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d > PASS_RADIUS * 6) return this.go(0, 0, face(-dx, -dy));
    return this.go(dx / d, dy / d, face(dx, dy));
  }

  private closest(me: MiniPlayer, keep?: (p: MiniPlayer) => boolean): MiniPlayer | null {
    let best: MiniPlayer | null = null;
    let bestDistance = Infinity;
    for (const p of this.others) {
      if (keep && !keep(p)) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < bestDistance) {
        best = p;
        bestDistance = d;
      }
    }
    return best;
  }

  private go(mx: number, my: number, aim: number, action = false): MiniBotInput {
    return { mx, my, aim, action };
  }
}
