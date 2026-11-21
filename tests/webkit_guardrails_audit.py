#!/usr/bin/env python3
"""Static (S1-S6) + Runtime (R1-R5) iPad Safari WebKit Guardrails & Hygiene Audit.

Verifies:
- S1 / R1 (Guardrail 1): Zero synchronous renderer.compile() before first rAF.
- S2 / R2 (Guardrail 2): MeshStandardMaterial metalness <= 0.22 when scene.environment === null.
- S3 / R3 (Guardrail 3): Timer-free pointerdown HUD touch actions (zero ms-timer click dedup).
- S4 / R4 (Guardrail 4): >= 450 ms modal backdrop open guard on pointerdown.
- S5 / R5: Zero external CDN URLs, relative GitHub Pages paths, inline SVG favicon,
           .nojekyll, zero HTTP 4xx/5xx (including /favicon.ico), zero console/page errors.
- S6: Generic secret/token, .git/config, corp-path/email, and optional external blocklist check.
"""

from __future__ import annotations

import argparse
import html.parser
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any
import urllib.parse

sys.dont_write_bytecode = True

_TESTS_DIR = str(Path(__file__).resolve().parent)
if _TESTS_DIR not in sys.path:
  sys.path.insert(0, _TESTS_DIR)

import cdp  # noqa: E402


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

R3_HUD_BUTTONS: list[str] = [
    "#btn-garage",
    "#btn-teleport",
    "#btn-tnt",
    "#btn-camera",
    "#btn-auto-smash",
    "#btn-ragdoll",
    "#btn-audio",
    "#btn-repair",
]


# ---------------------------------------------------------------------------
# Shared Newline-Preserving Lexers (Zero Comment / String False Positives)
# ---------------------------------------------------------------------------

_REGEX_PREV_KEYWORDS = frozenset({
    "return", "case", "throw", "typeof", "void", "delete",
    "in", "of", "new", "yield", "await", "else", "do",
})
_REGEX_PAREN_KEYWORDS = frozenset({"if", "while", "for", "with"})
_REGEX_PREV_PUNCT = frozenset("([{},;=:?!&|~^+-*%<>")


def _can_start_regex(mask: list[str]) -> bool:
  """Determines whether '/' can start a JS regex literal based on prior token."""
  idx = len(mask) - 1
  while idx >= 0 and mask[idx] in (" ", "\t", "\r", "\n"):
    idx -= 1
  if idx < 0:
    return True
  ch = mask[idx]
  if ch in ("+", "-") and idx > 0 and mask[idx - 1] == ch:
    return False
  if ch in _REGEX_PREV_PUNCT:
    return True
  if ch == ")":
    # Handle statement-introducing condition parens: if (...) /regex/, while (...) /regex/, etc.
    depth = 1
    j = idx - 1
    while j >= 0 and depth > 0:
      if mask[j] == ")":
        depth += 1
      elif mask[j] == "(":
        depth -= 1
      j -= 1
    if depth != 0:
      return False
    while j >= 0 and mask[j] in (" ", "\t", "\r", "\n"):
      j -= 1
    if j >= 0 and (mask[j].isalnum() or mask[j] in ("_", "$")):
      end = j + 1
      while j >= 0 and (mask[j].isalnum() or mask[j] in ("_", "$")):
        j -= 1
      word = "".join(mask[j + 1 : end])
      return word in _REGEX_PAREN_KEYWORDS
    return False
  if ch.isalnum() or ch in ("_", "$"):
    end = idx + 1
    while idx >= 0 and (mask[idx].isalnum() or mask[idx] in ("_", "$")):
      idx -= 1
    word = "".join(mask[idx + 1 : end])
    return word in _REGEX_PREV_KEYWORDS
  return False


def strip_js(src: str, *, strip_strings: bool = False) -> str:
  """Single-pass newline-preserving JS lexer stripping comments (and optionally strings)."""
  n = len(src)
  i = 0
  out: list[str] = []
  # Parallel char-mask always blanking string/regex/comment interiors so
  # _can_start_regex() makes identical decisions for strip_strings=False and True.
  mask: list[str] = []
  # Stack of brace depths for nested `${ ... }` inside template literals.
  template_brace_stack: list[int] = []

  def _consume_template_segment(pos: int) -> int:
    while pos < n:
      ch = src[pos]
      if ch == "\\":
        if pos + 1 < n:
          nxt = src[pos + 1]
          m2 = "\n" if nxt == "\n" else " "
          mask.extend((" ", m2))
          if strip_strings:
            out.extend((" ", m2))
          else:
            out.extend((ch, nxt))
          pos += 2
          continue
        mask.append(" ")
        out.append(" " if strip_strings else ch)
        return pos + 1
      if ch == "`":
        mask.append("`")
        out.append("`")
        return pos + 1
      if ch == "$" and pos + 1 < n and src[pos + 1] == "{":
        mask.extend(("$", "{"))
        out.extend(("$", "{"))
        template_brace_stack.append(1)
        return pos + 2
      if ch == "\n":
        mask.append("\n")
        out.append("\n")
      else:
        mask.append(" ")
        out.append(" " if strip_strings else ch)
      pos += 1
    return pos

  while i < n:
    ch = src[i]
    nxt = src[i + 1] if i + 1 < n else ""

    # Line comment: // ... \n
    if ch == "/" and nxt == "/":
      mask.extend((" ", " "))
      out.extend((" ", " "))
      i += 2
      while i < n and src[i] != "\n":
        mask.append(" ")
        out.append(" ")
        i += 1
      continue

    # Block comment: /* ... */
    if ch == "/" and nxt == "*":
      mask.extend((" ", " "))
      out.extend((" ", " "))
      i += 2
      while i < n:
        if src[i] == "*" and i + 1 < n and src[i + 1] == "/":
          mask.extend((" ", " "))
          out.extend((" ", " "))
          i += 2
          break
        mc = "\n" if src[i] == "\n" else " "
        mask.append(mc)
        out.append(mc)
        i += 1
      continue

    # Single or double quoted string
    if ch in ("'", '"'):
      quote = ch
      mask.append(quote)
      out.append(quote)
      i += 1
      while i < n:
        c = src[i]
        if c == "\\":
          if i + 1 < n:
            c2 = src[i + 1]
            m2 = "\n" if c2 == "\n" else " "
            mask.extend((" ", m2))
            if strip_strings:
              out.extend((" ", m2))
            else:
              out.extend((c, c2))
            i += 2
            continue
        if c == quote:
          mask.append(quote)
          out.append(quote)
          i += 1
          break
        if c == "\n":
          mask.append("\n")
          out.append("\n")
        else:
          mask.append(" ")
          out.append(" " if strip_strings else c)
        i += 1
      continue

    # Template literal start
    if ch == "`":
      mask.append("`")
      out.append("`")
      i = _consume_template_segment(i + 1)
      continue

    # Brace tracking for template literal `${ ... }` expressions
    if template_brace_stack:
      if ch == "{":
        template_brace_stack[-1] += 1
        mask.append("{")
        out.append("{")
        i += 1
        continue
      if ch == "}":
        template_brace_stack[-1] -= 1
        mask.append("}")
        out.append("}")
        i += 1
        if template_brace_stack[-1] == 0:
          template_brace_stack.pop()
          i = _consume_template_segment(i)
        continue

    # Regex literal: / ... /flags
    if ch == "/" and _can_start_regex(mask):
      mask.append("/")
      out.append("/")
      i += 1
      in_class = False
      while i < n:
        c = src[i]
        if c == "\\" and i + 1 < n:
          c2 = src[i + 1]
          m2 = "\n" if c2 == "\n" else " "
          mask.extend((" ", m2))
          out.append(" " if strip_strings else c)
          out.append("\n" if c2 == "\n" else (" " if strip_strings else c2))
          i += 2
          continue
        if c == "[":
          in_class = True
        elif c == "]":
          in_class = False
        elif c == "/" and not in_class:
          mask.append("/")
          out.append("/")
          i += 1
          while i < n and src[i].isalpha():
            mask.append(src[i])
            out.append(src[i])
            i += 1
          break
        if c == "\n":
          mask.append("\n")
          out.append("\n")
          i += 1
          break
        mask.append(" ")
        out.append(" " if strip_strings else c)
        i += 1
      continue

    mask.append(ch)
    out.append(ch)
    i += 1

  return "".join(out)


def strip_css_comments(src: str) -> str:
  """Single-pass CSS comment stripper preserving strings and line numbers."""
  n = len(src)
  i = 0
  out: list[str] = []
  while i < n:
    ch = src[i]
    nxt = src[i + 1] if i + 1 < n else ""
    if ch in ("'", '"'):
      quote = ch
      out.append(quote)
      i += 1
      while i < n:
        c = src[i]
        out.append(c)
        i += 1
        if c == "\\" and i < n:
          out.append(src[i])
          i += 1
        elif c == quote:
          break
      continue
    if ch == "/" and nxt == "*":
      out.append("  ")
      i += 2
      while i < n:
        if src[i] == "*" and i + 1 < n and src[i + 1] == "/":
          out.append("  ")
          i += 2
          break
        out.append("\n" if src[i] == "\n" else " ")
        i += 1
      continue
    out.append(ch)
    i += 1
  return "".join(out)


def strip_html_comments(src: str) -> str:
  return re.sub(
      r"<!--[\s\S]*?-->",
      lambda m: "\n" * m.group(0).count("\n"),
      src,
  )


def extract_brace_body(code: str, start_idx: int) -> tuple[int, int, str]:
  """Finds first '{' at/after start_idx in string-stripped JS and returns (open_i, close_i, body)."""
  open_i = code.find("{", start_idx)
  if open_i < 0:
    return (-1, -1, "")
  depth = 0
  for i in range(open_i, len(code)):
    c = code[i]
    if c == "{":
      depth += 1
    elif c == "}":
      depth -= 1
      if depth == 0:
        return (open_i, i + 1, code[open_i : i + 1])
  return (open_i, len(code), code[open_i:])


def extract_enclosing_object(code: str, offset: int) -> str:
  """Finds the enclosing `{ ... }` object literal containing offset, or statement slice."""
  depth = 0
  open_i = -1
  for i in range(offset, -1, -1):
    c = code[i]
    if c == "}":
      depth += 1
    elif c == "{":
      if depth == 0:
        open_i = i
        break
      depth -= 1
  if open_i >= 0:
    _, _, body = extract_brace_body(code, open_i)
    if body:
      return body
  # Fallback: statement bounded by ';' or newline.
  s = max(0, code.rfind(";", 0, offset) + 1)
  e = code.find(";", offset)
  if e < 0:
    e = len(code)
  return code[s:e]


def line_of(src: str, offset: int) -> int:
  return src.count("\n", 0, max(0, offset)) + 1


# ---------------------------------------------------------------------------
# Static Audit Checks (S1 - S6)
# ---------------------------------------------------------------------------

