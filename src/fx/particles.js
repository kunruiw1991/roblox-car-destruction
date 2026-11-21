/**
 * Pooled 3D Destruction VFX, Skid Marks, Tumbling Debris & Floating Cash System
 * (Contract #12).
 *
 * Fixed-cap, zero-GC-pressure pools tuned for iPad Safari 60 fps and SwiftShader:
 *   - InstancedMesh (pre-initialized instanceColor at construction -> zero mid-frame
 *     shader recompile): sparks (96), glass shards (64), nitro flames (48),
 *     adaptive twin/single tire skid marks (240, polygonOffset).
 *   - Pooled fading meshes: smoke (40), fire (36), dust (36), explosion fireball +
 *     ground shockwave ring pairs (6).
 *   - Floating cash popups: pooled THREE.Sprite (24, toneMapped: false, fog: false)
 *     with active-sprite ref-checked 192x96 SRGBColorSpace CanvasTexture cache (48).
 *   - Tumbling 3D debris: MAX_DEBRIS = 48 with groundYFn bounce and ownership-safe
 *     disposal (ONLY disposes geometry/material flagged userData.ownsGeometry/ownsMaterial,
 *     NEVER disposes borrowed shared textures).
 *
 * Conventions for M3 callers:
 *   - emitNitro(pos, dir): dir is the exhaust jet travel direction (-forward, e.g.
 *     [-Math.sin(yaw), 0, -Math.cos(yaw)]).
 *   - addSkidMark(pos, yaw, width): width >= 0.75 stamps twin left/right tire strips
 *     around pos; width < 0.75 stamps a single centered tire strip.
 */

import * as THREE from '../../vendor/three.module.min.js';
import { createStandardMaterial, enforceMaterialGuardrails } from '../core/materials.js';

const MAX_SPARKS = 96;
const MAX_GLASS = 64;
const MAX_SMOKE = 40;
const MAX_FIRE = 36;
const MAX_DUST = 36;
const MAX_EXPLOSIONS = 6;
const MAX_NITRO = 48;
const MAX_SKIDS = 240;
const MAX_DEBRIS = 48;
const MAX_CASH_SPRITES = 24;
const MAX_CASH_TEX_CACHE = 48;

const DEBRIS_LIFETIME = 12.0;

const SPARK_COL_HOT = new THREE.Color(0xfff9c4);
const SPARK_COL_COOL = new THREE.Color(0xff9800);
const GLASS_PALETTE = [
  new THREE.Color(0xe0f2fe),
  new THREE.Color(0xbae6fd),
  new THREE.Color(0x7dd3fc),
];
const SMOKE_HEXES = [0x262c34, 0x3d4550, 0x525c68];
const DUST_HEXES = [0xd7c3a1, 0xc6b394, 0xb6afa4];
const FIRE_COL_BRIGHT = new THREE.Color(0xfff176);
const FIRE_COL_MID = new THREE.Color(0xff6d00);
const FIRE_COL_DARK = new THREE.Color(0xd84315);
const EXP_COL_START = new THREE.Color(0xfff59d);
const EXP_COL_MID = new THREE.Color(0xff6d00);
const EXP_COL_END = new THREE.Color(0xb71c1c);
const NITRO_PALETTE = [
  new THREE.Color(0xfff59d),
  new THREE.Color(0xffd600),
  new THREE.Color(0xff9100),
];

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : (n > max ? max : n);
}

function toVec3(input, out, fx = 0, fy = 0, fz = 0) {
  if (!input) {
    out.set(fx, fy, fz);
    return out;
  }
  if (Array.isArray(input) || ArrayBuffer.isView(input)) {
    const x = Number(input[0]);
    const y = Number(input[1]);
    const z = Number(input[2]);
    out.set(
      Number.isFinite(x) ? x : fx,
      Number.isFinite(y) ? y : fy,
      Number.isFinite(z) ? z : fz,
    );
    return out;
  }
  if (typeof input === 'object') {
    const x = Number(input.x);
    const y = Number(input.y);
    const z = Number(input.z);
    out.set(
      Number.isFinite(x) ? x : fx,
      Number.isFinite(y) ? y : fy,
      Number.isFinite(z) ? z : fz,
    );
    return out;
  }
  out.set(fx, fy, fz);
  return out;
}

function toQuat(input, out) {
  if (!input) {
    out.identity();
    return out;
  }
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 1;
  if (Array.isArray(input) || ArrayBuffer.isView(input)) {
    x = Number(input[0]);
    y = Number(input[1]);
    z = Number(input[2]);
    w = Number(input[3]);
  } else if (typeof input === 'object') {
    x = Number(input.x);
    y = Number(input.y);
    z = Number(input.z);
    w = Number(input.w);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(w)) {
    out.identity();
    return out;
  }
  const lenSq = x * x + y * y + z * z + w * w;
  if (lenSq < 1e-6) {
    out.identity();
    return out;
  }
  out.set(x, y, z, w).normalize();
  return out;
}

function createRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function formatCashLabel(amount) {
  const rounded = Math.max(1, Math.round(amount));
  const str = rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `+$${str}`;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const radius = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function makeCashCanvasTexture(label, isBig) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }
  const w = 192;
  const h = 96;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, w, h);

  // Crisp Roblox-style emerald / gold rounded pill badge
  const pad = 8;
  const r = 24;
  ctx.fillStyle = isBig ? '#15803d' : '#16a34a';
  ctx.beginPath();
  drawRoundedRect(ctx, pad, pad + 6, w - pad * 2, h - (pad + 6) * 2, r);
  ctx.fill();

  ctx.lineWidth = 6;
  ctx.strokeStyle = isBig ? '#fde047' : '#dcfce7';
  ctx.stroke();

  // Bold high-contrast cash text
  let fontSize = 44;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxTextW = w - 34;
  while (fontSize > 18) {
    ctx.font = `900 ${fontSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
    if (ctx.measureText(label).width <= maxTextW) break;
    fontSize -= 2;
  }
  ctx.font = `900 ${fontSize}px 'Avenir Next', 'Segoe UI', system-ui, sans-serif`;
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#052e16';
  ctx.strokeText(label, w * 0.5, h * 0.52, maxTextW);
  ctx.fillStyle = isBig ? '#fef08a' : '#ffffff';
  ctx.fillText(label, w * 0.5, h * 0.52, maxTextW);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function disposeDebrisMeshIfOwned(mesh) {
  if (!mesh || !mesh.userData) return;
  const ownsGeo = mesh.userData.ownsGeometry === true;
  const ownsMat = mesh.userData.ownsMaterial === true;
  const ownsTex = mesh.userData.ownsTextures === true;
  if (!ownsGeo && !ownsMat && !ownsTex) return;

  const disposedGeos = new Set();
  const disposedMats = new Set();
  const disposedTexs = new Set();

  const visit = (node) => {
    if (!node) return;
    if (ownsGeo && node.geometry && !disposedGeos.has(node.geometry)) {
      disposedGeos.add(node.geometry);
      if (typeof node.geometry.dispose === 'function') node.geometry.dispose();
    }
    if ((ownsMat || ownsTex) && node.material) {
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (let i = 0; i < mats.length; i += 1) {
        const m = mats[i];
        if (!m) continue;
        if (ownsTex && m.map && !disposedTexs.has(m.map)) {
          disposedTexs.add(m.map);
          if (typeof m.map.dispose === 'function') m.map.dispose();
        }
        if (ownsMat && !disposedMats.has(m)) {
          disposedMats.add(m);
          if (typeof m.dispose === 'function') m.dispose();
        }
      }
    }
  };

  if (typeof mesh.traverse === 'function') {
    mesh.traverse(visit);
  } else {
    visit(mesh);
  }
}

/**
 * Creates a fixed-cap, zero-allocation pooled 3D particle & debris system
 * (Contract #12).
 *
 * @param {THREE.Scene|null} scene
 */
export function createParticleSystem(scene) {
  const targetScene = scene || null;
  const rng = createRng(918273645);

  const fxRoot = new THREE.Group();
  fxRoot.name = 'fx_particle_system';
  if (targetScene && typeof targetScene.add === 'function') {
    targetScene.add(fxRoot);
  }

  const debrisGroup = new THREE.Group();
  debrisGroup.name = 'fx_debris_group';
  fxRoot.add(debrisGroup);

  const ownedGeoms = [];
  const ownedMats = [];
  const trackGeom = (g) => {
    ownedGeoms.push(g);
    return g;
  };
  const trackMat = (m) => {
    ownedMats.push(m);
    return m;
  };

  // Pre-allocated scratch math (ZERO allocations in emit* or update!)
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _q1 = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _e1 = new THREE.Euler();
  const _m1 = new THREE.Matrix4();
  const _c1 = new THREE.Color();
  const _scaleVec = new THREE.Vector3();
  const _zAxis = new THREE.Vector3(0, 0, 1);
  const _box = new THREE.Box3();
  const _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);

  let disposed = false;

  const initInstancedColorsAndMatrices = (instMesh, maxCount) => {
    _c1.setHex(0xffffff);
    for (let i = 0; i < maxCount; i += 1) {
      instMesh.setMatrixAt(i, _zeroMat);
      instMesh.setColorAt(i, _c1);
    }
    instMesh.count = 0;
    instMesh.frustumCulled = false;
    instMesh.castShadow = false;
    instMesh.receiveShadow = false;
    instMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    instMesh.instanceMatrix.needsUpdate = true;
    if (instMesh.instanceColor) {
      instMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      instMesh.instanceColor.needsUpdate = true;
    }
    fxRoot.add(instMesh);
  };

  // =========================================================================
  // 1. SPARKS POOL (InstancedMesh, MAX = 96, pre-init instanceColor)
  // =========================================================================
  const sparkGeo = trackGeom(new THREE.BoxGeometry(0.055, 0.055, 0.34));
  const sparkMat = trackMat(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const sparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
  sparkMesh.name = 'fx_sparks';
  initInstancedColorsAndMatrices(sparkMesh, MAX_SPARKS);

  const sparks = new Array(MAX_SPARKS);
  for (let i = 0; i < MAX_SPARKS; i += 1) {
    sparks[i] = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0.4 };
  }
  let sparkActive = 0;

  // =========================================================================
  // 2. GLASS SHARDS POOL (InstancedMesh, MAX = 64, Guardrail 2 metalness 0.14)
  // =========================================================================
  const glassGeo = trackGeom(new THREE.OctahedronGeometry(0.11, 0));
  glassGeo.scale(1.25, 0.25, 1.45);
  const glassMat = trackMat(createStandardMaterial({
    name: 'fx_glass_shard',
    color: 0xffffff,
    roughness: 0.16,
    metalness: 0.14,
    transparent: true,
    opacity: 0.78,
  }, targetScene));
  const glassMesh = new THREE.InstancedMesh(glassGeo, glassMat, MAX_GLASS);
  glassMesh.name = 'fx_glass';
  initInstancedColorsAndMatrices(glassMesh, MAX_GLASS);

  const glassShards = new Array(MAX_GLASS);
  for (let i = 0; i < MAX_GLASS; i += 1) {
    glassShards[i] = {
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      rx: 0, ry: 0, rz: 0,
      avx: 0, avy: 0, avz: 0,
      age: 0, life: 0.9,
      colIdx: 0,
      baseScale: 1.0,
    };
  }
  let glassActive = 0;

  // =========================================================================
  // 3. SMOKE POOL (Pooled Meshes, MAX = 40)
  // =========================================================================
  const smokeGeo = trackGeom(new THREE.DodecahedronGeometry(0.40, 0));
  const smokePool = new Array(MAX_SMOKE);
  for (let i = 0; i < MAX_SMOKE; i += 1) {
    const mat = trackMat(createStandardMaterial({
      name: `fx_smoke_${i}`,
      color: SMOKE_HEXES[i % SMOKE_HEXES.length],
      roughness: 0.94,
      metalness: 0.0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }, targetScene));
    const mesh = new THREE.Mesh(smokeGeo, mat);
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    fxRoot.add(mesh);
    smokePool[i] = {
      mesh, mat,
      active: false,
      vx: 0, vy: 0, vz: 0,
      spinY: 0,
      age: 0, life: 1.2,
      startScale: 0.45, endScale: 2.35,
      peakOpacity: 0.68,
    };
  }
  let smokeCursor = 0;

  // =========================================================================
  // 4. FIRE POOL (Pooled Meshes, MAX = 36)
  // =========================================================================
  const fireGeo = trackGeom(new THREE.DodecahedronGeometry(0.30, 0));
  const firePool = new Array(MAX_FIRE);
  for (let i = 0; i < MAX_FIRE; i += 1) {
    const mat = trackMat(new THREE.MeshBasicMaterial({
      color: 0xffab00,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }));
    const mesh = new THREE.Mesh(fireGeo, mat);
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    fxRoot.add(mesh);
    firePool[i] = {
      mesh, mat,
      active: false,
      vx: 0, vy: 0, vz: 0,
      spin: 0,
      age: 0, life: 0.48,
      baseScale: 0.55,
    };
  }
  let fireCursor = 0;

  // =========================================================================
  // 5. DUST POOL (Pooled Meshes, MAX = 36)
  // =========================================================================
  const dustGeo = trackGeom(new THREE.DodecahedronGeometry(0.34, 0));
  const dustPool = new Array(MAX_DUST);
  for (let i = 0; i < MAX_DUST; i += 1) {
    const mat = trackMat(createStandardMaterial({
      name: `fx_dust_${i}`,
      color: DUST_HEXES[i % DUST_HEXES.length],
      roughness: 0.95,
      metalness: 0.0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }, targetScene));
    const mesh = new THREE.Mesh(dustGeo, mat);
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    fxRoot.add(mesh);
    dustPool[i] = {
      mesh, mat,
      active: false,
      vx: 0, vy: 0, vz: 0,
      age: 0, life: 0.8,
      startScale: 0.5, endScale: 2.1,
    };
  }
  let dustCursor = 0;

  // =========================================================================
  // 6. EXPLOSION POOL (MAX = 6 fireball + ground shockwave ring pairs)
  // =========================================================================
  const expBallGeo = trackGeom(new THREE.IcosahedronGeometry(1.0, 1));
  const expRingGeo = trackGeom(new THREE.RingGeometry(0.72, 1.0, 24));
  expRingGeo.rotateX(-Math.PI / 2);

  const expPool = new Array(MAX_EXPLOSIONS);
  for (let i = 0; i < MAX_EXPLOSIONS; i += 1) {
    const ballMat = trackMat(new THREE.MeshBasicMaterial({
      color: 0xffd54f,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }));
    const ball = new THREE.Mesh(expBallGeo, ballMat);
    ball.visible = false;
    ball.castShadow = false;
    ball.receiveShadow = false;
    fxRoot.add(ball);

    const ringMat = trackMat(new THREE.MeshBasicMaterial({
      color: 0xffab40,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const ring = new THREE.Mesh(expRingGeo, ringMat);
    ring.visible = false;
    ring.castShadow = false;
    ring.receiveShadow = false;
    fxRoot.add(ring);

    expPool[i] = {
      ball, ballMat,
      ring, ringMat,
      active: false,
      ringSnapped: false,
      age: 0,
      radius: 4.5,
    };
  }
  let expCursor = 0;

  // =========================================================================
  // 7. NITRO FLAMES POOL (InstancedMesh, MAX = 48, tip pointing along +Z)
  // =========================================================================
  const nitroGeo = trackGeom(new THREE.ConeGeometry(0.15, 0.70, 6));
  nitroGeo.rotateX(Math.PI / 2);
  const nitroMat = trackMat(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const nitroMesh = new THREE.InstancedMesh(nitroGeo, nitroMat, MAX_NITRO);
  nitroMesh.name = 'fx_nitro';
  initInstancedColorsAndMatrices(nitroMesh, MAX_NITRO);

  const nitros = new Array(MAX_NITRO);
  for (let i = 0; i < MAX_NITRO; i += 1) {
    nitros[i] = {
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: -12,
      dx: 0, dy: 0, dz: -1,
      age: 0, life: 0.18,
      scale: 1.0,
      colIdx: 0,
    };
  }
  let nitroActive = 0;

  // =========================================================================
  // 8. TIRE SKID MARKS RING BUFFER (InstancedMesh, MAX = 240, polygonOffset)
  // =========================================================================
  const skidGeo = trackGeom(new THREE.PlaneGeometry(1, 1));
  skidGeo.rotateX(-Math.PI / 2);
  const skidMat = trackMat(new THREE.MeshBasicMaterial({
    color: 0x14171c,
    transparent: true,
    opacity: 0.60,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }));
  const skidMesh = new THREE.InstancedMesh(skidGeo, skidMat, MAX_SKIDS);
  skidMesh.name = 'fx_skid_marks';
  for (let i = 0; i < MAX_SKIDS; i += 1) {
    skidMesh.setMatrixAt(i, _zeroMat);
  }
  skidMesh.count = 0;
  skidMesh.frustumCulled = false;
  skidMesh.castShadow = false;
  skidMesh.receiveShadow = false;
  skidMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  skidMesh.instanceMatrix.needsUpdate = true;
  fxRoot.add(skidMesh);

  let skidCursor = 0;
  let skidCount = 0;

  // =========================================================================
  // 9. TUMBLING 3D DEBRIS LIST (MAX = 48, ownership-safe disposal)
  // =========================================================================
  const debrisList = [];

  // =========================================================================
  // 10. FLOATING CASH POPUPS (Pooled Sprites, MAX = 24, toneMapped/fog = false)
  // =========================================================================
  const cashTexCache = new Map();
  const cashPool = new Array(MAX_CASH_SPRITES);
  for (let i = 0; i < MAX_CASH_SPRITES; i += 1) {
    const mat = trackMat(new THREE.SpriteMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }));
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.name = `fx_cash_sprite_${i}`;
    fxRoot.add(sprite);
    cashPool[i] = {
      sprite,
      mat,
      active: false,
      vx: 0,
      vy: 3.0,
      vz: 0,
      age: 0,
      life: 1.35,
      baseW: 2.0,
      baseH: 1.0,
    };
  }
  let cashCursor = 0;

  function getCashTexture(amount) {
    const label = formatCashLabel(amount);
    const isBig = amount >= 200;
    const key = `${label}|${isBig ? 1 : 0}`;
    if (cashTexCache.has(key)) {
      return cashTexCache.get(key);
    }

    // Active-sprite ref-checked eviction so live sprites NEVER bind a disposed texture!
    if (cashTexCache.size >= MAX_CASH_TEX_CACHE) {
      const inUse = new Set();
      for (let i = 0; i < MAX_CASH_SPRITES; i += 1) {
        if (cashPool[i].active && cashPool[i].mat.map) {
          inUse.add(cashPool[i].mat.map);
        }
      }
      for (const [oldKey, oldTex] of cashTexCache.entries()) {
        if (!inUse.has(oldTex)) {
          oldTex.dispose();
          cashTexCache.delete(oldKey);
          break;
        }
      }
    }

    const tex = makeCashCanvasTexture(label, isBig);
    if (tex) {
      cashTexCache.set(key, tex);
    }
    return tex;
  }

  // =========================================================================
  // EMITTERS
  // =========================================================================

  function emitSparks(pos, count = 12, velScale = 1) {
    if (disposed) return;
    toVec3(pos, _v1, 0, 0.5, 0);
    const n = Math.round(clampNum(count, 1, 40, 12));
    const vs = clampNum(velScale, 0.2, 4.0, 1.0);

    for (let i = 0; i < n; i += 1) {
      let idx = sparkActive;
      if (idx < MAX_SPARKS) {
        sparkActive += 1;
      } else {
        idx = Math.floor(rng() * MAX_SPARKS);
      }
      const p = sparks[idx];
      const theta = rng() * Math.PI * 2;
      const speed = (5.0 + rng() * 9.0) * vs;
      const up = (0.35 + rng() * 0.75) * speed;
      const horiz = (0.45 + rng() * 0.65) * speed;
      p.x = _v1.x + (rng() - 0.5) * 0.25;
      p.y = _v1.y + (rng() - 0.5) * 0.20;
      p.z = _v1.z + (rng() - 0.5) * 0.25;
      p.vx = Math.cos(theta) * horiz;
      p.vy = up;
      p.vz = Math.sin(theta) * horiz;
      p.age = 0;
      p.life = 0.25 + rng() * 0.30;
    }
  }

  function emitGlass(pos, count = 14) {
    if (disposed) return;
    toVec3(pos, _v1, 0, 1.0, 0);
    const n = Math.round(clampNum(count, 1, 32, 14));

    for (let i = 0; i < n; i += 1) {
      let idx = glassActive;
      if (idx < MAX_GLASS) {
        glassActive += 1;
      } else {
        idx = Math.floor(rng() * MAX_GLASS);
      }
      const g = glassShards[idx];
      const theta = rng() * Math.PI * 2;
      const speed = 3.0 + rng() * 7.0;
      g.x = _v1.x + (rng() - 0.5) * 0.40;
      g.y = _v1.y + (rng() - 0.5) * 0.30;
      g.z = _v1.z + (rng() - 0.5) * 0.40;
      g.vx = Math.cos(theta) * speed;
      g.vy = 2.0 + rng() * 5.2;
      g.vz = Math.sin(theta) * speed;
      g.rx = rng() * Math.PI * 2;
      g.ry = rng() * Math.PI * 2;
      g.rz = rng() * Math.PI * 2;
      g.avx = (rng() - 0.5) * 22.0;
      g.avy = (rng() - 0.5) * 22.0;
      g.avz = (rng() - 0.5) * 22.0;
      g.age = 0;
      g.life = 0.65 + rng() * 0.60;
      g.colIdx = Math.floor(rng() * GLASS_PALETTE.length);
      g.baseScale = 0.75 + rng() * 0.65;
    }
  }

  function emitSmoke(pos, intensity = 1) {
    if (disposed) return;
    toVec3(pos, _v1, 0, 0.8, 0);
    const inten = clampNum(intensity, 0.2, 4.0, 1.0);
    const n = Math.round(clamp(inten * 3, 1, 8));

    for (let i = 0; i < n; i += 1) {
      const slot = smokePool[smokeCursor];
      smokeCursor = (smokeCursor + 1) % MAX_SMOKE;
      slot.active = true;
      slot.age = 0;
      slot.life = 0.95 + rng() * 0.75;
      slot.startScale = 0.42 + rng() * 0.25;
      slot.endScale = (1.8 + rng() * 0.8) * Math.min(inten, 1.8);
      slot.peakOpacity = clamp(0.54 + inten * 0.10, 0.45, 0.76);
      slot.vx = (rng() - 0.5) * 1.8;
      slot.vy = 2.2 + rng() * 2.2;
      slot.vz = (rng() - 0.5) * 1.8;
      slot.spinY = (rng() - 0.5) * 2.4;
      slot.mesh.position.set(
        _v1.x + (rng() - 0.5) * 0.45,
        _v1.y + (rng() - 0.5) * 0.25,
        _v1.z + (rng() - 0.5) * 0.45,
      );
      slot.mesh.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
      slot.mesh.scale.setScalar(slot.startScale);
      slot.mat.opacity = slot.peakOpacity;
      slot.mesh.visible = true;
    }
  }

  function emitFire(pos, intensity = 1) {
    if (disposed) return;
    toVec3(pos, _v1, 0, 0.8, 0);
    const inten = clampNum(intensity, 0.2, 4.0, 1.0);
    const n = Math.round(clamp(inten * 3, 1, 8));

    for (let i = 0; i < n; i += 1) {
      const slot = firePool[fireCursor];
      fireCursor = (fireCursor + 1) % MAX_FIRE;
      slot.active = true;
      slot.age = 0;
      slot.life = 0.32 + rng() * 0.33;
      slot.baseScale = (0.45 + rng() * 0.35) * Math.min(inten, 1.6);
      slot.vx = (rng() - 0.5) * 2.2;
      slot.vy = 2.8 + rng() * 2.7;
      slot.vz = (rng() - 0.5) * 2.2;
      slot.spin = (rng() - 0.5) * 5.0;
      slot.mesh.position.set(
        _v1.x + (rng() - 0.5) * 0.40,
        _v1.y + rng() * 0.25,
        _v1.z + (rng() - 0.5) * 0.40,
      );
      slot.mesh.scale.setScalar(slot.baseScale);
      slot.mat.color.copy(FIRE_COL_BRIGHT);
      slot.mat.opacity = 0.90;
      slot.mesh.visible = true;
    }
  }

  function emitDust(pos, count = 10) {
    if (disposed) return;
    toVec3(pos, _v1, 0, 0.2, 0);
    const n = Math.round(clampNum(count, 1, 16, 10));

    for (let i = 0; i < n; i += 1) {
      const slot = dustPool[dustCursor];
      dustCursor = (dustCursor + 1) % MAX_DUST;
      const theta = rng() * Math.PI * 2;
      const spd = 2.5 + rng() * 3.0;
      slot.active = true;
      slot.age = 0;
      slot.life = 0.55 + rng() * 0.50;
      slot.startScale = 0.48 + rng() * 0.22;
      slot.endScale = 1.85 + rng() * 0.55;
      slot.vx = Math.cos(theta) * spd;
      slot.vy = 0.8 + rng() * 1.4;
      slot.vz = Math.sin(theta) * spd;
      slot.mesh.position.set(
        _v1.x + (rng() - 0.5) * 0.50,
        Math.max(0.15, _v1.y + rng() * 0.25),
        _v1.z + (rng() - 0.5) * 0.50,
      );
      slot.mesh.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
      slot.mesh.scale.setScalar(slot.startScale);
      slot.mat.opacity = 0.52;
      slot.mesh.visible = true;
    }
  }

  function emitExplosion(pos, radius = 4.5) {
    if (disposed) return;
    toVec3(pos, _v1, 0, 0.8, 0);
    const r = clampNum(radius, 1.5, 16.0, 4.5);

    const slot = expPool[expCursor];
    expCursor = (expCursor + 1) % MAX_EXPLOSIONS;
    slot.active = true;
    slot.ringSnapped = false;
    slot.age = 0;
    slot.radius = r;

    slot.ball.position.copy(_v1);
    slot.ball.scale.setScalar(0.35);
    slot.ballMat.color.copy(EXP_COL_START);
    slot.ballMat.opacity = 0.92;
    slot.ball.visible = true;

    slot.ring.position.set(_v1.x, Math.max(0.14, _v1.y - 0.55), _v1.z);
    slot.ring.scale.setScalar(0.50);
    slot.ringMat.opacity = 0.85;
    slot.ring.visible = true;

    // Preserve _v1 into local copy before cascading calls that also use _v1
    const ex = _v1.x;
    const ey = _v1.y;
    const ez = _v1.z;
    const cascadePos = _v2.set(ex, ey, ez);

    emitSparks(cascadePos, 22, 1.5);
    emitFire(cascadePos, 2.5);
    emitSmoke(cascadePos, 2.5);
    emitDust(cascadePos, 10);
  }

  function emitNitro(pos, dir) {
    if (disposed) return;
    toVec3(pos, _v1, 0, 0.4, 0);
    toVec3(dir, _v2, 0, 0, -1);
    if (_v2.lengthSq() < 1e-6) {
      _v2.set(0, 0, -1);
    } else {
      _v2.normalize();
    }

    for (let i = 0; i < 3; i += 1) {
      let idx = nitroActive;
      if (idx < MAX_NITRO) {
        nitroActive += 1;
      } else {
        idx = Math.floor(rng() * MAX_NITRO);
      }
      const nt = nitros[idx];
      const spd = 10.0 + rng() * 7.0;
      const spreadX = (rng() - 0.5) * 0.18;
      const spreadY = (rng() - 0.5) * 0.14;
      const spreadZ = (rng() - 0.5) * 0.18;
      nt.dx = _v2.x + spreadX;
      nt.dy = _v2.y + spreadY;
      nt.dz = _v2.z + spreadZ;
      const dLen = Math.hypot(nt.dx, nt.dy, nt.dz) || 1;
      nt.dx /= dLen;
      nt.dy /= dLen;
      nt.dz /= dLen;

      nt.x = _v1.x + (rng() - 0.5) * 0.12;
      nt.y = _v1.y + (rng() - 0.5) * 0.08;
      nt.z = _v1.z + (rng() - 0.5) * 0.12;
      nt.vx = nt.dx * spd;
      nt.vy = nt.dy * spd;
      nt.vz = nt.dz * spd;
      nt.age = 0;
      nt.life = 0.12 + rng() * 0.12;
      nt.scale = 0.85 + rng() * 0.45;
      nt.colIdx = i % NITRO_PALETTE.length;
    }
  }

  function stampSingleSkid(x, y, z, yaw, stripW, stripLen) {
    _v3.set(x, y, z);
    _e1.set(0, yaw, 0);
    _q1.setFromEuler(_e1);
    _scaleVec.set(stripW, 1, stripLen);
    _m1.compose(_v3, _q1, _scaleVec);
    skidMesh.setMatrixAt(skidCursor, _m1);
    skidCursor = (skidCursor + 1) % MAX_SKIDS;
    if (skidCount < MAX_SKIDS) {
      skidCount += 1;
      skidMesh.count = skidCount;
    }
    skidMesh.instanceMatrix.needsUpdate = true;
  }

  function addSkidMark(pos, yaw = 0, width = 1.6) {
    if (disposed) return;
    toVec3(pos, _v1, 0, 0, 0);
    const yAng = Number.isFinite(Number(yaw)) ? Number(yaw) : 0;
    const w = clampNum(width, 0.15, 4.0, 1.6);
    const yPos = _v1.y + 0.035;
    const stripLen = 0.95;

    // Adaptive width: >= 0.75 m (axle track width) stamps twin left/right tire strips;
    // < 0.75 m (single tire width) stamps one centered strip.
    if (w >= 0.75) {
      const stripW = clamp(w * 0.18, 0.20, 0.42);
      const halfTrack = w * 0.42;
      const rightX = Math.cos(yAng);
      const rightZ = -Math.sin(yAng);
      stampSingleSkid(_v1.x + rightX * halfTrack, yPos, _v1.z + rightZ * halfTrack, yAng, stripW, stripLen);
      stampSingleSkid(_v1.x - rightX * halfTrack, yPos, _v1.z - rightZ * halfTrack, yAng, stripW, stripLen);
    } else {
      const stripW = clamp(w, 0.18, 0.60);
      stampSingleSkid(_v1.x, yPos, _v1.z, yAng, stripW, stripLen);
    }
  }

  function spawnDebris(mesh, pos, quat, linVel, angVel) {
    if (disposed || !mesh || typeof mesh !== 'object' || !mesh.isObject3D) return;

    if (!targetScene || !targetScene.environment) {
      enforceMaterialGuardrails(mesh);
    }

    toVec3(pos, _v1, 0, 1.0, 0);
    toQuat(quat, _q1);
    toVec3(linVel, _v2, (rng() - 0.5) * 6, 4.5 + rng() * 3.5, (rng() - 0.5) * 6);
    toVec3(angVel, _v3, (rng() - 0.5) * 8, (rng() - 0.5) * 8, (rng() - 0.5) * 8);

    // Clamp extreme velocities so debris never explodes to Infinity
    _v2.set(clamp(_v2.x, -75, 75), clamp(_v2.y, -75, 75), clamp(_v2.z, -75, 75));
    _v3.set(clamp(_v3.x, -30, 30), clamp(_v3.y, -30, 30), clamp(_v3.z, -30, 30));

    // Duplicate-mesh guard: update kinematics, re-attach if detached, & reset age if already active
    for (let i = 0; i < debrisList.length; i += 1) {
      if (debrisList[i].mesh === mesh) {
        const existing = debrisList[i];
        if (mesh.parent !== debrisGroup) {
          debrisGroup.add(mesh);
        }
        mesh.visible = true;
        mesh.position.copy(_v1);
        mesh.quaternion.copy(_q1);
        existing.vx = _v2.x;
        existing.vy = _v2.y;
        existing.vz = _v2.z;
        existing.avx = _v3.x;
        existing.avy = _v3.y;
        existing.avz = _v3.z;
        existing.age = 0;
        return;
      }
    }

    // FIFO eviction at hard cap (MAX_DEBRIS = 48)
    while (debrisList.length >= MAX_DEBRIS) {
      const oldest = debrisList.shift();
      if (oldest.mesh.parent === debrisGroup) {
        debrisGroup.remove(oldest.mesh);
      }
      disposeDebrisMeshIfOwned(oldest.mesh);
    }

    if (mesh.parent && mesh.parent !== debrisGroup) {
      mesh.parent.remove(mesh);
    }
    mesh.visible = true;
    mesh.position.copy(_v1);
    mesh.quaternion.copy(_q1);
    debrisGroup.add(mesh);

    // Estimate bounce radius once at spawn
    let radius = Number(mesh.userData && mesh.userData.debrisRadius);
    if (!Number.isFinite(radius) || radius <= 0) {
      mesh.updateMatrixWorld(true);
      _box.setFromObject(mesh);
      if (!_box.isEmpty()) {
        const hHalf = (_box.max.y - _box.min.y) * 0.5;
        radius = clamp(hHalf, 0.18, 1.35);
      } else {
        radius = 0.30;
      }
    } else {
      radius = clamp(radius, 0.18, 1.35);
    }

    debrisList.push({
      mesh,
      vx: _v2.x,
      vy: _v2.y,
      vz: _v2.z,
      avx: _v3.x,
      avy: _v3.y,
      avz: _v3.z,
      radius,
      age: 0,
      life: DEBRIS_LIFETIME,
    });
  }

  function spawnCashBurst(pos, amount = 50) {
    if (disposed) return;
    toVec3(pos, _v1, 0, 1.5, 0);
    const amt = clampNum(amount, 1, 999999, 50);
    const tex = getCashTexture(amt);

    const slot = cashPool[cashCursor];
    cashCursor = (cashCursor + 1) % MAX_CASH_SPRITES;
    slot.active = true;
    slot.age = 0;
    slot.life = 1.35;
    slot.vx = (rng() - 0.5) * 1.1;
    slot.vy = 2.6 + rng() * 1.0;
    slot.vz = (rng() - 0.5) * 1.1;

    const sizeMult = amt >= 200 ? 1.30 : 1.0;
    slot.baseW = 2.1 * sizeMult;
    slot.baseH = 1.05 * sizeMult;

    slot.mat.map = tex || null;
    slot.mat.toneMapped = false;
    slot.mat.fog = false;
    slot.mat.opacity = 1.0;
    slot.mat.needsUpdate = true;

    slot.sprite.position.set(
      _v1.x + (rng() - 0.5) * 0.5,
      _v1.y + 0.5,
      _v1.z + (rng() - 0.5) * 0.5,
    );
    slot.sprite.scale.set(slot.baseW * 0.55, slot.baseH * 0.55, 1);
    slot.sprite.visible = true;
  }

  // =========================================================================
  // FIXED-STEP SIMULATION UPDATE (ZERO GC ALLOCATIONS)
  // =========================================================================

  function update(dt, groundYFn) {
    if (disposed) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const stepDt = Math.min(dt, 0.05);

    const sampleGround = (x, z) => {
      if (typeof groundYFn !== 'function') return 0;
      const y = groundYFn(x, z);
      return Number.isFinite(y) ? y : 0;
    };

    // --- 1. Update Sparks (InstancedMesh swap-remove compaction) ---
    if (sparkActive > 0) {
      let i = 0;
      while (i < sparkActive) {
        const p = sparks[i];
        p.age += stepDt;
        if (p.age >= p.life) {
          sparkActive -= 1;
          if (i < sparkActive) {
            const tmp = sparks[i];
            sparks[i] = sparks[sparkActive];
            sparks[sparkActive] = tmp;
          }
          continue;
        }
        p.vy -= 22.0 * stepDt;
        p.x += p.vx * stepDt;
        p.y += p.vy * stepDt;
        p.z += p.vz * stepDt;

        const gY = sampleGround(p.x, p.z) + 0.04;
        if (p.y < gY) {
          p.y = gY;
          if (p.vy < 0) p.vy = -p.vy * 0.45;
          p.vx *= 0.80;
          p.vz *= 0.80;
        }

        const t = p.age / p.life;
        const speed = Math.hypot(p.vx, p.vy, p.vz);
        if (speed > 1e-4) {
          _v2.set(p.vx / speed, p.vy / speed, p.vz / speed);
          _q1.setFromUnitVectors(_zAxis, _v2);
        } else {
          _q1.identity();
        }

        const s = 1.0 - t * 0.75;
        const stretch = clamp(0.6 + speed * 0.10, 0.6, 2.2) * s;
        _v1.set(p.x, p.y, p.z);
        _scaleVec.set(s, s, stretch);
        _m1.compose(_v1, _q1, _scaleVec);
        sparkMesh.setMatrixAt(i, _m1);
        _c1.copy(SPARK_COL_HOT).lerp(SPARK_COL_COOL, t);
        sparkMesh.setColorAt(i, _c1);
        i += 1;
      }
      sparkMesh.count = sparkActive;
      sparkMesh.instanceMatrix.needsUpdate = true;
      if (sparkMesh.instanceColor) sparkMesh.instanceColor.needsUpdate = true;
    } else if (sparkMesh.count !== 0) {
      sparkMesh.count = 0;
    }

    // --- 2. Update Glass Shards (InstancedMesh swap-remove compaction) ---
    if (glassActive > 0) {
      let i = 0;
      while (i < glassActive) {
        const g = glassShards[i];
        g.age += stepDt;
        if (g.age >= g.life) {
          glassActive -= 1;
          if (i < glassActive) {
            const tmp = glassShards[i];
            glassShards[i] = glassShards[glassActive];
            glassShards[glassActive] = tmp;
          }
          continue;
        }
        g.vy -= 20.0 * stepDt;
        g.x += g.vx * stepDt;
        g.y += g.vy * stepDt;
        g.z += g.vz * stepDt;
        g.rx += g.avx * stepDt;
        g.ry += g.avy * stepDt;
        g.rz += g.avz * stepDt;

        const gY = sampleGround(g.x, g.z) + 0.05;
        if (g.y < gY) {
          g.y = gY;
          if (g.vy < -0.5) {
            g.vy = -g.vy * 0.36;
          } else {
            g.vy = 0;
          }
          g.vx *= 0.70;
          g.vz *= 0.70;
          g.avx *= 0.75;
          g.avy *= 0.75;
          g.avz *= 0.75;
        }

        const t = g.age / g.life;
        const sc = g.baseScale * (t > 0.75 ? (1.0 - (t - 0.75) / 0.25) : 1.0);
        _v1.set(g.x, g.y, g.z);
        _e1.set(g.rx, g.ry, g.rz);
        _q1.setFromEuler(_e1);
        _scaleVec.setScalar(Math.max(0.01, sc));
        _m1.compose(_v1, _q1, _scaleVec);
        glassMesh.setMatrixAt(i, _m1);
        glassMesh.setColorAt(i, GLASS_PALETTE[g.colIdx]);
        i += 1;
      }
      glassMesh.count = glassActive;
      glassMesh.instanceMatrix.needsUpdate = true;
      if (glassMesh.instanceColor) glassMesh.instanceColor.needsUpdate = true;
    } else if (glassMesh.count !== 0) {
      glassMesh.count = 0;
    }

    // --- 3. Update Smoke Pool ---
    for (let i = 0; i < MAX_SMOKE; i += 1) {
      const s = smokePool[i];
      if (!s.active) continue;
      s.age += stepDt;
      if (s.age >= s.life) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      const t = s.age / s.life;
      s.mesh.position.x += s.vx * stepDt;
      s.mesh.position.y += s.vy * stepDt;
      s.mesh.position.z += s.vz * stepDt;
      s.mesh.rotation.y += s.spinY * stepDt;
      const sc = s.startScale + (s.endScale - s.startScale) * t;
      s.mesh.scale.setScalar(sc);
      s.mat.opacity = s.peakOpacity * (1.0 - t);
    }

    // --- 4. Update Fire Pool ---
    for (let i = 0; i < MAX_FIRE; i += 1) {
      const f = firePool[i];
      if (!f.active) continue;
      f.age += stepDt;
      if (f.age >= f.life) {
        f.active = false;
        f.mesh.visible = false;
        continue;
      }
      const t = f.age / f.life;
      f.mesh.position.x += f.vx * stepDt;
      f.mesh.position.y += f.vy * stepDt;
      f.mesh.position.z += f.vz * stepDt;
      f.mesh.rotation.y += f.spin * stepDt;

      // Pulse up early, then taper sharply
      const pulse = t < 0.3 ? (0.8 + (t / 0.3) * 0.7) : (1.5 * (1.0 - (t - 0.3) / 0.7));
      f.mesh.scale.setScalar(Math.max(0.05, f.baseScale * pulse));
      if (t < 0.45) {
        f.mat.color.copy(FIRE_COL_BRIGHT).lerp(FIRE_COL_MID, t / 0.45);
      } else {
        f.mat.color.copy(FIRE_COL_MID).lerp(FIRE_COL_DARK, (t - 0.45) / 0.55);
      }
      f.mat.opacity = 0.92 * (1.0 - t);
    }

    // --- 5. Update Dust Pool ---
    for (let i = 0; i < MAX_DUST; i += 1) {
      const d = dustPool[i];
      if (!d.active) continue;
      d.age += stepDt;
      if (d.age >= d.life) {
        d.active = false;
        d.mesh.visible = false;
        continue;
      }
      const t = d.age / d.life;
      const drag = Math.exp(-2.8 * stepDt);
      d.vx *= drag;
      d.vz *= drag;
      d.mesh.position.x += d.vx * stepDt;
      d.mesh.position.y += d.vy * stepDt;
      d.mesh.position.z += d.vz * stepDt;
      const sc = d.startScale + (d.endScale - d.startScale) * t;
      d.mesh.scale.setScalar(sc);
      d.mat.opacity = 0.52 * (1.0 - t);
    }

    // --- 6. Update Explosions (Fireball + Ground Shockwave Ring) ---
    for (let i = 0; i < MAX_EXPLOSIONS; i += 1) {
      const e = expPool[i];
      if (!e.active) continue;
      if (!e.ringSnapped) {
        e.ringSnapped = true;
        e.ring.position.y = Math.min(
          e.ball.position.y,
          Math.max(0.14, sampleGround(e.ball.position.x, e.ball.position.z) + 0.14),
        );
      }
      e.age += stepDt;
      const ballLife = 0.65;
      const ringLife = 0.48;
      if (e.age >= ballLife) {
        e.active = false;
        e.ball.visible = false;
        e.ring.visible = false;
        continue;
      }

      const tb = e.age / ballLife;
      const easeOut = 1.0 - (1.0 - tb) * (1.0 - tb);
      const ballScale = 0.35 + (e.radius * 0.95 - 0.35) * easeOut;
      e.ball.scale.setScalar(ballScale);
      if (tb < 0.4) {
        e.ballMat.color.copy(EXP_COL_START).lerp(EXP_COL_MID, tb / 0.4);
      } else {
        e.ballMat.color.copy(EXP_COL_MID).lerp(EXP_COL_END, (tb - 0.4) / 0.6);
      }
      e.ballMat.opacity = 0.92 * (1.0 - tb);

      if (e.age < ringLife) {
        const tr = e.age / ringLife;
        const ringScale = 0.50 + (e.radius * 2.0 - 0.50) * tr;
        e.ring.scale.setScalar(ringScale);
        e.ringMat.opacity = 0.85 * (1.0 - tr);
      } else {
        e.ring.visible = false;
      }
    }

    // --- 7. Update Nitro Flames (InstancedMesh swap-remove compaction) ---
    if (nitroActive > 0) {
      let i = 0;
      while (i < nitroActive) {
        const nt = nitros[i];
        nt.age += stepDt;
        if (nt.age >= nt.life) {
          nitroActive -= 1;
          if (i < nitroActive) {
            const tmp = nitros[i];
            nitros[i] = nitros[nitroActive];
            nitros[nitroActive] = tmp;
          }
          continue;
        }
        nt.x += nt.vx * stepDt;
        nt.y += nt.vy * stepDt;
        nt.z += nt.vz * stepDt;

        const t = nt.age / nt.life;
        const sc = nt.scale * (1.0 - t * 0.80);
        _v1.set(nt.x, nt.y, nt.z);
        _v2.set(nt.dx, nt.dy, nt.dz);
        _q1.setFromUnitVectors(_zAxis, _v2);
        _scaleVec.set(sc, sc, sc * (1.0 + t * 0.55));
        _m1.compose(_v1, _q1, _scaleVec);
        nitroMesh.setMatrixAt(i, _m1);
        nitroMesh.setColorAt(i, NITRO_PALETTE[nt.colIdx]);
        i += 1;
      }
      nitroMesh.count = nitroActive;
      nitroMesh.instanceMatrix.needsUpdate = true;
      if (nitroMesh.instanceColor) nitroMesh.instanceColor.needsUpdate = true;
    } else if (nitroMesh.count !== 0) {
      nitroMesh.count = 0;
    }

    // --- 8. Update Tumbling 3D Debris ---
    for (let i = debrisList.length - 1; i >= 0; i -= 1) {
      const d = debrisList[i];
      d.age += stepDt;
      if (d.age >= d.life) {
        if (d.mesh.parent === debrisGroup) {
          debrisGroup.remove(d.mesh);
        }
        disposeDebrisMeshIfOwned(d.mesh);
        debrisList.splice(i, 1);
        continue;
      }

      d.vy -= 22.0 * stepDt;
      d.mesh.position.x += d.vx * stepDt;
      d.mesh.position.y += d.vy * stepDt;
      d.mesh.position.z += d.vz * stepDt;

      // Singularity-free quaternion tumble
      const angSpd = Math.hypot(d.avx, d.avy, d.avz);
      if (angSpd > 1e-4) {
        _v2.set(d.avx / angSpd, d.avy / angSpd, d.avz / angSpd);
        _q2.setFromAxisAngle(_v2, Math.min(angSpd * stepDt, 1.2));
        d.mesh.quaternion.premultiply(_q2).normalize();
      }

      const floorY = sampleGround(d.mesh.position.x, d.mesh.position.z) + d.radius;
      if (d.mesh.position.y < floorY) {
        d.mesh.position.y = floorY;
        if (d.vy < -1.1) {
          d.vy = -d.vy * 0.36;
        } else {
          d.vy = 0;
        }
        const linFric = Math.exp(-4.5 * stepDt);
        const angFric = Math.exp(-4.0 * stepDt);
        d.vx *= linFric;
        d.vz *= linFric;
        d.avx *= angFric;
        d.avy *= angFric;
        d.avz *= angFric;
        if (d.vx * d.vx + d.vy * d.vy + d.vz * d.vz < 0.02) {
          d.vx = 0;
          d.vy = 0;
          d.vz = 0;
        }
      }

      // Final NaN guard
      if (
        !Number.isFinite(d.mesh.position.x)
        || !Number.isFinite(d.mesh.position.y)
        || !Number.isFinite(d.mesh.position.z)
      ) {
        d.mesh.position.set(0, floorY, 0);
        d.vx = 0;
        d.vy = 0;
        d.vz = 0;
      }
    }

    // --- 9. Update Floating Cash Sprites ---
    for (let i = 0; i < MAX_CASH_SPRITES; i += 1) {
      const c = cashPool[i];
      if (!c.active) continue;
      c.age += stepDt;
      if (c.age >= c.life) {
        c.active = false;
        c.sprite.visible = false;
        c.mat.map = null;
        continue;
      }
      const t = c.age / c.life;
      c.sprite.position.x += c.vx * stepDt;
      c.sprite.position.y += c.vy * stepDt;
      c.sprite.position.z += c.vz * stepDt;
      c.vy *= Math.exp(-1.1 * stepDt);

      // Pop-in scale 0.55 -> 1.15 -> 1.0
      let pop = 1.0;
      if (t < 0.16) {
        pop = 0.55 + (t / 0.16) * 0.60;
      } else if (t < 0.32) {
        pop = 1.15 - ((t - 0.16) / 0.16) * 0.15;
      }
      c.sprite.scale.set(c.baseW * pop, c.baseH * pop, 1);
      c.mat.opacity = t < 0.65 ? 1.0 : Math.max(0, 1.0 - (t - 0.65) / 0.35);
    }
  }

  function clearDebris() {
    for (let i = 0; i < debrisList.length; i += 1) {
      const mesh = debrisList[i].mesh;
      if (mesh.parent === debrisGroup) {
        debrisGroup.remove(mesh);
      }
      disposeDebrisMeshIfOwned(mesh);
    }
    debrisList.length = 0;
  }

  function getActiveDebrisCount() {
    return debrisList.length;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearDebris();
    if (fxRoot.parent) {
      fxRoot.parent.remove(fxRoot);
    }
    for (let i = 0; i < MAX_CASH_SPRITES; i += 1) {
      cashPool[i].active = false;
      cashPool[i].sprite.visible = false;
      cashPool[i].mat.map = null;
    }
    sparkMesh.count = 0;
    glassMesh.count = 0;
    nitroMesh.count = 0;
    skidMesh.count = 0;
    sparkMesh.dispose();
    glassMesh.dispose();
    nitroMesh.dispose();
    skidMesh.dispose();
    for (let i = 0; i < ownedGeoms.length; i += 1) {
      ownedGeoms[i].dispose();
    }
    for (let i = 0; i < ownedMats.length; i += 1) {
      ownedMats[i].dispose();
    }
    for (const tex of cashTexCache.values()) {
      tex.dispose();
    }
    cashTexCache.clear();
    ownedGeoms.length = 0;
    ownedMats.length = 0;
    sparkActive = 0;
    glassActive = 0;
    nitroActive = 0;
    skidCount = 0;
  }

  return {
    emitSparks,
    emitGlass,
    emitSmoke,
    emitFire,
    emitExplosion,
    emitDust,
    emitNitro,
    addSkidMark,
    spawnDebris,
    spawnCashBurst,
    update,
    clearDebris,
    getActiveDebrisCount,
    dispose,
  };
}
