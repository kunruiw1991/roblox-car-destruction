/**
 * CARS / GARAGE Modal Controller (Contracts #3, #6, #14; WebKit Guardrails 3 & 4).
 *
 * - Pre-builds 9 [data-paint-id] swatches and 12 native <button class="vehicle-card">
 *   [data-vehicle-id] cards ONCE at initialization (zero listener leaks, < 1 ms open).
 * - ZERO raw click listeners; ZERO nested buttons; NEVER disables vehicle cards
 *   (all 12 vehicles are immediately spawnable via freeStarter, purchase, or tryFree).
 * - Enforces Guardrail 4 via bindModalBackdropDismiss() with openedAt initialized to
 *   Number.NaN when closed and stamped LAST inside open() immediately after unhiding.
 */

import { PAINT_SWATCHES, VEHICLES } from '../data/vehicles.js';
import { bindHudTouchAction, bindModalBackdropDismiss } from '../core/touch_bind.js';

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function formatCashBadge(amount) {
  const n = Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : 0;
  if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (n >= 100000) return `$${Math.round(n / 1000)}K`;
  return `$${n.toLocaleString('en-US')}`;
}

function compactSpecs(vehicle) {
  const raw = String(vehicle && vehicle.specsText ? vehicle.specsText : '').replace(/\s+/g, ' ').trim();
  if (raw.length <= 44) return raw;
  const parts = raw.split(' • ').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // Prefer keeping lead highlight + speed/mass without ever splitting a token
    const kept = [parts[0]];
    for (let i = 1; i < parts.length; i += 1) {
      const candidate = `${kept.join(' • ')} • ${parts[i]}`;
      if (candidate.length <= 44) {
        kept.push(parts[i]);
      }
    }
    if (kept.length >= 2) {
      return kept.join(' • ');
    }
    // Always pair headline + top speed cleanly
    const speedPart = parts[parts.length - 1];
    const headline = parts[0].length > 28 ? parts[0].slice(0, 28).trimEnd() : parts[0];
    return `${headline} • ${speedPart}`;
  }
  return raw.slice(0, 44).trimEnd();
}

/**
 * Hydrates #modal-garage with 9 paint swatches and 12 single-tap vehicle cards.
 *
 * @param {object} callbacks
 */
