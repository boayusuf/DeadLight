import type { MapId } from '../shared/maps.js';
import type { LobbyPlayer, MiniExtra } from '../shared/protocol.js';
import {
  ROOM_COUNT,
  roomOf,
  roomsSpawns,
  stepRooms,
  type RoomState,
  type RoomsPhase,
} from '../shared/rooms.js';
import type { Broadcast } from './match.js';
import { MiniMatch, type MiniMatchPlayer } from './mini.js';

/** How long the music plays, the number hangs in the air, and the doors stay open. */
const MUSIC_MS = 6000;
const ANNOUNCE_MS = 1400;
const COUNT_MS = 5000;
const REVEAL_MS = 2600;

/**
 * Rooms.
 *
 * The music plays and the middle of the floor turns under everyone's feet.
 * Then a number is called, the clock runs, and the doors lock: a room saves
 * the fighters inside it only if exactly that many of them got in. Everyone
 * else — wrong room, crowded room, still on the floor — is out.
 */
export class RoomsMatch extends MiniMatch {
  readonly kind = 'rooms' as const;

  private phase: RoomsPhase = 'music';
  private phaseEndsAt: number;
  private target: number | null = null;
  private rooms: RoomState[] = fresh();

  constructor(roster: readonly LobbyPlayer[], send: Broadcast, now: number, map: MapId) {
    super(roster, send, now, map, roomsSpawns(roster.length));
    this.round = 1;
    this.phaseEndsAt = now + MUSIC_MS;
    this.announce();
  }

  protected advance(now: number, dt: number): void {
    for (const p of this.standing()) {
      const next = stepRooms(p, p.mx, p.my, dt, { phase: this.phase, rooms: this.rooms });
      p.x = next.x;
      p.y = next.y;
      p.action = false;
    }
    if (now >= this.phaseEndsAt) this.turn(now);
  }

  /** music → announce → count → reveal → music. */
  private turn(now: number): void {
    switch (this.phase) {
      case 'music':
        this.phase = 'announce';
        this.phaseEndsAt = now + ANNOUNCE_MS;
        this.target = this.call();
        return;
      case 'announce':
        this.phase = 'count';
        this.phaseEndsAt = now + COUNT_MS;
        return;
      case 'count':
        this.phase = 'reveal';
        this.phaseEndsAt = now + REVEAL_MS;
        this.judge();
        return;
      case 'reveal':
        this.phase = 'music';
        this.phaseEndsAt = now + MUSIC_MS;
        this.target = null;
        this.rooms = fresh();
        this.round++;
        return;
    }
  }

  /**
   * The number called. Never so big that every survivor fits in one room, and
   * never so big that it cannot be made: with four left, "four" would simply
   * be everyone walking into the same door.
   */
  private call(): number {
    const standing = this.standing().length;
    const most = Math.max(1, Math.min(standing - 1, ROOM_COUNT));
    return 1 + Math.floor(Math.random() * most);
  }

  /** Lock the doors, count heads, and take everyone the rooms did not save. */
  private judge(): void {
    const target = this.target ?? 1;
    const inside = new Map<number, MiniMatchPlayer[]>();
    for (const p of this.standing()) {
      const room = roomOf(p);
      if (room === null) continue;
      const list = inside.get(room) ?? [];
      list.push(p);
      inside.set(room, list);
    }

    const exact = [...inside.values()].filter((list) => list.length === target);
    const saved = new Set<string>(
      // A number nobody managed to make saves everyone who at least got through
      // a door; the dance floor never saves anybody.
      (exact.length > 0 ? exact : [...inside.values()]).flat().map((p) => p.id),
    );

    for (let i = 0; i < ROOM_COUNT; i++) {
      const list = inside.get(i) ?? [];
      const outcome = list.length === 0 ? null : list.length === target ? 'ok' : 'wrong';
      this.rooms[i] = { open: false, locked: true, outcome };
    }

    for (const p of this.standing()) {
      if (saved.has(p.id)) p.score++;
      else this.eliminate(p);
    }
  }

  protected override left(): number {
    return Math.max(0, this.phaseEndsAt - this.now);
  }

  protected extra(): MiniExtra {
    return {
      kind: 'rooms',
      phase: this.phase,
      phaseLeft: Math.round(this.left()),
      target: this.target,
      rooms: this.rooms.map((r) => ({ ...r })),
    };
  }
}

/** Doors open, nothing judged. */
const fresh = (): RoomState[] =>
  Array.from({ length: ROOM_COUNT }, () => ({ open: true, locked: false, outcome: null }));