DOT_COMPILE_RE = re.compile(r"(?:\?\.|\.)\s*compile(?:Async)?\s*\(")
BRACKET_COMPILE_RE = re.compile(r"\[\s*['\"]compile(?:Async)?['\"]\s*\]\s*\(")
METALNESS_VAL_RE = re.compile(
    r"\bmetalness\s*(?P<op>:|=(?!=))\s*(?P<val>(?:0?\.\d+|\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?)"
)
ENVMAP_RE = re.compile(
    r"\benvMap\s*(?::\s*(?!null\b|undefined\b|false\b)\S|(?=[,\}]))"
)
MAX_METALNESS_CONST_RE = re.compile(
    r"\bMAX_NON_IBL_METALNESS\s*=\s*(?P<val>(?:0?\.\d+|\d+(?:\.\d+)?))"
)
DIRECT_STD_MAT_RE = re.compile(
    r"\bnew\s+(?:THREE\.)?Mesh(?:Standard|Physical)Material\s*\("
)

_G3_DEDUP_TS_IDENT = (
    r"(?!openedAt\b|openAt\b|modalOpenedAt\b)"
    r"(?:"
    r"\w*(?:pointer|touch|tap|click)\w*"
    r"|(?:last|prev|recent)_?(?:down|up|fire|event)(?:_?(?:time|at|ms))?\b"
    r"|(?:debounce|dedup)\w*"
    r")"
)
G3_TIMER_DEDUP_RE = re.compile(
    r"(?:Date\.now\s*\(\s*\)|performance\.now\s*\(\s*\)|\bnowMs\s*\(\s*\)|\bnow\b|\bt\b|\bgestureStart\b|\bcoordStart\b)"
    r"\s*-\s*" + _G3_DEDUP_TS_IDENT + r"\s*<=?\s*"
    r"(?:\d+|debounce\w*|dedup\w*|window\w*|threshold\w*|ms\b)",
    re.IGNORECASE,
)
G3_TWO_LINE_DEDUP_RE = re.compile(
    r"(?:const|let|var)\s+(?P<var>[a-zA-Z_$]\w*)\s*=\s*"
    r"(?:Date\.now\s*\(\s*\)|performance\.now\s*\(\s*\)|\bnowMs\s*\(\s*\)|\bnow\b|\bt\b)"
    r"\s*-\s*" + _G3_DEDUP_TS_IDENT
    + r"[\s\S]{0,180}?\b(?P=var)\s*<=?\s*(?:\d+|debounce\w*|dedup\w*)",
    re.IGNORECASE,
)
G3_TIMERS_RE = re.compile(r"\b(?:Date\.now|performance\.now|setTimeout|setInterval)\b")
G3_CLICK_CLOCK_RE = re.compile(r"\b(?:Date\.now|performance\.now|nowMs)\s*\(")
G3_TIMEOUT_LATCH_RE = re.compile(
    r"\bsetTimeout\s*\([\s\S]{0,180}?(?:ignore|swallow|suppress|handled|skip|block|recent)\w*(?:Click|Tap|Pointer|Touch)?",
    re.IGNORECASE,
)
KNOWN_CDN_RE = re.compile(
    r"(?:unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|"
    r"fonts\.googleapis\.com|fonts\.gstatic\.com|esm\.sh|skypack\.dev|ajax\.googleapis\.com)",
    re.IGNORECASE,
)


def _has_js_export(no_cs: str, symbol: str) -> bool:
  """Returns True if symbol is exported via declaration or ES2022 `export { ... }` list."""
  esc = re.escape(symbol)
  if re.search(rf"\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+{esc}\b", no_cs):
    return True
  for m in re.finditer(r"\bexport\s*\{([^}]*)\}", no_cs):
    spec = m.group(1)
    if re.search(rf"(?:^|,)\s*(?:\w+\s+as\s+)?{esc}\s*(?:,|$)", spec):
      return True
  return False


def _collect_src_js(root: Path) -> list[Path]:
  src_dir = root / "src"
  if not src_dir.is_dir():
    return []
  return sorted(p for p in src_dir.rglob("*.js") if p.is_file())


def _skip_balanced_parens(code: str, open_paren_idx: int) -> int:
  """Given index of '(', returns index immediately after matching ')'."""
  depth = 0
  for i in range(open_paren_idx, len(code)):
    c = code[i]
    if c == "(":
      depth += 1
    elif c == ")":
      depth -= 1
      if depth == 0:
        return i + 1
  return len(code)


def _find_callable_body_span(no_cs: str, no_c: str, start_idx: int) -> tuple[int, int, str, str]:
  """Extracts callable body (open_i, close_i, body_cs, body_c) after start_idx."""
  n = len(no_cs)
  i = start_idx
  while i < n and no_cs[i].isspace():
    i += 1
  # Skip optional 'async' / 'function' / '*' / function name before '(' or '=>'.
  for _ in range(4):
    if i < n and no_cs[i] == "*":
      i += 1
    elif i < n and (no_cs[i].isalpha() or no_cs[i] in ("_", "$")):
      j = i
      while j < n and (no_cs[j].isalnum() or no_cs[j] in ("_", "$")):
        j += 1
      word = no_cs[i:j]
      if word in ("async", "function"):
        i = j
      else:
        # Either function name before '(' or single arrow param before '=>'.
        k = j
        while k < n and no_cs[k].isspace():
          k += 1
        if k < n and (no_cs[k] == "(" or no_cs[k : k + 2] == "=>"):
          i = k
        else:
          return (-1, -1, "", "")
    else:
      break
    while i < n and no_cs[i].isspace():
      i += 1

  if i < n and no_cs[i] == "(":
    i = _skip_balanced_parens(no_cs, i)
    while i < n and no_cs[i].isspace():
      i += 1
  if no_cs[i : i + 2] == "=>":
    i += 2
    while i < n and no_cs[i].isspace():
      i += 1
  if i >= n or no_cs[i] != "{":
    return (-1, -1, "", "")
  o, e, body_cs = extract_brace_body(no_cs, i)
  if o < 0:
    return (-1, -1, "", "")
  return (o, e, body_cs, no_c[o:e])


def _find_callable_body(no_cs: str, no_c: str, start_idx: int) -> tuple[str, str]:
  """Extracts function/arrow body after start_idx, skipping destructured (...) params."""
  _, _, body_cs, body_c = _find_callable_body_span(no_cs, no_c, start_idx)
  return (body_cs, body_c)


def _find_function_body(no_cs: str, no_c: str, func_name: str) -> tuple[str, str]:
  pat = re.compile(
      rf"(?:export\s+)?(?:async\s+)?function\s+{re.escape(func_name)}\b|"
      rf"(?:export\s+)?(?:const|let|var)\s+{re.escape(func_name)}\s*="
  )
  m = pat.search(no_cs)
  if not m:
    return ("", "")
  return _find_callable_body(no_cs, no_c, m.end())


def _find_function_decl_and_body(no_cs: str, no_c: str, func_name: str) -> tuple[str, str, str]:
  """Returns (decl_and_body_cs, body_cs, body_c) including signature default params."""
  pat = re.compile(
      rf"(?:export\s+)?(?:async\s+)?function\s+{re.escape(func_name)}\b|"
      rf"(?:export\s+)?(?:const|let|var)\s+{re.escape(func_name)}\s*="
  )
  m = pat.search(no_cs)
  if not m:
    return ("", "", "")
  o, e, body_cs, body_c = _find_callable_body_span(no_cs, no_c, m.end())
  if o < 0:
    return ("", "", "")
  return (no_cs[m.start() : e], body_cs, body_c)


def _find_function_body_near(
    no_cs: str, no_c: str, func_name: str, ref_offset: int
) -> tuple[str, str]:
  """Finds body of named callable nearest (preferring preceding) to ref_offset."""
  pat = re.compile(
      rf"(?:export\s+)?(?:async\s+)?function\s+{re.escape(func_name)}\b|"
      rf"(?:export\s+)?(?:const|let|var)\s+{re.escape(func_name)}\s*="
  )
  matches = list(pat.finditer(no_cs))
  if not matches:
    return ("", "")
  preceding = [m for m in matches if m.start() <= ref_offset]
  ordered = list(reversed(preceding)) + [m for m in matches if m.start() > ref_offset]
  for m in ordered:
    body_cs, body_c = _find_callable_body(no_cs, no_c, m.end())
    if body_cs:
      return (body_cs, body_c)
    # Expression arrow fallback: `const fn = (e) => ...;`
    arrow_i = no_cs.find("=>", m.end())
    if arrow_i >= 0 and arrow_i - m.end() < 80:
      end_semi = no_cs.find(";", arrow_i)
      end_nl = no_cs.find("\n", arrow_i)
      ends = [x for x in (end_semi, end_nl) if x >= 0]
      end_i = min(ends) if ends else len(no_cs)
      return (no_cs[arrow_i + 2 : end_i], no_c[arrow_i + 2 : end_i])
  return ("", "")


def _find_local_clock_helpers(no_cs: str, no_c: str) -> set[str]:
  """Detects thin local clock wrapper helpers (e.g., `const clock = () => performance.now()`)."""
  helpers: set[str] = set()
  decl_pat = re.compile(
      r"(?:function\s+([a-zA-Z_$]\w*)\s*\([^)]*\)|"
      r"(?:const|let|var)\s+([a-zA-Z_$]\w*)\s*=\s*(?:async\s*)?"
      r"(?:function\b|\([^)]*\)\s*=>|[a-zA-Z_$]\w*\s*=>))"
  )
  for m in decl_pat.finditer(no_cs):
    name = m.group(1) or m.group(2)
    if not name:
      continue
    call_start = no_cs.find("=", m.start()) + 1 if m.group(2) else m.start()
    body_cs, _ = _find_callable_body(no_cs, no_c, call_start)
    if not body_cs:
      arrow_i = no_cs.find("=>", m.start())
      if arrow_i >= 0 and arrow_i < m.end() + 4:
        end_semi = no_cs.find(";", arrow_i)
        end_nl = no_cs.find("\n", arrow_i)
        ends = [x for x in (end_semi, end_nl) if x >= 0]
        end_i = min(ends) if ends else len(no_cs)
        body_cs = no_cs[arrow_i + 2 : end_i]
    if (
        body_cs
        and len(body_cs) <= 220
        and "addEventListener" not in body_cs
        and G3_CLICK_CLOCK_RE.search(body_cs)
    ):
      helpers.add(name)
  return helpers


def check_s1_no_pre_raf_compile(root: Path) -> dict[str, Any]:
  js_files = _collect_src_js(root)
  if not js_files:
    return {
        "id": "S1_G1_NO_PRE_RAF_COMPILE",
        "phase": "static",
        "guardrail": "G1",
        "passed": False,
        "details": {"error": "no_source_files_found"},
    }
  offenders: list[str] = []
  has_renderer = False
  for path in js_files:
    rel = path.relative_to(root).as_posix()
    raw = path.read_text(encoding="utf-8", errors="replace")
    no_c = strip_js(raw, strip_strings=False)
    no_cs = strip_js(raw, strip_strings=True)
    if re.search(r"\bWebGLRenderer\b|getContext\s*\(\s*['\"]webgl2?['\"]", no_c):
      has_renderer = True
    for m in DOT_COMPILE_RE.finditer(no_cs):
      offenders.append(f"{rel}:{line_of(raw, m.start())}: {m.group(0).strip()}")
    for m in BRACKET_COMPILE_RE.finditer(no_c):
      offenders.append(f"{rel}:{line_of(raw, m.start())}: {m.group(0).strip()}")

  passed = has_renderer and not offenders
  return {
      "id": "S1_G1_NO_PRE_RAF_COMPILE",
      "phase": "static",
      "guardrail": "G1",
      "passed": passed,
      "details": {
          "filesScanned": len(js_files),
          "hasRendererReference": has_renderer,
          "offenders": offenders,
      },
  }


