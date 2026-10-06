import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { BROADCAST_HZ, TICK_HZ, TICK_MS } from '../shared/constants.js';
import type { ClientMessage } from '../shared/protocol.js';
import { Lobby } from './lobby.js';

const PORT = Number(process.env.PORT ?? 8080);
const CLIENT_DIR = join(process.cwd(), 'dist', 'client');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Serves the built client when there is one, so production is a single process. */
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(CLIENT_DIR)) {
    res.writeHead(404).end('Run `npm run build` to serve the client from here.');
    return;
  }

  const requested = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!));
  const candidate = join(CLIENT_DIR, requested);
  const file =
    candidate.startsWith(CLIENT_DIR) && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(CLIENT_DIR, 'index.html');

  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const http = createServer(serveStatic);
const wss = new WebSocketServer({ server: http, path: '/ws' });
const lobby = new Lobby();

let nextId = 1;

/**
 * A phone that closes a tab or loses signal often never says goodbye, so the
 * socket just goes quiet. Anyone who misses a ping is dropped.
 */
const HEARTBEAT_MS = 10_000;
const answered = new WeakMap<WebSocket, boolean>();
setInterval(() => {
  for (const socket of wss.clients) {
    if (!answered.get(socket)) {
      socket.terminate();
      continue;
    }
    answered.set(socket, false);
    socket.ping();
  }
}, HEARTBEAT_MS);

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 12) : '';
  return name || `Player ${nextId}`;
}

wss.on('connection', (socket: WebSocket) => {
  const id = `p${nextId++}`;
  answered.set(socket, true);
  socket.on('pong', () => answered.set(socket, true));
  const conn = {
    send: (payload: string) => {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    },
  };

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const now = Date.now();
    const room = lobby.roomFor(id);

    switch (msg.t) {
      case 'join': {
        if (room) return;
        const name = cleanName(msg.name);
        if (msg.mode === 'public') lobby.joinPublic(id, name, conn);
        else if (msg.mode === 'create') lobby.createParty(id, name, conn);
        else {
          const result = lobby.joinParty(id, name, msg.code, conn);
          if ('error' in result) conn.send(JSON.stringify({ t: 'err', msg: result.error }));
        }
        return;
      }
      case 'start':
        room?.requestStart(id, now);
        return;
      case 'again':
        room?.setReady(id, true);
        return;
      case 'ready':
        room?.setReady(id, Boolean(msg.value));
        return;
      case 'color':
        room?.setColor(id, String(msg.color));
        return;
      case 'input':
        room?.input(
          id,
          Number(msg.seq) || 0,
          Number(msg.mx) || 0,
          Number(msg.my) || 0,
          Number(msg.aim),
          msg.x === undefined || msg.y === undefined ? undefined : { x: Number(msg.x), y: Number(msg.y) },
        );
        return;
    }
  });

  socket.on('close', () => lobby.leave(id, Date.now()));
});

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  lobby.tick(now, dt);
}, TICK_MS);

setInterval(() => lobby.pushState(), 1000 / BROADCAST_HZ);

http.listen(PORT, () => {
  console.log(`deadlight server listening on :${PORT} (tick ${TICK_HZ}Hz)`);
});
