import { MODE_BLURBS, MODE_IDS, MODE_MIN_PLAYERS, MODE_NAMES, type ModeId } from './modes.js';

/**
 * The games a room can play. `deadlight` is the blackout shooter this project
 * started as — its own modes live in `modes.ts`. The other five are lit,
 * continuous games that share only the fighters, the lobby and the finishers.
 */
export const MINI_GAME_IDS = ['freeze', 'collapse', 'rooms', 'sumo', 'potato'] as const;
export type MiniGameId = (typeof MINI_GAME_IDS)[number];

export const GAME_IDS = ['deadlight', ...MINI_GAME_IDS] as const;
export type GameId = (typeof GAME_IDS)[number];

export const isMiniGameId = (value: unknown): value is MiniGameId =>
  (MINI_GAME_IDS as readonly unknown[]).includes(value);
export const isGameId = (value: unknown): value is GameId =>
  (GAME_IDS as readonly unknown[]).includes(value);

export const GAME_NAMES: Record<GameId, string> = {
  deadlight: 'DeadLight',
  freeze: 'Freeze',
  collapse: 'Collapse',
  rooms: 'Rooms',
  sumo: 'Sumo',
  potato: 'Hot potato',
};

export const GAME_BLURBS: Record<GameId, string> = {
  deadlight: 'Shoot blind. Last one standing.',
  freeze: 'Move while the eye looks and you are done.',
  collapse: 'The floor breaks under you.',
  rooms: 'Get into a room with exactly that many.',
  sumo: 'Slippery ice. Shove them off and stay on.',
  potato: 'Pass the bomb before it goes off.',
};

/**
 * Fewest fighters a game makes sense with. Rooms needs three: with two, every
 * call of "two" is answered by standing still.
 */
export const GAME_MIN_PLAYERS: Record<GameId, number> = {
  deadlight: 2,
  freeze: 2,
  collapse: 2,
  rooms: 3,
  sumo: 2,
  potato: 3,
};

/**
 * What the camera shows of each arena, in world units. Freeze is a long
 * corridor seen a screen at a time; the rest are shown whole.
 */
export const GAME_VIEW: Record<MiniGameId, { w: number; h: number }> = {
  freeze: { w: 900, h: 1500 },
  collapse: { w: 1100, h: 1100 },
  rooms: { w: 1200, h: 1200 },
  sumo: { w: 1200, h: 1200 },
  potato: { w: 1100, h: 1100 },
};

/**
 * Everything a lobby can be set to, in the order the picker shows it: the dark
 * game and its three modes, then the five lit games, then a mix of them all.
 * `classic` is DeadLight itself, so it is not listed twice.
 */
export const PICKABLE: readonly (GameMode | 'mix')[] = [
  'classic',
  ...MODE_IDS.filter((m) => m !== 'classic'),
  ...MINI_GAME_IDS,
  'mix',
];

/** What the lobby may be set to: one game, or a different one every round. */
export type GameChoice = GameId | 'mix';
export const isGameChoice = (value: unknown): value is GameChoice =>
  value === 'mix' || isGameId(value);

/** A game mode on the wire: a DeadLight mode, or one of the lit games. */
export type GameMode = ModeId | MiniGameId;

/**
 * One name, blurb and seat count for either family, so the lobby does not have
 * to know which kind of game it is showing.
 */
export function gameModeName(mode: GameMode): string {
  return isMiniGameId(mode) ? GAME_NAMES[mode] : MODE_NAMES[mode];
}

export function gameModeBlurb(mode: GameMode): string {
  return isMiniGameId(mode) ? GAME_BLURBS[mode] : MODE_BLURBS[mode];
}

export function gameModeMinPlayers(mode: GameMode): number {
  return isMiniGameId(mode) ? GAME_MIN_PLAYERS[mode] : MODE_MIN_PLAYERS[mode];
}