def check_s2_metalness_static(root: Path) -> dict[str, Any]:
  js_files = _collect_src_js(root)
  if not js_files:
    return {
        "id": "S2_G2_METALNESS_CAP_STATIC",
        "phase": "static",
        "guardrail": "G2",
        "passed": False,
        "details": {"error": "no_source_files_found"},
    }

  offenders: list[str] = []
  direct_mat_offenders: list[str] = []
  const_issues: list[str] = []
  enforce_callers: list[str] = []

  for path in js_files:
    rel = path.relative_to(root).as_posix()
    raw = path.read_text(encoding="utf-8", errors="replace")
    no_cs = strip_js(raw, strip_strings=True)

    for m in METALNESS_VAL_RE.finditer(no_cs):
      val = float(m.group("val"))
      if val > 0.22:
        # Only exempt object-property colon syntax (`metalness: ...`) inside an
        # object literal with `envMap`; NEVER exempt bare assignment `m.metalness = ...`
        # via an unrelated sibling `{ envMap }` in the enclosing function body.
        has_envmap = False
        if m.group("op") == ":":
          ctx = extract_enclosing_object(no_cs, m.start())
          has_envmap = bool(ENVMAP_RE.search(ctx))
        if not has_envmap:
          offenders.append(
              f"{rel}:{line_of(raw, m.start())}: metalness={val} > 0.22 without envMap"
          )

    for m in MAX_METALNESS_CONST_RE.finditer(no_cs):
      val = float(m.group("val"))
      if val > 0.22:
        const_issues.append(f"{rel}:{line_of(raw, m.start())}: MAX_NON_IBL_METALNESS={val} > 0.22")

    if rel != "src/core/materials.js":
      if re.search(r"\benforceMaterialGuardrails\s*\(", no_cs):
        enforce_callers.append(rel)
      for m in DIRECT_STD_MAT_RE.finditer(no_cs):
        # Inspect argument object literal if present right after '('.
        arg_start = m.end()
        arg_obj = ""
        ws_end = arg_start
        while ws_end < len(no_cs) and no_cs[ws_end].isspace():
          ws_end += 1
        if ws_end < len(no_cs) and no_cs[ws_end] == "{":
          _, _, arg_obj = extract_brace_body(no_cs, ws_end)
        if not ENVMAP_RE.search(arg_obj):
          direct_mat_offenders.append(
              f"{rel}:{line_of(raw, m.start())}: direct {m.group(0).strip()} outside src/core/materials.js"
          )

  mat_path = root / "src/core/materials.js"
  mat_issues: list[str] = []
  if not mat_path.is_file():
    mat_issues.append("missing src/core/materials.js")
  else:
    mat_raw = mat_path.read_text(encoding="utf-8", errors="replace")
    mat_cs = strip_js(mat_raw, strip_strings=True)
    if not _has_js_export(mat_cs, "createStandardMaterial"):
      mat_issues.append("src/core/materials.js missing export createStandardMaterial")
    if not _has_js_export(mat_cs, "enforceMaterialGuardrails"):
      mat_issues.append("src/core/materials.js missing export enforceMaterialGuardrails")
    m_const = MAX_METALNESS_CONST_RE.search(mat_cs)
    has_clamp = bool(
        re.search(r"Math\.min\s*\(|>\s*(?:0?\.(?:1\d|2[012])|MAX_NON_IBL_METALNESS)", mat_cs)
    )
    if not m_const:
      mat_issues.append("src/core/materials.js missing MAX_NON_IBL_METALNESS constant")
    elif float(m_const.group("val")) > 0.22:
      mat_issues.append(f"MAX_NON_IBL_METALNESS={m_const.group('val')} > 0.22")
    if not has_clamp:
      mat_issues.append("src/core/materials.js missing metalness clamp logic")
    if not enforce_callers:
      mat_issues.append("enforceMaterialGuardrails() is never called outside src/core/materials.js")

  passed = (
      not offenders
      and not direct_mat_offenders
      and not const_issues
      and not mat_issues
  )
  return {
      "id": "S2_G2_METALNESS_CAP_STATIC",
      "phase": "static",
      "guardrail": "G2",
      "passed": passed,
      "details": {
          "metalnessOffenders": offenders,
          "directMaterialOffenders": direct_mat_offenders,
          "constantIssues": const_issues,
          "materialsModuleIssues": mat_issues,
          "enforceCallers": enforce_callers,
      },
  }


def check_s3_timer_free_hud_touch_static(root: Path) -> dict[str, Any]:
  tb_path = root / "src/core/touch_bind.js"
  s3a_issues: list[str] = []
  if not tb_path.is_file():
    s3a_issues.append("missing src/core/touch_bind.js")
  else:
    raw = tb_path.read_text(encoding="utf-8", errors="replace")
    no_c = strip_js(raw, strip_strings=False)
    no_cs = strip_js(raw, strip_strings=True)
    if not _has_js_export(no_cs, "bindHudTouchAction"):
      s3a_issues.append("touch_bind.js missing export bindHudTouchAction")
    if not _has_js_export(no_cs, "bindHoldControl"):
      s3a_issues.append("touch_bind.js missing export bindHoldControl")

    body_cs, body_c = _find_function_body(no_cs, no_c, "bindHudTouchAction")
    if not body_cs:
      s3a_issues.append("could not parse bindHudTouchAction function body")
    else:
      if not re.search(r"addEventListener\s*\(\s*['\"]pointerdown['\"]", body_c):
        s3a_issues.append("bindHudTouchAction missing pointerdown listener")
      if not re.search(r"addEventListener\s*\(\s*['\"]click['\"]", body_c):
        s3a_issues.append("bindHudTouchAction missing click swallow listener")
      tb_clocks = _find_local_clock_helpers(no_cs, no_c)
      timer_hits = G3_TIMERS_RE.findall(body_cs)
      if tb_clocks:
        clk_pat = re.compile(r"\b(?:" + "|".join(re.escape(h) for h in sorted(tb_clocks)) + r")\s*\(")
        timer_hits.extend(clk_pat.findall(body_cs))
      if timer_hits:
        s3a_issues.append(f"bindHudTouchAction contains forbidden timer APIs: {timer_hits}")

  # Scan src/ui/**/*.js, src/core/touch_bind.js, src/main.js for timer-based click dedup.
  scan_files: list[Path] = []
  ui_dir = root / "src/ui"
  if ui_dir.is_dir():
    scan_files.extend(sorted(p for p in ui_dir.rglob("*.js") if p.is_file()))
  for extra in (root / "src/core/touch_bind.js", root / "src/main.js"):
    if extra.is_file() and extra not in scan_files:
      scan_files.append(extra)

  dedup_offenders: list[str] = []
  raw_click_offenders: list[str] = []
  bind_hud_callers: list[str] = []

  for path in scan_files:
    rel = path.relative_to(root).as_posix()
    raw = path.read_text(encoding="utf-8", errors="replace")
    no_c = strip_js(raw, strip_strings=False)
    no_cs = strip_js(raw, strip_strings=True)

    if rel != "src/core/touch_bind.js" and re.search(r"\bbindHudTouchAction\s*\(", no_cs):
      bind_hud_callers.append(rel)

    local_clocks = _find_local_clock_helpers(no_cs, no_c)
    clock_tokens = ["Date\\.now", "performance\\.now", "nowMs"] + [
        re.escape(h) for h in sorted(local_clocks)
    ]
    file_clock_re = re.compile(r"\b(?:" + "|".join(clock_tokens) + r")\s*\(")

    for m in G3_TIMER_DEDUP_RE.finditer(no_cs):
      dedup_offenders.append(f"{rel}:{line_of(raw, m.start())}: timer dedup '{m.group(0).strip()}'")
    for m in G3_TWO_LINE_DEDUP_RE.finditer(no_cs):
      dedup_offenders.append(
          f"{rel}:{line_of(raw, m.start())}: two-line timer dedup"
      )

    # Zero clock reads inside any 'click' listener (inline OR named identifier) or .onclick/onClick handler.
    for m in re.finditer(r"addEventListener\s*\(\s*['\"]click['\"]\s*,", no_c):
      body_cs, _ = _find_callable_body(no_cs, no_c, m.end())
      if not body_cs:
        m_id = re.match(r"\s*([a-zA-Z_$]\w*)\b", no_cs[m.end() :])
        if m_id:
          body_cs, _ = _find_function_body_near(no_cs, no_c, m_id.group(1), m.start())
      if body_cs and file_clock_re.search(body_cs):
        dedup_offenders.append(
            f"{rel}:{line_of(raw, m.start())}: clock call inside click listener"
        )
    for m in re.finditer(r"(?:function\s+onClick\b|(?:const|let|var)\s+onClick\s*=)", no_cs):
      body_cs, _ = _find_callable_body(no_cs, no_c, m.end())
      if body_cs and file_clock_re.search(body_cs):
        dedup_offenders.append(
            f"{rel}:{line_of(raw, m.start())}: clock call inside onClick handler"
        )
    for m in re.finditer(r"\.onclick\s*=", no_cs):
      body_cs, _ = _find_callable_body(no_cs, no_c, m.end())
      if not body_cs:
        m_id = re.match(r"\s*([a-zA-Z_$]\w*)\b", no_cs[m.end() :])
        if m_id:
          body_cs, _ = _find_function_body_near(no_cs, no_c, m_id.group(1), m.start())
      if body_cs and file_clock_re.search(body_cs):
        dedup_offenders.append(
            f"{rel}:{line_of(raw, m.start())}: clock call inside .onclick handler"
        )

    # Zero setTimeout click-suppression latches inside pointerdown/pointerup handlers.
    for m in re.finditer(r"addEventListener\s*\(\s*['\"]pointer(?:down|up)['\"]\s*,", no_c):
      body_cs, _ = _find_callable_body(no_cs, no_c, m.end())
      if not body_cs:
        m_id = re.match(r"\s*([a-zA-Z_$]\w*)\b", no_cs[m.end() :])
        if m_id:
          body_cs, _ = _find_function_body_near(no_cs, no_c, m_id.group(1), m.start())
      if body_cs and G3_TIMEOUT_LATCH_RE.search(body_cs):
        dedup_offenders.append(
            f"{rel}:{line_of(raw, m.start())}: setTimeout click-latch inside pointer handler"
        )

    # Raw click listeners and .onclick assignments in src/ui/**/*.js bypass touch_bind.js.
    if rel.startswith("src/ui/"):
      for m in re.finditer(r"addEventListener\s*\(\s*['\"]click['\"]", no_c):
        raw_click_offenders.append(
            f"{rel}:{line_of(raw, m.start())}: raw addEventListener('click') in src/ui/"
        )
      for m in re.finditer(r"\.onclick\s*=", no_cs):
        raw_click_offenders.append(
            f"{rel}:{line_of(raw, m.start())}: raw .onclick assignment in src/ui/"
        )

  if not bind_hud_callers:
    s3a_issues.append("bindHudTouchAction() is never called from src/ui/ or src/main.js")

  passed = not s3a_issues and not dedup_offenders and not raw_click_offenders
  return {
      "id": "S3_G3_TIMER_FREE_HUD_TOUCH",
      "phase": "static",
      "guardrail": "G3",
      "passed": passed,
      "details": {
          "touchBindIssues": s3a_issues,
          "timerDedupOffenders": dedup_offenders,
          "rawUiClickOffenders": raw_click_offenders,
          "bindHudCallers": bind_hud_callers,
      },
  }


