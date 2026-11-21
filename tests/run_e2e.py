#!/usr/bin/env python3
"""Opaque-Box iPad Touch E2E Test Suite (Tiers 1-4: 216 Named Cases).

Derived strictly from ORIGINAL_REQUEST.md, PROJECT.md § Interface Contract #14,
and TEST_INFRA.md:
- Tier 1 (93 cases): T1_F01_01..T1_F18_05 (Feature Coverage across F1-F18,
  covering all 12 vehicles, 9 paint swatches, 4 categories, 14 destruction zones)
- Tier 2 (90 cases): T2_F01_01..T2_F18_05 (Boundary Value Analysis & Negative
  Robustness: 5 per feature across F1-F18)
- Tier 3 (24 cases): T3_P01..T3_P14 (14 Vehicle x Zone pairs covering all 12
  vehicles and all 14 zones) + T3_P15..T3_P24 (10 Cross-UI/System pairs)
- Tier 4 (9 scenarios): T4_S01..T4_S09 uninterrupted touch-only family play
  sessions, including T4_S09 1280x800 RGB JPEG hero & 8-image Fable Play-First
  Audit screenshot pack.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
from pathlib import Path
import shutil
import sys
import tempfile
import time
from typing import Any, Callable
import urllib.parse

sys.dont_write_bytecode = True

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
  sys.path.insert(0, _TESTS_DIR)

from PIL import Image  # noqa: E402
import cdp  # noqa: E402
import layout_audit  # noqa: E402


VEHICLES_12: list[str] = [
    "sedan",
    "compact",
    "van",
    "box_truck",
    "semi_truck",
    "school_bus",
    "tuk_tuk",
    "pickup",
    "monster_truck",
    "smart_micro",
    "beetle",
    "rally_raider",
]

PAINT_SWATCHES_9: list[str] = [
    "red",
    "white",
    "blue",
    "yellow",
    "green",
    "cyan",
    "purple",
    "orange",
    "black",
]

ZONE_CATEGORIES_4: list[str] = [
    "crushers",
    "ramps",
    "arenas",
    "hazards",
]

ZONES_14: list[str] = [
    "hub_lab",
    "hydraulic_press",
    "wrecking_balls",
    "spinning_hammers",
    "nail_hammer",
    "giant_hammer",
    "spike_drop",
    "train_crossing",
    "shredder_tunnels",
    "ski_jump",
    "mega_ramp",
    "derby_arena",
    "crash_c4_wall",
    "lava_obby",
]

ACT1_CRUSHER_ZONES: list[tuple[str, str]] = [
    ("T1_F14_01", "hydraulic_press"),
    ("T1_F14_02", "wrecking_balls"),
    ("T1_F14_03", "spinning_hammers"),
    ("T1_F14_04", "nail_hammer"),
    ("T1_F14_05", "giant_hammer"),
    ("T1_F14_06", "spike_drop"),
    ("T1_F14_07", "train_crossing"),
]

ACT2_ZONES: list[tuple[str, str, bool]] = [
    ("T1_F15_01", "shredder_tunnels", True),
    ("T1_F15_02", "ski_jump", False),
    ("T1_F15_03", "mega_ramp", False),
    ("T1_F15_04", "derby_arena", True),
    ("T1_F15_05", "crash_c4_wall", True),
    ("T1_F15_06", "lava_obby", True),
]

TIER3_VEHICLE_ZONE_PAIRS: list[tuple[str, str, str, bool]] = [
    ("T3_P01", "sedan", "hub_lab", False),
    ("T3_P02", "compact", "hydraulic_press", True),
    ("T3_P03", "van", "wrecking_balls", True),
    ("T3_P04", "box_truck", "spinning_hammers", True),
    ("T3_P05", "semi_truck", "nail_hammer", True),
    ("T3_P06", "school_bus", "train_crossing", True),
    ("T3_P07", "tuk_tuk", "giant_hammer", True),
    ("T3_P08", "pickup", "derby_arena", True),
    ("T3_P09", "monster_truck", "spike_drop", True),
    ("T3_P10", "smart_micro", "shredder_tunnels", True),
    ("T3_P11", "beetle", "ski_jump", False),
    ("T3_P12", "rally_raider", "mega_ramp", False),
    ("T3_P13", "semi_truck", "crash_c4_wall", True),
    ("T3_P14", "tuk_tuk", "lava_obby", True),
]


# ---------------------------------------------------------------------------
# Case Recording & Shared Opaque-Box Interaction Helpers
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class CaseResult:
  case_id: str
  tier: int
  feature: str
  description: str
  passed: bool
  duration_ms: float
  detail: str = ""


class SuiteRecorder:
  def __init__(self, timeout_scale: float = 1.0) -> None:
    self.timeout_scale = max(0.25, float(timeout_scale))
    self.results: list[CaseResult] = []
    self._seen_ids: set[str] = set()

  def scale(self, sec: float) -> float:
    return float(sec) * self.timeout_scale

  def run_case(
      self,
      case_id: str,
      tier: int,
      feature: str,
      description: str,
      fn: Callable[[], str | None],
  ) -> bool:
    if case_id in self._seen_ids:
      raise ValueError(f"Duplicate test case id: {case_id}")
    self._seen_ids.add(case_id)
    t0 = time.monotonic()
    try:
      note = fn() or ""
      ok = True
      detail = str(note)
    except Exception as exc:
      ok = False
      detail = f"{type(exc).__name__}: {exc}"
    dur_ms = (time.monotonic() - t0) * 1000.0
    self.results.append(
        CaseResult(
            case_id=case_id,
            tier=tier,
            feature=feature,
            description=description,
            passed=ok,
            duration_ms=round(dur_ms, 1),
            detail=detail,
        )
    )
    tag = "PASS" if ok else "FAIL"
    suffix = f" | {detail[:180]}" if (detail and not ok) else ""
    print(f"  [{tag}] {case_id} (T{tier}/{feature}) {description}{suffix}")
    return ok


def _assert(cond: bool, msg: str) -> None:
  if not cond:
    raise AssertionError(msg)


def _best_effort(fn: Callable[[], Any]) -> Any:
  """Runs non-asserting inter-section housekeeping without crashing runner reporting."""
  try:
    return fn()
  except Exception:
    return None


def _crop_center_3d(img: Image.Image) -> Image.Image:
  """Crops to the HUD-free central 50% x 45% 3D viewport guaranteed by layout_audit.py."""
  w, h = img.size
  return img.crop((int(w * 0.25), int(h * 0.275), int(w * 0.75), int(h * 0.725)))


def _preplay_canvas_rgb_stats(sess: cdp.CdpSession, img: Image.Image) -> dict[str, Any]:
  """Computes RGB diversity stats strictly on exposed canvas pixels outside #start-overlay cards."""
  card_rects = sess.eval_js(
      """(() => {
        const vw = window.innerWidth, vh = window.innerHeight;
        const ov = document.getElementById('start-overlay');
        if (!ov) return [];
        const out = [];
        const isVis = (el) => {
          if (!el || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
          const cs = getComputedStyle(el);
          return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05;
        };
        const collect = (node) => {
          for (const child of Array.from(node.children)) {
            if (!isVis(child)) continue;
            const r = child.getBoundingClientRect();
            if (r.width <= 1 || r.height <= 1) continue;
            if (r.width >= vw * 0.9 && r.height >= vh * 0.9 && child.children.length > 0) {
              collect(child);
            } else {
              out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
            }
          }
        };
        if (isVis(ov)) collect(ov);
        return out;
      })()""",
      await_promise=False,
  ) or []

  rgb = img.convert("RGB")
  sw = 320
  sh = max(1, int(round(sw * rgb.height / max(1, rgb.width))))
  thumb = rgb.resize((sw, sh), Image.Resampling.BILINEAR)
  sx = sw / max(1.0, float(sess.width))
  sy = sh / max(1.0, float(sess.height))
  pad = 4.0
  scaled_rects = [
      (
          float(r["left"]) * sx - pad,
          float(r["top"]) * sy - pad,
          float(r["right"]) * sx + pad,
          float(r["bottom"]) * sy + pad,
      )
      for r in card_rects
  ]

  px = thumb.load()
  luma_sum = 0.0
  sat_sum = 0.0
  sum_r = sum_g = sum_b = 0.0
  sq_r = sq_g = sq_b = 0.0
  bins: set[tuple[int, int, int]] = set()
  count = 0

  for y in range(0, sh, 2):
    for x in range(0, sw, 2):
      if any(l <= x <= r and t <= y <= b for (l, t, r, b) in scaled_rects):
        continue
      r_v, g_v, b_v = px[x, y]
      count += 1
      sum_r += r_v
      sum_g += g_v
      sum_b += b_v
      sq_r += r_v * r_v
      sq_g += g_v * g_v
      sq_b += b_v * b_v
      luma_sum += 0.299 * r_v + 0.587 * g_v + 0.114 * b_v
      sat_sum += max(r_v, g_v, b_v) - min(r_v, g_v, b_v)
      bins.add((r_v >> 5, g_v >> 5, b_v >> 5))

  if count < 50:
    return cdp.image_rgb_stats(_crop_center_3d(rgb))

  mr, mg, mb = sum_r / count, sum_g / count, sum_b / count
  vr = max(0.0, sq_r / count - mr * mr)
  vg = max(0.0, sq_g / count - mg * mg)
  vb = max(0.0, sq_b / count - mb * mb)
  rgb_std = (math.sqrt(vr) + math.sqrt(vg) + math.sqrt(vb)) / 3.0
  return {
      "exposed_samples": count,
      "mean_luma": round(luma_sum / count, 2),
      "rgb_std": round(rgb_std, 2),
      "mean_saturation": round(sat_sum / count, 2),
      "unique_bins": len(bins),
  }


def _find_open_canvas_drag_segment(
    sess: cdp.CdpSession,
    dx_frac: float = -0.15,
    dy_frac: float = -0.02,
) -> tuple[float, float, float, float]:
  """Finds an unobstructed open-canvas drag segment inside the central play area."""
  seg = sess.eval_js(
      f"""(() => {{
        const vw = window.innerWidth, vh = window.innerHeight;
        const canvas = document.getElementById('game-canvas') || document.querySelector('canvas');
        const isCanvasAt = (x, y) => {{
          if (x < vw * 0.25 || x > vw * 0.75 || y < vh * 0.275 || y > vh * 0.725) return false;
          const hit = document.elementFromPoint(x, y);
          return Boolean(hit && (hit === canvas || hit.tagName.toUpperCase() === 'CANVAS'));
        }};
        const dx = Math.round(vw * ({float(dx_frac)}));
        const dy = Math.round(vh * ({float(dy_frac)}));
        const anchors = [
          [0.50, 0.50], [0.55, 0.48], [0.45, 0.52],
          [0.50, 0.42], [0.50, 0.58], [0.60, 0.50], [0.40, 0.50],
        ];
        for (const [fx, fy] of anchors) {{
          const x1 = Math.round(vw * fx);
          const y1 = Math.round(vh * fy);
          const x2 = Math.max(Math.round(vw * 0.27), Math.min(Math.round(vw * 0.73), x1 + dx));
          const y2 = Math.max(Math.round(vh * 0.29), Math.min(Math.round(vh * 0.71), y1 + dy));
          const xm = Math.round((x1 + x2) * 0.5);
          const ym = Math.round((y1 + y2) * 0.5);
          if (isCanvasAt(x1, y1) && isCanvasAt(xm, ym) && isCanvasAt(x2, y2)) {{
            return {{ found: true, x1, y1, x2, y2 }};
          }}
        }}
        return {{ found: false }};
      }})()""",
      await_promise=False,
  ) or {"found": False}
  _assert(seg.get("found"), f"No unobstructed open-canvas drag segment found in central viewport ({sess.width}x{sess.height})")
  return (float(seg["x1"]), float(seg["y1"]), float(seg["x2"]), float(seg["y2"]))


def _is_finite_num(v: Any) -> bool:
  return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def _vec3_finite(v: Any) -> bool:
  return isinstance(v, list) and len(v) == 3 and all(_is_finite_num(x) for x in v)


def _vec3_dist(a: list[float], b: list[float]) -> float:
  return math.sqrt(sum((float(a[i]) - float(b[i])) ** 2 for i in range(3)))


def _get_state(sess: cdp.CdpSession) -> dict[str, Any]:
  st = sess.eval_js("window.__ROBLOX_CAR_CRASH__.getState()", await_promise=False)
  _assert(isinstance(st, dict), f"getState() returned non-dict: {st!r}")
  return st


def _get_material_audit(sess: cdp.CdpSession) -> dict[str, Any]:
  aud = sess.eval_js("window.__ROBLOX_CAR_CRASH__.getMaterialAudit()", await_promise=False)
  _assert(isinstance(aud, dict), f"getMaterialAudit() returned non-dict: {aud!r}")
  return aud


def _get_canvas_stats(sess: cdp.CdpSession) -> dict[str, Any]:
  st = sess.eval_js("window.__ROBLOX_CAR_CRASH__.getCanvasStats()", await_promise=False)
  _assert(isinstance(st, dict), f"getCanvasStats() returned non-dict: {st!r}")
  return st


def _step_frames(sess: cdp.CdpSession, n: int = 20, dt: float = 1.0 / 60.0) -> None:
  sess.eval_js(
      f"""(() => {{
        const api = window.__ROBLOX_CAR_CRASH__;
        if (api && typeof api.stepFrames === 'function') {{
          api.stepFrames({int(n)}, {float(dt)});
          return true;
        }}
        return false;
      }})()""",
      await_promise=False,
  )


def _action_deltas(before: dict[str, Any], after: dict[str, Any]) -> dict[str, int]:
  out: dict[str, int] = {}
  for k in set(before.keys()) | set(after.keys()):
    d = int(after.get(k, 0)) - int(before.get(k, 0))
    if d != 0:
      out[str(k)] = d
  return out


def _assert_material_compliant(sess: cdp.CdpSession, ctx: str = "") -> dict[str, Any]:
  aud = _get_material_audit(sess)
  _assert(int(aud.get("checked", 0)) > 0, f"{ctx}: checked={aud.get('checked')} <= 0")
  if not aud.get("hasEnvironment"):
    max_m = float(aud.get("maxMetalness", 99.0))
    off = aud.get("offenders") or []
    _assert(max_m <= 0.22, f"{ctx}: maxMetalness={max_m} > 0.22 without environment")
    _assert(len(off) == 0, f"{ctx}: metalness offenders={off[:3]}")
  return aud


def _assert_state_finite(st: dict[str, Any], ctx: str = "") -> None:
  for k in ("integrity", "maxIntegrity", "detachedParts", "totalParts", "cash", "xp", "level", "speedKmh", "nitro", "cameraRoll"):
    _assert(_is_finite_num(st.get(k)), f"{ctx}: non-finite {k}={st.get(k)!r}")
  _assert(_vec3_finite(st.get("position")), f"{ctx}: non-finite position={st.get('position')!r}")
  _assert(_vec3_finite(st.get("velocity")), f"{ctx}: non-finite velocity={st.get('velocity')!r}")
  _assert(0.0 <= float(st["integrity"]) <= float(st["maxIntegrity"]) + 1e-6, f"{ctx}: integrity out of bounds ({st['integrity']}/{st['maxIntegrity']})")
  _assert(0 <= int(st["detachedParts"]) <= int(st["totalParts"]), f"{ctx}: detachedParts out of bounds ({st['detachedParts']}/{st['totalParts']})")
  _assert(-1e-6 <= float(st["nitro"]) <= 100.001, f"{ctx}: nitro out of [0,100] ({st['nitro']})")


def _close_modals(sess: cdp.CdpSession) -> None:
  for _ in range(3):
    st = _get_state(sess)
    if not st.get("activeModal"):
      return
    for sel in ("#btn-garage-close", "#btn-teleport-close"):
      info = sess.locate_selector(sel, timeout_s=0.15)
      if info.get("found"):
        sess.touch_tap(info["x"], info["y"], hold_ms=10)
        sess.wait_raf(1)
        if not _get_state(sess).get("activeModal"):
          return


def _ensure_started(sess: cdp.CdpSession, rec: SuiteRecorder) -> None:
  st = _get_state(sess)
  if not st.get("started"):
    sess.touch_tap_selector("#btn-play", timeout_s=rec.scale(4.0))
    ok = sess.wait_for("window.__ROBLOX_CAR_CRASH__.getState().started === true", timeout_s=rec.scale(4.0))
    _assert(ok, "Game did not transition to started=true after touching #btn-play")
    sess.wait_raf(1)


def _tap_fix(sess: cdp.CdpSession, rec: SuiteRecorder) -> dict[str, Any]:
  _close_modals(sess)
  sess.touch_tap_selector("#btn-repair", hold_ms=10, timeout_s=rec.scale(3.0))
  sess.wait_raf(1)
  st = _get_state(sess)
  _assert(
      float(st["integrity"]) >= float(st["maxIntegrity"]) - 0.1
      and int(st["detachedParts"]) == 0
      and not st.get("wrecked")
      and not st.get("onFire")
      and not st.get("ragdolling"),
      f"FIX (#btn-repair) did not fully recover vehicle (possible softlock): {st}",
  )
  return st


def _open_garage(sess: cdp.CdpSession, rec: SuiteRecorder) -> None:
  _close_modals(sess)
  sess.touch_tap_selector("#btn-garage", hold_ms=10, timeout_s=rec.scale(3.0))
  ok = sess.wait_for(
      "window.__ROBLOX_CAR_CRASH__.getState().activeModal === 'garage'",
      timeout_s=rec.scale(3.0),
  )
  _assert(ok, "#modal-garage failed to open via touch")
  sess.wait_raf(1)


def _select_vehicle(
    sess: cdp.CdpSession,
    rec: SuiteRecorder,
    vid: str,
    paint_id: str | None = None,
) -> dict[str, Any]:
  _open_garage(sess, rec)
  if paint_id is not None:
    psel = f'#modal-garage [data-paint-id="{paint_id}"]'
    pinfo = sess.locate_selector(psel, timeout_s=rec.scale(2.0), scroll_if_needed=True)
    _assert(pinfo.get("found"), f"Paint swatch not found: {psel}")
    sess.wait_raf(1)
    pinfo = sess.locate_selector(psel, timeout_s=0.5, scroll_if_needed=False)
    sess.touch_tap(pinfo["x"], pinfo["y"], hold_ms=10)
    sess.wait_raf(1)

  vsel = f'#modal-garage [data-vehicle-id="{vid}"]'
  vinfo = sess.locate_selector(vsel, timeout_s=rec.scale(2.0), scroll_if_needed=True)
  _assert(vinfo.get("found"), f"Vehicle selector not found: {vsel}")
  sess.wait_raf(1)

  vid_json = json.dumps(vid)
  candidates = sess.eval_js(
      f"""(() => {{
        const card = document.querySelector('#modal-garage [data-vehicle-id=' + {vid_json} + ']');
        if (!card) return [];
        const isDisabled = (el) => Boolean(
          el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('is-disabled')
        );
        const isVis = (el) => {{
          let cur = el;
          while (cur && cur !== document.documentElement) {{
            if (cur.hasAttribute && cur.hasAttribute('hidden')) return false;
            if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
            const cs = getComputedStyle(cur);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') <= 0.05) return false;
            cur = cur.parentElement;
          }}
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        }};
        const scoreBtn = (el) => {{
          const txt = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toUpperCase();
          const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
          if (el.hasAttribute('data-vehicle-try') || cls.includes('btn-try') || cls.includes('btn-spawn') || el.id === 'btn-garage-spawn') return 0;
          if (/\\b(TRY|SPAWN|DRIVE|SELECT|EQUIP|PLAY|USE)\\b/.test(txt)) return 1;
          if (cls.includes('btn-buy') || /\\bBUY\\b/.test(txt)) return 3;
          return 2;
        }};
        const nested = Array.from(card.querySelectorAll('button, [role="button"]'))
          .filter((b) => isVis(b) && !isDisabled(b));
        nested.sort((a, b) => scoreBtn(a) - scoreBtn(b));
        return nested.map((b, idx) => {{
          b.setAttribute('data-e2e-cand-idx', String(idx));
          return idx;
        }});
      }})()""",
      await_promise=False,
  ) or []

  if candidates:
    for idx in candidates:
      ok_scroll = sess.eval_js(
          f"""(() => {{
            const card = document.querySelector('#modal-garage [data-vehicle-id=' + {vid_json} + ']');
            const b = card ? card.querySelector('[data-e2e-cand-idx="{int(idx)}"]') : null;
            if (!b) return false;
            try {{ b.scrollIntoView({{ block: 'center', inline: 'nearest', behavior: 'instant' }}); }} catch (_) {{}}
            return true;
          }})()""",
          await_promise=False,
      )
      if not ok_scroll:
        continue
      sess.wait_raf(1)
      coords = sess.eval_js(
          f"""(() => {{
            const card = document.querySelector('#modal-garage [data-vehicle-id=' + {vid_json} + ']');
            const b = card ? card.querySelector('[data-e2e-cand-idx="{int(idx)}"]') : null;
            if (!b) return {{ found: false }};
            const r = b.getBoundingClientRect();
            if (r.width <= 1 || r.height <= 1) return {{ found: false }};
            return {{ found: true, x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }};
          }})()""",
          await_promise=False,
      ) or {"found": False}
      if coords.get("found"):
        sess.touch_tap(coords["x"], coords["y"], hold_ms=10)
        sess.wait_raf(1)
        if _get_state(sess).get("vehicleId") == vid:
          break
  else:
    vinfo = sess.locate_selector(vsel, timeout_s=0.5, scroll_if_needed=False)
    sess.touch_tap(vinfo["x"], vinfo["y"], hold_ms=10)
    sess.wait_raf(1)

  if _get_state(sess).get("vehicleId") != vid:
    footer_pts = sess.eval_js(
        f"""(() => {{
          const isDisabled = (el) => Boolean(
            el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('is-disabled')
          );
          const out = [];
          for (const s of ['[data-vehicle-try=' + {vid_json} + ']', '.btn-try', '.btn-spawn', '#btn-garage-spawn']) {{
            const requireModalLevel = (s === '.btn-try' || s === '.btn-spawn');
            let e = null;
            for (const cand of Array.from(document.querySelectorAll('#modal-garage ' + s))) {{
              if (isDisabled(cand)) continue;
              if (requireModalLevel && cand.closest('[data-vehicle-id]')) continue;
              e = cand;
              break;
            }}
            if (!e) continue;
            try {{ e.scrollIntoView({{ block: 'center', inline: 'nearest', behavior: 'instant' }}); }} catch (_) {{}}
            const r = e.getBoundingClientRect();
            if (r.width > 1 && r.height > 1) out.push({{ x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }});
          }}
          return out;
        }})()""",
        await_promise=False,
    ) or []
    for fpt in footer_pts:
      sess.touch_tap(fpt["x"], fpt["y"], hold_ms=10)
      sess.wait_raf(1)
      if _get_state(sess).get("vehicleId") == vid:
        break

  if _get_state(sess).get("vehicleId") != vid and candidates:
    vinfo = sess.locate_selector(vsel, timeout_s=0.5, scroll_if_needed=True)
    if vinfo.get("found"):
      sess.wait_raf(1)
      vinfo = sess.locate_selector(vsel, timeout_s=0.5, scroll_if_needed=False)
      sess.touch_tap(vinfo["x"], vinfo["y"], hold_ms=10)
      sess.wait_raf(1)

  sess.eval_js(
      "document.querySelectorAll('#modal-garage [data-e2e-cand-idx]').forEach((el) => el.removeAttribute('data-e2e-cand-idx')); true;",
      await_promise=False,
  )

  _close_modals(sess)
  st = _get_state(sess)
  _assert(st.get("vehicleId") == vid, f"Expected vehicleId={vid}, got {st.get('vehicleId')}")
  return st


def _open_teleport(sess: cdp.CdpSession, rec: SuiteRecorder) -> None:
  _close_modals(sess)
  sess.touch_tap_selector("#btn-teleport", hold_ms=10, timeout_s=rec.scale(3.0))
  ok = sess.wait_for(
      "window.__ROBLOX_CAR_CRASH__.getState().activeModal === 'teleport'",
      timeout_s=rec.scale(3.0),
  )
  _assert(ok, "#modal-teleport failed to open via touch")
  sess.wait_raf(1)


def _select_zone(sess: cdp.CdpSession, rec: SuiteRecorder, zid: str) -> dict[str, Any]:
  _open_teleport(sess, rec)
  zsel = f'#modal-teleport [data-zone-id="{zid}"]'
  info = sess.locate_selector(zsel, timeout_s=0.25, scroll_if_needed=True)
  if not info.get("found"):
    cats = sess.eval_js(
        """Array.from(document.querySelectorAll('#modal-teleport [data-zone-cat]'))
           .map((el) => el.getAttribute('data-zone-cat')).filter(Boolean)""",
        await_promise=False,
    ) or []
    for cat in cats:
      cinfo = sess.locate_selector(f'#modal-teleport [data-zone-cat="{cat}"]', timeout_s=0.4, scroll_if_needed=True)
      if cinfo.get("found"):
        sess.touch_tap(cinfo["x"], cinfo["y"], hold_ms=10)
        sess.wait_raf(1)
        info = sess.locate_selector(zsel, timeout_s=0.25, scroll_if_needed=True)
        if info.get("found"):
          break

  _assert(info.get("found"), f"Zone button {zsel} not found in #modal-teleport")
  info = sess.locate_selector(zsel, timeout_s=0.5, scroll_if_needed=False)
  sess.touch_tap(info["x"], info["y"], hold_ms=10)
  sess.wait_raf(1)
  _close_modals(sess)
  st = _get_state(sess)
  _assert(st.get("zoneId") == zid, f"Expected zoneId={zid}, got {st.get('zoneId')}")
  return st


def _find_backdrop_point(sess: cdp.CdpSession, modal_sel: str) -> dict[str, Any]:
  return sess.eval_js(
      f"""(() => {{
        const modal = document.querySelector({json.dumps(modal_sel)});
        if (!modal) return {{ found: false }};
        const vw = window.innerWidth, vh = window.innerHeight;
        const card = modal.querySelector('.modal-card');
        const cr = card ? card.getBoundingClientRect() : null;
        const cands = cr ? [
          [cr.left * 0.5, vh * 0.5],
          [cr.right + (vw - cr.right) * 0.5, vh * 0.5],
          [vw * 0.5, cr.top * 0.5],
          [vw * 0.5, cr.bottom + (vh - cr.bottom) * 0.5],
          [10, 10], [vw - 10, 10], [10, vh - 10], [vw - 10, vh - 10],
        ] : [[10, 10], [vw - 10, 10]];
        for (const [cx, cy] of cands) {{
          if (cx < 2 || cx > vw - 2 || cy < 2 || cy > vh - 2) continue;
          if (document.elementFromPoint(cx, cy) === modal) {{
            return {{ found: true, x: Math.round(cx), y: Math.round(cy) }};
          }}
        }}
        return {{ found: false }};
      }})()""",
      await_promise=False,
  ) or {"found": False}


