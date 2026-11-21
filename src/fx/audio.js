/**
 * Procedural Web Audio Engine & iPadOS Safari SFX Synthesizer (Contract #9).
 *
 * - Zero external audio files (100% Web Audio API synthesis + pre-allocated
 *   white/pink noise buffers).
 * - Safe no-op before first user-gesture unlock() and after dispose().
 * - Handles Safari 'suspended' and 'interrupted' AudioContext states plus
 *   1-sample silent buffer unlock synchronously inside gesture handlers.
 * - Master DynamicsCompressorNode limiter, per-effect cooldown throttling,
 *   and MAX_ACTIVE_VOICES cap to prevent distortion or WebKit audio stalls.
 */

const MAX_ACTIVE_VOICES = 14;
const MASTER_GAIN_DEFAULT = 0.85;

const COOLDOWNS_MS = Object.freeze({
  crash: 75,
  glass: 90,
  crush: 180,
  hammer: 220,
  shredder: 110,
  train: 600,
  explosion: 160,
  cash: 55,
  trick: 85,
  horn: 220,
  button: 35,
});

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function finiteOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function createNoiseBuffers(ctx) {
  const sampleRate = ctx.sampleRate || 44100;
  const length = Math.max(1, Math.floor(sampleRate * 1.5));

  const white = ctx.createBuffer(1, length, sampleRate);
  const wData = white.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    wData[i] = Math.random() * 2 - 1;
  }

  // Paul Kellet pink noise approximation
  const pink = ctx.createBuffer(1, length, sampleRate);
  const pData = pink.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < length; i += 1) {
    const wn = wData[i];
    b0 = 0.99886 * b0 + wn * 0.0555179;
    b1 = 0.99332 * b1 + wn * 0.0750759;
    b2 = 0.96900 * b2 + wn * 0.1538520;
    b3 = 0.86650 * b3 + wn * 0.3104856;
    b4 = 0.55000 * b4 + wn * 0.5329522;
    b5 = -0.7616 * b5 - wn * 0.0168980;
    pData[i] = clamp((b0 + b1 + b2 + b3 + b4 + b5 + b6 + wn * 0.5362) * 0.11, -1, 1);
    b6 = wn * 0.115926;
  }

  return { white, pink };
}

/**
 * Creates a self-contained procedural Web Audio synthesizer for vehicle engine,
 * drift/nitro loops, and all 11 car destruction SFX.
 */