def check_s4_modal_backdrop_guard_static(root: Path) -> dict[str, Any]:
  tb_path = root / "src/core/touch_bind.js"
  issues: list[str] = []
  guard_ms_val: float | None = None

  if not tb_path.is_file():
    issues.append("missing src/core/touch_bind.js")
  else:
    raw = tb_path.read_text(encoding="utf-8", errors="replace")
    no_c = strip_js(raw, strip_strings=False)
    no_cs = strip_js(raw, strip_strings=True)

    m_ms = re.search(
        r"\b(?:export\s+)?const\s+MODAL_BACKDROP_GUARD_MS\s*=\s*([0-9]+(?:\.[0-9]+)?)",
        no_cs,
    )
    if not m_ms or not _has_js_export(no_cs, "MODAL_BACKDROP_GUARD_MS"):
      issues.append("touch_bind.js missing export const MODAL_BACKDROP_GUARD_MS")
    else:
      guard_ms_val = float(m_ms.group(1))
      if guard_ms_val < 450.0:
        issues.append(f"MODAL_BACKDROP_GUARD_MS={guard_ms_val} < 450")

    if not _has_js_export(no_cs, "bindModalBackdropDismiss"):
      issues.append("touch_bind.js missing export bindModalBackdropDismiss")
    else:
      decl_and_body_cs, body_cs, body_c = _find_function_decl_and_body(
          no_cs, no_c, "bindModalBackdropDismiss"
      )
      if not body_cs:
        issues.append("could not parse bindModalBackdropDismiss body")
      else:
        if not re.search(r"addEventListener\s*\(\s*['\"]pointerdown['\"]", body_c):
          issues.append("bindModalBackdropDismiss missing pointerdown listener")
        if not re.search(r"\.target\s*[!=]==?\s*\w+|\w+\s*[!=]==?\s*\w+\.target\b", body_cs):
          issues.append("bindModalBackdropDismiss missing event.target backdrop identity check")
        if not re.search(r"\b(?:performance\.now|Date\.now)\s*\(", body_cs):
          issues.append("bindModalBackdropDismiss missing elapsed time check")
        if not re.search(r"\bMODAL_BACKDROP_GUARD_MS\b|\b(?:4[5-9]\d|[5-9]\d\d)\b", decl_and_body_cs):
          issues.append("bindModalBackdropDismiss missing >= 450 ms threshold comparison")
        if not re.search(r"addEventListener\s*\(\s*['\"]click['\"]", body_c):
          issues.append("bindModalBackdropDismiss missing trailing click swallow")

  # Check modal controller files.
  modal_files: list[Path] = []
  ui_dir = root / "src/ui"
  if ui_dir.is_dir():
    modal_files = sorted(p for p in ui_dir.glob("*modal*.js") if p.is_file())

  modal_callers: list[str] = []
  if modal_files:
    for mf in modal_files:
      rel = mf.relative_to(root).as_posix()
      m_cs = strip_js(mf.read_text(encoding="utf-8", errors="replace"), strip_strings=True)
      if not re.search(r"\bbindModalBackdropDismiss\s*\(", m_cs):
        issues.append(f"{rel} does not call bindModalBackdropDismiss()")
      else:
        modal_callers.append(rel)
      if not re.search(r"\b(?:performance\.now|Date\.now)\s*\(|\bgetOpenedAt\b", m_cs):
        issues.append(f"{rel} neither records modal open timestamp nor wires getOpenedAt")
  else:
    # Fallback: check across src/**/*.js if modals are defined in main.js/ui.
    call_count = 0
    for jf in _collect_src_js(root):
      rel = jf.relative_to(root).as_posix()
      if rel == "src/core/touch_bind.js":
        continue
      c = len(
          re.findall(
              r"\bbindModalBackdropDismiss\s*\(",
              strip_js(jf.read_text(encoding="utf-8", errors="replace"), strip_strings=True),
          )
      )
      if c > 0:
        call_count += c
        modal_callers.append(f"{rel}({c})")
    if call_count < 2:
      issues.append(f"expected >= 2 bindModalBackdropDismiss() calls across modals, found {call_count}")

  return {
      "id": "S4_G4_MODAL_BACKDROP_GUARD_STATIC",
      "phase": "static",
      "guardrail": "G4",
      "passed": not issues,
      "details": {
          "guardMs": guard_ms_val,
          "modalCallers": modal_callers,
          "issues": issues,
      },
  }


class _HtmlAssetParser(html.parser.HTMLParser):
  """Extracts asset attributes, favicon links, viewport meta, importmaps, inline CSS."""

  _ASSET_TAGS = frozenset({
      "script", "link", "img", "audio", "video", "source", "iframe", "object",
  })
  _ASSET_ATTRS = frozenset({"src", "href", "poster", "data", "srcset"})

  def __init__(self) -> None:
    super().__init__(convert_charrefs=True)
    self.assets: list[tuple[int, str, str, str]] = []
    self.has_svg_favicon: bool = False
    self.viewport_content: str = ""
    self.has_importmap: bool = False
    self.inline_styles: list[tuple[int, str]] = []
    self._in_style: bool = False
    self._style_buf: list[str] = []
    self._style_line: int = 1

  def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
    t = tag.lower()
    line = self.getpos()[0]
    attr_map = {k.lower(): (v or "") for k, v in attrs}

    if t == "style":
      self._in_style = True
      self._style_buf = []
      self._style_line = line
      return

    if t == "script" and attr_map.get("type", "").strip().lower() == "importmap":
      self.has_importmap = True

    if t == "meta" and attr_map.get("name", "").strip().lower() == "viewport":
      self.viewport_content = attr_map.get("content", "")

    if t == "link":
      rels = attr_map.get("rel", "").lower().split()
      href = attr_map.get("href", "").strip()
      if "icon" in rels and re.match(r"^data:image/svg\+xml(?:;[^,]*)?,", href, re.IGNORECASE):
        self.has_svg_favicon = True

    if t in self._ASSET_TAGS:
      for k, v in attr_map.items():
        if k in self._ASSET_ATTRS and v.strip():
          if k == "srcset":
            for entry in v.split(","):
              url_part = entry.strip().split()[0] if entry.strip() else ""
              if url_part:
                self.assets.append((line, t, k, url_part))
          else:
            self.assets.append((line, t, k, v.strip()))

  def handle_data(self, data: str) -> None:
    if self._in_style:
      self._style_buf.append(data)

  def handle_endtag(self, tag: str) -> None:
    if tag.lower() == "style" and self._in_style:
      self._in_style = False
      self.inline_styles.append((self._style_line, "".join(self._style_buf)))


def _check_asset_url(
    url: str,
    base_dir: Path,
    root: Path,
    location: str,
    issues: list[str],
    *,
    require_exists: bool = True,
) -> None:
  u = url.strip()
  if not u or u.startswith("#"):
    return
  low = u.lower()
  if low.startswith(("data:", "blob:")):
    return
  if low.startswith(("http://", "https://", "//")):
    issues.append(f"{location}: external URL forbidden ({u})")
    return
  if u.startswith("/"):
    issues.append(f"{location}: root-absolute path breaks GitHub Pages subpath ({u})")
    return
  if require_exists:
    clean = u.split("#", 1)[0].split("?", 1)[0]
    if clean:
      target = (base_dir / clean).resolve()
      try:
        target.relative_to(root.resolve())
      except ValueError:
        issues.append(f"{location}: path escapes repo root ({u})")
        return
      if not target.exists():
        issues.append(f"{location}: referenced local asset missing ({u})")


def _scan_css_urls(
    css_text: str,
    base_dir: Path,
    root: Path,
    rel_label: str,
    issues: list[str],
    line_offset: int = 0,
) -> None:
  cleaned = strip_css_comments(css_text)
  for pat in (
      re.compile(r"@import\s+(?:url\(\s*)?['\"]?([^'\")\s]+)", re.IGNORECASE),
      re.compile(r"url\(\s*['\"]?([^'\")\s]+)", re.IGNORECASE),
  ):
    for m in pat.finditer(cleaned):
      ln = line_of(cleaned, m.start()) + line_offset
      _check_asset_url(m.group(1), base_dir, root, f"{rel_label}:{ln}", issues)
  for m in KNOWN_CDN_RE.finditer(cleaned):
    ln = line_of(cleaned, m.start()) + line_offset
    issues.append(f"{rel_label}:{ln}: known CDN hostname ({m.group(0)})")


def check_s5_offline_packaging_static(root: Path) -> dict[str, Any]:
  issues: list[str] = []

  # S5a: Root packaging files.
  nojekyll = root / ".nojekyll"
  if not nojekyll.is_file():
    issues.append("missing .nojekyll in repo root")
  vendor_three = root / "vendor/three.module.min.js"
  if not vendor_three.is_file():
    issues.append("missing vendor/three.module.min.js")
  elif vendor_three.stat().st_size < 100_000:
    issues.append(
        f"vendor/three.module.min.js unexpectedly small ({vendor_three.stat().st_size} bytes < 100000)"
    )

  # S5b: index.html via HTMLParser.
  index_html = root / "index.html"
  if not index_html.is_file():
    issues.append("missing index.html")
  else:
    raw_html = index_html.read_text(encoding="utf-8", errors="replace")
    clean_html = strip_html_comments(raw_html)
    parser = _HtmlAssetParser()
    parser.feed(clean_html)
    if not parser.has_svg_favicon:
      issues.append("index.html missing inline data:image/svg+xml favicon <link rel='icon'>")
    vp = parser.viewport_content.lower()
    if "viewport-fit=cover" not in vp or "user-scalable=no" not in vp:
      issues.append(
          f"index.html viewport meta must include viewport-fit=cover and user-scalable=no (got {parser.viewport_content!r})"
      )
    if parser.has_importmap:
      issues.append("index.html must not use <script type='importmap'>")
    for ln, tag, attr, val in parser.assets:
      _check_asset_url(val, root, root, f"index.html:{ln} <{tag} {attr}>", issues)
    for ln, css_body in parser.inline_styles:
      _scan_css_urls(css_body, root, root, "index.html<style>", issues, line_offset=ln - 1)
    for m in KNOWN_CDN_RE.finditer(clean_html):
      issues.append(f"index.html:{line_of(clean_html, m.start())}: known CDN hostname ({m.group(0)})")

  # S5c: styles/**/*.css.
  styles_dir = root / "styles"
  if styles_dir.is_dir():
    for css_path in sorted(p for p in styles_dir.rglob("*.css") if p.is_file()):
      rel = css_path.relative_to(root).as_posix()
      _scan_css_urls(
          css_path.read_text(encoding="utf-8", errors="replace"),
          css_path.parent,
          root,
          rel,
          issues,
      )

  # S5d: src/**/*.js (match syntax on string-stripped no_cs, extract specifier from no_c
  # so prose strings like `"export replay from '/lab'"` never false-positive).
  js_url_pats = [
      re.compile(r"(?:^|[;\n])[ \t]*import[ \t]+(['\"])([^'\"]*)\1"),
      re.compile(r"(?:^|[;\n])[ \t]*(?:import|export)\b[^'\";]*?\bfrom[ \t]+(['\"])([^'\"]*)\1"),
      re.compile(r"\bimport\s*\(\s*(['\"])([^'\"]*)\1\s*\)"),
      re.compile(r"\bfetch\s*\(\s*(['\"])([^'\"]*)\1"),
      re.compile(r"\bnew\s+(?:Audio|Worker|SharedWorker)\s*\(\s*(['\"])([^'\"]*)\1"),
      re.compile(r"\.src\s*=\s*(['\"])([^'\"]*)\1"),
  ]
  for js_path in _collect_src_js(root):
    rel = js_path.relative_to(root).as_posix()
    raw = js_path.read_text(encoding="utf-8", errors="replace")
    no_c = strip_js(raw, strip_strings=False)
    no_cs = strip_js(raw, strip_strings=True)
    for pat in js_url_pats:
      for m in pat.finditer(no_cs):
        spec = no_c[m.start(2) : m.end(2)]
        ln = line_of(raw, m.start())
        req_exists = spec.startswith(("./", "../"))
        _check_asset_url(
            spec,
            js_path.parent,
            root,
            f"{rel}:{ln}",
            issues,
            require_exists=req_exists,
        )
    for m in KNOWN_CDN_RE.finditer(no_c):
      issues.append(f"{rel}:{line_of(raw, m.start())}: known CDN hostname ({m.group(0)})")

  return {
      "id": "S5_ZERO_CDN_RELATIVE_PATHS_PACKAGING",
      "phase": "static",
      "guardrail": "R3/Hygiene",
      "passed": not issues,
      "details": {"issues": issues},
  }


