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

/** How far the thumb travels for full speed, in CSS pixels. */
const STICK_REACH = 46;
/** How far the knob is drawn from centre, so it stays inside its base. */
const KNOB_TRAVEL = 30;
const STICK_DEADZONE = 0.18;

/** True on phones and tablets, where there is no keyboard or mouse to rely on. */
export const touchDevice = matchMedia('(pointer: coarse)').matches;

/** True while the player is typing, so WASD stays available to the keyboard. */
function typing(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  return node.isContentEditable || node.tagName === 'INPUT' || node.tagName === 'TEXTAREA';
}

/**
 * Keyboard and mouse on desktop. On touch screens the left half of the screen
 * is a floating joystick that appears under the thumb, and touching the right
 * half aims at that point.
 */
export class Input {
  readonly pointer = { x: 0, y: 0 };
  private readonly held = new Set<string>();

  private stickId: number | null = null;
  private aimId: number | null = null;
  private readonly origin = { x: 0, y: 0 };
  private readonly stick = { x: 0, y: 0 };
  private readonly base = document.createElement('div');
  private readonly knob = document.createElement('div');

  constructor(surface: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (typing(e.target)) return;
      if (e.code in AXES) {
        this.held.add(e.code);
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => this.held.delete(e.code));
    addEventListener('blur', () => {
      this.held.clear();
      this.release();
    });

    this.base.className = 'stick';
    this.knob.className = 'stick-knob';
    this.base.append(this.knob);
    this.base.hidden = true;
    document.body.append(this.base);

    surface.addEventListener('pointerdown', (e) => this.down(e));
    surface.addEventListener('pointermove', (e) => this.move(e));
    surface.addEventListener('pointerup', (e) => this.up(e));
    surface.addEventListener('pointercancel', (e) => this.up(e));
  }

  /** Movement direction with a length of at most one, or zeroes when idle. */
  direction(): { x: number; y: number } {
    if (this.stickId !== null) {
      const length = Math.hypot(this.stick.x, this.stick.y);
      return length < STICK_DEADZONE ? { x: 0, y: 0 } : { x: this.stick.x, y: this.stick.y };
    }

    let x = 0;
    let y = 0;
    for (const code of this.held) {
      const axis = AXES[code]!;
      x += axis[0];
      y += axis[1];
    }
    const length = Math.hypot(x, y);
    return length > 0 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
  }

  private down(e: PointerEvent): void {
    if (e.pointerType !== 'touch') {
      this.aimAt(e);
      return;
    }
    e.preventDefault();

    if (e.clientX < innerWidth / 2 && this.stickId === null) {
      this.stickId = e.pointerId;
      this.origin.x = e.clientX;
      this.origin.y = e.clientY;
      this.stick.x = 0;
      this.stick.y = 0;
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.knob.style.transform = '';
      this.base.hidden = false;
      return;
    }
    if (this.aimId === null) {
      this.aimId = e.pointerId;
      this.aimAt(e);
    }
  }

  private move(e: PointerEvent): void {
    if (e.pointerType !== 'touch') {
      this.aimAt(e);
      return;
    }
    if (e.pointerId === this.stickId) {
      let dx = (e.clientX - this.origin.x) / STICK_REACH;
      let dy = (e.clientY - this.origin.y) / STICK_REACH;
      const length = Math.hypot(dx, dy);
      if (length > 1) {
        dx /= length;
        dy /= length;
      }
      this.stick.x = dx;
      this.stick.y = dy;
      this.knob.style.transform = `translate(${dx * KNOB_TRAVEL}px, ${dy * KNOB_TRAVEL}px)`;
    } else if (e.pointerId === this.aimId) {
      this.aimAt(e);
    }
  }

  private up(e: PointerEvent): void {
    if (e.pointerId === this.stickId) this.release();
    if (e.pointerId === this.aimId) this.aimId = null;
  }

  private release(): void {
    this.stickId = null;
    this.stick.x = 0;
    this.stick.y = 0;
    this.base.hidden = true;
  }

  private aimAt(e: PointerEvent): void {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
  }
}
