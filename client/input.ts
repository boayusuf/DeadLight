const AXES: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/** True while the player is typing, so WASD stays available to the keyboard. */
function typing(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  return node.isContentEditable || node.tagName === 'INPUT' || node.tagName === 'TEXTAREA';
}

export class Input {
  readonly pointer = { x: 0, y: 0 };
  private readonly held = new Set<string>();

  constructor(target: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (typing(e.target)) return;
      if (e.code in AXES) {
        this.held.add(e.code);
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => this.held.delete(e.code));
    addEventListener('blur', () => this.held.clear());
    target.addEventListener('pointermove', (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
    });
  }

  /** Normalised movement direction, or zeroes when idle. */
  direction(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const code of this.held) {
      const axis = AXES[code]!;
      x += axis[0];
      y += axis[1];
    }
    const len = Math.hypot(x, y);
    return len > 0 ? { x: x / len, y: y / len } : { x: 0, y: 0 };
  }
}
