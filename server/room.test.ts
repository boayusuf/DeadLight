import { describe, expect, it } from 'vitest';
import { PLAYER_COLORS } from '../shared/constants.js';
import type { ServerMessage } from '../shared/protocol.js';
import { Room } from './room.js';

function colours(room: Room): Record<string, string> {
  return Object.fromEntries(room.members.map((m) => [m.id, m.color]));
}

describe('Room colours', () => {
  const quiet = { send: (_: string) => {} };

  it('hands out a different colour to everyone who joins', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.join('b', 'B', quiet);
    expect(colours(room)).toEqual({ a: PLAYER_COLORS[0], b: PLAYER_COLORS[1] });
  });

  it('lets a player switch to a free colour', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.setColor('a', PLAYER_COLORS[4]);
    expect(colours(room).a).toBe(PLAYER_COLORS[4]);
  });

  it('refuses a colour someone else is wearing', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.join('b', 'B', quiet);
    room.setColor('b', PLAYER_COLORS[0]);
    expect(colours(room)).toEqual({ a: PLAYER_COLORS[0], b: PLAYER_COLORS[1] });
  });

  it('ignores colours that are not on the palette', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.setColor('a', '#ffffff');
    expect(colours(room).a).toBe(PLAYER_COLORS[0]);
  });

  it('tells everyone in the lobby about the change', () => {
    const seen: ServerMessage[] = [];
    const room = new Room('ABCD');
    room.join('a', 'A', { send: (raw) => seen.push(JSON.parse(raw)) });
    room.setColor('a', PLAYER_COLORS[2]);
    const lobby = seen.at(-1);
    expect(lobby?.t === 'lobby' && lobby.players[0]?.color).toBe(PLAYER_COLORS[2]);
  });
});