def _find_inner_card_point(sess: cdp.CdpSession, modal_sel: str) -> dict[str, Any]:
  return sess.eval_js(
      f"""(() => {{
        const modal = document.querySelector({json.dumps(modal_sel)});
        const card = modal ? modal.querySelector('.modal-card') : null;
        if (!card) return {{ found: false }};
        const cr = card.getBoundingClientRect();
        const cands = [
          [cr.left + cr.width * 0.35, cr.top + 16],
          [cr.left + cr.width * 0.50, cr.top + 16],
          [cr.left + 18, cr.top + 16],
          [cr.left + cr.width * 0.50, cr.top + 28],
          [cr.left + 16, cr.bottom - 14],
        ];
        for (const [px, py] of cands) {{
          const h = document.elementFromPoint(px, py);
          if (h && card.contains(h) && !h.closest('button, [role="button"], input, a')) {{
            return {{ found: true, x: Math.round(px), y: Math.round(py) }};
          }}
        }}
        return {{ found: false }};
      }})()""",
      await_promise=False,
  ) or {"found": False}


def _run_zone_action(
    sess: cdp.CdpSession,
    rec: SuiteRecorder,
    *,
    expect_damage: bool = True,
    use_trigger: bool = True,
    use_boost: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
  before = _get_state(sess)
  sess.touch_tap_selector("#btn-auto-smash", timeout_s=rec.scale(3.0))
  if use_boost:
    binfo = sess.locate_selector("#btn-boost", timeout_s=0.3)
    if binfo.get("found"):
      with sess.hold_touches([("#btn-gas", 1), ("#btn-boost", 2)]):
        _step_frames(sess, 20, 1.0 / 60.0)

  def _is_damaged(st: dict[str, Any]) -> bool:
    return (
        float(st["integrity"]) < float(before["integrity"]) - 0.1
        or int(st["detachedParts"]) > int(before["detachedParts"])
        or bool(st.get("onFire"))
        or bool(st.get("wrecked"))
    )

  def _poll_and_tap_trigger() -> bool:
    if not use_trigger:
      return False
    tinfo = sess.locate_selector("#btn-machine-trigger", timeout_s=0.05)
    if tinfo.get("found") and tinfo.get("hitTestable"):
      sess.touch_tap(tinfo["x"], tinfo["y"], hold_ms=10)
      return True
    return False

  # Tap trigger immediately if already visible on the pad, then poll after each approach chunk.
  _poll_and_tap_trigger()

  max_chunks = 6 if expect_damage else 2
  after = before
  damaged = False
  for chunk_idx in range(max_chunks):
    _step_frames(sess, 45, 1.0 / 60.0)
    sess.wait_raf(1)
    after = _get_state(sess)
    _assert_state_finite(after, f"zone={after.get('zoneId')}")
    damaged = _is_damaged(after)
    if damaged:
      break
    if _poll_and_tap_trigger():
      _step_frames(sess, 30, 1.0 / 60.0)
      sess.wait_raf(1)
      after = _get_state(sess)
      _assert_state_finite(after, f"zone={after.get('zoneId')}")
      damaged = _is_damaged(after)
      if damaged:
        break
    if not expect_damage:
      moved = _vec3_dist(before["position"], after["position"]) > 1.0
      if (
          moved
          or float(after["speedKmh"]) > 8.0
          or float(after["cash"]) > float(before["cash"])
          or float(after["xp"]) > float(before["xp"])
      ):
        break

  if expect_damage:
    _assert(
        damaged,
        f"Expected visible damage in zone={after.get('zoneId')}, "
        f"before=(integrity={before['integrity']}, parts={before['detachedParts']}), "
        f"after=(integrity={after['integrity']}, parts={after['detachedParts']}, "
        f"onFire={after.get('onFire')}, wrecked={after.get('wrecked')})",
    )
  else:
    moved = _vec3_dist(before["position"], after["position"]) > 1.0
    progressed = (
        damaged
        or moved
        or float(after["speedKmh"]) > 8.0
        or float(after["cash"]) > float(before["cash"])
        or float(after["xp"]) > float(before["xp"])
    )
    _assert(progressed, f"Expected active movement/stunt/damage in zone={after.get('zoneId')}")
  return before, after


def _probe_modal_guard_timing(
    sess: cdp.CdpSession,
    btn_sel: str,
    modal_sel: str,
    early_ms: int,
    late_ms: int,
) -> dict[str, Any]:
  for attempt in range(3):
    _close_modals(sess)
    sess.wait_raf(2)
    binfo = sess.locate_selector(btn_sel, timeout_s=3.0)
    _assert(binfo.get("found"), f"Modal button {btn_sel} not found")
    sess.eval_js(
        f"""(() => {{
          const b = document.querySelector({json.dumps(btn_sel)});
          const m = document.querySelector({json.dumps(modal_sel)});
          window.__E2E_G4_T0__ = null;
          if (window.__E2E_G4_MO__) {{ try {{ window.__E2E_G4_MO__.disconnect(); }} catch (_) {{}} window.__E2E_G4_MO__ = null; }}
          const checkOpen = () => {{
            if (!m) return false;
            if (m.hidden || m.getAttribute('aria-hidden') === 'true') return false;
            const cs = getComputedStyle(m);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05;
          }};
          const checkOpenAnchor = () => {{
            if (Boolean(window.__ROBLOX_CAR_CRASH__?.getState?.().activeModal)) return true;
            return checkOpen();
          }};
          if (m) {{
            const mo = new MutationObserver(() => {{
              if (window.__E2E_G4_T0__ === null && checkOpenAnchor()) {{
                window.__E2E_G4_T0__ = performance.now();
                mo.disconnect();
              }}
            }});
            mo.observe(m, {{ attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style'] }});
            window.__E2E_G4_MO__ = mo;
          }}
          if (b) {{
            b.addEventListener('pointerdown', () => {{
              queueMicrotask(() => {{
                if (window.__E2E_G4_T0__ === null && checkOpenAnchor()) {{
                  window.__E2E_G4_T0__ = performance.now();
                }}
              }});
            }}, {{ capture: false, once: true }});
          }}
        }})()""",
        await_promise=False,
    )
    sess.touch_tap(binfo["x"], binfo["y"], hold_ms=15)
    probe = sess.eval_js(
        f"""(async () => {{
          const modal = document.querySelector({json.dumps(modal_sel)});
          if (!modal) return {{ error: 'missing' }};
          const isOpen = () => {{
            if (modal.hidden || modal.getAttribute('aria-hidden') === 'true') return false;
            const cs = getComputedStyle(modal);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05;
          }};
          const isOpenAnchor = () => Boolean(window.__ROBLOX_CAR_CRASH__?.getState?.().activeModal) || isOpen();
          if (window.__E2E_G4_T0__ === null) {{
            for (let k = 0; k < 4 && !isOpenAnchor(); k++) {{
              await new Promise((r) => requestAnimationFrame(r));
            }}
            if (window.__E2E_G4_T0__ === null && isOpenAnchor()) {{
              window.__E2E_G4_T0__ = performance.now();
            }}
          }}
          if (window.__E2E_G4_MO__) {{ try {{ window.__E2E_G4_MO__.disconnect(); }} catch (_) {{}} window.__E2E_G4_MO__ = null; }}
          const t0 = typeof window.__E2E_G4_T0__ === 'number' ? window.__E2E_G4_T0__ : performance.now();
          const vw = window.innerWidth, vh = window.innerHeight;
          const card = modal.querySelector('.modal-card');
          const cr = card ? card.getBoundingClientRect() : null;
          let bx = 8, by = 8;
          const cands = cr ? [
            [cr.left * 0.5, vh * 0.5],
            [cr.right + (vw - cr.right) * 0.5, vh * 0.5],
            [vw * 0.5, cr.top * 0.5],
            [vw * 0.5, cr.bottom + (vh - cr.bottom) * 0.5],
            [8, 8], [vw - 8, 8],
          ] : [[8, 8], [vw - 8, 8]];
          for (const [cx, cy] of cands) {{
            if (cx < 2 || cx > vw - 2 || cy < 2 || cy > vh - 2) continue;
            if (document.elementFromPoint(cx, cy) === modal) {{
              bx = Math.round(cx); by = Math.round(cy); break;
            }}
          }}
          const waitUntil = async (ms) => {{
            while (true) {{
              const el = performance.now() - t0;
              if (el >= ms) return Math.round(el * 10) / 10;
              await new Promise((r) => setTimeout(r, Math.max(1, Math.floor(ms - el))));
            }}
          }};
          const fireDown = () => modal.dispatchEvent(new PointerEvent('pointerdown', {{
            bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, clientX: bx, clientY: by
          }}));
          const tEarly = await waitUntil({int(early_ms)});
          fireDown();
          const openEarly = isOpen() && Boolean(window.__ROBLOX_CAR_CRASH__.getState().activeModal);
          const tLate = await waitUntil({int(late_ms)});
          fireDown();
          await new Promise((r) => requestAnimationFrame(r));
          const openLate = isOpen() || Boolean(window.__ROBLOX_CAR_CRASH__.getState().activeModal);
          return {{ tEarly, openEarly, tLate, openLate }};
        }})()""",
        await_promise=True,
    ) or {}
    if probe.get("tEarly", 999) < 446 or attempt == 2:
      return probe
  return {}


def _target_url(browser: cdp.CdpBrowser, live_url: str | None, url_query: str = "", path: str = "index.html") -> tuple[str, str]:
  if live_url:
    u = live_url
    if url_query:
      sep = "&" if "?" in u else "?"
      u = f"{u}{sep}{url_query.lstrip('?')}"
    p = urllib.parse.urlsplit(u)
    return u, f"{p.scheme}://{p.netloc}/"
  q = f"?{url_query.lstrip('?')}" if url_query else ""
  return f"{path}{q}", (browser.base_url or "http://127.0.0.1/")


# ---------------------------------------------------------------------------
# TIER 1: Feature Coverage (93 Named Cases: T1_F01_01 .. T1_F18_05)
# ---------------------------------------------------------------------------

def run_tier_1(
    browser: cdp.CdpBrowser,
    rec: SuiteRecorder,
    *,
    root: Path,
    live_url: str | None,
    url_query: str,
) -> None:
  print("\n=== TIER 1: Feature Coverage (93 Cases) ===")
  url, expected_origin = _target_url(browser, live_url, url_query)

  with browser.new_session(
      width=1180,
      height=820,
      dpr=2.0,
      mobile=True,
      install_preboot_spy=True,
      install_audio_spy=True,
      reuse_initial_tab=True,
  ) as sess:
    loaded = False
    boot_err = ""
    try:
      loaded = sess.goto(
          url,
          wait_expr="typeof window.__ROBLOX_CAR_CRASH__ === 'object' && window.__ROBLOX_CAR_CRASH__ !== null",
          timeout_s=rec.scale(25.0),
      )
      if loaded:
        sess.wait_raf(3)
    except Exception as exc:
      loaded = False
      boot_err = f"{type(exc).__name__}: {exc}"
    cold_snap = _best_effort(lambda: sess.snapshot_telemetry(pump_sec=0.1, allow_favicon_404=False)) or {
        "http_errors": [], "server_http_errors": [], "requested_urls": [], "responses": [],
        "console_errors": [], "exceptions": [], "network_failures": [], "window_errors": [],
    }
    cold_spy = _best_effort(sess.get_preboot_spy) or {}
    cold_state = _best_effort(lambda: _get_state(sess)) if loaded else {}
    if not isinstance(cold_state, dict):
      cold_state = {}

    # --- F1 (5) ---
    rec.run_case("T1_F01_01", 1, "F1", "Cold boot HTTP 200 and zero 4xx/5xx (incl. /favicon.ico)", lambda: (
        _assert(loaded, f"Page failed to boot: {url} ({boot_err or cold_snap.get('exceptions') or cold_snap.get('http_errors')})"),
        _assert(len(cold_snap["http_errors"]) == 0, f"HTTP errors: {cold_snap['http_errors'][:3]}"),
        _assert(len(cold_snap["server_http_errors"]) == 0, f"Server HTTP errors: {cold_snap['server_http_errors'][:3]}"),
        "0 HTTP errors",
    )[-1])

    def _f1_02() -> str:
      ext = [
          u for u in cold_snap["requested_urls"]
          if not u.startswith(("data:", "blob:", "about:", expected_origin))
      ]
      _assert(len(ext) == 0, f"External requests detected: {ext[:3]}")
      return f"all {len(cold_snap['requested_urls'])} requests on origin"
    rec.run_case("T1_F01_02", 1, "F1", "Zero external CDN/origin network requests", _f1_02)

    def _f1_03() -> str:
      hits = [
          r for r in cold_snap["responses"]
          if "vendor/three.module.min.js" in str(r.get("url", ""))
          and int(r.get("status", 0)) == 200
          and str(r.get("url", "")).startswith(expected_origin)
      ]
      _assert(len(hits) >= 1, "Expected HTTP 200 request for local vendor/three.module.min.js")
      return "vendor/three.module.min.js HTTP 200"
    rec.run_case("T1_F01_03", 1, "F1", "Local vendored vendor/three.module.min.js served HTTP 200", _f1_03)

    def _f1_04() -> str:
      has_svg = sess.eval_js(
          "Boolean(document.querySelector('link[rel*=\"icon\"][href^=\"data:image/svg+xml\"]'))",
          await_promise=False,
      )
      _assert(bool(has_svg), "Missing inline data:image/svg+xml favicon")
      if live_url is None:
        _assert((root / ".nojekyll").is_file(), "Missing .nojekyll in project root")
      fav_404 = [
          r for r in cold_snap["http_errors"]
          if "favicon.ico" in str(r.get("url", ""))
      ]
      _assert(len(fav_404) == 0, f"favicon.ico 404 detected: {fav_404}")
      return "inline SVG favicon + .nojekyll"
    rec.run_case("T1_F01_04", 1, "F1", "Inline SVG favicon & .nojekyll packaging hygiene", _f1_04)

    rec.run_case("T1_F01_05", 1, "F1", "Zero uncaught JS console errors, exceptions, or loading failures", lambda: (
        _assert(len(cold_snap["console_errors"]) == 0, f"console_errors={cold_snap['console_errors'][:3]}"),
        _assert(len(cold_snap["exceptions"]) == 0, f"exceptions={cold_snap['exceptions'][:3]}"),
        _assert(len(cold_snap["network_failures"]) == 0, f"network_failures={cold_snap['network_failures'][:3]}"),
        _assert(len(cold_snap["window_errors"]) == 0, f"window_errors={cold_snap['window_errors'][:3]}"),
        "clean console & network",
    )[-1])

    # --- F2 (5) ---
    def _f2_01() -> str:
      _assert(bool(cold_spy.get("firstRafDone")), f"firstRafDone false: {cold_spy}")
      _assert(int(cold_spy.get("preRafCompileShaders", -1)) == 0, f"preRafCompileShaders={cold_spy.get('preRafCompileShaders')}")
      _assert(int(cold_spy.get("preRafLinkPrograms", -1)) == 0, f"preRafLinkPrograms={cold_spy.get('preRafLinkPrograms')}")
      _assert(int(cold_spy.get("preRafDraws", -1)) == 0, f"preRafDraws={cold_spy.get('preRafDraws')}")
      _assert(len(cold_spy.get("compileMethodHits") or []) == 0, f"compileMethodHits={cold_spy.get('compileMethodHits')}")
      _assert(int(cold_spy.get("totalCompileShaders", 0)) > 0, "totalCompileShaders == 0 (no WebGL2 shader compiled)")
      return f"preRaf=0, totalCompileShaders={cold_spy.get('totalCompileShaders')}"
    rec.run_case("T1_F02_01", 1, "F2", "Pre-boot WebGL2 spy confirms zero pre-rAF shader compile/link/draw", _f2_01)

    rec.run_case("T1_F02_02", 1, "F2", "Telemetry seam confirms firstRafDone and zero compileBeforeFirstRaf", lambda: (
        _assert(bool(cold_state.get("firstRafDone")), f"seam firstRafDone={cold_state.get('firstRafDone')}"),
        _assert(not cold_state.get("compileBeforeFirstRaf"), f"seam compileBeforeFirstRaf={cold_state.get('compileBeforeFirstRaf')}"),
        "seam ok",
    )[-1])

    def _f2_03() -> str:
      cinfo = sess.locate_selector("#game-canvas", timeout_s=2.0)
      _assert(cinfo.get("found"), f"#game-canvas not visible: {cinfo}")
      _assert(float(cinfo["width"]) >= 600 and float(cinfo["height"]) >= 400, f"Canvas too small: {cinfo}")
      cs = _get_canvas_stats(sess)
      dpr = float(cs.get("dpr", 0))
      min_dpr = 0.5 if cs.get("isSoftwareGpu") else 1.0
      _assert(0.25 <= dpr <= 4.0 and dpr >= min_dpr, f"Bad dpr (min={min_dpr}): {cs}")
      _assert(int(cs.get("width", 0)) >= 280 and int(cs.get("height", 0)) >= 180, f"Bad canvasStats: {cs}")
      return f"{cs.get('width')}x{cs.get('height')} dpr={dpr} sw={cs.get('isSoftwareGpu')}"
    rec.run_case("T1_F02_03", 1, "F2", "#game-canvas visible and getCanvasStats() matches viewport", _f2_03)

    def _f2_04() -> str:
      f0 = int(_get_state(sess).get("frameCount", 0))
      time.sleep(rec.scale(0.35))
      f1 = int(_get_state(sess).get("frameCount", 0))
      _assert(f1 >= f0 + 2, f"rAF stalled: frameCount {f0} -> {f1}")
      return f"frameCount {f0} -> {f1}"
    rec.run_case("T1_F02_04", 1, "F2", "Active requestAnimationFrame loop increments frameCount", _f2_04)

    def _f2_05() -> str:
      st = _preplay_canvas_rgb_stats(sess, sess.capture_image())
      _assert(25.0 <= st["mean_luma"] <= 245.0, f"Blank/dark/white pre-play canvas luma={st['mean_luma']}")
      _assert(
          st["rgb_std"] >= 8.0 and st["unique_bins"] >= 8 and st.get("mean_saturation", 99.0) >= 10.0,
          f"Low pre-play canvas visual diversity (outside #start-overlay cards): {st}",
      )
      return f"luma={st['mean_luma']}, std={st['rgb_std']}, bins={st['unique_bins']}, sat={st.get('mean_saturation')}"
    rec.run_case("T1_F02_05", 1, "F2", "Non-blank colorful WebGL2 render on cold boot", _f2_05)

    # --- F3 (5) ---
    rec.run_case("T1_F03_01", 1, "F3", "Title scene getMaterialAudit() metalness <= 0.22 when env=null", lambda: (
        f"maxMetalness={_assert_material_compliant(sess, 'title').get('maxMetalness')}"
    ))

    # --- F4_01 starts gameplay via touch tap on #btn-play ---
    def _f4_01() -> str:
      _ensure_started(sess, rec)
      ov = sess.locate_selector("#start-overlay", timeout_s=0.1)
      _assert(not ov.get("found"), "#start-overlay still visible after touching #btn-play")
      return "started=true"
    rec.run_case("T1_F04_01", 1, "F4", "Single touch tap on #btn-play enters active gameplay", _f4_01)

    # Finish F3 (02..05)
    rec.run_case("T1_F03_02", 1, "F3", "Active play scene getMaterialAudit() metalness <= 0.22", lambda: (
        f"maxMetalness={_assert_material_compliant(sess, 'play_active').get('maxMetalness')}"
    ))

    def _f3_03() -> str:
      crop = _crop_center_3d(sess.capture_image())
      st = cdp.image_rgb_stats(crop)
      _assert(
          st["is_non_blank"] and st["mean_luma"] >= 45.0 and st["dark_pixel_frac"] <= 0.35 and st["rgb_std"] >= 8.0,
          f"Dark/blank/flat daylight scene: {st}",
      )
      return f"center luma={st['mean_luma']}, std={st['rgb_std']}, dark={st['dark_pixel_frac']}"
    rec.run_case("T1_F03_03", 1, "F3", "Bright daylight scene visibility (non-black MeshStandardMaterial)", _f3_03)

    rec.run_case("T1_F03_04", 1, "F3", "Vehicle switch (monster_truck) passes getMaterialAudit() <= 0.22", lambda: (
        _select_vehicle(sess, rec, "monster_truck"),
        f"maxMetalness={_assert_material_compliant(sess, 'monster_truck').get('maxMetalness')}",
    )[-1])

    rec.run_case("T1_F03_05", 1, "F3", "Zone warp (shredder_tunnels) passes getMaterialAudit() <= 0.22", lambda: (
        _select_zone(sess, rec, "shredder_tunnels"),
        f"maxMetalness={_assert_material_compliant(sess, 'shredder_tunnels').get('maxMetalness')}",
    )[-1])

    # Return cleanly to hub_lab + sedan (non-raising inter-section housekeeping)
    _best_effort(lambda: _select_zone(sess, rec, "hub_lab"))
    _best_effort(lambda: _select_vehicle(sess, rec, "sedan"))

    # Finish F4 (02..05)
    def _f4_02() -> str:
      before = _get_state(sess)
      sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(3.0))
      time.sleep(0.15)
      after = _get_state(sess)
      d = _action_deltas(before.get("hudActionCounts") or {}, after.get("hudActionCounts") or {})
      _assert(len(d) == 1 and sum(d.values()) == 1, f"#btn-camera tap delta expected +1, got {d}")
      _assert(after.get("cameraMode") != before.get("cameraMode"), "cameraMode did not change")
      return f"{before.get('cameraMode')} -> {after.get('cameraMode')}"
    rec.run_case("T1_F04_02", 1, "F4", "Single touch tap on #btn-camera fires exactly once", _f4_02)

    def _f4_03() -> str:
      before = _get_state(sess)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(3.0))
      time.sleep(0.15)
      after = _get_state(sess)
      d = _action_deltas(before.get("hudActionCounts") or {}, after.get("hudActionCounts") or {})
      _assert(len(d) == 1 and sum(d.values()) == 1, f"#btn-tnt tap delta expected +1, got {d}")
      _tap_fix(sess, rec)
      return f"delta={d}"
    rec.run_case("T1_F04_03", 1, "F4", "Single touch tap on #btn-tnt fires exactly once", _f4_03)

    def _f4_04() -> str:
      _tap_fix(sess, rec)
      before = _get_state(sess)
      try:
        sess.touch_hold_start_selector("#btn-gas", touch_id=None, timeout_s=rec.scale(3.0))
        _step_frames(sess, 25, 1.0 / 60.0)
        time.sleep(rec.scale(0.15))
        mid = _get_state(sess)
      finally:
        sess.touch_release_all()
      sess.wait_raf(2)
      moved = _vec3_dist(before["position"], mid["position"]) > 0.3
      _assert(float(mid["speedKmh"]) > 2.0 or moved, f"Gas hold did not accelerate: speed={mid['speedKmh']}, dist={_vec3_dist(before['position'], mid['position'])}")
      return f"speedKmh={mid['speedKmh']}"
    rec.run_case("T1_F04_04", 1, "F4", "Touch hold on #btn-gas accelerates and releases cleanly", _f4_04)

    def _f4_05() -> str:
      before = _get_state(sess)
      sess.keyboard_press("Enter", selector="#btn-camera")
      time.sleep(0.08)
      after = _get_state(sess)
      d = _action_deltas(before.get("hudActionCounts") or {}, after.get("hudActionCounts") or {})
      _assert(len(d) == 1 and sum(d.values()) == 1, f"Keyboard Enter on #btn-camera delta expected +1, got {d}")
      return f"keyboard Enter delta={d}"
    rec.run_case("T1_F04_05", 1, "F4", "Keyboard Enter accessibility fires #btn-camera once", _f4_05)

    # --- F5 (5) ---
    rec.run_case("T1_F05_01", 1, "F5", "Touch #btn-garage opens #modal-garage", lambda: (
        _open_garage(sess, rec),
        _assert(sess.locate_selector("#modal-garage", timeout_s=1.0).get("found"), "#modal-garage not visible"),
        "garage open",
    )[-1])

    rec.run_case("T1_F05_02", 1, "F5", "Touch #btn-garage-close immediately closes #modal-garage", lambda: (
        sess.touch_tap_selector("#btn-garage-close", timeout_s=rec.scale(2.0)),
        sess.wait_raf(2),
        _assert(not _get_state(sess).get("activeModal"), "#modal-garage stayed open"),
        "garage closed",
    )[-1])

    rec.run_case("T1_F05_03", 1, "F5", "Touch #btn-teleport opens #modal-teleport", lambda: (
        _open_teleport(sess, rec),
        _assert(sess.locate_selector("#modal-teleport", timeout_s=1.0).get("found"), "#modal-teleport not visible"),
        "teleport open",
    )[-1])

    rec.run_case("T1_F05_04", 1, "F5", "Touch #btn-teleport-close immediately closes #modal-teleport", lambda: (
        sess.touch_tap_selector("#btn-teleport-close", timeout_s=rec.scale(2.0)),
        sess.wait_raf(2),
        _assert(not _get_state(sess).get("activeModal"), "#modal-teleport stayed open"),
        "teleport closed",
    )[-1])

    def _f5_05() -> str:
      _open_garage(sess, rec)
      time.sleep(0.55)
      pt = _find_backdrop_point(sess, "#modal-garage")
      _assert(pt.get("found"), "No hit-testable backdrop coordinate found on #modal-garage")
      sess.touch_tap(pt["x"], pt["y"], hold_ms=15)
      sess.wait_raf(2)
      _assert(not _get_state(sess).get("activeModal"), "Backdrop tap after 550ms failed to dismiss #modal-garage")
      return f"dismissed at ({pt['x']},{pt['y']})"
    rec.run_case("T1_F05_05", 1, "F5", "Touch #modal-garage backdrop after 550ms dismisses modal", _f5_05)

    # --- F6 (5) ---
    _best_effort(lambda: _select_zone(sess, rec, "hub_lab"))
    _best_effort(lambda: _tap_fix(sess, rec))
    img_hub_crop: Image.Image | None = _best_effort(lambda: _crop_center_3d(sess.capture_image()))

    def _get_hub_crop() -> Image.Image:
      nonlocal img_hub_crop
      if img_hub_crop is None:
        img_hub_crop = _crop_center_3d(sess.capture_image())
      return img_hub_crop

    def _f6_01() -> str:
      st = cdp.image_rgb_stats(_get_hub_crop())
      _assert(st["is_non_blank"] and st["unique_bins"] >= 12 and st["mean_saturation"] >= 15.0 and st["rgb_std"] >= 8.0, f"Low visual polish in center 3D viewport: {st}")
      return f"bins={st['unique_bins']}, sat={st['mean_saturation']}, std={st['rgb_std']}"
    rec.run_case("T1_F06_01", 1, "F6", "Hub gameplay frame exhibits vibrant color diversity", _f6_01)

    def _f6_02() -> str:
      st = cdp.image_rgb_stats(_get_hub_crop())
      _assert(
          st["is_non_blank"]
          and st["mean_luma"] >= 45.0
          and st["rgb_std"] >= 8.0
          and (st["sky_blue_frac"] > 0.01 or st["turf_green_frac"] > 0.01),
          f"Missing daylight sky/turf cues in center 3D viewport: {st}",
      )
      return f"sky={st['sky_blue_frac']}, turf={st['turf_green_frac']}, std={st['rgb_std']}"
    rec.run_case("T1_F06_02", 1, "F6", "Roblox daylight sky & green turf cues visible", _f6_02)

    def _f6_03() -> str:
      _select_zone(sess, rec, "shredder_tunnels")
      sess.wait_raf(2)
      img_shred = _crop_center_3d(sess.capture_image())
      d = cdp.image_frame_delta(_get_hub_crop(), img_shred)
      _assert(d["mad"] >= 4.0, f"hub_lab vs shredder_tunnels too similar in center 3D viewport: {d}")
      return f"mad={d['mad']}"
    rec.run_case("T1_F06_03", 1, "F6", "Visual distinction between hub_lab and shredder_tunnels", _f6_03)

    def _f6_04() -> str:
      _select_zone(sess, rec, "ski_jump")
      sess.wait_raf(2)
      img_ski = _crop_center_3d(sess.capture_image())
      _select_zone(sess, rec, "lava_obby")
      sess.wait_raf(2)
      img_lava = _crop_center_3d(sess.capture_image())
      d = cdp.image_frame_delta(img_ski, img_lava)
      _assert(d["mad"] >= 4.0, f"ski_jump vs lava_obby too similar in center 3D viewport: {d}")
      return f"mad={d['mad']}"
    rec.run_case("T1_F06_04", 1, "F6", "Visual distinction between ski_jump and lava_obby", _f6_04)

    def _f6_05() -> str:
      _select_zone(sess, rec, "hub_lab")
      _tap_fix(sess, rec)
      im1 = _crop_center_3d(sess.capture_image())
      with sess.hold_touches([("#btn-gas", None)]):
        _step_frames(sess, 25, 1.0 / 60.0)
        time.sleep(rec.scale(0.15))
        im2 = _crop_center_3d(sess.capture_image())
      d = cdp.image_frame_delta(im1, im2)
      _assert(d["changed_px_frac"] > 0.0005, f"Center 3D canvas did not visually update during motion: {d}")
      return f"changed_px={d['changed_px_frac']}"
    rec.run_case("T1_F06_05", 1, "F6", "Active world motion produces visual frame updates", _f6_05)

    # --- F7 (5) ---
    def _f7_01() -> str:
      _assert(sess.locate_selector("#btn-audio", timeout_s=2.0).get("found"), "#btn-audio not visible")
      spy = sess.get_audio_spy()
      _assert(isinstance(spy, dict) and "createdBeforeGesture" in spy, f"Missing pre-boot audio spy: {spy}")
      _assert(int(spy.get("createdBeforeGesture", -1)) == 0, f"AudioContext constructed before user gesture: {spy}")
      return f"audioSpy={spy}"
    rec.run_case("T1_F07_01", 1, "F7", "Audio button #btn-audio visible with zero pre-gesture AudioContext", _f7_01)

    def _f7_02() -> str:
      spy = sess.get_audio_spy()
      _assert(int(spy.get("createdBeforeGesture", -1)) == 0, f"AudioContext constructed before gesture: {spy}")
      _assert(int(spy.get("createdCount", 0)) >= 1, f"Web Audio AudioContext never created after gesture: {spy}")
      sess.assert_zero_errors("T1_F07_02")
      return f"createdCount={spy.get('createdCount')}, lastState={spy.get('lastState')}, states={spy.get('states')}"
    rec.run_case("T1_F07_02", 1, "F7", "Post-gesture Web Audio unlock constructs AudioContext cleanly", _f7_02)

    def _f7_03() -> str:
      b_st = _get_state(sess)
      b_txt = sess.eval_js("(document.querySelector('#btn-audio')?.textContent || '').trim()", await_promise=False)
      sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0))
      sess.wait_raf(2)
      a_st = _get_state(sess)
      a_txt = sess.eval_js("(document.querySelector('#btn-audio')?.textContent || '').trim()", await_promise=False)
      d = _action_deltas(b_st.get("hudActionCounts") or {}, a_st.get("hudActionCounts") or {})
      _assert(sum(d.values()) == 1 or a_txt != b_txt, f"#btn-audio tap had no effect (delta={d}, txt={b_txt!r}->{a_txt!r})")
      return f"delta={d}, txt={b_txt!r}->{a_txt!r}"
    rec.run_case("T1_F07_03", 1, "F7", "Single touch tap on #btn-audio toggles mute", _f7_03)

    def _f7_04() -> str:
      b_st = _get_state(sess)
      b_txt = sess.eval_js("(document.querySelector('#btn-audio')?.textContent || '').trim()", await_promise=False)
      sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0))
      sess.wait_raf(2)
      a_st = _get_state(sess)
      a_txt = sess.eval_js("(document.querySelector('#btn-audio')?.textContent || '').trim()", await_promise=False)
      d = _action_deltas(b_st.get("hudActionCounts") or {}, a_st.get("hudActionCounts") or {})
      _assert(sum(d.values()) == 1 or a_txt != b_txt, f"Second #btn-audio tap had no effect (delta={d}, txt={b_txt!r}->{a_txt!r})")
      sess.assert_zero_errors("T1_F07_04")
      return f"unmuted delta={d}, txt={b_txt!r}->{a_txt!r}"
    rec.run_case("T1_F07_04", 1, "F7", "Second touch tap on #btn-audio restores sound", _f7_04)

    def _f7_05() -> str:
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 15, 1.0 / 60.0)
      _tap_fix(sess, rec)
      sess.assert_zero_errors("T1_F07_05")
      return "SFX triggers clean"
    rec.run_case("T1_F07_05", 1, "F7", "SFX triggers during TNT and repair produce zero WebAudio errors", _f7_05)

    # --- F8 (5) ---
    def _f8_01() -> str:
      # Cycle back to 'chase' if T1_F04_02/05 moved it.
      for _ in range(4):
        if _get_state(sess).get("cameraMode") == "chase":
          break
        sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(2.0))
        sess.wait_raf(1)
      st = _get_state(sess)
      _assert(st.get("cameraMode") == "chase", f"Expected chase mode, got {st.get('cameraMode')}")
      _assert(abs(float(st.get("cameraRoll", 1.0))) < 1e-4, f"Non-zero cameraRoll={st.get('cameraRoll')}")
      return "chase roll=0"
    rec.run_case("T1_F08_01", 1, "F8", "Chase camera mode has strictly zero cameraRoll", _f8_01)

    def _f8_02() -> str:
      seen = {_get_state(sess).get("cameraMode")}
      for _ in range(3):
        sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(2.0))
        sess.wait_raf(2)
        seen.add(_get_state(sess).get("cameraMode"))
      _assert(len(seen) >= 3, f"Expected >= 3 camera modes, saw {seen}")
      return f"modes={sorted(str(x) for x in seen)}"
    rec.run_case("T1_F08_02", 1, "F8", "Cycling #btn-camera visits chase, cockpit, and orbit_close", _f8_02)

    def _f8_03() -> str:
      for _ in range(3):
        st = _get_state(sess)
        _assert(abs(float(st.get("cameraRoll", 1.0))) < 1e-4, f"Non-zero cameraRoll={st.get('cameraRoll')} in {st.get('cameraMode')}")
        sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(2.0))
        sess.wait_raf(2)
      return "zero roll across all modes"
    rec.run_case("T1_F08_03", 1, "F8", "Zero cameraRoll invariant holds in every camera mode", _f8_03)

    def _f8_04() -> str:
      im1 = _crop_center_3d(sess.capture_image())
      x1, y1, x2, y2 = _find_open_canvas_drag_segment(sess, dx_frac=-0.15, dy_frac=-0.02)
      sess.touch_drag(x1, y1, x2, y2, steps=8, step_delay_ms=10, touch_id=1)
      sess.wait_raf(3)
      im2 = _crop_center_3d(sess.capture_image())
      st = _get_state(sess)
      d = cdp.image_frame_delta(im1, im2)
      _assert(abs(float(st.get("cameraRoll", 1.0))) < 1e-4, f"cameraRoll drifted after orbit drag: {st.get('cameraRoll')}")
      _assert(d["mad"] >= 0.5 or d["changed_px_frac"] > 0.002, f"Open-canvas orbit drag had no visual effect in center 3D viewport: {d}")
      return f"orbit mad={d['mad']}, roll=0"
    rec.run_case("T1_F08_04", 1, "F8", "Open-canvas 1-finger touch drag orbits camera with zero roll", _f8_04)

    def _f8_05() -> str:
      before = dict(_get_state(sess).get("hudActionCounts") or {})
      x1, y1, x2, y2 = _find_open_canvas_drag_segment(sess, dx_frac=0.14, dy_frac=0.0)
      sess.touch_drag(x1, y1, x2, y2, steps=6, step_delay_ms=10, touch_id=1)
      sess.wait_raf(2)
      after = dict(_get_state(sess).get("hudActionCounts") or {})
      d = _action_deltas(before, after)
      _assert(len(d) == 0, f"Open-canvas drag triggered HUD buttons: {d}")
      return "0 accidental HUD clicks"
    rec.run_case("T1_F08_05", 1, "F8", "Open-canvas touch drag triggers zero accidental HUD actions", _f8_05)

    # --- F9 (5) ---
    def _f9_01() -> str:
      _open_garage(sess, rec)
      found = sess.eval_js(
          "Array.from(document.querySelectorAll('#modal-garage [data-vehicle-id]')).map(e => e.getAttribute('data-vehicle-id'))",
          await_promise=False,
      ) or []
      missing = [v for v in VEHICLES_12 if v not in found]
      _close_modals(sess)
      _assert(not missing, f"Missing vehicles in Garage modal: {missing}")
      return f"{len(found)} vehicles listed"
    rec.run_case("T1_F09_01", 1, "F9", "Garage modal exposes all 12 canonical vehicle IDs", _f9_01)

    def _f9_02() -> str:
      _open_garage(sess, rec)
      found = sess.eval_js(
          "Array.from(document.querySelectorAll('#modal-garage [data-paint-id]')).map(e => e.getAttribute('data-paint-id'))",
          await_promise=False,
      ) or []
      missing = [p for p in PAINT_SWATCHES_9 if p not in found]
      _close_modals(sess)
      _assert(not missing, f"Missing paint swatches in Garage modal: {missing}")
      return f"{len(found)} swatches listed"
    rec.run_case("T1_F09_02", 1, "F9", "Garage modal exposes all 9 Roblox paint swatches", _f9_02)

    def _f9_03() -> str:
      for vid in VEHICLES_12[:6]:
        _select_vehicle(sess, rec, vid)
      return "6/6 Act I vehicles spawned"
    rec.run_case("T1_F09_03", 1, "F9", "Touch-spawning vehicles 1-6 (sedan..school_bus) updates vehicleId", _f9_03)

    def _f9_04() -> str:
      for vid in VEHICLES_12[6:]:
        _select_vehicle(sess, rec, vid)
      return "6/6 vehicles (tuk_tuk..rally_raider) spawned"
    rec.run_case("T1_F09_04", 1, "F9", "Touch-spawning vehicles 7-12 (tuk_tuk..rally_raider) updates vehicleId", _f9_04)

    def _f9_05() -> str:
      colors_seen: set[str] = set()
      for pid in ("blue", "yellow", "purple"):
        st = _select_vehicle(sess, rec, "sedan", paint_id=pid)
        colors_seen.add(str(st.get("vehicleColor") or ""))
        _assert_material_compliant(sess, f"paint:{pid}")
      _assert(len(colors_seen) >= 2, f"Paint swatch selection did not update vehicleColor: {colors_seen}")
      return f"colors={sorted(colors_seen)}"
    rec.run_case("T1_F09_05", 1, "F9", "Touch-selecting paint swatches updates vehicleColor cleanly", _f9_05)

    # --- F10 (5) ---
    _best_effort(lambda: _select_zone(sess, rec, "hub_lab"))
    _best_effort(lambda: _select_vehicle(sess, rec, "sedan"))
    _best_effort(lambda: _tap_fix(sess, rec))

    def _f10_01() -> str:
      st = _get_state(sess)
      _assert(int(st["totalParts"]) >= 10, f"Expected totalParts >= 10, got {st['totalParts']}")
      _assert(int(st["detachedParts"]) == 0, f"Expected detachedParts == 0, got {st['detachedParts']}")
      _assert(float(st["integrity"]) >= float(st["maxIntegrity"]) - 0.1, f"Expected full integrity, got {st['integrity']}")
      return f"totalParts={st['totalParts']}, intact"
    rec.run_case("T1_F10_01", 1, "F10", "Fresh vehicle has >= 10 detachable parts and 100% integrity", _f10_01)

    def _f10_02() -> str:
      before = _get_state(sess)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(3.0))
      _step_frames(sess, 25, 1.0 / 60.0)
      after = _get_state(sess)
      _assert(float(after["integrity"]) < float(before["integrity"]), f"TNT did not reduce integrity: {before['integrity']} -> {after['integrity']}")
      return f"integrity {before['integrity']} -> {after['integrity']}"
    rec.run_case("T1_F10_02", 1, "F10", "Impact/TNT reduces vehicle integrity below maxIntegrity", _f10_02)

    def _f10_03() -> str:
      for _ in range(3):
        if int(_get_state(sess)["detachedParts"]) >= 1:
          break
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 25, 1.0 / 60.0)
      st = _get_state(sess)
      _assert(int(st["detachedParts"]) >= 1, f"Expected >= 1 detached part after impacts, got {st['detachedParts']}")
      return f"detachedParts={st['detachedParts']}/{st['totalParts']}"
    rec.run_case("T1_F10_03", 1, "F10", "Sustained impact detaches >= 1 modular vehicle part", _f10_03)

    def _f10_04() -> str:
      txt = str(sess.eval_js("(document.querySelector('#hud-parts')?.textContent || '').trim()", await_promise=False) or "")
      _assert(bool(txt) and "NaN" not in txt and "undefined" not in txt, f"Invalid #hud-parts text: {txt!r}")
      return f"#hud-parts={txt!r}"
    rec.run_case("T1_F10_04", 1, "F10", "#hud-parts displays updated detached-part telemetry", _f10_04)

    rec.run_case("T1_F10_05", 1, "F10", "Tapping #btn-repair restores 100% integrity and 0 detached parts", lambda: (
        _tap_fix(sess, rec),
        "fully repaired",
    )[-1])

    # --- F11 (5) ---
    rec.run_case("T1_F11_01", 1, "F11", "Fresh vehicle starts with seated avatar (ragdolling === false)", lambda: (
        _assert(not _get_state(sess).get("ragdolling"), "Expected ragdolling=false on spawn"),
        "seated",
    )[-1])

    def _f11_02() -> str:
      before = _get_state(sess)
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(3.0))
      sess.wait_raf(2)
      after = _get_state(sess)
      d = _action_deltas(before.get("hudActionCounts") or {}, after.get("hudActionCounts") or {})
      _assert(bool(after.get("ragdolling")), f"Expected ragdolling=true after #btn-ragdoll, got {after.get('ragdolling')}")
      _assert(sum(d.values()) == 1, f"#btn-ragdoll expected +1 action delta, got {d}")
      return "ragdolling=true"
    rec.run_case("T1_F11_02", 1, "F11", "Touch tap on #btn-ragdoll ejects blocky avatar into ragdoll", _f11_02)

    def _f11_03() -> str:
      f0 = int(_get_state(sess)["frameCount"])
      _step_frames(sess, 15, 1.0 / 60.0)
      time.sleep(rec.scale(0.12))
      f1 = int(_get_state(sess)["frameCount"])
      _assert(f1 > f0, "rAF froze during ragdoll")
      sess.assert_zero_errors("T1_F11_03")
      return f"frames {f0} -> {f1}"
    rec.run_case("T1_F11_03", 1, "F11", "Active ragdoll physics runs smoothly with zero errors", _f11_03)

    rec.run_case("T1_F11_04", 1, "F11", "Tapping #btn-repair re-seats ragdolled avatar", lambda: (
        _tap_fix(sess, rec),
        "re-seated",
    )[-1])

    def _f11_05() -> str:
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0))
      sess.wait_raf(2)
      _assert(bool(_get_state(sess).get("ragdolling")), "Failed to enter ragdoll")
      st = _select_vehicle(sess, rec, "compact")
      _assert(not st.get("ragdolling"), "Vehicle switch did not reset ragdolling=false")
      return "reset on vehicle switch"
    rec.run_case("T1_F11_05", 1, "F11", "Switching vehicles after ragdoll cleanly re-seats avatar", _f11_05)

    # --- F12 (5) ---
    _best_effort(lambda: _select_vehicle(sess, rec, "sedan"))
    _best_effort(lambda: _tap_fix(sess, rec))

    def _f12_01() -> str:
      before = _get_state(sess)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 25, 1.0 / 60.0)
      after = _get_state(sess)
      _assert(float(after["integrity"]) < float(before["integrity"]) or float(after["cash"]) > float(before["cash"]), "TNT produced no explosion effect")
      return f"integrity={after['integrity']}"
    rec.run_case("T1_F12_01", 1, "F12", "Tapping #btn-tnt triggers explosion impact and VFX", _f12_01)

    def _f12_02() -> str:
      for _ in range(4):
        st = _get_state(sess)
        max_i = max(1.0, float(st["maxIntegrity"]))
        if st.get("onFire") or st.get("wrecked") or float(st["integrity"]) <= 0.45 * max_i:
          break
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 25, 1.0 / 60.0)
      st = _get_state(sess)
      max_i = max(1.0, float(st["maxIntegrity"]))
      _assert(
          bool(st.get("onFire")) or bool(st.get("wrecked")) or float(st["integrity"]) <= 0.45 * max_i,
          f"Expected fire/wrecked/heavy damage escalation (<=45% of {max_i}), got {st}",
      )
      return f"integrity={st['integrity']}/{max_i}, onFire={st.get('onFire')}, wrecked={st.get('wrecked')}"
    rec.run_case("T1_F12_02", 1, "F12", "Repeated heavy blasts escalate to smoke/fire/wrecked state", _f12_02)

    def _f12_03() -> str:
      st = _get_state(sess)
      alert_txt = str(sess.eval_js("(document.querySelector('#hud-alert')?.textContent || '').trim()", await_promise=False) or "")
      _assert(bool(st.get("lastAlert")) or bool(alert_txt), "Expected destruction alert text in lastAlert or #hud-alert")
      return f"alert={(st.get('lastAlert') or alert_txt)!r}"
    rec.run_case("T1_F12_03", 1, "F12", "Destruction alert banner/telemetry reports status", _f12_03)

    def _f12_04() -> str:
      _tap_fix(sess, rec)
      before = _get_state(sess)
      with sess.hold_touches([("#btn-gas", 1), ("#btn-boost", 2)]):
        _step_frames(sess, 25, 1.0 / 60.0)
        time.sleep(rec.scale(0.10))
        after = _get_state(sess)
      _assert(
          float(after["nitro"]) < float(before["nitro"]) - 1.0,
          f"Nitro boost did not consume nitro bar: before={before['nitro']}, after={after['nitro']}, speed={after['speedKmh']}",
      )
      return f"nitro {before['nitro']} -> {after['nitro']}, speed={after['speedKmh']}"
    rec.run_case("T1_F12_04", 1, "F12", "Holding #btn-boost activates Nitro boost & consumes Nitro bar", _f12_04)

    rec.run_case("T1_F12_05", 1, "F12", "Repair clears fire and wrecked VFX states cleanly", lambda: (
        _tap_fix(sess, rec),
        "fire/wrecked cleared",
    )[-1])

    # --- F13 (5) ---
    rec.run_case("T1_F13_01", 1, "F13", "Teleporting to hub_lab sets zoneId and finite position", lambda: (
        _assert_state_finite(_select_zone(sess, rec, "hub_lab"), "hub_lab"),
        "hub_lab ready",
    )[-1])

    rec.run_case("T1_F13_02", 1, "F13", "Auto-Smash in hub_lab drives/impacts glass lab cleanly", lambda: (
        _run_zone_action(sess, rec, expect_damage=False),
        "hub_lab action ok",
    )[-1])

    def _f13_03() -> str:
      st = cdp.image_rgb_stats(_crop_center_3d(sess.capture_image()))
      _assert(st["is_non_blank"] and st["mean_luma"] >= 45.0 and st["rgb_std"] >= 8.0, f"hub_lab center 3D frame issue: {st}")
      return f"luma={st['mean_luma']}, std={st['rgb_std']}"
    rec.run_case("T1_F13_03", 1, "F13", "hub_lab renders bright daylight non-blank scene", _f13_03)

    rec.run_case("T1_F13_04", 1, "F13", "hub_lab satisfies non-IBL metalness <= 0.22", lambda: (
        f"maxMetalness={_assert_material_compliant(sess, 'hub_lab').get('maxMetalness')}"
    ))

    rec.run_case("T1_F13_05", 1, "F13", "FIX cleanly resets vehicle in hub_lab", lambda: (
        _tap_fix(sess, rec),
        "hub_lab reset ok",
    )[-1])

    # --- F14 (7: all 7 Act I mechanical crushers & railroad train) ---
    for cid, zid in ACT1_CRUSHER_ZONES:
      def _make_act1(z: str = zid) -> str:
        _select_zone(sess, rec, z)
        _tap_fix(sess, rec)
        _, after = _run_zone_action(sess, rec, expect_damage=True, use_trigger=True)
        _tap_fix(sess, rec)
        return f"{z}: integrity={after['integrity']}, parts={after['detachedParts']}"
      rec.run_case(cid, 1, "F14", f"Act I zone {zid}: warp + crash/trigger damage + FIX", _make_act1)

    # --- F15 (6: all 6 Act II zones) ---
    for cid, zid, need_dmg in ACT2_ZONES:
      def _make_act2(z: str = zid, dmg: bool = need_dmg) -> str:
        _select_zone(sess, rec, z)
        _tap_fix(sess, rec)
        _, after = _run_zone_action(sess, rec, expect_damage=dmg, use_trigger=True, use_boost=(not dmg))
        _tap_fix(sess, rec)
        return f"{z}: integrity={after['integrity']}, speed={after['speedKmh']}"
      rec.run_case(cid, 1, "F15", f"Act II zone {zid}: warp + stunt/crush + FIX", _make_act2)

    # --- F16 (5) ---
    _best_effort(lambda: _select_zone(sess, rec, "hub_lab"))
    _best_effort(lambda: _tap_fix(sess, rec))

    def _f16_01() -> str:
      with sess.hold_touches([("#btn-gas", None)]):
        _step_frames(sess, 25, 1.0 / 60.0)
        mid = _get_state(sess)
      _assert(float(mid["speedKmh"]) > 2.0, f"Expected speedKmh > 2 on GAS, got {mid['speedKmh']}")
      return f"speed={mid['speedKmh']}"
    rec.run_case("T1_F16_01", 1, "F16", "Touch hold #btn-gas accelerates vehicle forward", _f16_01)

    def _f16_02() -> str:
      _tap_fix(sess, rec)
      before = _get_state(sess)
      with sess.hold_touches([("#btn-brake", None)]):
        _step_frames(sess, 30, 1.0 / 60.0)
        mid = _get_state(sess)
        gear = str(sess.eval_js("(document.querySelector('#hud-gear-value')?.textContent || '').trim()", await_promise=False) or "")
      moved = _vec3_dist(before["position"], mid["position"]) > 0.2
      _assert(gear.upper().startswith("R") or moved or float(mid["speedKmh"]) > 0.5, f"REV/brake inactive: gear={gear!r}, speed={mid['speedKmh']}")
      return f"gear={gear!r}, speed={mid['speedKmh']}"
    rec.run_case("T1_F16_02", 1, "F16", "Touch hold #btn-brake engages braking/reverse", _f16_02)

    def _f16_03() -> str:
      _tap_fix(sess, rec)
      before = _get_state(sess)
      with sess.hold_touches([("#btn-gas", None), ("#btn-steer-left", None)]):
        _step_frames(sess, 10, 1.0 / 60.0)
        mid = _get_state(sess)
        _step_frames(sess, 20, 1.0 / 60.0)
        after = _get_state(sess)
      _assert_state_finite(after, "T1_F16_03")
      dist = _vec3_dist(before["position"], after["position"])
      _assert(dist > 0.3 or float(after["speedKmh"]) > 2.0, "Multi-touch GAS+STEER did not move vehicle")
      # Verify genuine steering physics via velocity heading rotation and yaw-invariant perpendicular displacement.
      v1x, v1z = float(mid["velocity"][0]), float(mid["velocity"][2])
      v2x, v2z = float(after["velocity"][0]), float(after["velocity"][2])
      n1 = math.hypot(v1x, v1z)
      n2 = math.hypot(v2x, v2z)
      heading_sin = abs(v1x * v2z - v1z * v2x) / (n1 * n2) if (n1 > 0.2 and n2 > 0.2) else 0.0
      dx = float(after["position"][0]) - float(before["position"][0])
      dz = float(after["position"][2]) - float(before["position"][2])
      perp_disp = abs(dx * v1z - dz * v1x) / n1 if n1 > 0.2 else 0.0
      turned = heading_sin > 0.01 or perp_disp > 0.15
      _assert(
          turned,
          f"Steering physics did not turn vehicle during GAS+STEER-LEFT (heading_sin={heading_sin:.4f}, perp_disp={perp_disp:.3f})",
      )
      return f"dist={dist:.1f}, heading_sin={heading_sin:.3f}, perp_disp={perp_disp:.3f}"
    rec.run_case("T1_F16_03", 1, "F16", "Simultaneous multi-touch #btn-gas + #btn-steer-left drives & steers", _f16_03)

    def _f16_04() -> str:
      _tap_fix(sess, rec)
      before = _get_state(sess)
      with sess.hold_touches([("#btn-gas", 1), ("#btn-boost", 2)]):
        _step_frames(sess, 25, 1.0 / 60.0)
        after = _get_state(sess)
      _assert(
          float(after["nitro"]) < float(before["nitro"]) - 1.0,
          f"Multi-touch GAS+NOS did not consume Nitro: before={before['nitro']}, after={after['nitro']}, speed={after['speedKmh']}",
      )
      return f"nitro={after['nitro']}, speed={after['speedKmh']}"
    rec.run_case("T1_F16_04", 1, "F16", "Simultaneous multi-touch #btn-gas + #btn-boost accelerates with Nitro", _f16_04)

    def _f16_05() -> str:
      _select_zone(sess, rec, "hydraulic_press")
      _tap_fix(sess, rec)
      _, after = _run_zone_action(sess, rec, expect_damage=True)
      _tap_fix(sess, rec)
      return f"integrity={after['integrity']}"
    rec.run_case("T1_F16_05", 1, "F16", "One-tap #btn-auto-smash launches into nearest setup", _f16_05)

    # --- F17 (5) ---
    def _f17_01() -> str:
      texts = sess.eval_js(
          """(() => ({
            cash: (document.querySelector('#hud-cash')?.textContent || '').trim(),
            integrity: (document.querySelector('#hud-integrity-value')?.textContent || '').trim(),
            parts: (document.querySelector('#hud-parts')?.textContent || '').trim(),
            level: (document.querySelector('#hud-level')?.textContent || '').trim(),
          }))()""",
          await_promise=False,
      ) or {}
      _assert("$" in texts.get("cash", ""), f"Bad #hud-cash: {texts}")
      _assert("%" in texts.get("integrity", ""), f"Bad #hud-integrity-value: {texts}")
      for k, v in texts.items():
        _assert(bool(v) and "NaN" not in v and "undefined" not in v, f"Bad HUD text {k}={v!r}")
      return str(texts)
    rec.run_case("T1_F17_01", 1, "F17", "HUD displays valid formatted Cash, Integrity %, Parts, and Level", _f17_01)

    def _f17_02() -> str:
      before = _get_state(sess)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 25, 1.0 / 60.0)
      after = _get_state(sess)
      _assert(float(after["cash"]) > float(before["cash"]), f"Cash did not increase on crash: {before['cash']} -> {after['cash']}")
      return f"cash {before['cash']} -> {after['cash']}"
    rec.run_case("T1_F17_02", 1, "F17", "Destruction increases player Cash and updates #hud-cash", _f17_02)

    def _f17_03() -> str:
      _tap_fix(sess, rec)
      before = _get_state(sess)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 25, 1.0 / 60.0)
      after = _get_state(sess)
      _assert(float(after["xp"]) > float(before["xp"]) or int(after["level"]) > int(before["level"]), f"XP/level did not progress: {before['xp']}/{before['level']} -> {after['xp']}/{after['level']}")
      return f"xp {before['xp']} -> {after['xp']} (lvl {after['level']})"
    rec.run_case("T1_F17_03", 1, "F17", "Destruction increases per-car XP/Level", _f17_03)

    def _f17_04() -> str:
      st = _get_state(sess)
      feed = str(sess.eval_js("(document.querySelector('#hud-trick-feed')?.textContent || '').trim()", await_promise=False) or "")
      _assert(int(st.get("trickComboCount", 0)) >= 1 or len(feed) > 0, f"Trick/crash scorecard empty (count={st.get('trickComboCount')}, feed={feed!r})")
      return f"combo={st.get('trickComboCount')}, feed={feed[:40]!r}"
    rec.run_case("T1_F17_04", 1, "F17", "Trick/Crash Combo Scorecard records destruction activity", _f17_04)

    def _f17_05() -> str:
      lb = str(sess.eval_js("(document.querySelector('#hud-leaderboard')?.textContent || '').trim()", await_promise=False) or "")
      _assert(len(lb) > 0 and "NaN" not in lb, f"#hud-leaderboard empty or invalid: {lb!r}")
      return f"leaderboard={lb[:40]!r}"
    rec.run_case("T1_F17_05", 1, "F17", "#hud-leaderboard visible with valid score text", _f17_05)

    # --- F18 (5) ---
    _best_effort(lambda: _tap_fix(sess, rec))

    def _f18_01() -> str:
      needed = [
          "#btn-garage", "#btn-teleport", "#btn-camera", "#btn-ragdoll", "#btn-audio",
          "#btn-steer-left", "#btn-steer-right", "#btn-auto-smash", "#btn-tnt",
          "#btn-repair", "#btn-brake", "#btn-gas", "#btn-boost",
      ]
      missing = [s for s in needed if not sess.locate_selector(s, timeout_s=0.5).get("hitTestable")]
      _assert(not missing, f"Missing/occluded primary HUD buttons: {missing}")
      return f"{len(needed)}/13 buttons hit-testable"
    rec.run_case("T1_F18_01", 1, "F18", "All 13 primary iPad HUD buttons visible & hit-testable at 1180x820", _f18_01)

    def _f18_02() -> str:
      _open_teleport(sess, rec)
      cats = sess.eval_js(
          "Array.from(document.querySelectorAll('#modal-teleport [data-zone-cat]')).map(e => e.getAttribute('data-zone-cat'))",
          await_promise=False,
      ) or []
      _close_modals(sess)
      missing = [c for c in ZONE_CATEGORIES_4 if c not in cats]
      _assert(not missing, f"Missing Teleport category tabs: {missing}")
      return f"categories={cats}"
    rec.run_case("T1_F18_02", 1, "F18", "Teleport modal lists all 4 zone categories", _f18_02)

    def _f18_03() -> str:
      _open_teleport(sess, rec)
      seen: set[str] = set()
      seen.update(
          sess.eval_js(
              "Array.from(document.querySelectorAll('#modal-teleport [data-zone-id]')).map(e => e.getAttribute('data-zone-id'))",
              await_promise=False,
          ) or []
      )
      for cat in ZONE_CATEGORIES_4:
        cinfo = sess.locate_selector(f'#modal-teleport [data-zone-cat="{cat}"]', timeout_s=0.3)
        if cinfo.get("found"):
          sess.touch_tap(cinfo["x"], cinfo["y"], hold_ms=15)
          sess.wait_raf(1)
          seen.update(
              sess.eval_js(
                  "Array.from(document.querySelectorAll('#modal-teleport [data-zone-id]')).map(e => e.getAttribute('data-zone-id'))",
                  await_promise=False,
              ) or []
          )
      _close_modals(sess)
      missing = [z for z in ZONES_14 if z not in seen]
      _assert(not missing, f"Missing zone buttons in #modal-teleport: {missing}")
      return f"{len(seen)}/14 zones exposed"
    rec.run_case("T1_F18_03", 1, "F18", "All 14 destruction zones reachable via #modal-teleport", _f18_03)

    def _f18_04() -> str:
      _select_zone(sess, rec, "hub_lab")
      _tap_fix(sess, rec)
      with sess.hold_touches([("#btn-gas", None)]):
        _step_frames(sess, 25, 1.0 / 60.0)
        sp = str(sess.eval_js("(document.querySelector('#hud-speed-value')?.textContent || '').trim()", await_promise=False) or "")
        gr = str(sess.eval_js("(document.querySelector('#hud-gear-value')?.textContent || '').trim()", await_promise=False) or "")
      _assert(bool(sp) and "NaN" not in sp and bool(gr) and "NaN" not in gr, f"Bad speed/gear HUD: {sp!r} / {gr!r}")
      return f"speed={sp!r}, gear={gr!r}"
    rec.run_case("T1_F18_04", 1, "F18", "#hud-speed-value and #hud-gear-value update cleanly during driving", _f18_04)

    def _f18_05() -> str:
      r_play = layout_audit.measure_layout_state(sess, "play_active", None)
      _assert(r_play.get("passed"), f"1180x820 play_active layout failed: {layout_audit._summarize_failures(r_play)}")
      _open_garage(sess, rec)
      r_gar = layout_audit.measure_layout_state(sess, "modal_garage", "#modal-garage")
      _close_modals(sess)
      _assert(r_gar.get("passed"), f"1180x820 modal_garage layout failed: {layout_audit._summarize_failures(r_gar)}")
      _open_teleport(sess, rec)
      r_tel = layout_audit.measure_layout_state(sess, "modal_teleport", "#modal-teleport")
      _close_modals(sess)
      _assert(r_tel.get("passed"), f"1180x820 modal_teleport layout failed: {layout_audit._summarize_failures(r_tel)}")
      sess.assert_zero_errors("T1_F18_05")
      return "layout clean across play+modals"
    rec.run_case("T1_F18_05", 1, "F18", "Zero layout violations at 1180x820 across play & modal states", _f18_05)


