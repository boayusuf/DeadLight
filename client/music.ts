import { STAGE_COUNT } from '../shared/constants.js';

/** Dark industrial techno in E phrygian; every layer is synthesised, nothing is sampled. */
const STAGE_BPM = [108, 118, 128, 138, 148] as const;
const SHOWDOWN_BPM = 152;
const STEPS_PER_BAR = 16;
const STORAGE_KEY = 'deadlight.music';

/** Sits under the SFX, whose peaks are ~0.05-0.2 on the shared master. */
const MUSIC_LEVEL = 0.13;
const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;
const MAX_LAG_S = 0.2;
const FADE_OUT_S = 0.6;
const TEARDOWN_MS = 700;
const OPEN_CUTOFF = 18000;
const DARK_CUTOFF = 500;
const DARK_GAIN = 0.5;
const KILLCAM_S = 4;

const ROOT_MIDI = 28;
const CHORD_ROOTS = [0, 0, -4, 1] as const;
const SHOWDOWN_ROOTS = [0, 0, 0, 1] as const;

const BASS_BASE: readonly (number | null)[] = [
  null, null, 0, null, null, null, 0, null, null, null, 0, null, null, null, 1, null,
];
const BASS_BUSY: readonly (number | null)[] = [
  null, null, 0, 12, null, null, 0, null, null, 0, null, 12, null, null, 3, null,
];
const BASS_DRIVE: readonly number[] = [0, 0, 12, 0, 0, 12, 0, 0, 0, 0, 12, 0, 0, 12, 1, 0];
const ARP: readonly number[] = [0, 12, 7, 12, 0, 10, 7, 12, 0, 12, 7, 15, 0, 10, 7, 3];
const STAB_STEPS: readonly number[] = [0, 3, 6, 10];
const STAB_CHORD: readonly number[] = [0, 3, 7];
const PAD_CHORD: readonly number[] = [12, 19, 25];
const FILL_CLAPS: readonly number[] = [10, 12, 13, 14, 15];

const midiHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

interface Rig {
  ctx: AudioContext;
  noise: AudioBuffer;
  pre: GainNode;
  darkFilter: BiquadFilterNode;
  darkGain: GainNode;
  comp: DynamicsCompressorNode;
  fade: GainNode;
  level: GainNode;
  /** Live sources, so teardown can cut tails instead of waiting for them. */
  voices: Set<AudioScheduledSourceNode>;
}

interface ToneOpts {
  type: OscillatorType;
  freq: number;
  t: number;
  dur: number;
  peak: number;
  attack?: number;
  detune?: number;
  glideTo?: number;
  glideTime?: number;
  cutoff?: number;
  cutoffTo?: number;
  /** Triangle envelope (attack, then linear fall) instead of a plucked decay. */
  swell?: boolean;
}

interface NoiseOpts {
  t: number;
  dur: number;
  peak: number;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
  attack?: number;
}

interface Riser {
  out: GainNode;
  sources: AudioScheduledSourceNode[];
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function buildRig(ctx: AudioContext, out: AudioNode, noise: AudioBuffer): Rig {
  const pre = ctx.createGain();
  const darkFilter = ctx.createBiquadFilter();
  const darkGain = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  const fade = ctx.createGain();
  const level = ctx.createGain();
  darkFilter.type = 'lowpass';
  darkFilter.Q.value = 0.7;
  darkFilter.frequency.value = OPEN_CUTOFF;
  comp.threshold.value = -16;
  comp.knee.value = 10;
  comp.ratio.value = 6;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  fade.gain.value = 0;
  pre.connect(darkFilter).connect(darkGain).connect(comp).connect(fade).connect(level).connect(out);
  return { ctx, noise, pre, darkFilter, darkGain, comp, fade, level, voices: new Set() };
}

function destroyRig(rig: Rig): void {
  for (const voice of rig.voices) {
    try {
      voice.stop();
    } catch {
      // Already stopped; disconnect below is all that is left to do.
    }
    voice.disconnect();
  }
  rig.voices.clear();
  [rig.pre, rig.darkFilter, rig.darkGain, rig.comp, rig.fade, rig.level].forEach((n) => n.disconnect());
}

/** Registers a source and frees it, plus its helper nodes, the moment it ends. */
function track(rig: Rig, source: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
  rig.voices.add(source);
  source.onended = () => {
    rig.voices.delete(source);
    source.disconnect();
    nodes.forEach((n) => n.disconnect());
  };
}

function tone(rig: Rig, o: ToneOpts): void {
  const { ctx } = rig;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.freq, o.t);
  if (o.glideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(o.glideTo, o.t + (o.glideTime ?? o.dur));
  }
  if (o.detune) osc.detune.value = o.detune;