export function createAudioEngine() {
  let ctx = null;
  let compressor = null;
  let masterGain = null;
  let engineBus = null;
  let sfxBus = null;
  let whiteNoiseBuffer = null;
  let pinkNoiseBuffer = null;

  // Continuous vehicle engine / drift / nitro graph
  let engineBooted = false;
  let engineOscMain = null;
  let engineOscSub = null;
  let engineSubGain = null;
  let engineFilter = null;
  let engineAmp = null;
  let driftSource = null;
  let driftFilter = null;
  let driftGain = null;
  let nitroSource = null;
  let nitroFilter = null;
  let nitroGain = null;

  let unlocked = false;
  let silentUnlocked = false;
  let muted = false;
  let disposed = false;
  let activeVoices = 0;
  const lastPlayedAt = Object.create(null);

  const stopContinuousGraph = () => {
    const stopNode = (node) => {
      if (!node) return;
      try { node.stop(); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
    };

    stopNode(engineOscMain);
    stopNode(engineOscSub);
    stopNode(driftSource);
    stopNode(nitroSource);

    for (const node of [
      engineSubGain,
      engineFilter,
      engineAmp,
      driftFilter,
      driftGain,
      nitroFilter,
      nitroGain,
    ]) {
      if (node) {
        try { node.disconnect(); } catch (_) {}
      }
    }

    engineOscMain = null;
    engineOscSub = null;
    engineSubGain = null;
    engineFilter = null;
    engineAmp = null;
    driftSource = null;
    driftFilter = null;
    driftGain = null;
    nitroSource = null;
    nitroFilter = null;
    nitroGain = null;
    engineBooted = false;
  };

  const resetContextRefs = () => {
    stopContinuousGraph();
    for (const node of [engineBus, sfxBus, masterGain, compressor]) {
      if (node) {
        try { node.disconnect(); } catch (_) {}
      }
    }
    if (ctx) {
      try { ctx.onstatechange = null; } catch (_) {}
    }
    ctx = null;
    compressor = null;
    masterGain = null;
    engineBus = null;
    sfxBus = null;
    whiteNoiseBuffer = null;
    pinkNoiseBuffer = null;
    silentUnlocked = false;
    unlocked = false;
    activeVoices = 0;
  };

  const ensureContext = () => {
    if (disposed) return null;
    if (ctx && ctx.state === 'closed') {
      resetContextRefs();
    }
    if (ctx) return ctx;
    if (typeof window === 'undefined') return null;

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;

    try {
      ctx = new AudioCtor();
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.knee.value = 16;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.14;
      compressor.connect(ctx.destination);

      masterGain = ctx.createGain();
      masterGain.gain.value = muted ? 0.0001 : MASTER_GAIN_DEFAULT;
      masterGain.connect(compressor);

      engineBus = ctx.createGain();
      engineBus.gain.value = 0.55;
      engineBus.connect(masterGain);

      sfxBus = ctx.createGain();
      sfxBus.gain.value = 0.95;
      sfxBus.connect(masterGain);

      const buffers = createNoiseBuffers(ctx);
      whiteNoiseBuffer = buffers.white;
      pinkNoiseBuffer = buffers.pink;

      const createdCtx = ctx;
      try {
        createdCtx.onstatechange = () => {
          if (disposed || ctx !== createdCtx) return;
          if (createdCtx.state === 'running') {
            unlocked = true;
            bootContinuousGraph();
          } else {
            unlocked = false;
          }
        };
      } catch (_) {}
    } catch (_) {
      resetContextRefs();
      return null;
    }
    return ctx;
  };

  const bootContinuousGraph = () => {
    if (engineBooted || !ctx || ctx.state !== 'running' || disposed) return;
    engineBooted = true;
    const now = ctx.currentTime;

    try {
      engineFilter = ctx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.setValueAtTime(240, now);
      engineFilter.Q.setValueAtTime(1.4, now);

      engineAmp = ctx.createGain();
      engineAmp.gain.setValueAtTime(0.0001, now);
      engineFilter.connect(engineAmp);
      engineAmp.connect(engineBus);

      engineOscMain = ctx.createOscillator();
      engineOscMain.type = 'sawtooth';
      engineOscMain.frequency.setValueAtTime(58, now);
      engineOscMain.connect(engineFilter);
      engineOscMain.start(now);

      engineOscSub = ctx.createOscillator();
      engineOscSub.type = 'triangle';
      engineOscSub.frequency.setValueAtTime(29, now);
      engineSubGain = ctx.createGain();
      engineSubGain.gain.setValueAtTime(0.6, now);
      engineOscSub.connect(engineSubGain);
      engineSubGain.connect(engineFilter);
      engineOscSub.start(now);

      // Continuous tire-drift screech loop (silent until drifting)
      driftSource = ctx.createBufferSource();
      driftSource.buffer = whiteNoiseBuffer;
      driftSource.loop = true;
      driftFilter = ctx.createBiquadFilter();
      driftFilter.type = 'bandpass';
      driftFilter.frequency.setValueAtTime(1600, now);
      driftFilter.Q.setValueAtTime(6.5, now);
      driftGain = ctx.createGain();
      driftGain.gain.setValueAtTime(0.0001, now);
      driftSource.connect(driftFilter);
      driftFilter.connect(driftGain);
      driftGain.connect(engineBus);
      driftSource.start(now);

      // Continuous nitro jet whoosh loop (silent until boosting)
      nitroSource = ctx.createBufferSource();
      nitroSource.buffer = pinkNoiseBuffer;
      nitroSource.loop = true;
      nitroFilter = ctx.createBiquadFilter();
      nitroFilter.type = 'bandpass';
      nitroFilter.frequency.setValueAtTime(1100, now);
      nitroFilter.Q.setValueAtTime(1.8, now);
      nitroGain = ctx.createGain();
      nitroGain.gain.setValueAtTime(0.0001, now);
      nitroSource.connect(nitroFilter);
      nitroFilter.connect(nitroGain);
      nitroGain.connect(engineBus);
      nitroSource.start(now);
    } catch (_) {
      stopContinuousGraph();
    }
  };

  const canFire = (key) => {
    if (disposed || muted || !unlocked || !ctx || ctx.state !== 'running') return false;
    if (activeVoices >= MAX_ACTIVE_VOICES) return false;
    const now = nowMs();
    const minGap = COOLDOWNS_MS[key] || 40;
    if (lastPlayedAt[key] !== undefined && (now - lastPlayedAt[key]) < minGap) {
      return false;
    }
    lastPlayedAt[key] = now;
    return true;
  };

  const trackSource = (source, nodesToDisconnect = []) => {
    activeVoices += 1;
    let released = false;
    const cleanup = () => {
      if (released) return;
      released = true;
      activeVoices = Math.max(0, activeVoices - 1);
      try {
        source.disconnect();
      } catch (_) {}
      for (let i = 0; i < nodesToDisconnect.length; i += 1) {
        try {
          nodesToDisconnect[i].disconnect();
        } catch (_) {}
      }
    };
    source.onended = cleanup;
    return cleanup;
  };

  const spawnNoiseBurst = ({
    buffer,
    duration = 0.25,
    filterType = 'bandpass',
    freqStart = 900,
    freqEnd = 300,
    q = 1.2,
    gainPeak = 0.3,
    delay = 0,
  }) => {
    if (!ctx || ctx.state !== 'running' || !buffer || activeVoices >= MAX_ACTIVE_VOICES) return;
    let src = null;
    let filter = null;
    let env = null;
    let cleanup = null;
    try {
      const t0 = ctx.currentTime + delay;
      src = ctx.createBufferSource();
      src.buffer = buffer;

      filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.setValueAtTime(Math.max(40, freqStart), t0);
      if (freqEnd !== freqStart) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t0 + duration);
      }
      filter.Q.setValueAtTime(q, t0);

      env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(Math.max(0.001, gainPeak), t0 + Math.min(0.015, duration * 0.2));
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

      src.connect(filter);
      filter.connect(env);
      env.connect(sfxBus);

      cleanup = trackSource(src, [filter, env]);
      src.start(t0, Math.random() * 0.4, duration + 0.03);
    } catch (_) {
      if (cleanup) {
        cleanup();
      } else {
        try { src?.disconnect(); } catch (__) {}
        try { filter?.disconnect(); } catch (__) {}
        try { env?.disconnect(); } catch (__) {}
      }
    }
  };

  const spawnTone = ({
    type = 'triangle',
    freqStart = 220,
    freqEnd = 110,
    duration = 0.18,
    gainPeak = 0.25,
    delay = 0,
  }) => {
    if (!ctx || ctx.state !== 'running' || activeVoices >= MAX_ACTIVE_VOICES) return;
    let osc = null;
    let env = null;
    let cleanup = null;
    try {
      const t0 = ctx.currentTime + delay;
      osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(Math.max(25, freqStart), t0);
      if (freqEnd !== freqStart) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(25, freqEnd), t0 + duration);
      }

      env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(Math.max(0.001, gainPeak), t0 + Math.min(0.012, duration * 0.15));
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

      osc.connect(env);
      env.connect(sfxBus);

      cleanup = trackSource(osc, [env]);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (_) {
      try { osc?.stop(); } catch (__) {}
      if (cleanup) {
        cleanup();
      } else {
        try { osc?.disconnect(); } catch (__) {}
        try { env?.disconnect(); } catch (__) {}
      }
    }
  };

  const unlock = () => {
    if (disposed) return;
    if (
      !ctx
      && typeof navigator !== 'undefined'
      && navigator.userActivation
      && !navigator.userActivation.isActive
      && !navigator.userActivation.hasBeenActive
    ) {
      return;
    }

    const audioCtx = ensureContext();
    if (!audioCtx) return;

    const wasNotRunning = audioCtx.state !== 'running';
    try {
      if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
        const res = audioCtx.resume();
        if (res && typeof res.then === 'function') {
          res.then(() => {
            if (!disposed && ctx === audioCtx && audioCtx.state === 'running') {
              unlocked = true;
              bootContinuousGraph();
            }
          }, () => {});
        }
      }
      // 1-sample silent buffer synchronously unlocks WebKit iPadOS audio output
      if (!silentUnlocked || wasNotRunning) {
        const silent = audioCtx.createBuffer(1, 1, 22050);
        const src = audioCtx.createBufferSource();
        src.buffer = silent;
        src.connect(masterGain);
        src.start(0);
        silentUnlocked = true;
      }
    } catch (_) {
      // Ignore if gesture restriction persists; next gesture retries cleanly.
    }

    if (audioCtx.state === 'running') {
      unlocked = true;
      bootContinuousGraph();
    } else {
      unlocked = false;
    }
  };

  const onGestureUnlock = () => {
    if (disposed) return;
    if (ctx && ctx.state === 'running' && unlocked && engineBooted) return;
    unlock();
  };

  const GESTURE_EVENTS = ['touchend', 'pointerup', 'click', 'keydown'];
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    for (let i = 0; i < GESTURE_EVENTS.length; i += 1) {
      window.addEventListener(GESTURE_EVENTS[i], onGestureUnlock, { capture: true, passive: true });
    }
  }

  const setMuted = (value) => {
    muted = Boolean(value);
    if (!ctx || !masterGain || disposed) return;
    try {
      if (ctx.state !== 'running') {
        masterGain.gain.value = muted ? 0.0001 : MASTER_GAIN_DEFAULT;
        return;
      }
      const now = ctx.currentTime;
      masterGain.gain.setTargetAtTime(muted ? 0.0001 : MASTER_GAIN_DEFAULT, now, 0.02);
      if (muted && engineBooted) {
        engineAmp?.gain.setTargetAtTime(0.0001, now, 0.02);
        driftGain?.gain.setTargetAtTime(0.0001, now, 0.02);
        nitroGain?.gain.setTargetAtTime(0.0001, now, 0.02);
      }
    } catch (_) {}
  };

  const isMuted = () => muted;

  const updateEngine = (speedRatio = 0, pitchScale = 1, isBoosting = false, isDrifting = false) => {
    if (disposed || !unlocked || !ctx || ctx.state !== 'running' || !engineBooted) return;
    const now = ctx.currentTime;
    if (muted) {
      try {
        engineAmp.gain.setTargetAtTime(0.0001, now, 0.03);
        driftGain.gain.setTargetAtTime(0.0001, now, 0.03);
        nitroGain.gain.setTargetAtTime(0.0001, now, 0.03);
      } catch (_) {}
      return;
    }

    const spd = clamp(finiteOr(speedRatio, 0), 0, 1.5);
    const scale = clamp(finiteOr(pitchScale, 1), 0.45, 2.0);
    const boost = Boolean(isBoosting);
    const drift = Boolean(isDrifting) && spd > 0.14;

    const baseFreq = (48 + spd * 112 + (boost ? 24 : 0)) * scale;
    const filterCut = 180 + spd * 640 + (boost ? 280 : 0);
    const amp = 0.06 + clamp(spd, 0, 1) * 0.14 + (boost ? 0.05 : 0);

    try {
      engineOscMain.frequency.setTargetAtTime(baseFreq, now, 0.04);
      engineOscSub.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.04);
      engineFilter.frequency.setTargetAtTime(filterCut, now, 0.05);
      engineAmp.gain.setTargetAtTime(amp, now, 0.05);

      driftFilter.frequency.setTargetAtTime(1450 + clamp(spd, 0, 1) * 450, now, 0.04);
      driftGain.gain.setTargetAtTime(drift ? 0.13 : 0.0001, now, 0.04);

      nitroFilter.frequency.setTargetAtTime(950 + clamp(spd, 0, 1) * 600, now, 0.04);
      nitroGain.gain.setTargetAtTime(boost ? 0.24 : 0.0001, now, 0.04);
    } catch (_) {}
  };

  const playCrash = (intensity = 0.6) => {
    if (!canFire('crash')) return;
    const mag = clamp(finiteOr(intensity, 0.6), 0.15, 1.2);
    // Low metallic thump + broadband sheet-metal crunch
    spawnTone({
      type: 'triangle',
      freqStart: 135 + mag * 40,
      freqEnd: 34,
      duration: 0.18 + mag * 0.14,
      gainPeak: 0.34 * mag,
    });
    spawnNoiseBurst({
      buffer: pinkNoiseBuffer,
      duration: 0.20 + mag * 0.20,
      filterType: 'bandpass',
      freqStart: 1100 + mag * 700,
      freqEnd: 240,
      q: 0.9,
      gainPeak: 0.38 * mag,
    });
  };

  const playGlassShatter = () => {
    if (!canFire('glass')) return;
    spawnNoiseBurst({
      buffer: whiteNoiseBuffer,
      duration: 0.28,
      filterType: 'highpass',
      freqStart: 3200,
      freqEnd: 4600,
      q: 1.5,
      gainPeak: 0.28,
    });
    const freqs = [2950, 3820, 4650];
    for (let i = 0; i < freqs.length; i += 1) {
      spawnTone({
        type: 'sine',
        freqStart: freqs[i],
        freqEnd: freqs[i] * 0.72,
        duration: 0.11,
        gainPeak: 0.09,
        delay: i * 0.025,
      });
    }
  };

  const playCrush = () => {
    if (!canFire('crush')) return;
    // Hydraulic servo hiss + deep metal buckling groan
    spawnTone({
      type: 'sawtooth',
      freqStart: 115,
      freqEnd: 42,
      duration: 0.42,
      gainPeak: 0.30,
    });
    spawnNoiseBurst({
      buffer: pinkNoiseBuffer,
      duration: 0.40,
      filterType: 'lowpass',
      freqStart: 820,
      freqEnd: 160,
      q: 2.2,
      gainPeak: 0.32,
    });
  };

  const playHammerDrop = () => {
    if (!canFire('hammer')) return;
    spawnTone({
      type: 'sine',
      freqStart: 180,
      freqEnd: 32,
      duration: 0.36,
      gainPeak: 0.44,
    });
    spawnNoiseBurst({
      buffer: pinkNoiseBuffer,
      duration: 0.30,
      filterType: 'lowpass',
      freqStart: 1200,
      freqEnd: 140,
      q: 1.0,
      gainPeak: 0.36,
    });
  };

  const playShredderGrind = () => {
    if (!canFire('shredder')) return;
    spawnTone({
      type: 'sawtooth',
      freqStart: 148,
      freqEnd: 92,
      duration: 0.18,
      gainPeak: 0.20,
    });
    spawnNoiseBurst({
      buffer: whiteNoiseBuffer,
      duration: 0.18,
      filterType: 'bandpass',
      freqStart: 1850,
      freqEnd: 780,
      q: 3.4,
      gainPeak: 0.25,
    });
  };

  const playTrainHorn = () => {
    if (!canFire('train')) return;
    // Classic North American diesel freight triad: C#4 (277.2), E4 (329.6), G#4 (415.3)
    const chord = [277.18, 329.63, 415.30];
    for (let i = 0; i < chord.length; i += 1) {
      spawnTone({
        type: 'sawtooth',
        freqStart: chord[i],
        freqEnd: chord[i] * 0.985,
        duration: 0.72,
        gainPeak: 0.15,
      });
    }
  };

  const playExplosion = () => {
    if (!canFire('explosion')) return;
    spawnTone({
      type: 'sine',
      freqStart: 140,
      freqEnd: 26,
      duration: 0.58,
      gainPeak: 0.48,
    });
    spawnNoiseBurst({
      buffer: pinkNoiseBuffer,
      duration: 0.65,
      filterType: 'lowpass',
      freqStart: 1400,
      freqEnd: 95,
      q: 0.8,
      gainPeak: 0.46,
    });
  };

  const playCash = (amount = 50) => {
    if (!canFire('cash')) return;
    const bonus = clamp(finiteOr(amount, 50) / 500, 0, 1);
    const root = 880 + bonus * 160;
    spawnTone({
      type: 'triangle',
      freqStart: root,
      freqEnd: root * 1.02,
      duration: 0.09,
      gainPeak: 0.18,
    });
    spawnTone({
      type: 'triangle',
      freqStart: root * 1.5,
      freqEnd: root * 1.52,
      duration: 0.14,
      gainPeak: 0.18,
      delay: 0.06,
    });
  };

  const playTrick = () => {
    if (!canFire('trick')) return;
    const notes = [523.25, 659.25, 783.99];
    for (let i = 0; i < notes.length; i += 1) {
      spawnTone({
        type: 'triangle',
        freqStart: notes[i],
        freqEnd: notes[i] * 1.03,
        duration: 0.11,
        gainPeak: 0.16,
        delay: i * 0.055,
      });
    }
  };

  const playHorn = () => {
    if (!canFire('horn')) return;
    spawnTone({
      type: 'sawtooth',
      freqStart: 392,
      freqEnd: 392,
      duration: 0.24,
      gainPeak: 0.16,
    });
    spawnTone({
      type: 'sawtooth',
      freqStart: 493.88,
      freqEnd: 493.88,
      duration: 0.24,
      gainPeak: 0.15,
    });
  };

  const playButton = () => {
    if (!canFire('button')) return;
    spawnTone({
      type: 'sine',
      freqStart: 640,
      freqEnd: 920,
      duration: 0.055,
      gainPeak: 0.14,
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unlocked = false;
    silentUnlocked = false;

    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      for (let i = 0; i < GESTURE_EVENTS.length; i += 1) {
        window.removeEventListener(GESTURE_EVENTS[i], onGestureUnlock, true);
      }
    }

    const closingCtx = ctx;
    resetContextRefs();

    if (closingCtx && typeof closingCtx.close === 'function') {
      try {
        const res = closingCtx.close();
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      } catch (_) {}
    }
  };

  return {
    unlock,
    setMuted,
    isMuted,
    updateEngine,
    playCrash,
    playGlassShatter,
    playCrush,
    playHammerDrop,
    playShredderGrind,
    playTrainHorn,
    playExplosion,
    playCash,
    playTrick,
    playHorn,
    playButton,
    dispose,
  };
}
