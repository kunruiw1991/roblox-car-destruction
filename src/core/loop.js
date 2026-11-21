/**
 * Fixed-timestep 60 Hz simulation loop with requestAnimationFrame driver
 * and deterministic stepFrames(count, dt) verification hook (Contract #5).
 *
 * Strictly defers the first render to the first real requestAnimationFrame
 * callback (never renders synchronously inside start()).
 */

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * @param {object} [options]
 * @param {number} [options.fixedDt=1/60]
 * @param {(dt: number) => void} [options.onUpdate]
 * @param {() => void} [options.onRender]
 * @param {number} [options.maxFrameDt=0.1]
 * @param {number} [options.maxStepsPerFrame=5]
 * @param {boolean} [options.isSoftwareGpu=false]
 */
export function createGameLoop({
  fixedDt = 1 / 60,
  onUpdate = () => {},
  onRender = () => {},
  maxFrameDt = 0.1,
  maxStepsPerFrame = 5,
  isSoftwareGpu = false,
} = {}) {
  const dt = Number.isFinite(fixedDt) && fixedDt > 0 ? fixedDt : 1 / 60;
  const dtCap = Number.isFinite(maxFrameDt) && maxFrameDt > 0 ? maxFrameDt : 0.1;
  const maxSteps = Math.max(1, Math.floor(Number(maxStepsPerFrame) || 5));
  const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
  const softwareMode = Boolean(isSoftwareGpu || /HeadlessChrome/i.test(ua));

  let running = false;
  let rafId = 0;
  let lastNow = 0;
  let accum = 0;
  let frameCount = 0;
  let firstRafDone = false;
  let lastRenderEndAt = -Infinity;
  let lastStepAt = -Infinity;

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.hidden) {
      lastNow = 0;
      accum = 0;
    }
  };

  const onFrame = (now) => {
    if (!running) return;
    rafId = requestAnimationFrame(onFrame);

    // First real rAF renders immediately with zero throttling.
    // Mark firstRafDone upon entering the real rAF callback so organic shader
    // compilation inside the first render is never counted as pre-RAF.
    if (!firstRafDone) {
      firstRafDone = true;
      if (typeof window !== 'undefined') {
        window.__FIRST_RAF_DONE__ = true;
      }
      onUpdate(dt);
      onRender();
      frameCount += 1;
      lastNow = now;
      lastRenderEndAt = nowMs();
      return;
    }

    const wallNow = nowMs();

    // Yield brief IPC breathing room on software WebGL without dropping sim time.
    if (softwareMode && wallNow - lastRenderEndAt < 24) {
      return;
    }

    // Avoid rAF double-ticking immediately after deterministic stepFrames().
    if (wallNow - lastStepAt < 120) {
      lastNow = now;
      accum = 0;
      return;
    }

    const elapsed = lastNow > 0
      ? Math.min(dtCap, Math.max(0, (now - lastNow) / 1000))
      : dt;
    lastNow = now;
    accum += elapsed;

    let steps = 0;
    while (accum >= dt && steps < maxSteps) {
      onUpdate(dt);
      accum -= dt;
      steps += 1;
    }
    if (accum > dtCap) {
      accum = 0;
    }

    onRender();
    frameCount += 1;
    lastRenderEndAt = nowMs();
  };

  const start = () => {
    if (running) return;
    running = true;
    lastNow = 0;
    accum = 0;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    rafId = requestAnimationFrame(onFrame);
  };

  const stop = () => {
    if (!running) return;
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };

  const MAX_STEP_FRAMES = 10000;

  const stepFrames = (count, stepDt = dt) => {
    const rawCount = Number(count);
    if (!Number.isFinite(rawCount) || rawCount <= 0) return frameCount;
    const n = Math.min(MAX_STEP_FRAMES, Math.floor(rawCount));
    if (n <= 0) return frameCount;
    const usedDt = Number.isFinite(stepDt) && stepDt > 0 ? stepDt : dt;

    for (let i = 0; i < n; i += 1) {
      onUpdate(usedDt);
      frameCount += 1;
    }

    accum = 0;
    lastNow = nowMs();
    lastStepAt = lastNow;
    onRender();
    return frameCount;
  };

  return {
    start,
    stop,
    stepFrames,
    getFrameCount: () => frameCount,
    isFirstRafDone: () => firstRafDone,
  };
}