# ---------------------------------------------------------------------------
# TIER 2: Boundary & Negative Robustness (90 Cases: T2_F01_01 .. T2_F18_05)
# ---------------------------------------------------------------------------

def run_tier_2(
    browser: cdp.CdpBrowser,
    rec: SuiteRecorder,
    *,
    root: Path,
    live_url: str | None,
    url_query: str,
) -> None:
  print("\n=== TIER 2: Boundary, Corner & Tier 5 Hardening Regressions (98 Cases) ===")
  url, _ = _target_url(browser, live_url, url_query)

  # --- F1 (5) ---
  def _t2_f01_01() -> str:
    if live_url is not None:
      with browser.new_session(width=1180, height=820, dpr=2.0, mobile=True) as s:
        ok = s.goto(url, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(20.0))
        _assert(ok, "Live subpath failed to load")
        s.assert_zero_errors("T2_F01_01")
      return "live subpath ok"
    with cdp.LocalStaticServer(root, strict_subpath="/roblox-car-destruction") as sub_srv:
      q = f"?{url_query.lstrip('?')}" if url_query else ""
      sub_url = f"{sub_srv.base_url}index.html{q}"
      with browser.new_session(width=1180, height=820, dpr=2.0, mobile=True, install_preboot_spy=True) as s:
        ok = s.goto(sub_url, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(20.0))
        _assert(ok, f"Subpath page failed to boot: {sub_url}")
        s.wait_raf(3)
        snap = s.snapshot_telemetry(allow_favicon_404=False)
        _assert(len(snap["http_errors"]) == 0, f"Subpath HTTP errors: {snap['http_errors'][:3]}")
        _assert(len(sub_srv.get_error_records(allow_favicon_404=False)) == 0, f"Subpath server errors: {sub_srv.get_error_records()[:3]}")
        _assert(len(snap["console_errors"]) == 0 and len(snap["exceptions"]) == 0, "Subpath console/exception error")
    return "strict subpath /roblox-car-destruction/ 0 errors"
  rec.run_case("T2_F01_01", 2, "F1", "Strict GitHub Pages subpath (/roblox-car-destruction/) loads with zero 404s", _t2_f01_01)

  with browser.new_session(
      width=1180,
      height=820,
      dpr=2.0,
      mobile=True,
      install_preboot_spy=True,
      install_audio_spy=True,
  ) as sess:
    def _t2_f01_02() -> str:
      q = f"{url_query}&v=1" if url_query else "v=1"
      u2, _ = _target_url(browser, live_url, q)
      ok = sess.goto(u2, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(20.0))
      _assert(ok, "Query-string reload failed")
      sess.wait_raf(3)
      sess.assert_zero_errors("T2_F01_02")
      return "query reload clean"
    rec.run_case("T2_F01_02", 2, "F1", "Query-string cache-busting reload (?v=1) yields zero 404s", _t2_f01_02)

    def _t2_f01_03() -> str:
      ok = sess.reset_page(url, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(20.0))
      _assert(ok, "Cold reset_page reload failed")
      sess.wait_raf(3)
      sess.assert_zero_errors("T2_F01_03")
      return "cold reload clean"
    rec.run_case("T2_F01_03", 2, "F1", "Fresh cold-tab reload produces HTTP 200 and zero console errors", _t2_f01_03)

    def _t2_f01_04() -> str:
      vp = str(sess.eval_js("document.querySelector('meta[name=\"viewport\"]')?.getAttribute('content') || ''", await_promise=False) or "").lower()
      _assert("viewport-fit=cover" in vp and "user-scalable=no" in vp, f"Bad viewport meta: {vp!r}")
      return vp
    rec.run_case("T2_F01_04", 2, "F1", "Viewport meta enforces viewport-fit=cover and user-scalable=no", _t2_f01_04)

    def _t2_f01_05() -> str:
      title = str(sess.eval_js("document.title || ''", await_promise=False) or "").strip()
      fav = str(sess.eval_js("document.querySelector('link[rel*=\"icon\"]')?.getAttribute('href') || ''", await_promise=False) or "")
      _assert(len(title) > 0, "Empty document.title")
      _assert(fav.startswith("data:image/svg+xml"), f"Non-SVG favicon: {fav[:40]!r}")
      return f"title={title!r}"
    rec.run_case("T2_F01_05", 2, "F1", "Document title non-empty and favicon is inline data:image/svg+xml", _t2_f01_05)

    # --- F2 (5) ---
    def _t2_f02_01() -> str:
      spy = sess.get_preboot_spy()
      _assert(int(spy.get("preRafCompileShaders", -1)) == 0, f"preRafCompileShaders={spy.get('preRafCompileShaders')}")
      _assert(int(spy.get("preRafLinkPrograms", -1)) == 0, f"preRafLinkPrograms={spy.get('preRafLinkPrograms')}")
      _assert(int(spy.get("preRafDraws", -1)) == 0, f"preRafDraws={spy.get('preRafDraws')}")
      _assert(int(spy.get("totalCompileShaders", 0)) > 0, "totalCompileShaders == 0")
      return "reload spy clean"
    rec.run_case("T2_F02_01", 2, "F2", "Post-reload WebGL2 pre-boot spy confirms zero pre-rAF draws/compiles", _t2_f02_01)

    _best_effort(lambda: _ensure_started(sess, rec))

    def _t2_f02_02() -> str:
      f0 = int(_get_state(sess)["frameCount"])
      _step_frames(sess, 10, 1.0 / 60.0)
      f1 = int(_get_state(sess)["frameCount"])
      _assert(f1 >= f0 + 10, f"stepFrames(10) did not advance frameCount ({f0} -> {f1})")
      return f"frameCount {f0} -> {f1}"
    rec.run_case("T2_F02_02", 2, "F2", "Deterministic stepFrames(10, 1/60) advances simulation cleanly", _t2_f02_02)

    def _t2_f02_03() -> str:
      for w, h in ((768, 1024), (1280, 800), (1180, 820)):
        sess.set_viewport(w, h, dpr=2.0, mobile=True, wait_frames=2)
        st = cdp.image_rgb_stats(_crop_center_3d(sess.capture_image()))
        _assert(st["is_non_blank"] and st["rgb_std"] >= 8.0, f"Blank/flat canvas after resize to {w}x{h}: {st}")
      return "non-blank across 3 resizes"
    rec.run_case("T2_F02_03", 2, "F2", "Rapid viewport resize preserves active non-blank WebGL2 canvas", _t2_f02_03)

    def _t2_f02_04() -> str:
      _select_vehicle(sess, rec, "school_bus")
      _select_zone(sess, rec, "shredder_tunnels")
      f0 = int(_get_state(sess)["frameCount"])
      time.sleep(rec.scale(0.25))
      f1 = int(_get_state(sess)["frameCount"])
      _assert(f1 > f0, f"rAF stopped after rapid switch: {f0} -> {f1}")
      return f"frames {f0} -> {f1}"
    rec.run_case("T2_F02_04", 2, "F2", "rAF loop remains active after rapid vehicle + zone switches", _t2_f02_04)

    def _t2_f02_05() -> str:
      cs = _get_canvas_stats(sess)
      dpr = float(cs.get("dpr", 0))
      min_dpr = 0.5 if cs.get("isSoftwareGpu") else 1.0
      _assert(
          int(cs.get("width", 0)) >= 280
          and int(cs.get("height", 0)) >= 180
          and 0.25 <= dpr <= 4.0
          and dpr >= min_dpr,
          f"Invalid canvasStats: {cs}",
      )
      return str(cs)
    rec.run_case("T2_F02_05", 2, "F2", "getCanvasStats() reports finite positive dimensions after resize", _t2_f02_05)

    # --- F3 (5) ---
    def _t2_f03_01() -> str:
      for vid in VEHICLES_12:
        _select_vehicle(sess, rec, vid)
        _assert_material_compliant(sess, f"T2_F03_01:{vid}")
      return "12/12 vehicles <= 0.22"
    rec.run_case("T2_F03_01", 2, "F3", "Rapid cycling all 12 vehicles stays strictly <= 0.22 metalness", _t2_f03_01)

    def _t2_f03_02() -> str:
      for pid in PAINT_SWATCHES_9:
        _select_vehicle(sess, rec, "sedan", paint_id=pid)
        _assert_material_compliant(sess, f"T2_F03_02:{pid}")
      return "9/9 paint swatches <= 0.22"
    rec.run_case("T2_F03_02", 2, "F3", "All 9 paint swatches stay strictly <= 0.22 metalness", _t2_f03_02)

    def _t2_f03_03() -> str:
      for _ in range(3):
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 20, 1.0 / 60.0)
      aud = _assert_material_compliant(sess, "T2_F03_03:wrecked")
      return f"wrecked maxMetalness={aud.get('maxMetalness')}"
    rec.run_case("T2_F03_03", 2, "F3", "Post-explosion / burning state stays <= 0.22 metalness", _t2_f03_03)

    rec.run_case("T2_F03_04", 2, "F3", "Post-FIX repaired state stays <= 0.22 metalness", lambda: (
        _tap_fix(sess, rec),
        f"maxMetalness={_assert_material_compliant(sess, 'T2_F03_04:repaired').get('maxMetalness')}",
    )[-1])

    def _t2_f03_05() -> str:
      _select_zone(sess, rec, "hub_lab")
      _select_vehicle(sess, rec, "sedan", paint_id="black")
      st = cdp.image_rgb_stats(_crop_center_3d(sess.capture_image()))
      _assert(st["is_non_blank"] and st["mean_luma"] >= 40.0 and st["rgb_std"] >= 8.0, f"Black paint rendered overly dark/blank scene: {st}")
      return f"black paint luma={st['mean_luma']}, std={st['rgb_std']}"
    rec.run_case("T2_F03_05", 2, "F3", "Darkest paint swatch (black) preserves bright daylight scene", _t2_f03_05)

    # --- F4 (5) ---
    def _delayed_click_check(sel: str, delay_ms: int, ctor: str, detail_val: int) -> str:
      _close_modals(sess)
      res = sess.eval_js(
          f"""(async () => {{
            const el = document.querySelector({json.dumps(sel)});
            if (!el) return {{ error: 'missing' }};
            const before = {{ ...(window.__ROBLOX_CAR_CRASH__.getState().hudActionCounts || {{}}) }};
            el.dispatchEvent(new PointerEvent('pointerdown', {{
              bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, pointerId: 71
            }}));
            el.dispatchEvent(new PointerEvent('pointerup', {{
              bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, pointerId: 71
            }}));
            await new Promise((r) => setTimeout(r, {int(delay_ms)}));
            const Ctor = ({json.dumps(ctor)} === 'PointerEvent' && typeof PointerEvent === 'function')
              ? PointerEvent : MouseEvent;
            const opts = {{ bubbles: true, cancelable: true, detail: {int(detail_val)} }};
            if (Ctor === PointerEvent) opts.pointerType = 'touch';
            el.dispatchEvent(new Ctor('click', opts));
            const after = {{ ...(window.__ROBLOX_CAR_CRASH__.getState().hudActionCounts || {{}}) }};
            return {{ before, after }};
          }})()""",
          await_promise=True,
      ) or {}
      d = _action_deltas(res.get("before") or {}, res.get("after") or {})
      _assert(len(d) == 1 and sum(d.values()) == 1, f"{sel} {delay_ms}ms delayed {ctor} click double-fired or dropped: {d}")
      return f"delta={d}"

    rec.run_case("T2_F04_01", 2, "F4", "600ms delayed MouseEvent click after pointerdown fires strictly once", lambda: _delayed_click_check("#btn-repair", 600, "MouseEvent", 1))
    rec.run_case("T2_F04_02", 2, "F4", "1200ms delayed PointerEvent click after pointerdown fires strictly once", lambda: _delayed_click_check("#btn-tnt", 1200, "PointerEvent", 1))
    rec.run_case("T2_F04_03", 2, "F4", "600ms Safari touch-click detail:0 quirk fires strictly once", lambda: _delayed_click_check("#btn-camera", 600, "PointerEvent", 0))

    def _t2_f04_04() -> str:
      def _steer_is_pressed() -> bool:
        return bool(
            sess.eval_js(
                "Boolean(document.querySelector('#btn-steer-left')?.classList.contains('is-pressed'))",
                await_promise=False,
            )
        )

      def _assert_straight_after_interrupt(label: str) -> float:
        with sess.hold_touches([("#btn-gas", None)]):
          _step_frames(sess, 10, 1.0 / 60.0)
          sv1 = _get_state(sess)
          _step_frames(sess, 15, 1.0 / 60.0)
          sv2 = _get_state(sess)
        vx1, vz1 = float(sv1["velocity"][0]), float(sv1["velocity"][2])
        vx2, vz2 = float(sv2["velocity"][0]), float(sv2["velocity"][2])
        sn1 = math.hypot(vx1, vz1)
        sn2 = math.hypot(vx2, vz2)
        _assert(
            sn1 > 0.2 and sn2 > 0.2,
            f"Post-{label} straight GAS check did not accelerate (n1={sn1:.2f}, n2={sn2:.2f})",
        )
        h_sin = abs(vx1 * vz2 - vz1 * vx2) / (sn1 * sn2)
        _assert(
            h_sin < 0.05,
            f"Stuck steering after {label}: straight GAS drive still curved (heading_sin={h_sin:.4f})",
        )
        return h_sin

      # Sub-check A: touch_cancel() ONLY (must release BOTH throttle AND steering)
      _tap_fix(sess, rec)
      try:
        sess.touch_hold_start_selector("#btn-gas", touch_id=1)
        sess.touch_hold_start_selector("#btn-steer-left", touch_id=2)
        _step_frames(sess, 20, 1.0 / 60.0)
        c0 = float(_get_state(sess)["speedKmh"])
        steer_had_a = _steer_is_pressed()
        _assert(c0 > 2.0, f"Sub-check A (touchCancel): GAS hold did not accelerate (s0={c0})")
        sess.touch_cancel()
        _step_frames(sess, 60, 1.0 / 60.0)
        c1 = float(_get_state(sess)["speedKmh"])
        _assert(
            (c1 < c0 * 0.78 or c1 < 3.0) and c1 < c0 - 0.5,
            f"Stuck throttle after touchCancel ONLY: speed did not decelerate ({c0} -> {c1})",
        )
        if steer_had_a:
          _assert(
              not _steer_is_pressed(),
              "Stuck steering after touchCancel ONLY: #btn-steer-left kept .is-pressed",
          )
        ha = _assert_straight_after_interrupt("touchCancel ONLY")
      finally:
        sess.touch_release_all()

      # Sub-check B: window.blur ONLY (must release BOTH throttle AND steering)
      _tap_fix(sess, rec)
      try:
        sess.touch_hold_start_selector("#btn-gas", touch_id=1)
        sess.touch_hold_start_selector("#btn-steer-left", touch_id=2)
        _step_frames(sess, 20, 1.0 / 60.0)
        b0 = float(_get_state(sess)["speedKmh"])
        steer_had_b = _steer_is_pressed()
        _assert(b0 > 2.0, f"Sub-check B (window.blur): GAS hold did not accelerate (s0={b0})")
        sess.eval_js("window.dispatchEvent(new Event('blur')); true;", await_promise=False)
        _step_frames(sess, 60, 1.0 / 60.0)
        b1 = float(_get_state(sess)["speedKmh"])
        _assert(
            (b1 < b0 * 0.78 or b1 < 3.0) and b1 < b0 - 0.5,
            f"Stuck throttle after window.blur ONLY: speed did not decelerate ({b0} -> {b1})",
        )
        if steer_had_b:
          _assert(
              not _steer_is_pressed(),
              "Stuck steering after window.blur ONLY: #btn-steer-left kept .is-pressed",
          )
        hb = _assert_straight_after_interrupt("window.blur ONLY")
      finally:
        sess.touch_release_all()
      return f"touchCancel {c0:.1f}->{c1:.1f} (h={ha:.3f}); blur {b0:.1f}->{b1:.1f} (h={hb:.3f})"
    rec.run_case("T2_F04_04", 2, "F4", "Multi-touch GAS+STEER releases cleanly on touchCancel alone AND window.blur alone", _t2_f04_04)

    def _t2_f04_05() -> str:
      before = dict(_get_state(sess).get("hudActionCounts") or {})
      info = sess.locate_selector("#btn-camera", timeout_s=2.0)
      _assert(info.get("found"), "#btn-camera not found")
      # Drag finger off button and release (no click event fired by browser).
      sess.touch_drag(info["x"], info["y"], max(5.0, info["x"] - 140.0), min(790.0, info["y"] + 140.0), steps=5, step_delay_ms=8, touch_id=1)
      sess.wait_raf(2)
      mid = dict(_get_state(sess).get("hudActionCounts") or {})
      d1 = _action_deltas(before, mid)
      _assert(len(d1) == 1 and sum(d1.values()) == 1, f"Drag-off pointerdown expected +1, got {d1}")
      sess.keyboard_press("Enter", selector="#btn-camera")
      time.sleep(0.08)
      after = dict(_get_state(sess).get("hudActionCounts") or {})
      d2 = _action_deltas(mid, after)
      _assert(len(d2) == 1 and sum(d2.values()) == 1, f"Keyboard Enter after drag-off blocked by sticky latch: {d2}")
      return f"drag-off={d1}, enter={d2}"
    rec.run_case("T2_F04_05", 2, "F4", "Drag-off touch cancel followed by keyboard Enter activates cleanly", _t2_f04_05)

    # --- F5 (5) ---
    g_probe2_cache: dict[str, Any] = {}

    def _t2_f05_01() -> str:
      p = _probe_modal_guard_timing(sess, "#btn-garage", "#modal-garage", early_ms=100, late_ms=485)
      _assert(not p.get("error"), f"Modal probe error: {p}")
      _assert(p.get("tEarly", 999) < 446 and bool(p.get("openEarly")), f"Closed at t+100ms: {p}")
      return f"t={p.get('tEarly')}ms open"
    rec.run_case("T2_F05_01", 2, "F5", "#modal-garage stays open on backdrop pointerdown at t+100ms", _t2_f05_01)

    def _t2_f05_02() -> str:
      p = _probe_modal_guard_timing(sess, "#btn-garage", "#modal-garage", early_ms=430, late_ms=485)
      g_probe2_cache.clear()
      g_probe2_cache.update(p)
      _assert(not p.get("error"), f"Modal probe error: {p}")
      _assert(p.get("tEarly", 999) < 446 and bool(p.get("openEarly")), f"Closed at t+430ms (<450ms): {p}")
      return f"t={p.get('tEarly')}ms open"
    rec.run_case("T2_F05_02", 2, "F5", "#modal-garage stays open on backdrop pointerdown at t+430ms (<450ms)", _t2_f05_02)

    def _t2_f05_03() -> str:
      p = g_probe2_cache if g_probe2_cache else _probe_modal_guard_timing(sess, "#btn-garage", "#modal-garage", early_ms=430, late_ms=485)
      _assert(not p.get("error"), f"Modal probe error: {p}")
      _assert(p.get("tLate", 0) >= 480 and not p.get("openLate"), f"Did not dismiss at t+485ms: {p}")
      return f"t={p.get('tLate')}ms closed"
    rec.run_case("T2_F05_03", 2, "F5", "#modal-garage dismisses on backdrop pointerdown at t+485ms (>=450ms)", _t2_f05_03)

    def _t2_f05_04() -> str:
      tp = _probe_modal_guard_timing(sess, "#btn-teleport", "#modal-teleport", early_ms=430, late_ms=490)
      _assert(not tp.get("error"), f"Modal probe error: {tp}")
      _assert(tp.get("tEarly", 999) < 446 and bool(tp.get("openEarly")), f"#modal-teleport closed early: {tp}")
      _assert(tp.get("tLate", 0) >= 485 and not tp.get("openLate"), f"#modal-teleport did not dismiss late: {tp}")
      return f"tEarly={tp['tEarly']}ms open, tLate={tp['tLate']}ms closed"
    rec.run_case("T2_F05_04", 2, "F5", "#modal-teleport enforces 450ms guard (430ms open -> 490ms closed)", _t2_f05_04)

    def _t2_f05_05() -> str:
      _open_garage(sess, rec)
      time.sleep(0.65)
      pt = _find_inner_card_point(sess, "#modal-garage")
      _assert(pt.get("found"), "Could not find inert inner .modal-card point")
      sess.touch_tap(pt["x"], pt["y"], hold_ms=15)
      sess.wait_raf(2)
      still = _get_state(sess).get("activeModal") == "garage"
      _close_modals(sess)
      _assert(still, "Tapping inner .modal-card at t+650ms unexpectedly dismissed #modal-garage")
      return f"stayed open at ({pt['x']},{pt['y']})"
    rec.run_case("T2_F05_05", 2, "F5", "Tapping inner .modal-card at t+650ms keeps modal open", _t2_f05_05)

    # --- F6 (5) ---
    def _t2_f06_01() -> str:
      with browser.new_session(width=1180, height=820, dpr=2.0, mobile=True) as s2:
        _assert(s2.goto(url, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(20.0)), "Boot failed")
        s2.wait_raf(3)
        st = _preplay_canvas_rgb_stats(s2, s2.capture_image())
        _assert(
            25.0 <= st["mean_luma"] <= 245.0
            and st["rgb_std"] >= 8.0
            and st.get("mean_saturation", 0.0) >= 10.0
            and st.get("unique_bins", 0) >= 12,
            f"Title screen canvas blank/flat (outside #start-overlay cards): {st}",
        )
        return f"title canvas std={st['rgb_std']}, bins={st['unique_bins']}, sat={st.get('mean_saturation')}"
    rec.run_case("T2_F06_01", 2, "F6", "Title overlay frame renders high-contrast non-blank visuals", _t2_f06_01)

    def _t2_f06_02() -> str:
      for pid in ("red", "yellow", "purple"):
        _select_vehicle(sess, rec, "sedan", paint_id=pid)
        st = cdp.image_rgb_stats(_crop_center_3d(sess.capture_image()))
        _assert(st["is_non_blank"] and st["rgb_std"] >= 8.0, f"Blank/flat render after swatch {pid}: {st}")
      return "3 swatches crisp"
    rec.run_case("T2_F06_02", 2, "F6", "Sequential paint swatch switches keep crisp non-blank render", _t2_f06_02)

    def _t2_f06_03() -> str:
      _select_zone(sess, rec, "crash_c4_wall")
      im1 = _crop_center_3d(sess.capture_image())
      _select_zone(sess, rec, "derby_arena")
      im2 = _crop_center_3d(sess.capture_image())
      d = cdp.image_frame_delta(im1, im2)
      _assert(d["mad"] >= 3.0, f"crash_c4_wall vs derby_arena too similar: {d}")
      return f"mad={d['mad']}"
    rec.run_case("T2_F06_03", 2, "F6", "Visual distinction between crash_c4_wall and derby_arena", _t2_f06_03)

    def _t2_f06_04() -> str:
      _select_zone(sess, rec, "train_crossing")
      im1 = _crop_center_3d(sess.capture_image())
      _select_zone(sess, rec, "giant_hammer")
      im2 = _crop_center_3d(sess.capture_image())
      d = cdp.image_frame_delta(im1, im2)
      _assert(d["mad"] >= 3.0, f"train_crossing vs giant_hammer too similar: {d}")
      return f"mad={d['mad']}"
    rec.run_case("T2_F06_04", 2, "F6", "Visual distinction between train_crossing and giant_hammer", _t2_f06_04)

    def _t2_f06_05() -> str:
      sess.set_viewport(820, 1180, dpr=2.0, mobile=True, wait_frames=2)
      st = cdp.image_rgb_stats(_crop_center_3d(sess.capture_image()))
      sess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=2)
      _assert(st["is_non_blank"] and st["mean_luma"] >= 40.0 and st["rgb_std"] >= 8.0, f"Portrait canvas issue: {st}")
      return f"portrait luma={st['mean_luma']}, std={st['rgb_std']}"
    rec.run_case("T2_F06_05", 2, "F6", "Portrait 820x1180 canvas renders bright non-blank visuals", _t2_f06_05)

    # --- F7 (5) ---
    def _t2_f07_01() -> str:
      before = dict(_get_state(sess).get("hudActionCounts") or {})
      for _ in range(5):
        sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0))
        sess.wait_raf(1)
      after = dict(_get_state(sess).get("hudActionCounts") or {})
      d = _action_deltas(before, after)
      _assert(sum(d.values()) == 5, f"5x audio toggle delta expected 5, got {d}")
      return f"delta={d}"
    rec.run_case("T2_F07_01", 2, "F7", "Rapid 5x mute/unmute taps fire exactly 5 times with zero errors", _t2_f07_01)

    rec.run_case("T2_F07_02", 2, "F7", "Muted driving + TNT + crash produces zero errors", lambda: (
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0)),
        _step_frames(sess, 15, 1.0 / 60.0),
        sess.assert_zero_errors("T2_F07_02"),
        "muted ok",
    )[-1])

    rec.run_case("T2_F07_03", 2, "F7", "Unmuting mid-crash produces zero WebAudio exceptions", lambda: (
        sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0)),
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0)),
        _tap_fix(sess, rec),
        sess.assert_zero_errors("T2_F07_03"),
        "unmuted mid-crash ok",
    )[-1])

    rec.run_case("T2_F07_04", 2, "F7", "Switching vehicles during muted state keeps audio clean", lambda: (
        sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0)),
        _select_vehicle(sess, rec, "monster_truck"),
        sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0)),
        sess.assert_zero_errors("T2_F07_04"),
        "clean",
    )[-1])

    def _t2_f07_05() -> str:
      sess.set_viewport(820, 1180, dpr=2.0, mobile=True, wait_frames=2)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      sess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=2)
      _tap_fix(sess, rec)
      sess.assert_zero_errors("T2_F07_05")
      return "rotation audio clean"
    rec.run_case("T2_F07_05", 2, "F7", "Viewport rotation during active SFX produces zero audio errors", _t2_f07_05)

    # --- F8 (5) ---
    def _t2_f08_01() -> str:
      for _ in range(6):
        sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(2.0))
        sess.wait_raf(1)
        _assert(abs(float(_get_state(sess)["cameraRoll"])) < 1e-4, "cameraRoll non-zero during rapid cycle")
      return "6 rapid cycles roll=0"
    rec.run_case("T2_F08_01", 2, "F8", "6 rapid #btn-camera cycles maintain cameraRoll === 0", _t2_f08_01)

    def _t2_f08_02() -> str:
      x1, y1, x2, y2 = _find_open_canvas_drag_segment(sess, dx_frac=-0.13, dy_frac=-0.11)
      sess.touch_drag(x1, y1, x2, y2, steps=8, step_delay_ms=8)
      sess.wait_raf(2)
      _assert(abs(float(_get_state(sess)["cameraRoll"])) < 1e-4, "diagonal orbit introduced roll")
      return "diagonal roll=0"
    rec.run_case("T2_F08_02", 2, "F8", "Diagonal open-canvas orbit drag keeps cameraRoll === 0", _t2_f08_02)

    def _t2_f08_03() -> str:
      x1, y1, x2, y2 = _find_open_canvas_drag_segment(sess, dx_frac=0.0, dy_frac=0.22)
      sess.touch_drag(x1, y1, x2, y2, steps=8, step_delay_ms=8)
      sess.touch_drag(x2, y2, x1, y1, steps=8, step_delay_ms=8)
      sess.wait_raf(2)
      _assert(abs(float(_get_state(sess)["cameraRoll"])) < 1e-4, "vertical pitch drag introduced roll")
      st = cdp.image_rgb_stats(_crop_center_3d(sess.capture_image()))
      _assert(st["is_non_blank"] and st["rgb_std"] >= 8.0, f"extreme pitch broke render: {st}")
      return "pitch clamp ok"
    rec.run_case("T2_F08_03", 2, "F8", "Extreme vertical open-canvas drag clamps pitch cleanly with roll === 0", _t2_f08_03)

    def _t2_f08_04() -> str:
      x1, y1, x2, y2 = _find_open_canvas_drag_segment(sess, dx_frac=-0.10, dy_frac=0.0)
      sess.touch_drag(x1, y1, x2, y2, steps=4, step_delay_ms=8, cancel=True)
      sess.wait_raf(2)
      _assert(abs(float(_get_state(sess)["cameraRoll"])) < 1e-4, "roll non-zero after touchCancel")
      return "touchCancel orbit ok"
    rec.run_case("T2_F08_04", 2, "F8", "Open-canvas drag aborted by touchCancel leaves HUD responsive", _t2_f08_04)

    def _t2_f08_05() -> str:
      for _ in range(4):
        if _get_state(sess).get("cameraMode") == "cockpit":
          break
        sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(2.0))
        sess.wait_raf(1)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 20, 1.0 / 60.0)
      st = _tap_fix(sess, rec)
      _assert(abs(float(st["cameraRoll"])) < 1e-4, "cockpit roll non-zero")
      # Return to chase
      for _ in range(4):
        if _get_state(sess).get("cameraMode") == "chase":
          break
        sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(2.0))
        sess.wait_raf(1)
      return "cockpit crash+FIX ok"
    rec.run_case("T2_F08_05", 2, "F8", "Cockpit camera survives TNT crash + FIX with zero roll", _t2_f08_05)

    # --- F9 (5) ---
    rec.run_case("T2_F09_01", 2, "F9", "Re-selecting currently active vehicle is idempotent", lambda: (
        _select_vehicle(sess, rec, "sedan"),
        _assert(_select_vehicle(sess, rec, "sedan")["vehicleId"] == "sedan", "idempotent select failed"),
        "idempotent ok",
    )[-1])

    def _t2_f09_02() -> str:
      for vid in ("sedan", "school_bus", "tuk_tuk", "monster_truck"):
        _select_vehicle(sess, rec, vid)
      _assert(_get_state(sess)["vehicleId"] == "monster_truck", "rapid sequence mismatch")
      return "settled on monster_truck"
    rec.run_case("T2_F09_02", 2, "F9", "Rapid 4-vehicle switch sequence settles cleanly on monster_truck", _t2_f09_02)

    rec.run_case("T2_F09_03", 2, "F9", "Paint swatch selection + vehicle spawn preserves clean state", lambda: (
        _assert_state_finite(_select_vehicle(sess, rec, "beetle", paint_id="cyan"), "T2_F09_03"),
        "cyan beetle ok",
    )[-1])

    def _t2_f09_04() -> str:
      s1 = _select_vehicle(sess, rec, "semi_truck")
      s2 = _select_vehicle(sess, rec, "smart_micro")
      _assert(int(s1["totalParts"]) >= 10 and int(s2["totalParts"]) >= 10, f"Low parts count: {s1['totalParts']}, {s2['totalParts']}")
      return f"semi={s1['totalParts']}, micro={s2['totalParts']}"
    rec.run_case("T2_F09_04", 2, "F9", "Heavyweight (semi_truck) and micro (smart_micro) both expose >= 10 parts", _t2_f09_04)

    def _t2_f09_05() -> str:
      for _ in range(3):
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 20, 1.0 / 60.0)
      st = _select_vehicle(sess, rec, "rally_raider")
      _assert(float(st["integrity"]) >= float(st["maxIntegrity"]) - 0.1 and not st.get("wrecked"), f"Swapping from wrecked car kept damage: {st}")
      return "fresh rally_raider 100%"
    rec.run_case("T2_F09_05", 2, "F9", "Spawning rally_raider while wrecked produces fresh 100% vehicle", _t2_f09_05)

    # --- F10 (5) ---
    def _t2_f10_01() -> str:
      for _ in range(5):
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 15, 1.0 / 60.0)
        _assert_state_finite(_get_state(sess), "T2_F10_01")
      return f"bounded integrity={_get_state(sess)['integrity']}"
    rec.run_case("T2_F10_01", 2, "F10", "5x consecutive TNT blasts keep integrity clamped in [0, maxIntegrity]", _t2_f10_01)

    rec.run_case("T2_F10_02", 2, "F10", "detachedParts never exceeds totalParts under extreme blasts", lambda: (
        _assert(0 <= int(_get_state(sess)["detachedParts"]) <= int(_get_state(sess)["totalParts"]), "detachedParts out of range"),
        f"{_get_state(sess)['detachedParts']}/{_get_state(sess)['totalParts']}",
    )[-1])

    def _t2_f10_03() -> str:
      _select_vehicle(sess, rec, "tuk_tuk")
      before = _tap_fix(sess, rec)
      for _ in range(2):
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 20, 1.0 / 60.0)
      after = _get_state(sess)
      _assert(
          float(after["integrity"]) < float(before["integrity"]) - 0.1,
          f"Tuk-Tuk took no TNT damage (before={before['integrity']}, after={after['integrity']}, max={before['maxIntegrity']})",
      )
      _tap_fix(sess, rec)
      return f"tuk_tuk damaged ({before['integrity']}->{after['integrity']}) + repaired"
    rec.run_case("T2_F10_03", 2, "F10", "3-wheel Tuk-Tuk damage/detachment and FIX recovery", _t2_f10_03)

    def _t2_f10_04() -> str:
      for _ in range(3):
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 20, 1.0 / 60.0)
        _tap_fix(sess, rec)
      return "3x TNT->FIX cycles clean"
    rec.run_case("T2_F10_04", 2, "F10", "3 consecutive TNT -> FIX cycles leave zero leaked detached parts", _t2_f10_04)

    def _t2_f10_05() -> str:
      _tap_fix(sess, rec)
      for _ in range(6):
        if _get_state(sess).get("wrecked") or float(_get_state(sess)["integrity"]) <= 0.1:
          break
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 20, 1.0 / 60.0)
      dmg = _get_state(sess)
      _assert(
          bool(dmg.get("wrecked")) or float(dmg["integrity"]) < float(dmg["maxIntegrity"]) * 0.5,
          f"Expected heavy/wrecked damage before FIX, got integrity={dmg['integrity']}/{dmg['maxIntegrity']}, wrecked={dmg.get('wrecked')}",
      )
      _tap_fix(sess, rec)
      return f"wrecked ({dmg['integrity']}/{dmg['maxIntegrity']}) -> 100% FIX"
    rec.run_case("T2_F10_05", 2, "F10", "Fully wrecked vehicle recovers 100% on single FIX tap", _t2_f10_05)

    # --- F11 (5) ---
    def _t2_f11_01() -> str:
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0))
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0))
      _step_frames(sess, 15, 1.0 / 60.0)
      _assert_state_finite(_get_state(sess), "T2_F11_01")
      return "double ragdoll stable"
    rec.run_case("T2_F11_01", 2, "F11", "Double-tapping #btn-ragdoll keeps physics finite and crash-free", _t2_f11_01)

    rec.run_case("T2_F11_02", 2, "F11", "TNT blast while ragdolling recovers cleanly via FIX", lambda: (
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0)),
        _step_frames(sess, 15, 1.0 / 60.0),
        _tap_fix(sess, rec),
        "ragdoll+TNT+FIX ok",
    )[-1])

    def _t2_f11_03() -> str:
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0))
      sess.wait_raf(2)
      st = _select_zone(sess, rec, "hub_lab")
      _assert(not st.get("ragdolling"), "Zone teleport did not re-seat ragdolled avatar")
      return "teleport re-seated"
    rec.run_case("T2_F11_03", 2, "F11", "Zone teleport while ragdolling automatically re-seats avatar", _t2_f11_03)

    def _t2_f11_04() -> str:
      sess.touch_tap_selector("#btn-auto-smash", timeout_s=rec.scale(2.0))
      _step_frames(sess, 15, 1.0 / 60.0)
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0))
      _step_frames(sess, 15, 1.0 / 60.0)
      _assert_state_finite(_get_state(sess), "T2_F11_04")
      _tap_fix(sess, rec)
      return "high-speed eject ok"
    rec.run_case("T2_F11_04", 2, "F11", "High-speed Auto-Smash ragdoll ejection recovers cleanly via FIX", _t2_f11_04)

    def _t2_f11_05() -> str:
      sess.set_viewport(820, 1180, dpr=2.0, mobile=True, wait_frames=2)
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0))
      sess.wait_raf(2)
      _assert(bool(_get_state(sess).get("ragdolling")), "Portrait ragdoll failed")
      _tap_fix(sess, rec)
      sess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=2)
      return "portrait eject+FIX ok"
    rec.run_case("T2_F11_05", 2, "F11", "Ragdoll ejection and FIX recovery in Portrait 820x1180", _t2_f11_05)

    # --- F12 (5) ---
    def _t2_f12_01() -> str:
      for _ in range(6):
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 20, 1.0 / 60.0)
      _assert_state_finite(_get_state(sess), "T2_F12_01")
      sess.assert_zero_errors("T2_F12_01")
      return "6x TNT spam clean"
    rec.run_case("T2_F12_01", 2, "F12", "6x rapid TNT spam produces zero errors and finite physics", _t2_f12_01)

    rec.run_case("T2_F12_02", 2, "F12", "FIX immediately clears onFire and wrecked after spam blasts", lambda: (
        _tap_fix(sess, rec),
        "cleared",
    )[-1])

    def _t2_f12_03() -> str:
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _select_zone(sess, rec, "derby_arena")
      f0 = int(_get_state(sess)["frameCount"])
      time.sleep(rec.scale(0.15))
      f1 = int(_get_state(sess)["frameCount"])
      _assert(f1 > f0, "rAF stalled after zone switch with active debris")
      return f"frames {f0} -> {f1}"
    rec.run_case("T2_F12_03", 2, "F12", "Zone switch with active debris keeps rAF smooth", _t2_f12_03)

    def _t2_f12_04() -> str:
      for _ in range(4):
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      st = _select_vehicle(sess, rec, "pickup")
      _assert(not st.get("onFire") and not st.get("wrecked"), f"Fire/wrecked leaked across vehicle swap: {st}")
      return "clean swap"
    rec.run_case("T2_F12_04", 2, "F12", "Vehicle swap clears active fire and wrecked states", _t2_f12_04)

    def _t2_f12_05() -> str:
      _tap_fix(sess, rec)
      with sess.hold_touches([("#btn-gas", 1), ("#btn-boost", 2)]):
        _step_frames(sess, 60, 1.0 / 60.0)
        n1 = float(_get_state(sess)["nitro"])
      _step_frames(sess, 90, 1.0 / 60.0)
      n2 = float(_get_state(sess)["nitro"])
      _assert(0.0 <= n1 <= 100.0 and 0.0 <= n2 <= 100.0, f"Nitro out of bounds: {n1}, {n2}")
      return f"nitro {n1:.1f} -> {n2:.1f}"
    rec.run_case("T2_F12_05", 2, "F12", "Nitro stays strictly clamped in [0, 100] across drain & recharge", _t2_f12_05)

    # --- F13 (5) ---
    _best_effort(lambda: _select_zone(sess, rec, "hub_lab"))
    _best_effort(lambda: _tap_fix(sess, rec))

    def _t2_f13_01() -> str:
      with sess.hold_touches([("#btn-gas", 1), ("#btn-boost", 2)]):
        _step_frames(sess, 45, 1.0 / 60.0)
        st = _get_state(sess)
      _assert_state_finite(st, "T2_F13_01")
      _assert(float(st["position"][1]) > -50.0, f"Fell through hub_lab floor: y={st['position'][1]}")
      return f"y={st['position'][1]:.2f}"
    rec.run_case("T2_F13_01", 2, "F13", "Full-boost driving in hub_lab never falls through ground", _t2_f13_01)

    def _t2_f13_02() -> str:
      for _ in range(2):
        _run_zone_action(sess, rec, expect_damage=False)
        _tap_fix(sess, rec)
      return "2x hub_lab reset ok"
    rec.run_case("T2_F13_02", 2, "F13", "Repeated Auto-Smash + FIX cycles in hub_lab reset cleanly", _t2_f13_02)

    rec.run_case("T2_F13_03", 2, "F13", "TNT + EJECT + FIX combination in hub_lab recovers cleanly", lambda: (
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0)),
        sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0)),
        _step_frames(sess, 15, 1.0 / 60.0),
        _tap_fix(sess, rec),
        "ok",
    )[-1])

    rec.run_case("T2_F13_04", 2, "F13", "Re-teleporting to hub_lab while already in hub_lab resets cleanly", lambda: (
        _assert_state_finite(_select_zone(sess, rec, "hub_lab"), "T2_F13_04"),
        "re-warp ok",
    )[-1])

    rec.run_case("T2_F13_05", 2, "F13", "Giant semi_truck operates in hub_lab without NaN physics", lambda: (
        _select_vehicle(sess, rec, "semi_truck"),
        _run_zone_action(sess, rec, expect_damage=False),
        _tap_fix(sess, rec),
        "semi_truck ok",
    )[-1])

    # --- F14 (5) ---
    def _t2_f14_01() -> str:
      _select_zone(sess, rec, "hydraulic_press")
      _tap_fix(sess, rec)
      for _ in range(3):
        tinfo = sess.locate_selector("#btn-machine-trigger", timeout_s=0.3)
        if tinfo.get("found"):
          sess.touch_tap(tinfo["x"], tinfo["y"], hold_ms=15)
      _run_zone_action(sess, rec, expect_damage=True)
      sess.assert_zero_errors("T2_F14_01")
      return "press spam ok"
    rec.run_case("T2_F14_01", 2, "F14", "Repeated machine trigger spam at hydraulic_press stays stable", _t2_f14_01)

    def _t2_f14_02() -> str:
      for _ in range(3):
        if _get_state(sess).get("wrecked"):
          break
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 20, 1.0 / 60.0)
      dmg = _get_state(sess)
      _assert(
          bool(dmg.get("wrecked")) or float(dmg["integrity"]) < float(dmg["maxIntegrity"]) - 0.1,
          f"Expected damaged/wrecked state before FIX at hydraulic_press: {dmg}",
      )
      _tap_fix(sess, rec)
      return f"zero soft-lock at press ({dmg['integrity']}/{dmg['maxIntegrity']} -> 100%)"
    rec.run_case("T2_F14_02", 2, "F14", "Crushed/wrecked recovery via FIX at hydraulic_press (zero soft-lock)", _t2_f14_02)

    def _t2_f14_03() -> str:
      _select_zone(sess, rec, "train_crossing")
      _tap_fix(sess, rec)
      _run_zone_action(sess, rec, expect_damage=True)
      _tap_fix(sess, rec)
      return "train_crossing recovery ok"
    rec.run_case("T2_F14_03", 2, "F14", "Train collision + FIX recovery at train_crossing", _t2_f14_03)

    def _t2_f14_04() -> str:
      _select_zone(sess, rec, "giant_hammer")
      _tap_fix(sess, rec)
      _run_zone_action(sess, rec, expect_damage=True)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 15, 1.0 / 60.0)
      _tap_fix(sess, rec)
      return "giant_hammer+TNT+FIX ok"
    rec.run_case("T2_F14_04", 2, "F14", "giant_hammer + TNT combined blast recovers 100% via FIX", _t2_f14_04)

    def _t2_f14_05() -> str:
      _select_zone(sess, rec, "spike_drop")
      _tap_fix(sess, rec)
      _run_zone_action(sess, rec, expect_damage=True)
      _tap_fix(sess, rec)
      return "spike_drop recovery ok"
    rec.run_case("T2_F14_05", 2, "F14", "spike_drop naval mine blast recovers 100% via FIX", _t2_f14_05)

    # --- F15 (5) ---
    def _t2_f15_01() -> str:
      _select_zone(sess, rec, "shredder_tunnels")
      _tap_fix(sess, rec)
      _run_zone_action(sess, rec, expect_damage=True)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 20, 1.0 / 60.0)
      _tap_fix(sess, rec)
      return "shredder zero soft-lock"
    rec.run_case("T2_F15_01", 2, "F15", "shredder_tunnels extreme crush recovers cleanly via FIX (zero soft-lock)", _t2_f15_01)

    def _t2_f15_02() -> str:
      _select_zone(sess, rec, "lava_obby")
      _tap_fix(sess, rec)
      _run_zone_action(sess, rec, expect_damage=True)
      _tap_fix(sess, rec)
      return "lava_obby zero soft-lock"
    rec.run_case("T2_F15_02", 2, "F15", "lava_obby fire/catapult hazard recovers cleanly via FIX (zero soft-lock)", _t2_f15_02)

    def _t2_f15_03() -> str:
      _select_zone(sess, rec, "ski_jump")
      _tap_fix(sess, rec)
      _run_zone_action(sess, rec, expect_damage=False, use_boost=True)
      _tap_fix(sess, rec)
      return "ski_jump Nitro ok"
    rec.run_case("T2_F15_03", 2, "F15", "ski_jump full Nitro launch stays finite and resets via FIX", _t2_f15_03)

    def _t2_f15_04() -> str:
      _select_zone(sess, rec, "mega_ramp")
      _tap_fix(sess, rec)
      _run_zone_action(sess, rec, expect_damage=False, use_boost=True)
      _tap_fix(sess, rec)
      return "mega_ramp Nitro ok"
    rec.run_case("T2_F15_04", 2, "F15", "mega_ramp full Nitro launch stays finite and resets via FIX", _t2_f15_04)

    def _t2_f15_05() -> str:
      _select_zone(sess, rec, "derby_arena")
      _run_zone_action(sess, rec, expect_damage=True)
      _select_zone(sess, rec, "crash_c4_wall")
      _run_zone_action(sess, rec, expect_damage=True)
      _tap_fix(sess, rec)
      return "derby -> c4_wall ok"
    rec.run_case("T2_F15_05", 2, "F15", "Back-to-back derby_arena and crash_c4_wall warps stay clean", _t2_f15_05)

    # --- F16 (5) ---
    _best_effort(lambda: _select_zone(sess, rec, "hub_lab"))
    _best_effort(lambda: _tap_fix(sess, rec))

    def _t2_f16_01() -> str:
      with sess.hold_touches([("#btn-gas", 1), ("#btn-brake", 2)]):
        _step_frames(sess, 20, 1.0 / 60.0)
        st = _get_state(sess)
      _assert_state_finite(st, "T2_F16_01")
      return "GAS+REV finite"
    rec.run_case("T2_F16_01", 2, "F16", "Simultaneous GAS + REV hold stays finite and releases cleanly", _t2_f16_01)

    def _t2_f16_02() -> str:
      with sess.hold_touches([("#btn-steer-left", 1), ("#btn-steer-right", 2)]):
        _step_frames(sess, 20, 1.0 / 60.0)
        st = _get_state(sess)
      _assert_state_finite(st, "T2_F16_02")
      return "L+R finite"
    rec.run_case("T2_F16_02", 2, "F16", "Simultaneous STEER-LEFT + STEER-RIGHT hold stays finite", _t2_f16_02)

    def _t2_f16_03() -> str:
      with sess.hold_touches([("#btn-gas", 1), ("#btn-boost", 2)]):
        _step_frames(sess, 90, 1.0 / 60.0)
        n = float(_get_state(sess)["nitro"])
      _assert(0.0 <= n <= 100.0, f"Nitro out of range: {n}")
      return f"nitro={n:.1f}"
    rec.run_case("T2_F16_03", 2, "F16", "Continuous boost drain never pushes Nitro below 0%", _t2_f16_03)

    def _t2_f16_04() -> str:
      sess.touch_tap_selector("#btn-auto-smash", timeout_s=rec.scale(2.0))
      _step_frames(sess, 10, 1.0 / 60.0)
      st = _tap_fix(sess, rec)
      _assert(float(st["speedKmh"]) < 15.0, f"FIX did not calm Auto-Smash velocity: speed={st['speedKmh']}")
      return f"speed after FIX={st['speedKmh']}"
    rec.run_case("T2_F16_04", 2, "F16", "FIX immediately cancels active Auto-Smash launch velocity", _t2_f16_04)

    def _t2_f16_05() -> str:
      _tap_fix(sess, rec)
      with sess.hold_touches([("#btn-gas", None)]):
        _step_frames(sess, 25, 1.0 / 60.0)
        mid = _get_state(sess)
      _assert(float(mid["speedKmh"]) > 2.0, f"Could not drive after FIX: speed={mid['speedKmh']}")
      return f"post-FIX speed={mid['speedKmh']}"
    rec.run_case("T2_F16_05", 2, "F16", "Immediate GAS driving works smoothly right after FIX", _t2_f16_05)

    # --- F17 (5) ---
    rec.run_case("T2_F17_01", 2, "F17", "All numeric telemetry fields strictly finite across gameplay", lambda: (
        _assert_state_finite(_get_state(sess), "T2_F17_01"),
        "all finite",
    )[-1])

    def _t2_f17_02() -> str:
      texts = sess.eval_js(
          """['#hud-cash','#hud-integrity-value','#hud-parts','#hud-level','#hud-speed-value','#hud-gear-value']
             .map(s => [s, (document.querySelector(s)?.textContent || '').trim()])""",
          await_promise=False,
      ) or []
      for s, t in texts:
        _assert("NaN" not in t and "undefined" not in t and "Infinity" not in t, f"Corrupt HUD {s}={t!r}")
      return "zero NaN/undefined in HUD"
    rec.run_case("T2_F17_02", 2, "F17", "Zero NaN, undefined, or Infinity strings in HUD indicators", _t2_f17_02)

    def _t2_f17_03() -> str:
      c0 = float(_get_state(sess)["cash"])
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 20, 1.0 / 60.0)
      c1 = float(_get_state(sess)["cash"])
      _tap_fix(sess, rec)
      c2 = float(_get_state(sess)["cash"])
      _assert(c1 >= c0 and c2 >= c0 and c2 >= 0.0, f"Cash regressed: {c0} -> {c1} -> {c2}")
      return f"cash {c0} -> {c1} -> {c2}"
    rec.run_case("T2_F17_03", 2, "F17", "Cash is non-negative and never lost on FIX repair", _t2_f17_03)

    def _t2_f17_04() -> str:
      st0 = _get_state(sess)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 20, 1.0 / 60.0)
      _tap_fix(sess, rec)
      st2 = _get_state(sess)
      _assert(int(st2["level"]) >= int(st0["level"]) and (int(st2["level"]) > int(st0["level"]) or float(st2["xp"]) >= float(st0["xp"])), "XP/Level regressed")
      return f"lvl {st0['level']}->{st2['level']}, xp {st0['xp']}->{st2['xp']}"
    rec.run_case("T2_F17_04", 2, "F17", "XP and Level never regress across crash and repair", _t2_f17_04)

    def _t2_f17_05() -> str:
      for _ in range(3):
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 15, 1.0 / 60.0)
      r = layout_audit.measure_layout_state(sess, "play_active", None)
      _tap_fix(sess, rec)
      _assert(not r.get("offscreenHudStrips"), f"HUD strips overflowed after trick spam: {r.get('offscreenHudStrips')}")
      return "trick feed bounded"
    rec.run_case("T2_F17_05", 2, "F17", "#hud-trick-feed remains bounded within viewport after rapid crashes", _t2_f17_05)

    # --- F18 (5: Remaining 4 iPad viewports + dynamic rotation) ---
    def _check_vp_layout(w: int, h: int, dpr: float, check_modals: bool = False) -> str:
      sess.set_viewport(w, h, dpr=dpr, mobile=True, wait_frames=3)
      rp = layout_audit.measure_layout_state(sess, "play_active", None)
      _assert(rp.get("passed"), f"{w}x{h} play_active failed: {layout_audit._summarize_failures(rp)}")
      if check_modals:
        _open_garage(sess, rec)
        rg = layout_audit.measure_layout_state(sess, "modal_garage", "#modal-garage")
        _close_modals(sess)
        _assert(rg.get("passed"), f"{w}x{h} modal_garage failed: {layout_audit._summarize_failures(rg)}")
        _open_teleport(sess, rec)
        rt = layout_audit.measure_layout_state(sess, "modal_teleport", "#modal-teleport")
        _close_modals(sess)
        _assert(rt.get("passed"), f"{w}x{h} modal_teleport failed: {layout_audit._summarize_failures(rt)}")
      return f"{w}x{h} layout PASS"

    rec.run_case("T2_F18_01", 2, "F18", "Layout audit passes at 1024x768 (iPad Classic Landscape)", lambda: _check_vp_layout(1024, 768, 2.0))
    rec.run_case("T2_F18_02", 2, "F18", "Layout audit passes at 1280x800 (Hero Screenshot Landscape)", lambda: _check_vp_layout(1280, 800, 1.0))
    rec.run_case("T2_F18_03", 2, "F18", "Layout audit passes at 820x1180 (iPad Air Portrait) play + modals", lambda: _check_vp_layout(820, 1180, 2.0, check_modals=True))
    rec.run_case("T2_F18_04", 2, "F18", "Layout audit passes at 768x1024 (iPad Classic Portrait)", lambda: _check_vp_layout(768, 1024, 2.0))

    def _t2_f18_05() -> str:
      sess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=2)
      sess.set_viewport(820, 1180, dpr=2.0, mobile=True, wait_frames=3)
      r1 = layout_audit.measure_layout_state(sess, "play_active", None)
      _assert(r1.get("passed"), f"Rotate to portrait failed: {layout_audit._summarize_failures(r1)}")
      sess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=3)
      r2 = layout_audit.measure_layout_state(sess, "play_active", None)
      _assert(r2.get("passed"), f"Rotate back to landscape failed: {layout_audit._summarize_failures(r2)}")
      sess.assert_zero_errors("T2_F18_05")
      return "dynamic rotation clean"
    rec.run_case("T2_F18_05", 2, "F18", "Dynamic no-reload rotation (1180x820 -> 820x1180 -> 1180x820) passes layout", _t2_f18_05)

    # --- F19 (8: Additive Tier 5 Hardening Regressions: T2_F19_01 .. T2_F19_08) ---
    def _t2_f19_01() -> str:
      sess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=2)
      _select_vehicle(sess, rec, "sedan")
      _select_zone(sess, rec, "spike_drop")
      _tap_fix(sess, rec)
      captured = sess.eval_js(
          """(async () => {
            const THREE = await import(new URL('./vendor/three.module.min.js', window.location.href).href);
            let liveScene = null;
            let liveCam = null;
            const origUpdate = THREE.Object3D.prototype.updateMatrixWorld;
            THREE.Object3D.prototype.updateMatrixWorld = function (...args) {
              if (!liveScene && this.isScene) liveScene = this;
              if (!liveCam && this.isPerspectiveCamera) liveCam = this;
              return origUpdate.apply(this, args);
            };
            try {
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            } finally {
              THREE.Object3D.prototype.updateMatrixWorld = origUpdate;
            }
            window.__T5_CAP__ = { THREE, scene: liveScene, cam: liveCam };
            return { hasScene: Boolean(liveScene), hasCam: Boolean(liveCam) };
          })()""",
          await_promise=True,
      ) or {}
      _assert(captured.get("hasScene") and captured.get("hasCam"), f"Failed to capture live scene/camera: {captured}")

      try:
        sess.touch_tap_selector("#btn-auto-smash", timeout_s=rec.scale(2.0))
        false_culled_events: list[dict[str, Any]] = []
        mine_flags: dict[str, Any] = {}
        inst_count = 0
        for step_inc in (90, 25, 25, 25):
          _step_frames(sess, step_inc, 1.0 / 60.0)
          sess.wait_raf(1)
          res = sess.eval_js(
              """(() => {
                const cap = window.__T5_CAP__;
                if (!cap || !cap.scene || !cap.cam) return { error: 'no_cap' };
                const { THREE, scene, cam } = cap;
                scene.updateMatrixWorld(true);
                cam.updateMatrixWorld(true);
                const frustum = new THREE.Frustum();
                const projScreen = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
                frustum.setFromProjectionMatrix(projScreen);
                const mat4 = new THREE.Matrix4();
                const worldMat = new THREE.Matrix4();
                const pos = new THREE.Vector3();
                let instCount = 0;
                const mines = {};
                const bad = [];
                scene.traverse((obj) => {
                  if (!obj.isInstancedMesh || !obj.visible) return;
                  instCount += 1;
                  if (obj.name === 'spike_drop_mine_bodies' || obj.name === 'spike_drop_mine_spikes') {
                    mines[obj.name] = { frustumCulled: Boolean(obj.frustumCulled), count: obj.count };
                  }
                  let inFrustum = 0;
                  for (let i = 0; i < obj.count; i += 1) {
                    obj.getMatrixAt(i, mat4);
                    worldMat.multiplyMatrices(obj.matrixWorld, mat4);
                    pos.setFromMatrixPosition(worldMat);
                    if (frustum.containsPoint(pos)) inFrustum += 1;
                  }
                  const threeWillDraw = !obj.frustumCulled || frustum.intersectsObject(obj);
                  if (inFrustum > 0 && !threeWillDraw) {
                    bad.push({ name: obj.name, inFrustum, frustumCulled: obj.frustumCulled });
                  }
                });
                return { instCount, mines, bad };
              })()""",
              await_promise=False,
          ) or {}
          _assert(not res.get("error"), f"Frustum scan error: {res}")
          inst_count = max(inst_count, int(res.get("instCount", 0)))
          mine_flags = res.get("mines") or mine_flags
          if res.get("bad"):
            false_culled_events.extend(res["bad"])
      finally:
        sess.eval_js("delete window.__T5_CAP__; true;", await_promise=False)
        _tap_fix(sess, rec)

      _assert(inst_count >= 14, f"Expected >= 14 InstancedMeshes, saw {inst_count}")
      _assert("spike_drop_mine_bodies" in mine_flags and "spike_drop_mine_spikes" in mine_flags, f"Missing spike_drop mine meshes: {mine_flags}")
      _assert(mine_flags["spike_drop_mine_bodies"]["frustumCulled"] is False, f"spike_drop_mine_bodies still frustumCulled: {mine_flags}")
      _assert(mine_flags["spike_drop_mine_spikes"]["frustumCulled"] is False, f"spike_drop_mine_spikes still frustumCulled: {mine_flags}")
      _assert(len(false_culled_events) == 0, f"FALSE_CULLED InstancedMeshes during spike_drop: {false_culled_events}")
      sess.assert_zero_errors("T2_F19_01")
      return f"instMeshes={inst_count}, minesCulled=false, falseCulled=0"
    rec.run_case("T2_F19_01", 2, "F19", "Dynamic InstancedMesh frustum visibility at spike_drop (0 FALSE_CULLED across all 14 meshes)", _t2_f19_01)

    def _t2_f19_02() -> str:
      strict_root = None if live_url else root
      with cdp.CdpBrowser(root=strict_root, autoplay_policy="document-user-activation-required") as sb:
        s_url, _ = _target_url(sb, live_url, url_query)
        with sb.new_session(
            width=1180,
            height=820,
            dpr=2.0,
            mobile=True,
            install_audio_spy=True,
        ) as s2:
          ok = s2.goto(s_url, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(25.0))
          _assert(ok, f"Strict autoplay session failed to boot: {s_url}")
          s2.wait_raf(3)
          pre_spy = s2.get_audio_spy()
          _assert(int(pre_spy.get("createdBeforeGesture", -1)) == 0 and int(pre_spy.get("createdCount", -1)) == 0, f"AudioContext created before gesture: {pre_spy}")

          s2.touch_tap_selector("#btn-play", timeout_s=rec.scale(4.0))
          s2.wait_raf(5)
          time.sleep(0.15)
          s2.pump_events(0.1)

          st = _get_state(s2)
          post_spy = s2.get_audio_spy()
          autoplay_warns = [
              e for e in s2.log_entries
              if "AudioContext" in str(e.get("text", "")) and "not allowed" in str(e.get("text", ""))
          ]
          _assert(bool(st.get("started")), f"#btn-play did not start under strict autoplay: {st}")
          play_cnt = int((st.get("hudActionCounts") or {}).get("play", 0))
          _assert(play_cnt == 1, f"Expected hudActionCounts.play === 1, got {play_cnt}")
          _assert(int(post_spy.get("createdBeforeGesture", -1)) == 0, f"AudioContext created before gesture: {post_spy}")
          _assert(int(post_spy.get("createdCount", 0)) >= 1, f"AudioContext never created on tap #1: {post_spy}")
          _assert(post_spy.get("lastState") == "running", f"Expected AudioContext.state === 'running' after tap #1, got {post_spy}")
          _assert(len(autoplay_warns) == 0, f"Chrome autoplay warnings emitted on tap #1: {autoplay_warns}")
          s2.assert_zero_errors("T2_F19_02")
          return f"strict autoplay tap#1 state={post_spy.get('lastState')}, warns=0, play={play_cnt}"
    rec.run_case("T2_F19_02", 2, "F19", "Strict autoplay (document-user-activation-required) unlocks AudioContext to running on tap #1 with 0 warnings", _t2_f19_02)

    def _t2_f19_03() -> str:
      res = sess.eval_js(
          """(async () => {
            const { createAudioEngine } = await import(new URL('./src/fx/audio.js', window.location.href).href);
            const OrigAC = window.AudioContext;
            const OrigWebkitAC = window.webkitAudioContext;
            const stats = {
              instances: 0,
              oscCreated: 0,
              bufCreated: 0,
              setTargetCalls: 0,
              startedNodes: 0,
              stoppedNodes: 0,
              throwOnCreateOsc: false,
              throwOnCreateBuf: false,
              throwOnExpRamp: false,
              throwOnStartAt: -1,
            };
            const createdCtxs = [];
            class MockParam {
              constructor(v = 0) { this.value = v; }
              setValueAtTime() { return this; }
              linearRampToValueAtTime() { return this; }
              exponentialRampToValueAtTime() {
                if (stats.throwOnExpRamp) throw new DOMException('bad ramp', 'InvalidStateError');
                return this;
              }
              setTargetAtTime() {
                stats.setTargetCalls += 1;
                return this;
              }
            }
            class MockNode {
              connect() { return this; }
              disconnect() {}
            }
            class MockAudioContext {
              constructor() {
                stats.instances += 1;
                this.state = 'running';
                this.sampleRate = 44100;
                this.currentTime = 0;
                this.destination = new MockNode();
                this.onstatechange = null;
                createdCtxs.push(this);
              }
              createDynamicsCompressor() {
                const n = new MockNode();
                n.threshold = new MockParam(-12);
                n.knee = new MockParam(16);
                n.ratio = new MockParam(6);
                n.attack = new MockParam(0.004);
                n.release = new MockParam(0.14);
                return n;
              }
              createGain() {
                const n = new MockNode();
                n.gain = new MockParam(1);
                return n;
              }
              createBiquadFilter() {
                const n = new MockNode();
                n.type = 'lowpass';
                n.frequency = new MockParam(440);
                n.Q = new MockParam(1);
                return n;
              }
              createBuffer(ch, len) {
                const arr = new Float32Array(Math.max(1, len));
                return { getChannelData: () => arr };
              }
              createOscillator() {
                if (stats.throwOnCreateOsc) throw new DOMException('bad osc', 'InvalidStateError');
                stats.oscCreated += 1;
                const n = new MockNode();
                n.type = 'sine';
                n.frequency = new MockParam(220);
                n.start = () => {
                  stats.startedNodes += 1;
                  if (stats.throwOnStartAt === stats.startedNodes) {
                    throw new DOMException('boot fail', 'InvalidStateError');
                  }
                };
                n.stop = () => { stats.stoppedNodes += 1; };
                return n;
              }
              createBufferSource() {
                if (stats.throwOnCreateBuf) throw new DOMException('bad buf', 'InvalidStateError');
                stats.bufCreated += 1;
                const n = new MockNode();
                n.buffer = null;
                n.loop = false;
                n.start = () => {
                  stats.startedNodes += 1;
                  if (stats.throwOnStartAt === stats.startedNodes) {
                    throw new DOMException('boot fail', 'InvalidStateError');
                  }
                };
                n.stop = () => { stats.stoppedNodes += 1; };
                return n;
              }
              resume() {
                this.state = 'running';
                return Promise.resolve();
              }
              close() {
                this.state = 'closed';
                return Promise.resolve();
              }
            }
            window.AudioContext = MockAudioContext;
            window.webkitAudioContext = MockAudioContext;
            let eng1 = null;
            let eng2 = null;
            try {
              // (a) Interrupted state: 0 voices & 0 setTargetAtTime calls
              eng1 = createAudioEngine();
              eng1.unlock();
              const ctx1 = createdCtxs[0];
              ctx1.state = 'interrupted';
              if (typeof ctx1.onstatechange === 'function') ctx1.onstatechange();
              const oscBeforeInt = stats.oscCreated;
              const bufBeforeInt = stats.bufCreated;
              const tgtBeforeInt = stats.setTargetCalls;
              eng1.playCrash(1.0);
              eng1.playGlassShatter();
              eng1.playExplosion();
              eng1.playButton();
              for (let i = 0; i < 10; i += 1) eng1.updateEngine(0.8, 1.0, true, true);
              const intVoices = (stats.oscCreated - oscBeforeInt) + (stats.bufCreated - bufBeforeInt);
              const intTargets = stats.setTargetCalls - tgtBeforeInt;

              // (b) Closed context recreation
              ctx1.state = 'closed';
              eng1.unlock();
              const recreated = stats.instances === 2 && createdCtxs[1].state === 'running';

              // (c) Throwing WebAudio APIs caught safely
              let uncaught = 0;
              const tryCall = (fn) => { try { fn(); } catch (_) { uncaught += 1; } };
              stats.throwOnExpRamp = true;
              tryCall(() => eng1.playCrash(1.0));
              tryCall(() => eng1.playButton());
              stats.throwOnExpRamp = false;
              stats.throwOnCreateOsc = true;
              tryCall(() => eng1.playButton());
              tryCall(() => eng1.playTrick());
              stats.throwOnCreateOsc = false;
              stats.throwOnCreateBuf = true;
              tryCall(() => eng1.playGlassShatter());
              tryCall(() => eng1.playExplosion());
              stats.throwOnCreateBuf = false;
              eng1.dispose();
              eng1 = null;

              // (d) Partial-boot oscillator cleanup (throw at driftSource.start(), 4th start after silent buf + 2 oscs)
              stats.startedNodes = 0;
              stats.stoppedNodes = 0;
              stats.throwOnStartAt = 4;
              eng2 = createAudioEngine();
              eng2.unlock();
              const startedBeforeFail = stats.startedNodes;
              const stoppedAfterFail = stats.stoppedNodes;
              stats.throwOnStartAt = -1;
              eng2.dispose();
              eng2 = null;
              return { intVoices, intTargets, recreated, uncaught, startedBeforeFail, stoppedAfterFail };
            } finally {
              try { eng1?.dispose(); } catch (_) {}
              try { eng2?.dispose(); } catch (_) {}
              window.AudioContext = OrigAC;
              window.webkitAudioContext = OrigWebkitAC;
            }
          })()""",
          await_promise=True,
      ) or {}
      _assert(res.get("intVoices") == 0 and res.get("intTargets") == 0, f"Interrupted context queued voices/targets: {res}")
      _assert(res.get("recreated") is True, f"Closed context was not recreated on unlock(): {res}")
      _assert(res.get("uncaught") == 0, f"Throwing WebAudio APIs escaped uncaught: {res}")
      _assert(int(res.get("stoppedAfterFail", 0)) >= 2, f"Partial-boot oscillators leaked without stop(): {res}")
      sess.assert_zero_errors("T2_F19_03")
      return f"intVoices=0, intTargets=0, recreated=true, uncaught=0, stoppedOrphans={res.get('stoppedAfterFail')}"
    rec.run_case("T2_F19_03", 2, "F19", "audio.js fault resilience (interrupted gating, closed recreation, throwing APIs, partial-boot cleanup)", _t2_f19_03)

    def _t2_f19_04() -> str:
      res = sess.eval_js(
          """(async () => {
            const THREE = await import(new URL('./vendor/three.module.min.js', window.location.href).href);
            const { createScoringSystem } = await import(new URL('./src/sim/scoring.js', window.location.href).href);
            const { createPhysicsSim } = await import(new URL('./src/sim/physics.js', window.location.href).href);
            const { createTextureLibrary } = await import(new URL('./src/world/textures.js', window.location.href).href);

            const t0 = performance.now();
            const scoring = createScoringSystem();
            scoring.addReward({ cash: Infinity, xp: Infinity, label: 'INF' });
            scoring.addReward({ cash: NaN, xp: -Infinity, label: 'NAN' });
            scoring.onStuntLanding({ flips: Infinity, rolls: NaN, spins: Infinity, airTime: Infinity });
            scoring.onSkiMarker(Infinity);
            scoring.buyOrTryVehicle({ id: 'inf_car', price: Infinity });
            const st = scoring.getState('sedan');
            const scoreMs = performance.now() - t0;

            const tmpScene = new THREE.Scene();
            const textures = createTextureLibrary();
            const mockWorld = {
              getGroundHeight: () => 0,
              getSlopeNormal: (_x, _z, out) => (out ? out.set(0, 1, 0) : new THREE.Vector3(0, 1, 0)),
              resetBreakables: () => {},
              getAiVehicles: () => [],
              triggerZoneMachine: () => ({ triggered: false }),
              triggerNearestMachine: () => ({ triggered: false }),
            };
            const sim = createPhysicsSim({
              scene: tmpScene,
              world: mockWorld,
              particles: null,
              audio: null,
              avatar: null,
              scoring,
              textures,
              cameraCtrl: null,
            });
            try {
              const tp0 = performance.now();
              // NaN lateral impulse must NOT permanently poison sideSkew
              sim.applyHazardImpacts([{ kind: 'pillar', damage: 15, impulse: [NaN, 0, NaN] }]);
              sim.applyHazardImpacts([{ kind: 'pillar', damage: 25, impulse: [15, 0, 0] }]);
              let bodyRollZ = 0;
              tmpScene.traverse((o) => {
                if (o.name === 'bodyGroup') bodyRollZ = o.rotation.z;
              });
              // Extreme NaN/Infinity stepKinematics + wrecked impulse must remain finite & O(1)
              sim.stepKinematics(Infinity, { steer: NaN, throttle: Infinity, brake: -Infinity, boost: NaN });
              sim.applyHazardImpacts([{ kind: 'train', damage: 120, impulse: [NaN, Infinity, -Infinity], explode: true }]);
              sim.applyHazardImpacts([{ kind: 'train', damage: 50, impulse: [NaN, Infinity, -Infinity] }]);
              sim.stepKinematics(NaN, { steer: Infinity, throttle: 1, brake: 0, boost: 1 });
              const snap = sim.getSnapshot();
              const physMs = performance.now() - tp0;
              const allFinite = [
                ...snap.position,
                ...snap.velocity,
                snap.integrity,
                snap.nitro,
                snap.speedKmh,
                snap.steerAngle,
                bodyRollZ,
              ].every((v) => typeof v === 'number' && Number.isFinite(v));
              return {
                scoreMs,
                physMs,
                scoreFinite: Number.isFinite(st.cash) && Number.isFinite(st.xp) && Number.isFinite(st.level),
                bodyRollZ,
                allFinite,
              };
            } finally {
              sim.dispose();
              textures.dispose();
            }
          })()""",
          await_promise=True,
      ) or {}
      _assert(res.get("scoreFinite") is True and float(res.get("scoreMs", 999)) < 50.0, f"scoring.js NaN/Infinity failed: {res}")
      _assert(res.get("allFinite") is True and float(res.get("physMs", 999)) < 50.0, f"physics.js NaN/Infinity failed: {res}")
      _assert(abs(float(res.get("bodyRollZ", 0.0))) > 1e-4, f"sideSkew was poisoned by NaN impulse (bodyRollZ={res.get('bodyRollZ')})")
      sess.assert_zero_errors("T2_F19_04")
      return f"scoreMs={res['scoreMs']:.1f}, physMs={res['physMs']:.1f}, bodyRollZ={res['bodyRollZ']:.4f}"
    rec.run_case("T2_F19_04", 2, "F19", "scoring.js & physics.js NaN/Infinity bounded (<50ms, finite state, sideSkew unpoisoned)", _t2_f19_04)

    def _t2_f19_05() -> str:
      res = sess.eval_js(
          """(async () => {
            const THREE = await import(new URL('./vendor/three.module.min.js', window.location.href).href);
            const { createDestructionWorld } = await import(new URL('./src/world/arena.js', window.location.href).href);
            const { createPhysicsSim } = await import(new URL('./src/sim/physics.js', window.location.href).href);
            const { createTextureLibrary } = await import(new URL('./src/world/textures.js', window.location.href).href);

            const tmpScene = new THREE.Scene();
            const textures = createTextureLibrary();
            const realWorld = createDestructionWorld(tmpScene, textures);
            let sim = null;
            try {
              const runProbe = (startX, startZ, dirX, dirZ, steps, useBoost = false, vehicleId = 'sedan') => {
                // Map hub_lab spawn (0, 14) heading -Z = (0, -1) onto (startX, startZ) heading (dirX, dirZ)
                const leftX = dirZ;
                const leftZ = -dirX;
                const toWorld = (lx, lz) => {
                  const fwd = 14.0 - lz;
                  return [startX + fwd * dirX + lx * leftX, startZ + fwd * dirZ + lx * leftZ];
                };
                const proxyWorld = {
                  getGroundHeight: (lx, lz) => {
                    const [wx, wz] = toWorld(lx, lz);
                    return realWorld.getGroundHeight(wx, wz);
                  },
                  getSlopeNormal: (lx, lz, out) => {
                    const [wx, wz] = toWorld(lx, lz);
                    const n = realWorld.getSlopeNormal(wx, wz, out);
                    // Rotate horizontal normal back into local frame (+left, -fwd)
                    const nFwd = n.x * dirX + n.z * dirZ;
                    const nLeft = n.x * leftX + n.z * leftZ;
                    n.x = nLeft;
                    n.z = -nFwd;
                    return n;
                  },
                  resetBreakables: () => {},
                  getAiVehicles: () => [],
                  triggerZoneMachine: () => ({ triggered: false }),
                  triggerNearestMachine: () => ({ triggered: false }),
                };
                if (sim) sim.dispose();
                sim = createPhysicsSim({
                  scene: tmpScene,
                  world: proxyWorld,
                  particles: null,
                  audio: null,
                  avatar: null,
                  scoring: null,
                  textures,
                  cameraCtrl: null,
                });
                if (vehicleId && vehicleId !== 'sedan') {
                  sim.selectVehicle(vehicleId);
                }
                let prevY = sim.getSnapshot().position[1];
                let maxDeltaY = 0;
                let maxY = prevY;
                let minPostFwd = Infinity;
                let postFwd = 0;
                for (let i = 0; i < steps; i += 1) {
                  sim.stepKinematics(1 / 60, { steer: 0, throttle: 1, brake: 0, boost: useBoost ? 1 : 0 });
                  const snap = sim.getSnapshot();
                  const y = snap.position[1];
                  const fwdVel = -snap.velocity[2];
                  const dy = Math.abs(y - prevY);
                  if (dy > maxDeltaY) maxDeltaY = dy;
                  if (y > maxY) maxY = y;
                  if (i >= 5 && fwdVel < minPostFwd) minPostFwd = fwdVel;
                  postFwd = fwdVel;
                  prevY = y;
                }
                return { maxDeltaY, maxY, minPostFwd, postFwd };
              };

              const cliffs = {
                mega_ramp_side: runProbe(12.0, 160.0, -1, 0, 70),
                ski_jump_side: runProbe(-197.0, -128.0, 1, 0, 70),
                shredder_orange_side: runProbe(200.0, -111.0, -1, 0, 70),
                lava_bridge_under: runProbe(-176.0, 164.0, 0, -1, 70),
                rainbow_ramp_side: runProbe(-20.5, 184.0, -1, 0, 70),
              };
              const legitMegaRamp = runProbe(0.0, 128.0, 0, 1, 130, true);
              const derbyBanked = {
                derby_in_east_rally_nos: runProbe(132.0, 168.0, 1, 0, 130, true, 'rally_raider'),
                derby_out_west_sedan_nos: runProbe(40.0, 168.0, 1, 0, 150, true, 'sedan'),
                derby_out_west_rally_gas: runProbe(25.0, 168.0, 1, 0, 180, false, 'rally_raider'),
              };
              return { cliffs, legitMegaRamp, derbyBanked };
            } finally {
              try { sim?.dispose(); } catch (_) {}
              realWorld.dispose();
              textures.dispose();
            }
          })()""",
          await_promise=True,
      ) or {}
      cliffs = res.get("cliffs") or {}
      _assert(len(cliffs) == 5, f"Missing cliff probe results: {res}")
      worst = max(float(v["maxDeltaY"]) for v in cliffs.values())
      _assert(worst <= 1.2, f"Vertical cliff snap teleport detected (maxDeltaY={worst:.2f}m > 1.2m): {cliffs}")
      legit_max_y = float((res.get("legitMegaRamp") or {}).get("maxY", 0.0))
      _assert(legit_max_y >= 5.0, f"Legitimate mega_ramp climb broken (maxY={legit_max_y:.2f}m < 5.0m)")
      derby_banked = res.get("derbyBanked") or {}
      _assert(len(derby_banked) == 3, f"Missing Derby banked-wall probe results: {res}")
      derby_summary = []
      for dname, dres in derby_banked.items():
        d_max_y = float(dres.get("maxY", 0.0))
        d_min_fwd = float(dres.get("minPostFwd", -1.0))
        d_post_fwd = float(dres.get("postFwd", -1.0))
        _assert(
            d_max_y >= 5.0,
            f"Derby banked wall {dname} climb broken (maxY={d_max_y:.2f}m < 5.0m): {dres}",
        )
        _assert(
            d_min_fwd > 0.0 and d_post_fwd > 0.0,
            f"Derby banked wall {dname} falsely rebounded backward (minPostFwd={d_min_fwd:.2f}, postFwd={d_post_fwd:.2f}): {dres}",
        )
        derby_summary.append(f"{dname}={d_max_y:.2f}m/fwd={d_post_fwd:.1f}")
      sess.assert_zero_errors("T2_F19_05")
      return f"worstCliffDeltaY={worst:.3f}m <= 1.2m, legitMegaRampMaxY={legit_max_y:.2f}m, derby=[{', '.join(derby_summary)}]"
    rec.run_case("T2_F19_05", 2, "F19", "No vertical cliff snap teleport across 5 sheer cliffs (<=1.2m) while mega_ramp & Derby banked walls climb smoothly", _t2_f19_05)

    def _t2_f19_06() -> str:
      sess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=2)
      _select_zone(sess, rec, "hub_lab")
      _tap_fix(sess, rec)

      # Sub-check A: camera.js visibilitychange orbit release
      cam_ok = sess.eval_js(
          """(async () => {
            const THREE = await import(new URL('./vendor/three.module.min.js', window.location.href).href);
            let liveCam = null;
            const origUpdate = THREE.Object3D.prototype.updateMatrixWorld;
            THREE.Object3D.prototype.updateMatrixWorld = function (...args) {
              if (!liveCam && this.isPerspectiveCamera) liveCam = this;
              return origUpdate.apply(this, args);
            };
            try {
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            } finally {
              THREE.Object3D.prototype.updateMatrixWorld = origUpdate;
            }
            window.__T5_CAM__ = liveCam;
            if (!liveCam) return { ok: false };
            const cv = document.getElementById('game-canvas');
            const r = cv.getBoundingClientRect();
            const cx = r.left + r.width * 0.5;
            const cy = r.top + r.height * 0.45;
            cv.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, pointerId: 901, pointerType: 'touch', button: 0, clientX: cx, clientY: cy,
            }));
            cv.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true, cancelable: true, pointerId: 901, pointerType: 'touch', button: 0, clientX: cx + 25, clientY: cy,
            }));
            const hiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
            try {
              Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
              document.dispatchEvent(new Event('visibilitychange'));
            } finally {
              if (hiddenDesc) Object.defineProperty(document, 'hidden', hiddenDesc);
              else delete document.hidden;
              document.dispatchEvent(new Event('visibilitychange'));
            }
            return { ok: true, yawBefore: liveCam.rotation.y };
          })()""",
          await_promise=True,
      ) or {}
      _assert(cam_ok.get("ok"), f"Failed camera visibilitychange setup: {cam_ok}")
      x1, y1, x2, y2 = _find_open_canvas_drag_segment(sess, dx_frac=-0.18, dy_frac=0.0)
      sess.touch_drag(x1, y1, x2, y2, steps=8, step_delay_ms=10, touch_id=1)
      sess.wait_raf(2)
      yaw_after = float(sess.eval_js("const y = window.__T5_CAM__ ? window.__T5_CAM__.rotation.y : 0; delete window.__T5_CAM__; y;", await_promise=False) or 0.0)
      yaw_diff = abs(math.atan2(math.sin(yaw_after - float(cam_ok["yawBefore"])), math.cos(yaw_after - float(cam_ok["yawBefore"]))))
      _assert(yaw_diff > 0.25, f"camera.js orbit stayed locked after visibilitychange (yawDiff={yaw_diff:.4f} rad)")

      # Sub-check B: touch_bind.js .is-pressed release on window.blur & visibilitychange
      press_res = sess.eval_js(
          """(() => {
            const btn = document.getElementById('btn-repair');
            btn.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, pointerId: 902, pointerType: 'touch', button: 0,
            }));
            const down1 = btn.classList.contains('is-pressed');
            window.dispatchEvent(new Event('blur'));
            const afterBlur = btn.classList.contains('is-pressed');

            btn.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, pointerId: 903, pointerType: 'touch', button: 0,
            }));
            const down2 = btn.classList.contains('is-pressed');
            const hiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
            try {
              Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
              document.dispatchEvent(new Event('visibilitychange'));
            } finally {
              if (hiddenDesc) Object.defineProperty(document, 'hidden', hiddenDesc);
              else delete document.hidden;
              document.dispatchEvent(new Event('visibilitychange'));
            }
            const afterVis = btn.classList.contains('is-pressed');
            return { down1, afterBlur, down2, afterVis };
          })()""",
          await_promise=False,
      ) or {}
      _assert(press_res.get("down1") and not press_res.get("afterBlur"), f".is-pressed stuck after window.blur: {press_res}")
      _assert(press_res.get("down2") and not press_res.get("afterVis"), f".is-pressed stuck after visibilitychange: {press_res}")

      # Sub-check C: G4 rapid open -> backdrop (<450ms) -> close -> immediate reopen -> backdrop (<450ms, >=450ms)
      _open_garage(sess, rec)
      bp = _find_backdrop_point(sess, "#modal-garage")
      _assert(bp.get("found"), "Could not locate #modal-garage backdrop")
      time.sleep(0.10)
      sess.touch_tap(bp["x"], bp["y"], hold_ms=12)
      sess.wait_raf(1)
      _assert(_get_state(sess).get("activeModal") == "garage", "Garage closed early on cycle 1")
      sess.touch_tap_selector("#btn-garage-close", timeout_s=rec.scale(2.0))
      sess.wait_raf(1)
      _assert(_get_state(sess).get("activeModal") is None, "Garage did not close on close button")
      _open_garage(sess, rec)
      time.sleep(0.10)
      sess.touch_tap(bp["x"], bp["y"], hold_ms=12)
      sess.wait_raf(1)
      _assert(_get_state(sess).get("activeModal") == "garage", "Garage closed early on immediate reopen (stale openedAt)")
      time.sleep(0.42)
      sess.touch_tap(bp["x"], bp["y"], hold_ms=12)
      sess.wait_raf(2)
      _assert(_get_state(sess).get("activeModal") is None, "Garage failed to dismiss after >=450ms on reopen")

      # Sub-check D: G4 ghost-click check (backdrop dismiss over underlying HUD button fires 0 underlying actions)
      _open_garage(sess, rec)
      time.sleep(0.52)
      ghost_pt = sess.eval_js(
          """(() => {
            const modal = document.getElementById('modal-garage');
            for (const sel of ['#btn-tnt', '#btn-repair', '#btn-camera', '#btn-ragdoll', '#btn-audio']) {
              const el = document.querySelector(sel);
              if (!el) continue;
              const r = el.getBoundingClientRect();
              const x = r.left + r.width * 0.5;
              const y = r.top + r.height * 0.5;
              if (document.elementFromPoint(x, y) === modal) {
                return { found: true, sel, x, y };
              }
            }
            return { found: false };
          })()""",
          await_promise=False,
      ) or {}
      _assert(ghost_pt.get("found"), f"No HUD button lay directly under #modal-garage backdrop: {ghost_pt}")
      before_counts = dict(_get_state(sess).get("hudActionCounts") or {})
      sess.touch_tap(ghost_pt["x"], ghost_pt["y"], hold_ms=15)
      sess.wait_raf(3)
      after_st = _get_state(sess)
      ghost_deltas = _action_deltas(before_counts, after_st.get("hudActionCounts") or {})
      _assert(after_st.get("activeModal") is None, "Ghost-click backdrop tap did not dismiss garage")
      _assert(len(ghost_deltas) == 0, f"Ghost click leaked through backdrop onto {ghost_pt['sel']}: {ghost_deltas}")
      sess.assert_zero_errors("T2_F19_06")
      return f"orbitYaw={yaw_diff:.2f}rad, pressedClean=true, rapidReopen=ok, ghostOver={ghost_pt['sel']}:0"
    rec.run_case("T2_F19_06", 2, "F19", "camera.js visibilitychange orbit release + .is-pressed cleanup + G4 rapid reopen & ghost-click guard", _t2_f19_06)

    def _t2_f19_07() -> str:
      # Sub-check A: Modal-open hazard pause in derby_arena
      _select_vehicle(sess, rec, "sedan")
      _select_zone(sess, rec, "derby_arena")
      _tap_fix(sess, rec)
      _open_garage(sess, rec)
      st0 = _get_state(sess)
      hp0 = float(st0["integrity"])
      _step_frames(sess, 240, 1.0 / 60.0)
      st1 = _get_state(sess)
      _close_modals(sess)
      _assert(float(st1["integrity"]) == hp0 and not st1.get("wrecked"), f"Derby AI damaged player while Garage modal open: {hp0} -> {st1['integrity']} (wrecked={st1.get('wrecked')})")

      # Sub-check B: High-speed steering drift creates real lateral slip & fx_skid_marks
      _select_zone(sess, rec, "hub_lab")
      _tap_fix(sess, rec)
      cap_skid = sess.eval_js(
          """(async () => {
            const THREE = await import(new URL('./vendor/three.module.min.js', window.location.href).href);
            let liveScene = null;
            const origUpdate = THREE.Object3D.prototype.updateMatrixWorld;
            THREE.Object3D.prototype.updateMatrixWorld = function (...args) {
              if (!liveScene && this.isScene) liveScene = this;
              return origUpdate.apply(this, args);
            };
            try {
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            } finally {
              THREE.Object3D.prototype.updateMatrixWorld = origUpdate;
            }
            let skidMesh = null;
            if (liveScene) {
              liveScene.traverse((o) => { if (o.name === 'fx_skid_marks') skidMesh = o; });
            }
            window.__T5_SKID__ = skidMesh;
            return { found: Boolean(skidMesh), count0: skidMesh ? skidMesh.count : -1 };
          })()""",
          await_promise=True,
      ) or {}
      _assert(cap_skid.get("found"), f"fx_skid_marks mesh not found in scene: {cap_skid}")
      count0 = int(cap_skid["count0"])
      try:
        with sess.hold_touches([("#btn-gas", 1), ("#btn-boost", 2)]):
          _step_frames(sess, 95, 1.0 / 60.0)
          peak_spd = float(_get_state(sess)["speedKmh"])
        with sess.hold_touches([("#btn-gas", 1), ("#btn-steer-left", 2)]):
          _step_frames(sess, 90, 1.0 / 60.0)
        count1 = int(sess.eval_js("window.__T5_SKID__ ? window.__T5_SKID__.count : -1", await_promise=False) or -1)
      finally:
        sess.eval_js("delete window.__T5_SKID__; true;", await_promise=False)
        _tap_fix(sess, rec)

      _assert(peak_spd >= 100.0, f"Sedan did not reach high speed before drift turn: {peak_spd:.1f} km/h")
      _assert(count1 > count0, f"High-speed full-lock turn produced 0 new skid marks ({count0} -> {count1})")

      # Sub-check C: FIX-9 manual EJECT -> GAS re-seat vs wrecked ragdoll preserved under GAS
      _select_zone(sess, rec, "hub_lab")
      _tap_fix(sess, rec)
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0))
      _step_frames(sess, 6, 1.0 / 60.0)
      st_eject = _get_state(sess)
      _assert(
          st_eject.get("ragdolling") is True and not st_eject.get("wrecked"),
          f"Manual #btn-ragdoll did not eject non-wrecked avatar: {st_eject}",
      )
      with sess.hold_touches([("#btn-gas", 1)]):
        _step_frames(sess, 12, 1.0 / 60.0)
      st_reseat = _get_state(sess)
      _assert(
          st_reseat.get("ragdolling") is False,
          f"FIX-9 failed: #btn-gas did not re-seat manually ejected driver: {st_reseat}",
      )
      for _ in range(5):
        if _get_state(sess).get("wrecked"):
          break
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 15, 1.0 / 60.0)
      st_wreck0 = _get_state(sess)
      _assert(
          st_wreck0.get("wrecked") is True and st_wreck0.get("ragdolling") is True,
          f"Expected wrecked ragdoll after TNT taps: {st_wreck0}",
      )
      with sess.hold_touches([("#btn-gas", 1)]):
        _step_frames(sess, 25, 1.0 / 60.0)
      st_wreck1 = _get_state(sess)
      _assert(
          st_wreck1.get("wrecked") is True and st_wreck1.get("ragdolling") is True,
          f"FIX-9 regression: #btn-gas re-seated wrecked driver: {st_wreck1}",
      )
      _tap_fix(sess, rec)

      # Sub-check D: GAP-CLOSE-2 opening #btn-garage while boosting silences nitroGain (<= 0.001)
      was_muted = bool(sess.eval_js(
          "Boolean(document.getElementById('btn-audio')?.classList.contains('is-muted'))",
          await_promise=False,
      ))
      if was_muted:
        sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0))
      sess.eval_js(
          """(() => {
            const orig = AudioParam.prototype.setTargetAtTime;
            window.__T5_NITRO_SPY__ = {
              orig,
              nitroParam: null,
              phase: 'boost',
              boostMax: 0,
              modalTargets: [],
            };
            AudioParam.prototype.setTargetAtTime = function (target, startTime, timeConstant) {
              const spy = window.__T5_NITRO_SPY__;
              if (spy) {
                if (
                  !spy.nitroParam
                  && spy.phase === 'boost'
                  && Math.abs(target - 0.24) < 0.01
                  && Math.abs(timeConstant - 0.04) < 0.005
                ) {
                  spy.nitroParam = this;
                }
                if (this === spy.nitroParam) {
                  if (spy.phase === 'boost') {
                    if (target > spy.boostMax) spy.boostMax = target;
                  } else if (spy.phase === 'modal') {
                    spy.modalTargets.push(target);
                  }
                }
              }
              return orig.call(this, target, startTime, timeConstant);
            };
            return true;
          })()""",
          await_promise=False,
      )
      nitro_spy = {}
      try:
        with sess.hold_touches([("#btn-gas", 1), ("#btn-boost", 2)]):
          _step_frames(sess, 20, 1.0 / 60.0)
          sess.touch_tap_selector("#btn-garage", timeout_s=rec.scale(2.0), touch_id=3)
          sess.wait_raf(1)
          st_modal_open = _get_state(sess)
          _assert(
              st_modal_open.get("activeModal") == "garage",
              f"Garage modal failed to open while boosting: {st_modal_open}",
          )
          sess.eval_js(
              "if (window.__T5_NITRO_SPY__) window.__T5_NITRO_SPY__.phase = 'modal'; true;",
              await_promise=False,
          )
          _step_frames(sess, 20, 1.0 / 60.0)
        _step_frames(sess, 10, 1.0 / 60.0)
        nitro_spy = sess.eval_js(
            """(() => {
              const spy = window.__T5_NITRO_SPY__;
              if (!spy) return { captured: false };
              return {
                captured: Boolean(spy.nitroParam),
                boostMax: spy.boostMax,
                modalCount: spy.modalTargets.length,
                modalMax: spy.modalTargets.length ? Math.max(...spy.modalTargets) : -1,
              };
            })()""",
            await_promise=False,
        ) or {}
      finally:
        sess.eval_js(
            """(() => {
              const spy = window.__T5_NITRO_SPY__;
              if (spy && spy.orig) AudioParam.prototype.setTargetAtTime = spy.orig;
              delete window.__T5_NITRO_SPY__;
              return true;
            })()""",
            await_promise=False,
        )
        _close_modals(sess)
        if was_muted:
          sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0))
        _tap_fix(sess, rec)

      _assert(
          nitro_spy.get("captured") and float(nitro_spy.get("boostMax", 0.0)) >= 0.20,
          f"Did not capture active nitroGain (~0.24) while boosting before modal open: {nitro_spy}",
      )
      _assert(
          int(nitro_spy.get("modalCount", 0)) >= 10 and float(nitro_spy.get("modalMax", 1.0)) <= 0.001,
          f"GAP-CLOSE-2: nitroGain stayed audible while Garage modal paused: {nitro_spy}",
      )
      sess.assert_zero_errors("T2_F19_07")
      return (
          f"derbyModalPause hp={hp0:.0f}->{st1['integrity']:.0f}, "
          f"driftPeak={peak_spd:.0f}km/h skids={count0}->{count1}, "
          f"ejectReseat=ok/wreckStay=ok, "
          f"modalNitro={nitro_spy['boostMax']:.2f}->{nitro_spy['modalMax']:.4f}"
      )
    rec.run_case("T2_F19_07", 2, "F19", "Modal-open hazard/nitro-audio pause + drift skid marks + FIX-9 eject/wreck GAS reseat behavior", _t2_f19_07)

    def _t2_f19_08() -> str:
      # Bind live THREE.WebGLRenderer via CDP Runtime.queryObjects + scene node count + DOM count
      proto_res = sess.cdp(
          "Runtime.evaluate",
          {
              "expression": "(async () => { const THREE = await import(new URL('./vendor/three.module.min.js', window.location.href).href); return THREE.WebGLRenderer.prototype; })()",
              "awaitPromise": True,
              "returnByValue": False,
          },
      )
      proto_id = (proto_res.get("result") or {}).get("objectId")
      _assert(bool(proto_id), f"Failed to resolve WebGLRenderer.prototype: {proto_res}")
      q_res = sess.cdp("Runtime.queryObjects", {"prototypeObjectId": proto_id})
      arr_id = (q_res.get("objects") or {}).get("objectId")
      _assert(bool(arr_id), f"Failed to query WebGLRenderer instances: {q_res}")

      def _sample_mem() -> dict[str, int]:
        mem = sess.cdp(
            "Runtime.callFunctionOn",
            {
                "objectId": arr_id,
                "functionDeclaration": """function() {
                  const r = this[0];
                  return {
                    geometries: r ? r.info.memory.geometries : -1,
                    textures: r ? r.info.memory.textures : -1,
                    domNodes: document.querySelectorAll('*').length,
                  };
                }""",
                "returnByValue": True,
            },
        )
        val = (mem.get("result") or {}).get("value") or {}
        sc_nodes = int(sess.eval_js(
            """(async () => {
              const THREE = await import(new URL('./vendor/three.module.min.js', window.location.href).href);
              let liveScene = null;
              const origUpdate = THREE.Object3D.prototype.updateMatrixWorld;
              THREE.Object3D.prototype.updateMatrixWorld = function (...args) {
                if (!liveScene && this.isScene) liveScene = this;
                return origUpdate.apply(this, args);
              };
              try {
                await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              } finally {
                THREE.Object3D.prototype.updateMatrixWorld = origUpdate;
              }
              let n = 0;
              if (liveScene) liveScene.traverse(() => { n += 1; });
              return n;
            })()""",
            await_promise=True,
        ) or 0)
        return {
            "geometries": int(val.get("geometries", -1)),
            "textures": int(val.get("textures", -1)),
            "domNodes": int(val.get("domNodes", -1)),
            "sceneNodes": sc_nodes,
        }

      try:
        _select_zone(sess, rec, "hub_lab")
        for round_idx in range(2):
          for vid in ("sedan", "school_bus", "tuk_tuk", "monster_truck"):
            _select_vehicle(sess, rec, vid)
            sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
            sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
            _step_frames(sess, 20, 1.0 / 60.0)
            _tap_fix(sess, rec)
          if round_idx == 0:
            r1 = _sample_mem()
          else:
            r2 = _sample_mem()
      finally:
        try:
          sess.cdp("Runtime.releaseObject", {"objectId": arr_id})
          sess.cdp("Runtime.releaseObject", {"objectId": proto_id})
        except Exception:
          pass
        _select_vehicle(sess, rec, "sedan")
        _tap_fix(sess, rec)

      _assert(r1["geometries"] > 0 and r1["textures"] > 0, f"Invalid renderer.info.memory sample: {r1}")
      dg = r2["geometries"] - r1["geometries"]
      dt = r2["textures"] - r1["textures"]
      dd = r2["domNodes"] - r1["domNodes"]
      ds = r2["sceneNodes"] - r1["sceneNodes"]
      _assert(dg <= 2 and dt <= 2, f"GPU geometry/texture leak detected R1->R2: r1={r1}, r2={r2}")
      _assert(dd <= 2 and ds <= 4, f"DOM/scene node leak detected R1->R2: r1={r1}, r2={r2}")
      sess.assert_zero_errors("T2_F19_08")
      return f"R1->R2 delta geo={dg:+d} tex={dt:+d} scene={ds:+d} dom={dd:+d}"
    rec.run_case("T2_F19_08", 2, "F19", "GPU/WebGL2/scene/DOM zero-leak across repeated vehicle swaps + debris detach + repair", _t2_f19_08)


