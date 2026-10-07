import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, PLAYER_COLORS, TICK_MS } from '../shared/constants.js';
import type { ServerMessage } from '../shared/protocol.js';
import { BOT_FILL_AFTER_MS, BOT_FILL_TO, Room } from './room.js';

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

describe('Room finishers', () => {
  const quiet = { send: (_: string) => {} };

  it('starts everyone on the default and keeps a pick made at join', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.join('b', 'B', quiet, 'supernova');
    expect(room.members.map((m) => m.finisher)).toEqual(['shatter', 'supernova']);
  });

  it('switches to a known finisher and ignores anything else', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.setFinisher('a', 'glitch');
    room.setFinisher('a', 'nuke');
    room.setFinisher('a', { evil: true });
    expect(room.members[0]?.finisher).toBe('glitch');
  });
});

describe('Room wins', () => {
  it('counts each match win and carries the tally into the next lobby', () => {
    const seen: ServerMessage[] = [];
    const room = new Room('ABCD');
    room.join('a', 'A', { send: (raw) => seen.push(JSON.parse(raw)) });
    room.join('b', 'B', { send: () => {} });

    let clock = 1000;
    const until = (t: ServerMessage['t']) => {
      const from = seen.length;
      for (let i = 0; i < 2000; i++) {
        clock += TICK_MS;
        room.tick(clock, TICK_MS / 1000);
        const found = seen.slice(from).find((m) => m.t === t);
        if (found) return found;
      }
      throw new Error(`No '${t}' arrived`);
    };

    room.requestStart('a', clock);
    until('dark');
    const lights = until('lights');
    if (lights.t !== 'lights') throw new Error('expected lights');
    const a = lights.players.find((p) => p.id === 'a')!;
    const b = lights.players.find((p) => p.id === 'b')!;
    until('dark');
    room.input('a', 1, 0, 0, Math.atan2(b.y - a.y, b.x - a.x));
    room.input('b', 1, 0, 0, Math.atan2(a.y - b.y, a.x - b.x) + Math.PI / 2);

    const over = until('over');
    expect(over.t === 'over' && over.wins).toEqual({ a: 1, b: 0 });
    // The room drops back to its lobby on the same tick the match settles.
    const lobby = seen.slice(seen.indexOf(over)).find((m) => m.t === 'lobby');
    expect(lobby?.t === 'lobby' && lobby.players.map((p) => p.wins)).toEqual([1, 0]);
  });
});

describe('Room arenas', () => {
  const quiet = { send: (_: string) => {} };

  it('lets the host pick a map or random, and nobody else', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.join('b', 'B', quiet);
    room.setMap('a', 'mirrors');
    expect(room.map).toBe('mirrors');
    room.setMap('b', 'factory');
    room.setMap('a', 'moon');
    expect(room.map).toBe('mirrors');
    room.setMap('a', 'random');
    expect(room.map).toBe('random');
  });

  it('keeps matchmaking on random', () => {
    const room = new Room(null);
    room.join('a', 'A', quiet);
    room.setMap('a', 'lab');
    expect(room.map).toBe('random');
  });
});

describe('Room bots', () => {
  const quiet = { send: (_: string) => {} };

  it('seats a ready bot for the host only', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.join('b', 'B', quiet);
    room.addBot('b', 'normal');
    room.addBot('a', 'godlike');
    expect(room.members).toHaveLength(2);
    room.addBot('a', 'hard');
    const bot = room.members[2]!;
    expect(bot).toMatchObject({ bot: true, ready: true });
    expect(bot.color).not.toBe(room.members[0]!.color);
  });

  it('removes a bot on the host\'s word, never a person', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.join('b', 'B', quiet);
    room.addBot('a', 'easy');
    const botId = room.members[2]!.id;
    room.removeBot('a', 'b');
    room.removeBot('a', botId);
    expect(room.members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('gives up a bot seat when a person joins a full room', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    for (let i = 1; i < MAX_PLAYERS; i++) room.addBot('a', 'normal');
    expect(room.members).toHaveLength(MAX_PLAYERS);
    expect(room.open).toBe(true);
    room.join('z', 'Z', quiet);
    expect(room.members).toHaveLength(MAX_PLAYERS);
    expect(room.members.filter((m) => m.bot)).toHaveLength(MAX_PLAYERS - 2);
  });

  it('empties out when the last person leaves, bots and all', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.addBot('a', 'normal');
    room.leave('a', 5000);
    expect(room.members).toHaveLength(0);
    expect(room.emptySince).toBe(5000);
  });

  it('fills a lonely matchmaking room with bots after a wait', () => {
    const room = new Room(null);
    room.join('a', 'A', quiet);
    let clock = 1000;
    for (; clock < 1000 + BOT_FILL_AFTER_MS - 100; clock += TICK_MS) room.tick(clock, TICK_MS / 1000);
    expect(room.members).toHaveLength(1);
    for (; clock < 1000 + BOT_FILL_AFTER_MS + 10_000; clock += TICK_MS) room.tick(clock, TICK_MS / 1000);
    expect(room.members).toHaveLength(BOT_FILL_TO);
    expect(room.members.filter((m) => m.bot)).toHaveLength(BOT_FILL_TO - 1);
  });
});
