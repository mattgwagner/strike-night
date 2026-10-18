// Synthesised sound effects. No asset files; everything is WebAudio.
// Every method no-ops until init() — that runs on the first click, from Game.resume.
import type { WeaponId } from '../../shared/constants';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  volume = 0.6;
  /** Quiet pad under the match. Default on; the pause menu can turn it off. */
  ambient = true;
  private amb: { oscs: OscillatorNode[]; lfo: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private heartOn = false;
  private heartTimer = 0;
  private heartGen = 0;

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    if (this.ambient) this.startAmbient();
    this.syncHeart();
  }

  /** Master gain. Safe before init(); the value is applied when the context exists. */
  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  /** Quiet synth pad. Safe before init(); remembered and started from init(). */
  setAmbient(on: boolean) {
    this.ambient = on;
    if (!this.ctx || !this.master) return;
    if (on) this.startAmbient();
    else this.stopAmbient();
  }

  /** Looping lub-dub while health is low and the player is still up. */
  setLowHealth(on: boolean) {
    if (this.heartOn === on) return;
    this.heartOn = on;
    this.syncHeart();
  }

  private startAmbient() {
    if (this.amb || !this.ctx || !this.master) return;
    const c = this.ctx;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    const gain = c.createGain();
    gain.gain.value = 0.045;
    const oscs: OscillatorNode[] = [];
    const notes: Array<[number, OscillatorType, number]> = [
      [55, 'sine', 0],
      [110, 'triangle', -6],
      [164.8, 'sine', 5],
    ];
    for (const [freq, type, detune] of notes) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(filter);
      o.start();
      oscs.push(o);
    }
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    filter.connect(gain).connect(this.master);
    this.amb = { oscs, lfo, gain, filter };
  }

  private stopAmbient() {
    const cur = this.amb;
    if (!cur) return;
    this.amb = null;
    for (const o of cur.oscs) { try { o.stop(); } catch { /* already stopped */ } o.disconnect(); }
    try { cur.lfo.stop(); } catch { /* already stopped */ }
    cur.lfo.disconnect();
    cur.gain.disconnect();
    cur.filter.disconnect();
  }

  private syncHeart() {
    const gen = ++this.heartGen;
    if (this.heartTimer) { clearInterval(this.heartTimer); this.heartTimer = 0; }
    if (!this.heartOn || !this.ctx || !this.master) return;
    const beat = () => {
      if (gen !== this.heartGen || !this.heartOn) return;
      this.thump(68, 0.2);
      window.setTimeout(() => { if (gen === this.heartGen && this.heartOn) this.thump(50, 0.14); }, 150);
    };
    beat();
    this.heartTimer = window.setInterval(beat, 900);
  }

  private thump(freq: number, gain: number) {
    this.tone(freq, 0.1, gain, 'sine', 0.55);
    this.noise(0.07, gain * 0.45, 160, 30, 0, 3);
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
    if (!this.ctx || !this.master || gain <= 0) return;
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
  hitmarker(head: boolean) { if (head) this.headshot(); else this.tone(1200, 0.06, 0.25, 'square', 0.8); }
  /** Short high sting. Game already calls hitmarker(true) when a headshot lands. */
  headshot() {
    this.tone(1568, 0.06, 0.18, 'square', 1.02);
    this.tone(2093, 0.08, 0.14, 'square', 1);
    this.tone(2637, 0.12, 0.1, 'sine', 1);
    this.noise(0.04, 0.1, 6400, 2200, 0, 4);
  }
  hurt() { this.noise(0.15, 0.4, 900, 100, 0, 2); this.tone(220, 0.15, 0.25, 'triangle', 0.5); }
  kill() { this.tone(660, 0.1, 0.25, 'square'); setTimeout(() => this.tone(990, 0.15, 0.25, 'square'), 90); }
  die() { this.tone(300, 0.6, 0.35, 'sawtooth', 0.25); this.noise(0.4, 0.4, 600, 50, 0, 1.5); }
  reload() { this.noise(0.05, 0.25, 4000, 1500, 0, 4); setTimeout(() => this.noise(0.05, 0.3, 3000, 1000, 0, 4), 350); setTimeout(() => this.tone(500, 0.05, 0.15, 'square'), 700); }
  switchWeapon() { this.noise(0.04, 0.2, 5000, 2000, 0, 4); }
  footstep() { this.noise(0.05, 0.08, 500, 80, 0, 3); }
  spawn() { this.tone(440, 0.1, 0.2, 'sine', 1.5); }
  matchStart() {
    this.noise(0.08, 0.16, 2400, 400, 0, 2);
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => setTimeout(() => {
      this.tone(f, i === notes.length - 1 ? 0.34 : 0.16, 0.2, 'square', 1);
      this.tone(f / 2, i === notes.length - 1 ? 0.4 : 0.2, 0.1, 'sawtooth', 1);
    }, 70 + i * 130));
  }
  matchOver() {
    const notes = [783.99, 659.25, 523.25, 392, 261.63];
    notes.forEach((f, i) => setTimeout(() => {
      this.tone(f, 0.32, 0.18, 'triangle', 0.82);
      this.tone(f / 2, 0.4, 0.07, 'sine', 0.9);
    }, i * 190));
    setTimeout(() => this.noise(0.45, 0.16, 320, 40, 0, 1.2), notes.length * 190);
  }
}
