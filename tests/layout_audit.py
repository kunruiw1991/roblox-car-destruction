#!/usr/bin/env python3
"""Multi-viewport iPad Layout, Overlap, Touch Target & Center Clearance Audit.

Audits all 5 canonical iPad viewports (Landscape & Portrait) plus dynamic
no-reload runtime rotation (1180x820 -> 820x1180 -> 1180x820) across:
- title (initial #start-overlay)
- play_active (after touching #btn-play)
- modal_garage (#modal-garage)
- modal_teleport (#modal-teleport)

Checks (a)-(f):
(a) Zero horizontal/vertical scrollbars
(b) Zero clipped/offscreen HUD buttons and HUD strips
(c) Zero pairwise HUD overlaps (excluding ancestor containment & transparent wrappers)
(d) >= 44x44 px touch hit target floor on primary HUD buttons (43.5 px subpixel tol.)
(e) Dual unobstructed center 50% x 45% 3D viewport check (DOM + 3x3 elementFromPoint)
(f) Modal card viewport containment + hit-testable >= 24 px backdrop margin
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time
from typing import Any

sys.dont_write_bytecode = True

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
  sys.path.insert(0, _TESTS_DIR)

import cdp  # noqa: E402


AUDIT_LAYOUT_DOM_JS: str = r"""
((stateName, activeModalSel) => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const docEl = document.documentElement;
  const body = document.body;

  const PRIMARY_PLAY_BUTTON_IDS = [
    'btn-garage', 'btn-teleport', 'btn-camera', 'btn-ragdoll', 'btn-audio',
    'btn-steer-left', 'btn-steer-right',
    'btn-auto-smash', 'btn-tnt', 'btn-repair',
    'btn-brake', 'btn-gas', 'btn-boost',
  ];
  const HUD_INDICATOR_IDS = [
    'hud-integrity-bar', 'hud-integrity-value', 'hud-nitro-bar',
    'hud-cash', 'hud-parts', 'hud-level', 'hud-alert',
    'hud-leaderboard', 'hud-trick-feed', 'hud-speed-value', 'hud-gear-value',
  ];

  const isVisible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    let cur = el;
    while (cur && cur !== docEl) {
      if (cur.hasAttribute && cur.hasAttribute('hidden')) return false;
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      const cs = window.getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') <= 0.05) {
        return false;
      }
      cur = cur.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const parseAlpha = (rgbaStr) => {
    if (!rgbaStr || rgbaStr === 'transparent') return 0;
    const m = rgbaStr.match(/rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
    if (!m) return 0;
    return m[1] === undefined ? 1 : parseFloat(m[1]);
  };

  const hasVisiblePaint = (el, cs) => {
    if (parseAlpha(cs.backgroundColor) > 0.08) return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const sides = [
      [cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor],
      [cs.borderRightWidth, cs.borderRightStyle, cs.borderRightColor],
      [cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor],
      [cs.borderLeftWidth, cs.borderLeftStyle, cs.borderLeftColor],
    ];
    for (const [w, s, c] of sides) {
      if (parseFloat(w || '0') >= 1 && s && s !== 'none' && s !== 'hidden' && parseAlpha(c) > 0.08) {
        return true;
      }
    }
    return false;
  };

  const hasDirectText = (el) => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0) {
        return true;
      }
    }
    return false;
  };

  const roundRect = (r) => ({
    left: Math.round(r.left * 10) / 10,
    top: Math.round(r.top * 10) / 10,
    right: Math.round(r.right * 10) / 10,
    bottom: Math.round(r.bottom * 10) / 10,
    width: Math.round(r.width * 10) / 10,
    height: Math.round(r.height * 10) / 10,
  });

  const describeEl = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const txt = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? `("${txt}")` : ''}`;
  };

  const findScrollAncestor = (el, stopAt) => {
    let cur = el.parentElement;
    while (cur && cur !== stopAt && cur !== body && cur !== docEl) {
      const cs = window.getComputedStyle(cur);
      if (
        ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight + 2) ||
        ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && cur.scrollWidth > cur.clientWidth + 2)
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  };

  // (a) Zero Horizontal/Vertical Scrollbars
  const scrollbars = {
    innerWidth: vw,
    innerHeight: vh,
    docClientWidth: docEl.clientWidth,
    docClientHeight: docEl.clientHeight,
    docScrollWidth: docEl.scrollWidth,
    docScrollHeight: docEl.scrollHeight,
    bodyClientWidth: body ? body.clientWidth : vw,
    bodyClientHeight: body ? body.clientHeight : vh,
    bodyScrollWidth: body ? body.scrollWidth : vw,
    bodyScrollHeight: body ? body.scrollHeight : vh,
  };
  const hasScrollbar =
    scrollbars.docScrollWidth > scrollbars.docClientWidth + 1 ||
    scrollbars.docScrollHeight > scrollbars.docClientHeight + 1 ||
    scrollbars.docScrollWidth > vw + 1 ||
    scrollbars.docScrollHeight > vh + 1 ||
    scrollbars.bodyScrollWidth > vw + 1 ||
    scrollbars.bodyScrollHeight > vh + 1;

  // Locate active modal root if expected
  const activeModalEl = activeModalSel ? document.querySelector(activeModalSel) : null;
  const activeModalVisible = Boolean(activeModalEl && isVisible(activeModalEl));
  const modalMissing = Boolean(activeModalSel && !activeModalVisible);
  const scopeRoot = activeModalVisible ? activeModalEl : body;

  // Canvas fill check
  const canvasEl = document.getElementById('game-canvas') || document.querySelector('canvas');
  const canvasRect = canvasEl ? roundRect(canvasEl.getBoundingClientRect()) : null;
  const canvasFillsViewport = Boolean(
    canvasRect && canvasRect.width >= vw - 2 && canvasRect.height >= vh - 2
  );

  // Collect visible interactive controls within scopeRoot
  const rawButtons = Array.from(
    scopeRoot.querySelectorAll('button, [role="button"], [role="tab"]')
  ).filter((el) => {
    if (!isVisible(el)) return false;
    const cs = window.getComputedStyle(el);
    return cs.pointerEvents !== 'none';
  });
  const topButtons = rawButtons.filter(
    (el) => !rawButtons.some((other) => other !== el && other.contains(el))
  );

  const controls = [];
  for (const el of topButtons) {
    const rawR = el.getBoundingClientRect();
    const scrollAnc = activeModalVisible ? findScrollAncestor(el, activeModalEl) : null;
    const eff = { left: rawR.left, top: rawR.top, right: rawR.right, bottom: rawR.bottom };
    if (scrollAnc) {
      const sr = scrollAnc.getBoundingClientRect();
      eff.left = Math.max(eff.left, sr.left);
      eff.top = Math.max(eff.top, sr.top);
      eff.right = Math.min(eff.right, sr.right);
      eff.bottom = Math.min(eff.bottom, sr.bottom);
      if (eff.right - eff.left < 6 || eff.bottom - eff.top < 6) continue;
    }
    controls.push({
      el,
      id: el.id || '',
      inScrollList: Boolean(scrollAnc),
      isPaintSwatch: el.hasAttribute('data-paint-id'),
      desc: describeEl(el),
      rawRect: roundRect(rawR),
      rect: roundRect({
        left: eff.left, top: eff.top, right: eff.right, bottom: eff.bottom,
        width: eff.right - eff.left, height: eff.bottom - eff.top,
      }),
    });
  }

  // (b) Zero Offscreen / Clipped Interactive HUD Buttons & HUD Strips
  const offscreenControls = controls
    .filter((c) => !c.inScrollList && (
      c.rawRect.left < -1 || c.rawRect.top < -1 ||
      c.rawRect.right > vw + 1 || c.rawRect.bottom > vh + 1
    ))
    .map((c) => ({ desc: c.desc, rect: c.rawRect }));

  const offscreenHudStrips = [];
  if (!activeModalVisible && stateName !== 'title') {
    for (const hid of HUD_INDICATOR_IDS) {
      const el = document.getElementById(hid);
      if (!el || !isVisible(el)) continue;
      const r = roundRect(el.getBoundingClientRect());
      if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
        offscreenHudStrips.push({ desc: describeEl(el), rect: r });
      }
    }
  }

  const clippedText = [];
  for (const c of controls) {
    if (c.inScrollList) continue;
    const cs = window.getComputedStyle(c.el);
    if (
      (cs.overflowX === 'hidden' || cs.overflowX === 'clip') &&
      cs.textOverflow !== 'ellipsis' &&
      c.el.clientWidth > 0 &&
      c.el.scrollWidth > c.el.clientWidth + 2
    ) {
      clippedText.push({ desc: c.desc, scrollWidth: c.el.scrollWidth, clientWidth: c.el.clientWidth });
    }
  }

  // (c) Zero Pairwise Overlaps (Sibling Interactive Controls & Distinct HUD Panels)
  const collisionBoxes = controls.map((c) => ({
    el: c.el,
    kind: 'control',
    desc: c.desc,
    rect: c.rect,
  }));
  const trackedEls = new Set(controls.map((c) => c.el));

  if (!activeModalVisible && stateName !== 'title') {
    const uiRoot = document.getElementById('ui-layer') || body;
    const walkPanels = (node) => {
      for (const child of Array.from(node.children)) {
        if (!isVisible(child)) continue;
        const tag = child.tagName.toUpperCase();
        if (tag === 'CANVAS' || tag === 'SCRIPT' || tag === 'STYLE') continue;
        if (child.id === 'start-overlay' || child.classList.contains('modal-backdrop')) continue;
        if (trackedEls.has(child)) continue;
        const cs = window.getComputedStyle(child);
        const r = child.getBoundingClientRect();
        const isLargeWrapper = r.width >= vw * 0.55 || r.height >= vh * 0.45;
        const painted = hasVisiblePaint(child, cs);
        const interactive = cs.pointerEvents !== 'none';
        if (isLargeWrapper || (!painted && !interactive && !hasDirectText(child))) {
          walkPanels(child);
        } else {
          trackedEls.add(child);
          collisionBoxes.push({
            el: child,
            kind: 'hud_panel',
            desc: describeEl(child),
            rect: roundRect(r),
          });
        }
      }
    };
    walkPanels(uiRoot);

    // Explicitly track visible Contract #14 leaf HUD indicators so sibling
    // intra-panel overlaps (e.g. #btn-garage vs #hud-cash inside a painted
    // panel < 55% viewport width) are always caught while ancestor containment
    // checks still exempt parent-child boxes.
    for (const hid of HUD_INDICATOR_IDS) {
      const el = document.getElementById(hid);
      if (!el || !isVisible(el) || trackedEls.has(el)) continue;
      trackedEls.add(el);
      collisionBoxes.push({
        el,
        kind: 'hud_indicator',
        desc: describeEl(el),
        rect: roundRect(el.getBoundingClientRect()),
      });
    }
  }

  const overlaps = [];
  for (let i = 0; i < collisionBoxes.length; i++) {
    for (let j = i + 1; j < collisionBoxes.length; j++) {
      const a = collisionBoxes[i];
      const b = collisionBoxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ox = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const oy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (ox > 1.5 && oy > 1.5) {
        overlaps.push({
          a: a.desc,
          b: b.desc,
          ox: Math.round(ox * 10) / 10,
          oy: Math.round(oy * 10) / 10,
        });
      }
    }
  }

  // (d) Touch-Friendly Minimum Hit Size (>= 44x44 px on primary HUD buttons, 43.5 px tol.)
  const missingPrimaryButtons = [];
  if (stateName === 'title') {
    const playBtn = document.getElementById('btn-play');
    if (!playBtn || !isVisible(playBtn)) missingPrimaryButtons.push('#btn-play');
  } else if (!activeModalVisible) {
    for (const bid of PRIMARY_PLAY_BUTTON_IDS) {
      const el = document.getElementById(bid);
      if (!el || !isVisible(el)) missingPrimaryButtons.push(`#${bid}`);
    }
  }

  const undersizedControls = [];
  for (const c of controls) {
    const minPx = c.isPaintSwatch ? 36 : 44;
    const floor = minPx - 0.5;
    if (c.rawRect.width < floor || c.rawRect.height < floor) {
      undersizedControls.push({
        desc: c.desc,
        width: c.rawRect.width,
        height: c.rawRect.height,
        minRequired: minPx,
      });
    }
  }

  // (e) Unobstructed Central 3D Play Area (Center 50% x 45%: x 25..75%, y 27.5..72.5%)
  const centerZone = {
    left: Math.round(vw * 0.25 * 10) / 10,
    right: Math.round(vw * 0.75 * 10) / 10,
    top: Math.round(vh * 0.275 * 10) / 10,
    bottom: Math.round(vh * 0.725 * 10) / 10,
  };
  const centerObstructions = [];
  const centerHitFailures = [];
  const checkCenterClearance = !activeModalVisible && stateName !== 'title';

  if (checkCenterClearance) {
    const skipTags = new Set(['CANVAS', 'SCRIPT', 'STYLE', 'SVG', 'PATH', 'CIRCLE', 'RECT', 'LINE', 'POLYGON']);
    for (const el of Array.from(body.querySelectorAll('*'))) {
      if (!isVisible(el)) continue;
      if (skipTags.has(el.tagName.toUpperCase())) continue;
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const isFullViewportWrapper = r.width >= vw * 0.9 && r.height >= vh * 0.9;
      if (el.id === 'app' || el.id === 'ui-layer') continue;

      const blocksInput = cs.pointerEvents !== 'none';
      const painted = hasVisiblePaint(el, cs);
      const textBlocking = hasDirectText(el);
      if (isFullViewportWrapper && !blocksInput && !painted && !textBlocking) continue;
      if (!blocksInput && !painted && !textBlocking) continue;

      const ox = Math.min(r.right, centerZone.right) - Math.max(r.left, centerZone.left);
      const oy = Math.min(r.bottom, centerZone.bottom) - Math.max(r.top, centerZone.top);
      if (ox > 2 && oy > 2) {
        centerObstructions.push({
          desc: describeEl(el),
          rect: roundRect(r),
          overlap: { ox: Math.round(ox * 10) / 10, oy: Math.round(oy * 10) / 10 },
          pointerEvents: cs.pointerEvents,
          bg: cs.backgroundColor,
        });
      }
    }

    for (const fx of [0.32, 0.50, 0.68]) {
      for (const fy of [0.34, 0.50, 0.66]) {
        const px = Math.round(vw * fx);
        const py = Math.round(vh * fy);
        const hit = document.elementFromPoint(px, py);
        if (!hit || hit.tagName.toUpperCase() !== 'CANVAS') {
          centerHitFailures.push({
            x: px,
            y: py,
            hit: hit ? describeEl(hit) : null,
          });
        }
      }
    }
  }

  // (f) Modal Layout & Visible Hit-Testable Backdrop Margin (>= 24 px)
  let modalAudit = null;
  if (activeModalVisible) {
    const cardEl = activeModalEl.querySelector('.modal-card');
    const cardVisible = Boolean(cardEl && isVisible(cardEl));
    const mr = roundRect(activeModalEl.getBoundingClientRect());
    const cr = cardVisible ? roundRect(cardEl.getBoundingClientRect()) : null;
    const cardInBounds = Boolean(
      cr && cr.left >= -1 && cr.top >= -1 && cr.right <= vw + 1 && cr.bottom <= vh + 1
    );
    const margins = cr ? {
      left: Math.round(cr.left * 10) / 10,
      right: Math.round((vw - cr.right) * 10) / 10,
      top: Math.round(cr.top * 10) / 10,
      bottom: Math.round((vh - cr.bottom) * 10) / 10,
    } : { left: 0, right: 0, top: 0, bottom: 0 };
    const maxMargin = Math.max(margins.left, margins.right, margins.top, margins.bottom);

    let backdropPoint = null;
    if (cr) {
      const candidates = [
        [cr.left * 0.5, vh * 0.5],
        [cr.right + (vw - cr.right) * 0.5, vh * 0.5],
        [vw * 0.5, cr.top * 0.5],
        [vw * 0.5, cr.bottom + (vh - cr.bottom) * 0.5],
        [10, 10],
        [vw - 10, 10],
        [10, vh - 10],
        [vw - 10, vh - 10],
      ];
      for (const [cx, cy] of candidates) {
        if (cx < 2 || cx > vw - 2 || cy < 2 || cy > vh - 2) continue;
        const hit = document.elementFromPoint(cx, cy);
        if (hit === activeModalEl) {
          backdropPoint = { x: Math.round(cx), y: Math.round(cy) };
          break;
        }
      }
    }

    const closeBtn = activeModalEl.querySelector('#btn-garage-close, #btn-teleport-close');
    const closeOk = Boolean(closeBtn && isVisible(closeBtn));
    const itemCount = activeModalSel === '#modal-garage'
      ? activeModalEl.querySelectorAll('[data-vehicle-id]').length
      : activeModalEl.querySelectorAll('[data-zone-id]').length;

    modalAudit = {
      backdropRect: mr,
      cardVisible,
      cardRect: cr,
      cardInBounds,
      margins,
      maxMargin,
      backdropAccessible: maxMargin >= 24 && Boolean(backdropPoint),
      backdropPoint,
      closeOk,
      itemCount,
    };
  }

  const modalAuditOk = !activeModalSel || (
    !modalMissing &&
    Boolean(modalAudit) &&
    modalAudit.cardVisible &&
    modalAudit.cardInBounds &&
    modalAudit.backdropAccessible &&
    modalAudit.closeOk &&
    modalAudit.itemCount >= 1
  );

  const passed =
    !hasScrollbar &&
    !modalMissing &&
    (stateName === 'title' || activeModalVisible || canvasFillsViewport) &&
    missingPrimaryButtons.length === 0 &&
    offscreenControls.length === 0 &&
    offscreenHudStrips.length === 0 &&
    clippedText.length === 0 &&
    overlaps.length === 0 &&
    undersizedControls.length === 0 &&
    centerObstructions.length === 0 &&
    centerHitFailures.length === 0 &&
    modalAuditOk;

  return {
    state: stateName,
    viewport: `${vw}x${vh}`,
    passed,
    hasScrollbar,
    scrollbars,
    canvasFillsViewport,
    canvasRect,
    controlCount: controls.length,
    missingPrimaryButtons,
    offscreenControls,
    offscreenHudStrips,
    clippedText,
    overlaps,
    undersizedControls,
    centerZone,
    centerObstructions: centerObstructions.slice(0, 12),
    centerHitFailures,
    modalAudit,
  };
})
"""


def measure_layout_state(
    sess: cdp.CdpSession,
    state_name: str,
    active_modal_sel: str | None = None,
) -> dict[str, Any]:
  expr = f"({AUDIT_LAYOUT_DOM_JS})({json.dumps(state_name)}, {json.dumps(active_modal_sel)})"
  res = sess.eval_js(expr, await_promise=False)
  if not isinstance(res, dict):
    return {
        "state": state_name,
        "viewport": f"{sess.width}x{sess.height}",
        "passed": False,
        "error": "layout_eval_returned_non_dict",
    }
  return res


def _summarize_failures(res: dict[str, Any]) -> list[str]:
  reasons: list[str] = []
  if res.get("error"):
    reasons.append(f"error={res['error']}")
  if res.get("hasScrollbar"):
    reasons.append(f"scrollbars={res.get('scrollbars')}")
  if not res.get("canvasFillsViewport") and res.get("state") not in ("title", "modal_garage", "modal_teleport"):
    reasons.append(f"canvas_rect={res.get('canvasRect')}")
  if res.get("missingPrimaryButtons"):
    reasons.append(f"missing={res['missingPrimaryButtons']}")
  if res.get("offscreenControls"):
    reasons.append(f"offscreenControls={res['offscreenControls'][:3]}")
  if res.get("offscreenHudStrips"):
    reasons.append(f"offscreenHudStrips={res['offscreenHudStrips'][:3]}")
  if res.get("clippedText"):
    reasons.append(f"clippedText={res['clippedText'][:3]}")
  if res.get("overlaps"):
    reasons.append(f"overlaps={res['overlaps'][:3]}")
  if res.get("undersizedControls"):
    reasons.append(f"undersized={res['undersizedControls'][:3]}")
  if res.get("centerObstructions"):
    reasons.append(f"centerObstructions={res['centerObstructions'][:3]}")
  if res.get("centerHitFailures"):
    reasons.append(f"centerHitFailures={res['centerHitFailures'][:3]}")
  ma = res.get("modalAudit")
  if res.get("state") in ("modal_garage", "modal_teleport"):
    if not ma:
      reasons.append("modal_missing_or_hidden")
    else:
      if not ma.get("cardVisible") or not ma.get("cardInBounds"):
        reasons.append(f"modalCardBounds={ma.get('cardRect')}")
      if not ma.get("backdropAccessible"):
        reasons.append(f"backdropInaccessible(margins={ma.get('margins')})")
      if not ma.get("closeOk"):
        reasons.append("modalCloseButtonMissing")
      if int(ma.get("itemCount", 0)) < 1:
        reasons.append("modalItemCount<1")
  return reasons


def _parse_viewport_filter(vp_str: str | None) -> list[tuple[str, int, int, float, bool]]:
  if not vp_str:
    return list(cdp.IPAD_VIEWPORTS)
  parts = vp_str.lower().split("x")
  if len(parts) != 2:
    raise ValueError(f"Invalid --viewport format {vp_str!r}; expected WxH (e.g. 1180x820)")
  w, h = int(parts[0]), int(parts[1])
  for entry in cdp.IPAD_VIEWPORTS:
    if entry[1] == w and entry[2] == h:
      return [entry]
  return [(f"custom_{w}x{h}", w, h, 2.0, True)]


def run_layout_audit(
    *,
    root: str | Path = cdp.DEFAULT_PROJECT_ROOT,
    url: str | None = None,
    viewport_filter: str | None = None,
    shots_dir: str | Path | None = None,
    url_query: str = "",
) -> dict[str, Any]:
  root_path = Path(root).resolve()
  viewports = _parse_viewport_filter(viewport_filter)
  shots_path = Path(shots_dir).resolve() if shots_dir else None
  if shots_path is not None:
    shots_path.mkdir(parents=True, exist_ok=True)

  results: list[dict[str, Any]] = []
  telemetry_errors: list[dict[str, Any]] = []

  browser_root = None if url else root_path
  with cdp.CdpBrowser(root=browser_root) as browser:
    if url:
      target_url = url
      if url_query:
        sep = "&" if "?" in target_url else "?"
        target_url = f"{target_url}{sep}{url_query.lstrip('?')}"
    else:
      q = f"?{url_query.lstrip('?')}" if url_query else ""
      target_url = f"index.html{q}"

    for idx, (tag, w, h, dpr, mobile) in enumerate(viewports):
      with browser.new_session(
          width=w,
          height=h,
          dpr=dpr,
          mobile=mobile,
          install_preboot_spy=False,
          install_audio_spy=False,
          reuse_initial_tab=(idx == 0),
      ) as sess:
        loaded = sess.goto(
            target_url,
            wait_expr="typeof window.__ROBLOX_CAR_CRASH__ === 'object' && window.__ROBLOX_CAR_CRASH__ !== null",
            timeout_s=25.0,
        )
        if not loaded:
          results.append({
              "id": f"{tag}:boot",
              "tag": tag,
              "viewport": f"{w}x{h}",
              "state": "boot",
              "passed": False,
              "reasons": [f"page failed to boot {target_url}"],
          })
          continue

        sess.wait_raf(3)

        # 1. Title state
        r_title = measure_layout_state(sess, "title", None)
        r_title["id"] = f"{tag}:title"
        r_title["tag"] = tag
        r_title["reasons"] = _summarize_failures(r_title)
        results.append(r_title)

        # 2. Active gameplay state (tap #btn-play)
        try:
          sess.touch_tap_selector("#btn-play", timeout_s=4.0)
          sess.wait_for("window.__ROBLOX_CAR_CRASH__.getState().started === true", timeout_s=4.0)
          sess.wait_raf(3)
        except Exception as exc:
          results.append({
              "id": f"{tag}:play_active",
              "tag": tag,
              "viewport": f"{w}x{h}",
              "state": "play_active",
              "passed": False,
              "reasons": [f"failed to tap #btn-play: {exc}"],
          })
          continue

        r_play = measure_layout_state(sess, "play_active", None)
        r_play["id"] = f"{tag}:play_active"
        r_play["tag"] = tag
        r_play["reasons"] = _summarize_failures(r_play)
        results.append(r_play)
        if shots_path is not None:
          sess.capture_screenshot_jpeg(shots_path / f"{tag}_play.jpg", width=w, height=h, quality=88)

        # 3. Modal Garage state
        try:
          sess.touch_tap_selector("#btn-garage", timeout_s=3.0)
          sess.wait_for("window.__ROBLOX_CAR_CRASH__.getState().activeModal === 'garage'", timeout_s=3.0)
          sess.wait_raf(2)
        except Exception:
          pass
        r_gar = measure_layout_state(sess, "modal_garage", "#modal-garage")
        r_gar["id"] = f"{tag}:modal_garage"
        r_gar["tag"] = tag
        r_gar["reasons"] = _summarize_failures(r_gar)
        results.append(r_gar)
        try:
          sess.touch_tap_selector("#btn-garage-close", timeout_s=2.0)
          sess.wait_raf(2)
        except Exception:
          pass

        # 4. Modal Teleport state
        try:
          sess.touch_tap_selector("#btn-teleport", timeout_s=3.0)
          sess.wait_for("window.__ROBLOX_CAR_CRASH__.getState().activeModal === 'teleport'", timeout_s=3.0)
          sess.wait_raf(2)
        except Exception:
          pass
        r_tel = measure_layout_state(sess, "modal_teleport", "#modal-teleport")
        r_tel["id"] = f"{tag}:modal_teleport"
        r_tel["tag"] = tag
        r_tel["reasons"] = _summarize_failures(r_tel)
        results.append(r_tel)
        try:
          sess.touch_tap_selector("#btn-teleport-close", timeout_s=2.0)
          sess.wait_raf(2)
        except Exception:
          pass

        # Dynamic no-reload rotation sequence on 1180x820 session (when full matrix runs).
        if viewport_filter is None and w == 1180 and h == 820:
          for rot_id, rw, rh in (
              ("dynamic_rotate:1180x820->820x1180", 820, 1180),
              ("dynamic_rotate:820x1180->1180x820", 1180, 820),
          ):
            vp_info = sess.set_viewport(rw, rh, dpr=2.0, mobile=True, wait_frames=3)
            r_rot = measure_layout_state(sess, "play_active", None)
            r_rot["id"] = rot_id
            r_rot["tag"] = "dynamic_rotation"
            extra_reasons = _summarize_failures(r_rot)
            if vp_info.get("innerWidth") != rw or vp_info.get("innerHeight") != rh:
              extra_reasons.append(
                  f"viewport mismatch after rotate: expected {rw}x{rh}, got {vp_info}"
              )
              r_rot["passed"] = False
            r_rot["reasons"] = extra_reasons
            results.append(r_rot)

        snap = sess.snapshot_telemetry(pump_sec=0.05, allow_favicon_404=False)
        for k in (
            "console_errors",
            "exceptions",
            "http_errors",
            "network_failures",
            "log_errors",
            "server_http_errors",
            "window_errors",
        ):
          if snap.get(k):
            telemetry_errors.append({"viewport": f"{w}x{h}", "kind": k, "items": snap[k][:3]})

  total = len(results)
  passed_count = sum(1 for r in results if r.get("passed"))
  failed_count = total - passed_count
  all_passed = (failed_count == 0) and (total > 0) and (len(telemetry_errors) == 0)

  return {
      "suite": "layout_audit",
      "root": str(root_path),
      "url": url,
      "passed": all_passed,
      "summary": {
          "total": total,
          "passed": passed_count,
          "failed": failed_count,
          "telemetry_errors": len(telemetry_errors),
      },
      "telemetry_errors": telemetry_errors,
      "checks": results,
  }


def main(argv: list[str] | None = None) -> int:
  ap = argparse.ArgumentParser(
      description="5-Viewport iPad Layout, Overlap, Touch Target & Center Clearance Audit"
  )
  ap.add_argument("--root", default=str(cdp.DEFAULT_PROJECT_ROOT), help="Project root directory")
  ap.add_argument("--url", default=None, help="Optional live URL instead of local static server")
  ap.add_argument("--viewport", default=None, help="Optional single WxH viewport filter (e.g. 1180x820)")
  ap.add_argument("--shots-dir", default=None, help="Optional directory to save play-state JPEGs")
  ap.add_argument("--url-query", default="", help="Optional query string appended to page URL")
  ap.add_argument("--json-out", default=None, help="Optional path to write JSON report")
  args = ap.parse_args(argv)

  t0 = time.monotonic()
  report = run_layout_audit(
      root=args.root,
      url=args.url,
      viewport_filter=args.viewport,
      shots_dir=args.shots_dir,
      url_query=args.url_query,
  )
  elapsed = time.monotonic() - t0
  report["elapsed_s"] = round(elapsed, 2)

  print("=== IPAD MULTI-VIEWPORT LAYOUT AUDIT ===")
  for chk in report["checks"]:
    tag = "PASS" if chk.get("passed") else "FAIL"
    extra = ""
    if not chk.get("passed"):
      extra = f" -> {'; '.join(chk.get('reasons') or [])[:300]}"
    print(f"  [{tag}] {chk['id']} ({chk.get('viewport')}){extra}")

  if report["telemetry_errors"]:
    print(f"  [FAIL] Runtime telemetry errors: {report['telemetry_errors'][:3]}")

  s = report["summary"]
  print(
      f"SUMMARY: {s['passed']}/{s['total']} PASS | failed={s['failed']} | "
      f"telemetry_errors={s['telemetry_errors']} | elapsed={elapsed:.2f}s"
  )

  if args.json_out:
    out_p = Path(args.json_out)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    out_p.write_text(json.dumps(report, indent=2), encoding="utf-8")

  return 0 if report["passed"] else 1


if __name__ == "__main__":
  raise SystemExit(main())