def _build_secret_patterns() -> list[tuple[str, re.Pattern[str]]]:
  # Constructed cleanly so this audit file never contains raw secret prefixes.
  gh_prefixes = "|".join(("gh" + "p", "gh" + "o", "gh" + "u", "gh" + "s", "gh" + "r"))
  gh_pat_prefix = "github_" + "pat_"
  return [
      ("github_token", re.compile(rf"\b(?:{gh_prefixes})_[A-Za-z0-9_]{{20,}}\b")),
      ("github_pat", re.compile(rf"\b{gh_pat_prefix}[A-Za-z0-9_]{{20,}}\b")),
      ("github_auth_url", re.compile(r"https?://[^/\s:@]+:[^/\s@]+@github\.com")),
      ("x_access_token", re.compile(r"\bx-access-token\s*:", re.IGNORECASE)),
      ("basic_auth", re.compile(r"AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=]{12,}", re.IGNORECASE)),
      ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
      ("oauth_token", re.compile(r"\boauth_token\s*[:=]\s*['\"]?[A-Za-z0-9_]{20,}")),
  ]


def _build_corp_path_patterns() -> list[tuple[str, re.Pattern[str]]]:
  p1 = "/usr/local/" + "google/home/"
  p2 = "/google/src/" + "cloud/"
  p3 = "@" + "google\\.com\\b"
  p4 = "\\.corp\\." + "google\\.com\\b"
  return [
      ("local_home_path", re.compile(re.escape(p1) + r"[a-zA-Z0-9._-]+")),
      ("citc_path", re.compile(re.escape(p2) + r"[a-zA-Z0-9._-]+")),
      ("corp_email", re.compile(r"[a-zA-Z0-9._%+-]+" + p3, re.IGNORECASE)),
      ("corp_domain", re.compile(p4, re.IGNORECASE)),
  ]


def check_s6_privacy_and_credentials(
    root: Path,
    blocklist_file: str | Path | None = None,
) -> dict[str, Any]:
  secret_pats = _build_secret_patterns()
  corp_pats = _build_corp_path_patterns()
  issues: list[str] = []

  # Collect text files to scan (skipping vendor/three.module.min.js, .git/objects, __pycache__, binaries).
  text_exts = {".html", ".htm", ".css", ".js", ".mjs", ".py", ".md", ".json", ".txt", ".yml", ".yaml"}
  binary_exts = {
      ".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".bmp",
      ".wasm", ".bin", ".zip", ".gz", ".mp3", ".mp4", ".ogg", ".wav",
      ".ttf", ".woff", ".woff2", ".pdf",
  }
  scan_targets: list[Path] = []
  for p in sorted(root.iterdir()):
    if not p.is_file():
      continue
    if p.suffix.lower() in binary_exts:
      continue
    try:
      head = p.read_bytes()[:4096]
    except OSError:
      continue
    if b"\x00" in head:
      continue
    scan_targets.append(p)
  for sub in ("styles", "src", "tests"):
    d = root / sub
    if d.is_dir():
      for p in sorted(d.rglob("*")):
        if not p.is_file():
          continue
        if "__pycache__" in p.parts:
          continue
        if p.suffix.lower() in text_exts:
          scan_targets.append(p)

  blocklist_patterns: list[tuple[int, re.Pattern[str]]] = []
  bl_path = blocklist_file if blocklist_file is not None else os.environ.get("PRIVACY_BLOCKLIST_FILE")
  if bl_path:
    bp = Path(bl_path)
    if not bp.is_file():
      issues.append(f"privacy blocklist file not found: {bp}")
    else:
      idx = 0
      for raw_line in bp.read_text(encoding="utf-8", errors="replace").splitlines():
        term = raw_line.strip()
        if not term or term.startswith("#"):
          continue
        idx += 1
        left_b = r"\b" if (term[0].isascii() and (term[0].isalnum() or term[0] == "_")) else ""
        right_b = r"\b" if (term[-1].isascii() and (term[-1].isalnum() or term[-1] == "_")) else ""
        blocklist_patterns.append(
            (idx, re.compile(f"{left_b}{re.escape(term)}{right_b}", re.IGNORECASE))
        )

  for path in scan_targets:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="replace")
    for label, pat in secret_pats:
      for m in pat.finditer(text):
        issues.append(f"{rel}:{line_of(text, m.start())}: secret pattern matched ({label})")
    for label, pat in corp_pats:
      for m in pat.finditer(text):
        issues.append(f"{rel}:{line_of(text, m.start())}: internal path/email leak ({label})")
    for entry_idx, pat in blocklist_patterns:
      for m in pat.finditer(text):
        # Never log matched literal text!
        issues.append(f"{rel}:{line_of(text, m.start())}: matched blocklist entry #{entry_idx}")

  # Check .git/config and recent git commits if this is a git repo.
  git_config = root / ".git/config"
  git_checked = False
  if git_config.is_file():
    git_checked = True
    cfg_text = git_config.read_text(encoding="utf-8", errors="replace")
    if re.search(r"://[^/\s]+@github\.com", cfg_text, re.IGNORECASE):
      issues.append(".git/config: embedded credentials in github.com remote URL")
    if re.search(r"\bextraheader\b", cfg_text, re.IGNORECASE):
      issues.append(".git/config: suspicious http.extraheader present")
    for label, pat in secret_pats:
      if pat.search(cfg_text):
        issues.append(f".git/config: secret pattern matched ({label})")
    try:
      proc = subprocess.run(
          ["git", "-C", str(root), "log", "-n", "50", "--format=%an <%ae>"],
          capture_output=True,
          text=True,
          timeout=5.0,
          check=False,
      )
      if proc.returncode == 0:
        corp_email_pat = corp_pats[2][1]
        for line in proc.stdout.splitlines():
          if corp_email_pat.search(line):
            issues.append("git log: internal corporate email found in commit author")
            break
    except Exception:
      pass

  return {
      "id": "S6_PRIVACY_AND_CREDENTIAL_HYGIENE",
      "phase": "static",
      "guardrail": "R3/Privacy",
      "passed": not issues,
      "details": {
          "filesScanned": len(scan_targets),
          "gitConfigChecked": git_checked,
          "blocklistEntries": len(blocklist_patterns),
          "issues": issues,
      },
  }


# ---------------------------------------------------------------------------
# Runtime Audit Checks (R1 - R5)
# ---------------------------------------------------------------------------

def _get_state(sess: cdp.CdpSession) -> dict[str, Any]:
  return sess.eval_js("window.__ROBLOX_CAR_CRASH__.getState()", await_promise=False) or {}


def _get_material_audit(sess: cdp.CdpSession) -> dict[str, Any]:
  return sess.eval_js("window.__ROBLOX_CAR_CRASH__.getMaterialAudit()", await_promise=False) or {}


def _close_any_modal(sess: cdp.CdpSession) -> None:
  for _ in range(3):
    st = _get_state(sess)
    active = st.get("activeModal")
    if not active:
      return
    close_sel = "#btn-garage-close" if active == "garage" else "#btn-teleport-close"
    info = sess.locate_selector(close_sel, timeout_s=0.3)
    if info.get("found"):
      sess.touch_tap(info["x"], info["y"], hold_ms=20)
      sess.wait_raf(2)
    else:
      # Fallback: try both close buttons.
      for sel in ("#btn-garage-close", "#btn-teleport-close"):
        inf = sess.locate_selector(sel, timeout_s=0.1)
        if inf.get("found"):
          sess.touch_tap(inf["x"], inf["y"], hold_ms=20)
          sess.wait_raf(2)


def _action_count_deltas(before: dict[str, Any], after: dict[str, Any]) -> dict[str, int]:
  deltas: dict[str, int] = {}
  keys = set(before.keys()) | set(after.keys())
  for k in keys:
    d = int(after.get(k, 0)) - int(before.get(k, 0))
    if d != 0:
      deltas[str(k)] = d
  return deltas


def check_r1_runtime_no_pre_raf_compile(sess: cdp.CdpSession) -> dict[str, Any]:
  spy = sess.get_preboot_spy()
  state = _get_state(sess)
  issues: list[str] = []

  if not spy:
    issues.append("window.__PREBOOT_SPY__ missing")
  else:
    if not spy.get("firstRafStarted"):
      issues.append("firstRafStarted is False")
    if not spy.get("firstRafDone"):
      issues.append("firstRafDone is False")
    if int(spy.get("rafCount", 0)) < 2:
      issues.append(f"rafCount={spy.get('rafCount')} < 2")
    if int(spy.get("preRafCompileShaders", 0)) != 0:
      issues.append(f"preRafCompileShaders={spy.get('preRafCompileShaders')} != 0")
    if int(spy.get("preRafLinkPrograms", 0)) != 0:
      issues.append(
          f"preRafLinkPrograms={spy.get('preRafLinkPrograms')} != 0 "
          f"(stacks={spy.get('preRafLinkStacks', [])[:1]})"
      )
    if int(spy.get("preRafDraws", 0)) != 0:
      issues.append(f"preRafDraws={spy.get('preRafDraws')} != 0")
    if spy.get("compileMethodHits"):
      issues.append(f"compileMethodHits non-empty: {spy.get('compileMethodHits')[:2]}")
    if int(spy.get("totalCompileShaders", 0)) <= 0:
      issues.append("totalCompileShaders == 0 (vacuous WebGL2 render check failed)")
    if int(spy.get("totalLinkPrograms", 0)) <= 0:
      issues.append("totalLinkPrograms == 0 (vacuous WebGL2 render check failed)")

  if not state.get("firstRafDone"):
    issues.append("seam state.firstRafDone is not True")
  if bool(state.get("compileBeforeFirstRaf")):
    issues.append(f"seam state.compileBeforeFirstRaf={state.get('compileBeforeFirstRaf')!r}")
  if int(state.get("frameCount", 0)) < 1:
    issues.append(f"seam state.frameCount={state.get('frameCount')} < 1")

  return {
      "id": "R1_G1_RUNTIME_NO_PRE_RAF_COMPILE",
      "phase": "runtime",
      "guardrail": "G1",
      "passed": not issues,
      "details": {
          "spy": {
              "firstRafStarted": spy.get("firstRafStarted"),
              "firstRafDone": spy.get("firstRafDone"),
              "rafCount": spy.get("rafCount"),
              "preRafCompileShaders": spy.get("preRafCompileShaders"),
              "preRafLinkPrograms": spy.get("preRafLinkPrograms"),
              "preRafDraws": spy.get("preRafDraws"),
              "totalCompileShaders": spy.get("totalCompileShaders"),
              "totalLinkPrograms": spy.get("totalLinkPrograms"),
              "compileMethodHits": len(spy.get("compileMethodHits") or []),
          },
          "seam": {
              "firstRafDone": state.get("firstRafDone"),
              "compileBeforeFirstRaf": state.get("compileBeforeFirstRaf"),
              "frameCount": state.get("frameCount"),
          },
          "issues": issues,
      },
  }


