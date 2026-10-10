import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, PLAYER_COLORS, TICK_MS } from '../shared/constants.js';
import { FREEZE_FINISH_Y } from '../shared/freeze.js';
import type { ServerMessage } from '../shared/protocol.js';
import { Room, votesNeeded } from './room.js';

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

    // No mirrors, so a beam aimed away can never come back; and if cover blocks
    // the shot, sudden death cuts it. Spawns are random, so b looks away every round.
    room.setMap('a', 'pillars');
    room.requestStart('a', clock);
    const intro = [...seen].reverse().find((m) => m.t === 'lights');
    if (intro?.t !== 'lights') throw new Error('expected lights');
    const a = intro.players.find((p) => p.id === 'a')!;
    const b = intro.players.find((p) => p.id === 'b')!;
    const toB = Math.atan2(b.y - a.y, b.x - a.x);
    for (let seq = 1; ; seq++) {
      if (seq > 40) throw new Error('a never landed the shot');
      until('dark');
      room.input('a', seq, 0, 0, toB);
      room.input('b', seq, 0, 0, toB);
      const lights = until('lights');
      if (lights.t === 'lights' && lights.remaining < 2) break;
    }

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

  it('never seats a bot in matchmaking by itself, but will on request', () => {
    const room = new Room(null);
    room.join('a', 'A', quiet);
    for (let clock = 1000; clock < 60_000; clock += TICK_MS) room.tick(clock, TICK_MS / 1000);
    expect(room.members.map((m) => m.id)).toEqual(['a']);
    room.addBot('a', 'normal');
    expect(room.members.map((m) => m.id)).toEqual(['a', 'bot1']);
  });

  it('only seats a bot for someone who is actually in the room', () => {
    const room = new Room(null);
    room.join('a', 'A', quiet);
    room.addBot('stranger', 'normal');
    expect(room.members.map((m) => m.id)).toEqual(['a']);
  });
});

