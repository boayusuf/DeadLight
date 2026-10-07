import { ROOM_GRACE_MS, type FinisherId } from '../shared/constants.js';
import { Room, type Conn } from './room.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

export class Lobby {
  private readonly rooms = new Map<string, Room>();
  private readonly publicRooms: Room[] = [];
  private readonly byClient = new Map<string, Room>();

  roomFor(id: string): Room | undefined {
    return this.byClient.get(id);
  }

  joinPublic(id: string, name: string, conn: Conn, finisher?: FinisherId): Room {
    const room = this.publicRooms.find((r) => r.open) ?? this.createPublic();
    this.place(room, id, name, conn, finisher);
    return room;
  }

  createParty(id: string, name: string, conn: Conn, finisher?: FinisherId): Room {
    const room = new Room(this.freshCode());
    this.rooms.set(room.code!, room);
    this.place(room, id, name, conn, finisher);
    return room;
  }

  joinParty(
    id: string,
    name: string,
    code: string,
    conn: Conn,
    finisher?: FinisherId,
  ): Room | { error: string } {
    const room = this.rooms.get(code.trim().toUpperCase());
    if (!room) return { error: 'No party with that code.' };
    if (!room.open) return { error: 'That party is full.' };
    this.place(room, id, name, conn, finisher);
    return room;
  }

  leave(id: string, now: number): void {
    const room = this.byClient.get(id);
    if (!room) return;
    this.byClient.delete(id);
    room.leave(id, now);
  }

  tick(now: number, dt: number): void {
    for (const room of this.allRooms()) {
      room.tick(now, dt);
      if (room.emptySince !== null && now - room.emptySince > ROOM_GRACE_MS) this.drop(room);
    }
  }

  pushState(): void {
    for (const room of this.allRooms()) room.pushState();
  }

  private allRooms(): Room[] {
    return [...this.publicRooms, ...this.rooms.values()];
  }

  private place(room: Room, id: string, name: string, conn: Conn, finisher?: FinisherId): void {
    this.byClient.set(id, room);
    room.join(id, name, conn, finisher);
  }

  private createPublic(): Room {
    const room = new Room(null);
    this.publicRooms.push(room);
    return room;
  }

  private drop(room: Room): void {
    if (room.code) this.rooms.delete(room.code);
    const i = this.publicRooms.indexOf(room);
    if (i !== -1) this.publicRooms.splice(i, 1);
  }

  private freshCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }
}