def _check_material_audit_sample(
    audit: dict[str, Any],
    label: str,
    issues: list[str],
) -> float:
  if not isinstance(audit, dict):
    issues.append(f"{label}: getMaterialAudit() returned non-dict")
    return 99.0
  checked = int(audit.get("checked", 0))
  max_m = float(audit.get("maxMetalness", 99.0))
  offenders = audit.get("offenders") or []
  has_env = bool(audit.get("hasEnvironment", False))
  if checked <= 0:
    issues.append(f"{label}: checked={checked} <= 0")
  if not has_env:
    if max_m > 0.22:
      issues.append(f"{label}: maxMetalness={max_m} > 0.22 without environment")
    if offenders:
      issues.append(f"{label}: offenders={offenders[:3]}")
  return max_m


def _select_vehicle_in_garage(sess: cdp.CdpSession, vid: str) -> bool:
  _close_any_modal(sess)
  sess.touch_tap_selector("#btn-garage", timeout_s=3.0)
  sess.wait_for("window.__ROBLOX_CAR_CRASH__.getState().activeModal === 'garage'", timeout_s=3.0)
  sess.wait_raf(2)

  sel = f'#modal-garage [data-vehicle-id="{vid}"]'
  info = sess.locate_selector(sel, timeout_s=2.0, scroll_if_needed=True)
  if not info.get("found"):
    return False
  sess.wait_raf(1)

  # Inspect enabled nested action buttons inside card (prioritizing TRY/SPAWN/DRIVE/SELECT over BUY).
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
      pt = sess.eval_js(
          f"""(() => {{
            const card = document.querySelector('#modal-garage [data-vehicle-id=' + {vid_json} + ']');
            const b = card ? card.querySelector('[data-e2e-cand-idx="{int(idx)}"]') : null;
            if (!b) return {{ found: false }};
            try {{ b.scrollIntoView({{ block: 'center', inline: 'nearest', behavior: 'instant' }}); }} catch (_) {{}}
            return {{ found: true }};
          }})()""",
          await_promise=False,
      ) or {"found": False}
      if not pt.get("found"):
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
        sess.touch_tap(coords["x"], coords["y"], hold_ms=20)
        sess.wait_raf(2)
        if _get_state(sess).get("vehicleId") == vid:
          break
  else:
    info = sess.locate_selector(sel, timeout_s=1.0, scroll_if_needed=False)
    if info.get("found"):
      sess.touch_tap(info["x"], info["y"], hold_ms=20)
      sess.wait_raf(2)

  # Cleanup temporary candidate tags and check modal-level spawn/try footer fallback if still not selected.
  if _get_state(sess).get("vehicleId") != vid:
    footer_pts = sess.eval_js(
        f"""(() => {{
          const isDisabled = (el) => Boolean(
            el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('is-disabled')
          );
          const out = [];
          for (const extra of ['[data-vehicle-try=' + {vid_json} + ']', '.btn-try', '.btn-spawn', '#btn-garage-spawn']) {{
            const requireModalLevel = (extra === '.btn-try' || extra === '.btn-spawn');
            let el = null;
            for (const cand of Array.from(document.querySelectorAll('#modal-garage ' + extra))) {{
              if (isDisabled(cand)) continue;
              if (requireModalLevel && cand.closest('[data-vehicle-id]')) continue;
              el = cand;
              break;
            }}
            if (!el) continue;
            try {{ el.scrollIntoView({{ block: 'center', inline: 'nearest', behavior: 'instant' }}); }} catch (_) {{}}
            const r = el.getBoundingClientRect();
            if (r.width > 1 && r.height > 1) {{
              out.push({{ x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }});
            }}
          }}
          return out;
        }})()""",
        await_promise=False,
    ) or []
    for fpt in footer_pts:
      sess.touch_tap(fpt["x"], fpt["y"], hold_ms=20)
      sess.wait_raf(2)
      if _get_state(sess).get("vehicleId") == vid:
        break

  # Last-resort fallback: tap card center directly if nested buttons didn't change vehicleId.
  if _get_state(sess).get("vehicleId") != vid and candidates:
    info = sess.locate_selector(sel, timeout_s=0.5, scroll_if_needed=True)
    if info.get("found"):
      sess.wait_raf(1)
      info = sess.locate_selector(sel, timeout_s=0.5, scroll_if_needed=False)
      sess.touch_tap(info["x"], info["y"], hold_ms=20)
      sess.wait_raf(2)

  sess.eval_js(
      "document.querySelectorAll('#modal-garage [data-e2e-cand-idx]').forEach((el) => el.removeAttribute('data-e2e-cand-idx')); true;",
      await_promise=False,
  )

  _close_any_modal(sess)
  sess.wait_raf(2)
  return _get_state(sess).get("vehicleId") == vid


def _select_zone_in_teleport(sess: cdp.CdpSession, zid: str) -> bool:
  _close_any_modal(sess)
  sess.touch_tap_selector("#btn-teleport", timeout_s=3.0)
  sess.wait_for("window.__ROBLOX_CAR_CRASH__.getState().activeModal === 'teleport'", timeout_s=3.0)
  sess.wait_raf(2)

  sel = f'#modal-teleport [data-zone-id="{zid}"]'
  info = sess.locate_selector(sel, timeout_s=0.3, scroll_if_needed=True)
  if not info.get("found"):
    cats = sess.eval_js(
        """Array.from(document.querySelectorAll('#modal-teleport [data-zone-cat]'))
           .map((el) => el.getAttribute('data-zone-cat')).filter(Boolean)""",
        await_promise=False,
    ) or []
    for cat in cats:
      cat_sel = f'#modal-teleport [data-zone-cat="{cat}"]'
      cinfo = sess.locate_selector(cat_sel, timeout_s=0.5, scroll_if_needed=True)
      if cinfo.get("found"):
        sess.touch_tap(cinfo["x"], cinfo["y"], hold_ms=20)
        sess.wait_raf(2)
        info = sess.locate_selector(sel, timeout_s=0.3, scroll_if_needed=True)
        if info.get("found"):
          break

  if not info.get("found"):
    _close_any_modal(sess)
    return False

  sess.wait_raf(1)
  info = sess.locate_selector(sel, timeout_s=1.0, scroll_if_needed=False)
  sess.touch_tap(info["x"], info["y"], hold_ms=20)
  sess.wait_raf(2)
  _close_any_modal(sess)
  return _get_state(sess).get("zoneId") == zid


def check_r2_runtime_metalness_sweep(sess: cdp.CdpSession) -> dict[str, Any]:
  issues: list[str] = []
  global_max = 0.0

  # 1. Title screen audit (before tapping #btn-play).
  m0 = _check_material_audit_sample(_get_material_audit(sess), "title", issues)
  global_max = max(global_max, m0)

  # 2. Tap #btn-play into active gameplay.
  if not _get_state(sess).get("started"):
    sess.touch_tap_selector("#btn-play", timeout_s=5.0)
    sess.wait_for("window.__ROBLOX_CAR_CRASH__.getState().started === true", timeout_s=5.0)
    sess.wait_raf(3)
  if not _get_state(sess).get("started"):
    issues.append("failed to enter active gameplay after tapping #btn-play")

  m1 = _check_material_audit_sample(_get_material_audit(sess), "play_active", issues)
  global_max = max(global_max, m1)

  # 3. Sweep all 12 vehicles via Garage UI.
  audited_vehicles: list[str] = []
  for vid in VEHICLES_12:
    if not _select_vehicle_in_garage(sess, vid):
      issues.append(f"vehicle:{vid}: could not select via #modal-garage")
      continue
    audited_vehicles.append(vid)
    mv = _check_material_audit_sample(_get_material_audit(sess), f"vehicle:{vid}", issues)
    global_max = max(global_max, mv)

  # 4. Sweep all 14 zones via Teleport UI.
  audited_zones: list[str] = []
  for zid in ZONES_14:
    if not _select_zone_in_teleport(sess, zid):
      issues.append(f"zone:{zid}: could not select via #modal-teleport")
      continue
    audited_zones.append(zid)
    mz = _check_material_audit_sample(_get_material_audit(sess), f"zone:{zid}", issues)
    global_max = max(global_max, mz)

  if len(audited_vehicles) != 12:
    issues.append(f"audited_vehicles={len(audited_vehicles)} != 12")
  if len(audited_zones) != 14:
    issues.append(f"audited_zones={len(audited_zones)} != 14")

  # Return cleanly to hub_lab + sedan.
  _select_zone_in_teleport(sess, "hub_lab")
  _select_vehicle_in_garage(sess, "sedan")

  return {
      "id": "R2_G2_RUNTIME_METALNESS_SWEEP",
      "phase": "runtime",
      "guardrail": "G2",
      "passed": not issues,
      "details": {
          "auditedVehicles": len(audited_vehicles),
          "auditedZones": len(audited_zones),
          "globalMaxMetalness": round(global_max, 4),
          "issues": issues,
      },
  }


