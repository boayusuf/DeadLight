import type { FinisherId } from './constants.js';
import type { MapChoice, MapId } from './maps.js';
import type { Resolution } from './resolve.js';

export interface LobbyPlayer {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  finisher: FinisherId;
  /** Matches won in this room, kept across rematches. */
  wins: number;
  /** Played by the server. */
  bot: boolean;
}

export type BotDifficulty = 'easy' | 'normal' | 'hard';

/** Final placement, best first. */
export interface Standing {
  id: string;
  roundsSurvived: number;
  kills: number;
  /** Distance of this player's farthest kill, in world units; 0 without a kill. */
  longest: number;
  killedBy: string | null;
}

/** One fighter's path through a blackout: x, y and aim at REPLAY_HZ. */
export interface ReplayTrack {
  id: string;
  points: [number, number, number][];
}

export interface SnapshotPlayer {
  id: string;
  x: number;
  y: number;
  aim: number;
  alive: boolean;
}

export type ClientMessage =
  | { t: 'join'; name: string; finisher?: string; mode: 'public' }
  | { t: 'join'; name: string; finisher?: string; mode: 'create' }
  | { t: 'join'; name: string; finisher?: string; mode: 'code'; code: string }
  | { t: 'start' }
  | { t: 'ready'; value: boolean }
  /** Pick a colour, and with it a fighter. Refused if someone else has it. */
  | { t: 'color'; color: string }
  /** Pick the death effect your kills will carry. */
  | { t: 'finisher'; finisher: string }
  /** Host only: the arena for the next match. */
  | { t: 'map'; map: string }
  /** Host only: seat a bot, or remove one by id. */
  | { t: 'bot'; add: true; difficulty: string }
  | { t: 'bot'; add: false; id: string }
  /** `seq` numbers each input so the server can say which ones it has applied. */
  | { t: 'input'; seq: number; mx: number; my: number; aim: number; x?: number; y?: number }
  | { t: 'again' };

export type ServerMessage
  /** Lobby state; `countdownMs` is only present once a public match is queued. */
  = | {
      t: 'lobby';
      selfId: string;
      code: string | null;
      host: boolean;
      players: LobbyPlayer[];
      countdownMs: number | null;
      map: MapChoice;
    }
  | { t: 'match'; players: LobbyPlayer[]; startCount: number; map: MapId }
  /**
   * Lights on: the round that just ended, resolved. Also the only moment
   * opponent positions are ever sent to a client.
   */
  | {
      t: 'lights';
      round: number;
      stage: number;
      size: number;
      previousSize: number;
      players: SnapshotPlayer[];
      resolution: Resolution | null;
      remaining: number;
      holdMs: number;
      /** Every crate destroyed so far this match, including this round's. */
      broken: string[];
      /**
       * Only on the round that ends the match: every contender's path through
       * the final blackout, for the killcam. Safe to send, the round is over.
       */
      replay?: ReplayTrack[];
    }
  /** Blackout begins, and how long it will last. */
  | { t: 'dark'; round: number; durationMs: number }
  /** Your own position during blackout, as of input `seq`. */
  | { t: 'self'; x: number; y: number; seq: number }
  /** Eliminated players and late joiners watch the blackout in full light. */
  | { t: 'watch'; players: SnapshotPlayer[] }
  /** `wins` is the room's running tally including this match, keyed by player id. */
  | { t: 'over'; winner: string | null; rounds: number; standings: Standing[]; wins: Record<string, number> }
  | { t: 'err'; msg: string };
