// Synthesised sound effects. No asset files; everything is WebAudio.
import type { WeaponId } from '../../shared/constants';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  volume = 0.6;

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }

  private noise(dur: number, gain: number, lp: number, hp = 0, pan = 0, decay = 1) {
    if (!this.ctx || !this.master) return;
    const c = this.ctx;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, decay);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
    const h = c.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp;
    const g = c.createGain(); g.gain.value = gain;
    const p = c.createStereoPanner(); p.pan.value = pan;
    src.connect(f).connect(h).connect(g).connect(p).connect(this.master);
    src.start();
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', slide = 1, pan = 0) {
    if (!this.ctx || !this.master) return;
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), c.currentTime + dur);
    const g = c.createGain(); g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    const p = c.createStereoPanner(); p.pan.value = pan;
    o.connect(g).connect(p).connect(this.master);
    o.start(); o.stop(c.currentTime + dur);
  }

  shot(w: WeaponId, distance = 0, pan = 0) {
    const att = 1 / (1 + distance * 0.06);
    switch (w) {
      case 'knife': this.noise(0.08, 0.3 * att, 3000, 800, pan, 2); break;
      case 'pistol': this.noise(0.12, 0.5 * att, 2500, 200, pan, 3); this.tone(180, 0.08, 0.3 * att, 'square', 0.4, pan); break;
      case 'rifle': this.noise(0.1, 0.55 * att, 3500, 300, pan, 3); this.tone(140, 0.07, 0.35 * att, 'sawtooth', 0.3, pan); break;
      case 'shotgun': this.noise(0.25, 0.8 * att, 1800, 80, pan, 2); this.tone(90, 0.18, 0.5 * att, 'square', 0.3, pan); break;
      case 'sniper': this.noise(0.35, 0.8 * att, 1500, 60, pan, 1.5); this.tone(110, 0.3, 0.45 * att, 'sawtooth', 0.2, pan); break;
    }
  }
  hitmarker(head: boolean) { this.tone(head ? 1800 : 1200, 0.06, 0.25, 'square', 0.8); if (head) this.tone(2400, 0.08, 0.15, 'sine', 1.2); }
  hurt() { this.noise(0.15, 0.4, 900, 100, 0, 2); this.tone(220, 0.15, 0.25, 'triangle', 0.5); }
  kill() { this.tone(660, 0.1, 0.25, 'square'); setTimeout(() => this.tone(990, 0.15, 0.25, 'square'), 90); }
  die() { this.tone(300, 0.6, 0.35, 'sawtooth', 0.25); this.noise(0.4, 0.4, 600, 50, 0, 1.5); }
  reload() { this.noise(0.05, 0.25, 4000, 1500, 0, 4); setTimeout(() => this.noise(0.05, 0.3, 3000, 1000, 0, 4), 350); setTimeout(() => this.tone(500, 0.05, 0.15, 'square'), 700); }
  switchWeapon() { this.noise(0.04, 0.2, 5000, 2000, 0, 4); }
  footstep() { this.noise(0.05, 0.08, 500, 80, 0, 3); }
  spawn() { this.tone(440, 0.1, 0.2, 'sine', 1.5); }
  matchStart() { [0, 150, 300].forEach((d, i) => setTimeout(() => this.tone(440 * (i === 2 ? 2 : 1), 0.2, 0.3, 'square'), d)); }
  matchOver() { [0, 200, 400, 600].forEach((d, i) => setTimeout(() => this.tone(880 - i * 120, 0.25, 0.3, 'square'), d)); }
}