  gain.gain.setValueAtTime(0.0001, o.t);
  gain.gain.linearRampToValueAtTime(o.peak, o.t + (o.attack ?? 0.004));
  if (o.swell) gain.gain.linearRampToValueAtTime(0.0001, o.t + o.dur);
  else gain.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur);

  const nodes: AudioNode[] = [gain];
  if (o.cutoff !== undefined) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(o.cutoff, o.t);
    filter.frequency.exponentialRampToValueAtTime(o.cutoffTo ?? o.cutoff, o.t + o.dur);
    osc.connect(filter).connect(gain);
    nodes.push(filter);
  } else {
    osc.connect(gain);
  }
  gain.connect(rig.pre);
  osc.start(o.t);
  osc.stop(o.t + o.dur + 0.05);
  track(rig, osc, ...nodes);
}

function noiseHit(rig: Rig, o: NoiseOpts): void {
  const { ctx } = rig;
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = rig.noise;
  filter.type = o.filter;
  filter.frequency.value = o.freq;
  filter.Q.value = o.q ?? 0.7;
  gain.gain.setValueAtTime(0.0001, o.t);
  gain.gain.linearRampToValueAtTime(o.peak, o.t + (o.attack ?? 0.002));
  gain.gain.exponentialRampToValueAtTime(0.0001, o.t + o.dur);
  source.connect(filter).connect(gain).connect(rig.pre);
  source.start(o.t, Math.random() * (rig.noise.duration - o.dur - 0.1));
  source.stop(o.t + o.dur + 0.05);
  track(rig, source, filter, gain);
}

function kick(rig: Rig, t: number, heavy: boolean): void {
  tone(rig, {
    type: 'sine', freq: 150, glideTo: 42, glideTime: 0.1,
    t, dur: heavy ? 0.42 : 0.32, peak: heavy ? 1 : 0.9,
  });
  if (heavy) noiseHit(rig, { t, dur: 0.02, peak: 0.25, filter: 'bandpass', freq: 3000 });
}

function clap(rig: Rig, t: number, vel: number): void {
  noiseHit(rig, { t: t - 0.012, dur: 0.02, peak: 0.12 * vel, filter: 'bandpass', freq: 1500, q: 1.2 });
  noiseHit(rig, { t, dur: 0.14, peak: 0.3 * vel, filter: 'bandpass', freq: 1500, q: 1.2 });
}

function hat(rig: Rig, t: number, open: boolean, vel: number): void {
  noiseHit(rig, {
    t, dur: open ? 0.14 : 0.04, peak: (open ? 0.09 : 0.1) * vel, filter: 'highpass', freq: 7000,
  });
}

/** The "drop" when lights return: kick, sub fall and a crash-like noise hit. */
function dropAccent(rig: Rig, t: number): void {
  kick(rig, t, true);
  tone(rig, { type: 'sine', freq: 70, glideTo: 28, glideTime: 0.6, t, dur: 0.7, peak: 0.7 });
  noiseHit(rig, { t, dur: 0.7, peak: 0.3, filter: 'highpass', freq: 4500, attack: 0.005 });
}

function heartbeat(rig: Rig, t: number, peak: number): void {
  tone(rig, { type: 'sine', freq: 80, glideTo: 38, glideTime: 0.08, t, dur: 0.28, peak });
}

/** Rising tension for the killcam: a bandpass noise sweep plus a climbing saw. */
function startRiser(rig: Rig, t: number): Riser {
  const { ctx } = rig;
  const out = ctx.createGain();
  out.connect(rig.pre);

  const source = ctx.createBufferSource();
  const band = ctx.createBiquadFilter();
  const noiseGain = ctx.createGain();
  source.buffer = rig.noise;
  source.loop = true;
  band.type = 'bandpass';
  band.Q.value = 3;
  band.frequency.setValueAtTime(250, t);
  band.frequency.exponentialRampToValueAtTime(6000, t + KILLCAM_S);
  source.connect(band).connect(noiseGain);
  noiseGain.gain.setValueAtTime(0.0001, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.22, t + KILLCAM_S);
  noiseGain.connect(out);

  const saw = ctx.createOscillator();
  const sawFilter = ctx.createBiquadFilter();
  const sawGain = ctx.createGain();
  saw.type = 'sawtooth';
  saw.frequency.setValueAtTime(110, t);
  saw.frequency.exponentialRampToValueAtTime(440, t + KILLCAM_S);
  sawFilter.type = 'lowpass';
  sawFilter.frequency.value = 1200;
  sawGain.gain.setValueAtTime(0.0001, t);
  sawGain.gain.exponentialRampToValueAtTime(0.08, t + KILLCAM_S);
  saw.connect(sawFilter).connect(sawGain).connect(out);

  const end = t + KILLCAM_S + 0.3;
  source.start(t);
  source.stop(end);
  saw.start(t);
  saw.stop(end);
  track(rig, source, band, noiseGain);
  track(rig, saw, sawFilter, sawGain, out);
  return { out, sources: [source, saw] };
}