def check_r3_runtime_hud_touch(sess: cdp.CdpSession) -> dict[str, Any]:
  issues: list[str] = []
  per_button: dict[str, dict[str, Any]] = {}

  for sel in R3_HUD_BUTTONS:
    btn_res: dict[str, Any] = {}
    _close_any_modal(sess)
    sess.wait_raf(2)

    # R3(a): Real CDP touch tap + 250ms wait -> delta === +1.
    info = sess.locate_selector(sel, timeout_s=3.0)
    if not info.get("found") or not info.get("hitTestable"):
      issues.append(f"{sel} R3(a): not visible/hitTestable ({info})")
      per_button[sel] = {"error": "not_found"}
      continue
    before = dict(_get_state(sess).get("hudActionCounts") or {})
    sess.touch_tap(info["x"], info["y"], hold_ms=20)
    time.sleep(0.25)
    after = dict(_get_state(sess).get("hudActionCounts") or {})
    deltas_a = _action_count_deltas(before, after)
    ok_a = (len(deltas_a) == 1 and sum(deltas_a.values()) == 1)
    btn_res["touch_tap_delta"] = deltas_a
    if not ok_a:
      issues.append(f"{sel} R3(a) touch tap expected +1 single action, got {deltas_a}")
    _close_any_modal(sess)
    sess.wait_raf(2)

    # R3(b): Synthetic pointerdown -> pointerup -> 600ms delayed MouseEvent & PointerEvent clicks.
    for cycle_name, ctor_name, detail_val in [
        ("delayed_mouse_click_600ms", "MouseEvent", 1),
        ("delayed_pointer_click_600ms", "PointerEvent", 1),
    ]:
      _close_any_modal(sess)
      sess.wait_raf(1)
      sel_json = json.dumps(sel)
      res_b = sess.eval_js(
          f"""(async () => {{
            const el = document.querySelector({sel_json});
            if (!el) return {{ error: 'missing' }};
            const before = {{ ...(window.__ROBLOX_CAR_CRASH__.getState().hudActionCounts || {{}}) }};
            el.dispatchEvent(new PointerEvent('pointerdown', {{
              bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, pointerId: 91
            }}));
            el.dispatchEvent(new PointerEvent('pointerup', {{
              bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, pointerId: 91
            }}));
            await new Promise((r) => setTimeout(r, 600));
            const Ctor = ({json.dumps(ctor_name)} === 'PointerEvent' && typeof PointerEvent === 'function')
              ? PointerEvent : MouseEvent;
            const opts = {{ bubbles: true, cancelable: true, detail: {int(detail_val)} }};
            if (Ctor === PointerEvent) opts.pointerType = 'touch';
            el.dispatchEvent(new Ctor('click', opts));
            const after = {{ ...(window.__ROBLOX_CAR_CRASH__.getState().hudActionCounts || {{}}) }};
            return {{ before, after }};
          }})()""",
          await_promise=True,
      ) or {}
      deltas_b = _action_count_deltas(res_b.get("before") or {}, res_b.get("after") or {})
      btn_res[cycle_name] = deltas_b
      if not (len(deltas_b) == 1 and sum(deltas_b.values()) == 1):
        issues.append(f"{sel} R3(b) {cycle_name} expected +1, got {deltas_b}")
      _close_any_modal(sess)
      sess.wait_raf(1)

    # Extra Safari touch-click detail: 0 quirk on #btn-repair.
    if sel == "#btn-repair":
      res_b3 = sess.eval_js(
          """(async () => {
            const el = document.querySelector('#btn-repair');
            const before = { ...(window.__ROBLOX_CAR_CRASH__.getState().hudActionCounts || {}) };
            el.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, pointerId: 92
            }));
            el.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, pointerId: 92
            }));
            await new Promise((r) => setTimeout(r, 600));
            el.dispatchEvent(new PointerEvent('click', {
              bubbles: true, cancelable: true, pointerType: 'touch', detail: 0
            }));
            const after = { ...(window.__ROBLOX_CAR_CRASH__.getState().hudActionCounts || {}) };
            return { before, after };
          })()""",
          await_promise=True,
      ) or {}
      deltas_b3 = _action_count_deltas(res_b3.get("before") or {}, res_b3.get("after") or {})
      btn_res["safari_detail0_click_600ms"] = deltas_b3
      if not (len(deltas_b3) == 1 and sum(deltas_b3.values()) == 1):
        issues.append(f"{sel} R3(b3) Safari detail:0 click expected +1, got {deltas_b3}")

    # R3(c): Drag-off pointerdown (no click) -> focus -> real CDP keyboard Enter -> delta === +1.
    _close_any_modal(sess)
    sess.wait_raf(1)
    # Trigger a pointerdown without click to exercise non-sticky latch reset.
    sel_json = json.dumps(sel)
    sess.eval_js(
        f"""(() => {{
          const el = document.querySelector({sel_json});
          if (el) el.dispatchEvent(new PointerEvent('pointerdown', {{
            bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, pointerId: 93
          }}));
        }})()""",
        await_promise=False,
    )
    time.sleep(0.05)
    _close_any_modal(sess)
    sess.wait_raf(1)

    before_c = dict(_get_state(sess).get("hudActionCounts") or {})
    sess.keyboard_press("Enter", selector=sel)
    time.sleep(0.06)
    after_c = dict(_get_state(sess).get("hudActionCounts") or {})
    deltas_c = _action_count_deltas(before_c, after_c)
    btn_res["keyboard_enter_delta"] = deltas_c
    if not (len(deltas_c) == 1 and sum(deltas_c.values()) == 1):
      issues.append(f"{sel} R3(c) keyboard Enter after drag-off expected +1, got {deltas_c}")
    _close_any_modal(sess)
    sess.wait_raf(1)

    per_button[sel] = btn_res

  return {
      "id": "R3_G3_RUNTIME_HUD_TOUCH_NO_DOUBLE_FIRE",
      "phase": "runtime",
      "guardrail": "G3",
      "passed": not issues,
      "details": {
          "buttons": per_button,
          "issues": issues,
      },
  }


def check_r4_runtime_modal_backdrop_guard(sess: cdp.CdpSession) -> dict[str, Any]:
  issues: list[str] = []
  results: dict[str, Any] = {}

  for btn_sel, modal_sel in (
      ("#btn-garage", "#modal-garage"),
      ("#btn-teleport", "#modal-teleport"),
  ):
    modal_res: dict[str, Any] = {}
    probe: dict[str, Any] = {}

    for attempt in range(3):
      _close_any_modal(sess)
      sess.wait_raf(2)

      btn_info = sess.locate_selector(btn_sel, timeout_s=3.0)
      if not btn_info.get("found"):
        issues.append(f"{modal_sel}: trigger button {btn_sel} not found")
        break

      # Anchor t0 immediately AFTER modal becomes open (MutationObserver + bubble
      # microtask fallback) so DOM rendering inside open() before openedAt = performance.now()
      # cannot subtract from elapsed time and shield a buggy < 450 ms guard.
      sess.eval_js(
          f"""(() => {{
            const b = document.querySelector({json.dumps(btn_sel)});
            const m = document.querySelector({json.dumps(modal_sel)});
            window.__G4_T0__ = null;
            if (window.__G4_MO__) {{ try {{ window.__G4_MO__.disconnect(); }} catch (_) {{}} window.__G4_MO__ = null; }}
            const checkOpen = () => {{
              if (!m) return false;
              if (m.hidden || m.getAttribute('aria-hidden') === 'true') return false;
              const cs = getComputedStyle(m);
              return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05;
            }};
            if (m) {{
              const mo = new MutationObserver(() => {{
                if (window.__G4_T0__ === null && checkOpen()) {{
                  window.__G4_T0__ = performance.now();
                  mo.disconnect();
                }}
              }});
              mo.observe(m, {{ attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style'] }});
              window.__G4_MO__ = mo;
            }}
            if (b) {{
              b.addEventListener('pointerdown', () => {{
                queueMicrotask(() => {{
                  if (window.__G4_T0__ === null && checkOpen()) {{
                    window.__G4_T0__ = performance.now();
                  }}
                }});
              }}, {{ capture: false, once: true }});
            }}
          }})()""",
          await_promise=False,
      )
      sess.touch_tap(btn_info["x"], btn_info["y"], hold_ms=15)

      probe = sess.eval_js(
          f"""(async () => {{
            const modal = document.querySelector({json.dumps(modal_sel)});
            if (!modal) return {{ error: 'modal_missing' }};
            const isOpen = () => {{
              if (modal.hidden || modal.getAttribute('aria-hidden') === 'true') return false;
              const cs = getComputedStyle(modal);
              return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05;
            }};
            if (window.__G4_T0__ === null) {{
              for (let k = 0; k < 4 && !isOpen(); k++) {{
                await new Promise((r) => requestAnimationFrame(r));
              }}
              if (window.__G4_T0__ === null && isOpen()) {{
                window.__G4_T0__ = performance.now();
              }}
            }}
            if (window.__G4_MO__) {{ try {{ window.__G4_MO__.disconnect(); }} catch (_) {{}} window.__G4_MO__ = null; }}
            const t0 = typeof window.__G4_T0__ === 'number' ? window.__G4_T0__ : performance.now();
            const findPoints = () => {{
              const vw = window.innerWidth, vh = window.innerHeight;
              const card = modal.querySelector('.modal-card');
              const cr = card ? card.getBoundingClientRect() : null;
              let bx = 10, by = 10, backdropHitOk = false;
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
                  bx = Math.round(cx); by = Math.round(cy); backdropHitOk = true; break;
                }}
              }}
              let ix = cr ? Math.round(cr.left + cr.width * 0.5) : Math.round(vw * 0.5);
              let iy = cr ? Math.round(cr.top + 16) : Math.round(vh * 0.5);
              let innerHitOk = false;
              if (cr && card) {{
                const innerCands = [];
                const titleEl = card.querySelector('.modal-title, h1, h2, h3, .modal-header');
                if (titleEl) {{
                  const tr = titleEl.getBoundingClientRect();
                  if (tr.width > 4 && tr.height > 4) {{
                    innerCands.push([tr.left + tr.width * 0.5, tr.top + tr.height * 0.5]);
                    innerCands.push([tr.left + Math.min(20, tr.width * 0.25), tr.top + tr.height * 0.5]);
                  }}
                }}
                for (const fx of [0.25, 0.40, 0.50, 0.65, 0.80]) {{
                  for (const fy of [10, 18, 28, Math.max(12, cr.height - 12)]) {{
                    innerCands.push([cr.left + cr.width * fx, cr.top + fy]);
                  }}
                }}
                innerCands.push([cr.left + 12, cr.top + cr.height * 0.5]);
                innerCands.push([cr.right - 12, cr.top + cr.height * 0.5]);
                for (const [px, py] of innerCands) {{
                  if (px < cr.left + 2 || px > cr.right - 2 || py < cr.top + 2 || py > cr.bottom - 2) continue;
                  const h = document.elementFromPoint(px, py);
                  if (h && card.contains(h) && !h.closest('button, [role="button"], input, a, select, textarea')) {{
                    ix = Math.round(px); iy = Math.round(py); innerHitOk = true; break;
                  }}
                }}
              }}
              return {{ bx, by, backdropHitOk, ix, iy, innerHitOk }};
            }};
            const waitUntil = async (targetMs) => {{
              while (true) {{
                const elapsed = performance.now() - t0;
                if (elapsed >= targetMs) return Math.round(elapsed * 10) / 10;
                await new Promise((r) => setTimeout(r, Math.max(1, Math.floor(targetMs - elapsed))));
              }}
            }};
            const pts = findPoints();
            const fireBackdropDown = () => modal.dispatchEvent(new PointerEvent('pointerdown', {{
              bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0,
              clientX: pts.bx, clientY: pts.by,
            }}));

            const t100 = await waitUntil(100);
            fireBackdropDown();
            const openAt100 = isOpen();
            const stateModalAt100 = window.__ROBLOX_CAR_CRASH__.getState().activeModal;

            const t430 = await waitUntil(430);
            fireBackdropDown();
            const openAt430 = isOpen();
            const stateModalAt430 = window.__ROBLOX_CAR_CRASH__.getState().activeModal;

            const t485 = await waitUntil(485);
            fireBackdropDown();
            await new Promise((r) => requestAnimationFrame(r));
            const openAt485 = isOpen();
            const stateModalAt485 = window.__ROBLOX_CAR_CRASH__.getState().activeModal;

            return {{
              ...pts,
              t100, openAt100, stateModalAt100,
              t430, openAt430, stateModalAt430,
              t485, openAt485, stateModalAt485,
            }};
          }})()""",
          await_promise=True,
      ) or {}

      # Retry if SwiftShader GC caused t430 to overshoot 446 ms.
      if probe.get("t430", 0) < 446 or attempt == 2:
        break

    modal_res["timing_probe"] = probe
    if probe.get("error"):
      issues.append(f"{modal_sel}: {probe['error']}")
      results[modal_sel] = modal_res
      continue
    if not probe.get("backdropHitOk"):
      issues.append(f"{modal_sel}: backdrop coordinate outside .modal-card not hit-testable")
    if probe.get("t100", 999) >= 446 or not probe.get("openAt100") or not probe.get("stateModalAt100"):
      issues.append(
          f"{modal_sel}: closed early at t+100ms "
          f"(t100={probe.get('t100')}, open={probe.get('openAt100')}, state={probe.get('stateModalAt100')})"
      )
    if probe.get("t430", 999) >= 446 or not probe.get("openAt430") or not probe.get("stateModalAt430"):
      issues.append(
          f"{modal_sel}: closed early at t+430ms (< 450ms guard) "
          f"(t430={probe.get('t430')}, open={probe.get('openAt430')}, state={probe.get('stateModalAt430')})"
      )
    if probe.get("t485", 0) < 480 or probe.get("openAt485") or probe.get("stateModalAt485"):
      issues.append(
          f"{modal_sel}: failed to dismiss at t+485ms (>= 450ms) "
          f"(t485={probe.get('t485')}, open={probe.get('openAt485')}, state={probe.get('stateModalAt485')})"
      )

    # Inner .modal-card non-dismissal at t+600ms + real CDP touch backdrop dismissal.
    _close_any_modal(sess)
    sess.wait_raf(1)
    sess.touch_tap_selector(btn_sel, timeout_s=3.0)
    time.sleep(0.60)

    if not probe.get("innerHitOk"):
      issues.append(f"{modal_sel}: could not find inert hit-testable interior point on .modal-card")
    else:
      sess.touch_tap(probe["ix"], probe["iy"], hold_ms=20)
      sess.wait_raf(2)
      still_open = bool(_get_state(sess).get("activeModal"))
      modal_res["inner_card_600ms_stayed_open"] = still_open
      if not still_open:
        issues.append(f"{modal_sel}: tapping inner .modal-card at t+600ms dismissed modal")

    sess.touch_tap(probe["bx"], probe["by"], hold_ms=20)
    sess.wait_raf(2)
    closed_after_real_tap = not bool(_get_state(sess).get("activeModal"))
    modal_res["real_touch_backdrop_dismissed"] = closed_after_real_tap
    if not closed_after_real_tap:
      issues.append(f"{modal_sel}: real CDP touch on backdrop at t+600ms did not dismiss modal")

    _close_any_modal(sess)
    results[modal_sel] = modal_res

  return {
      "id": "R4_G4_RUNTIME_MODAL_BACKDROP_GUARD",
      "phase": "runtime",
      "guardrail": "G4",
      "passed": not issues,
      "details": {"modals": results, "issues": issues},
  }


