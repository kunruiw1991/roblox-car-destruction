/**
 * iPad Safari Touch & Modal Input Guardrails (Contract #3 / Guardrails 3 & 4).
 *
 * - bindHudTouchAction(): fires immediately on pointerdown and unconditionally
 *   swallows pointer-originated click events with ZERO millisecond timers,
 *   while preserving keyboard Enter/Space and programmatic .click(), and
 *   supporting simultaneous multi-touch (never rejects secondary thumbs).
 * - bindHoldControl(): multi-touch per-pointerId hold control with capture and
 *   pointercancel / lostpointercapture / window.blur / visibilitychange release.
 * - bindModalBackdropDismiss(): dismisses strictly on backdrop pointerdown
 *   once >= MODAL_BACKDROP_GUARD_MS (450 ms) have elapsed since modal open.
 */

export const MODAL_BACKDROP_GUARD_MS = 450;

function isElementDisabled(el) {
  if (!el) return true;
  return Boolean(el.disabled)
    || el.getAttribute('aria-disabled') === 'true'
    || el.classList.contains('is-disabled');
}

function isPointerType(pt) {
  return pt === 'touch' || pt === 'mouse' || pt === 'pen';
}

/**
 * Binds a discrete HUD button to fire on pointerdown while swallowing trailing
 * pointer-originated click events without any millisecond deduplication timer.
 *
 * @param {HTMLElement} el
 * @param {(e: Event) => void} handler
 * @param {{ stopPropagation?: boolean, onAudioUnlock?: (() => void)|null }} [options]
 * @returns {() => void} unbind
 */
export function bindHudTouchAction(el, handler, options) {
  if (!el || typeof handler !== 'function') {
    return () => {};
  }

  const opts = options && typeof options === 'object' ? options : {};
  const { onAudioUnlock = null, stopPropagation = true } = opts;
  const shouldStopPropagation = stopPropagation !== false;
  const unlock = typeof onAudioUnlock === 'function' ? onAudioUnlock : null;

  let swallowNextTrustedClick = false;

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.cancelable) e.preventDefault();
    if (shouldStopPropagation) e.stopPropagation();

    swallowNextTrustedClick = true;
    if (unlock) unlock();
    if (isElementDisabled(el)) return;

    el.classList.add('is-pressed');
    handler(e);
  };

  const clearPressed = () => {
    el.classList.remove('is-pressed');
  };

  const onVisChange = () => {
    if (typeof document !== 'undefined' && document.hidden) {
      clearPressed();
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      swallowNextTrustedClick = false;
    }
  };

  const onClick = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (shouldStopPropagation) e.stopPropagation();

    const isPointerClick = e.detail > 0
      || isPointerType(e.pointerType)
      || (swallowNextTrustedClick && e.isTrusted !== false);

    if (isPointerClick) {
      swallowNextTrustedClick = false;
      e.preventDefault();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
      return;
    }

    swallowNextTrustedClick = false;
    if (unlock) unlock();
    if (isElementDisabled(el)) return;
    handler(e);
  };

  const onContextMenu = (e) => {
    e.preventDefault();
  };

  el.addEventListener('pointerdown', onPointerDown, { passive: false });
  el.addEventListener('pointerup', clearPressed);
  el.addEventListener('pointercancel', clearPressed);
  el.addEventListener('pointerleave', clearPressed);
  el.addEventListener('keydown', onKeyDown);
  el.addEventListener('click', onClick, true);
  el.addEventListener('contextmenu', onContextMenu);
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', clearPressed);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisChange);
  }

  return () => {
    clearPressed();
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointerup', clearPressed);
    el.removeEventListener('pointercancel', clearPressed);
    el.removeEventListener('pointerleave', clearPressed);
    el.removeEventListener('keydown', onKeyDown);
    el.removeEventListener('click', onClick, true);
    el.removeEventListener('contextmenu', onContextMenu);
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', clearPressed);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisChange);
    }
  };
}

/**
 * Binds a continuous driving control (steer, gas, brake/reverse, nitro) with
 * per-pointerId multi-touch tracking and fail-safe release on cancel/blur/hide.
 *
 * @param {HTMLElement} el
 * @param {{ onChange: (pressed: boolean) => void, onAudioUnlock?: (() => void)|null }} config
 * @returns {() => void} unbind
 */
