/** Below this the server and client agree; the gap is just timing. */
const DEADZONE = 28;
/** Beyond this the client is genuinely wrong, so jump rather than drift. */
const SNAP = 160;
/** Share of a real error corrected per server message, so fixes stay invisible. */
const EASE = 0.2;

interface Sent {
  seq: number;
  x: number;
  y: number;
}

/**
 * Keeps the client's own movement honest without fighting latency.
 *
 * The server's reports are always a round trip old. Comparing them with where
 * the fighter is *now* means a fast-moving player is always "wrong" and gets
 * yanked backwards several times a second. Instead each input is numbered and
 * remembered, and a report is compared with where the fighter was when that
 * input was sent — which is the only position the server could know about.
 */
export class Prediction {
  private seq = 0;
  private sent: Sent[] = [];

  reset(): void {
    this.sent = [];
  }

  /** Call when an input goes out; returns the number to send with it. */
  record(x: number, y: number): number {
    this.seq++;
    this.sent.push({ seq: this.seq, x, y });
    if (this.sent.length > 120) this.sent.shift();
    return this.seq;
  }

  /** Returns the corrected current position for a server report. */
  reconcile(
    report: { x: number; y: number; seq: number },
    current: { x: number; y: number },
  ): { x: number; y: number } {
    const then = this.sent.find((s) => s.seq === report.seq);
    this.sent = this.sent.filter((s) => s.seq > report.seq);
    if (!then) return current;

    const ex = report.x - then.x;
    const ey = report.y - then.y;
    const error = Math.hypot(ex, ey);

    if (error < DEADZONE) return current;
    if (error > SNAP) return { x: current.x + ex, y: current.y + ey };
    return { x: current.x + ex * EASE, y: current.y + ey * EASE };
  }
}
