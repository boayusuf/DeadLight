import {
  LOBBY_COUNTDOWN_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
} from '../shared/constants.js';
import type { LobbyPlayer, ServerMessage } from '../shared/protocol.js';
import { Match } from './match.js';

export interface Conn {
  send(payload: string): void;
}

interface Member extends LobbyPlayer {
  conn: Conn;
  ready: boolean;
}

export class Room {
  readonly members: Member[] = [];
  match: Match | null = null;
  emptySince: number | null = null;

  private hostId: string | null = null;
  private countdownEndsAt: number | null = null;
  private roster: ServerMessage | null = null;

  constructor(readonly code: string | null) {}

  get isPublic(): boolean {
    return this.code === null;
  }

  get open(): boolean {
    return this.match === null && this.members.length < MAX_PLAYERS;
  }

  join(id: string, name: string, conn: Conn): void {
    const used = new Set(this.members.map((m) => m.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];

    this.members.push({ id, name, color, conn, ready: false });
    this.hostId ??= id;
    this.emptySince = null;

    if (this.match && this.roster) this.send(this.roster, id);
    this.sendLobby();
  }

  leave(id: string, now: number): void {
    const i = this.members.findIndex((m) => m.id === id);
    if (i === -1) return;

    this.members.splice(i, 1);
    this.match?.disconnect(id);
    if (this.hostId === id) this.hostId = this.members[0]?.id ?? null;
    if (this.members.length === 0) {
      this.emptySince = now;
      this.match = null;
      return;
    }
    this.sendLobby();
  }

  /** Host-initiated start, private rooms only. */
  requestStart(id: string, now: number): void {
    if (this.isPublic || this.match || id !== this.hostId) return;
    if (this.members.length < MIN_PLAYERS) return;
    this.startMatch(now);
  }

  get hasHost(): boolean {
    return this.hostId !== null;
  }

  /** One colour per fighter; a taken colour is simply ignored. */
  setColor(id: string, color: string): void {
    const member = this.members.find((m) => m.id === id);
    if (!member || this.match) return;
    if (!(PLAYER_COLORS as readonly string[]).includes(color)) return;
    if (this.members.some((m) => m.id !== id && m.color === color)) return;
    member.color = color;
    this.sendLobby();
  }

  setReady(id: string, value: boolean): void {
    const member = this.members.find((m) => m.id === id);
    if (!member || this.match) return;
    member.ready = value;
    this.sendLobby();
  }

  input(id: string, seq: number, mx: number, my: number, aim: number): void {
    this.match?.input(id, seq, mx, my, aim);
  }

  tick(now: number, dt: number): void {
    if (this.match) {
      this.match.tick(now, dt);
      this.match.settle(now);
      if (this.match.finished) {
        this.match = null;
        this.roster = null;
        for (const m of this.members) m.ready = false;
        this.countdownEndsAt = null;
        this.sendLobby();
      }
      return;
    }

    if (!this.isPublic) return;

    // Everyone present has to say they are ready; the countdown is then short
    // and visible rather than an unexplained wait.
    const waiting = this.members.every((m) => m.ready) ? this.members : [];
    if (waiting.length < MIN_PLAYERS) {
      if (this.countdownEndsAt !== null) {
        this.countdownEndsAt = null;
        this.sendLobby();
      }
      return;
    }

    if (this.countdownEndsAt === null) {
      this.countdownEndsAt = now + LOBBY_COUNTDOWN_MS;
      this.sendLobby();
    }

    if (now >= this.countdownEndsAt) this.startMatch(now);
  }

  pushState(): void {
    if (!this.match) return;
    const spectators = this.members.filter((m) => !this.match!.alive(m.id)).map((m) => m.id);
    this.match.pushState(spectators);
  }

  private startMatch(now: number): void {
    const lineup = this.members
      .slice(0, MAX_PLAYERS)
      .map((m) => ({ id: m.id, name: m.name, color: m.color, ready: m.ready }));
    if (lineup.length < MIN_PLAYERS) return;

    this.countdownEndsAt = null;
    this.match = new Match(lineup, (msg, to) => {
      if (msg.t === 'match') this.roster = msg;
      this.send(msg, to);
    }, now);
  }

  private sendLobby(): void {
    const players = this.members.map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      ready: m.ready,
    }));
    const countdownMs =
      this.countdownEndsAt === null ? null : Math.max(0, this.countdownEndsAt - Date.now());

    for (const m of this.members) {
      this.send(
        {
          t: 'lobby',
          selfId: m.id,
          code: this.code,
          host: m.id === this.hostId,
          players,
          countdownMs,
        },
        m.id,
      );
    }
  }

  private send(message: ServerMessage, to?: string): void {
    const payload = JSON.stringify(message);
    for (const m of this.members) {
      if (to === undefined || m.id === to) m.conn.send(payload);
    }
  }
}