export function bindHoldControl(el, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const { onChange, onAudioUnlock = null } = cfg;
  if (!el || typeof onChange !== 'function') {
    return () => {};
  }

  const unlock = typeof onAudioUnlock === 'function' ? onAudioUnlock : null;
  const activeIds = new Set();
  let lastPressed = false;

  const sync = () => {
    const pressed = activeIds.size > 0;
    el.classList.toggle('is-pressed', pressed);
    if (pressed !== lastPressed) {
      lastPressed = pressed;
      onChange(pressed);
    }
  };

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (isElementDisabled(el)) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();

    if (unlock) unlock();

    const pid = e.pointerId !== undefined ? e.pointerId : 'mouse';
    activeIds.add(pid);
    if (e.pointerId !== undefined) {
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch (_) {
        // Synthetic or detached events may not support capture.
      }
    }
    sync();
  };

  const onPointerUpOrCancel = (e) => {
    const pid = e && e.pointerId !== undefined ? e.pointerId : 'mouse';
    if (activeIds.delete(pid)) {
      sync();
    }
  };

  const onWindowPointerEnd = (e) => {
    const pid = e && e.pointerId !== undefined ? e.pointerId : 'mouse';
    if (activeIds.has(pid)) {
      activeIds.delete(pid);
      sync();
    }
  };

  const releaseAll = () => {
    if (activeIds.size > 0) {
      activeIds.clear();
      sync();
    }
  };

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.hidden) {
      releaseAll();
    }
  };

  const swallowClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
  };

  const onContextMenu = (e) => {
    e.preventDefault();
  };

  el.addEventListener('pointerdown', onPointerDown, { passive: false });
  el.addEventListener('pointerup', onPointerUpOrCancel);
  el.addEventListener('pointercancel', onPointerUpOrCancel);
  el.addEventListener('lostpointercapture', onPointerUpOrCancel);
  el.addEventListener('click', swallowClick, true);
  el.addEventListener('contextmenu', onContextMenu);

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerup', onWindowPointerEnd);
    window.addEventListener('pointercancel', onWindowPointerEnd);
    window.addEventListener('blur', releaseAll);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return () => {
    releaseAll();
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointerup', onPointerUpOrCancel);
    el.removeEventListener('pointercancel', onPointerUpOrCancel);
    el.removeEventListener('lostpointercapture', onPointerUpOrCancel);
    el.removeEventListener('click', swallowClick, true);
    el.removeEventListener('contextmenu', onContextMenu);

    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerup', onWindowPointerEnd);
      window.removeEventListener('pointercancel', onWindowPointerEnd);
      window.removeEventListener('blur', releaseAll);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}

/**
 * Dismisses a modal ONLY when pointerdown lands directly on backdropEl AND at
 * least MODAL_BACKDROP_GUARD_MS (450 ms) have elapsed since getOpenedAt().
 *
 * @param {HTMLElement} backdropEl
 * @param {{ getOpenedAt: () => number, onDismiss: (e: Event) => void }} config
 * @returns {() => void} unbind
 */
export function bindModalBackdropDismiss(backdropEl, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const { getOpenedAt, onDismiss } = cfg;
  if (!backdropEl || typeof getOpenedAt !== 'function' || typeof onDismiss !== 'function') {
    return () => {};
  }

  let swallowNextClick = false;

  const onPointerDown = (e) => {
    if (e.target !== backdropEl) return;
    if (e.button !== undefined && e.button !== 0) return;

    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    swallowNextClick = true;

    const rawOpenedAt = getOpenedAt();
    const openedAt = typeof rawOpenedAt === 'number' ? rawOpenedAt : Number.NaN;
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

    if (!Number.isFinite(openedAt) || openedAt <= 0 || (now - openedAt) < MODAL_BACKDROP_GUARD_MS) {
      return;
    }

    onDismiss(e);
  };

  const onClick = (e) => {
    if (e.target !== backdropEl) return;
    if (swallowNextClick || e.detail > 0 || isPointerType(e.pointerType)) {
      swallowNextClick = false;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }
    }
  };

  backdropEl.addEventListener('pointerdown', onPointerDown, { passive: false });
  backdropEl.addEventListener('click', onClick, true);

  return () => {
    backdropEl.removeEventListener('pointerdown', onPointerDown);
    backdropEl.removeEventListener('click', onClick, true);
  };
}
