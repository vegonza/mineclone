/**
 * All sound effects are synthesised at runtime with the Web Audio API —
 * filtered noise bursts and short tonal blips, shaped per material.
 */
const MATERIALS = {
  stone: { base: 260, noise: 0.75, decay: 0.11, q: 1.2, gain: 0.5 },
  gravel: { base: 190, noise: 1.0, decay: 0.13, q: 0.6, gain: 0.45 },
  sand: { base: 150, noise: 1.0, decay: 0.16, q: 0.4, gain: 0.34 },
  wood: { base: 380, noise: 0.55, decay: 0.1, q: 2.4, gain: 0.5 },
  grass: { base: 300, noise: 0.95, decay: 0.12, q: 0.7, gain: 0.35 },
  glass: { base: 1400, noise: 0.5, decay: 0.09, q: 5, gain: 0.4 },
  wool: { base: 180, noise: 0.9, decay: 0.1, q: 0.5, gain: 0.28 },
  snow: { base: 210, noise: 1.0, decay: 0.1, q: 0.5, gain: 0.3 },
  water: { base: 420, noise: 0.9, decay: 0.18, q: 1.5, gain: 0.3 },
};

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.muted = false;
    this._lastStep = 0;
  }

  /** Must be called from a user gesture. */
  resume() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this._makeNoise(1.0);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _makeNoise(seconds) {
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.floor(rate * seconds), rate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      // Mildly brown-ish noise: smoother, less hissy than pure white.
      const white = Math.random() * 2 - 1;
      last = (last + 0.04 * white) / 1.04;
      data[i] = last * 3.2 + white * 0.35;
    }
    return buf;
  }

  _burst({ material = 'stone', pitch = 1, gain = 1, decay = null, filterType = 'bandpass' }) {
    if (!this.ctx || this.muted) return;
    const m = MATERIALS[material] ?? MATERIALS.stone;
    const t = this.ctx.currentTime;
    const dur = decay ?? m.decay;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;

    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = m.base * pitch * (0.9 + Math.random() * 0.2);
    filter.Q.value = m.q;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(m.gain * gain * m.noise, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(filter).connect(env).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);

    // A soft tonal body under the noise gives each material its character.
    if (m.noise < 1) {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(m.base * pitch * 1.1, t);
      osc.frequency.exponentialRampToValueAtTime(m.base * pitch * 0.6, t + dur);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(m.gain * gain * (1 - m.noise) * 0.6, t + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(og).connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }

  breakBlock(material) {
    this._burst({ material, pitch: 0.85, gain: 1.15, decay: 0.22 });
  }

  placeBlock(material) {
    this._burst({ material, pitch: 1.15, gain: 0.9, decay: 0.1 });
  }

  footstep(material) {
    const now = performance.now();
    if (now - this._lastStep < 120) return;
    this._lastStep = now;
    this._burst({ material, pitch: 0.7 + Math.random() * 0.1, gain: 0.42, decay: 0.075, filterType: 'lowpass' });
  }

  splash() {
    this._burst({ material: 'water', pitch: 1, gain: 1.1, decay: 0.3, filterType: 'lowpass' });
  }

  click() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.07);
  }
}
