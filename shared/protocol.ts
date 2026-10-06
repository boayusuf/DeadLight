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
  | { t: 'input'; mx: number; my: number; aim: number }
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
  /** Blackout begins. Deliberately carries no duration. */
  | { t: 'dark'; round: number }
  /** Your own corrected position during blackout. */
  | { t: 'self'; x: number; y: number }
  /** Eliminated players and late joiners watch the blackout in full light. */
  | { t: 'watch'; players: SnapshotPlayer[] }
  | { t: 'over'; winner: string | null; rounds: number; standings: Standing[] }
  | { t: 'err'; msg: string };
