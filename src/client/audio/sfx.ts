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

  /** Marker shots: a puff of air and a soft pop, not a bang. */
  shot(w: WeaponId, distance = 0, pan = 0) {
    const att = 1 / (1 + distance * 0.06);
    switch (w) {
      case 'tag': this.noise(0.1, 0.3 * att, 2600, 500, pan, 2); this.tone(140, 0.05, 0.2 * att, 'triangle', 0.6, pan); break;
      case 'pistol': this.noise(0.06, 0.38 * att, 2200, 300, pan, 3); this.tone(260, 0.05, 0.2 * att, 'triangle', 0.5, pan); break;
      case 'semi': this.noise(0.07, 0.45 * att, 2600, 250, pan, 3); this.tone(200, 0.06, 0.28 * att, 'triangle', 0.45, pan); break;
      case 'auto': this.noise(0.06, 0.4 * att, 2800, 300, pan, 3); this.tone(220, 0.05, 0.22 * att, 'triangle', 0.5, pan); break;
      case 'pump':
        this.noise(0.12, 0.55 * att, 1800, 150, pan, 2); this.tone(150, 0.1, 0.35 * att, 'triangle', 0.4, pan);
        // rack the pump
        setTimeout(() => this.noise(0.05, 0.22 * att, 4000, 1500, pan, 4), 330);
        setTimeout(() => this.noise(0.05, 0.26 * att, 3200, 1000, pan, 4), 480);
        break;
    }
  }

  // ----- grenades -----
  /** Your own throw: a short whoosh. */
  nadeThrow(distance = 0, pan = 0) {
    const att = 1 / (1 + distance * 0.08);
    this.noise(0.18, 0.25 * att, 1800, 400, pan, 1.5);
    this.tone(520, 0.14, 0.05 * att, 'sine', 0.6, pan);
  }
  /** A grenade hits a wall or the floor. */
  nadeBounce(distance = 0, pan = 0) {
    const att = 1 / (1 + distance * 0.1);
    if (att < 0.08) return;
    this.tone(330, 0.05, 0.22 * att, 'triangle', 0.6, pan);
    this.noise(0.03, 0.18 * att, 2500, 600, pan, 4);
  }
  /** Paint grenade bursts: a wet thump and a spray. */
  paintBurst(distance = 0, pan = 0) {
    const att = 1 / (1 + distance * 0.05);
    this.tone(120, 0.22, 0.45 * att, 'sine', 0.45, pan);
    this.noise(0.32, 0.6 * att, 1400, 60, pan, 2);
    setTimeout(() => this.noise(0.4, 0.22 * att, 5200, 1600, pan, 1.6), 40);
  }
  /** Smoke pops and hisses for a couple of seconds. */
  smokeHiss(distance = 0, pan = 0) {
    const att = 1 / (1 + distance * 0.05);
    this.tone(180, 0.08, 0.2 * att, 'square', 0.5, pan);
    this.noise(2.4, 0.2 * att, 6000, 1800, pan, 0.7);
  }
  hitmarker(head: boolean) { if (head) this.headshot(); else this.tone(1200, 0.06, 0.25, 'square', 0.8); }
  /** Short high sting. Game already calls hitmarker(true) when a head mark lands. */
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
