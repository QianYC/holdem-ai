// Procedural casino-lounge BGM and sound effects with the Web Audio API (no audio files).
// Moods: 'lounge' (swing jazz, default), 'tense' (minor vamp when someone is all-in), 'off'.
// Browsers only allow audio after a user gesture, so start() must be called from a click/keydown.

const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);

const SONGS = {
  lounge: {
    bpm: 96,
    swing: 0.62,
    // Dm9 – G13 – Cmaj9 – A7(b9): a ii–V–I turnaround, two bars each chord pair.
    chords: [
      { root: 50, voicing: [53, 57, 60, 64] },
      { root: 43, voicing: [53, 57, 59, 64] },
      { root: 48, voicing: [52, 55, 59, 62] },
      { root: 45, voicing: [55, 58, 61, 64] },
    ],
    walk: [0, 3, 5, 7],
    melody: [
      [74, 72, null, 69, 72, null, 74, 76],
      [77, null, 76, 74, 71, null, 67, null],
      [76, 74, 72, null, 71, 72, 74, null],
      [73, null, 70, 69, 67, null, 64, null],
    ],
    drums: 'brush',
  },
  tense: {
    bpm: 118,
    swing: 0.5,
    // Am7 – Fmaj7 – Dm7 – E7: a darker minor vamp.
    chords: [
      { root: 45, voicing: [55, 60, 64, 67] },
      { root: 41, voicing: [57, 60, 64, 65] },
      { root: 50, voicing: [53, 57, 60, 65] },
      { root: 40, voicing: [56, 59, 62, 64] },
    ],
    walk: [0, 0, 7, 0],
    melody: [
      [76, null, null, 72, 74, null, 76, null],
      [77, null, 76, null, 72, null, 69, null],
      [74, null, 72, 74, 77, null, 76, null],
      [76, 75, 76, null, 71, null, 68, null],
    ],
    drums: 'pulse',
  },
};

