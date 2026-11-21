/**
 * Roblox-Style Edge-Docked iPad HUD Controller (Contracts #3, #4, #9, #14).
 *
 * Guardrail 3 enforced strictly:
 *   - All 10 discrete HUD buttons bind via bindHudTouchAction() (zero raw click
 *     listeners, zero millisecond deduplication timers).
 *   - All 5 continuous driving pedals bind via multi-touch bindHoldControl().
 *   - Each discrete HUD button immediately increments strictly 1 dedicated key
 *     in hudActionCounts via onHudAction(key).
 */

import { bindHudTouchAction, bindHoldControl } from '../core/touch_bind.js';

const CAMERA_MODE_LABELS = Object.freeze({
  chase: Object.freeze({ short: 'CAM', aria: 'Camera: Chase' }),
  cockpit: Object.freeze({ short: 'CAB', aria: 'Camera: Cockpit' }),
  orbit_close: Object.freeze({ short: 'ORB', aria: 'Camera: Close Orbit' }),
});

const MACHINE_SHORT_LABELS = Object.freeze({
  hydraulic_press: 'PRESS',
  nail_hammer: 'NAIL',
  giant_hammer: 'DROP',
  spike_drop: 'MINES',
  train_crossing: 'TRAIN',
  crash_c4_wall: 'BLAST',
});

const MAX_TRICK_ROWS = 4;
const MAX_ALERT_LEN = 48;
const MAX_TRICK_LEN = 26;

export function formatCash(amount) {
  const n = Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : 0;
  if (n >= 1000000) {
    return `$${(n / 1000000).toFixed(1)}M`;
  }
  if (n >= 100000) {
    return `$${Math.round(n / 1000)}K`;
  }
  return `$${n.toLocaleString('en-US')}`;
}

function clampText(raw, maxLen) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  const limit = Math.max(1, maxLen - 1);
  const sliced = s.slice(0, limit);
  const nextChar = s.charAt(limit);
  let base = sliced;
  if (nextChar && !/\s/.test(nextChar)) {
    const lastSpace = sliced.lastIndexOf(' ');
    if (lastSpace >= Math.floor(limit * 0.45)) {
      base = sliced.slice(0, lastSpace);
    }
  }
  base = base.replace(/[!.,;:-]+$/, '').trimEnd();
  return `${base || sliced.trimEnd()}!`;
}

/**
 * Hydrates all Contract #14 HUD elements, touch controls, keyboard mirror, and
 * dirty-checked DOM updates.
 *
 * @param {object} callbacks
 */
