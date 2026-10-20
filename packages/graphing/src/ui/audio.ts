// The sound trace (slice 8): short notes while tracing a curve with the
// keyboard, and the whole curve played left to right. Web Audio only — an
// oscillator, a gain and a stereo panner; nothing is fetched. The context is
// made on the first sound the student asks for and never before (D-2: no
// `AudioContext` at load), and any failure leaves the graph silent rather
// than broken.

import type { Tone } from "../engine/summary";

type Ctx = AudioContext;

const VOLUME = 0.15;

export class Tones {
  private ctx: Ctx | null = null;
  private failed = false;
  private playing: (() => void) | null = null;

  /** False once Web Audio has been found missing or broken here. */
  get available(): boolean {
    return !this.failed;
  }

  private context(): Ctx | null {
    if (this.ctx) return this.ctx;
    if (this.failed) return null;
    try {
      const C =
        (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) throw new Error("no Web Audio");
      this.ctx = new C();
      return this.ctx;
    } catch {
      this.failed = true;
      return null;
    }
  }

  /** The output chain: oscillator → gain → panner (when there is one) → speakers. */
  private chain(ctx: Ctx): { osc: OscillatorNode; gain: GainNode; pan: StereoPannerNode | null } {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    let pan: StereoPannerNode | null = null;
    if (typeof ctx.createStereoPanner === "function") {
      pan = ctx.createStereoPanner();
      gain.connect(pan);
      pan.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    return { osc, gain, pan };
  }

  /** One short note; a null tone is a soft click-free silence. Returns false if silent here. */
  note(tone: Tone, seconds = 0.12): boolean {
    const ctx = this.context();
    if (!ctx) return false;
    try {
      this.stop();
      ctx.resume?.()?.catch(() => {});
      if (tone.freq === null) return true;
      const { osc, gain, pan } = this.chain(ctx);
      const t0 = ctx.currentTime;
      osc.frequency.setValueAtTime(tone.freq, t0);
      pan?.pan.setValueAtTime(tone.pan, t0);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(VOLUME, t0 + 0.01);
      gain.gain.setValueAtTime(VOLUME, t0 + seconds - 0.02);
      gain.gain.linearRampToValueAtTime(0, t0 + seconds);
      osc.start(t0);
      osc.stop(t0 + seconds + 0.01);
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  /** Plays the tones evenly over `seconds`; `onEnd` runs when it finishes or is stopped. */
  sweep(tones: Tone[], seconds = 3, onEnd?: () => void): boolean {
    const ctx = this.context();
    if (!ctx || !tones.length) return false;
    try {
      this.stop();
      ctx.resume?.()?.catch(() => {});
      const { osc, gain, pan } = this.chain(ctx);
      const t0 = ctx.currentTime + 0.05;
      const dt = seconds / tones.length;
      let on = false;
      tones.forEach((tone, k) => {
        const t = t0 + k * dt;
        pan?.pan.setValueAtTime(tone.pan, t);
        if (tone.freq === null) {
          if (on) gain.gain.setTargetAtTime(0, t, 0.005);
          on = false;
          return;
        }
        osc.frequency.setValueAtTime(tone.freq, t);
        if (!on) gain.gain.setTargetAtTime(VOLUME, t, 0.005);
        on = true;
      });
      gain.gain.setTargetAtTime(0, t0 + seconds, 0.01);
      osc.start(t0);
      osc.stop(t0 + seconds + 0.1);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.playing === stop) this.playing = null;
        onEnd?.();
      };
      const stop = () => {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
        finish();
      };
      osc.onended = finish;
      // A context the page can't start (no user gesture, audio blocked) never
      // fires onended; the sweep still ends on time.
      setTimeout(finish, (seconds + 0.5) * 1000);
      this.playing = stop;
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  get busy(): boolean {
    return this.playing !== null;
  }

  stop(): void {
    const p = this.playing;
    this.playing = null;
    p?.();
  }

  close(): void {
    this.stop();
    void this.ctx?.close?.().catch(() => {});
    this.ctx = null;
  }
}