export function createAudio() {
  let ctx = null;
  let master;
  let musicBus;
  let sfxBus;
  let noiseBuf;
  let mood = 'lounge';
  let timer = null;
  let nextTime = 0;
  let step = 0;
  let enabled = localStorage.getItem('holdem.bgm') !== 'off';
  let volume = Number(localStorage.getItem('holdem.volume') ?? 0.5);

  function init() {
    if (ctx) return;
    ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    master = ctx.createGain();
    master.gain.value = volume;
    musicBus = ctx.createGain();
    musicBus.gain.value = enabled ? 0.55 : 0;
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.9;
    // A little room: feedback delay as a cheap reverb on the music.
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.23;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    musicBus.connect(master);
    musicBus.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    lp.connect(wet);
    wet.connect(master);
    sfxBus.connect(master);
    master.connect(comp);
    comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  function env(g, t, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function tone(freq, t, dur, { type = 'sine', peak = 0.2, attack = 0.01, bus = musicBus, detune = 0, filter } = {}) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    const g = ctx.createGain();
    env(g, t, attack, peak, dur);
    let node = o;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      o.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // Electric-piano-ish note: sine body + soft triangle bell.
  function epiano(n, t, dur, peak = 0.06) {
    tone(NOTE(n), t, dur, { type: 'sine', peak, attack: 0.005 });
    tone(NOTE(n) * 2, t, dur * 0.5, { type: 'triangle', peak: peak * 0.25, attack: 0.002 });
  }

  function noise(t, dur, { freq = 6000, q = 0.8, peak = 0.05, type = 'highpass', bus = musicBus } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    env(g, t, 0.003, peak, dur);
    src.connect(f);
    f.connect(g);
    g.connect(bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  function kick(t, peak = 0.35) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.15);
    env(g, t, 0.003, peak, 0.22);
    o.connect(g);
    g.connect(musicBus);
    o.start(t);
    o.stop(t + 0.3);
  }

  // One step = one eighth note. 8 steps per bar, 2 bars per chord, 4 chords per loop.
  function scheduleStep(t, beatDur) {
    const song = SONGS[mood];
    const bar = Math.floor(step / 8);
    const chord = song.chords[Math.floor(bar / 2) % song.chords.length];
    const pos = step % 8;
    const onBeat = pos % 2 === 0;
    const swingDelay = onBeat ? 0 : beatDur * (song.swing - 0.5) * 2;
    const tt = t + swingDelay;
    // Comping: chord stabs on beat 1 and the "and" of 2.
    if (pos === 0 || pos === 3) for (const n of chord.voicing) epiano(n, tt, beatDur * (pos === 0 ? 3 : 1.6), 0.035);
    // Walking / pulsing bass on quarter notes.
    if (onBeat) {
      const q = pos / 2;
      const n = chord.root + song.walk[q] + (bar % 2 && q === 3 ? -1 : 0);
      tone(NOTE(n), t, beatDur * 1.8, { type: 'triangle', peak: 0.16, attack: 0.01, filter: 900 });
    }
    // Sparse melody on the second bar of each chord.
    if (bar % 2 === 1) {
      const line = song.melody[Math.floor(bar / 2) % song.melody.length];
      const n = line[pos];
      if (n && Math.random() < 0.85) epiano(n + 12 * 0, tt, beatDur * 1.6, 0.05);
    }
    // Drums.
    if (song.drums === 'brush') {
      noise(tt, onBeat ? 0.12 : 0.06, { freq: 7000, peak: onBeat ? 0.018 : 0.03 });
      if (pos === 2 || pos === 6) noise(t, 0.18, { freq: 2500, type: 'bandpass', q: 0.6, peak: 0.025 });
      if (pos === 0 && bar % 2 === 0) kick(t, 0.18);
    } else {
      noise(tt, 0.05, { freq: 8000, peak: 0.025 });
      if (pos === 0 || pos === 4) kick(t, 0.32);
      if (pos === 2 || pos === 6) noise(t, 0.15, { freq: 1800, type: 'bandpass', q: 0.7, peak: 0.05 });
    }
    step = (step + 1) % (8 * 2 * song.chords.length);
  }

  function tick() {
    const beatDur = 60 / SONGS[mood].bpm / 2;
    while (nextTime < ctx.currentTime + 0.15) {
      scheduleStep(nextTime, beatDur);
      nextTime += beatDur;
    }
  }

  function startLoop() {
    if (timer || !enabled) return;
    nextTime = ctx.currentTime + 0.1;
    timer = setInterval(tick, 25);
  }

  function stopLoop() {
    clearInterval(timer);
    timer = null;
  }

  const api = {
    get enabled() {
      return enabled;
    },
    get volume() {
      return volume;
    },
    // Call from a user gesture.
    start() {
      init();
      if (ctx.state === 'suspended') ctx.resume();
      startLoop();
    },
    toggle() {
      enabled = !enabled;
      localStorage.setItem('holdem.bgm', enabled ? 'on' : 'off');
      api.start();
      musicBus.gain.setTargetAtTime(enabled ? 0.55 : 0, ctx.currentTime, 0.2);
      if (!enabled) setTimeout(() => !enabled && stopLoop(), 600);
      return enabled;
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      localStorage.setItem('holdem.volume', String(volume));
      if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
    },
    setMood(m) {
      if (!SONGS[m] || m === mood) return;
      mood = m;
      step = 0;
    },
    get ready() {
      return Boolean(ctx && ctx.state === 'running');
    },
    sfx(name) {
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime + 0.01;
      const b = { bus: sfxBus };
      switch (name) {
        case 'chips':
          for (let i = 0; i < 4; i++) noise(t + i * 0.045 + Math.random() * 0.02, 0.05, { freq: 3500 + Math.random() * 2500, type: 'bandpass', q: 6, peak: 0.12, ...b });
          break;
        case 'allin':
          for (let i = 0; i < 12; i++) noise(t + i * 0.03 + Math.random() * 0.02, 0.06, { freq: 3000 + Math.random() * 3000, type: 'bandpass', q: 5, peak: 0.14, ...b });
          tone(NOTE(45), t, 0.8, { type: 'sawtooth', peak: 0.08, filter: 500, ...b });
          break;
        case 'card':
          noise(t, 0.08, { freq: 2200, type: 'bandpass', q: 0.9, peak: 0.12, ...b });
          break;
        case 'deal':
          for (let i = 0; i < 4; i++) noise(t + i * 0.09, 0.07, { freq: 2400, type: 'bandpass', q: 0.9, peak: 0.1, ...b });
          break;
        case 'fold':
          noise(t, 0.15, { freq: 900, type: 'lowpass', q: 0.5, peak: 0.08, ...b });
          break;
        case 'check':
          tone(180, t, 0.06, { type: 'square', peak: 0.05, filter: 1200, ...b });
          tone(180, t + 0.09, 0.06, { type: 'square', peak: 0.05, filter: 1200, ...b });
          break;
        case 'chat':
          tone(NOTE(81), t, 0.08, { type: 'sine', peak: 0.07, ...b });
          tone(NOTE(88), t + 0.06, 0.12, { type: 'sine', peak: 0.06, ...b });
          break;
        case 'turn':
          tone(NOTE(84), t, 0.35, { type: 'sine', peak: 0.12, ...b });
          tone(NOTE(91), t + 0.12, 0.45, { type: 'sine', peak: 0.1, ...b });
          break;
        case 'win':
          [72, 76, 79, 84, 88].forEach((n, i) => tone(NOTE(n), t + i * 0.08, 0.5, { type: 'triangle', peak: 0.1, ...b }));
          for (let i = 0; i < 10; i++) noise(t + 0.3 + i * 0.04, 0.05, { freq: 4000 + Math.random() * 2000, type: 'bandpass', q: 6, peak: 0.08, ...b });
          break;
        case 'lose':
          [64, 63, 62, 59].forEach((n, i) => tone(NOTE(n), t + i * 0.22, 0.5, { type: 'sawtooth', peak: 0.05, filter: 1400, ...b }));
          break;
        case 'knockout':
          [76, 79, 83, 88, 91, 95].forEach((n, i) => tone(NOTE(n), t + i * 0.06, 0.6, { type: 'sine', peak: 0.09, ...b }));
          tone(NOTE(52), t, 1.2, { type: 'triangle', peak: 0.12, ...b });
          break;
        case 'gameover':
          [67, 66, 65, 64, 52].forEach((n, i) => tone(NOTE(n), t + i * 0.35, i === 4 ? 1.6 : 0.4, { type: 'sawtooth', peak: 0.07, filter: 1100, ...b }));
          break;
        case 'victory':
          [60, 64, 67, 72, 67, 72, 76, 79, 84].forEach((n, i) => tone(NOTE(n), t + i * 0.1, i === 8 ? 1.2 : 0.3, { type: 'triangle', peak: 0.1, ...b }));
          break;
        default:
      }
    },
  };
  return api;
}