export function createHudController({
  onPlay,
  onOpenGarage,
  onOpenTeleport,
  onCycleCamera,
  onToggleRagdoll,
  onToggleAudio,
  onAutoSmash,
  onThrowTnt,
  onRepair,
  onMachineTrigger,
  onHorn = null,
  onEscape = null,
  onAudioUnlock = null,
  onHudAction = null,
  onControlsChange = null,
}) {
  const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);

  const startOverlay = $('start-overlay');
  const hudRoot = $('hud-root');

  // Discrete buttons
  const btnPlay = $('btn-play');
  const btnGarage = $('btn-garage');
  const btnTeleport = $('btn-teleport');
  const btnCamera = $('btn-camera');
  const btnRagdoll = $('btn-ragdoll');
  const btnAudio = $('btn-audio');
  const btnAutoSmash = $('btn-auto-smash');
  const btnTnt = $('btn-tnt');
  const btnRepair = $('btn-repair');
  const btnMachineTrigger = $('btn-machine-trigger');

  // Hold pedals
  const btnSteerLeft = $('btn-steer-left');
  const btnSteerRight = $('btn-steer-right');
  const btnBrake = $('btn-brake');
  const btnGas = $('btn-gas');
  const btnBoost = $('btn-boost');

  // Live HUD indicators
  const cashEl = $('hud-cash');
  const partsEl = $('hud-parts');
  const levelEl = $('hud-level');
  const integrityBarEl = $('hud-integrity-bar');
  const integrityValEl = $('hud-integrity-value');
  const nitroBarEl = $('hud-nitro-bar');
  const alertEl = $('hud-alert');
  const lbJjEl = $('hud-lb-jj');
  const lbMikeyEl = $('hud-lb-mikey');
  const trickFeedEl = $('hud-trick-feed');
  const speedValEl = $('hud-speed-value');
  const gearValEl = $('hud-gear-value');

  const camLabelEl = btnCamera ? btnCamera.querySelector('.btn-label') : null;
  const ragdollLabelEl = btnRagdoll ? btnRagdoll.querySelector('.btn-label') : null;
  const audioIconEl = btnAudio ? btnAudio.querySelector('.btn-icon') : null;
  const machineLabelEl = btnMachineTrigger ? btnMachineTrigger.querySelector('.btn-label') : null;

  let started = false;
  let modalOpen = false;

  const touchState = {
    steerLeft: false,
    steerRight: false,
    gas: false,
    brake: false,
    boost: false,
  };

  const keyState = {
    steerLeft: false,
    steerRight: false,
    gas: false,
    brake: false,
    boost: false,
  };

  const unsubs = [];

  const getControls = () => {
    if (!started || modalOpen) {
      return { steer: 0, throttle: 0, brake: 0, boost: 0 };
    }
    const left = touchState.steerLeft || keyState.steerLeft;
    const right = touchState.steerRight || keyState.steerRight;
    const gas = touchState.gas || keyState.gas;
    const brake = touchState.brake || keyState.brake;
    const boost = touchState.boost || keyState.boost;
    return {
      steer: (left ? 1 : 0) - (right ? 1 : 0),
      throttle: gas ? 1 : 0,
      brake: brake ? 1 : 0,
      boost: boost ? 1 : 0,
    };
  };

  const notifyControls = () => {
    if (onControlsChange) {
      onControlsChange(getControls());
    }
  };

  const clearKeyHolds = () => {
    keyState.steerLeft = false;
    keyState.steerRight = false;
    keyState.gas = false;
    keyState.brake = false;
    keyState.boost = false;
    notifyControls();
  };

  const clearAllHolds = () => {
    keyState.steerLeft = false;
    keyState.steerRight = false;
    keyState.gas = false;
    keyState.brake = false;
    keyState.boost = false;
    touchState.steerLeft = false;
    touchState.steerRight = false;
    touchState.gas = false;
    touchState.brake = false;
    touchState.boost = false;
    const pedals = [btnSteerLeft, btnSteerRight, btnBrake, btnGas, btnBoost];
    for (let i = 0; i < pedals.length; i += 1) {
      if (pedals[i]) pedals[i].classList.remove('is-pressed');
    }
    notifyControls();
  };

  const updateCameraButton = (mode) => {
    const cfg = CAMERA_MODE_LABELS[mode] || CAMERA_MODE_LABELS.chase;
    if (camLabelEl && camLabelEl.textContent !== cfg.short) {
      camLabelEl.textContent = cfg.short;
    }
    if (btnCamera) {
      btnCamera.setAttribute('aria-label', cfg.aria);
    }
  };

  const updateAudioButton = (muted) => {
    const isMuted = Boolean(muted);
    if (btnAudio) {
      btnAudio.classList.toggle('is-muted', isMuted);
      btnAudio.setAttribute('aria-pressed', String(isMuted));
      btnAudio.setAttribute('aria-label', isMuted ? 'Unmute Sound' : 'Mute Sound');
    }
    if (audioIconEl) {
      audioIconEl.textContent = isMuted ? '\u{1F507}' : '\u{1F50A}';
    }
  };

  // Bind all 10 discrete HUD buttons strictly via bindHudTouchAction (Guardrail 3)
  const bindAction = (el, key, fn) => {
    if (!el) return;
    unsubs.push(
      bindHudTouchAction(
        el,
        () => {
          onHudAction?.(key);
          fn?.();
        },
        { onAudioUnlock },
      ),
    );
  };

  bindAction(btnPlay, 'play', () => {
    onPlay?.();
  });

  bindAction(btnGarage, 'garage', () => {
    onOpenGarage?.();
  });

  bindAction(btnTeleport, 'teleport', () => {
    onOpenTeleport?.();
  });

  bindAction(btnCamera, 'camera', () => {
    const mode = onCycleCamera?.();
    if (mode) updateCameraButton(mode);
  });

  bindAction(btnRagdoll, 'ragdoll', () => {
    onToggleRagdoll?.();
  });

  bindAction(btnAudio, 'audio', () => {
    const muted = onToggleAudio?.();
    updateAudioButton(muted);
  });

  bindAction(btnAutoSmash, 'auto_smash', () => {
    onAutoSmash?.();
  });

  bindAction(btnTnt, 'tnt', () => {
    onThrowTnt?.();
  });

  bindAction(btnRepair, 'repair', () => {
    onRepair?.();
  });

  bindAction(btnMachineTrigger, 'machine_trigger', () => {
    onMachineTrigger?.();
  });

  // Bind all 5 continuous driving pedals via bindHoldControl (Guardrail 3)
  const bindPedal = (el, field) => {
    if (!el) return;
    unsubs.push(
      bindHoldControl(el, {
        onAudioUnlock,
        onChange: (pressed) => {
          touchState[field] = Boolean(pressed);
          notifyControls();
        },
      }),
    );
  };

  bindPedal(btnSteerLeft, 'steerLeft');
  bindPedal(btnSteerRight, 'steerRight');
  bindPedal(btnBrake, 'brake');
  bindPedal(btnGas, 'gas');
  bindPedal(btnBoost, 'boost');

  // Desktop keyboard mirror (auto-clears on window.blur / visibilitychange)
  const onKeyDown = (e) => {
    if (!e) return;
    onAudioUnlock?.();

    const code = e.code;
    if (code === 'Escape') {
      if (modalOpen) {
        e.preventDefault();
        onEscape?.();
      }
      return;
    }

    if (!started) {
      if ((code === 'Enter' || code === 'Space') && document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault();
        onHudAction?.('play');
        onPlay?.();
      }
      return;
    }

    if (modalOpen) {
      if (!e.repeat && (code === 'KeyG' || code === 'KeyM')) {
        e.preventDefault();
        onEscape?.();
      }
      return;
    }

    if (code === 'KeyW' || code === 'ArrowUp') {
      keyState.gas = true;
      notifyControls();
      return;
    }
    if (code === 'KeyS' || code === 'ArrowDown') {
      keyState.brake = true;
      notifyControls();
      return;
    }
    if (code === 'KeyA' || code === 'ArrowLeft') {
      keyState.steerLeft = true;
      notifyControls();
      return;
    }
    if (code === 'KeyD' || code === 'ArrowRight') {
      keyState.steerRight = true;
      notifyControls();
      return;
    }
    if (code === 'ShiftLeft' || code === 'ShiftRight') {
      keyState.boost = true;
      notifyControls();
      return;
    }

    if (e.repeat) return;
    if (document.activeElement && document.activeElement.tagName === 'BUTTON' && (code === 'Space' || code === 'Enter')) {
      return;
    }

    if (code === 'Space') {
      e.preventDefault();
      onHudAction?.('auto_smash');
      onAutoSmash?.();
    } else if (code === 'KeyE') {
      onHudAction?.('tnt');
      onThrowTnt?.();
    } else if (code === 'KeyR') {
      onHudAction?.('repair');
      onRepair?.();
    } else if (code === 'KeyC') {
      onHudAction?.('camera');
      const mode = onCycleCamera?.();
      if (mode) updateCameraButton(mode);
    } else if (code === 'KeyG') {
      onHudAction?.('garage');
      onOpenGarage?.();
    } else if (code === 'KeyM') {
      onHudAction?.('teleport');
      onOpenTeleport?.();
    } else if (code === 'KeyF') {
      onHudAction?.('ragdoll');
      onToggleRagdoll?.();
    } else if (code === 'KeyH') {
      onHorn?.();
    }
  };

  const onKeyUp = (e) => {
    if (!e) return;
    const code = e.code;
    if (code === 'KeyW' || code === 'ArrowUp') keyState.gas = false;
    else if (code === 'KeyS' || code === 'ArrowDown') keyState.brake = false;
    else if (code === 'KeyA' || code === 'ArrowLeft') keyState.steerLeft = false;
    else if (code === 'KeyD' || code === 'ArrowRight') keyState.steerRight = false;
    else if (code === 'ShiftLeft' || code === 'ShiftRight') keyState.boost = false;
    else return;
    notifyControls();
  };

  const onWindowBlur = () => {
    clearAllHolds();
  };

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.hidden) {
      clearAllHolds();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  // Dirty-checking cache for minimal 60 Hz DOM writes
  const prev = {
    cashText: '',
    mikeyText: '',
    partsText: '',
    levelText: '',
    hpRounded: -1,
    hpTone: '',
    nitroRounded: -1,
    speedRounded: -1,
    gear: '',
    cameraMode: '',
    ragdolling: null,
    autoSmashActive: null,
    machineLabel: '',
    machineAria: '',
    machineReady: null,
    alertHidden: true,
    alertText: '',
    alertTone: '',
    feedSig: '',
  };

  const setStarted = (value) => {
    started = Boolean(value);
    if (startOverlay) startOverlay.hidden = started;
    if (hudRoot) hudRoot.hidden = !started;
    if (!started) clearAllHolds();
    notifyControls();
  };

  const setModalOpen = (open) => {
    modalOpen = Boolean(open);
    if (modalOpen) {
      clearKeyHolds();
      const pedals = [btnSteerLeft, btnSteerRight, btnBrake, btnGas, btnBoost];
      for (let i = 0; i < pedals.length; i += 1) {
        if (pedals[i]) pedals[i].classList.remove('is-pressed');
      }
    } else {
      if (btnSteerLeft) btnSteerLeft.classList.toggle('is-pressed', touchState.steerLeft);
      if (btnSteerRight) btnSteerRight.classList.toggle('is-pressed', touchState.steerRight);
      if (btnBrake) btnBrake.classList.toggle('is-pressed', touchState.brake);
      if (btnGas) btnGas.classList.toggle('is-pressed', touchState.gas);
      if (btnBoost) btnBoost.classList.toggle('is-pressed', touchState.boost);
    }
    notifyControls();
  };

  const render = (view) => {
    if (!view || !started) return;

    // 1. Cash & Leaderboard (update in place, never rebuild #hud-leaderboard)
    const cashText = formatCash(view.cash);
    if (cashText !== prev.cashText) {
      prev.cashText = cashText;
      if (cashEl) cashEl.textContent = cashText;
      if (lbJjEl) lbJjEl.textContent = cashText;
    }

    const mikeyText = formatCash(view.mikeyCash);
    if (mikeyText !== prev.mikeyText) {
      prev.mikeyText = mikeyText;
      if (lbMikeyEl) lbMikeyEl.textContent = mikeyText;
    }

    // 2. Parts & Level
    const partsText = `${Math.max(0, Math.round(view.detachedParts || 0))}/${Math.max(1, Math.round(view.totalParts || 12))}`;
    if (partsText !== prev.partsText) {
      prev.partsText = partsText;
      if (partsEl) partsEl.textContent = partsText;
    }

    const levelText = `LVL ${Math.max(1, Math.round(view.level || 1))}`;
    if (levelText !== prev.levelText) {
      prev.levelText = levelText;
      if (levelEl) levelEl.textContent = levelText;
    }

    // 3. Integrity bar (.is-warn / .is-danger)
    const maxHp = view.maxIntegrity > 0 ? view.maxIntegrity : 100;
    const hpPct = Math.min(100, Math.max(0, (Number(view.integrity) / maxHp) * 100));
    const hpRounded = Number.isFinite(hpPct) ? Math.round(hpPct) : 100;
    const hpTone = (hpRounded < 35 || view.onFire) ? 'danger' : (hpRounded < 70 ? 'warn' : 'ok');

    if (hpRounded !== prev.hpRounded) {
      prev.hpRounded = hpRounded;
      if (integrityBarEl) {
        integrityBarEl.style.width = `${hpRounded}%`;
        integrityBarEl.setAttribute('aria-valuenow', String(hpRounded));
      }
      if (integrityValEl) {
        integrityValEl.textContent = `${hpRounded}%`;
      }
    }
    if (hpTone !== prev.hpTone) {
      prev.hpTone = hpTone;
      if (integrityBarEl) {
        integrityBarEl.classList.toggle('is-warn', hpTone === 'warn');
        integrityBarEl.classList.toggle('is-danger', hpTone === 'danger');
      }
    }

    // 4. Nitro bar
    const nitroPct = Math.min(100, Math.max(0, Number(view.nitro)));
    const nitroRounded = Number.isFinite(nitroPct) ? Math.round(nitroPct) : 100;
    if (nitroRounded !== prev.nitroRounded) {
      prev.nitroRounded = nitroRounded;
      if (nitroBarEl) {
        nitroBarEl.style.width = `${nitroRounded}%`;
        nitroBarEl.setAttribute('aria-valuenow', String(nitroRounded));
      }
    }

    // 5. Speedometer & Gear
    const rawSpeed = Number.isFinite(view.speedKmh) ? Math.abs(view.speedKmh) : 0;
    const speedRounded = Math.min(999, Math.round(rawSpeed));
    if (speedRounded !== prev.speedRounded) {
      prev.speedRounded = speedRounded;
      if (speedValEl) speedValEl.textContent = String(speedRounded);
    }

    const gearText = String(view.gear || 'D1');
    if (gearText !== prev.gear) {
      prev.gear = gearText;
      if (gearValEl) gearValEl.textContent = gearText;
    }

    // 6. Camera, Ragdoll, Auto-Smash & Contextual Machine Trigger
    if (view.cameraMode && view.cameraMode !== prev.cameraMode) {
      prev.cameraMode = view.cameraMode;
      updateCameraButton(view.cameraMode);
    }

    const isRag = Boolean(view.ragdolling);
    if (isRag !== prev.ragdolling) {
      prev.ragdolling = isRag;
      if (ragdollLabelEl) ragdollLabelEl.textContent = isRag ? 'STAND' : 'EJECT';
      if (btnRagdoll) {
        btnRagdoll.setAttribute('aria-pressed', String(isRag));
        btnRagdoll.setAttribute('aria-label', isRag ? 'Return to Seat' : 'Eject Ragdoll');
      }
    }

    const isSmash = Boolean(view.autoSmashActive);
    if (isSmash !== prev.autoSmashActive) {
      prev.autoSmashActive = isSmash;
      if (btnAutoSmash) btnAutoSmash.setAttribute('aria-pressed', String(isSmash));
    }

    // Short <= 6-char uppercase label for #btn-machine-trigger (prevents 768x1024 overflow)
    const mappedShort = (view.machineShortLabel && view.machineShortLabel.length <= 6)
      ? view.machineShortLabel.toUpperCase()
      : (MACHINE_SHORT_LABELS[view.zoneId] || 'CRUSH');
    const machineAria = view.machineAriaLabel || 'Trigger Crusher Machine';
    const machineReady = Boolean(view.machineReady);

    if (mappedShort !== prev.machineLabel) {
      prev.machineLabel = mappedShort;
      if (machineLabelEl) machineLabelEl.textContent = mappedShort;
    }
    if (machineAria !== prev.machineAria) {
      prev.machineAria = machineAria;
      if (btnMachineTrigger) btnMachineTrigger.setAttribute('aria-label', machineAria);
    }
    if (machineReady !== prev.machineReady) {
      prev.machineReady = machineReady;
      if (btnMachineTrigger) btnMachineTrigger.classList.toggle('is-ready', machineReady);
    }

    // 7. Alert Banner (#hud-alert: hidden + alert-danger / alert-wrecked / alert-info)
    const alertText = view.alertText ? clampText(view.alertText, MAX_ALERT_LEN) : '';
    const alertTone = String(view.alertTone || 'warn');
    const shouldHide = !alertText;

    if (alertEl) {
      if (shouldHide !== prev.alertHidden) {
        prev.alertHidden = shouldHide;
        alertEl.hidden = shouldHide;
      }
      if (!shouldHide && (alertText !== prev.alertText || alertTone !== prev.alertTone)) {
        prev.alertText = alertText;
        prev.alertTone = alertTone;
        alertEl.textContent = alertText;
        alertEl.classList.toggle('alert-danger', alertTone === 'danger');
        alertEl.classList.toggle('alert-wrecked', alertTone === 'wrecked');
        alertEl.classList.toggle('alert-info', alertTone === 'info');
      }
    }

    // 8. Trick / Crash Combo Feed (strictly <= 4 rows, <= 26 chars each)
    if (trickFeedEl && Array.isArray(view.trickFeed)) {
      const capped = view.trickFeed.slice(0, MAX_TRICK_ROWS);
      let sig = '';
      for (let i = 0; i < capped.length; i += 1) {
        sig += `${capped[i].id}:${capped[i].tone}:${capped[i].text}|`;
      }
      if (sig !== prev.feedSig) {
        prev.feedSig = sig;
        trickFeedEl.textContent = '';
        for (let i = 0; i < capped.length; i += 1) {
          const item = capped[i];
          const row = document.createElement('div');
          row.className = item.tone === 'crash'
            ? 'trick-row trick-crash'
            : (item.tone === 'combo' ? 'trick-row trick-combo' : 'trick-row');
          row.textContent = clampText(item.text, MAX_TRICK_LEN);
          trickFeedEl.appendChild(row);
        }
      }
    }
  };

  const dispose = () => {
    clearAllHolds();
    for (let i = 0; i < unsubs.length; i += 1) {
      unsubs[i]();
    }
    unsubs.length = 0;
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };

  return {
    setStarted,
    setModalOpen,
    getControls,
    clearInputs: clearAllHolds,
    updateAudioButton,
    updateCameraButton,
    render,
    dispose,
  };
}