# ---------------------------------------------------------------------------
# TIER 3: Cross-Feature Pairwise Combinations (24 Cases: T3_P01 .. T3_P24)
# ---------------------------------------------------------------------------

def run_tier_3(
    browser: cdp.CdpBrowser,
    rec: SuiteRecorder,
    *,
    live_url: str | None,
    url_query: str,
) -> None:
  print("\n=== TIER 3: Pairwise Combinatorial Coverage (24 Cases) ===")
  url, _ = _target_url(browser, live_url, url_query)

  with browser.new_session(
      width=1180,
      height=820,
      dpr=2.0,
      mobile=True,
      install_preboot_spy=False,
      install_audio_spy=False,
  ) as sess:
    boot_ok = False
    boot_err = ""
    try:
      boot_ok = sess.goto(url, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(25.0))
      if boot_ok:
        sess.wait_raf(3)
        _ensure_started(sess, rec)
    except Exception as exc:
      boot_ok = False
      boot_err = f"{type(exc).__name__}: {exc}"
    if not boot_ok:
      rec.run_case(
          "T3_BOOT",
          3,
          "Boot",
          f"Tier 3 session boot {url}",
          lambda: (_assert(False, f"Tier 3 session failed to boot {url}: {boot_err}"), "")[-1],
      )
      return

    # P01..P14: 14 Vehicle x Zone pairs covering all 12 vehicles & all 14 zones
    for cid, vid, zid, need_dmg in TIER3_VEHICLE_ZONE_PAIRS:
      def _pair_vz(v: str = vid, z: str = zid, dmg: bool = need_dmg) -> str:
        _select_vehicle(sess, rec, v)
        _select_zone(sess, rec, z)
        _tap_fix(sess, rec)
        _assert_material_compliant(sess, f"{v}x{z}")
        _, after = _run_zone_action(sess, rec, expect_damage=dmg, use_trigger=True, use_boost=(not dmg))
        _tap_fix(sess, rec)
        return f"{v}@{z}: integrity={after['integrity']}, parts={after['detachedParts']}"
      rec.run_case(cid, 3, "F9xF14/F15", f"Pair {vid} x {zid} (spawn + warp + smash + FIX)", _pair_vz)

    # P15..P24: 10 Cross-UI / System Pairs
    def _p15() -> str:
      _select_vehicle(sess, rec, "smart_micro", paint_id="purple")
      _select_zone(sess, rec, "shredder_tunnels")
      _run_zone_action(sess, rec, expect_damage=True)
      _assert_material_compliant(sess, "T3_P15")
      _tap_fix(sess, rec)
      return "purple smart_micro @ shredder ok"
    rec.run_case("T3_P15", 3, "F3xF9xF15", "Paint swatch (purple) x Shredder damage x Metalness <= 0.22", _p15)

    def _p16() -> str:
      _select_zone(sess, rec, "hub_lab")
      _tap_fix(sess, rec)
      with sess.hold_touches([("#btn-gas", 1), ("#btn-steer-right", 2), ("#btn-boost", 3)]):
        _step_frames(sess, 20, 1.0 / 60.0)
      x1, y1, x2, y2 = _find_open_canvas_drag_segment(sess, dx_frac=-0.10, dy_frac=-0.01)
      sess.touch_drag(x1, y1, x2, y2, steps=6, step_delay_ms=8, touch_id=1)
      sess.wait_raf(1)
      st = _get_state(sess)
      _assert(abs(float(st["cameraRoll"])) < 1e-4, "cameraRoll non-zero after multi-touch + orbit")
      return "multi-touch + orbit roll=0"
    rec.run_case("T3_P16", 3, "F4xF8xF16", "3-finger GAS+STEER+NOS x Open-canvas orbit drag (zero roll)", _p16)

    def _p17() -> str:
      for _ in range(4):
        if _get_state(sess).get("cameraMode") == "cockpit":
          break
        sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(2.0))
        sess.wait_raf(1)
      _select_zone(sess, rec, "crash_c4_wall")
      _run_zone_action(sess, rec, expect_damage=True)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(sess, 15, 1.0 / 60.0)
      st = _tap_fix(sess, rec)
      _assert(abs(float(st["cameraRoll"])) < 1e-4, "cockpit roll non-zero")
      for _ in range(4):
        if _get_state(sess).get("cameraMode") == "chase":
          break
        sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(2.0))
        sess.wait_raf(1)
      return "cockpit crash+FIX ok"
    rec.run_case("T3_P17", 3, "F8xF12xF15", "Cockpit camera x C4 Wall Auto-Smash + TNT + FIX", _p17)

    def _p18() -> str:
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0))
      sess.wait_raf(2)
      _assert(bool(_get_state(sess).get("ragdolling")), "ragdoll failed")
      st = _select_zone(sess, rec, "train_crossing")
      _assert(not st.get("ragdolling"), "ragdoll persisted after teleport")
      return "ragdoll cleared by teleport"
    rec.run_case("T3_P18", 3, "F11xF14xF18", "Ragdoll ejection x Teleport to train_crossing auto-reseats", _p18)

    def _p19() -> str:
      sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0))
      _select_zone(sess, rec, "hydraulic_press")
      _run_zone_action(sess, rec, expect_damage=True)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _tap_fix(sess, rec)
      sess.touch_tap_selector("#btn-audio", timeout_s=rec.scale(2.0))
      sess.assert_zero_errors("T3_P19")
      return "muted crush+TNT+FIX clean"
    rec.run_case("T3_P19", 3, "F7xF12xF14", "Muted audio x Hydraulic Press crush + TNT + FIX", _p19)

    def _p20() -> str:
      before = _tap_fix(sess, rec)
      for _ in range(3):
        sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
        _step_frames(sess, 15, 1.0 / 60.0)
      mid = _get_state(sess)
      _assert(
          float(mid["integrity"]) < float(before["integrity"]) * 0.85,
          f"Expected damaged vehicle before swap ({before['integrity']} -> {mid['integrity']})",
      )
      st = _select_vehicle(sess, rec, "rally_raider")
      _assert(float(st["integrity"]) >= float(st["maxIntegrity"]) - 0.1 and int(st["detachedParts"]) == 0, "Garage swap did not restore intact vehicle")
      return "swapped to intact rally_raider"
    rec.run_case("T3_P20", 3, "F9xF10xF18", "Damaged vehicle x Garage vehicle swap restores 100% integrity", _p20)

    def _p21() -> str:
      sess.set_viewport(820, 1180, dpr=2.0, mobile=True, wait_frames=2)
      tp = _probe_modal_guard_timing(sess, "#btn-teleport", "#modal-teleport", early_ms=430, late_ms=490)
      _assert(not tp.get("error"), f"Portrait modal probe error: {tp}")
      _assert(tp.get("tEarly", 999) < 446 and bool(tp.get("openEarly")), f"Portrait modal closed early: {tp}")
      _assert(tp.get("tLate", 0) >= 485 and not tp.get("openLate"), f"Portrait modal did not close late: {tp}")
      _select_zone(sess, rec, "ski_jump")
      sess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=2)
      return "portrait 450ms guard + ski_jump ok"
    rec.run_case("T3_P21", 3, "F5xF15xF18", "Portrait 820x1180 x Teleport 450ms backdrop guard + ski_jump warp", _p21)

    def _p22() -> str:
      _close_modals(sess)
      res = sess.eval_js(
          """(async () => {
            const b = document.querySelector('#btn-garage');
            const before = { ...(window.__ROBLOX_CAR_CRASH__.getState().hudActionCounts || {}) };
            b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0 }));
            b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0 }));
            await new Promise((r) => setTimeout(r, 600));
            b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
            const after = { ...(window.__ROBLOX_CAR_CRASH__.getState().hudActionCounts || {}) };
            return { before, after, activeModal: window.__ROBLOX_CAR_CRASH__.getState().activeModal };
          })()""",
          await_promise=True,
      ) or {}
      d = _action_deltas(res.get("before") or {}, res.get("after") or {})
      _close_modals(sess)
      _assert(len(d) == 1 and sum(d.values()) == 1 and res.get("activeModal") == "garage", f"Delayed click broke #btn-garage: {res}")
      return "garage stayed open +1"
    rec.run_case("T3_P22", 3, "F4xF5", "Delayed 600ms synthetic click x #btn-garage modal open stays single-fire", _p22)

    def _p23() -> str:
      _select_zone(sess, rec, "derby_arena")
      _tap_fix(sess, rec)
      before = _get_state(sess)
      _, after = _run_zone_action(sess, rec, expect_damage=True)
      _assert(float(after["cash"]) > float(before["cash"]) or float(after["xp"]) > float(before["xp"]), "Derby crash gave no cash/xp")
      _tap_fix(sess, rec)
      return f"cash +{float(after['cash']) - float(before['cash']):.0f}"
    rec.run_case("T3_P23", 3, "F15xF17", "derby_arena Auto-Smash x Cash/XP & Combo Scorecard progression", _p23)

    def _p24() -> str:
      _select_zone(sess, rec, "hub_lab")
      _tap_fix(sess, rec)
      sess.set_viewport(768, 1024, dpr=2.0, mobile=True, wait_frames=2)
      with sess.hold_touches([("#btn-gas", None)]):
        _step_frames(sess, 20, 1.0 / 60.0)
        mid = _get_state(sess)
      _assert(float(mid["speedKmh"]) > 2.0, f"Driving failed in 768x1024 portrait: {mid['speedKmh']}")
      _tap_fix(sess, rec)
      sess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=2)
      sess.assert_zero_errors("T3_P24")
      return f"768x1024 speed={mid['speedKmh']}"
    rec.run_case("T3_P24", 3, "F16xF18", "Dynamic rotation (1180x820 -> 768x1024 -> 1180x820) x Active driving & FIX", _p24)


