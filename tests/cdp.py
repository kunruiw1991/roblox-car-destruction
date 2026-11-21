#!/usr/bin/env python3
"""Zero-dependency Python 3 Chrome DevTools Protocol (CDP) test harness.

Provides:
- LocalStaticServer: thread-safe in-process ThreadingHTTPServer on 127.0.0.1:0
  with explicit JS/MJS MIME mapping, Cache-Control: no-store, and request log.
- _WebsocketsSyncTransport + _StdlibRFC6455Transport: fast loopback CDP
  WebSocket transport (zero hard third-party dependencies).
- CdpBrowser: isolated short /tmp Chrome profile with SwiftShader WebGL2 flags,
  proxy-bypassing loopback HTTP polling, fast tab creation, and process-group
  cleanup.
- CdpSession: pre-boot Guardrail 1 WebGL2/RAF spy, Web Audio unlock spy, early
  error hooks, Network/Console/Exception/Log telemetry, Chrome 158 stateful
  multi-touch emulation, keyboard dispatch, and pure-Pillow screenshot/delta
  utilities.
"""

from __future__ import annotations

import atexit
import base64
from contextlib import contextmanager
import dataclasses
import functools
import hashlib
import http.server
import io
import json
import math
import os
from pathlib import Path
import secrets
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterator
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True

from PIL import Image, ImageChops, ImageStat

try:
  import websockets.sync.client as _ws_sync_client
except Exception:  # pragma: no cover - fallback tested separately
  _ws_sync_client = None


DEFAULT_PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
CHROME_BIN: str = os.environ.get("CHROME_BIN", "/usr/bin/google-chrome")

# Canonical 5 iPad viewports: (tag, width, height, dpr, mobile)
IPAD_VIEWPORTS: list[tuple[str, int, int, float, bool]] = [
    ("ipad_air_landscape", 1180, 820, 2.0, True),
    ("ipad_classic_landscape", 1024, 768, 2.0, True),
    ("screenshot_landscape", 1280, 800, 1.0, True),
    ("ipad_air_portrait", 820, 1180, 2.0, True),
    ("ipad_classic_portrait", 768, 1024, 2.0, True),
]

MIME_OVERRIDES: dict[str, str] = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
}

EARLY_ERROR_HOOK_JS: str = r"""
(() => {
  if (window.__E2E_ERROR_TRACKER__) return;
  const tracker = {
    jsErrors: [],
    unhandledRejections: [],
    resourceErrors: [],
  };
  window.__E2E_ERROR_TRACKER__ = tracker;

  window.addEventListener('error', (ev) => {
    const target = ev && ev.target;
    if (target && target !== window && target.tagName) {
      tracker.resourceErrors.push({
        tag: String(target.tagName),
        src: String(target.src || target.href || ''),
      });
      return;
    }
    tracker.jsErrors.push({
      message: String((ev && ev.message) || 'Unknown error'),
      filename: String((ev && ev.filename) || ''),
      lineno: Number((ev && ev.lineno) || 0),
      colno: Number((ev && ev.colno) || 0),
    });
  }, true);

  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev ? ev.reason : null;
    tracker.unhandledRejections.push({
      reason: r && r.stack ? String(r.stack) : String(r),
    });
  });
})();
"""

PREBOOT_GUARDRAIL1_SPY_JS: str = r"""
(() => {
  if (window.__PREBOOT_SPY__) return;
  const spy = {
    firstRafScheduled: false,
    firstRafStarted: false,
    firstRafDone: false,
    rafCount: 0,
    firstRafStartMs: null,
    firstLinkMs: null,
    preRafCompileShaders: 0,
    preRafLinkPrograms: 0,
    preRafDraws: 0,
    totalCompileShaders: 0,
    totalLinkPrograms: 0,
    inFirstRafLinkPrograms: 0,
    postFirstRafLinkPrograms: 0,
    compileMethodHits: [],
    preRafLinkStacks: [],
    webglContexts: [],
  };
  window.__PREBOOT_SPY__ = spy;
  window.__PREBOOT_FIRST_RAF_DONE__ = false;
  window.__PREBOOT_FIRST_RAF_STARTED__ = false;

  const origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function rcdTrackedRaf(cb) {
    spy.firstRafScheduled = true;
    return origRAF(function rcdRafWrapper(ts) {
      const isFirst = !spy.firstRafStarted;
      if (isFirst) {
        spy.firstRafStarted = true;
        spy.firstRafStartMs = performance.now();
        window.__PREBOOT_FIRST_RAF_STARTED__ = true;
      }
      spy.rafCount += 1;
      try {
        return cb(ts);
      } finally {
        if (isFirst) {
          spy.firstRafDone = true;
          window.__PREBOOT_FIRST_RAF_DONE__ = true;
        }
      }
    });
  };

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  if (typeof origGetContext === 'function') {
    HTMLCanvasElement.prototype.getContext = function rcdTrackedGetContext(type) {
      const ctx = origGetContext.apply(this, arguments);
      if (ctx && (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl')) {
        spy.webglContexts.push({
          type: String(type),
          preRaf: !spy.firstRafStarted,
          canvasId: String(this.id || ''),
        });
      }
      return ctx;
    };
  }

  function captureDeepStack() {
    const prev = Error.stackTraceLimit;
    try {
      Error.stackTraceLimit = 40;
      return String(new Error().stack || '');
    } finally {
      Error.stackTraceLimit = prev;
    }
  }

  function wrapGLProto(proto) {
    if (!proto || proto.__rcdPrebootWrapped) return;
    proto.__rcdPrebootWrapped = true;

    const origCompileShader = proto.compileShader;
    if (typeof origCompileShader === 'function') {
      proto.compileShader = function rcdTrackedCompileShader() {
        spy.totalCompileShaders += 1;
        if (!spy.firstRafStarted) {
          spy.preRafCompileShaders += 1;
        }
        return origCompileShader.apply(this, arguments);
      };
    }

    const origLinkProgram = proto.linkProgram;
    if (typeof origLinkProgram === 'function') {
      proto.linkProgram = function rcdTrackedLinkProgram() {
        spy.totalLinkPrograms += 1;
        if (spy.firstLinkMs === null) spy.firstLinkMs = performance.now();
        const phase = !spy.firstRafStarted
          ? 'pre_raf'
          : (!spy.firstRafDone ? 'in_first_raf' : 'post_raf');
        const stack = captureDeepStack();
        if (/\.compile(?:Async)?\s*\(/.test(stack)) {
          if (spy.compileMethodHits.length < 10) {
            spy.compileMethodHits.push({
              phase,
              stack: stack.split('\n').slice(1, 20).join(' | '),
            });
          }
        }
        if (phase === 'pre_raf') {
          spy.preRafLinkPrograms += 1;
          if (spy.preRafLinkStacks.length < 5) {
            spy.preRafLinkStacks.push(stack.split('\n').slice(1, 14).join(' | '));
          }
        } else if (phase === 'in_first_raf') {
          spy.inFirstRafLinkPrograms += 1;
        } else {
          spy.postFirstRafLinkPrograms += 1;
        }
        return origLinkProgram.apply(this, arguments);
      };
    }

    for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const orig = proto[fn];
      if (typeof orig === 'function') {
        proto[fn] = function rcdTrackedDraw() {
          if (!spy.firstRafStarted) spy.preRafDraws += 1;
          return orig.apply(this, arguments);
        };
      }
    }
  }

  if (typeof WebGL2RenderingContext !== 'undefined') wrapGLProto(WebGL2RenderingContext.prototype);
  if (typeof WebGLRenderingContext !== 'undefined') wrapGLProto(WebGLRenderingContext.prototype);
})();
"""