def check_r5_zero_404_and_clean_console(
    sess: cdp.CdpSession,
    expected_origin: str,
    live_url: str | None = None,
) -> dict[str, Any]:
  snap = sess.snapshot_telemetry(pump_sec=0.1, allow_favicon_404=False)
  issues: list[str] = []

  if snap["http_errors"]:
    issues.append(f"http_errors={snap['http_errors'][:5]}")
  if snap["server_http_errors"]:
    issues.append(f"server_http_errors={snap['server_http_errors'][:5]}")
  if snap["network_failures"]:
    issues.append(f"network_failures={snap['network_failures'][:5]}")
  if snap["console_errors"]:
    issues.append(f"console_errors={snap['console_errors'][:5]}")
  if snap["exceptions"]:
    issues.append(f"exceptions={snap['exceptions'][:5]}")
  if snap["log_errors"]:
    issues.append(f"log_errors={snap['log_errors'][:5]}")
  if snap["window_errors"]:
    issues.append(f"window_errors={snap['window_errors'][:5]}")

  external_urls: list[str] = []
  for u in snap["requested_urls"]:
    if u.startswith(("data:", "blob:", "about:")):
      continue
    if not u.startswith(expected_origin):
      external_urls.append(u)
  if external_urls:
    issues.append(f"external_origin_requests={external_urls[:5]}")

  if live_url:
    doc_statuses = [
        r["status"] for r in snap["responses"]
        if r.get("type") == "Document" or r.get("url", "").rstrip("/") == live_url.rstrip("/")
    ]
    if 200 not in doc_statuses:
      issues.append(f"live_url initial document did not return HTTP 200 (statuses={doc_statuses})")

  return {
      "id": "R5_ZERO_404_AND_CLEAN_CONSOLE",
      "phase": "runtime",
      "guardrail": "R2/R3",
      "passed": not issues,
      "details": {
          "totalResponses": len(snap["responses"]),
          "httpErrors": len(snap["http_errors"]),
          "serverHttpErrors": len(snap["server_http_errors"]),
          "networkFailures": len(snap["network_failures"]),
          "consoleErrors": len(snap["console_errors"]),
          "exceptions": len(snap["exceptions"]),
          "externalRequests": external_urls[:5],
          "issues": issues,
      },
  }


# ---------------------------------------------------------------------------
# Public Entry Point & CLI
# ---------------------------------------------------------------------------

def run_guardrails_audit(
    *,
    root: str | Path = cdp.DEFAULT_PROJECT_ROOT,
    live_url: str | None = None,
    static_only: bool = False,
    runtime_only: bool = False,
    privacy_blocklist_file: str | Path | None = None,
    url_query: str = "",
) -> dict[str, Any]:
  root_path = Path(root).resolve()
  checks: list[dict[str, Any]] = []
  mode = "live-url" if live_url else ("static-only" if static_only else ("runtime-only" if runtime_only else "local"))

  if not runtime_only and not live_url:
    checks.append(check_s1_no_pre_raf_compile(root_path))
    checks.append(check_s2_metalness_static(root_path))
    checks.append(check_s3_timer_free_hud_touch_static(root_path))
    checks.append(check_s4_modal_backdrop_guard_static(root_path))
    checks.append(check_s5_offline_packaging_static(root_path))
    checks.append(check_s6_privacy_and_credentials(root_path, privacy_blocklist_file))

  if not static_only:
    browser_root = None if live_url else root_path
    with cdp.CdpBrowser(root=browser_root) as browser:
      with browser.new_session(
          width=1180,
          height=820,
          dpr=2.0,
          mobile=True,
          install_preboot_spy=True,
          reuse_initial_tab=True,
      ) as sess:
        if live_url:
          target_url = live_url
          if url_query:
            sep = "&" if "?" in target_url else "?"
            target_url = f"{target_url}{sep}{url_query.lstrip('?')}"
          parsed = urllib.parse.urlsplit(target_url)
          expected_origin = f"{parsed.scheme}://{parsed.netloc}/"
        else:
          q = f"?{url_query.lstrip('?')}" if url_query else ""
          target_url = f"index.html{q}"
          expected_origin = browser.base_url or "http://127.0.0.1/"

        loaded = sess.goto(
            target_url,
            wait_expr="typeof window.__ROBLOX_CAR_CRASH__ === 'object' && window.__ROBLOX_CAR_CRASH__ !== null",
            timeout_s=25.0,
        )
        if not loaded:
          checks.append({
              "id": "R0_PAGE_BOOT",
              "phase": "runtime",
              "guardrail": "Boot",
              "passed": False,
              "details": {
                  "error": f"window.__ROBLOX_CAR_CRASH__ unavailable after navigating to {target_url}",
                  "telemetry": sess.snapshot_telemetry(),
              },
          })
        else:
          sess.wait_raf(3)
          checks.append(check_r1_runtime_no_pre_raf_compile(sess))
          checks.append(check_r2_runtime_metalness_sweep(sess))
          checks.append(check_r3_runtime_hud_touch(sess))
          checks.append(check_r4_runtime_modal_backdrop_guard(sess))
          checks.append(check_r5_zero_404_and_clean_console(sess, expected_origin, live_url=live_url))

  total = len(checks)
  passed_count = sum(1 for c in checks if c["passed"])
  failed_count = total - passed_count
  return {
      "suite": "webkit_guardrails_audit",
      "mode": mode,
      "root": str(root_path),
      "liveUrl": live_url,
      "passed": failed_count == 0 and total > 0,
      "summary": {
          "total": total,
          "passed": passed_count,
          "failed": failed_count,
          "skipped": 0,
      },
      "checks": checks,
  }


def main(argv: list[str] | None = None) -> int:
  ap = argparse.ArgumentParser(
      description="Static + Runtime Safari WebKit Guardrails (1-4) & Asset Hygiene Audit"
  )
  ap.add_argument("--root", default=str(cdp.DEFAULT_PROJECT_ROOT), help="Project root directory")
  ap.add_argument("--live-url", default=None, help="Optional live deployed URL (e.g. GitHub Pages)")
  ap.add_argument("--static-only", action="store_true", help="Run static S1-S6 checks only")
  ap.add_argument("--runtime-only", action="store_true", help="Run runtime R1-R5 checks only")
  ap.add_argument("--privacy-blocklist-file", default=None, help="Optional external blocklist file path")
  ap.add_argument("--url-query", default="", help="Optional query string appended to page URL")
  ap.add_argument("--json-out", default=None, help="Optional path to write JSON report")
  args = ap.parse_args(argv)

  if args.static_only and args.runtime_only:
    print("ERROR: --static-only and --runtime-only are mutually exclusive", file=sys.stderr)
    return 2

  t0 = time.monotonic()
  report = run_guardrails_audit(
      root=args.root,
      live_url=args.live_url,
      static_only=args.static_only,
      runtime_only=args.runtime_only,
      privacy_blocklist_file=args.privacy_blocklist_file,
      url_query=args.url_query,
  )
  elapsed = time.monotonic() - t0
  report["elapsed_s"] = round(elapsed, 2)

  print(f"=== WEBKIT GUARDRAILS AUDIT ({report['mode']}) ===")
  for chk in report["checks"]:
    tag = "PASS" if chk["passed"] else "FAIL"
    extra = ""
    if not chk["passed"]:
      extra = f" -> {json.dumps(chk['details'], ensure_ascii=False)[:320]}"
    print(f"  [{tag}] {chk['id']} ({chk['phase']}/{chk['guardrail']}){extra}")

  s = report["summary"]
  print(
      f"SUMMARY: {s['passed']}/{s['total']} PASS | failed={s['failed']} | elapsed={elapsed:.2f}s"
  )

  if args.json_out:
    out_p = Path(args.json_out)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    out_p.write_text(json.dumps(report, indent=2), encoding="utf-8")

  return 0 if report["passed"] else 1


if __name__ == "__main__":
  raise SystemExit(main())
