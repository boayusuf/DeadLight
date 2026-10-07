import {
  DEFAULT_FINISHER,
  FINISHERS,
  LOBBY_COUNTDOWN_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  isFinisher,
  type FinisherId,
} from '../shared/constants.js';
import { MAP_IDS, isMapChoice, type MapChoice, type MapId } from '../shared/maps.js';
import type { BotDifficulty, LobbyPlayer, ServerMessage } from '../shared/protocol.js';
import { BOT_NAMES, BotBrain } from './bots.js';
import { Match } from './match.js';

const DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];
/** A lone player in matchmaking waits this long before bots start filling seats. */
export const BOT_FILL_AFTER_MS = 10_000;
const BOT_FILL_EVERY_MS = 1_500;
/** Matchmaking fills up to this many fighters with bots. */
export const BOT_FILL_TO = 4;

export interface Conn {
  send(payload: string): void;
}

interface Member extends LobbyPlayer {
  conn: Conn;
  ready: boolean;
  brain: BotBrain | null;
  seq: number;
}

export class Room {
  readonly members: Member[] = [];
  match: Match | null = null;
  emptySince: number | null = null;

  /** The arena for the next match; matchmaking always rolls one. */
  map: MapChoice = 'random';

  private hostId: string | null = null;
  private countdownEndsAt: number | null = null;
  private roster: ServerMessage | null = null;
  private botCount = 0;
  /** When a human started waiting in matchmaking, and when the last bot sat down. */
  private waitingSince: number | null = null;
  private lastFill = 0;

  constructor(readonly code: string | null) {}

  get isPublic(): boolean {
    return this.code === null;
  }

  /** A bot gives up its seat to a person, so a room full of bots is still open. */
  get open(): boolean {
    return this.match === null && (this.members.length < MAX_PLAYERS || this.members.some((m) => m.bot));
  }

  get humans(): Member[] {
    return this.members.filter((m) => !m.bot);
  }

  join(id: string, name: string, conn: Conn, finisher: FinisherId = DEFAULT_FINISHER): void {
    if (this.members.length >= MAX_PLAYERS) this.dropBot();
    this.seat({ id, name, conn, finisher, bot: false, brain: null });
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
    // Bots never host and never keep a room alive on their own.
    if (this.hostId === id) this.hostId = this.humans[0]?.id ?? null;
    if (this.humans.length === 0) {
      this.members.length = 0;
      this.emptySince = now;
      this.match = null;
      return;
    }
    this.sendLobby();
  }

  /** Host only, outside a match. Seats a bot with a free colour and a random finisher. */
  addBot(requester: string, difficulty: unknown): void {
    if (requester !== this.hostId || this.match || this.members.length >= MAX_PLAYERS) return;
    if (!DIFFICULTIES.includes(difficulty as BotDifficulty)) return;
    this.seatBot(difficulty as BotDifficulty);
    this.sendLobby();
  }

  removeBot(requester: string, botId: unknown): void {
    if (requester !== this.hostId || this.match) return;
    const i = this.members.findIndex((m) => m.bot && m.id === botId);
    if (i === -1) return;
    this.members.splice(i, 1);
    this.sendLobby();
  }

  setMap(requester: string, map: unknown): void {
    if (requester !== this.hostId || this.match || this.isPublic || !isMapChoice(map)) return;
    this.map = map;
    this.sendLobby();
  }

  private seatBot(difficulty: BotDifficulty): void {
    const id = `bot${++this.botCount}`;
    const taken = new Set(this.members.map((m) => m.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${this.botCount}`;
    const brain = new BotBrain(id, difficulty);
    const finisher = FINISHERS[Math.floor(Math.random() * FINISHERS.length)]!;
    // A bot's seat hears exactly what a player's socket would.
    const conn = { send: (payload: string) => brain.hear(JSON.parse(payload) as ServerMessage) };
    this.seat({ id, name, conn, finisher, bot: true, brain });
  }

  private seat(m: Pick<Member, 'id' | 'name' | 'conn' | 'finisher' | 'bot' | 'brain'>): void {
    const used = new Set(this.members.map((x) => x.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
    this.members.push({ ...m, color, ready: m.bot, wins: 0, seq: 0 });
  }

  private dropBot(): void {
    const bot = [...this.members].reverse().find((m) => m.bot);
    if (bot) this.members.splice(this.members.indexOf(bot), 1);
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

  /** Unknown effects are ignored, like unknown colours. */
  setFinisher(id: string, finisher: unknown): void {
    const member = this.members.find((m) => m.id === id);
    if (!member || this.match || !isFinisher(finisher)) return;
    member.finisher = finisher;
    this.sendLobby();
  }

  setReady(id: string, value: boolean): void {
    const member = this.members.find((m) => m.id === id);
    if (!member || member.bot || this.match) return;
    member.ready = value;
    this.sendLobby();
  }

  input(
    id: string,
    seq: number,
    mx: number,
    my: number,
    aim: number,
    report?: { x: number; y: number },
  ): void {
    this.match?.input(id, seq, mx, my, aim, report);
  }

  tick(now: number, dt: number): void {
    if (this.match) {
      this.driveBots(now);
      this.match.tick(now, dt);
      this.match.settle(now);
      if (this.match.finished) {
        this.match = null;
        this.roster = null;
        for (const m of this.members) m.ready = m.bot;
        this.countdownEndsAt = null;
        this.waitingSince = null;
        this.sendLobby();
      }
      return;
    }

    if (!this.isPublic) return;
    this.fillWithBots(now);

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

  /** Bots act on the same tick as the match, through the same input path as players. */
  private driveBots(now: number): void {
    for (const m of this.members) {
      const input = m.brain?.think(now);
      if (input) this.match?.input(m.id, ++m.seq, input.mx, input.my, input.aim, undefined, now);
    }
  }

  /**
   * Matchmaking with too few people: once a human has waited a while, bots
   * sit down one by one until there is a proper match to play.
   */
  private fillWithBots(now: number): void {
    if (this.humans.length === 0 || this.members.length >= BOT_FILL_TO) {
      this.waitingSince = null;
      return;
    }
    this.waitingSince ??= now;
    if (now - this.waitingSince < BOT_FILL_AFTER_MS || now - this.lastFill < BOT_FILL_EVERY_MS) return;
    this.lastFill = now;
    this.seatBot('normal');
    this.sendLobby();
  }

  private startMatch(now: number): void {
    const lineup = this.members.slice(0, MAX_PLAYERS).map((m) => this.profile(m));
    if (lineup.length < MIN_PLAYERS) return;

    this.countdownEndsAt = null;
    const map: MapId =
      this.map === 'random' ? MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)]! : this.map;
    this.match = new Match(
      lineup,
      (msg, to) => {
        if (msg.t === 'match') this.roster = msg;
        this.send(msg.t === 'over' ? { ...msg, wins: this.recordWin(msg.winner) } : msg, to);
      },
      now,
      map,
    );
  }

  /** Counts the win and returns the room's tally, for the result card. */
  private recordWin(winner: string | null): Record<string, number> {
    const champion = this.members.find((m) => m.id === winner);
    if (champion) champion.wins++;
    return Object.fromEntries(this.members.map((m) => [m.id, m.wins]));
  }

  private profile(m: Member): LobbyPlayer {
    return { id: m.id, name: m.name, color: m.color, ready: m.ready, finisher: m.finisher, wins: m.wins, bot: m.bot };
  }

  private sendLobby(): void {
    const players = this.members.map((m) => this.profile(m));
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
          map: this.map,
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
