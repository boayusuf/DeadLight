import type { FinisherId } from './constants.js';
import type { CollapseExtra } from './collapse.js';
import type { FreezeExtra } from './freeze.js';
import type { GameChoice, GameMode, MiniGameId } from './games.js';
import type { PotatoExtra } from './potato.js';
import type { RoomsExtra } from './rooms.js';
import type { SumoExtra } from './sumo.js';
import type { MapChoice, MapId } from './maps.js';
import type { ModeId, Role, RoundModeId, TargetPath } from './modes.js';
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
  /** Points in a round mode; absent in Classic. */
  score?: number;
}

/** How a round ended, for the banner everyone sees. */
export type RoundOutcome =
  /** The target or ghost went down; `winners` landed the shot. */
  | { kind: 'caught'; focus: string; winners: string[] }
  /** The target or ghost made it to the end. */
  | { kind: 'escaped'; focus: string }
  /** Assassin: who completed a contract this round. */
  | { kind: 'contracts'; winners: string[] };

/** What one fighter alone is told about their part in the round. */
export interface Brief {
  role: Role;
  /** Hunted, to the Target only: the path they are held to. */
  path?: TargetPath;
  /** Assassin, to its owner only: who they are hunting and how far along they are. */
  contract?: string;
  progress?: number;
  /** Assassin: whether the contract is still live, done, or lost. */
  status?: 'live' | 'complete' | 'failed';
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
  /** Host only: the game, 'mix', or a DeadLight mode for the next match. */
  | { t: 'mode'; mode: string }
  /** Host only: how long a session runs and which games it draws from. */
  | { t: 'session'; runs?: number; count?: number; games?: string[] }
  /** Host only: seat a bot, or remove one by id. */
  | { t: 'bot'; add: true; difficulty: string }
  | { t: 'bot'; add: false; id: string }
  /** Party host: remove someone. Matchmaking: vote to remove them, or take the vote back. */
  | { t: 'kick'; id: string }
  /** `seq` numbers each input so the server can say which ones it has applied. */
  /** `action` is the lit games' one button: a dash, a shove, a lunge. */
  | {
      t: 'input';
      seq: number;
      mx: number;
      my: number;
      aim: number;
      x?: number;
      y?: number;
      action?: boolean;
    }
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
      gameMode: GameMode;
      /** The game the room is set to, or 'mix' for a different one each time. */
      game: GameChoice;
      /** Which DeadLight mode the dark game is set to. */
      darkMode: ModeId;
      session: SessionSetup;
      /** Matchmaking kick votes against each player, and the ones this player cast. */
      votes: Record<string, number>;
      voted: string[];
      /** Votes that remove someone; null in a party, where the host decides. */
      votesNeeded: number | null;
    }
  /** You were removed from the room, by the host or by a vote. */
  | { t: 'kicked'; vote: boolean }
  | { t: 'match'; players: LobbyPlayer[]; startCount: number; map: MapId; gameMode: GameMode }
  /**
   * Round modes: everything public about the round. Sent as it starts, with
   * `outcome` null, and again as it ends.
   */
  | {
      t: 'round';
      mode: RoundModeId;
      round: number;
      rounds: number;
      /** The Target or Ghost; null in Assassin, where every target is private. */
      focus: string | null;
      scores: Record<string, number>;
      outcome: RoundOutcome | null;
    }
  /** Round modes: this fighter's private orders. Never sent to anyone else. */
  | { t: 'brief'; brief: Brief }
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
  | {
      t: 'over';
      winner: string | null;
      rounds: number;
      standings: Standing[];
      wins: Record<string, number>;
      gameMode: GameMode;
      /** Games still to play in this session; 0 when the session is over. */
      sessionLeft?: number;
    }
  /**
   * Where the session is up to, sent as each game begins: "RUN 1/2 GAME 2/3".
   * `startsInMs` is the get-ready beat before the game goes live.
   */
  | {
      t: 'session';
      run: number;
      runs: number;
      game: number;
      games: number;
      next: GameMode;
      startsInMs: number;
    }
  /**
   * The lit games, several times a second. Nothing is hidden in them, so every
   * fighter's position goes to everyone, spectators included.
   */
  | {
      t: 'mini';
      kind: MiniGameId;
      round: number;
      /** Server clock this state was taken at, so effects can be aged. */
      time: number;
      /** Milliseconds left of whatever the game is counting down. */
      left: number;
      players: MiniPlayer[];
      scores: Record<string, number>;
      extra: MiniExtra;
    }
  | { t: 'err'; msg: string };

/** A fighter in a lit game. Everyone can see everyone, so there is nothing to withhold. */
export interface MiniPlayer {
  id: string;
  x: number;
  y: number;
  aim: number;
  state: 'alive' | 'out';
}

/** Everything public about a lit game's floor, tagged by which game it is. */
export type MiniExtra =
  | ({ kind: 'freeze' } & FreezeExtra)
  | ({ kind: 'collapse' } & CollapseExtra)
  | ({ kind: 'rooms' } & RoomsExtra)
  | ({ kind: 'sumo' } & SumoExtra)
  | ({ kind: 'potato' } & PotatoExtra);

/** How long a session lasts, and which games it may draw from. */
export interface SessionSetup {
  /** Times the whole set of games is played through. */
  runs: number;
  /** Games in one run. Only used when the room is set to 'mix'. */
  count: number;
  /** The pool 'mix' draws from. */
  games: GameChoice[];
}
