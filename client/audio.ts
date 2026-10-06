/**
 * Everything is synthesised — no audio files, so the whole game is one bundle.
 * The accelerating tick is the only honest shared signal during a blackout.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private hum: { osc: OscillatorNode; gain: GainNode } | null = null;
  private noise: AudioBuffer | null = null;

  enable(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();

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

    osc.connect(filter).connect(gain).connect(ctx.destination);
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
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  }

  kill(): void {
    this.burst(0.22, 0.18, 1400);
    this.blip('sawtooth', 90, 0.18, 0.1);
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
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.02);
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
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
    source.stop(ctx.currentTime + duration + 0.02);
  }
}
