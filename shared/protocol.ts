import type { Resolution } from './resolve.js';

export interface LobbyPlayer {
  id: string;
  name: string;
  color: string;
  ready: boolean;
}

/** Final placement, best first. */
export interface Standing {
  id: string;
  roundsSurvived: number;
}

export interface SnapshotPlayer {
  id: string;
  x: number;
  y: number;
  aim: number;
  alive: boolean;
}

export type ClientMessage =
  | { t: 'join'; name: string; mode: 'public' }
  | { t: 'join'; name: string; mode: 'create' }
  | { t: 'join'; name: string; mode: 'code'; code: string }
  | { t: 'start' }
  | { t: 'ready'; value: boolean }
  /** Pick a colour, and with it a fighter. Refused if someone else has it. */
  | { t: 'color'; color: string }
  /** `seq` numbers each input so the server can say which ones it has applied. */
  | { t: 'input'; seq: number; mx: number; my: number; aim: number; x?: number; y?: number }
  | { t: 'again' };

export type ServerMessage
  /** Lobby state; `countdownMs` is only present once a public match is queued. */
  = | { t: 'lobby'; selfId: string; code: string | null; host: boolean; players: LobbyPlayer[]; countdownMs: number | null }
  | { t: 'match'; players: LobbyPlayer[]; startCount: number }
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
    }
  /** Blackout begins, and how long it will last. */
  | { t: 'dark'; round: number; durationMs: number }
  /** Your own position during blackout, as of input `seq`. */
  | { t: 'self'; x: number; y: number; seq: number }
  /** Eliminated players and late joiners watch the blackout in full light. */
  | { t: 'watch'; players: SnapshotPlayer[] }
  | { t: 'over'; winner: string | null; rounds: number; standings: Standing[] }
  | { t: 'err'; msg: string };
