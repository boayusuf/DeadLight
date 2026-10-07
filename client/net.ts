import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

function endpoint(): string {
  const override = import.meta.env.VITE_SERVER_URL;
  if (override) return override;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

/**
 * A free server sleeps when nobody plays and takes a while to wake. Knocking
 * as the page opens lets it boot while the player is still typing a name.
 * Only the side effect matters, so a failed knock is ignored.
 */
export function wake(): void {
  if (!import.meta.env.VITE_SERVER_URL) return;
  const url = endpoint().replace(/^ws/, 'http').replace(/\/ws$/, '/');
  fetch(url, { mode: 'no-cors' }).catch(() => undefined);
}

export class Net {
  private socket: WebSocket | null = null;

  constructor(
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onDrop: () => void,
  ) {
    // Leave the room straight away when the tab closes, instead of waiting
    // for the server's heartbeat to notice.
    addEventListener('pagehide', () => this.socket?.close());
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;

    const socket = new WebSocket(endpoint());
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not reach the server.')), {
        once: true,
      });
    });

    socket.addEventListener('message', (e) => this.onMessage(JSON.parse(e.data as string)));
    socket.addEventListener('close', () => {
      this.socket = null;
      this.onDrop();
    });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