PREBOOT_AUDIO_SPY_JS: str = r"""
(() => {
  if (window.__PREBOOT_AUDIO_SPY__) return;
  const audioSpy = {
    hasGesture: false,
    createdCount: 0,
    createdBeforeGesture: 0,
    resumeCalls: 0,
    lastState: null,
    states: [],
  };
  window.__PREBOOT_AUDIO_SPY__ = audioSpy;

  const recordState = (st) => {
    if (!st) return;
    audioSpy.lastState = st;
    if (audioSpy.states.length === 0 || audioSpy.states[audioSpy.states.length - 1] !== st) {
      audioSpy.states.push(st);
    }
  };

  const markGesture = () => { audioSpy.hasGesture = true; };
  for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'keydown']) {
    window.addEventListener(ev, markGesture, { capture: true, passive: true });
  }

  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Orig = window[name];
    if (typeof Orig !== 'function' || Orig.__rcdAudioWrapped) continue;
    const Wrapped = function rcdAudioContext(...args) {
      const inst = new Orig(...args);
      audioSpy.createdCount += 1;
      if (!audioSpy.hasGesture) audioSpy.createdBeforeGesture += 1;
      try { recordState(inst.state || null); } catch (_) {}
      if (typeof inst.addEventListener === 'function') {
        try {
          inst.addEventListener('statechange', () => {
            try { recordState(inst.state || null); } catch (_) {}
          });
        } catch (_) {}
      }
      if (typeof inst.resume === 'function') {
        const origResume = inst.resume.bind(inst);
        inst.resume = function rcdAudioResume() {
          audioSpy.resumeCalls += 1;
          const p = origResume();
          if (p && typeof p.then === 'function') {
            return p.then((val) => {
              try { recordState(inst.state || null); } catch (_) {}
              return val;
            });
          }
          try { recordState(inst.state || null); } catch (_) {}
          return p;
        };
      }
      return inst;
    };
    Wrapped.prototype = Orig.prototype;
    Wrapped.__rcdAudioWrapped = true;
    try { window[name] = Wrapped; } catch (_) {}
  }
})();
"""


# ---------------------------------------------------------------------------
# Pure-Pillow image statistics & frame delta (zero numpy dependency)
# ---------------------------------------------------------------------------

def _as_rgb_image(src: Image.Image | bytes | bytearray | str | Path) -> Image.Image:
  if isinstance(src, Image.Image):
    return src.convert("RGB") if src.mode != "RGB" else src
  if isinstance(src, (bytes, bytearray)):
    return Image.open(io.BytesIO(src)).convert("RGB")
  return Image.open(src).convert("RGB")


def image_rgb_stats(
    src: Image.Image | bytes | bytearray | str | Path,
) -> dict[str, Any]:
  """Computes exact RGB luminance, channel/global stddev, and color diversity."""
  img = _as_rgb_image(src)
  st = ImageStat.Stat(img)
  mean_rgb = [float(x) for x in st.mean[:3]]
  std_rgb = [float(x) for x in st.stddev[:3]]

  # True spatial per-channel mean stddev (guarantees 0.0 on any constant solid color).
  rgb_std = sum(std_rgb) / 3.0
  mean_luma = 0.299 * mean_rgb[0] + 0.587 * mean_rgb[1] + 0.114 * mean_rgb[2]
  max_std = max(std_rgb)

  # Fast downsampled scan for 12-bit color bins, saturation, and daylight cues.
  tw = min(160, max(1, img.width))
  th = min(100, max(1, img.height))
  thumb = img.resize((tw, th), Image.Resampling.NEAREST)
  pixels = list(thumb.getdata())
  total_px = max(1, len(pixels))

  bins: set[int] = set()
  sat_sum = 0
  dark_count = 0
  sky_count = 0
  turf_count = 0
  for r, g, b in pixels:
    bins.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4))
    cmax = r if (r >= g and r >= b) else (g if g >= b else b)
    cmin = r if (r <= g and r <= b) else (g if g <= b else b)
    sat_sum += cmax - cmin
    if (299 * r + 587 * g + 114 * b) < 15000:  # luma < 15
      dark_count += 1
    if b > r + 15 and b > 110:
      sky_count += 1
    if g > r + 10 and g > b + 5 and g > 70:
      turf_count += 1

  mean_saturation = sat_sum / total_px
  dark_pixel_frac = dark_count / total_px
  sky_blue_frac = sky_count / total_px
  turf_green_frac = turf_count / total_px

  is_non_blank = (max_std >= 6.0) and (5.0 <= mean_luma <= 250.0)
  return {
      "width": img.width,
      "height": img.height,
      "mode": img.mode,
      "mean_rgb": [round(x, 2) for x in mean_rgb],
      "std_rgb": [round(x, 2) for x in std_rgb],
      "rgb_std": round(rgb_std, 2),
      "mean_luma": round(mean_luma, 2),
      "max_std": round(max_std, 2),
      "unique_bins": len(bins),
      "mean_saturation": round(mean_saturation, 2),
      "dark_pixel_frac": round(dark_pixel_frac, 4),
      "sky_blue_frac": round(sky_blue_frac, 4),
      "turf_green_frac": round(turf_green_frac, 4),
      "is_non_blank": is_non_blank,
  }


def image_frame_delta(
    img1: Image.Image | bytes | bytearray | str | Path,
    img2: Image.Image | bytes | bytearray | str | Path,
    pixel_threshold: int = 4,
) -> dict[str, Any]:
  """Pure-Pillow L1 mean absolute diff and changed-pixel fraction."""
  im1 = _as_rgb_image(img1)
  im2 = _as_rgb_image(img2)
  if im2.size != im1.size:
    im2 = im2.resize(im1.size, Image.Resampling.BILINEAR)
  diff = ImageChops.difference(im1, im2)
  diff_stat = ImageStat.Stat(diff)
  mad = sum(diff_stat.mean[:3]) / 3.0
  max_ch = ImageChops.lighter(
      ImageChops.lighter(diff.getchannel(0), diff.getchannel(1)),
      diff.getchannel(2),
  )
  hist = max_ch.histogram()
  total_px = max(1, im1.width * im1.height)
  start_bin = min(256, max(1, int(pixel_threshold) + 1))
  changed_px = sum(hist[start_bin:])
  max_diff = next((i for i in range(255, -1, -1) if hist[i] > 0), 0)
  return {
      "mad": round(float(mad), 4),
      "l1_delta": round(float(mad), 4),
      "changed_px_frac": round(changed_px / total_px, 6),
      "max_channel_diff": int(max_diff),
  }


# Aliases for ergonomic reuse across test modules.
pixel_stats = image_rgb_stats
frame_delta = image_frame_delta


# ---------------------------------------------------------------------------
# Section 1: Zero-dependency LocalStaticServer
# ---------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class HttpRecord:
  method: str
  path: str
  status: int
  timestamp: float


class _QuietThreadingHTTPServer(http.server.ThreadingHTTPServer):
  daemon_threads = True
  allow_reuse_address = True


class LocalStaticServer:
  """In-process static HTTP server on 127.0.0.1:0 with isolated request log."""

  def __init__(
      self,
      root_dir: str | Path,
      strict_subpath: str | None = None,
  ) -> None:
    self.root_dir = Path(root_dir).resolve()
    if strict_subpath:
      clean = "/" + strict_subpath.strip("/")
      self.strict_subpath: str | None = clean
    else:
      self.strict_subpath = None
    self._lock = threading.Lock()
    self._records: list[HttpRecord] = []
    self._httpd: _QuietThreadingHTTPServer | None = None
    self._thread: threading.Thread | None = None
    self.port: int = 0

  @property
  def base_url(self) -> str:
    if self.strict_subpath:
      return f"http://127.0.0.1:{self.port}{self.strict_subpath}/"
    return f"http://127.0.0.1:{self.port}/"

  def start(self) -> LocalStaticServer:
    if self._httpd is not None:
      return self

    outer = self
    ext_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    ext_map.update(MIME_OVERRIDES)

    class _Handler(http.server.SimpleHTTPRequestHandler):
      extensions_map = ext_map

      def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._recorded_path: str | None = None
        super().__init__(*args, directory=str(outer.root_dir), **kwargs)

      def log_message(self, fmt: str, *args: Any) -> None:  # noqa: ARG002
        return

      def _rewrite_subpath(self) -> bool:
        if not outer.strict_subpath:
          return True
        parsed = urllib.parse.urlsplit(self.path)
        p = parsed.path
        if p == outer.strict_subpath:
          loc = outer.strict_subpath + "/"
          if parsed.query:
            loc += "?" + parsed.query
          self.send_response(301)
          self.send_header("Location", loc)
          self.end_headers()
          return False
        prefix = outer.strict_subpath + "/"
        if not p.startswith(prefix):
          self.send_error(404, "Outside strict_subpath")
          return False
        stripped = "/" + p[len(prefix):]
        self.path = stripped + (f"?{parsed.query}" if parsed.query else "")
        return True

      def do_GET(self) -> None:
        self._recorded_path = self.path
        if not self._rewrite_subpath():
          return
        super().do_GET()

      def do_HEAD(self) -> None:
        self._recorded_path = self.path
        if not self._rewrite_subpath():
          return
        super().do_HEAD()

      def send_response(self, code: int, message: str | None = None) -> None:
        rec_path = self._recorded_path if self._recorded_path is not None else self.path
        with outer._lock:
          outer._records.append(
              HttpRecord(
                  method=str(getattr(self, "command", "GET")),
                  path=str(rec_path),
                  status=int(code),
                  timestamp=time.time(),
              )
          )
        super().send_response(code, message)

      def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    self._httpd = _QuietThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    self.port = int(self._httpd.server_address[1])
    self._thread = threading.Thread(
        target=self._httpd.serve_forever,
        kwargs={"poll_interval": 0.1},
        name=f"rcd-http-{self.port}",
        daemon=True,
    )
    self._thread.start()
    return self

  def clear_records(self) -> None:
    with self._lock:
      self._records.clear()

  def get_records(self) -> list[HttpRecord]:
    with self._lock:
      return list(self._records)

  def get_error_records(self, allow_favicon_404: bool = False) -> list[HttpRecord]:
    out: list[HttpRecord] = []
    for rec in self.get_records():
      if rec.status >= 400:
        if allow_favicon_404 and rec.path.split("?", 1)[0].endswith("/favicon.ico") and rec.status == 404:
          continue
        out.append(rec)
    return out

  def close(self) -> None:
    httpd = self._httpd
    self._httpd = None
    if httpd is not None:
      try:
        httpd.shutdown()
      except Exception:
        pass
      try:
        httpd.server_close()
      except Exception:
        pass
    thr = self._thread
    self._thread = None
    if thr is not None:
      try:
        thr.join(timeout=2.0)
      except Exception:
        pass

  def __enter__(self) -> LocalStaticServer:
    return self.start()

  def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
    self.close()


