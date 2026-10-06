import type { ClientMessage, ServerMessage } from '../shared/protocol.js';

function endpoint(): string {
  const override = import.meta.env.VITE_SERVER_URL;
  if (override) return override;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

export class Net {
  private socket: WebSocket | null = null;

  constructor(
    private readonly onMessage: (msg: ServerMessage) => void,
    private readonly onDrop: () => void,
  ) {}

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