# ---------------------------------------------------------------------------
# TIER 4: Real-World Family Play Scenarios + 1280x800 Hero & Audit Pack (9 Cases)
# ---------------------------------------------------------------------------

def run_tier_4(
    browser: cdp.CdpBrowser,
    rec: SuiteRecorder,
    *,
    live_url: str | None,
    url_query: str,
    screenshots_dir: Path | None,
    hero_screenshot: Path | None,
) -> dict[str, Any]:
  print("\n=== TIER 4: Real-World Touch-Only Family Play Scenarios (9 Scenarios) ===")
  url, _ = _target_url(browser, live_url, url_query)
  screenshot_artifacts: dict[str, Any] = {}

  # Scenarios S1..S7 on cold-booted 1180x820 iPad Air Landscape tab
  s1_detached_parts = 0
  with browser.new_session(
      width=1180,
      height=820,
      dpr=2.0,
      mobile=True,
      install_preboot_spy=True,
      install_audio_spy=True,
  ) as sess:
    def _s1() -> str:
      nonlocal s1_detached_parts
      ok = sess.goto(url, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(25.0))
      _assert(ok, "S1 boot failed")
      sess.wait_raf(3)
      spy = sess.get_preboot_spy()
      _assert(int(spy.get("preRafCompileShaders", -1)) == 0 and int(spy.get("preRafLinkPrograms", -1)) == 0, f"S1 pre-rAF compile: {spy}")
      _ensure_started(sess, rec)
      _select_vehicle(sess, rec, "sedan", paint_id="red")
      _select_zone(sess, rec, "hydraulic_press")
      _tap_fix(sess, rec)
      before, after = _run_zone_action(sess, rec, expect_damage=True, use_trigger=True)
      if int(after["detachedParts"]) == 0:
        # Give a second crush cycle to allow part detachment on lighter first glance.
        tinfo = sess.locate_selector("#btn-machine-trigger", timeout_s=0.1)
        if tinfo.get("found") and tinfo.get("hitTestable"):
          sess.touch_tap(tinfo["x"], tinfo["y"], hold_ms=10)
        _step_frames(sess, 45, 1.0 / 60.0)
        after = _get_state(sess)
      s1_detached_parts = int(after["detachedParts"])
      _assert(float(after["cash"]) > float(before["cash"]), "S1 press crash awarded no cash")
      _tap_fix(sess, rec)
      sess.assert_zero_errors("T4_S01")
      return f"integrity={after['integrity']}, parts={after['detachedParts']}, cash+{float(after['cash'])-float(before['cash']):.0f}"
    rec.run_case("T4_S01", 4, "Scenario", "S1: Classic Demolition Lab Hydraulic Press Loop (Red Sedan)", _s1)

    def _s2() -> str:
      _select_vehicle(sess, rec, "school_bus", paint_id="yellow")
      _select_zone(sess, rec, "train_crossing")
      _tap_fix(sess, rec)
      before, after = _run_zone_action(sess, rec, expect_damage=True, use_trigger=True)
      _assert_material_compliant(sess, "T4_S02")
      _assert(float(after["cash"]) > float(before["cash"]), "S2 train hit awarded no cash")
      _tap_fix(sess, rec)
      sess.assert_zero_errors("T4_S02")
      return f"school_bus@train integrity={after['integrity']}"
    rec.run_case("T4_S02", 4, "Scenario", "S2: School Bus vs. Moving Diesel Train Crossing", _s2)

    def _s3() -> str:
      _select_vehicle(sess, rec, "smart_micro", paint_id="purple")
      _select_zone(sess, rec, "shredder_tunnels")
      _tap_fix(sess, rec)
      before, after = _run_zone_action(sess, rec, expect_damage=True, use_trigger=True, use_boost=True)
      if int(after["detachedParts"]) == 0:
        _step_frames(sess, 45, 1.0 / 60.0)
        after = _get_state(sess)
      s3_detached = int(after["detachedParts"])
      _assert(
          s3_detached >= 1 or s1_detached_parts >= 1,
          f"Crushers produced zero detached parts across S1 (parts={s1_detached_parts}) and S3 (parts={s3_detached})",
      )
      _assert(float(after["xp"]) > float(before["xp"]) or int(after["level"]) > int(before["level"]), "S3 shredder gave no XP")
      _tap_fix(sess, rec)
      sess.assert_zero_errors("T4_S03")
      return f"smart_micro@shredder integrity={after['integrity']}, parts={s3_detached}, xp+{float(after['xp'])-float(before['xp']):.0f}"
    rec.run_case("T4_S03", 4, "Scenario", "S3: RGB Spiked Shredder Tunnels Gauntlet (Purple Smart Micro)", _s3)

    def _s4() -> str:
      _select_vehicle(sess, rec, "beetle")
      _select_zone(sess, rec, "ski_jump")
      _tap_fix(sess, rec)
      before, after = _run_zone_action(sess, rec, expect_damage=False, use_boost=True)
      _tap_fix(sess, rec)
      sess.assert_zero_errors("T4_S04")
      return f"beetle@ski_jump speed={after['speedKmh']}, cash={after['cash']}"
    rec.run_case("T4_S04", 4, "Scenario", "S4: Giant Ski Jump (50-1500) Nitro & Trick Combo Session (VW Beetle)", _s4)

    def _s5() -> str:
      _select_zone(sess, rec, "hub_lab")
      _select_vehicle(sess, rec, "semi_truck")
      _tap_fix(sess, rec)
      before = _get_state(sess)
      sess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      sess.touch_tap_selector("#btn-auto-smash", timeout_s=rec.scale(2.0))
      _step_frames(sess, 35, 1.0 / 60.0)
      sess.touch_tap_selector("#btn-ragdoll", timeout_s=rec.scale(2.0))
      _step_frames(sess, 15, 1.0 / 60.0)
      mid = _get_state(sess)
      _assert(bool(mid.get("ragdolling")), "S5 ragdoll did not activate")
      _assert(float(mid["integrity"]) < float(before["integrity"]), "S5 TNT+smash produced no damage")
      _tap_fix(sess, rec)
      sess.assert_zero_errors("T4_S05")
      return f"semi_truck blast integrity={mid['integrity']}, parts={mid['detachedParts']}"
    rec.run_case("T4_S05", 4, "Scenario", "S5: Demolition Lab Glass Blast + Dynamite + Ragdoll Eject (Semi Truck)", _s5)

    def _s6() -> str:
      _select_zone(sess, rec, "derby_arena")
      _select_vehicle(sess, rec, "pickup")
      _tap_fix(sess, rec)
      with sess.hold_touches([("#btn-gas", 1), ("#btn-steer-left", 2), ("#btn-boost", 3)]):
        _step_frames(sess, 20, 1.0 / 60.0)
      x1, y1, x2, y2 = _find_open_canvas_drag_segment(sess, dx_frac=-0.12, dy_frac=-0.02)
      sess.touch_drag(x1, y1, x2, y2, steps=8, step_delay_ms=10, touch_id=1)
      sess.wait_raf(1)
      _assert(abs(float(_get_state(sess)["cameraRoll"])) < 1e-4, "S6 orbit induced roll")
      for _ in range(3):
        sess.touch_tap_selector("#btn-camera", timeout_s=rec.scale(2.0))
        sess.wait_raf(1)
        _assert(abs(float(_get_state(sess)["cameraRoll"])) < 1e-4, "S6 camera cycle induced roll")
      _run_zone_action(sess, rec, expect_damage=True)
      _tap_fix(sess, rec)
      sess.assert_zero_errors("T4_S06")
      return "derby multi-touch + orbit + crash ok"
    rec.run_case("T4_S06", 4, "Scenario", "S6: Banked-Wall Derby Arena Multi-Touch Driving & Orbit Cam (Pickup)", _s6)

    def _s7() -> str:
      _select_vehicle(sess, rec, "tuk_tuk")
      _select_zone(sess, rec, "wrecking_balls")
      _tap_fix(sess, rec)
      _run_zone_action(sess, rec, expect_damage=True)
      _select_zone(sess, rec, "lava_obby")
      _tap_fix(sess, rec)
      _, after = _run_zone_action(sess, rec, expect_damage=True)
      _tap_fix(sess, rec)
      sess.assert_zero_errors("T4_S07")
      return f"tuk_tuk lava_obby integrity={after['integrity']}, zero soft-lock"
    rec.run_case("T4_S07", 4, "Scenario", "S7: Wrecking Balls + Lava Obby Zero Soft-Lock Endurance (Tuk-Tuk)", _s7)

  # S8: Cold Portrait iPad (820x1180) Full Family Play Session + Dynamic Rotate
  with browser.new_session(
      width=820,
      height=1180,
      dpr=2.0,
      mobile=True,
      install_preboot_spy=True,
      install_audio_spy=True,
  ) as psess:
    def _s8() -> str:
      ok = psess.goto(url, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(25.0))
      _assert(ok, "S8 Portrait boot failed")
      psess.wait_raf(3)
      r_title = layout_audit.measure_layout_state(psess, "title", None)
      _assert(r_title.get("passed"), f"S8 Portrait title layout failed: {layout_audit._summarize_failures(r_title)}")
      _ensure_started(psess, rec)
      r_play = layout_audit.measure_layout_state(psess, "play_active", None)
      _assert(r_play.get("passed"), f"S8 Portrait play layout failed: {layout_audit._summarize_failures(r_play)}")
      gp = _probe_modal_guard_timing(psess, "#btn-garage", "#modal-garage", early_ms=430, late_ms=490)
      _assert(not gp.get("error") and gp.get("tEarly", 999) < 446 and bool(gp.get("openEarly")) and not gp.get("openLate"), f"S8 Portrait 450ms guard failed: {gp}")
      _select_vehicle(psess, rec, "monster_truck", paint_id="cyan")
      _select_zone(psess, rec, "giant_hammer")
      _tap_fix(psess, rec)
      _run_zone_action(psess, rec, expect_damage=True, use_trigger=True)
      psess.touch_tap_selector("#btn-tnt", timeout_s=rec.scale(2.0))
      _step_frames(psess, 15, 1.0 / 60.0)
      _tap_fix(psess, rec)
      # Dynamic rotate to Landscape 1180x820 and drive smoothly
      psess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=3)
      r_rot = layout_audit.measure_layout_state(psess, "play_active", None)
      _assert(r_rot.get("passed"), f"S8 Rotated landscape layout failed: {layout_audit._summarize_failures(r_rot)}")
      with psess.hold_touches([("#btn-gas", None)]):
        _step_frames(psess, 20, 1.0 / 60.0)
        mid = _get_state(psess)
      _assert(float(mid["speedKmh"]) > 2.0, "S8 driving failed after portrait->landscape rotate")
      psess.assert_zero_errors("T4_S08")
      return f"portrait->landscape speed={mid['speedKmh']}"
    rec.run_case("T4_S08", 4, "Scenario", "S8: Portrait iPad (820x1180) Family Play + Dynamic Landscape Rotation", _s8)

  # S9: 1280x800 Hero Screenshot & 8-Image Fable Play-First Audit Pack
  with browser.new_session(
      width=1280,
      height=800,
      dpr=2.0,
      mobile=True,
      install_preboot_spy=True,
      install_audio_spy=True,
  ) as hsess:
    def _s9() -> str:
      tmp_dir_obj = None
      if screenshots_dir is not None:
        out_dir = screenshots_dir
        out_dir.mkdir(parents=True, exist_ok=True)
      else:
        tmp_dir_obj = tempfile.TemporaryDirectory(prefix="rcd_s9_shots_")
        out_dir = Path(tmp_dir_obj.name)

      try:
        ok = hsess.goto(url, wait_expr="Boolean(window.__ROBLOX_CAR_CRASH__)", timeout_s=rec.scale(25.0))
        _assert(ok, "S9 1280x800 boot failed")
        hsess.wait_raf(3)

        # 01: Title 1280x800
        m1 = hsess.capture_screenshot_jpeg(out_dir / "01_title_1280x800.jpg", width=1280, height=800, quality=92)
        _ensure_started(hsess, rec)

        # 02: Hub / Hydraulic Press active crash (HERO 1280x800)
        _select_vehicle(hsess, rec, "rally_raider", paint_id="red")
        _select_zone(hsess, rec, "hydraulic_press")
        _tap_fix(hsess, rec)
        _run_zone_action(hsess, rec, expect_damage=True, use_trigger=True)
        hero_pack_path = out_dir / "02_hub_press_1280x800.jpg"
        m2 = hsess.capture_screenshot_jpeg(hero_pack_path, width=1280, height=800, quality=92)
        if hero_screenshot is not None:
          hero_screenshot.parent.mkdir(parents=True, exist_ok=True)
          shutil.copy2(hero_pack_path, hero_screenshot)

        # 03: Shredder Tunnel 1280x800
        _select_vehicle(hsess, rec, "smart_micro", paint_id="purple")
        _select_zone(hsess, rec, "shredder_tunnels")
        _tap_fix(hsess, rec)
        _run_zone_action(hsess, rec, expect_damage=True)
        m3 = hsess.capture_screenshot_jpeg(out_dir / "03_shredder_tunnel_1280x800.jpg", width=1280, height=800, quality=92)

        # 04: School Bus vs Train 1280x800
        _select_vehicle(hsess, rec, "school_bus", paint_id="yellow")
        _select_zone(hsess, rec, "train_crossing")
        _tap_fix(hsess, rec)
        _run_zone_action(hsess, rec, expect_damage=True, use_trigger=True)
        m4 = hsess.capture_screenshot_jpeg(out_dir / "04_train_schoolbus_1280x800.jpg", width=1280, height=800, quality=92)

        # 05: Ski Jump / Derby 1280x800
        _select_vehicle(hsess, rec, "monster_truck", paint_id="blue")
        _select_zone(hsess, rec, "ski_jump")
        _tap_fix(hsess, rec)
        _run_zone_action(hsess, rec, expect_damage=False, use_boost=True)
        m5 = hsess.capture_screenshot_jpeg(out_dir / "05_ski_jump_derby_1280x800.jpg", width=1280, height=800, quality=92)

        # 06: Garage Modal 1180x820
        hsess.set_viewport(1180, 820, dpr=2.0, mobile=True, wait_frames=2)
        _open_garage(hsess, rec)
        m6 = hsess.capture_screenshot_jpeg(out_dir / "06_garage_modal_1180x820.jpg", width=1180, height=820, quality=92)
        _close_modals(hsess)

        # 07: Teleport Modal 1180x820
        _open_teleport(hsess, rec)
        m7 = hsess.capture_screenshot_jpeg(out_dir / "07_teleport_modal_1180x820.jpg", width=1180, height=820, quality=92)
        _close_modals(hsess)

        # 08: Portrait Play 820x1180
        hsess.set_viewport(820, 1180, dpr=2.0, mobile=True, wait_frames=2)
        _select_zone(hsess, rec, "hub_lab")
        _tap_fix(hsess, rec)
        m8 = hsess.capture_screenshot_jpeg(out_dir / "08_portrait_play_820x1180.jpg", width=820, height=1180, quality=92)

        expected_specs = [
            (m1, (1280, 800)),
            (m2, (1280, 800)),
            (m3, (1280, 800)),
            (m4, (1280, 800)),
            (m5, (1280, 800)),
            (m6, (1180, 820)),
            (m7, (1180, 820)),
            (m8, (820, 1180)),
        ]
        for meta, (ew, eh) in expected_specs:
          p = Path(meta["path"])
          _assert(p.is_file() and p.stat().st_size > 10_000, f"Screenshot too small or missing: {meta}")
          with Image.open(p) as im:
            _assert(im.size == (ew, eh) and im.mode == "RGB", f"Bad JPEG spec {p.name}: {im.size}/{im.mode}")
          _assert(35.0 <= meta["mean_luma"] <= 245.0, f"Bad luma on {p.name}: {meta['mean_luma']}")
          _assert(
              meta.get("is_non_blank") and meta["rgb_std"] >= 12.0,
              f"Blank/flat image {p.name}: is_non_blank={meta.get('is_non_blank')}, rgb_std={meta['rgb_std']}",
          )

        if hero_screenshot is not None:
          _assert(hero_screenshot.is_file() and hero_screenshot.stat().st_size > 10_000, "Hero screenshot missing/small")
          with Image.open(hero_screenshot) as him:
            _assert(him.size == (1280, 800) and him.mode == "RGB", f"Hero screenshot bad spec: {him.size}/{him.mode}")

        # Verify distinct cross-scene visual differences inside the unobstructed center 3D viewport
        with Image.open(m2["path"]) as im2, Image.open(m3["path"]) as im3, Image.open(m4["path"]) as im4, Image.open(m5["path"]) as im5, Image.open(m8["path"]) as im8:
          c2 = _crop_center_3d(im2)
          c3 = _crop_center_3d(im3)
          c4 = _crop_center_3d(im4)
          c5 = _crop_center_3d(im5)
          c8 = _crop_center_3d(im8)
          for cname, cimg in (("02_hub_press", c2), ("03_shredder", c3), ("04_train", c4), ("05_ski_jump", c5), ("08_portrait", c8)):
            cst = cdp.image_rgb_stats(cimg)
            _assert(cst["is_non_blank"] and cst["rgb_std"] >= 8.0, f"Center 3D viewport flat/blank in {cname}: {cst}")
          d23 = cdp.image_frame_delta(c2, c3)
          d34 = cdp.image_frame_delta(c3, c4)
          d45 = cdp.image_frame_delta(c4, c5)
        _assert(d23["mad"] >= 4.0 and d34["mad"] >= 4.0 and d45["mad"] >= 4.0, f"Center 3D scenes not visually distinct: d23={d23}, d34={d34}, d45={d45}")

        hsess.assert_zero_errors("T4_S09")
        screenshot_artifacts["pack_count"] = 8
        screenshot_artifacts["hero"] = str(hero_screenshot or hero_pack_path)
        screenshot_artifacts["cross_scene_mad"] = {
            "press_vs_shredder": d23["mad"],
            "shredder_vs_train": d34["mad"],
            "train_vs_skijump": d45["mad"],
        }
        return f"8/8 JPEGs verified, hero=1280x800 RGB ({m2['bytes']}B), mad={d23['mad']}/{d34['mad']}/{d45['mad']}"
      finally:
        if tmp_dir_obj is not None:
          tmp_dir_obj.cleanup()

    rec.run_case("T4_S09", 4, "Scenario", "S9: 1280x800 Hero & 8-Image Fable Play-First Audit Pack", _s9)

  return screenshot_artifacts