describe('Room kicks', () => {
  /** A room whose members record what they were sent. */
  function room(code: string | null, ids: string[]) {
    const inbox = new Map<string, ServerMessage[]>();
    const r = new Room(code);
    for (const id of ids) {
      inbox.set(id, []);
      r.join(id, id.toUpperCase(), { send: (raw) => inbox.get(id)!.push(JSON.parse(raw)) });
    }
    const lastLobby = (id: string) => [...inbox.get(id)!].reverse().find((m) => m.t === 'lobby');
    return { r, inbox, lastLobby };
  }

  it('lets the party host remove a person, and nobody else', () => {
    const { r, inbox } = room('ABCD', ['a', 'b', 'c']);
    expect(r.kick('b', 'c', 0)).toBeNull();
    expect(r.kick('a', 'a', 0)).toBeNull();
    expect(r.kick('a', 'c', 0)).toBe('c');
    expect(r.members.map((m) => m.id)).toEqual(['a', 'b']);
    expect(inbox.get('c')!.at(-1)).toEqual({ t: 'kicked', vote: false });
  });

  it('keeps bots in the party host’s hands only', () => {
    const { r } = room('ABCD', ['a', 'b']);
    r.addBot('b', 'normal');
    expect(r.members.filter((m) => m.bot)).toHaveLength(0);
    r.addBot('a', 'normal');
    const bot = r.members.find((m) => m.bot)!;
    r.removeBot('b', bot.id);
    expect(r.members).toContain(bot);
    r.removeBot('a', bot.id);
    expect(r.members).not.toContain(bot);
  });

  it('has no host kick in matchmaking', () => {
    const { r } = room(null, ['a', 'b', 'c']);
    expect(r.kick('a', 'b', 0)).toBeNull();
    expect(r.members).toHaveLength(3);
  });

  it('needs most of the others, and at least two, to vote someone out', () => {
    expect([2, 3, 4, 5, 6, 10].map(votesNeeded)).toEqual([2, 2, 2, 3, 3, 5]);
    const { r, inbox, lastLobby } = room(null, ['a', 'b', 'c', 'd', 'e']);
    expect(r.voteKick('a', 'e', 0)).toBeNull();
    expect(r.voteKick('b', 'e', 0)).toBeNull();
    const seen = lastLobby('c');
    expect(seen?.t === 'lobby' && [seen.votes, seen.voted, seen.votesNeeded]).toEqual([{ e: 2 }, [], 3]);
    const mine = lastLobby('a');
    expect(mine?.t === 'lobby' && mine.voted).toEqual(['e']);

    expect(r.voteKick('c', 'e', 0)).toBe('e');
    expect(r.members.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(inbox.get('e')!.at(-1)).toEqual({ t: 'kicked', vote: true });
  });

  it('takes a repeated vote back, and ignores votes on yourself or strangers', () => {
    const { r, lastLobby } = room(null, ['a', 'b', 'c']);
    r.voteKick('a', 'c', 0);
    r.voteKick('a', 'c', 0);
    const lobby = lastLobby('b');
    expect(lobby?.t === 'lobby' && lobby.votes).toEqual({ c: 0 });
    expect(r.voteKick('a', 'a', 0)).toBeNull();
    expect(r.voteKick('a', 'zz', 0)).toBeNull();
    expect(r.voteKick('zz', 'a', 0)).toBeNull();
    expect(r.members).toHaveLength(3);
  });

  it('forgets votes when a voter leaves', () => {
    const { r } = room(null, ['a', 'b', 'c', 'd']);
    r.voteKick('a', 'd', 0);
    r.leave('a', 0);
    expect(r.voteKick('b', 'd', 0)).toBeNull();
    expect(r.voteKick('c', 'd', 0)).toBe('d');
  });

  it('can vote someone out mid-match', () => {
    const { r } = room(null, ['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) r.setReady(id, true);
    for (let clock = 1000; !r.match && clock < 20_000; clock += TICK_MS) r.tick(clock, TICK_MS / 1000);
    expect(r.match).not.toBeNull();
    r.voteKick('a', 'c', 25_000);
    expect(r.voteKick('b', 'c', 25_000)).toBe('c');
    expect(r.members.map((m) => m.id)).toEqual(['a', 'b']);
    expect(r.match).not.toBeNull();
  });
});

describe('Room modes', () => {
  /** Collects what a member is sent, decoded. */
  function inbox() {
    const seen: ServerMessage[] = [];
    return { seen, conn: { send: (raw: string) => seen.push(JSON.parse(raw) as ServerMessage) } };
  }
  const lastLobby = (seen: ServerMessage[]) => [...seen].reverse().find((m) => m.t === 'lobby') as Extract<ServerMessage, { t: 'lobby' }>;

  it('lets the host pick a mode, tells everyone, and ignores anyone else', () => {
    const host = inbox();
    const guest = inbox();
    const room = new Room('ABCD');
    room.join('a', 'A', host.conn);
    room.join('b', 'B', guest.conn);

    room.setMode('b', 'ghost');
    expect(room.gameMode).toBe('classic');
    room.setMode('a', 'ghost');
    expect(lastLobby(host.seen).gameMode).toBe('ghost');
    expect(lastLobby(guest.seen).gameMode).toBe('ghost');
    room.setMode('a', 'switch');
    expect(room.gameMode).toBe('ghost');
  });

  it('starts the chosen mode, and refuses Assassin with too few fighters', () => {
    const host = inbox();
    const room = new Room('ABCD');
    room.join('a', 'A', host.conn);
    room.join('b', 'B', { send: () => {} });

    room.setMode('a', 'assassin');
    room.requestStart('a', 1000);
    expect(room.match).toBeNull();

    room.setMode('a', 'hunted');
    room.requestStart('a', 1000);
    const match = host.seen.find((m) => m.t === 'match') as Extract<ServerMessage, { t: 'match' }>;
    expect(match.gameMode).toBe('hunted');
    expect(host.seen.some((m) => m.t === 'brief')).toBe(true);
  });

  it('keeps the matchmaking mode out of any one player’s hands', () => {
    const room = new Room(null);
    expect(room.gameMode).toBe('classic');
    room.setMode('a', 'ghost');
    expect(room.gameMode).toBe('classic');
  });
});

describe('Room with a lit game', () => {
  const quiet = { send: (_: string) => {} };

  /** A party of three, with the host playing one of the lit games. */
  function party(mode: string): { room: Room; seen: ServerMessage[] } {
    const seen: ServerMessage[] = [];
    const room = new Room('ABCD');
    room.join('a', 'A', { send: (raw) => seen.push(JSON.parse(raw)) });
    room.join('b', 'B', quiet);
    room.join('c', 'C', quiet);
    room.setMode('a', mode);
    room.requestStart('a', 1000);
    return { room, seen };
  }

  function run(room: Room, ms: number, from = 1000): number {
    let clock = from;
    const until = clock + ms;
    while (clock < until) {
      clock += TICK_MS;
      room.tick(clock, TICK_MS / 1000);
      room.pushState();
    }
    return clock;
  }

  it('lets the host pick one of the lit games', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.setMode('a', 'sumo');
    expect(room.gameMode).toBe('sumo');
  });

  it('still refuses a mode that is not a game at all', () => {
    const room = new Room('ABCD');
    room.join('a', 'A', quiet);
    room.setMode('a', 'tiddlywinks');
    expect(room.gameMode).toBe('classic');
  });

  it('starts the game the host picked and sends its state', () => {
    const { room, seen } = party('potato');
    const announced = seen.find((m) => m.t === 'match');
    expect(announced?.t === 'match' && announced.gameMode).toBe('potato');
    run(room, 200);
    const state = seen.find((m) => m.t === 'mini');
    expect(state?.t === 'mini' && state.kind).toBe('potato');
    expect(state?.t === 'mini' && state.players).toHaveLength(3);
  });

  it('will not start a game the party is too small for', () => {
    const seen: ServerMessage[] = [];
    const room = new Room('ABCD');
    room.join('a', 'A', { send: (raw) => seen.push(JSON.parse(raw)) });
    room.join('b', 'B', quiet);
    room.setMode('a', 'rooms');
    room.requestStart('a', 1000);
    expect(seen.some((m) => m.t === 'match')).toBe(false);
    expect(room.match).toBeNull();
  });

  it('plays a lit game out and returns the room to its lobby', () => {
    const { room, seen } = party('collapse');
    run(room, 200_000);
    expect(seen.some((m) => m.t === 'over' && m.gameMode === 'collapse')).toBe(true);
    expect(room.match).toBeNull();
  });

  it('seats bots that know how to play it', () => {
    const seen: ServerMessage[] = [];
    const room = new Room('ABCD');
    room.join('a', 'A', { send: (raw) => seen.push(JSON.parse(raw)) });
    room.addBot('a', 'normal');
    room.addBot('a', 'normal');
    room.setMode('a', 'freeze');
    room.requestStart('a', 1000);
    run(room, 20_000);
    const states = seen.filter((m) => m.t === 'mini');
    expect(states.length).toBeGreaterThan(0);
    // The bots run while the eye is away, so somebody has left the start line.
    const last = states.at(-1);
    const moved =
      last?.t === 'mini' && last.players.some((p) => p.id !== 'a' && p.y > -FREEZE_FINISH_Y + 50);
    expect(moved).toBe(true);
  });
});
