/**
 * TELEPORT TO Modal Controller (Contracts #3, #7, #14; WebKit Guardrails 3 & 4).
 *
 * - Pre-builds 5 [data-zone-cat] category tabs ('all' + 4 ZONE_CATEGORIES) and
 *   14 [data-zone-id] zone cards ONCE at initialization (zero listener leaks,
 *   zero-scroll fit across all 5 iPad viewports).
 * - Defaults to 'all' category on open so all 14 zones are immediately tappable.
 * - Enforces Guardrail 4 via bindModalBackdropDismiss() with openedAt initialized to
 *   Number.NaN when closed and stamped LAST inside open() immediately after unhiding.
 */

import { ZONE_CATEGORIES, ZONES } from '../data/zones.js';
import { bindHudTouchAction, bindModalBackdropDismiss } from '../core/touch_bind.js';

const SHORT_CATEGORY_LABELS = Object.freeze({
  all: 'All',
  crushers: 'Crushers',
  ramps: 'Ramps',
  arenas: 'Arenas',
  hazards: 'Hazards',
});

const SHORT_ZONE_DESCS = Object.freeze({
  hub_lab: 'Central hub, #101 turntable & breakable glass lab.',
  hydraulic_press: 'Drive into the bay & flatten your car from above.',
  wrecking_balls: 'Twin giant steel pendulums across a 2-lane gantry.',
  spinning_hammers: 'Four spinning orange arms that juggle & flip cars.',
  nail_hammer: 'Park on STRIKE ZONE & drop the giant Nail Hammer.',
  giant_hammer: 'Tall wooden DROP ZONE tower with chained barrel.',
  spike_drop: 'Park in the hazard box & rain spiked naval mines.',
  train_crossing: 'Park on the tracks vs. speeding diesel trains!',
  shredder_tunnels: 'Red, Green & Orange spiked steel drum shredders.',
  ski_jump: 'Boost past 50–1500 stud signs for mega trick air!',
  mega_ramp: 'Giant launch ramp, 360° silver loop & cash rings.',
  derby_arena: 'Banked multicolored Derby bowl + Car Football!',
  crash_c4_wall: 'Crash test runway straight into a C4 block wall.',
  lava_obby: 'Bridge fork: Checkmark ✓ safe or Skull ☠ catapult!',
});

const MAX_DESC_LEN = 52;

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function truncateWords(raw, maxLen = MAX_DESC_LEN) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  const sliced = s.slice(0, maxLen - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  const base = lastSpace > maxLen * 0.55 ? sliced.slice(0, lastSpace) : sliced;
  return `${base.replace(/[.,;:!?-]+$/, '').trimEnd()}…`;
}

/**
 * Hydrates #modal-teleport with 5 category tabs and 14 instant-warp zone cards.
 *
 * @param {object} callbacks
 */