export class Music {
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private noise: AudioBuffer | null = null;
  private rig: Rig | null = null;
  private timer: number | null = null;
  private teardownTimer: number | null = null;

  private running = false;
  private isMuted = false;
  private dark = false;
  private killcam = false;
  private killStart = 0;
  private killStep = 0;
  private riser: Riser | null = null;

  private stage = 0;
  private pendingStage = 0;
  private showdown = false;
  private pendingShowdown = false;
  private step = 0;
  private bar = 0;
  private nextTime = 0;

  constructor() {
    try {
      this.isMuted = localStorage.getItem(STORAGE_KEY) === 'off';
    } catch {
      this.isMuted = false;
    }
  }

  get muted(): boolean {
    return this.isMuted;
  }

  attach(ctx: AudioContext, out: AudioNode): void {
    if (this.ctx === ctx) {
      this.out = out;
      return;
    }
    this.shutdown();
    this.ctx = ctx;
    this.out = out;
    this.noise = makeNoise(ctx);
  }

  start(): void {
    const { ctx, out, noise } = this;
    if (!ctx || !out || !noise || this.running) return;
    if (this.teardownTimer !== null) {
      window.clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
    const rig = (this.rig ??= buildRig(ctx, out, noise));
    this.running = true;
    this.killcam = false;
    this.stage = this.pendingStage = 0;
    this.showdown = this.pendingShowdown = false;
    this.step = 0;
    this.bar = 0;
    this.nextTime = ctx.currentTime + 0.06;
    this.applyDark(rig, this.dark, true);
    this.applyMute(rig, true);
    this.fadeIn(rig);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    const { ctx, rig } = this;
    if (!ctx || !rig || !this.running) return;
    this.running = false;
    this.killcam = false;
    this.dark = false;
    this.showdown = this.pendingShowdown = false;
    this.clearTimer();
    this.stopRiser(rig);
    const now = ctx.currentTime;
    rig.fade.gain.cancelScheduledValues(now);
    rig.fade.gain.setValueAtTime(rig.fade.gain.value, now);
    rig.fade.gain.linearRampToValueAtTime(0, now + FADE_OUT_S);
    this.teardownTimer = window.setTimeout(() => this.teardown(), TEARDOWN_MS);
  }

  setStage(stage: number): void {
    this.pendingStage = Math.max(0, Math.min(STAGE_COUNT - 1, Math.round(stage)));
  }

  setShowdown(on: boolean): void {
    this.pendingShowdown = on;
  }

  setDark(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    const { ctx, rig } = this;
    if (!ctx || !rig || !this.running) return;
    this.applyDark(rig, dark, false);
    if (!dark && !this.killcam && !this.isMuted) dropAccent(rig, ctx.currentTime);
  }

  setKillcam(on: boolean): void {
    const { ctx, rig } = this;
    if (!ctx || !rig || !this.running || on === this.killcam) return;
    this.killcam = on;
    this.nextTime = ctx.currentTime + 0.03;
    if (on) {
      this.killStart = this.nextTime;
      this.killStep = 0;
      this.riser = startRiser(rig, this.nextTime);
    } else {
      this.stopRiser(rig);
    }
  }

  toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    try {
      localStorage.setItem(STORAGE_KEY, this.isMuted ? 'off' : 'on');
    } catch {
      // Private mode: the toggle still works for this session.
    }
    if (this.rig) this.applyMute(this.rig, false);
    return this.isMuted;
  }

  private shutdown(): void {
    this.running = false;
    this.clearTimer();
    if (this.teardownTimer !== null) window.clearTimeout(this.teardownTimer);
    this.teardown();
  }

