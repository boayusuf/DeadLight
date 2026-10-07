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
import { MODE_IDS, MODE_MIN_PLAYERS, isModeId, type ModeId } from '../shared/modes.js';
import type { BotDifficulty, LobbyPlayer, ServerMessage } from '../shared/protocol.js';
import { BOT_NAMES, BotBrain } from './bots.js';
import { Match } from './match.js';
import { RoundMatch } from './rounds.js';

const DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];

/**
 * Votes a matchmaking kick needs: most of the other people in the room, and
 * never fewer than two, so one player can't throw out another alone.
 */
export function votesNeeded(people: number): number {
  return Math.max(2, Math.floor((people - 1) / 2) + 1);
}

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
  /** The mode for the next match. Hosts pick it; matchmaking takes each in turn. */
  gameMode: ModeId = 'classic';

  private hostId: string | null = null;
  private countdownEndsAt: number | null = null;
  private roster: ServerMessage | null = null;
  private botCount = 0;
  /** Matchmaking kick votes: who is up for removal, and who voted for it. */
  private readonly votes = new Map<string, Set<string>>();

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
    this.votes.delete(id);
    for (const voters of this.votes.values()) voters.delete(id);
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

  /** Party host only, outside a match. Seats a bot with a free colour and a random finisher. */
  addBot(requester: string, difficulty: unknown): void {
    if (this.isPublic || requester !== this.hostId || this.match || this.members.length >= MAX_PLAYERS) return;
    if (!DIFFICULTIES.includes(difficulty as BotDifficulty)) return;
    this.seatBot(difficulty as BotDifficulty);
    this.sendLobby();
  }

  removeBot(requester: string, botId: unknown): void {
    if (this.isPublic || requester !== this.hostId || this.match) return;
    const i = this.members.findIndex((m) => m.bot && m.id === botId);
    if (i === -1) return;
    this.members.splice(i, 1);
    this.sendLobby();
  }

  setMode(requester: string, mode: unknown): void {
    if (requester !== this.hostId || this.match || this.isPublic || !isModeId(mode)) return;
    this.gameMode = mode;
    this.sendLobby();
  }

  /** Whether the chosen mode can be played with everyone seated right now. */
  get modeFits(): boolean {
    return this.members.length >= MODE_MIN_PLAYERS[this.gameMode];
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

  /**
   * Party host only: removes another person from the room. Returns who was
   * kicked, after telling them, so the lobby can forget them too.
   */
  kick(requester: string, target: unknown, now: number): string | null {
    if (this.isPublic || requester !== this.hostId || target === requester) return null;
    return this.remove(target, now);
  }

  /**
   * Matchmaking only: a vote to remove someone. Once most of the others agree,
   * they are out. Voting again takes the vote back.
   */
  voteKick(voter: string, target: unknown, now: number): string | null {
    if (!this.isPublic || voter === target) return null;
    const people = this.humans;
    const suspect = people.find((m) => m.id === target);
    if (!suspect || !people.some((m) => m.id === voter)) return null;

    const voters = this.votes.get(suspect.id) ?? new Set<string>();
    if (voters.has(voter)) voters.delete(voter);
    else voters.add(voter);
    this.votes.set(suspect.id, voters);

    if (voters.size >= votesNeeded(people.length)) return this.remove(suspect.id, now);
    this.sendLobby();
    return null;
  }

  private remove(target: unknown, now: number): string | null {
    const member = this.humans.find((m) => m.id === target);
    if (!member) return null;
    member.conn.send(JSON.stringify({ t: 'kicked', vote: this.isPublic } satisfies ServerMessage));
    this.leave(member.id, now);
    return member.id;
  }

  /** Host-initiated start, private rooms only. */
  requestStart(id: string, now: number): void {
    if (this.isPublic || this.match || id !== this.hostId) return;
    if (this.members.length < MIN_PLAYERS || !this.modeFits) return;
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
        if (this.isPublic) this.rotateMode();
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

  /** Bots act on the same tick as the match, through the same input path as players. */
  private driveBots(now: number): void {
    for (const m of this.members) {
      const input = m.brain?.think(now);
      if (input) this.match?.input(m.id, ++m.seq, input.mx, input.my, input.aim, undefined, now);
    }
  }

  private startMatch(now: number): void {
    const lineup = this.members.slice(0, MAX_PLAYERS).map((m) => this.profile(m));
    if (lineup.length < MIN_PLAYERS) return;

    this.countdownEndsAt = null;
    const map: MapId =
      this.map === 'random' ? MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)]! : this.map;
    // Matchmaking never strands a lobby on a mode it is too small for.
    const mode = lineup.length >= MODE_MIN_PLAYERS[this.gameMode] ? this.gameMode : 'classic';
    const send = (msg: ServerMessage, to?: string) => {
      if (msg.t === 'match') this.roster = msg;
      this.send(msg.t === 'over' ? { ...msg, wins: this.recordWin(msg.winner) } : msg, to);
    };
    this.match = mode === 'classic' ? new Match(lineup, send, now, map) : new RoundMatch(lineup, send, now, map, mode);
  }

  /** Matchmaking plays the modes in turn, so every queue gets some variety. */
  private rotateMode(): void {
    this.gameMode = MODE_IDS[(MODE_IDS.indexOf(this.gameMode) + 1) % MODE_IDS.length]!;
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

    const votes = Object.fromEntries([...this.votes].map(([id, voters]) => [id, voters.size]));
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
          gameMode: this.gameMode,
          votes,
          voted: [...this.votes].filter(([, voters]) => voters.has(m.id)).map(([id]) => id),
          votesNeeded: this.isPublic ? votesNeeded(this.humans.length) : null,
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