export function createGarageModal({
  onSelectVehicle,
  onSelectPaint,
  onOpenChange = null,
  onAudioUnlock = null,
}) {
  const backdropEl = typeof document !== 'undefined' ? document.getElementById('modal-garage') : null;
  const closeBtn = typeof document !== 'undefined' ? document.getElementById('btn-garage-close') : null;
  const cashBadgeEl = typeof document !== 'undefined' ? document.getElementById('garage-cash-badge') : null;
  const paintRowEl = typeof document !== 'undefined' ? document.getElementById('garage-paint-row') : null;
  const vehicleGridEl = typeof document !== 'undefined' ? document.getElementById('garage-vehicle-grid') : null;
  const modalBodyEl = backdropEl ? backdropEl.querySelector('.modal-body') : null;

  let isOpen = false;
  let openedAt = Number.NaN;
  let activeVehicleId = 'sedan';
  let activeColorHex = '#e53935';
  let selectedPaintHex = '#e53935';
  let customPaintPickedInSession = false;
  let currentCash = 1500;
  let ownedIds = new Set(VEHICLES.filter((v) => v.freeStarter).map((v) => v.id));
  let vehicleLevels = {};

  const unsubs = [];
  /** @type {Array<{ swatch: object, btn: HTMLButtonElement }>} */
  const swatchNodes = [];
  /** @type {Array<{ vehicle: object, card: HTMLButtonElement, swatchEl: HTMLElement, metaEl: HTMLElement, ctaEl: HTMLElement }>} */
  const cardNodes = [];

  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    openedAt = Number.NaN;
    if (backdropEl) {
      backdropEl.hidden = true;
    }
    onOpenChange?.(false);
  };

  // Guardrail 4: backdrop pointerdown dismiss with >= 450 ms open guard
  if (backdropEl) {
    unsubs.push(
      bindModalBackdropDismiss(backdropEl, {
        getOpenedAt: () => openedAt,
        onDismiss: close,
      }),
    );
  }

  // Close button bypasses backdrop delay (0 ms dismiss)
  if (closeBtn) {
    unsubs.push(
      bindHudTouchAction(closeBtn, close, { onAudioUnlock }),
    );
  }

  const syncPaintSelection = (hex) => {
    const norm = String(hex || '').toLowerCase();
    for (let i = 0; i < swatchNodes.length; i += 1) {
      const { swatch, btn } = swatchNodes[i];
      const selected = swatch.hex.toLowerCase() === norm;
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('aria-pressed', String(selected));
    }
  };

  // Mount-once: 9 Roblox paint swatches ([data-paint-id])
  if (paintRowEl) {
    paintRowEl.textContent = '';
    for (let i = 0; i < PAINT_SWATCHES.length; i += 1) {
      const swatch = PAINT_SWATCHES[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'paint-swatch-btn';
      btn.setAttribute('data-paint-id', swatch.id);
      btn.setAttribute('aria-label', `Paint ${swatch.name}`);
      btn.setAttribute('aria-pressed', 'false');
      btn.style.setProperty('--swatch-hex', swatch.hex);
      paintRowEl.appendChild(btn);

      swatchNodes.push({ swatch, btn });

      unsubs.push(
        bindHudTouchAction(
          btn,
          () => {
            selectedPaintHex = swatch.hex;
            activeColorHex = swatch.hex;
            customPaintPickedInSession = true;
            syncPaintSelection(swatch.hex);
            // Update active card color preview immediately without closing Garage
            for (let j = 0; j < cardNodes.length; j += 1) {
              if (cardNodes[j].vehicle.id === activeVehicleId) {
                cardNodes[j].swatchEl.style.setProperty('--veh-color', swatch.hex);
              }
            }
            onSelectPaint?.(swatch);
          },
          { onAudioUnlock },
        ),
      );
    }
  }

  // Mount-once: 12 native <button class="vehicle-card"> cards ([data-vehicle-id], zero nested buttons)
  if (vehicleGridEl) {
    vehicleGridEl.textContent = '';
    for (let i = 0; i < VEHICLES.length; i += 1) {
      const v = VEHICLES[i];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'vehicle-card';
      card.setAttribute('data-vehicle-id', v.id);
      card.setAttribute('aria-label', `Select ${v.name}`);

      const topRow = document.createElement('div');
      topRow.className = 'vehicle-card-top';

      const nameEl = document.createElement('span');
      nameEl.className = 'vehicle-card-name';
      nameEl.textContent = v.name;

      const swatchEl = document.createElement('span');
      swatchEl.className = 'vehicle-card-swatch';
      swatchEl.style.setProperty('--veh-color', v.defaultColor);

      topRow.appendChild(nameEl);
      topRow.appendChild(swatchEl);

      const specsEl = document.createElement('div');
      specsEl.className = 'vehicle-card-specs';
      specsEl.textContent = compactSpecs(v);

      const footRow = document.createElement('div');
      footRow.className = 'vehicle-card-foot';

      const metaEl = document.createElement('span');
      metaEl.className = 'vehicle-card-meta';
      metaEl.style.fontSize = '10.5px';
      metaEl.style.color = 'var(--hud-muted)';
      metaEl.style.fontWeight = '800';

      const ctaEl = document.createElement('span');
      ctaEl.className = 'vehicle-card-cta';

      footRow.appendChild(metaEl);
      footRow.appendChild(ctaEl);

      card.appendChild(topRow);
      card.appendChild(specsEl);
      card.appendChild(footRow);
      vehicleGridEl.appendChild(card);

      cardNodes.push({ vehicle: v, card, swatchEl, metaEl, ctaEl });

      unsubs.push(
        bindHudTouchAction(
          card,
          () => {
            const colorHex = customPaintPickedInSession
              ? selectedPaintHex
              : (v.id === activeVehicleId ? activeColorHex : v.defaultColor);
            onSelectVehicle?.(v, colorHex);
            close();
          },
          { onAudioUnlock },
        ),
      );
    }
  }

  const syncState = (state = {}) => {
    if (state.activeVehicleId) activeVehicleId = String(state.activeVehicleId);
    if (state.activeColorHex) {
      activeColorHex = String(state.activeColorHex);
      selectedPaintHex = activeColorHex;
    }
    if (typeof state.cash === 'number' && Number.isFinite(state.cash)) {
      currentCash = state.cash;
    }
    if (state.ownedIds instanceof Set) {
      ownedIds = state.ownedIds;
    }
    if (state.vehicleLevels && typeof state.vehicleLevels === 'object') {
      vehicleLevels = state.vehicleLevels;
    }

    if (cashBadgeEl) {
      cashBadgeEl.textContent = formatCashBadge(currentCash);
    }

    syncPaintSelection(activeColorHex);

    for (let i = 0; i < cardNodes.length; i += 1) {
      const { vehicle: v, card, swatchEl, metaEl, ctaEl } = cardNodes[i];
      const owned = Boolean(v.freeStarter || ownedIds.has(v.id));
      const active = v.id === activeVehicleId;
      const lvl = Math.max(1, Number(vehicleLevels[v.id]) || 1);

      card.classList.toggle('is-active', active);
      card.classList.toggle('is-locked', !owned);
      card.setAttribute('aria-pressed', String(active));
      swatchEl.style.setProperty('--veh-color', active ? activeColorHex : v.defaultColor);

      if (owned) {
        metaEl.textContent = `LVL ${lvl}`;
        ctaEl.textContent = active ? 'ACTIVE' : 'SPAWN';
      } else if (currentCash >= v.price) {
        metaEl.textContent = `$${v.price.toLocaleString('en-US')}`;
        ctaEl.textContent = 'BUY';
      } else {
        metaEl.textContent = `$${v.price.toLocaleString('en-US')}`;
        ctaEl.textContent = 'TRY FREE';
      }
    }
  };

  const open = (state = {}) => {
    customPaintPickedInSession = false;
    syncState(state);
    if (modalBodyEl) {
      modalBodyEl.scrollTop = 0;
    }
    if (backdropEl) {
      backdropEl.hidden = false;
    }
    isOpen = true;
    onOpenChange?.(true);
    // Stamp openedAt LAST (immediately after unhiding) so Guardrail 4's 450 ms
    // check aligns strictly with DOM visibility mutation observers.
    openedAt = Math.max(1, nowMs());
  };

  const dispose = () => {
    close();
    for (let i = 0; i < unsubs.length; i += 1) {
      unsubs[i]();
    }
    unsubs.length = 0;
  };

  syncState({});

  return {
    open,
    close,
    isOpen: () => isOpen,
    syncState,
    dispose,
  };
}