export function createTeleportModal({
  onSelectZone,
  onOpenChange = null,
  onAudioUnlock = null,
}) {
  const backdropEl = typeof document !== 'undefined' ? document.getElementById('modal-teleport') : null;
  const closeBtn = typeof document !== 'undefined' ? document.getElementById('btn-teleport-close') : null;
  const zoneBadgeEl = typeof document !== 'undefined' ? document.getElementById('teleport-zone-badge') : null;
  const catTabsEl = typeof document !== 'undefined' ? document.getElementById('teleport-cat-tabs') : null;
  const zoneGridEl = typeof document !== 'undefined' ? document.getElementById('teleport-zone-grid') : null;
  const modalBodyEl = backdropEl ? backdropEl.querySelector('.modal-body') : null;

  let isOpen = false;
  let openedAt = Number.NaN;
  let activeCategory = 'all';
  let activeZoneId = 'hub_lab';

  const unsubs = [];
  /** @type {Array<{ id: string, btn: HTMLButtonElement }>} */
  const tabNodes = [];
  /** @type {Array<{ zone: object, card: HTMLButtonElement }>} */
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

  const setCategory = (catId) => {
    activeCategory = String(catId || 'all');

    for (let i = 0; i < tabNodes.length; i += 1) {
      const active = tabNodes[i].id === activeCategory;
      tabNodes[i].btn.classList.toggle('is-active', active);
      tabNodes[i].btn.setAttribute('aria-selected', String(active));
    }

    let visibleCount = 0;
    for (let i = 0; i < cardNodes.length; i += 1) {
      const { zone, card } = cardNodes[i];
      const show = activeCategory === 'all' || zone.category === activeCategory;
      card.hidden = !show;
      if (show) visibleCount += 1;
    }

    if (zoneBadgeEl) {
      zoneBadgeEl.textContent = `${visibleCount} ${visibleCount === 1 ? 'ZONE' : 'ZONES'}`;
    }
    if (modalBodyEl) {
      modalBodyEl.scrollTop = 0;
    }
  };

  // Mount-once: 5 category tabs ('all' + 4 ZONE_CATEGORIES)
  const tabs = [
    { id: 'all', icon: '\u{1F5FA}\uFE0F', label: 'All Zones', shortLabel: SHORT_CATEGORY_LABELS.all },
    ...ZONE_CATEGORIES.map((c) => ({
      id: c.id,
      icon: c.icon,
      label: c.label,
      shortLabel: SHORT_CATEGORY_LABELS[c.id] || c.label,
    })),
  ];

  if (catTabsEl) {
    catTabsEl.textContent = '';
    for (let i = 0; i < tabs.length; i += 1) {
      const tab = tabs[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'zone-cat-tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-zone-cat', tab.id);
      btn.setAttribute('aria-label', tab.label);
      btn.setAttribute('aria-selected', 'false');

      const iconSpan = document.createElement('span');
      iconSpan.setAttribute('aria-hidden', 'true');
      iconSpan.textContent = tab.icon;

      const labelSpan = document.createElement('span');
      labelSpan.textContent = tab.shortLabel;

      btn.appendChild(iconSpan);
      btn.appendChild(labelSpan);
      catTabsEl.appendChild(btn);

      tabNodes.push({ id: tab.id, btn });

      unsubs.push(
        bindHudTouchAction(
          btn,
          () => {
            setCategory(tab.id);
          },
          { onAudioUnlock },
        ),
      );
    }
  }

  // Mount-once: 14 zone cards ([data-zone-id])
  if (zoneGridEl) {
    zoneGridEl.textContent = '';
    for (let i = 0; i < ZONES.length; i += 1) {
      const z = ZONES[i];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'zone-card';
      card.setAttribute('data-zone-id', z.id);
      card.setAttribute('aria-label', `${z.name}: ${z.description}`);
      card.style.setProperty('--zone-accent', z.color);

      const nameEl = document.createElement('span');
      nameEl.className = 'zone-card-name';
      nameEl.textContent = z.name;

      const descEl = document.createElement('span');
      descEl.className = 'zone-card-desc';
      descEl.textContent = SHORT_ZONE_DESCS[z.id] || truncateWords(z.description, MAX_DESC_LEN);

      card.appendChild(nameEl);
      card.appendChild(descEl);
      zoneGridEl.appendChild(card);

      cardNodes.push({ zone: z, card });

      unsubs.push(
        bindHudTouchAction(
          card,
          () => {
            onSelectZone?.(z);
            close();
          },
          { onAudioUnlock },
        ),
      );
    }
  }

  const syncState = (state = {}) => {
    if (state.activeZoneId) {
      activeZoneId = String(state.activeZoneId);
    }
    for (let i = 0; i < cardNodes.length; i += 1) {
      const { zone, card } = cardNodes[i];
      const active = zone.id === activeZoneId;
      card.classList.toggle('is-active', active);
      card.setAttribute('aria-pressed', String(active));
    }
  };

  const open = (state = {}) => {
    syncState(state);
    setCategory('all');
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

  setCategory('all');
  syncState({});

  return {
    open,
    close,
    isOpen: () => isOpen,
    setCategory,
    syncState,
    dispose,
  };
}