# ---------------------------------------------------------------------------
# CLI Entry Point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
  ap = argparse.ArgumentParser(
      description="Opaque-Box iPad Touch E2E Suite (Tiers 1-4 + Tier 5 Regressions: 224 Cases)"
  )
  ap.add_argument("--tier", choices=("1", "2", "3", "4", "all"), default="all", help="Which tier(s) to execute")
  ap.add_argument("--root", default=str(cdp.DEFAULT_PROJECT_ROOT), help="Project root directory")
  ap.add_argument("--live-url", default=None, help="Optional live deployed URL (e.g. GitHub Pages)")
  ap.add_argument("--screenshots-dir", default=None, help="Optional directory to save Tier 4 S9 8-image pack")
  ap.add_argument("--hero-screenshot", default=None, help="Optional path to save 1280x800 RGB JPEG hero screenshot")
  ap.add_argument("--json-out", default=None, help="Optional path to write machine-readable JSON report")
  ap.add_argument("--timeout-scale", type=float, default=1.0, help="Multiplier for wait/hold timings")
  ap.add_argument("--url-query", default="", help="Optional query string appended to target URL")
  args = ap.parse_args(argv)

  root_path = Path(args.root).resolve()
  shots_dir = Path(args.screenshots_dir).resolve() if args.screenshots_dir else None
  hero_path = Path(args.hero_screenshot).resolve() if args.hero_screenshot else None

  rec = SuiteRecorder(timeout_scale=args.timeout_scale)
  t0 = time.monotonic()
  artifacts: dict[str, Any] = {}

  browser_root = None if args.live_url else root_path
  fatal_error: str | None = None
  try:
    with cdp.CdpBrowser(root=browser_root) as browser:
      if args.tier in ("1", "all"):
        run_tier_1(browser, rec, root=root_path, live_url=args.live_url, url_query=args.url_query)
      if args.tier in ("2", "all"):
        run_tier_2(browser, rec, root=root_path, live_url=args.live_url, url_query=args.url_query)
      if args.tier in ("3", "all"):
        run_tier_3(browser, rec, live_url=args.live_url, url_query=args.url_query)
      if args.tier in ("4", "all"):
        artifacts = run_tier_4(
            browser,
            rec,
            live_url=args.live_url,
            url_query=args.url_query,
            screenshots_dir=shots_dir,
            hero_screenshot=hero_path,
        )
  except Exception as exc:
    fatal_error = f"{type(exc).__name__}: {exc}"
    rec.run_case(
        "SUITE_FATAL",
        0,
        "Infra",
        "Unhandled runner exception",
        lambda: (_assert(False, fatal_error or "fatal runner error"), "")[-1],
    )
  finally:
    elapsed = time.monotonic() - t0
    total = len(rec.results)
    passed = sum(1 for r in rec.results if r.passed)
    failed = total - passed

    by_tier: dict[str, dict[str, int]] = {}
    for r in rec.results:
      tk = f"tier_{r.tier}"
      bucket = by_tier.setdefault(tk, {"total": 0, "passed": 0, "failed": 0})
      bucket["total"] += 1
      if r.passed:
        bucket["passed"] += 1
      else:
        bucket["failed"] += 1

    report = {
        "suite": "run_e2e",
        "tier": args.tier,
        "root": str(root_path),
        "liveUrl": args.live_url,
        "passed": failed == 0 and total > 0 and fatal_error is None,
        "fatalError": fatal_error,
        "elapsed_s": round(elapsed, 2),
        "summary": {
            "total": total,
            "passed": passed,
            "failed": failed,
            "by_tier": by_tier,
        },
        "artifacts": artifacts,
        "cases": [dataclasses.asdict(r) for r in rec.results],
    }

    print("\n=== E2E SUITE SUMMARY ===")
    for tk in sorted(by_tier.keys()):
      b = by_tier[tk]
      print(f"  {tk}: {b['passed']}/{b['total']} PASS (failed={b['failed']})")
    print(f"TOTAL: {passed}/{total} PASS | failed={failed} | elapsed={elapsed:.2f}s")

    if args.json_out:
      out_p = Path(args.json_out)
      out_p.parent.mkdir(parents=True, exist_ok=True)
      out_p.write_text(json.dumps(report, indent=2), encoding="utf-8")

  return 0 if report["passed"] else 1


if __name__ == "__main__":
  raise SystemExit(main())
