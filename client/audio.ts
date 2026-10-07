/**
 * Everything is synthesised — no audio files, so the whole game is one bundle.
 * The accelerating tick is the only honest shared signal during a blackout.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  /** Every effect runs through here, so music and finishers share one mix. */
  private master: GainNode | null = null;
  private hum: { osc: OscillatorNode; gain: GainNode } | null = null;
  private noise: AudioBuffer | null = null;

  /** Null until the first user gesture has unlocked audio. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  get output(): AudioNode | null {
    return this.master;
  }

  enable(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    const seconds = 0.4;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;
  }

  startHum(): void {
    const ctx = this.ctx;
    if (!ctx || this.hum) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sawtooth';
    osc.frequency.value = 42;
    filter.type = 'lowpass';
    filter.frequency.value = 180;
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.3);

    osc.connect(filter).connect(gain).connect(this.master!);
    osc.start();
    this.hum = { osc, gain };
  }

  stopHum(): void {
    const ctx = this.ctx;
    if (!ctx || !this.hum) return;
    const { osc, gain } = this.hum;
    this.hum = null;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
    osc.stop(ctx.currentTime + 0.1);
  }

  tick(urgency: number): void {
    this.blip('square', 620 + urgency * 420, 0.045, 0.05);
  }

  clack(): void {
    this.blip('square', 180, 0.09, 0.12);
    this.burst(0.09, 0.14, 2600);
  }

  thud(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(36, ctx.currentTime + 0.5);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
    osc.connect(gain).connect(this.master!);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  }

  /** Two beams cancelling: a bright metallic ring over a hiss. */
  clash(): void {
    this.blip('square', 1320, 0.22, 0.05);
    this.blip('square', 1985, 0.16, 0.035);
    this.burst(0.12, 0.08, 5200);
  }

  /** Under a callout banner: a low drop with a short bright edge on top. */
  callout(): void {
    this.sweep('sine', 140, 48, 0.32, 0.16);
    this.blip('square', 990, 0.06, 0.04);
  }

  /** Two fighters left: a short siren. */
  alarm(): void {
    [0, 0.28].forEach((at) => this.sweep('sawtooth', 520, 780, 0.26, 0.045, at));
  }

  /** Killcam opens: the tape winding back. */
  rewind(): void {
    this.sweep('sawtooth', 900, 120, 0.3, 0.05);
    this.burst(0.3, 0.06, 3000);
  }

  /** Killcam lights-on, slowed right down. */
  slowSnap(): void {
    this.sweep('square', 120, 40, 0.7, 0.1);
    this.burst(0.6, 0.12, 900);
  }

  /** The freeze frame on the killing hit. */
  heartbeat(): void {
    [0, 0.17].forEach((at) => this.sweep('sine', 80, 38, 0.2, 0.22, at));
  }

  /** A dry footfall, quiet enough to sit under everything else. */
  step(): void {
    this.burst(0.03, 0.035, 900);
  }

  /** Two short beeps: the perimeter is about to close in. */
  warn(): void {
    this.blip('square', 880, 0.05, 0.07);
    window.setTimeout(() => this.blip('square', 880, 0.05, 0.07), 130);
  }

  impact(): void {
    this.burst(0.05, 0.07, 3200);
  }

  win(): void {
    [392, 523, 659, 784].forEach((hz, i) => {
      window.setTimeout(() => this.blip('square', hz, 0.16, 0.09), i * 110);
    });
  }

  private blip(type: OscillatorType, frequency: number, duration: number, volume: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain).connect(this.master!);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
  }

  /** A pitch glide, `delay` seconds from now. */
  private sweep(
    type: OscillatorType,
    from: number,
    to: number,
    duration: number,
    volume: number,
    delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + duration);
    gain.gain.setValueAtTime(volume, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  private burst(duration: number, volume: number, cutoff: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    source.buffer = this.noise;
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    source.connect(filter).connect(gain).connect(this.master!);
    source.start();
    source.stop(ctx.currentTime + duration + 0.02);
  }
}
