// Procedural SFX with the Web Audio API. No asset files (PRD §9): every sound is
// synthesized at runtime from oscillators + pre-baked noise buffers. Audio is
// strictly non-critical — every public method is a safe no-op if Web Audio is
// missing or the context died, so a failure here never breaks the game.
//
// One AudioContext (suspended until a user gesture per the autoplay policy) feeds
// a master GainNode -> destination. 2D sounds (own weapons, UI) route straight to
// master; positional world events route through a short-lived PannerNode placed at
// a world position so they pan/attenuate relative to the camera.

import type { WeaponSlot } from '@rivals/shared';

type Vec = { x: number; y: number; z: number };

// PannerNode tuning — shared by every positional one-shot.
const PANNER_REF_DISTANCE = 5;
const PANNER_MAX_DISTANCE = 40;
const PANNER_ROLLOFF = 1;

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _masterVolume = 0.6;

  // Pre-baked noise buffers, reused across every sound (cheap; nodes are per-shot).
  private whiteNoise: AudioBuffer | null = null;
  private pinkNoise: AudioBuffer | null = null;

  constructor() {
    // Lazily safe: if anything throws (no Web Audio, locked-down browser), we keep
    // ctx === null and every method below early-returns into a no-op.
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;

      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._masterVolume;
      this.master.connect(this.ctx.destination);

      this.whiteNoise = this.makeNoise(0.6, false);
      this.pinkNoise = this.makeNoise(0.6, true);
    } catch {
      this.ctx = null;
      this.master = null;
    }
  }

  /** Resume the context — call on the first user gesture (pointer-lock click). Idempotent. */
  resume(): void {
    try {
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      /* non-critical */
    }
  }

  setMasterVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v));
    this._masterVolume = clamped;
    try {
      if (this.master && this.ctx) {
        this.master.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
      }
    } catch {
      /* non-critical */
    }
  }

  get masterVolume(): number {
    return this._masterVolume;
  }

  /** Place the listener so positional sounds pan/attenuate. Called each render frame. */
  updateListener(pos: Vec, forward: Vec, up: Vec): void {
    if (!this.ctx) return;
    try {
      const l = this.ctx.listener;
      const t = this.ctx.currentTime;
      // Newer browsers expose AudioParams; older WebKit only the deprecated setters.
      if (l.positionX) {
        l.positionX.setValueAtTime(pos.x, t);
        l.positionY.setValueAtTime(pos.y, t);
        l.positionZ.setValueAtTime(pos.z, t);
        l.forwardX.setValueAtTime(forward.x, t);
        l.forwardY.setValueAtTime(forward.y, t);
        l.forwardZ.setValueAtTime(forward.z, t);
        l.upX.setValueAtTime(up.x, t);
        l.upY.setValueAtTime(up.y, t);
        l.upZ.setValueAtTime(up.z, t);
      } else {
        // Deprecated fallback path.
        const ld = l as unknown as {
          setPosition(x: number, y: number, z: number): void;
          setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
        };
        ld.setPosition(pos.x, pos.y, pos.z);
        ld.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    } catch {
      /* non-critical */
    }
  }

  // ---------------------------------------------------------------------------
  // 2D sounds (own weapons + UI) — route to master gain only, no panner.
  // ---------------------------------------------------------------------------

  shoot(slot: WeaponSlot): void {
    this.guard((ctx, dest) => this.shootInto(ctx, dest, slot));
  }

  reload(): void {
    // Mechanical double-tick: two short band-limited noise clicks.
    this.guard((ctx, dest) => {
      const t = ctx.currentTime;
      this.noiseClick(ctx, dest, t, 0.03, 1800, 0.22);
      this.noiseClick(ctx, dest, t + 0.08, 0.04, 1200, 0.28);
    });
  }

  hitmarker(): void {
    // Short high tick — crisp positive feedback.
    this.guard((ctx, dest) => {
      const t = ctx.currentTime;
      this.blip(ctx, dest, t, 2400, 2600, 0.05, 0.3, 'square');
    });
  }

  jump(): void {
    this.guard((ctx, dest) => {
      const t = ctx.currentTime;
      this.blip(ctx, dest, t, 320, 560, 0.08, 0.14, 'triangle');
    });
  }

  land(): void {
    // Soft thud: low sine thump + a touch of filtered noise.
    this.guard((ctx, dest) => {
      const t = ctx.currentTime;
      this.blip(ctx, dest, t, 160, 70, 0.12, 0.22, 'sine');
      this.noiseClick(ctx, dest, t, 0.06, 500, 0.12);
    });
  }

  slideStart(): void {
    // Filtered-noise scrape: bandpass pink noise sweeping down.
    this.guard((ctx, dest) => {
      const t = ctx.currentTime;
      const src = this.noiseSource(ctx, true);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 2;
      bp.frequency.setValueAtTime(2600, t);
      bp.frequency.exponentialRampToValueAtTime(700, t + 0.28);
      const g = ctx.createGain();
      this.envelope(g.gain, t, 0.18, 0.3, 0.01);
      src.connect(bp).connect(g).connect(dest);
      src.start(t);
      src.stop(t + 0.32);
    });
  }

  roundStart(): void {
    // Rising two-tone sting.
    this.guard((ctx, dest) => {
      const t = ctx.currentTime;
      this.tone(ctx, dest, t, 440, 0.16, 0.26, 'triangle');
      this.tone(ctx, dest, t + 0.14, 660, 0.22, 0.26, 'triangle');
    });
  }

  roundEnd(youWon: boolean): void {
    this.guard((ctx, dest) => {
      const t = ctx.currentTime;
      if (youWon) {
        // Major arpeggio C-E-G-C.
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => this.tone(ctx, dest, t + i * 0.1, f, 0.18, 0.24, 'triangle'));
      } else {
        // Falling tone.
        this.glide(ctx, dest, t, 440, 150, 0.5, 0.26, 'sawtooth');
      }
    });
  }

  kill(): void {
    // Sharp sting: bright square stab with a fast pitch drop.
    this.guard((ctx, dest) => {
      const t = ctx.currentTime;
      this.blip(ctx, dest, t, 900, 1300, 0.04, 0.32, 'square');
      this.glide(ctx, dest, t, 1300, 500, 0.14, 0.22, 'square');
    });
  }

  // ---------------------------------------------------------------------------
  // Positional sounds — route through a per-shot PannerNode at a world pos.
  // ---------------------------------------------------------------------------

  shootAt(slot: WeaponSlot, pos: Vec): void {
    this.guardAt(pos, (ctx, dest) => this.shootInto(ctx, dest, slot));
  }

  explosionAt(pos: Vec): void {
    this.guardAt(pos, (ctx, dest) => {
      const t = ctx.currentTime;
      // Big noise burst through a downward-sweeping lowpass; pink gives a fuller body.
      const src = this.noiseSource(ctx, true);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2000, t);
      lp.frequency.exponentialRampToValueAtTime(200, t + 0.4);
      const ng = ctx.createGain();
      this.envelope(ng.gain, t, 0.9, 0.45, 0.005);
      src.connect(lp).connect(ng).connect(dest);
      src.start(t);
      src.stop(t + 0.5);

      // Low sine boom with a fast pitch decay.
      this.glide(ctx, dest, t, 120, 40, 0.45, 0.7, 'sine');
    });
  }

  footstepAt(pos: Vec): void {
    this.guardAt(pos, (ctx, dest) => {
      const t = ctx.currentTime;
      this.noiseClick(ctx, dest, t, 0.05, 900, 0.18);
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Run a sound builder against a live, resumed-or-suspended context routed to master. */
  private guard(build: (ctx: AudioContext, dest: AudioNode) => void): void {
    if (!this.ctx || !this.master) return;
    try {
      build(this.ctx, this.master);
    } catch {
      /* non-critical */
    }
  }

  /** Same, but inserts a PannerNode at `pos` between the sound and master. */
  private guardAt(pos: Vec, build: (ctx: AudioContext, dest: AudioNode) => void): void {
    if (!this.ctx || !this.master) return;
    try {
      const panner = this.makePanner(this.ctx, pos);
      panner.connect(this.master);
      build(this.ctx, panner);
    } catch {
      /* non-critical */
    }
  }

  private makePanner(ctx: AudioContext, pos: Vec): PannerNode {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = PANNER_REF_DISTANCE;
    p.maxDistance = PANNER_MAX_DISTANCE;
    p.rolloffFactor = PANNER_ROLLOFF;
    const t = ctx.currentTime;
    if (p.positionX) {
      p.positionX.setValueAtTime(pos.x, t);
      p.positionY.setValueAtTime(pos.y, t);
      p.positionZ.setValueAtTime(pos.z, t);
    } else {
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
    }
    return p;
  }

  /** Per-slot weapon timbre, shared by 2D shoot() and positional shootAt(). */
  private shootInto(ctx: AudioContext, dest: AudioNode, slot: WeaponSlot): void {
    const t = ctx.currentTime;
    switch (slot) {
      case 1: {
        // AR — tight click: short noise through a high-ish lowpass + a snap transient.
        const src = this.noiseSource(ctx);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(4000, t);
        lp.frequency.exponentialRampToValueAtTime(1200, t + 0.05);
        const g = ctx.createGain();
        this.envelope(g.gain, t, 0.4, 0.07, 0.002);
        src.connect(lp).connect(g).connect(dest);
        src.start(t);
        src.stop(t + 0.08);
        this.blip(ctx, dest, t, 220, 90, 0.04, 0.18, 'square');
        break;
      }
      case 2: {
        // Rocket — deep whoosh: noise through a rising bandpass + low sine swell.
        const src = this.noiseSource(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 0.8;
        bp.frequency.setValueAtTime(300, t);
        bp.frequency.exponentialRampToValueAtTime(1400, t + 0.3);
        const g = ctx.createGain();
        this.envelope(g.gain, t, 0.5, 0.35, 0.02);
        src.connect(bp).connect(g).connect(dest);
        src.start(t);
        src.stop(t + 0.4);
        this.glide(ctx, dest, t, 180, 90, 0.3, 0.22, 'sine');
        break;
      }
      case 3: {
        // Knife — swipe: fast bandpass-noise sweep upward, very short.
        const src = this.noiseSource(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.5;
        bp.frequency.setValueAtTime(800, t);
        bp.frequency.exponentialRampToValueAtTime(3500, t + 0.12);
        const g = ctx.createGain();
        this.envelope(g.gain, t, 0.35, 0.14, 0.005);
        src.connect(bp).connect(g).connect(dest);
        src.start(t);
        src.stop(t + 0.16);
        break;
      }
      case 4:
      default: {
        // Grenade throw — thunk: low triangle thump + soft noise.
        this.blip(ctx, dest, t, 200, 80, 0.1, 0.26, 'triangle');
        this.noiseClick(ctx, dest, t, 0.05, 600, 0.14);
        break;
      }
    }
  }

  // --- Small synthesis primitives -------------------------------------------

  /** A tone at fixed frequency. */
  private tone(
    ctx: AudioContext,
    dest: AudioNode,
    t: number,
    freq: number,
    dur: number,
    peak: number,
    type: OscillatorType,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    this.envelope(g.gain, t, peak, dur, Math.min(0.01, dur * 0.2));
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A tone with an exponential pitch ramp from f0 to f1. */
  private blip(
    ctx: AudioContext,
    dest: AudioNode,
    t: number,
    f0: number,
    f1: number,
    dur: number,
    peak: number,
    type: OscillatorType,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    this.envelope(g.gain, t, peak, dur, Math.min(0.005, dur * 0.2));
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Like blip but a longer glide (separate name purely for readability). */
  private glide(
    ctx: AudioContext,
    dest: AudioNode,
    t: number,
    f0: number,
    f1: number,
    dur: number,
    peak: number,
    type: OscillatorType,
  ): void {
    this.blip(ctx, dest, t, f0, f1, dur, peak, type);
  }

  /** A short lowpassed noise click. */
  private noiseClick(
    ctx: AudioContext,
    dest: AudioNode,
    t: number,
    dur: number,
    cutoff: number,
    peak: number,
  ): void {
    const src = this.noiseSource(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    this.envelope(g.gain, t, peak, dur, 0.001);
    src.connect(lp).connect(g).connect(dest);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** A noise BufferSource reading a pre-baked buffer (white by default, pink for body). */
  private noiseSource(ctx: AudioContext, pink = false): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = pink ? this.pinkNoise : this.whiteNoise;
    return src;
  }

  /** Fast linear attack + exponential-ish decay to ~silence over `dur`. */
  private envelope(param: AudioParam, t: number, peak: number, dur: number, attack: number): void {
    const a = Math.max(0.0005, attack);
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  /** Build a mono noise buffer. `pink` low-passes white for a softer spectrum. */
  private makeNoise(seconds: number, pink: boolean): AudioBuffer | null {
    if (!this.ctx) return null;
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    if (!pink) {
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } else {
      // Cheap pink-ish noise (Paul Kellet's economical filter).
      let b0 = 0,
        b1 = 0,
        b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
      }
    }
    return buf;
  }
}
