/**
 * Procedural Roblox CanvasTexture Library (Contract #8).
 *
 * 100% deterministic offline CanvasTextures (zero external URLs, zero HTTP 404s)
 * tagged with THREE.SRGBColorSpace for Three.js r170, lean 256x256 power-of-two
 * tiled maps (< 4 MB total VRAM), plus cached dynamic generators for industrial
 * signs, RCD license plates, and Ski Jump / livery numbers.
 */

import * as THREE from '../../vendor/three.module.min.js';

const MAX_DYNAMIC_CACHE = 128;

function createRng(initialSeed) {
  let seed = (initialSeed >>> 0) || 1;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function finalizeTexture(canvas, { repeat = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function parseHexLuminance(hex) {
  if (typeof hex !== 'string') return 0.5;
  const clean = hex.trim().replace('#', '');
  let r = 128;
  let g = 128;
  let b = 128;
  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
  } else if (clean.length >= 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return 0.5;
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function buildGrassGrid() {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rng = createRng(101);
  const cell = 64;

  // 4x4 Roblox vibrant green checkerboard squares with crisp bevels
  for (let gy = 0; gy < 4; gy += 1) {
    for (let gx = 0; gx < 4; gx += 1) {
      const light = (gx + gy) % 2 === 0;
      ctx.fillStyle = light ? '#4ec946' : '#3fb838';
      ctx.fillRect(gx * cell, gy * cell, cell, cell);

      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 2;
      ctx.strokeRect(gx * cell + 1, gy * cell + 1, cell - 2, cell - 2);

      ctx.strokeStyle = 'rgba(18,74,20,0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(gx * cell + 0.5, gy * cell + 0.5, cell - 1, cell - 1);
    }
  }

  // Subtle turf grain
  for (let i = 0; i < 420; i += 1) {
    const x = Math.floor(rng() * size);
    const y = Math.floor(rng() * size);
    ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(16,60,16,0.08)';
    ctx.fillRect(x, y, 2, 2);
  }

  // Classic 16x16 raised circular Roblox studs
  const step = 16;
  for (let sy = 0; sy < 16; sy += 1) {
    for (let sx = 0; sx < 16; sx += 1) {
      const cx = sx * step + step * 0.5;
      const cy = sy * step + step * 0.5;

      ctx.beginPath();
      ctx.arc(cx + 0.7, cy + 0.9, 4.1, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(32,115,28,0.34)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(126,240,118,0.28)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx - 0.8, cy - 0.8, 1.4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fill();
    }
  }

  return finalizeTexture(canvas, { repeat: true });
}

function buildAsphaltRoad() {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rng = createRng(202);

  ctx.fillStyle = '#3a4049';
  ctx.fillRect(0, 0, size, size);

  // Deterministic asphalt mineral speckle
  for (let i = 0; i < 1600; i += 1) {
    const x = Math.floor(rng() * size);
    const y = Math.floor(rng() * size);
    const bright = rng() > 0.5;
    ctx.fillStyle = bright ? 'rgba(220,228,238,0.07)' : 'rgba(15,18,24,0.12)';
    ctx.fillRect(x, y, 2, 2);
  }

  // Concrete curbs at outer left/right edges
  ctx.fillStyle = '#8b949e';
  ctx.fillRect(0, 0, 12, size);
  ctx.fillRect(size - 12, 0, 12, size);
  ctx.fillStyle = '#68717a';
  ctx.fillRect(10, 0, 2, size);
  ctx.fillRect(size - 12, 0, 2, size);

  // Crisp solid white shoulder lines
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(14, 0, 8, size);
  ctx.fillRect(size - 22, 0, 8, size);

  // Seamless yellow dashed centerline (2 dashes per 256px)
  ctx.fillStyle = '#facc15';
  ctx.fillRect(123, 18, 10, 88);
  ctx.fillRect(123, 146, 10, 88);

  return finalizeTexture(canvas, { repeat: true });
}

function buildHazardStripes() {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffd400';
  ctx.fillRect(0, 0, size, size);

  // 45-degree diagonal charcoal stripes with 64px period (seamless on 256x256)
  ctx.fillStyle = '#1b1f24';
  const period = 64;
  const stripeW = 32;
  for (let offset = -size; offset < size * 2; offset += period) {
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset + stripeW, 0);
    ctx.lineTo(offset + stripeW - size, size);
    ctx.lineTo(offset - size, size);
    ctx.closePath();
    ctx.fill();
  }

  return finalizeTexture(canvas, { repeat: true });
}

function buildConcretePad() {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rng = createRng(404);

  ctx.fillStyle = '#b9c1c9';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 1200; i += 1) {
    const x = Math.floor(rng() * size);
    const y = Math.floor(rng() * size);
    ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.09)' : 'rgba(55,65,81,0.09)';
    ctx.fillRect(x, y, 2, 2);
  }

  // 2x2 expansion joint seams
  ctx.strokeStyle = '#86909c';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(128, 0);
  ctx.lineTo(128, size);
  ctx.moveTo(0, 128);
  ctx.lineTo(size, 128);
  ctx.stroke();

  ctx.strokeStyle = '#d7dde3';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(130.5, 0);
  ctx.lineTo(130.5, size);
  ctx.moveTo(0, 130.5);
  ctx.lineTo(size, 130.5);
  ctx.stroke();

  // Subtle corner anchor bolts in each slab quadrant
  const boltOffsets = [
    [16, 16], [112, 16], [16, 112], [112, 112],
    [144, 16], [240, 16], [144, 112], [240, 112],
    [16, 144], [112, 144], [16, 240], [112, 240],
    [144, 144], [240, 144], [144, 240], [240, 240],
  ];
  for (let i = 0; i < boltOffsets.length; i += 1) {
    const [bx, by] = boltOffsets[i];
    ctx.beginPath();
    ctx.arc(bx, by, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#6b7280';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx - 0.8, by - 0.8, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = '#e5e7eb';
    ctx.fill();
  }

  return finalizeTexture(canvas, { repeat: true });
}

function buildWoodTruss() {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rng = createRng(505);
  const plankColors = ['#b57941', '#a86d37', '#bd8148', '#9e6532'];
  const plankH = 64;

  for (let p = 0; p < 4; p += 1) {
    const y0 = p * plankH;
    ctx.fillStyle = plankColors[p];
    ctx.fillRect(0, y0, size, plankH);

    // Horizontal wood grain streaks
    for (let s = 0; s < 26; s += 1) {
      const sy = y0 + 4 + rng() * (plankH - 8);
      const sw = 36 + rng() * 110;
      const sx = rng() * size;
      ctx.fillStyle = rng() > 0.45 ? 'rgba(84,48,18,0.16)' : 'rgba(245,204,152,0.13)';
      ctx.fillRect(sx, sy, sw, 2);
      if (sx + sw > size) {
        ctx.fillRect(0, sy, sx + sw - size, 2);
      }
    }

    // Dark plank seam
    ctx.fillStyle = '#6b411c';
    ctx.fillRect(0, y0, size, 3);

    // Iron bolt heads
    const boltY = y0 + plankH * 0.5;
    for (const bx of [24, 232]) {
      ctx.beginPath();
      ctx.arc(bx, boltY, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#374151';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx - 1.2, boltY - 1.2, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = '#9ca3af';
      ctx.fill();
    }
  }

  return finalizeTexture(canvas, { repeat: true });
}

function buildLavaMagma() {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rng = createRng(606);

  ctx.fillStyle = '#d83400';
  ctx.fillRect(0, 0, size, size);

  const drawWrappedBlob = (cx, cy, r, innerColor, outerColor) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const px = cx + ox;
        const py = cy + oy;
        if (px + r < 0 || px - r > size || py + r < 0 || py - r > size) continue;
        const grad = ctx.createRadialGradient(px, py, r * 0.1, px, py, r);
        grad.addColorStop(0, innerColor);
        grad.addColorStop(1, outerColor);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  // Molten orange & yellow cells
  for (let i = 0; i < 24; i += 1) {
    drawWrappedBlob(rng() * size, rng() * size, 22 + rng() * 26, '#ff9100', 'rgba(255,87,20,0)');
  }
  for (let i = 0; i < 18; i += 1) {
    drawWrappedBlob(rng() * size, rng() * size, 12 + rng() * 16, '#ffd600', 'rgba(255,145,0,0)');
  }
  for (let i = 0; i < 10; i += 1) {
    drawWrappedBlob(rng() * size, rng() * size, 6 + rng() * 8, '#fff3a1', 'rgba(255,214,0,0)');
  }

  // Dark basalt crust flecks
  for (let i = 0; i < 20; i += 1) {
    const cx = rng() * size;
    const cy = rng() * size;
    const rx = 5 + rng() * 10;
    const ry = 3 + rng() * 6;
    ctx.fillStyle = 'rgba(77,22,8,0.62)';
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const px = cx + ox;
        const py = cy + oy;
        if (px + rx < 0 || px - rx > size || py + ry < 0 || py - ry > size) continue;
        ctx.beginPath();
        ctx.ellipse(px, py, rx, ry, 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  return finalizeTexture(canvas, { repeat: true });
}

function buildDerbyTiles() {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const palette = [
    '#e53935', '#1e88e5', '#fdd835', '#43a047',
    '#fb8c00', '#00acc1', '#8e24aa', '#f4f6f8',
    '#43a047', '#f4f6f8', '#e53935', '#fb8c00',
    '#1e88e5', '#8e24aa', '#00acc1', '#fdd835',
  ];

  ctx.fillStyle = '#2b323b';
  ctx.fillRect(0, 0, size, size);

  const cell = 64;
  for (let gy = 0; gy < 4; gy += 1) {
    for (let gx = 0; gx < 4; gx += 1) {
      const color = palette[gy * 4 + gx];
      const x = gx * cell + 2;
      const y = gy * cell + 2;
      const w = cell - 4;

      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, w);

      ctx.fillStyle = 'rgba(255,255,255,0.24)';
      ctx.fillRect(x, y, w, 5);
      ctx.fillRect(x, y, 5, w);

      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      ctx.fillRect(x, y + w - 5, w, 5);
      ctx.fillRect(x + w - 5, y, 5, w);
    }
  }

  return finalizeTexture(canvas, { repeat: true });
}

function buildDirtSand() {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rng = createRng(808);

  ctx.fillStyle = '#d7b377';
  ctx.fillRect(0, 0, size, size);

  // Subtle seamless ripple bands
  for (let y = 0; y < size; y += 16) {
    ctx.strokeStyle = 'rgba(185,143,82,0.24)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let x = 0; x <= size; x += 16) {
      const wy = y + Math.sin((x / size) * Math.PI * 4) * 3;
      if (x === 0) ctx.moveTo(x, wy);
      else ctx.lineTo(x, wy);
    }
    ctx.stroke();
  }

  // Deterministic sand & pebble grain
  const tones = ['#c79f62', '#e2c38d', '#b98f52', '#edd4a6'];
  for (let i = 0; i < 1400; i += 1) {
    const x = Math.floor(rng() * size);
    const y = Math.floor(rng() * size);
    const s = rng() > 0.85 ? 3 : 2;
    ctx.fillStyle = tones[Math.floor(rng() * tones.length)];
    ctx.fillRect(x, y, s, s);
  }

  return finalizeTexture(canvas, { repeat: true });
}

function buildRainbowStripe() {
  const size = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const bands = ['#ff2d2d', '#ff8c00', '#ffe100', '#2ecc40', '#1e90ff', '#9b30ff'];
  const bandH = size / bands.length;

  for (let i = 0; i < bands.length; i += 1) {
    const y = Math.floor(i * bandH);
    const nextY = Math.ceil((i + 1) * bandH);
    ctx.fillStyle = bands[i];
    ctx.fillRect(0, y, size, nextY - y);

    ctx.fillStyle = 'rgba(255,255,255,0.26)';
    ctx.fillRect(0, y, size, 3);
  }

  return finalizeTexture(canvas, { repeat: true });
}

/**
 * Creates the shared procedural Roblox CanvasTexture library and dynamic
 * sign / plate / number generators with bounded caching and clean disposal.
 */
export function createTextureLibrary() {
  const grassGrid = buildGrassGrid();
  const asphaltRoad = buildAsphaltRoad();
  const hazardStripes = buildHazardStripes();
  const concretePad = buildConcretePad();
  const woodTruss = buildWoodTruss();
  const lavaMagma = buildLavaMagma();
  const derbyTiles = buildDerbyTiles();
  const dirtSand = buildDirtSand();
  const rainbowStripe = buildRainbowStripe();

  const baseTextures = [
    grassGrid,
    asphaltRoad,
    hazardStripes,
    concretePad,
    woodTruss,
    lavaMagma,
    derbyTiles,
    dirtSand,
    rainbowStripe,
  ];

  const signCache = new Map();
  const plateCache = new Map();
  const numberCache = new Map();

  const evictIfFull = (cache) => {
    if (cache.size < MAX_DYNAMIC_CACHE) return;
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldTex = cache.get(oldestKey);
      oldTex?.dispose();
      cache.delete(oldestKey);
    }
  };

  const makeSignTexture = (title = 'DEMOLITION LAB', subtitle = '', bg = '#1e293b', fg = '#ffffff') => {
    const tStr = String(title ?? '').toUpperCase();
    const sStr = String(subtitle ?? '').toUpperCase();
    const bgStr = String(bg || '#1e293b');
    const fgStr = String(fg || '#ffffff');
    const key = `${tStr}|${sStr}|${bgStr}|${fgStr}`;
    if (signCache.has(key)) return signCache.get(key);

    evictIfFull(signCache);

    const w = 512;
    const h = 256;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');

    // Outer hazard striped frame
    ctx.fillStyle = '#facc15';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.fillStyle = '#111827';
    for (let x = -h; x < w + h; x += 36) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + 18, 0);
      ctx.lineTo(x + 18 - h, h);
      ctx.lineTo(x - h, h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Inner solid sign board
    const pad = 18;
    ctx.fillStyle = bgStr;
    ctx.fillRect(pad, pad, w - pad * 2, h - pad * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 4;
    ctx.strokeRect(pad + 4, pad + 4, w - (pad + 4) * 2, h - (pad + 4) * 2);

    // Auto-fitted bold title
    const maxTextW = w - (pad + 22) * 2;
    let fontSize = 54;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    while (fontSize > 14) {
      ctx.font = `900 ${fontSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
      if (ctx.measureText(tStr).width <= maxTextW) break;
      fontSize -= 2;
    }
    ctx.font = `900 ${fontSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;

    const titleY = sStr ? h * 0.42 : h * 0.52;
    ctx.lineWidth = Math.max(2, Math.min(6, fontSize * 0.14));
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.strokeText(tStr, w * 0.5, titleY, maxTextW);
    ctx.fillStyle = fgStr;
    ctx.fillText(tStr, w * 0.5, titleY, maxTextW);

    if (sStr) {
      let subSize = 28;
      while (subSize > 14) {
        ctx.font = `800 ${subSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
        if (ctx.measureText(sStr).width <= maxTextW) break;
        subSize -= 2;
      }
      ctx.font = `800 ${subSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
      ctx.lineWidth = Math.max(2, Math.min(4, subSize * 0.16));
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(sStr, w * 0.5, h * 0.72, maxTextW);
      ctx.fillStyle = '#fde047';
      ctx.fillText(sStr, w * 0.5, h * 0.72, maxTextW);
    }

    const tex = finalizeTexture(canvas, { repeat: false });
    signCache.set(key, tex);
    return tex;
  };

  const makePlateTexture = (code = 'RCD 247') => {
    const text = String(code ?? 'RCD 247').trim().toUpperCase() || 'RCD 247';
    if (plateCache.has(text)) return plateCache.get(text);

    evictIfFull(plateCache);

    const w = 256;
    const h = 128;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#f6f8fa';
    ctx.fillRect(0, 0, w, h);

    // Blue top header band
    ctx.fillStyle = '#1565c0';
    ctx.fillRect(6, 6, w - 12, 30);

    // Crisp outer border
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, w - 6, h - 6);

    // Header label
    ctx.fillStyle = '#ffffff';
    ctx.font = `900 15px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ROBLOX CRASH LAB', w * 0.5, 22, w - 56);

    // Corner mounting screws
    for (const [sx, sy] of [[20, 20], [w - 20, 20], [20, h - 18], [w - 20, h - 18]]) {
      ctx.beginPath();
      ctx.arc(sx, sy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#94a3b8';
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Giant license plate characters
    const maxPlateW = w - 34;
    let fontSize = 52;
    while (fontSize > 16) {
      ctx.font = `900 ${fontSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
      if (ctx.measureText(text).width <= maxPlateW) break;
      fontSize -= 2;
    }
    ctx.font = `900 ${fontSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
    ctx.fillStyle = '#0f172a';
    ctx.fillText(text, w * 0.5, 82, maxPlateW);

    const tex = finalizeTexture(canvas, { repeat: false });
    plateCache.set(text, tex);
    return tex;
  };

  const makeNumberTexture = (num = '101', bg = '#fdd835') => {
    const label = String(num ?? '0');
    const bgStr = String(bg || '#fdd835');
    const key = `${label}|${bgStr}`;
    if (numberCache.has(key)) return numberCache.get(key);

    evictIfFull(numberCache);

    const size = 256;
    const canvas = makeCanvas(size, size);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = bgStr;
    ctx.fillRect(0, 0, size, size);

    // White outer border + dark inner frame
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, size - 14, size - 14);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 4;
    ctx.strokeRect(18, 18, size - 36, size - 36);

    const darkInkLum = parseHexLuminance('#111827');
    const lum = parseHexLuminance(bgStr);
    const contrastWhite = (1.0 + 0.05) / (lum + 0.05);
    const contrastDark = (lum + 0.05) / (darkInkLum + 0.05);
    const textColor = contrastDark >= contrastWhite ? '#111827' : '#ffffff';

    const maxInnerW = size - 60;
    let fontSize = 120;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    while (fontSize > 24) {
      ctx.font = `900 ${fontSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
      if (ctx.measureText(label).width <= maxInnerW) break;
      fontSize -= 2;
    }
    ctx.font = `900 ${fontSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
    ctx.fillStyle = textColor;
    ctx.fillText(label, size * 0.5, size * 0.53, maxInnerW);

    const tex = finalizeTexture(canvas, { repeat: false });
    numberCache.set(key, tex);
    return tex;
  };

  const dispose = () => {
    for (let i = 0; i < baseTextures.length; i += 1) {
      baseTextures[i].dispose();
    }
    for (const tex of signCache.values()) tex.dispose();
    for (const tex of plateCache.values()) tex.dispose();
    for (const tex of numberCache.values()) tex.dispose();
    signCache.clear();
    plateCache.clear();
    numberCache.clear();
  };

  return {
    grassGrid,
    asphaltRoad,
    hazardStripes,
    concretePad,
    woodTruss,
    lavaMagma,
    derbyTiles,
    dirtSand,
    rainbowStripe,
    makeSignTexture,
    makePlateTexture,
    makeNumberTexture,
    dispose,
  };
}