# ---------------------------------------------------------------------------
# Section 2: CDP WebSocket Transports (_WebsocketsSyncTransport + RFC-6455)
# ---------------------------------------------------------------------------

class _WebsocketsSyncTransport:
  """Fast loopback CDP WebSocket using websockets.sync.client with safe kwargs."""

  def __init__(self, ws_url: str, open_timeout: float = 15.0) -> None:
    if _ws_sync_client is None:
      raise ImportError("websockets.sync.client unavailable")
    self._ws = _ws_sync_client.connect(
        ws_url,
        proxy=None,
        max_size=None,
        max_queue=None,
        ping_interval=None,
        compression=None,
        open_timeout=open_timeout,
        close_timeout=3.0,
    )

  def send_json(self, payload: dict[str, Any]) -> None:
    self._ws.send(json.dumps(payload, separators=(",", ":")))

  def recv_json(self, timeout: float = 10.0) -> dict[str, Any]:
    raw = self._ws.recv(timeout=timeout)
    if isinstance(raw, bytes):
      raw = raw.decode("utf-8", errors="replace")
    return json.loads(raw)

  def close(self) -> None:
    try:
      self._ws.close()
    except Exception:
      pass


class _StdlibRFC6455Transport:
  """Pure-stdlib RFC-6455 WebSocket fallback for loopback CDP."""

  _GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

  def __init__(self, ws_url: str, open_timeout: float = 15.0) -> None:
    parsed = urllib.parse.urlsplit(ws_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "wss" else 80)
    path = parsed.path or "/"
    if parsed.query:
      path += "?" + parsed.query

    sock = socket.create_connection((host, port), timeout=open_timeout)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    self._sock = sock
    self._buf = bytearray()
    self._frag_chunks: list[bytes] = []

    try:
      key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
      req = (
          f"GET {path} HTTP/1.1\r\n"
          f"Host: {host}:{port}\r\n"
          "Upgrade: websocket\r\n"
          "Connection: Upgrade\r\n"
          f"Sec-WebSocket-Key: {key}\r\n"
          "Sec-WebSocket-Version: 13\r\n\r\n"
      ).encode("ascii")
      self._sock.sendall(req)

      # Read HTTP 101 handshake response.
      deadline = time.monotonic() + open_timeout
      header_end = -1
      while header_end < 0:
        rem = deadline - time.monotonic()
        if rem <= 0:
          raise TimeoutError("WebSocket handshake timed out")
        self._sock.settimeout(rem)
        chunk = self._sock.recv(4096)
        if not chunk:
          raise ConnectionError("EOF during WebSocket handshake")
        self._buf.extend(chunk)
        header_end = self._buf.find(b"\r\n\r\n")

      head = bytes(self._buf[:header_end]).decode("latin-1")
      del self._buf[: header_end + 4]
      status_line = head.splitlines()[0] if head else ""
      if " 101 " not in status_line:
        raise ConnectionError(f"WebSocket handshake failed: {status_line}")

      expected_accept = base64.b64encode(
          hashlib.sha1((key + self._GUID).encode("ascii")).digest()
      ).decode("ascii")
      if expected_accept not in head:
        raise ConnectionError("WebSocket Sec-WebSocket-Accept mismatch")
      self._sock.settimeout(None)
    except Exception:
      try:
        self._sock.close()
      except Exception:
        pass
      raise

  def _send_frame(self, opcode: int, payload: bytes) -> None:
    mask = secrets.token_bytes(4)
    length = len(payload)
    header = bytearray([0x80 | (opcode & 0x0F)])
    if length < 126:
      header.append(0x80 | length)
    elif length < 65536:
      header.append(0x80 | 126)
      header.extend(struct.pack("!H", length))
    else:
      header.append(0x80 | 127)
      header.extend(struct.pack("!Q", length))
    header.extend(mask)
    masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    self._sock.settimeout(15.0)
    self._sock.sendall(bytes(header) + masked)

  def _fill_buf(self, needed: int, deadline: float) -> None:
    while len(self._buf) < needed:
      rem = deadline - time.monotonic()
      if rem <= 0:
        raise TimeoutError("WebSocket recv timed out")
      rlist, _, _ = select.select([self._sock], [], [], min(rem, 0.25))
      if not rlist:
        continue
      self._sock.settimeout(max(0.001, rem))
      try:
        chunk = self._sock.recv(max(4096, needed - len(self._buf)))
      except socket.timeout as exc:
        raise TimeoutError("WebSocket recv timed out") from exc
      if not chunk:
        raise ConnectionError("WebSocket closed by peer")
      self._buf.extend(chunk)

  def _read_one_frame(self, deadline: float) -> tuple[bool, int, bytes]:
    """Peek-parses a full RFC-6455 frame; consumes self._buf only once complete."""
    self._fill_buf(2, deadline)
    b1 = self._buf[0]
    b2 = self._buf[1]
    fin = bool(b1 & 0x80)
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F
    pos = 2
    if length == 126:
      self._fill_buf(pos + 2, deadline)
      (length,) = struct.unpack("!H", self._buf[pos : pos + 2])
      pos += 2
    elif length == 127:
      self._fill_buf(pos + 8, deadline)
      (length,) = struct.unpack("!Q", self._buf[pos : pos + 8])
      pos += 8
    mask_len = 4 if masked else 0
    frame_end = pos + mask_len + length
    self._fill_buf(frame_end, deadline)
    if masked:
      mask_key = bytes(self._buf[pos : pos + 4])
      raw_payload = self._buf[pos + 4 : frame_end]
      data = bytes(b ^ mask_key[i & 3] for i, b in enumerate(raw_payload))
    else:
      data = bytes(self._buf[pos:frame_end])
    del self._buf[:frame_end]
    return fin, opcode, data

  def send_json(self, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    self._send_frame(0x1, data)

  def recv_json(self, timeout: float = 10.0) -> dict[str, Any]:
    deadline = time.monotonic() + max(0.001, float(timeout))
    while True:
      fin, opcode, data = self._read_one_frame(deadline)
      if opcode == 0x9:  # Ping -> Pong
        self._send_frame(0xA, data)
        continue
      if opcode == 0xA:  # Pong
        continue
      if opcode == 0x8:  # Close
        try:
          self._send_frame(0x8, b"")
        except Exception:
          pass
        raise ConnectionError("WebSocket close frame received")
      if opcode in (0x1, 0x2):
        self._frag_chunks = [data]
        if fin:
          payload = b"".join(self._frag_chunks)
          self._frag_chunks = []
          return json.loads(payload.decode("utf-8", errors="replace"))
      elif opcode == 0x0:
        self._frag_chunks.append(data)
        if fin:
          payload = b"".join(self._frag_chunks)
          self._frag_chunks = []
          return json.loads(payload.decode("utf-8", errors="replace"))

  def close(self) -> None:
    try:
      self._send_frame(0x8, b"")
    except Exception:
      pass
    try:
      self._sock.close()
    except Exception:
      pass


def _connect_ws(ws_url: str, open_timeout: float = 15.0) -> Any:
  if _ws_sync_client is not None:
    return _WebsocketsSyncTransport(ws_url, open_timeout=open_timeout)
  return _StdlibRFC6455Transport(ws_url, open_timeout=open_timeout)


# ---------------------------------------------------------------------------
# Section 3: Chrome Launch, Process Lifecycle & Tab Management
# ---------------------------------------------------------------------------

def _pick_free_port() -> int:
  with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    s.bind(("127.0.0.1", 0))
    return int(s.getsockname()[1])


def _make_loopback_opener() -> urllib.request.OpenerDirector:
  return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _chmod_writable_tree(root: Path) -> None:
  try:
    os.chmod(root, 0o770)
  except OSError:
    pass
  for dirpath, dirnames, filenames in os.walk(root):
    for d in dirnames:
      try:
        os.chmod(os.path.join(dirpath, d), 0o770)
      except OSError:
        pass
    for f in filenames:
      try:
        os.chmod(os.path.join(dirpath, f), 0o660)
      except OSError:
        pass


def build_chrome_cmd(
    *,
    chrome_bin: str,
    profile_dir: Path,
    debug_port: int,
    window_width: int = 1280,
    window_height: int = 800,
    no_proxy: bool = True,
    autoplay_policy: str | None = "no-user-gesture-required",
) -> list[str]:
  cmd = [
      chrome_bin,
      "--headless=new",
      "--ozone-platform=headless",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars=false",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--remote-allow-origins=*",
      f"--user-data-dir={profile_dir}",
      f"--remote-debugging-port={debug_port}",
      f"--window-size={int(window_width)},{int(window_height)}",
  ]
  if autoplay_policy:
    cmd.append(f"--autoplay-policy={autoplay_policy}")
  if no_proxy:
    cmd.append("--no-proxy-server")
  cmd.append("about:blank")
  return cmd


class CdpBrowser:
  """Manages a single headless Chrome instance + optional LocalStaticServer."""

  def __init__(
      self,
      root: str | Path | None = DEFAULT_PROJECT_ROOT,
      *,
      strict_subpath: str | None = None,
      chrome_bin: str = CHROME_BIN,
      no_proxy: bool | None = None,
      startup_timeout: float = 15.0,
      window_width: int = 1280,
      window_height: int = 800,
      autoplay_policy: str | None = "no-user-gesture-required",
  ) -> None:
    self.root = Path(root).resolve() if root is not None else None
    self.strict_subpath = strict_subpath
    self.chrome_bin = chrome_bin
    # Default: disable proxy for local loopback tests; allow env proxy for live URLs.
    self.no_proxy = (root is not None) if no_proxy is None else bool(no_proxy)
    self.startup_timeout = float(startup_timeout)
    self.window_width = int(window_width)
    self.window_height = int(window_height)
    self.autoplay_policy = autoplay_policy

    self._server: LocalStaticServer | None = None
    self._tmp_dir: Path | None = None
    self._proc: subprocess.Popen[Any] | None = None
    self._debug_port: int = 0
    self._opener = _make_loopback_opener()
    self._browser_ws: Any | None = None
    self._browser_cmd_id: int = 0
    self._initial_target_id: str | None = None
    self._initial_ws_url: str | None = None
    self._initial_tab_claimed: bool = False
    self._sessions: list[CdpSession] = []
    self._closed: bool = False
    self.browser_version: str = ""

  @property
  def base_url(self) -> str | None:
    return self._server.base_url if self._server is not None else None

  @property
  def server(self) -> LocalStaticServer | None:
    return self._server

  def _http_get_json(self, path: str, timeout: float = 3.0) -> Any:
    url = f"http://127.0.0.1:{self._debug_port}{path}"
    with self._opener.open(url, timeout=timeout) as resp:
      return json.loads(resp.read().decode("utf-8"))

  def _browser_cdp(self, method: str, params: dict[str, Any] | None = None, timeout: float = 10.0) -> dict[str, Any]:
    if self._browser_ws is None:
      raise RuntimeError("Browser WebSocket is not connected")
    self._browser_cmd_id += 1
    cid = self._browser_cmd_id
    msg: dict[str, Any] = {"id": cid, "method": method}
    if params:
      msg["params"] = params
    self._browser_ws.send_json(msg)
    deadline = time.monotonic() + timeout
    while True:
      rem = deadline - time.monotonic()
      if rem <= 0:
        raise TimeoutError(f"Browser CDP command timed out: {method}")
      data = self._browser_ws.recv_json(timeout=rem)
      if data.get("id") == cid:
        if "error" in data:
          raise RuntimeError(f"Browser CDP error in {method}: {data['error']}")
        return data.get("result") or {}

  def start(self) -> CdpBrowser:
    if self._proc is not None:
      return self

    if not Path(self.chrome_bin).exists():
      raise FileNotFoundError(f"Chrome binary not found at {self.chrome_bin}")

    try:
      if self.root is not None:
        self._server = LocalStaticServer(self.root, strict_subpath=self.strict_subpath)
        self._server.start()

      self._tmp_dir = Path(
          tempfile.mkdtemp(prefix=f"rcd_cdp_{os.getpid()}_", dir="/tmp")
      )
      os.chmod(self._tmp_dir, 0o700)
      profile_dir = self._tmp_dir / "prof"
      home_dir = self._tmp_dir / "home"
      sock_tmp = self._tmp_dir / "tmp"
      (home_dir / ".config").mkdir(parents=True, exist_ok=True)
      (home_dir / ".cache").mkdir(parents=True, exist_ok=True)
      profile_dir.mkdir(parents=True, exist_ok=True)
      sock_tmp.mkdir(parents=True, exist_ok=True)

      self._debug_port = _pick_free_port()
      cmd = build_chrome_cmd(
          chrome_bin=self.chrome_bin,
          profile_dir=profile_dir,
          debug_port=self._debug_port,
          window_width=self.window_width,
          window_height=self.window_height,
          no_proxy=self.no_proxy,
          autoplay_policy=self.autoplay_policy,
      )

      env: dict[str, str] = {
          "PATH": "/usr/local/bin:/usr/bin:/bin",
          "HOME": str(home_dir),
          "TMPDIR": str(sock_tmp),
          "XDG_CONFIG_HOME": str(home_dir / ".config"),
          "XDG_CACHE_HOME": str(home_dir / ".cache"),
          "LANG": "en_US.UTF-8",
      }
      if not self.no_proxy:
        for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY"):
          if k in os.environ:
            env[k] = os.environ[k]

      out_path = self._tmp_dir / "chrome.out"
      err_path = self._tmp_dir / "chrome.err"
      with open(out_path, "wb") as fout, open(err_path, "wb") as ferr:
        self._proc = subprocess.Popen(
            cmd,
            cwd="/tmp",
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=fout,
            stderr=ferr,
            start_new_session=True,
        )

      atexit.register(self.close)

      deadline = time.monotonic() + self.startup_timeout
      last_err: Exception | None = None
      while time.monotonic() < deadline:
        if self._proc.poll() is not None:
          rc = self._proc.returncode
          tail = ""
          try:
            tail = err_path.read_text(encoding="utf-8", errors="replace")[-800:]
          except OSError:
            pass
          self.close()
          raise RuntimeError(
              f"Chrome exited early with code {rc}: {tail}"
          )
        try:
          ver = self._http_get_json("/json/version", timeout=1.0)
          targets = self._http_get_json("/json/list", timeout=1.0)
          page_targets = [
              t for t in targets
              if t.get("type") == "page" and t.get("webSocketDebuggerUrl")
          ]
          browser_ws_url = ver.get("webSocketDebuggerUrl")
          if browser_ws_url and page_targets:
            self.browser_version = str(ver.get("Browser", ""))
            self._browser_ws = _connect_ws(browser_ws_url, open_timeout=10.0)
            self._initial_target_id = str(page_targets[0]["id"])
            self._initial_ws_url = str(page_targets[0]["webSocketDebuggerUrl"])
            return self
        except Exception as exc:
          last_err = exc
        time.sleep(0.05)

      tail = ""
      try:
        tail = err_path.read_text(encoding="utf-8", errors="replace")[-800:]
      except OSError:
        pass
      self.close()
      raise RuntimeError(
          f"Timed out waiting for Chrome CDP on port {self._debug_port} "
          f"(last_err={last_err}): {tail}"
      )
    except Exception:
      self.close()
      raise

  def new_session(
      self,
      *,
      width: int = 1180,
      height: int = 820,
      dpr: float = 2.0,
      mobile: bool = True,
      max_touch_points: int = 5,
      install_preboot_spy: bool = True,
      install_audio_spy: bool = True,
      reuse_initial_tab: bool = False,
  ) -> CdpSession:
    if self._proc is None:
      self.start()

    owns_target = True
    if reuse_initial_tab and not self._initial_tab_claimed and self._initial_ws_url:
      self._initial_tab_claimed = True
      target_id = self._initial_target_id or ""
      ws_url = self._initial_ws_url
      owns_target = False
    else:
      res = self._browser_cdp("Target.createTarget", {"url": "about:blank"})
      target_id = str(res["targetId"])
      ws_url = f"ws://127.0.0.1:{self._debug_port}/devtools/page/{target_id}"

    session = CdpSession(
        browser=self,
        target_id=target_id,
        ws_url=ws_url,
        owns_target=owns_target,
        width=width,
        height=height,
        dpr=dpr,
        mobile=mobile,
        max_touch_points=max_touch_points,
        install_preboot_spy=install_preboot_spy,
        install_audio_spy=install_audio_spy,
    )
    self._sessions.append(session)
    return session

  def _close_target(self, target_id: str) -> None:
    if self._closed or not target_id or self._browser_ws is None:
      return
    try:
      self._browser_cdp("Target.closeTarget", {"targetId": target_id}, timeout=3.0)
    except Exception:
      pass

  def close(self) -> None:
    if self._closed:
      return
    self._closed = True
    try:
      atexit.unregister(self.close)
    except Exception:
      pass

    for sess in list(self._sessions):
      try:
        sess._close_transport_only()
      except Exception:
        pass
    self._sessions.clear()

    if self._browser_ws is not None:
      try:
        self._browser_ws.close()
      except Exception:
        pass
      self._browser_ws = None

    proc = self._proc
    self._proc = None
    if proc is not None:
      try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
      except ProcessLookupError:
        pass
      except Exception:
        try:
          proc.terminate()
        except Exception:
          pass
      try:
        proc.wait(timeout=3.0)
      except subprocess.TimeoutExpired:
        try:
          os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
          try:
            proc.kill()
          except Exception:
            pass
        try:
          proc.wait(timeout=2.0)
        except Exception:
          pass

    if self._server is not None:
      try:
        self._server.close()
      except Exception:
        pass
      self._server = None

    tmp = self._tmp_dir
    self._tmp_dir = None
    if tmp is not None and tmp.exists():
      _chmod_writable_tree(tmp)
      shutil.rmtree(tmp, ignore_errors=True)

  def __enter__(self) -> CdpBrowser:
    return self.start()

  def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
    self.close()


# ---------------------------------------------------------------------------
# Section 4: CdpSession — Telemetry, Pre-Boot Spies, Native iPad Touch & Shots
# ---------------------------------------------------------------------------

_KEY_TABLE: dict[str, tuple[str, str, int, str]] = {
    "Enter": ("Enter", "Enter", 13, "\r"),
    "Space": (" ", "Space", 32, " "),
    " ": (" ", "Space", 32, " "),
    "Escape": ("Escape", "Escape", 27, ""),
    "Tab": ("Tab", "Tab", 9, ""),
    "ArrowUp": ("ArrowUp", "ArrowUp", 38, ""),
    "ArrowDown": ("ArrowDown", "ArrowDown", 40, ""),
    "ArrowLeft": ("ArrowLeft", "ArrowLeft", 37, ""),
    "ArrowRight": ("ArrowRight", "ArrowRight", 39, ""),
}


def _make_touch_point(
    x: float,
    y: float,
    touch_id: int = 1,
    radius_x: float = 6.0,
    radius_y: float = 6.0,
    force: float = 1.0,
) -> dict[str, Any]:
  return {
      "x": round(float(x), 1),
      "y": round(float(y), 1),
      "radiusX": float(radius_x),
      "radiusY": float(radius_y),
      "force": float(force),
      "id": int(touch_id),
  }


def _format_console_args(args: list[dict[str, Any]]) -> str:
  parts: list[str] = []
  for a in args:
    if "value" in a:
      parts.append(str(a["value"]))
    elif "description" in a:
      parts.append(str(a["description"]))
    else:
      parts.append(str(a.get("type", "")))
  return " ".join(parts)


class CdpSession:
  """Tab-level CDP controller with telemetry, spies, touch emulation & screenshots."""

  def __init__(
      self,
      *,
      browser: CdpBrowser,
      target_id: str,
      ws_url: str,
      owns_target: bool = True,
      width: int = 1180,
      height: int = 820,
      dpr: float = 2.0,
      mobile: bool = True,
      max_touch_points: int = 5,
      install_preboot_spy: bool = True,
      install_audio_spy: bool = True,
  ) -> None:
    self.browser = browser
    self.target_id = target_id
    self.ws_url = ws_url
    self._owns_target = owns_target
    self._ws: Any | None = None
    self._cmd_id: int = 0
    self._closed: bool = False

    self.width: int = int(width)
    self.height: int = int(height)
    self.dpr: float = float(dpr)
    self.mobile: bool = bool(mobile)
    self.max_touch_points: int = int(max_touch_points)

    # Active touch points tracked by touch_id for Chrome 158 semantics.
    self._active_touches: dict[int, dict[str, Any]] = {}

    # Telemetry buffers.
    self._request_urls: dict[str, str] = {}
    self.requested_urls: list[str] = []
    self.network_responses: list[dict[str, Any]] = []
    self.network_failures: list[dict[str, Any]] = []
    self.console_entries: list[dict[str, Any]] = []
    self.exceptions: list[dict[str, Any]] = []
    self.log_entries: list[dict[str, Any]] = []
    self._page_loaded: bool = False

    try:
      self._ws = _connect_ws(ws_url, open_timeout=15.0)

      # Enable required CDP domains.
      self.cdp("Page.enable")
      self.cdp("Runtime.enable")
      self.cdp("Network.enable")
      self.cdp("Log.enable")
      try:
        self.cdp("Network.setCacheDisabled", {"cacheDisabled": True})
      except Exception:
        pass

      # Install pre-boot init scripts BEFORE any navigation.
      self.add_init_script(EARLY_ERROR_HOOK_JS)
      if install_preboot_spy:
        self.add_init_script(PREBOOT_GUARDRAIL1_SPY_JS)
      if install_audio_spy:
        self.add_init_script(PREBOOT_AUDIO_SPY_JS)

      # Apply initial iPad viewport & touch emulation before navigating.
      self.set_viewport(
          self.width,
          self.height,
          dpr=self.dpr,
          mobile=self.mobile,
          max_touch_points=self.max_touch_points,
          wait_frames=0,
      )
    except Exception:
      self.close()
      raise

  def _handle_event(self, method: str, params: dict[str, Any]) -> None:
    if method == "Network.requestWillBeSent":
      rid = str(params.get("requestId", ""))
      req = params.get("request") or {}
      url = str(req.get("url", ""))
      if rid and url:
        self._request_urls[rid] = url
      if url:
        self.requested_urls.append(url)
    elif method == "Network.responseReceived":
      rid = str(params.get("requestId", ""))
      resp = params.get("response") or {}
      url = str(resp.get("url") or self._request_urls.get(rid, ""))
      self.network_responses.append({
          "requestId": rid,
          "url": url,
          "status": int(resp.get("status", 0)),
          "statusText": str(resp.get("statusText", "")),
          "mimeType": str(resp.get("mimeType", "")),
          "type": str(params.get("type", "")),
      })
    elif method == "Network.loadingFailed":
      rid = str(params.get("requestId", ""))
      self.network_failures.append({
          "requestId": rid,
          "url": self._request_urls.get(rid, ""),
          "type": str(params.get("type", "")),
          "errorText": str(params.get("errorText", "")),
          "canceled": bool(params.get("canceled", False)),
      })
    elif method == "Runtime.consoleAPICalled":
      ctype = str(params.get("type", "log"))
      text = _format_console_args(params.get("args") or [])
      self.console_entries.append({
          "type": ctype,
          "text": text,
          "timestamp": params.get("timestamp"),
      })
    elif method == "Runtime.exceptionThrown":
      det = params.get("exceptionDetails") or {}
      exc_obj = det.get("exception") or {}
      self.exceptions.append({
          "text": str(det.get("text", "")),
          "description": str(exc_obj.get("description") or exc_obj.get("value") or ""),
          "url": str(det.get("url", "")),
          "line": int(det.get("lineNumber", 0)),
          "column": int(det.get("columnNumber", 0)),
      })
    elif method == "Log.entryAdded":
      entry = params.get("entry") or {}
      self.log_entries.append({
          "level": str(entry.get("level", "")),
          "source": str(entry.get("source", "")),
          "text": str(entry.get("text", "")),
          "url": str(entry.get("url", "")),
      })
    elif method == "Page.loadEventFired":
      self._page_loaded = True

  def cdp(
      self,
      method: str,
      params: dict[str, Any] | None = None,
      timeout: float = 25.0,
  ) -> dict[str, Any]:
    if self._ws is None:
      raise RuntimeError("CdpSession is closed")
    self._cmd_id += 1
    cid = self._cmd_id
    payload: dict[str, Any] = {"id": cid, "method": method}
    if params is not None:
      payload["params"] = params
    self._ws.send_json(payload)

    deadline = time.monotonic() + float(timeout)
    while True:
      rem = deadline - time.monotonic()
      if rem <= 0:
        raise TimeoutError(f"CDP command timed out after {timeout}s: {method}")
      msg = self._ws.recv_json(timeout=rem)
      if "id" not in msg:
        self._handle_event(str(msg.get("method", "")), msg.get("params") or {})
        continue
      if msg.get("id") == cid:
        if "error" in msg:
          raise RuntimeError(f"CDP error in {method}: {msg['error']}")
        return msg.get("result") or {}

  def pump_events(self, duration: float = 0.06) -> None:
    if self._ws is None:
      return
    deadline = time.monotonic() + max(0.0, float(duration))
    while True:
      rem = deadline - time.monotonic()
      if rem <= 0:
        break
      try:
        msg = self._ws.recv_json(timeout=min(0.02, rem))
      except TimeoutError:
        continue
      except Exception:
        break
      if "id" not in msg:
        self._handle_event(str(msg.get("method", "")), msg.get("params") or {})

  def add_init_script(self, source: str) -> str:
    res = self.cdp("Page.addScriptToEvaluateOnNewDocument", {"source": source})
    return str(res.get("identifier", ""))

  def eval_js(
      self,
      expression: str,
      await_promise: bool = True,
      timeout: float = 25.0,
  ) -> Any:
    res = self.cdp(
        "Runtime.evaluate",
        {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": bool(await_promise),
            "userGesture": False,
        },
        timeout=timeout,
    )
    if "exceptionDetails" in res:
      det = res["exceptionDetails"]
      exc = det.get("exception") or {}
      desc = exc.get("description") or exc.get("value") or det.get("text") or str(det)
      raise RuntimeError(f"JS evaluation exception: {desc}")
    obj = res.get("result") or {}
    return obj.get("value")

  def wait_raf(self, frames: int = 2) -> None:
    n = max(1, int(frames))
    self.eval_js(
        f"""
        new Promise((resolve) => {{
          let left = {n};
          const tick = () => {{
            left -= 1;
            if (left <= 0) resolve(true);
            else requestAnimationFrame(tick);
          }};
          requestAnimationFrame(tick);
        }})
        """,
        await_promise=True,
    )

  def wait_for(
      self,
      predicate_js: str,
      timeout_s: float = 10.0,
      poll_s: float = 0.05,
  ) -> bool:
    deadline = time.monotonic() + float(timeout_s)
    while time.monotonic() < deadline:
      try:
        val = self.eval_js(f"Boolean(({predicate_js}))", await_promise=True)
        if val:
          return True
      except Exception:
        pass
      self.pump_events(min(poll_s, max(0.01, deadline - time.monotonic())))
    return False

  def _resolve_url(self, url_or_path: str) -> str:
    if url_or_path.startswith(("http://", "https://", "about:", "data:")):
      return url_or_path
    base = self.browser.base_url
    if not base:
      raise ValueError(f"Relative path {url_or_path!r} requires a local server")
    return urllib.parse.urljoin(base, url_or_path.lstrip("/"))

  def goto(
      self,
      url_or_path: str = "index.html",
      *,
      wait_expr: str | None = None,
      timeout_s: float = 20.0,
  ) -> bool:
    url = self._resolve_url(url_or_path)
    if self._active_touches:
      self.touch_release_all()
    self._page_loaded = False
    nav_res = self.cdp("Page.navigate", {"url": url}, timeout=timeout_s)
    if nav_res.get("errorText"):
      self.network_failures.append({
          "requestId": str(nav_res.get("loaderId", "")),
          "url": url,
          "type": "Document",
          "errorText": str(nav_res["errorText"]),
          "canceled": False,
      })
      return False
    deadline = time.monotonic() + float(timeout_s)
    while not self._page_loaded and time.monotonic() < deadline:
      self.pump_events(0.05)
    if wait_expr:
      rem = max(1.0, deadline - time.monotonic())
      return self.wait_for(wait_expr, timeout_s=rem)
    return self._page_loaded

  def reset_page(
      self,
      url_or_path: str = "index.html",
      *,
      wait_expr: str | None = None,
      timeout_s: float = 20.0,
  ) -> bool:
    self.touch_release_all()
    self.cdp("Page.navigate", {"url": "about:blank"}, timeout=10.0)
    self.pump_events(0.08)
    self.clear_telemetry()
    return self.goto(url_or_path, wait_expr=wait_expr, timeout_s=timeout_s)

  def set_viewport(
      self,
      width: int,
      height: int,
      dpr: float = 2.0,
      mobile: bool = True,
      max_touch_points: int = 5,
      wait_frames: int = 2,
  ) -> dict[str, Any]:
    if self._active_touches:
      self.touch_release_all()
    self.width = int(width)
    self.height = int(height)
    self.dpr = float(dpr)
    self.mobile = bool(mobile)
    self.max_touch_points = int(max_touch_points)

    self.cdp(
        "Emulation.setDeviceMetricsOverride",
        {
            "width": self.width,
            "height": self.height,
            "deviceScaleFactor": self.dpr,
            "mobile": self.mobile,
            "screenWidth": self.width,
            "screenHeight": self.height,
        },
    )
    self.cdp(
        "Emulation.setTouchEmulationEnabled",
        {
            "enabled": self.mobile,
            "maxTouchPoints": self.max_touch_points if self.mobile else 1,
        },
    )
    if wait_frames > 0:
      self.eval_js("window.dispatchEvent(new Event('resize')); true;", await_promise=False)
      self.wait_raf(wait_frames)
    try:
      return self.eval_js(
          """(() => ({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            maxTouchPoints: navigator.maxTouchPoints,
            scrollWidth: document.documentElement ? document.documentElement.scrollWidth : 0,
            scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
          }))()""",
          await_promise=False,
      ) or {}
    except Exception:
      return {"innerWidth": self.width, "innerHeight": self.height, "devicePixelRatio": self.dpr}

  # -------------------------------------------------------------------------
  # Native iPad CDP Touch & Keyboard Helpers
  # -------------------------------------------------------------------------

  def locate_selector(
      self,
      selector: str,
      timeout_s: float = 0.0,
      scroll_if_needed: bool = False,
  ) -> dict[str, Any]:
    sel_json = json.dumps(selector)
    scroll_flag = "true" if scroll_if_needed else "false"
    js = f"""(() => {{
      const el = document.querySelector({sel_json});
      if (!el) return {{ found: false, reason: 'not_in_dom' }};
      let cur = el;
      while (cur && cur !== document.documentElement) {{
        if (cur.hasAttribute && cur.hasAttribute('hidden')) return {{ found: false, reason: 'hidden_attr' }};
        if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return {{ found: false, reason: 'aria_hidden' }};
        const cs = getComputedStyle(cur);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') <= 0.05) {{
          return {{ found: false, reason: 'css_hidden' }};
        }}
        cur = cur.parentElement;
      }}
      if ({scroll_flag}) {{
        try {{ el.scrollIntoView({{ block: 'center', inline: 'nearest', behavior: 'instant' }}); }} catch (_) {{}}
      }}
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return {{ found: false, reason: 'zero_size' }};
      const cs = getComputedStyle(el);
      const cx = r.left + r.width * 0.5;
      const cy = r.top + r.height * 0.5;
      const hit = document.elementFromPoint(cx, cy);
      const hitTestable = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      return {{
        found: true,
        x: Math.round(cx * 10) / 10,
        y: Math.round(cy * 10) / 10,
        left: Math.round(r.left * 10) / 10,
        top: Math.round(r.top * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        bottom: Math.round(r.bottom * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
        pointerEvents: cs.pointerEvents,
        hitTestable,
        hitTag: hit ? hit.tagName : null,
        hitId: hit ? hit.id : null,
      }};
    }})()"""

    deadline = time.monotonic() + max(0.0, float(timeout_s))
    while True:
      info = self.eval_js(js, await_promise=False) or {"found": False}
      if info.get("found") and (info.get("hitTestable") or timeout_s <= 0.0):
        return info
      if time.monotonic() >= deadline:
        return info
      time.sleep(0.04)

  def _alloc_touch_id(self, touch_id: int | None) -> int:
    """Returns lowest free positive touch_id when None; raises ValueError on active collision."""
    if touch_id is None:
      tid = 1
      while tid in self._active_touches:
        tid += 1
      return tid
    tid = int(touch_id)
    if tid in self._active_touches:
      raise ValueError(
          f"touch_id={tid} is already active in _active_touches "
          f"(active={sorted(self._active_touches)})"
      )
    return tid

  def touch_hold_start(
      self,
      x: float,
      y: float,
      touch_id: int | None = None,
  ) -> dict[str, Any]:
    tid = self._alloc_touch_id(touch_id)
    pt = _make_touch_point(x, y, touch_id=tid)
    self._active_touches[tid] = pt
    self.cdp(
        "Input.dispatchTouchEvent",
        {
            "type": "touchStart",
            "touchPoints": list(self._active_touches.values()),
        },
    )
    return pt

  def touch_hold_start_selector(
      self,
      selector: str,
      touch_id: int | None = None,
      timeout_s: float = 3.0,
      scroll_if_needed: bool = False,
  ) -> dict[str, Any]:
    info = self.locate_selector(
        selector, timeout_s=timeout_s, scroll_if_needed=scroll_if_needed
    )
    if not info.get("found"):
      raise AssertionError(f"Selector not visible/found for touch hold: {selector} ({info})")
    pt = self.touch_hold_start(info["x"], info["y"], touch_id=touch_id)
    info["touch_id"] = int(pt["id"])
    return info

  def touch_hold_move(self, x: float, y: float, touch_id: int = 1) -> None:
    pt = _make_touch_point(x, y, touch_id=touch_id)
    self._active_touches[int(touch_id)] = pt
    self.cdp(
        "Input.dispatchTouchEvent",
        {
            "type": "touchMove",
            "touchPoints": list(self._active_touches.values()),
        },
    )

  def touch_hold_end(self, touch_id: int | None = None) -> None:
    """Releases a single active finger (Chrome 158: [pt]) or all fingers individually."""
    if touch_id is None:
      if not self._active_touches:
        return
      for tid in reversed(list(self._active_touches)):
        self.touch_hold_end(touch_id=tid)
      return
    pt = self._active_touches.pop(int(touch_id), None)
    if pt is not None:
      self.cdp(
          "Input.dispatchTouchEvent",
          {"type": "touchEnd", "touchPoints": [pt]},
      )

  def touch_release_all(self) -> None:
    self.touch_hold_end(touch_id=None)

  def touch_cancel(self) -> None:
    """Chrome 158 strictly requires touchPoints=[] on touchCancel."""
    if not self._active_touches:
      return
    self._active_touches.clear()
    self.cdp(
        "Input.dispatchTouchEvent",
        {"type": "touchCancel", "touchPoints": []},
    )

  def touch_tap(
      self,
      x: float,
      y: float,
      hold_ms: int = 20,
      touch_id: int | None = None,
  ) -> None:
    pt = self.touch_hold_start(x, y, touch_id=touch_id)
    tid = int(pt["id"])
    try:
      if hold_ms > 0:
        time.sleep(hold_ms / 1000.0)
    finally:
      self.touch_hold_end(touch_id=tid)

  def touch_tap_selector(
      self,
      selector: str,
      hold_ms: int = 20,
      timeout_s: float = 3.0,
      touch_id: int | None = None,
      scroll_if_needed: bool = True,
  ) -> dict[str, Any]:
    info = self.locate_selector(
        selector, timeout_s=timeout_s, scroll_if_needed=scroll_if_needed
    )
    if not info.get("found"):
      raise AssertionError(f"Selector not found/visible for touch tap: {selector} ({info})")
    if scroll_if_needed:
      self.wait_raf(1)
      info2 = self.locate_selector(selector, timeout_s=0.0, scroll_if_needed=False)
      if info2.get("found"):
        info = info2
    self.touch_tap(info["x"], info["y"], hold_ms=hold_ms, touch_id=touch_id)
    return info

  def touch_drag(
      self,
      x1: float,
      y1: float,
      x2: float,
      y2: float,
      *,
      steps: int = 8,
      step_delay_ms: int = 12,
      touch_id: int | None = None,
      cancel: bool = False,
  ) -> None:
    n = max(1, int(steps))
    pt = self.touch_hold_start(x1, y1, touch_id=touch_id)
    tid = int(pt["id"])
    try:
      for i in range(1, n + 1):
        xi = x1 + (x2 - x1) * (i / n)
        yi = y1 + (y2 - y1) * (i / n)
        self.touch_hold_move(xi, yi, touch_id=tid)
        if step_delay_ms > 0:
          time.sleep(step_delay_ms / 1000.0)
      if cancel:
        self.touch_cancel()
      else:
        self.touch_hold_end(touch_id=tid)
    finally:
      if tid in self._active_touches:
        try:
          self.touch_hold_end(touch_id=tid)
        except Exception:
          pass

  @contextmanager
  def hold_touches(
      self,
      targets: list[tuple[str | tuple[float, float], int | None]],
  ) -> Iterator[list[dict[str, Any]]]:
    infos: list[dict[str, Any]] = []
    started_ids: list[int] = []
    try:
      for target, tid in targets:
        if isinstance(target, str):
          info = self.touch_hold_start_selector(target, touch_id=tid)
          infos.append(info)
          started_ids.append(int(info["touch_id"]))
        else:
          pt = self.touch_hold_start(target[0], target[1], touch_id=tid)
          infos.append(pt)
          started_ids.append(int(pt["id"]))
      yield infos
    finally:
      for tid in reversed(started_ids):
        if tid in self._active_touches:
          self.touch_hold_end(touch_id=tid)

  def multi_touch_hold(
      self,
      targets: list[tuple[str | tuple[float, float], int]],
      hold_ms: int = 300,
  ) -> list[dict[str, Any]]:
    with self.hold_touches(targets) as infos:
      if hold_ms > 0:
        time.sleep(hold_ms / 1000.0)
      return infos

  def dispatch_delayed_synthetic_click(
      self,
      selector: str,
      delay_ms: int = 600,
      *,
      event_kind: str = "pointer",
      detail: int = 1,
      pointer_type: str = "touch",
  ) -> dict[str, Any]:
    """Sleeps delay_ms real wall time, then dispatches a synthetic MouseEvent or PointerEvent click."""
    if delay_ms > 0:
      time.sleep(delay_ms / 1000.0)
    sel_json = json.dumps(selector)
    kind_json = json.dumps(event_kind)
    ptype_json = json.dumps(pointer_type)
    js = f"""(() => {{
      const el = document.querySelector({sel_json});
      if (!el) return {{ dispatched: false, reason: 'not_found' }};
      const r = el.getBoundingClientRect();
      const usePointer = ({kind_json} === 'pointer') && (typeof PointerEvent === 'function');
      const Ctor = usePointer ? PointerEvent : MouseEvent;
      const opts = {{
        bubbles: true,
        cancelable: true,
        view: window,
        detail: {int(detail)},
        clientX: r.left + r.width * 0.5,
        clientY: r.top + r.height * 0.5,
      }};
      if (usePointer) {{
        opts.pointerType = {ptype_json};
      }}
      const ev = new Ctor('click', opts);
      const notCanceled = el.dispatchEvent(ev);
      return {{
        dispatched: true,
        ctor: usePointer ? 'PointerEvent' : 'MouseEvent',
        detail: {int(detail)},
        defaultPrevented: !notCanceled,
      }};
    }})()"""
    return self.eval_js(js, await_promise=False) or {"dispatched": False}

  def keyboard_press(
      self,
      key: str,
      selector: str | None = None,
  ) -> None:
    """Dispatches Chrome 158 native rawKeyDown -> char (when printable/Enter) -> keyUp."""
    if selector is not None:
      sel_json = json.dumps(selector)
      focused = self.eval_js(
          f"(() => {{ const el = document.querySelector({sel_json}); if (!el) return false; el.focus(); return document.activeElement === el; }})()",
          await_promise=False,
      )
      if not focused:
        raise AssertionError(f"Could not focus selector for keyboard_press: {selector}")

    if key in _KEY_TABLE:
      k_name, code, vk, txt = _KEY_TABLE[key]
    elif len(key) == 1:
      k_name = key
      code = f"Key{key.upper()}" if key.isalpha() else ""
      vk = ord(key.upper())
      txt = key
    else:
      k_name, code, vk, txt = key, key, 0, ""

    self.cdp(
        "Input.dispatchKeyEvent",
        {
            "type": "rawKeyDown",
            "key": k_name,
            "code": code,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
        },
    )
    if txt:
      self.cdp(
          "Input.dispatchKeyEvent",
          {
              "type": "char",
              "key": k_name,
              "code": code,
              "text": txt,
              "unmodifiedText": txt,
              "windowsVirtualKeyCode": vk,
              "nativeVirtualKeyCode": vk,
          },
      )
    self.cdp(
        "Input.dispatchKeyEvent",
        {
            "type": "keyUp",
            "key": k_name,
            "code": code,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
        },
    )

  # -------------------------------------------------------------------------
  # Guardrail Spies & Telemetry
  # -------------------------------------------------------------------------

  def get_preboot_spy(self) -> dict[str, Any]:
    data = self.eval_js(
        """(() => {
          const s = window.__PREBOOT_SPY__ || null;
          if (!s) return null;
          return {
            ...s,
            firstRafDone: Boolean(window.__PREBOOT_FIRST_RAF_DONE__ || s.firstRafDone),
            firstRafStarted: Boolean(window.__PREBOOT_FIRST_RAF_STARTED__ || s.firstRafStarted),
          };
        })()""",
        await_promise=False,
    )
    return data or {}

  def get_audio_spy(self) -> dict[str, Any]:
    return self.eval_js("window.__PREBOOT_AUDIO_SPY__ || null", await_promise=False) or {}

  def snapshot_telemetry(
      self,
      pump_sec: float = 0.05,
      allow_favicon_404: bool = False,
  ) -> dict[str, Any]:
    self.pump_events(pump_sec)
    window_errors: list[dict[str, Any]] = []
    try:
      tracker = self.eval_js("window.__E2E_ERROR_TRACKER__ || null", await_promise=False)
      if isinstance(tracker, dict):
        for e in tracker.get("jsErrors") or []:
          window_errors.append({"kind": "jsError", **e})
        for e in tracker.get("unhandledRejections") or []:
          window_errors.append({"kind": "unhandledRejection", **e})
        for e in tracker.get("resourceErrors") or []:
          window_errors.append({"kind": "resourceError", **e})
    except Exception:
      pass

    console_errors = [
        c for c in self.console_entries if c.get("type") in ("error", "assert")
    ]
    http_errors: list[dict[str, Any]] = []
    for r in self.network_responses:
      status = int(r.get("status", 0))
      if status >= 400:
        url_path = urllib.parse.urlsplit(str(r.get("url", ""))).path
        if allow_favicon_404 and status == 404 and url_path.endswith("/favicon.ico"):
          continue
        http_errors.append(r)

    network_failures = [
        f for f in self.network_failures if not f.get("canceled")
    ]
    log_errors = [
        e for e in self.log_entries if e.get("level") == "error"
    ]
    server_http_errors: list[dict[str, Any]] = []
    if self.browser.server is not None:
      for rec in self.browser.server.get_error_records(allow_favicon_404=allow_favicon_404):
        server_http_errors.append(dataclasses.asdict(rec))

    return {
        "console_errors": console_errors,
        "exceptions": list(self.exceptions),
        "http_errors": http_errors,
        "network_failures": network_failures,
        "log_errors": log_errors,
        "server_http_errors": server_http_errors,
        "window_errors": window_errors,
        "responses": list(self.network_responses),
        "requested_urls": list(self.requested_urls),
    }

  def clear_telemetry(self) -> None:
    self._request_urls.clear()
    self.requested_urls.clear()
    self.network_responses.clear()
    self.network_failures.clear()
    self.console_entries.clear()
    self.exceptions.clear()
    self.log_entries.clear()
    if self.browser.server is not None:
      self.browser.server.clear_records()
    try:
      self.eval_js(
          """(() => {
            const t = window.__E2E_ERROR_TRACKER__;
            if (t) {
              t.jsErrors.length = 0;
              t.unhandledRejections.length = 0;
              t.resourceErrors.length = 0;
            }
          })()""",
          await_promise=False,
      )
    except Exception:
      pass

  def assert_zero_errors(
      self,
      context: str = "",
      allow_favicon_404: bool = False,
  ) -> dict[str, Any]:
    snap = self.snapshot_telemetry(allow_favicon_404=allow_favicon_404)
    problems: list[str] = []
    for key in (
        "console_errors",
        "exceptions",
        "http_errors",
        "network_failures",
        "log_errors",
        "server_http_errors",
        "window_errors",
    ):
      items = snap.get(key) or []
      if items:
        problems.append(f"{key}={items[:3]}")
    if problems:
      prefix = f"[{context}] " if context else ""
      raise AssertionError(f"{prefix}Runtime telemetry errors detected: " + "; ".join(problems))
    return snap

  # -------------------------------------------------------------------------
  # Visual Screenshots & Canvas Activity
  # -------------------------------------------------------------------------

  def capture_screenshot_png(self) -> bytes:
    res = self.cdp(
        "Page.captureScreenshot",
        {"format": "png", "captureBeyondViewport": False},
        timeout=25.0,
    )
    return base64.b64decode(res["data"])

  def capture_png_bytes(self) -> bytes:
    return self.capture_screenshot_png()

  def capture_image(self) -> Image.Image:
    return Image.open(io.BytesIO(self.capture_screenshot_png())).convert("RGB")

  def capture_screenshot_jpeg(
      self,
      path: str | Path,
      width: int | None = None,
      height: int | None = None,
      quality: int = 92,
  ) -> dict[str, Any]:
    img = self.capture_image()
    if width is not None and height is not None:
      target_size = (int(width), int(height))
      if img.size != target_size:
        img = img.resize(target_size, Image.Resampling.LANCZOS)
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(
        dest,
        format="JPEG",
        quality=int(quality),
        optimize=True,
        subsampling=0,
    )
    stats = image_rgb_stats(img)
    return {
        "path": str(dest),
        "bytes": dest.stat().st_size,
        **stats,
    }

  def verify_canvas_active(
      self,
      delay_s: float = 0.30,
      min_mad: float = 0.15,
      min_changed_frac: float = 0.0005,
  ) -> dict[str, Any]:
    im1 = self.capture_image()
    time.sleep(max(0.05, float(delay_s)))
    im2 = self.capture_image()
    st1 = image_rgb_stats(im1)
    st2 = image_rgb_stats(im2)
    delta = image_frame_delta(im1, im2)
    active = (
        st1["is_non_blank"]
        and st2["is_non_blank"]
        and (delta["mad"] >= min_mad or delta["changed_px_frac"] >= min_changed_frac)
    )
    return {
        "frame1_stats": st1,
        "frame2_stats": st2,
        "delta": delta,
        "active": active,
    }

  def _close_transport_only(self) -> None:
    if self._ws is not None:
      try:
        self._ws.close()
      except Exception:
        pass
      self._ws = None

  def close(self) -> None:
    if self._closed:
      return
    self._closed = True
    try:
      if self._active_touches and self._ws is not None:
        self.touch_release_all()
    except Exception:
      pass
    self._close_transport_only()
    if self._owns_target:
      self.browser._close_target(self.target_id)
    try:
      self.browser._sessions.remove(self)
    except ValueError:
      pass

  def __enter__(self) -> CdpSession:
    return self

  def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
    self.close()