  private teardown(): void {
    this.teardownTimer = null;
    if (this.rig && !this.running) {
      destroyRig(this.rig);
      this.rig = null;
      this.riser = null;
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private fadeIn(rig: Rig): void {
    const now = rig.ctx.currentTime;
    rig.fade.gain.cancelScheduledValues(now);
    rig.fade.gain.setValueAtTime(rig.fade.gain.value, now);
    rig.fade.gain.linearRampToValueAtTime(1, now + this.barDur());
  }

  private applyMute(rig: Rig, immediate: boolean): void {
    const now = rig.ctx.currentTime;
    const target = this.isMuted ? 0 : MUSIC_LEVEL;
    rig.level.gain.cancelScheduledValues(now);
    if (immediate) rig.level.gain.setValueAtTime(target, now);
    else rig.level.gain.setTargetAtTime(target, now, 0.05);
  }

  /** Muffling eases in over ~80 ms; reopening is instant so the drop lands on the beat. */
  private applyDark(rig: Rig, dark: boolean, immediate: boolean): void {
    const now = rig.ctx.currentTime;
    const { frequency } = rig.darkFilter;
    const { gain } = rig.darkGain;
    frequency.cancelScheduledValues(now);
    gain.cancelScheduledValues(now);
    if (dark && !immediate) {
      frequency.setTargetAtTime(DARK_CUTOFF, now, 0.027);
      gain.setTargetAtTime(DARK_GAIN, now, 0.027);
      return;
    }
    frequency.setValueAtTime(dark ? DARK_CUTOFF : OPEN_CUTOFF, now);
    gain.setValueAtTime(dark ? DARK_GAIN : 1, now);
  }

  private stopRiser(rig: Rig): void {
    const riser = this.riser;
    if (!riser) return;
    this.riser = null;
    const now = rig.ctx.currentTime;
    riser.out.gain.cancelScheduledValues(now);
    riser.out.gain.setValueAtTime(riser.out.gain.value, now);
    riser.out.gain.linearRampToValueAtTime(0, now + 0.15);
    riser.sources.forEach((s) => s.stop(now + 0.2));
  }

  /** Lookahead scheduler: tiny interval, notes placed on the audio clock. */
  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.rig || !this.running) return;
    const now = ctx.currentTime;
    if (this.isMuted) {
      this.nextTime = now + 0.05;
      return;
    }
    // A throttled background tab must not release a burst of stale notes.
    if (this.nextTime < now - MAX_LAG_S) this.nextTime = now + 0.05;
    while (this.nextTime < now + LOOKAHEAD_S) this.scheduleNext(this.rig);
  }

  private scheduleNext(rig: Rig): void {
    if (this.killcam) {
      this.killcamStep(rig, this.nextTime);
      this.nextTime += this.killcamStepDur(this.nextTime);
      this.killStep++;
      return;
    }
    this.scheduleStep(rig, this.nextTime);
    this.nextTime += this.stepDur();
    this.step = (this.step + 1) % STEPS_PER_BAR;
    if (this.step === 0) this.nextBar();
  }

  /** Stage, tempo and showdown only change on a bar line so the groove never stumbles. */
  private nextBar(): void {
    this.bar++;
    this.stage = this.pendingStage;
    this.showdown = this.pendingShowdown;
  }

  private bpm(): number {
    return this.showdown ? SHOWDOWN_BPM : (STAGE_BPM[this.stage] ?? STAGE_BPM[0]);
  }

  private stepDur(): number {
    return 60 / this.bpm() / 4;
  }

  private barDur(): number {
    return this.stepDur() * STEPS_PER_BAR;
  }

  private level(): number {
    return this.showdown ? STAGE_COUNT - 1 : this.stage;
  }

  private root(): number {
    const roots = this.showdown ? SHOWDOWN_ROOTS : CHORD_ROOTS;
    return roots[this.bar % roots.length] ?? 0;
  }

  private scheduleStep(rig: Rig, t: number): void {
    const level = this.level();
    this.rhythm(rig, t, level);
    if (level >= 1) this.bass(rig, t, level);
    if (level >= 2) this.clapStep(rig, t, level);
    if (level >= 2 && !this.showdown) this.arp(rig, t, level);
    if (level >= 3 && !this.showdown) this.stab(rig, t);
    if (level >= 4) this.atmosphere(rig, t);
  }

  private rhythm(rig: Rig, t: number, level: number): void {
    const s = this.step;
    if (s % 4 === 0) kick(rig, t, this.showdown);
    if (s % 4 === 2) {
      const sub = midiHz(ROOT_MIDI + this.root());
      tone(rig, { type: 'sine', freq: sub, t, dur: 0.22, peak: 0.5, attack: 0.01 });
    }
    if (level === 1 && s % 4 !== 2) return;
    if (level === 2 && s % 2 === 1) return;
    if (level >= 1) hat(rig, t, level >= 3 && s % 4 === 2, s % 2 === 1 ? 0.5 : 1);
  }

  private bass(rig: Rig, t: number, level: number): void {
    const s = this.step;
    const offset = this.showdown
      ? (BASS_DRIVE[s] ?? null)
      : ((level >= 2 ? BASS_BUSY : BASS_BASE)[s] ?? null);
    if (offset === null) return;
    const cutoff = 250 + (level / 4) * 1400;
    tone(rig, {
      type: 'sawtooth',
      freq: midiHz(ROOT_MIDI + this.root() + offset),
      t,
      dur: this.showdown ? this.stepDur() * 0.9 : 0.2,
      peak: s % 4 === 0 ? 0.2 : 0.32,
      cutoff: cutoff * 3,
      cutoffTo: cutoff,
    });
  }

  private clapStep(rig: Rig, t: number, level: number): void {
    const s = this.step;
    const fill = level >= 4 && this.bar % 4 === 3;
    if (fill && FILL_CLAPS.includes(s)) {
      clap(rig, t, 0.6 + Math.max(0, s - 10) * 0.08);
    } else if (!fill && (s === 4 || s === 12)) {
      clap(rig, t, 1);
    }
  }

  private arp(rig: Rig, t: number, level: number): void {
    const s = this.step;
    const bright = level / 4;
    tone(rig, {
      type: 'square',
      freq: midiHz(52 + this.root() + (ARP[s] ?? 0)),
      t,
      dur: 0.1,
      peak: s % 4 === 0 ? 0.09 : 0.06,
      cutoff: 800 + bright * 3200,
      cutoffTo: 400,
    });
  }

  private stab(rig: Rig, t: number): void {
    if (!STAB_STEPS.includes(this.step)) return;
    for (const interval of STAB_CHORD) {
      for (const detune of [-12, 12]) {
        tone(rig, {
          type: 'sawtooth',
          freq: midiHz(52 + this.root() + interval),
          detune,
          t,
          dur: 0.16,
          peak: 0.035,
          cutoff: 2600,
          cutoffTo: 600,
        });
      }
    }
  }

  /** Top layer: crash on each 4-bar phrase, bar-long pad, and a gliding lead on every 2nd bar. */
  private atmosphere(rig: Rig, t: number): void {
    if (this.step !== 0) return;
    if (this.bar > 0 && this.bar % 4 === 0) {
      noiseHit(rig, { t, dur: 1, peak: 0.22, filter: 'highpass', freq: 5000, attack: 0.005 });
    }
    if (this.showdown) {
      if (this.bar % 2 === 0) this.showdownLead(rig, t);
      return;
    }
    this.pad(rig, t);
    if (this.bar % 2 === 0) this.siren(rig, t);
  }

  private pad(rig: Rig, t: number): void {
    const dur = this.barDur() * 1.3;
    for (const interval of PAD_CHORD) {
      for (const detune of [-9, 9]) {
        tone(rig, {
          type: 'sawtooth', freq: midiHz(40 + this.root() + interval), detune,
          t, dur, peak: 0.03, attack: dur * 0.4, swell: true, cutoff: 1100,
        });
      }
    }
  }

  private siren(rig: Rig, t: number): void {
    const dur = this.barDur() * 1.9;
    const base = 76 + this.root();
    for (const detune of [-15, 15]) {
      tone(rig, {
        type: 'sawtooth', freq: midiHz(base), glideTo: midiHz(base + 1), detune,
        t, dur, peak: 0.03, attack: 0.3, swell: true, cutoff: 2500,
      });
    }
  }

  private showdownLead(rig: Rig, t: number): void {
    const dur = this.barDur() * 1.9;
    const base = 52 + this.root();
    for (const type of ['sawtooth', 'square'] as const) {
      tone(rig, {
        type, freq: midiHz(base), glideTo: midiHz(base + 1), detune: type === 'square' ? 14 : -14,
        t, dur, peak: 0.05, attack: 0.5, swell: true, cutoff: 700, cutoffTo: 1400,
      });
    }
  }

  /** Slow heart that quickens while the riser climbs. */
  private killcamStepDur(t: number): number {
    const progress = Math.min(1, Math.max(0, (t - this.killStart) / KILLCAM_S));
    return 0.17 - progress * 0.08;
  }

  private killcamStep(rig: Rig, t: number): void {
    const s = this.killStep % 8;
    if (s === 0) heartbeat(rig, t, 0.9);
    else if (s === 3) heartbeat(rig, t, 0.6);
  }
}
