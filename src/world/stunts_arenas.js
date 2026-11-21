/**
 * Stunt Ramps, Arenas, Cash Rings, Self-Contained Derby AI Cars & C4/Crash Test Wall:
 *   1. ski_jump       — Giant Ski Jump (24.0m -> 7.0m launch scoop), snowy peaks, 50-1500 signs
 *   2. mega_ramp      — Mega Incline Ramp (0.0m -> 8.0m), 360° Silver Loop, Rainbow Wall, Pink Spiral, Cash Rings
 *   3. derby_arena    — Banked Multicolored-Tile Oval Stadium, 4 Grandstands & 3 Roaming AI Crash Cars (incl. Mikey_Turtle)
 *   4. crash_c4_wall  — Blue-Lined Runway, Shallow Water Basin, Breakable 15-Block C4 Wall & Blue/White Crash Barrier
 *
 * Self-contained M2B WorldSection (zero imports from avatars.js / vehicle_mesh.js / particles.js).
 * Exports exact analytical SurfaceRegions matching rendered meshes, strictly caps non-IBL
 * metalness <= 0.20 via createStandardMaterial(), and sets toneMapped: false, fog: false on all Sprites.
 */

import * as THREE from '../../vendor/three.module.min.js';
import { createStandardMaterial } from '../core/materials.js';
import { getZoneById } from '../data/zones.js';

const TWO_PI = Math.PI * 2;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function wrapAngle(a) {
  if (typeof a !== 'number' || !Number.isFinite(a)) return 0;
  return ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function bevel1D(v, lo, hi, margin = 3.0) {
  if (v <= lo || v >= hi) return { val: 0, deriv: 0 };
  if (v < lo + margin) {
    const s = (v - lo) / margin;
    return { val: s * s * (3 - 2 * s), deriv: (6 * s * (1 - s)) / margin };
  }
  if (v > hi - margin) {
    const s = (hi - v) / margin;
    return { val: s * s * (3 - 2 * s), deriv: -(6 * s * (1 - s)) / margin };
  }
  return { val: 1, deriv: 0 };
}

// ===========================================================================
// ANALYTICAL SURFACE FUNCTIONS (Single Source of Truth for Meshes & Physics)
// ===========================================================================

function sampleSkiJump(x, z) {
  if (x < -193.5 || x > -176.5 || z < -176.0 || z > -124.0) return null;
  if (z <= -165.0) {
    return { y: 24.0, gx: 0, gz: 0 };
  }
  if (z <= -132.0) {
    const t = (z + 165.0) / 33.0;
    return {
      y: 24.0 - 9.4 * (1 - Math.cos(Math.PI * t)),
      gx: 0,
      gz: -9.4 * (Math.PI / 33.0) * Math.sin(Math.PI * t),
    };
  }
  const u = (z + 132.0) / 8.0;
  return {
    y: 5.2 + 1.8 * u * u,
    gx: 0,
    gz: 0.45 * u,
  };
}

function sampleMegaRamp(x, z) {
  if (x < -8.5 || x > 8.5 || z < 132.0 || z > 162.0) return null;
  const u = (z - 132.0) / 30.0;
  const su = Math.sqrt(Math.max(0, u));
  return {
    y: 8.0 * u * su,
    gx: 0,
    gz: 0.40 * su,
  };
}

function sampleRainbowWall(x, z) {
  if (x < -44.0 || x > -24.0 || z < 166.0 || z > 186.0) return null;
  const u = (z - 166.0) / 20.0;
  return {
    y: 8.5 * u * u,
    gx: 0,
    gz: 0.85 * u,
  };
}

const DERBY_CX = 160.0;
const DERBY_CZ = 168.0;
const DERBY_RX = 38.0;
const DERBY_RZ = 42.0;

function sampleDerbyArena(x, z) {
  const dx = x - DERBY_CX;
  const dz = z - DERBY_CZ;
  const nx = dx / DERBY_RX;
  const nz = dz / DERBY_RZ;
  const rho = Math.hypot(nx, nz);
  if (rho <= 0.74 || rho >= 1.18) return null;

  const theta = Math.atan2(dx, -dz); // 0 at North entrance (dx=0, dz<0)
  const a = Math.abs(theta);
  if (a <= 0.18) {
    return { y: 0, gx: 0, gz: 0 };
  }

  let f;
  let dfdr;
  if (rho <= 1.0) {
    const u = (rho - 0.74) / 0.26;
    f = 5.6 * u * u;
    dfdr = (11.2 * u) / 0.26;
  } else {
    const w = (rho - 1.0) / 0.18;
    f = 2.8 * (1 + Math.cos(Math.PI * w));
    dfdr = -2.8 * (Math.PI / 0.18) * Math.sin(Math.PI * w);
  }

  const drhoDx = nx / (rho * DERBY_RX);
  const drhoDz = nz / (rho * DERBY_RZ);

  let gate = 1.0;
  let dgateDx = 0.0;
  let dgateDz = 0.0;
  if (a < 0.36) {
    const s = (a - 0.18) / 0.18;
    gate = s * s * (3 - 2 * s);
    const dgda = (6 * s * (1 - s)) / 0.18;
    const r2 = dx * dx + dz * dz;
    if (r2 > 1e-8) {
      const sgn = theta >= 0 ? 1 : -1;
      dgateDx = dgda * sgn * (-dz / r2);
      dgateDz = dgda * sgn * (dx / r2);
    }
  }

  return {
    y: f * gate,
    gx: dfdr * drhoDx * gate + f * dgateDx,
    gz: dfdr * drhoDz * gate + f * dgateDz,
  };
}

function sampleC4WaterBasin(x, z) {
  if (x < 172.0 || x > 204.0 || z < 21.0 || z > 49.0) return null;
  const bx = bevel1D(x, 172.0, 204.0, 3.0);
  const bz = bevel1D(z, 21.0, 49.0, 3.0);
  return {
    y: -0.45 * bx.val * bz.val,
    gx: -0.45 * bx.deriv * bz.val,
    gz: -0.45 * bx.val * bz.deriv,
  };
}

// ===========================================================================
// PRIVATE PROCEDURAL CANVAS TEXTURES (Tracked & Disposed Internally)
// ===========================================================================

function makeCrashBarrierTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#1565c0';
  for (let x = 0; x < 256; x += 64) {
    ctx.fillRect(x, 0, 32, 256);
  }
  // Horizontal calibration target band
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 118, 256, 20);
  ctx.fillStyle = '#facc15';
  for (let x = 8; x < 256; x += 32) {
    ctx.fillRect(x, 122, 16, 12);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function makeC4SmileyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#facc15';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, 242, 242);

  // Cartoon smiling eyes
  ctx.fillStyle = '#111827';
  ctx.beginPath();
  ctx.arc(88, 96, 18, 0, Math.PI * 2);
  ctx.arc(168, 96, 18, 0, Math.PI * 2);
  ctx.fill();

  // Wide playful grin
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(128, 124, 58, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  // Corner C4 badge
  ctx.fillStyle = '#dc2626';
  ctx.fillRect(172, 184, 64, 52);
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('C4', 204, 211);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function makeNametagTexture(label, accentHex = '#4ade80') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(8, 8, 240, 48, 20);
  } else {
    ctx.rect(8, 8, 240, 48);
  }
  ctx.fill();
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = accentHex;
  ctx.beginPath();
  ctx.arc(34, 32, 9, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 24px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 52, 33, 186);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ===========================================================================
// CUSTOM ANALYTICAL MESH GEOMETRY BUILDERS
// ===========================================================================

function buildProfileRibbonGeometry(width, zStart, zEnd, steps, yFn, vRepeat = 1) {
  const halfW = width * 0.5;
  const positions = new Float32Array((steps + 1) * 2 * 3);
  const uvs = new Float32Array((steps + 1) * 2 * 2);
  const indices = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const z = zStart + (zEnd - zStart) * t;
    const y = yFn(z);
    const b = i * 2;
    positions[b * 3] = -halfW;
    positions[b * 3 + 1] = y;
    positions[b * 3 + 2] = z;
    uvs[b * 2] = 0;
    uvs[b * 2 + 1] = t * vRepeat;

    positions[(b + 1) * 3] = halfW;
    positions[(b + 1) * 3 + 1] = y;
    positions[(b + 1) * 3 + 2] = z;
    uvs[(b + 1) * 2] = 1;
    uvs[(b + 1) * 2 + 1] = t * vRepeat;

    if (i < steps) {
      indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildCurvedWallRibbonGeometry(xInner, flareOut, height, zStart, zEnd, steps, yFn) {
  // Double-sided flared guard wall following yFn(z)
  const positions = new Float32Array((steps + 1) * 2 * 3);
  const uvs = new Float32Array((steps + 1) * 2 * 2);
  const indices = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const z = zStart + (zEnd - zStart) * t;
    const y = yFn(z);
    const b = i * 2;
    positions[b * 3] = xInner;
    positions[b * 3 + 1] = y - 0.1;
    positions[b * 3 + 2] = z;
    uvs[b * 2] = t * 6;
    uvs[b * 2 + 1] = 0;

    positions[(b + 1) * 3] = xInner + flareOut;
    positions[(b + 1) * 3 + 1] = y + height;
    positions[(b + 1) * 3 + 2] = z;
    uvs[(b + 1) * 2] = t * 6;
    uvs[(b + 1) * 2 + 1] = 1;

    if (i < steps) {
      indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildDerbyRingGeometry(rhoMin, rhoMax, angSteps, radSteps, uRep, vRep) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const stride = radSteps + 1;

  for (let i = 0; i <= angSteps; i += 1) {
    const uFrac = i / angSteps;
    const angle = uFrac * Math.PI * 2; // 0 = North, PI/2 = East
    for (let j = 0; j <= radSteps; j += 1) {
      const vFrac = j / radSteps;
      const rho = rhoMin + (rhoMax - rhoMin) * vFrac;
      const x = DERBY_CX + DERBY_RX * rho * Math.sin(angle);
      const z = DERBY_CZ - DERBY_RZ * rho * Math.cos(angle);
      const s = sampleDerbyArena(x, z);
      const y = s ? s.y : 0;
      positions.push(x, y, z);
      uvs.push(uFrac * uRep, vFrac * vRep);
    }
  }

  for (let i = 0; i < angSteps; i += 1) {
    // Skip North entrance opening (|angle around 0 or 2PI| < 0.17 rad)
    const midAngle = ((i + 0.5) / angSteps) * Math.PI * 2;
    const distFromNorth = Math.min(midAngle, Math.PI * 2 - midAngle);
    if (distFromNorth < 0.17) continue;

    for (let j = 0; j < radSteps; j += 1) {
      const v00 = i * stride + j;
      const v10 = (i + 1) * stride + j;
      const v01 = i * stride + (j + 1);
      const v11 = (i + 1) * stride + (j + 1);
      // (+angle) x (+radial) = +Y UP & INWARD
      indices.push(v00, v10, v01, v10, v11, v01);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function normalizeVehInput(raw) {
  if (!raw || typeof raw !== 'object' || raw.valid === false) {
    return { valid: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, radius: 2.0 };
  }
  if (raw.valid === true && typeof raw.x === 'number' && typeof raw.z === 'number') {
    return raw;
  }
  const pos = raw.position || raw.pos;
  const x = Array.isArray(pos) ? pos[0] : pos?.x;
  const y = Array.isArray(pos) ? pos[1] : pos?.y;
  const z = Array.isArray(pos) ? pos[2] : pos?.z;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return { valid: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, radius: 2.0 };
  }
  const vel = raw.velocity || raw.vel;
  const rvx = Array.isArray(vel) ? vel[0] : vel?.x;
  const rvy = Array.isArray(vel) ? vel[1] : vel?.y;
  const rvz = Array.isArray(vel) ? vel[2] : vel?.z;
  const vx = Number.isFinite(rvx) ? rvx : 0;
  const vy = Number.isFinite(rvy) ? rvy : 0;
  const vz = Number.isFinite(rvz) ? rvz : 0;
  const speed = Number.isFinite(raw.speed) ? raw.speed : Math.hypot(vx, vy, vz);
  const w = Number.isFinite(raw.dimensions?.w) ? raw.dimensions.w : 2.1;
  const l = Number.isFinite(raw.dimensions?.l) ? raw.dimensions.l : 4.5;
  const radius = Number.isFinite(raw.radius) ? raw.radius : Math.max(w, l) * 0.44;
  return { valid: true, x, y, z, vx, vy, vz, speed, radius };
}

/**
 * Builds Ski Jump, Mega Ramp + 360° Silver Loop + Rainbow Wall + Cash Rings,
 * Banked Multicolored Derby Arena + 3 Self-Contained AI Cars (incl. Mikey_Turtle),
 * and Crash Test & Breakable C4 Explosives Wall.
 *
 * @param {THREE.Scene} scene
 * @param {ReturnType<import('./textures.js').createTextureLibrary>} textures
 */
export function createStuntsAndArenas(scene, textures) {
  const group = new THREE.Group();
  group.name = 'stunts_arenas_root';

  const ownedGeometries = new Set();
  const ownedMaterials = new Set();
  const ownedTextures = new Set();

  const trackGeo = (g) => {
    ownedGeometries.add(g);
    return g;
  };
  const trackMat = (m) => {
    ownedMaterials.add(m);
    return m;
  };
  const trackTex = (t) => {
    ownedTextures.add(t);
    return t;
  };
  const cloneTex = (baseTex, rx = 1, ry = 1) => {
    const t = baseTex.clone();
    t.repeat.set(rx, ry);
    t.needsUpdate = true;
    ownedTextures.add(t);
    return t;
  };

  // Shared materials (strictly metalness <= 0.20 via createStandardMaterial!)
  const whiteMat = trackMat(createStandardMaterial({ color: 0xf4f7fb, metalness: 0.06, roughness: 0.45, side: THREE.DoubleSide }, scene));
  const concreteMat = trackMat(createStandardMaterial({ map: cloneTex(textures.concretePad, 2, 4), metalness: 0.04, roughness: 0.82 }, scene));
  const concretePillarMat = trackMat(createStandardMaterial({ map: cloneTex(textures.concretePad, 1, 3), metalness: 0.04, roughness: 0.86 }, scene));
  const darkSteelMat = trackMat(createStandardMaterial({ color: 0x1e293b, metalness: 0.18, roughness: 0.42 }, scene));
  const hazardMat = trackMat(createStandardMaterial({ map: cloneTex(textures.hazardStripes, 6, 1), metalness: 0.08, roughness: 0.54 }, scene));
  const hazardCurbMat = trackMat(createStandardMaterial({
    map: cloneTex(textures.hazardStripes, 6, 1),
    metalness: 0.08,
    roughness: 0.54,
    side: THREE.DoubleSide,
  }, scene));
  const rockMat = trackMat(createStandardMaterial({ color: 0x607d8b, metalness: 0.04, roughness: 0.88 }, scene));
  const snowMat = trackMat(createStandardMaterial({ color: 0xf8fafc, metalness: 0.02, roughness: 0.78 }, scene));
  const silverLoopMat = trackMat(createStandardMaterial({ color: 0xdbe4ee, metalness: 0.18, roughness: 0.34 }, scene));
  const pinkSpiralMat = trackMat(createStandardMaterial({ color: 0xec407a, metalness: 0.12, roughness: 0.38 }, scene));
  const blueLineMat = trackMat(createStandardMaterial({ color: 0x1e88e5, metalness: 0.08, roughness: 0.45 }, scene));
  const redC4Mat = trackMat(createStandardMaterial({ color: 0xdc2626, metalness: 0.12, roughness: 0.40 }, scene));
  const c4BlockMat = trackMat(createStandardMaterial({ color: 0x64748b, metalness: 0.06, roughness: 0.78 }, scene));
  const ledOffMat = trackMat(createStandardMaterial({ color: 0x7f1d1d, metalness: 0.10, roughness: 0.40 }, scene));
  const ledOnMat = trackMat(createStandardMaterial({
    color: 0xff1744,
    emissive: 0xff1744,
    emissiveIntensity: 0.90,
    metalness: 0.10,
    roughness: 0.25,
  }, scene));
  const waterMat = trackMat(createStandardMaterial({
    color: 0x29b6f6,
    transparent: true,
    opacity: 0.58,
    metalness: 0.10,
    roughness: 0.22,
  }, scene));

  const crashBarrierTex = trackTex(makeCrashBarrierTexture());
  crashBarrierTex.repeat.set(3, 1);
  const crashBarrierMat = trackMat(createStandardMaterial({ map: crashBarrierTex, metalness: 0.08, roughness: 0.52 }, scene));
  const c4SmileyTex = trackTex(makeC4SmileyTexture());
  const c4SmileyMat = trackMat(createStandardMaterial({
    map: c4SmileyTex,
    emissive: 0x332b00,
    emissiveMap: c4SmileyTex,
    emissiveIntensity: 0.20,
    metalness: 0.04,
    roughness: 0.50,
  }, scene));

  const makeSignBoard = (title, subtitle, bg, fg, w, h, doubleSided = true) => {
    const tex = textures.makeSignTexture(title, subtitle, bg, fg);
    const mat = trackMat(createStandardMaterial({
      map: tex,
      emissive: 0x222222,
      emissiveMap: tex,
      emissiveIntensity: 0.26,
      roughness: 0.62,
      metalness: 0.04,
      side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    }, scene));
    return new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(w, h)), mat);
  };

  // =========================================================================
  // ZONE A: GIANT SKI JUMP ([-185, 24.5, -168] -> [-185, 7.0, -124])
  // =========================================================================
  const skiGroup = new THREE.Group();
  skiGroup.name = 'zone_ski_jump';
  group.add(skiGroup);

  const skiYFn = (z) => {
    const s = sampleSkiJump(-185, z);
    return s ? s.y : 0;
  };

  // Asphalt runway ribbon matching sampleSkiJump(x, z) to 0.000m (single UV repeat in geometry only)
  const skiAsphaltTex = cloneTex(textures.asphaltRoad, 1, 1);
  const skiDeckMat = trackMat(createStandardMaterial({
    map: skiAsphaltTex,
    color: 0x9aa4b2,
    metalness: 0.05,
    roughness: 0.82,
  }, scene));
  const skiDeck = new THREE.Mesh(trackGeo(buildProfileRibbonGeometry(17.0, -176.0, -124.0, 36, skiYFn, 8)), skiDeckMat);
  skiDeck.name = 'ski_jump_runway';
  skiDeck.position.x = -185.0;
  skiDeck.receiveShadow = true;
  skiGroup.add(skiDeck);

  // Curved white side walls along x = -185 +- 8.6
  const skiWallL = new THREE.Mesh(trackGeo(buildCurvedWallRibbonGeometry(-185.0 - 8.6, -0.55, 2.4, -176.0, -124.0, 36, skiYFn)), whiteMat);
  const skiWallR = new THREE.Mesh(trackGeo(buildCurvedWallRibbonGeometry(-185.0 + 8.6, 0.55, 2.4, -176.0, -124.0, 36, skiYFn)), whiteMat);
  skiGroup.add(skiWallL, skiWallR);

  // Start box back wall at z = -176 (8.0m behind spawnPos z=-168)
  const skiBackWall = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(18.4, 3.0, 0.8)), whiteMat);
  skiBackWall.position.set(-185.0, 25.4, -176.3);
  skiGroup.add(skiBackWall);

  // Overhead "SKI JUMP / 50 - 1500 STUDS" gantry at z = -164, y = 33.0 (8.8m headroom)
  for (const sx of [-193.8, -176.2]) {
    const post = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.9, 10.4, 0.9)), darkSteelMat);
    post.position.set(sx, 29.0, -164.0);
    skiGroup.add(post);
  }
  const skiSign = makeSignBoard('GIANT SKI JUMP', '50 - 1500 STUDS', '#0284c7', '#ffffff', 14.0, 3.0, true);
  skiSign.position.set(-185.0, 33.0, -164.0);
  skiSign.rotation.y = Math.PI; // readable facing +Z from spawnPos
  skiGroup.add(skiSign);

  // 5 Concrete support pylons grounding the ski jump deck (min deck height over Z footprint so corners stay below deck!)
  for (const pz of [-173, -162, -150, -138, -126]) {
    const h = Math.max(1.0, Math.min(skiYFn(pz - 1.7), skiYFn(pz + 1.7)) - 0.25);
    const pylon = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(15.6, h, 3.4)), concretePillarMat);
    pylon.position.set(-185.0, h * 0.5, pz);
    pylon.castShadow = true;
    skiGroup.add(pylon);
  }

  // 8 Dramatic Snowy Mountain Peaks flanking West, North, and East of chute (staying west of x=-136!)
  const peakSpecs = [
    [-216, -184, 20, 44],
    [-218, -150, 17, 36],
    [-212, -122, 15, 28],
    [-185, -206, 24, 48],
    [-156, -196, 18, 40],
    [-154, -160, 16, 34],
    [-154, -130, 14, 24],
    [-204, -204, 18, 42],
  ];
  for (let i = 0; i < peakSpecs.length; i += 1) {
    const [px, pz, rad, h] = peakSpecs[i];
    const rock = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(rad, h, 7)), rockMat);
    rock.position.set(px, h * 0.5, pz);
    skiGroup.add(rock);
    const capH = h * 0.36;
    const cap = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(rad * 0.37, capH, 7)), snowMat);
    cap.position.set(px, h - capH * 0.48, pz);
    skiGroup.add(cap);
  }

  // 6 Pairs of color-coded distance marker signs (50, 100, 300, 500, 750, 1500) + grass landing stripes
  const markerSpecs = [
    { label: '50', color: '#fdd835', hex: 0xfdd835, z: -104 },
    { label: '100', color: '#43a047', hex: 0x43a047, z: -82 },
    { label: '300', color: '#2e7d32', hex: 0x2e7d32, z: -52 },
    { label: '500', color: '#c0ca33', hex: 0xc0ca33, z: -18 },
    { label: '750', color: '#fb8c00', hex: 0xfb8c00, z: 20 },
    { label: '1500', color: '#e53935', hex: 0xe53935, z: 62 },
  ];
  const signPostGeo = trackGeo(new THREE.BoxGeometry(0.32, 3.2, 0.24));
  const signBoardGeo = trackGeo(new THREE.BoxGeometry(6.2, 4.4, 0.35));
  const stripeGeo = trackGeo(new THREE.PlaneGeometry(26.0, 0.9));

  for (let i = 0; i < markerSpecs.length; i += 1) {
    const mk = markerSpecs[i];
    const numTex = textures.makeNumberTexture(mk.label, mk.color);
    const numMat = trackMat(createStandardMaterial({
      map: numTex,
      emissive: 0x222222,
      emissiveMap: numTex,
      emissiveIntensity: 0.24,
      roughness: 0.52,
      metalness: 0.04,
    }, scene));
    const stripeMat = trackMat(createStandardMaterial({ color: mk.hex, roughness: 0.72, metalness: 0.04 }, scene));

    const groundStripe = new THREE.Mesh(stripeGeo, stripeMat);
    groundStripe.rotation.x = -Math.PI / 2;
    groundStripe.position.set(-185.0, 0.04, mk.z);
    skiGroup.add(groundStripe);

    for (const side of [-1, 1]) {
      const sx = -185.0 + side * 14.5;
      for (const pxOff of [-2.2, 2.2]) {
        const post = new THREE.Mesh(signPostGeo, darkSteelMat);
        post.position.set(sx + pxOff, 1.6, mk.z);
        skiGroup.add(post);
      }
      const board = new THREE.Mesh(signBoardGeo, numMat);
      board.position.set(sx, 5.2, mk.z);
      skiGroup.add(board);
    }
  }

  // =========================================================================
  // ZONE B: MEGA RAMP, 360° SILVER LOOP, RAINBOW WALL, PINK SPIRAL & CASH RINGS
  // =========================================================================
  const megaGroup = new THREE.Group();
  megaGroup.name = 'zone_mega_ramp';
  group.add(megaGroup);

  // Approach concrete pad (z in [116, 132]) + landing target apron (z in [192, 222])
  const megaApproach = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(20.0, 0.05, 16.0)), concreteMat);
  megaApproach.position.set(0, 0.0, 124.0);
  megaApproach.receiveShadow = true;
  megaGroup.add(megaApproach);

  const megaLanding = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(24.0, 0.05, 30.0)), concreteMat);
  megaLanding.position.set(0, 0.0, 207.0);
  megaLanding.receiveShadow = true;
  megaGroup.add(megaLanding);

  const megaLandingTrim = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(24.2, 0.06, 1.4)), hazardMat);
  megaLandingTrim.position.set(0, 0.01, 192.5);
  megaGroup.add(megaLandingTrim);

  // Main steep grey Mega Incline Ramp matching sampleMegaRamp(x, z) (vRepeat=1 since concreteMat repeats 2x4)
  const megaYFn = (z) => {
    const s = sampleMegaRamp(0, z);
    return s ? s.y : 0;
  };
  const megaDeck = new THREE.Mesh(trackGeo(buildProfileRibbonGeometry(17.0, 132.0, 162.0, 20, megaYFn, 1)), concreteMat);
  megaDeck.name = 'mega_ramp_deck';
  megaDeck.receiveShadow = true;
  megaGroup.add(megaDeck);

  // Double-sided yellow/black hazard edge curbs along Mega Ramp (visible both inside driving lane & outside!)
  const megaCurbL = new THREE.Mesh(trackGeo(buildCurvedWallRibbonGeometry(-8.5, -0.25, 0.75, 132.0, 162.0, 20, megaYFn)), hazardCurbMat);
  megaCurbL.name = 'mega_ramp_curb_l';
  const megaCurbR = new THREE.Mesh(trackGeo(buildCurvedWallRibbonGeometry(8.5, 0.25, 0.75, 132.0, 162.0, 20, megaYFn)), hazardCurbMat);
  megaCurbR.name = 'mega_ramp_curb_r';
  megaGroup.add(megaCurbL, megaCurbR);

  // Concrete support piers under Mega Ramp (min deck height over Z footprint so piers never poke through!)
  for (const pz of [144, 152, 160]) {
    const h = Math.max(0.8, Math.min(megaYFn(pz - 1.3), megaYFn(pz + 1.3)) - 0.20);
    const pier = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(16.0, h, 2.6)), concretePillarMat);
    pier.position.set(0, h * 0.5, pz);
    pier.castShadow = true;
    megaGroup.add(pier);
  }

  // Overhead "MEGA RAMP / FULL THROTTLE!" gantry sign at z = 130, y = 9.6 (wide open sightline underneath!)
  for (const mx of [-9.4, 9.4]) {
    const p = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.9, 10.6, 0.9)), darkSteelMat);
    p.position.set(mx, 5.3, 130.0);
    megaGroup.add(p);
  }
  const megaSign = makeSignBoard('MEGA RAMP', 'FULL THROTTLE!', '#7e22ce', '#fde047', 14.0, 2.8, true);
  megaSign.position.set(0, 9.6, 130.0);
  megaSign.rotation.y = Math.PI;
  megaGroup.add(megaSign);

  // Tall Bright Silver 360° Loop-de-Loop Arch (East flank center [+26, 15.0, 162], R = 14.5m, metalness: 0.18!)
  const LOOP_CX = 26.0;
  const LOOP_CY = 15.0;
  const LOOP_CZ = 162.0;
  const LOOP_R = 14.5;
  const loopSegGeo = trackGeo(new THREE.BoxGeometry(6.8, 0.48, 3.1));
  const loopSteps = 32;
  for (let i = 0; i < loopSteps; i += 1) {
    const t = i / loopSteps;
    const theta = t * Math.PI * 2;
    const lx = LOOP_CX - 3.2 + 6.4 * t;
    const ly = LOOP_CY - LOOP_R * Math.cos(theta);
    const lz = LOOP_CZ + LOOP_R * Math.sin(theta);
    const seg = new THREE.Mesh(loopSegGeo, silverLoopMat);
    seg.position.set(lx, ly, lz);
    seg.rotation.x = -theta;
    seg.castShadow = i % 4 === 0;
    megaGroup.add(seg);
  }
  // Loop entry/exit flat ramps + A-frame struts + sign
  const loopEntry = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(6.8, 0.42, 18.0)), silverLoopMat);
  loopEntry.position.set(22.8, 0.25, 148.0);
  megaGroup.add(loopEntry);
  const loopExit = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(6.8, 0.42, 18.0)), silverLoopMat);
  loopExit.position.set(29.2, 0.25, 176.0);
  megaGroup.add(loopExit);

  for (const sz of [148, 176]) {
    const strut = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.9, 15.6, 0.9)), hazardMat);
    strut.position.set(LOOP_CX, 7.8, sz);
    megaGroup.add(strut);
  }
  const loopSign = makeSignBoard('360° SILVER LOOP', 'KEEP SPEED HIGH!', '#334155', '#e2e8f0', 9.0, 2.4, true);
  loopSign.position.set(22.8, 7.2, 144.0);
  loopSign.rotation.y = Math.PI;
  megaGroup.add(loopSign);

  // Curved Rainbow Wall (West flank: x in [-44, -24], z in [166, 186])
  const rainbowYFn = (z) => {
    const s = sampleRainbowWall(-34, z);
    return s ? s.y : 0;
  };
  const rainbowTex = cloneTex(textures.rainbowStripe, 1, 1);
  const rainbowMat = trackMat(createStandardMaterial({ map: rainbowTex, metalness: 0.08, roughness: 0.42 }, scene));
  const rainbowDeck = new THREE.Mesh(trackGeo(buildProfileRibbonGeometry(20.0, 166.0, 186.0, 16, rainbowYFn, 1)), rainbowMat);
  rainbowDeck.position.x = -34.0;
  rainbowDeck.receiveShadow = true;
  megaGroup.add(rainbowDeck);

  const rainbowBack = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(20.0, 6.2, 1.0)), rainbowMat);
  rainbowBack.position.set(-34.0, 11.5, 186.5);
  megaGroup.add(rainbowBack);
  const rainbowUnder = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(19.6, 8.4, 1.0)), concretePillarMat);
  rainbowUnder.position.set(-34.0, 4.2, 186.5);
  megaGroup.add(rainbowUnder);

  const rainbowSign = makeSignBoard('RAINBOW WALL', 'STUNT QUARTER-PIPE', '#db2777', '#ffffff', 12.0, 2.6, true);
  rainbowSign.position.set(-34.0, 16.0, 186.2);
  rainbowSign.rotation.y = Math.PI;
  megaGroup.add(rainbowSign);

  // Pink Spiral Stunt Ramp (center [-30, 0, 140], radius 10.5m, 1.1 turns rising 0.2 -> 10.5m)
  const spiralSegGeo = trackGeo(new THREE.BoxGeometry(4.6, 0.36, 3.2));
  const spiralSteps = 24;
  for (let i = 0; i < spiralSteps; i += 1) {
    const t = i / (spiralSteps - 1);
    const ang = t * Math.PI * 2.2;
    const sx = -30.0 + Math.cos(ang) * 10.5;
    const sz = 140.0 + Math.sin(ang) * 10.5;
    const sy = 0.25 + t * 10.25;
    const seg = new THREE.Mesh(spiralSegGeo, pinkSpiralMat);
    seg.position.set(sx, sy, sz);
    seg.rotation.order = 'YXZ';
    seg.rotation.y = -ang;
    seg.rotation.x = -0.14;
    megaGroup.add(seg);
    if (i % 4 === 0 && sy > 1.2) {
      const col = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.42, 0.48, sy, 8)), whiteMat);
      col.position.set(sx, sy * 0.5, sz);
      megaGroup.add(col);
    }
  }

  // Rotating Glowing Pass-Through Cash Bonus Rings (4 in mega_ramp + 1 in ski_jump!)
  const greenRingMat = trackMat(createStandardMaterial({
    color: 0x22c55e,
    emissive: 0x16a34a,
    emissiveIntensity: 0.44,
    metalness: 0.16,
    roughness: 0.28,
  }, scene));
  const goldRingMat = trackMat(createStandardMaterial({
    color: 0xfacc15,
    emissive: 0xd97706,
    emissiveIntensity: 0.44,
    metalness: 0.16,
    roughness: 0.28,
  }, scene));

  const ringSpecs = [
    { id: 'mega_mid', x: 0, y: 5.4, z: 150, radius: 4.2, cashBonus: 50, xpBonus: 25 },
    { id: 'mega_air', x: 0, y: 11.2, z: 174, radius: 5.0, cashBonus: 100, xpBonus: 40 },
    { id: 'loop_entry', x: 22.8, y: 4.4, z: 150, radius: 4.4, cashBonus: 100, xpBonus: 40 },
    { id: 'rainbow_climb', x: -34, y: 4.8, z: 174, radius: 4.4, cashBonus: 50, xpBonus: 25 },
    { id: 'ski_air', x: -185, y: 10.5, z: -104, radius: 5.5, cashBonus: 100, xpBonus: 45 },
  ];

  const cashRings = ringSpecs.map((spec) => {
    const isGold = spec.cashBonus >= 100;
    const rGroup = new THREE.Group();
    rGroup.name = `cash_ring_${spec.id}`;
    rGroup.position.set(spec.x, spec.y, spec.z);

    const torus = new THREE.Mesh(
      trackGeo(new THREE.TorusGeometry(spec.radius, 0.36, 10, 24)),
      isGold ? goldRingMat : greenRingMat,
    );
    rGroup.add(torus);

    const plaqueTex = textures.makeNumberTexture(isGold ? '+$100' : '+$50', isGold ? '#f59e0b' : '#2e7d32');
    const plaqueMat = trackMat(createStandardMaterial({
      map: plaqueTex,
      emissive: 0x222222,
      emissiveMap: plaqueTex,
      emissiveIntensity: 0.30,
      roughness: 0.42,
      metalness: 0.06,
      side: THREE.FrontSide,
    }, scene));
    const plaqueGeo = trackGeo(new THREE.PlaneGeometry(2.6, 2.6));
    const plaqueF = new THREE.Mesh(plaqueGeo, plaqueMat);
    plaqueF.position.set(0, spec.radius + 1.5, 0.05);
    rGroup.add(plaqueF);
    const plaqueB = new THREE.Mesh(plaqueGeo, plaqueMat);
    plaqueB.position.set(0, spec.radius + 1.5, -0.05);
    plaqueB.rotation.y = Math.PI;
    rGroup.add(plaqueB);

    (spec.id === 'ski_air' ? skiGroup : megaGroup).add(rGroup);
    return {
      ...spec,
      group: rGroup,
      inside: false,
      cooldown: 0,
      popTimer: 0,
    };
  });

  // =========================================================================
  // ZONE C: BANKED MULTICOLORED DERBY ARENA + 3 ROAMING SELF-CONTAINED AI CARS
  // =========================================================================
  const derbyGroup = new THREE.Group();
  derbyGroup.name = 'zone_derby_arena';
  group.add(derbyGroup);

  // Flat dirt pit floor disc (rho <= 0.74 -> rx=28.1, rz=31.1)
  const dirtMat = trackMat(createStandardMaterial({
    map: cloneTex(textures.dirtSand, 7, 7),
    metalness: 0.02,
    roughness: 0.92,
  }, scene));
  const dirtFloor = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(1, 1, 0.16, 40)), dirtMat);
  dirtFloor.position.set(DERBY_CX, -0.05, DERBY_CZ);
  dirtFloor.scale.set(29.0, 1.0, 32.0);
  dirtFloor.receiveShadow = true;
  derbyGroup.add(dirtFloor);

  // Banked multicolored square-tile inner bowl (rho = 0.74 -> 1.00, single UV repeat in geometry for crisp Roblox tiles)
  const derbyTilesMat = trackMat(createStandardMaterial({
    map: cloneTex(textures.derbyTiles, 1, 1),
    metalness: 0.06,
    roughness: 0.56,
    side: THREE.DoubleSide,
  }, scene));
  const derbyInnerBowl = new THREE.Mesh(
    trackGeo(buildDerbyRingGeometry(0.74, 1.00, 48, 10, 14, 2)),
    derbyTilesMat,
  );
  derbyInnerBowl.name = 'derby_banked_tiles_bowl';
  derbyInnerBowl.receiveShadow = true;
  derbyGroup.add(derbyInnerBowl);

  // Outer sloped concrete/turf embankment skirt (rho = 1.00 -> 1.18, single UV repeat in geometry)
  const derbyOuterMat = trackMat(createStandardMaterial({
    map: cloneTex(textures.concretePad, 1, 1),
    color: 0xcbd5e1,
    metalness: 0.04,
    roughness: 0.85,
    side: THREE.DoubleSide,
  }, scene));
  const derbyOuterSkirt = new THREE.Mesh(
    trackGeo(buildDerbyRingGeometry(1.00, 1.18, 48, 6, 16, 2)),
    derbyOuterMat,
  );
  derbyGroup.add(derbyOuterSkirt);

  // Tall North Entrance Arch at (160, 0, 119.5) — high y=12.4 clearance never blocks spawn chase camera!
  for (const ax of [150.5, 169.5]) {
    const p = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.2, 13.0, 1.2)), darkSteelMat);
    p.position.set(ax, 6.5, 119.5);
    derbyGroup.add(p);
  }
  const derbyArchSign = makeSignBoard('DERBY ARENA', 'SMASH TO WIN!', '#be185d', '#fde047', 17.5, 3.0, true);
  derbyArchSign.position.set(160.0, 12.4, 119.5);
  derbyArchSign.rotation.y = Math.PI;
  derbyGroup.add(derbyArchSign);

  // South Stadium Scoreboard facing North into the bowl so spawn view sees iconic Derby signage
  for (const sx of [151.0, 169.0]) {
    const sp = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.0, 12.6, 1.0)), darkSteelMat);
    sp.position.set(sx, 6.3, 212.5);
    derbyGroup.add(sp);
  }
  const derbySouthSign = makeSignBoard('DERBY ARENA', 'SMASH RIVALS TO WIN!', '#be185d', '#fde047', 18.0, 3.4, true);
  derbySouthSign.position.set(160.0, 11.4, 212.5);
  derbySouthSign.rotation.y = Math.PI;
  derbyGroup.add(derbySouthSign);

  // 4 Tiered Spectator Grandstands (East, West, SE, SW — West stays >= x=109, clear of Car Football <= 100.5!)
  const standTierMats = [
    trackMat(createStandardMaterial({ color: 0xe53935, metalness: 0.06, roughness: 0.65 }, scene)),
    trackMat(createStandardMaterial({ color: 0x1e88e5, metalness: 0.06, roughness: 0.65 }, scene)),
    trackMat(createStandardMaterial({ color: 0xfdd835, metalness: 0.06, roughness: 0.65 }, scene)),
  ];
  const standTierGeo = trackGeo(new THREE.BoxGeometry(22.0, 1.4, 2.2));
  const standCanopyGeo = trackGeo(new THREE.BoxGeometry(23.5, 0.5, 7.6));

  const buildGrandstand = (gx, gz, rotY) => {
    const sg = new THREE.Group();
    sg.position.set(gx, 0, gz);
    sg.rotation.y = rotY;
    for (let t = 0; t < 3; t += 1) {
      const tier = new THREE.Mesh(standTierGeo, standTierMats[t]);
      tier.position.set(0, 3.0 + t * 1.45, t * 2.0);
      sg.add(tier);
    }
    const base = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(22.2, 2.8, 6.8)), darkSteelMat);
    base.position.set(0, 1.4, 2.0);
    sg.add(base);
    const canopy = new THREE.Mesh(standCanopyGeo, darkSteelMat);
    canopy.position.set(0, 9.6, 2.2);
    sg.add(canopy);
    for (const px of [-10.5, 10.5]) {
      const col = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.6, 6.8, 0.6)), darkSteelMat);
      col.position.set(px, 6.2, 5.2);
      sg.add(col);
    }
    derbyGroup.add(sg);
  };
  buildGrandstand(203.0, 168.0, -Math.PI / 2);      // East Grandstand
  buildGrandstand(115.0, 168.0, Math.PI / 2);       // West Grandstand (outer back at x~109.5, clear of Football!)
  buildGrandstand(189.0, 206.0, -Math.PI * 0.78);   // SE Grandstand
  buildGrandstand(131.0, 206.0, Math.PI * 0.78);    // SW Grandstand

  // -------------------------------------------------------------------------
  // 3 Self-Contained Roaming Roblox AI Crash Cars (NO M2A imports!)
  // -------------------------------------------------------------------------
  const aiWheelGeo = trackGeo(new THREE.CylinderGeometry(0.38, 0.38, 0.30, 12));
  aiWheelGeo.rotateZ(Math.PI / 2);
  const aiTireMat = trackMat(createStandardMaterial({ color: 0x181c22, metalness: 0.04, roughness: 0.85 }, scene));
  const aiGlassMat = trackMat(createStandardMaterial({
    color: 0x93c5fd,
    transparent: true,
    opacity: 0.45,
    metalness: 0.14,
    roughness: 0.18,
  }, scene));
  const smokeMat = trackMat(createStandardMaterial({
    color: 0x374151,
    transparent: true,
    opacity: 0.65,
    metalness: 0.02,
    roughness: 0.95,
  }, scene));
  const flameMat = trackMat(createStandardMaterial({
    color: 0xff6d00,
    emissive: 0xff9100,
    emissiveIntensity: 0.85,
    metalness: 0.04,
    roughness: 0.30,
  }, scene));
  const smokeGeo = trackGeo(new THREE.DodecahedronGeometry(0.45, 0));
  const flameGeo = trackGeo(new THREE.ConeGeometry(0.55, 1.35, 6));

  const buildSelfContainedAiCar = (spec) => {
    const carRoot = new THREE.Group();
    carRoot.name = `ai_car_${spec.id}`;
    const bodyGroup = new THREE.Group();
    carRoot.add(bodyGroup);

    const bodyMat = trackMat(createStandardMaterial({ color: spec.colorHex, metalness: 0.14, roughness: 0.38 }, scene));
    const accentMat = trackMat(createStandardMaterial({ color: spec.accentHex, metalness: 0.12, roughness: 0.42 }, scene));

    // Main lower chassis (local +Z = FRONT)
    const chassis = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(spec.w, spec.bodyH, spec.l)), bodyMat);
    chassis.position.y = 0.42 + spec.bodyH * 0.5;
    chassis.castShadow = true;
    bodyGroup.add(chassis);

    // Cabin / greenhouse
    const cab = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(spec.w * 0.88, spec.cabH, spec.cabL)), aiGlassMat);
    cab.position.set(0, 0.42 + spec.bodyH + spec.cabH * 0.48, spec.cabZ);
    bodyGroup.add(cab);

    const roof = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(spec.w * 0.90, 0.14, spec.cabL + 0.08)), spec.isVan ? whiteMat : bodyMat);
    roof.position.set(0, 0.42 + spec.bodyH + spec.cabH, spec.cabZ);
    bodyGroup.add(roof);

    // Detachable-on-damage front bumper
    const frontBumper = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(spec.w + 0.14, 0.32, 0.36)),
      spec.hazardBumper ? hazardMat : accentMat,
    );
    frontBumper.position.set(0, 0.48, spec.l * 0.5 + 0.12);
    bodyGroup.add(frontBumper);

    // License plate
    const plateMat = trackMat(createStandardMaterial({ map: textures.makePlateTexture(spec.plate), metalness: 0.04, roughness: 0.50 }, scene));
    const plateMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(0.76, 0.38)), plateMat);
    plateMesh.position.set(0, 0.55, -spec.l * 0.5 - 0.02);
    plateMesh.rotation.y = Math.PI;
    bodyGroup.add(plateMesh);

    // Blocky driver silhouette inside translucent cabin
    const driverMat = trackMat(createStandardMaterial({ color: spec.isMikey ? 0x22c55e : 0xfde047, metalness: 0.04, roughness: 0.55 }, scene));
    const driverTorso = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.54, 0.52, 0.34)), spec.isMikey ? accentMat : darkSteelMat);
    driverTorso.position.set(0, 0.42 + spec.bodyH + 0.25, spec.cabZ);
    bodyGroup.add(driverTorso);
    const driverHead = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.42, 0.42, 0.42)), driverMat);
    driverHead.position.set(0, 0.42 + spec.bodyH + 0.72, spec.cabZ);
    bodyGroup.add(driverHead);

    // Signature Mikey_Turtle roof shell + Sprite nametag (toneMapped: false, fog: false!)
    if (spec.isMikey) {
      const stripe = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.44, 0.06, spec.l + 0.02)), accentMat);
      stripe.position.set(0, 0.42 + spec.bodyH + 0.02, 0);
      bodyGroup.add(stripe);
      const shell = new THREE.Mesh(
        trackGeo(new THREE.SphereGeometry(0.72, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52)),
        trackMat(createStandardMaterial({ color: 0x1b5e20, metalness: 0.08, roughness: 0.48 }, scene)),
      );
      shell.scale.set(1.0, 0.68, 1.25);
      shell.position.set(0, 0.42 + spec.bodyH + spec.cabH + 0.05, spec.cabZ);
      bodyGroup.add(shell);

      const tagTex = trackTex(makeNametagTexture('Mikey_Turtle', '#4ade80'));
      const tagMat = trackMat(new THREE.SpriteMaterial({
        map: tagTex,
        transparent: true,
        toneMapped: false,
        fog: false,
      }));
      const nametag = new THREE.Sprite(tagMat);
      nametag.name = 'mikey_turtle_nametag';
      nametag.scale.set(3.8, 0.95, 1);
      nametag.position.set(0, 3.25, 0);
      carRoot.add(nametag);
    } else if (spec.hasRollBar) {
      for (const rx of [-0.78, 0.78]) {
        const post = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 0.9, 0.14)), darkSteelMat);
        post.position.set(rx, 0.42 + spec.bodyH + 0.45, -0.5);
        bodyGroup.add(post);
      }
      const bar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.72, 0.14, 0.14)), darkSteelMat);
      bar.position.set(0, 0.42 + spec.bodyH + 0.90, -0.5);
      bodyGroup.add(bar);
    }

    // 4 rotating wheels
    const wheels = [];
    const wx = spec.w * 0.5 + 0.05;
    const wz = spec.l * 0.31;
    for (const [xPos, zPos] of [[-wx, wz], [wx, wz], [-wx, -wz], [wx, -wz]]) {
      const w = new THREE.Mesh(aiWheelGeo, aiTireMat);
      w.position.set(xPos, 0.38, zPos);
      carRoot.add(w);
      wheels.push(w);
    }

    // Pooled self-contained damage smoke puffs + fire cone
    const smokePuffs = [];
    for (let s = 0; s < 3; s += 1) {
      const puff = new THREE.Mesh(smokeGeo, smokeMat);
      puff.visible = false;
      carRoot.add(puff);
      smokePuffs.push(puff);
    }
    const flameCone = new THREE.Mesh(flameGeo, flameMat);
    flameCone.position.set(0, 1.35, spec.l * 0.32);
    flameCone.visible = false;
    carRoot.add(flameCone);

    derbyGroup.add(carRoot);

    return {
      id: spec.id,
      name: spec.name,
      isMikey: Boolean(spec.isMikey),
      color: spec.colorStr,
      root: carRoot,
      bodyGroup,
      frontBumper,
      wheels,
      smokePuffs,
      flameCone,
      x: spec.startX,
      y: 0,
      z: spec.startZ,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: spec.startYaw,
      speed: spec.baseSpeed,
      baseSpeed: spec.baseSpeed,
      patrolPhase: spec.patrolPhase,
      patrolRx: spec.patrolRx,
      patrolRz: spec.patrolRz,
      ramOffset: spec.ramOffset,
      hp: 100,
      maxHp: 100,
      wrecked: false,
      respawnTimer: 0,
      hitCooldown: 0,
      spawnX: spec.startX,
      spawnZ: spec.startZ,
    };
  };

  const aiCars = [
    buildSelfContainedAiCar({
      id: 'mikey_turtle_car',
      name: 'Mikey_Turtle',
      isMikey: true,
      colorHex: 0x43a047,
      accentHex: 0xfdd835,
      colorStr: '#43a047',
      plate: 'MIKEY 01',
      w: 2.05,
      bodyH: 0.62,
      l: 4.15,
      cabH: 0.72,
      cabL: 1.85,
      cabZ: -0.1,
      startX: 160,
      startZ: 170,
      startYaw: Math.PI,
      baseSpeed: 14.5,
      patrolPhase: 0.0,
      patrolRx: 18.0,
      patrolRz: 21.0,
      ramOffset: 0.0,
    }),
    buildSelfContainedAiCar({
      id: 'cyan_derby_van',
      name: 'Cyan Van',
      isMikey: false,
      isVan: true,
      colorHex: 0x00acc1,
      accentHex: 0xf8fafc,
      colorStr: '#00acc1',
      plate: 'DERBY 02',
      w: 2.15,
      bodyH: 0.85,
      l: 4.75,
      cabH: 0.85,
      cabL: 3.40,
      cabZ: -0.25,
      startX: 176,
      startZ: 162,
      startYaw: -Math.PI / 2,
      baseSpeed: 13.0,
      patrolPhase: 2.1,
      patrolRx: 21.0,
      patrolRz: 24.0,
      ramOffset: 0.22,
    }),
    buildSelfContainedAiCar({
      id: 'orange_bruiser_pickup',
      name: 'Derby Bruiser',
      isMikey: false,
      hasRollBar: true,
      hazardBumper: true,
      colorHex: 0xfb8c00,
      accentHex: 0x1f2937,
      colorStr: '#fb8c00',
      plate: 'DERBY 03',
      w: 2.22,
      bodyH: 0.72,
      l: 4.85,
      cabH: 0.76,
      cabL: 1.75,
      cabZ: 0.35,
      startX: 144,
      startZ: 174,
      startYaw: Math.PI / 2,
      baseSpeed: 15.0,
      patrolPhase: 4.2,
      patrolRx: 20.0,
      patrolRz: 22.0,
      ramOffset: -0.22,
    }),
  ];

  const syncAiCarTransform = (ai) => {
    ai.root.position.set(ai.x, ai.y, ai.z);
    ai.root.rotation.y = ai.yaw;
  };
  for (let i = 0; i < aiCars.length; i += 1) {
    syncAiCarTransform(aiCars[i]);
  }

  // =========================================================================
  // ZONE D: CRASH TEST RUNWAY, WATER BASIN, BREAKABLE C4 WALL & CRASH BARRIER
  // =========================================================================
  const c4Group = new THREE.Group();
  c4Group.name = 'zone_crash_c4_wall';
  group.add(c4Group);

  // Blue-lined Crash Test Runway (x in [144, 173], z in [28.5, 41.5], y = 0.025)
  const runwayPad = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(29.0, 0.05, 13.0)),
    trackMat(createStandardMaterial({ map: cloneTex(textures.concretePad, 5, 2), metalness: 0.04, roughness: 0.82 }, scene)),
  );
  runwayPad.position.set(158.5, 0.0, 35.0);
  runwayPad.receiveShadow = true;
  c4Group.add(runwayPad);

  const guideLineGeo = trackGeo(new THREE.BoxGeometry(28.6, 0.02, 0.65));
  for (const lz of [29.2, 40.8]) {
    const line = new THREE.Mesh(guideLineGeo, blueLineMat);
    line.position.set(158.5, 0.032, lz);
    c4Group.add(line);
  }

  // Overhead "CRASH TEST & C4 LAB" arch at x = 160, y = 9.2 (unobstructed view of C4 smiley signs!)
  for (const pz of [28.0, 42.0]) {
    const p = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.9, 10.2, 0.9)), darkSteelMat);
    p.position.set(160.0, 5.1, pz);
    c4Group.add(p);
  }
  const c4ArchSign = makeSignBoard('CRASH TEST & C4 LAB', 'FULL SPEED AHEAD!', '#b91c1c', '#fde047', 13.0, 2.8, true);
  c4ArchSign.position.set(160.0, 9.2, 35.0);
  c4ArchSign.rotation.y = -Math.PI / 2;
  c4Group.add(c4ArchSign);

  // Shallow Blue Water Basin (x in [172, 204], z in [21, 49])
  // Render bright blue water surface just above main turf (y = 0.038) over cyan basin liner (y = 0.022)
  // so the pool is vividly visible while vehicles splash down smoothly to y = -0.45m!
  const basinLinerMat = trackMat(createStandardMaterial({ color: 0x0288d1, metalness: 0.06, roughness: 0.72 }, scene));
  const basinFloor = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(31.6, 27.6)), basinLinerMat);
  basinFloor.rotation.x = -Math.PI / 2;
  basinFloor.position.set(188.0, 0.022, 35.0);
  basinFloor.receiveShadow = true;
  c4Group.add(basinFloor);

  const waterPlane = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(31.0, 27.0)), waterMat);
  waterPlane.name = 'c4_water_basin_surface';
  waterPlane.rotation.x = -Math.PI / 2;
  waterPlane.position.set(188.0, 0.038, 35.0);
  c4Group.add(waterPlane);

  // Basin outer concrete curbs (leaving West runway entry open)
  const basinCurbNS = trackGeo(new THREE.BoxGeometry(32.6, 0.45, 0.8));
  for (const bz of [21.0, 49.0]) {
    const c = new THREE.Mesh(basinCurbNS, concretePillarMat);
    c.position.set(188.0, 0.22, bz);
    c4Group.add(c);
  }
  const basinCurbE = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.8, 0.45, 28.8)), concretePillarMat);
  basinCurbE.position.set(204.0, 0.22, 35.0);
  c4Group.add(basinCurbE);

  // 15-Block Breakable "C4 EXPLOSIVES" Wall (x = 185, z in [28, 42], 3 rows x 5 cols)
  const c4BlockGeo = trackGeo(new THREE.BoxGeometry(1.5, 1.45, 2.6));
  const c4StrapGeo = trackGeo(new THREE.BoxGeometry(1.58, 0.28, 0.55));
  const c4LedGeo = trackGeo(new THREE.SphereGeometry(0.14, 8, 6));
  const c4Blocks = [];
  const c4Leds = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const bGroup = new THREE.Group();
      const bx = 185.0;
      const by = -0.45 + 0.725 + row * 1.48;
      const bz = 29.6 + col * 2.7;
      bGroup.position.set(bx, by, bz);

      const blockMesh = new THREE.Mesh(c4BlockGeo, c4BlockMat);
      blockMesh.castShadow = true;
      bGroup.add(blockMesh);

      const strap = new THREE.Mesh(c4StrapGeo, redC4Mat);
      bGroup.add(strap);

      const led = new THREE.Mesh(c4LedGeo, ledOffMat);
      led.position.set(-0.80, 0.22, 0);
      bGroup.add(led);
      c4Leds.push(led);

      c4Group.add(bGroup);
      c4Blocks.push({
        group: bGroup,
        homeX: bx,
        homeY: by,
        homeZ: bz,
        x: bx,
        y: by,
        z: bz,
        vx: 0,
        vy: 0,
        vz: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        vrx: 0,
        vry: 0,
        vrz: 0,
      });
    }
  }

  // Central C4 Explosives banner + 3 top Yellow Smiley Warning Squares attached to wall frame
  const c4DecorGroup = new THREE.Group();
  c4DecorGroup.name = 'c4_wall_signage';
  c4Group.add(c4DecorGroup);
  const c4Banner = makeSignBoard('C4 EXPLOSIVES', 'BOOM ON IMPACT!', '#374151', '#fef08a', 8.8, 2.2, true);
  c4Banner.position.set(184.00, 2.0, 35.0);
  c4Banner.rotation.y = -Math.PI / 2;
  c4DecorGroup.add(c4Banner);

  const smileyGeo = trackGeo(new THREE.BoxGeometry(0.16, 1.5, 1.5));
  for (const sz of [31.2, 35.0, 38.8]) {
    const sm = new THREE.Mesh(smileyGeo, c4SmileyMat);
    sm.position.set(184.9, 4.75, sz);
    c4DecorGroup.add(sm);
  }

  // Solid Blue/White Striped Crash Test Barrier Wall at x = 196, z in [25, 45]
  const crashWall = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.4, 5.4, 20.0)), crashBarrierMat);
  crashWall.name = 'crash_test_barrier_wall';
  crashWall.position.set(196.0, 2.25, 35.0);
  crashWall.castShadow = true;
  c4Group.add(crashWall);

  for (const bz of [28.0, 35.0, 42.0]) {
    const buttress = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.2, 4.4, 0.9)), darkSteelMat);
    buttress.position.set(198.6, 1.8, bz);
    c4Group.add(buttress);
  }
  const crashSign = makeSignBoard('CRASH TEST WALL', 'IMPACT BARRIER', '#1e40af', '#ffffff', 12.0, 2.4, true);
  crashSign.position.set(196.0, 6.2, 35.0);
  crashSign.rotation.y = -Math.PI / 2;
  c4Group.add(crashSign);

  const c4State = {
    intact: true,
    scatterTimer: 0,
    rebuildTimer: 0,
    pendingManualBlast: false,
  };

  const restoreC4Wall = () => {
    c4State.intact = true;
    c4State.scatterTimer = 0;
    c4State.rebuildTimer = 0;
    c4State.pendingManualBlast = false;
    c4DecorGroup.visible = true;
    for (let i = 0; i < c4Blocks.length; i += 1) {
      const b = c4Blocks[i];
      b.x = b.homeX;
      b.y = b.homeY;
      b.z = b.homeZ;
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      b.rx = 0;
      b.ry = 0;
      b.rz = 0;
      b.vrx = 0;
      b.vry = 0;
      b.vrz = 0;
      b.group.position.set(b.x, b.y, b.z);
      b.group.rotation.set(0, 0, 0);
    }
  };

  const detonateC4Wall = (dirX = 1) => {
    c4State.intact = false;
    c4State.scatterTimer = 4.0;
    c4State.rebuildTimer = 14.0;
    c4DecorGroup.visible = false;
    for (let i = 0; i < c4Blocks.length; i += 1) {
      const b = c4Blocks[i];
      const row = Math.floor(i / 5);
      const col = i % 5;
      const spreadZ = (col - 2) * 3.8;
      b.vx = dirX * (10.0 + (i % 4) * 3.2) + ((i % 2 === 0 ? 1 : -1) * 2.5);
      b.vy = 7.5 + row * 3.4 + (col % 2) * 1.8;
      b.vz = spreadZ + ((row - 1) * 2.1);
      b.vrx = 3.5 + (i % 3) * 1.4;
      b.vry = -2.8 + (col - 2) * 1.2;
      b.vrz = 4.0 - row * 1.3;
    }
  };

  // =========================================================================
  // UPDATE, HAZARD QUERY, TRIGGER & ALERT LOOP
  // =========================================================================
  let simTime = 0;
  const localCooldowns = new Map();
  const defaultCtx = {
    simTime: 0,
    canHit(key, cooldownSec = 0.4) {
      const last = localCooldowns.get(key);
      if (last !== undefined && defaultCtx.simTime - last < cooldownSec) return false;
      localCooldowns.set(key, defaultCtx.simTime);
      return true;
    },
  };

  const sampleDerbyHeightLocal = (x, z) => {
    const s = sampleDerbyArena(x, z);
    return s ? s.y : 0;
  };

  const update = (dt, rawVeh) => {
    const safeDt = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 0;
    if (safeDt <= 0) return;
    simTime += safeDt;
    defaultCtx.simTime = simTime;

    const veh = normalizeVehInput(rawVeh);

    // 1. Rotate glowing Cash Bonus Rings + animate pop pulse
    for (let i = 0; i < cashRings.length; i += 1) {
      const ring = cashRings[i];
      ring.cooldown = Math.max(0, ring.cooldown - safeDt);
      ring.group.rotation.y += safeDt * 1.9;
      if (ring.popTimer > 0) {
        ring.popTimer = Math.max(0, ring.popTimer - safeDt);
        const s = 1 + 0.25 * Math.sin((ring.popTimer / 0.35) * Math.PI);
        ring.group.scale.set(s, s, s);
      } else if (ring.group.scale.x !== 1) {
        ring.group.scale.set(1, 1, 1);
      }
    }

    // 2. Update 3 self-contained roaming Derby AI crash cars
    const playerInDerby = veh.valid && Math.hypot(veh.x - DERBY_CX, veh.z - DERBY_CZ) <= 44.0;
    for (let i = 0; i < aiCars.length; i += 1) {
      const ai = aiCars[i];
      ai.hitCooldown = Math.max(0, ai.hitCooldown - safeDt);

      if (ai.wrecked) {
        ai.respawnTimer -= safeDt;
        ai.speed = Math.max(0, ai.speed - 14.0 * safeDt);
        ai.vx *= Math.exp(-3.0 * safeDt);
        ai.vz *= Math.exp(-3.0 * safeDt);
        ai.x += ai.vx * safeDt;
        ai.z += ai.vz * safeDt;
        ai.bodyGroup.rotation.z = 0.46;

        if (ai.respawnTimer <= 0) {
          // Respawn cleanly inside rho <= 0.55
          ai.hp = ai.maxHp;
          ai.wrecked = false;
          ai.frontBumper.visible = true;
          ai.bodyGroup.rotation.z = 0;
          ai.flameCone.visible = false;
          for (let s = 0; s < ai.smokePuffs.length; s += 1) ai.smokePuffs[s].visible = false;
          const angle = simTime * 0.7 + i * 2.1;
          ai.x = DERBY_CX + Math.cos(angle) * 16.0;
          ai.z = DERBY_CZ + Math.sin(angle) * 18.0;
          ai.vx = 0;
          ai.vz = 0;
          ai.speed = ai.baseSpeed;
        }
      } else {
        // Choose steering target: ram player when inside arena, else cruise smooth oval patrol
        let targetX;
        let targetZ;
        let desiredSpeed;
        if (playerInDerby) {
          targetX = veh.x;
          targetZ = veh.z;
          desiredSpeed = ai.baseSpeed + 3.5;
        } else {
          ai.patrolPhase += safeDt * (0.48 + i * 0.08);
          targetX = DERBY_CX + Math.cos(ai.patrolPhase) * ai.patrolRx;
          targetZ = DERBY_CZ + Math.sin(ai.patrolPhase) * ai.patrolRz;
          desiredSpeed = ai.baseSpeed;
        }
        const desiredYaw = Math.atan2(targetX - ai.x, targetZ - ai.z) + (playerInDerby ? ai.ramOffset : 0);
        const diff = wrapAngle(desiredYaw - ai.yaw);
        const maxTurn = 2.6 * safeDt;
        ai.yaw = wrapAngle(ai.yaw + clamp(diff, -maxTurn, maxTurn));
        ai.speed += (desiredSpeed - ai.speed) * Math.min(1, safeDt * 3.0);

        const fwdX = Math.sin(ai.yaw);
        const fwdZ = Math.cos(ai.yaw);
        ai.vx = fwdX * ai.speed;
        ai.vz = fwdZ * ai.speed;
        ai.x += ai.vx * safeDt;
        ai.z += ai.vz * safeDt;

        // Soft AI-to-AI separation
        for (let j = 0; j < aiCars.length; j += 1) {
          if (i === j) continue;
          const other = aiCars[j];
          const sdx = ai.x - other.x;
          const sdz = ai.z - other.z;
          const sDist = Math.hypot(sdx, sdz);
          if (sDist > 1e-4 && sDist < 4.4) {
            const push = (4.4 - sDist) * 0.5;
            ai.x += (sdx / sDist) * push;
            ai.z += (sdz / sDist) * push;
          }
        }
      }

      // Arena oval containment clamp (rho <= 0.90)
      const dx = ai.x - DERBY_CX;
      const dz = ai.z - DERBY_CZ;
      const rho = Math.hypot(dx / DERBY_RX, dz / DERBY_RZ);
      if (rho > 0.90) {
        const scale = 0.90 / rho;
        ai.x = DERBY_CX + dx * scale;
        ai.z = DERBY_CZ + dz * scale;
        ai.yaw = Math.atan2(-dx, -dz);
      }

      ai.y = sampleDerbyHeightLocal(ai.x, ai.z);
      syncAiCarTransform(ai);

      // Spin wheels
      const wheelSpin = (ai.speed * safeDt) / 0.38;
      for (let w = 0; w < ai.wheels.length; w += 1) {
        ai.wheels[w].rotation.x += wheelSpin;
      }

      // Damage smoke / fire visuals
      if (ai.hp < 75) {
        ai.frontBumper.visible = false;
        if (!ai.wrecked) {
          ai.bodyGroup.rotation.z = 0.14 * (i % 2 === 0 ? 1 : -1);
        }
        for (let s = 0; s < ai.smokePuffs.length; s += 1) {
          const puff = ai.smokePuffs[s];
          puff.visible = true;
          const phase = (simTime * 1.4 + s * 0.33) % 1;
          puff.position.set(Math.sin(simTime * 3 + s) * 0.35, 1.3 + phase * 2.1, 1.3 - phase * 0.6);
          const sc = 0.55 + phase * 1.05;
          puff.scale.set(sc, sc, sc);
        }
      } else {
        ai.frontBumper.visible = true;
        if (!ai.wrecked) ai.bodyGroup.rotation.z = 0;
        for (let s = 0; s < ai.smokePuffs.length; s += 1) {
          ai.smokePuffs[s].visible = false;
        }
      }

      if (ai.hp < 35) {
        ai.flameCone.visible = true;
        const fl = 0.82 + 0.35 * Math.sin(simTime * 22 + i);
        ai.flameCone.scale.set(1.0, fl, 1.0);
      } else {
        ai.flameCone.visible = false;
      }
    }

    // 3. Update C4 Wall blinking LEDs, ballistic rubble scatter & auto-rebuild
    const ledBlink = c4State.intact && Math.sin(simTime * 10) > 0;
    const ledMat = ledBlink ? ledOnMat : ledOffMat;
    for (let i = 0; i < c4Leds.length; i += 1) {
      c4Leds[i].material = ledMat;
    }

    if (!c4State.intact) {
      if (c4State.scatterTimer > 0) {
        c4State.scatterTimer = Math.max(0, c4State.scatterTimer - safeDt);
        for (let i = 0; i < c4Blocks.length; i += 1) {
          const b = c4Blocks[i];
          b.vy -= 24.0 * safeDt;
          b.x += b.vx * safeDt;
          b.y += b.vy * safeDt;
          b.z += b.vz * safeDt;
          const basinSample = sampleC4WaterBasin(b.x, b.z);
          const floorY = (basinSample ? basinSample.y : 0) + 0.72;
          if (b.y < floorY) {
            b.y = floorY;
            b.vy = Math.abs(b.vy) > 1.2 ? Math.abs(b.vy) * 0.35 : 0;
            b.vx *= 0.78;
            b.vz *= 0.78;
            b.vrx *= 0.78;
            b.vry *= 0.78;
            b.vrz *= 0.78;
          }
          b.rx += b.vrx * safeDt;
          b.ry += b.vry * safeDt;
          b.rz += b.vrz * safeDt;
          b.group.position.set(b.x, b.y, b.z);
          b.group.rotation.set(b.rx, b.ry, b.rz);
        }
      }
      c4State.rebuildTimer -= safeDt;
      const distPlayerToC4 = veh.valid ? Math.hypot(veh.x - 185, veh.z - 35) : 999;
      if (c4State.rebuildTimer <= 0 && distPlayerToC4 > 26.0) {
        restoreC4Wall();
      }
    }
  };

  const queryHazards = (rawVeh, ctx) => {
    const veh = normalizeVehInput(rawVeh);
    if (!veh.valid) return [];
    const activeCtx = ctx || defaultCtx;
    const impacts = [];

    // 1. Ski Jump runway side-wall scrape guide
    if (veh.z >= -176.0 && veh.z <= -124.0) {
      const dxSki = veh.x - (-185.0);
      const absDx = Math.abs(dxSki);
      if (absDx > 7.4 && absDx <= 9.6) {
        const deckY = skiYFn(veh.z);
        if (veh.y >= deckY - 1.2 && activeCtx.canHit('ski_jump_wall', 0.40)) {
          const inwardSign = dxSki > 0 ? -1 : 1;
          impacts.push({
            kind: 'pillar',
            damage: 6,
            impulse: [inwardSign * 9.0, 1.0, 0],
            crushY: 0,
            frontCrumple: 0.08,
            cashBonus: 15,
            xpBonus: 10,
            label: 'SKI WALL SCRAPE!',
            sound: 'crash',
            ignite: false,
            explode: false,
            ejectRagdoll: false,
          });
        }
      }
    }

    // 2. Glowing Cash Bonus Rings (one-shot + leave-to-rearm!)
    for (let i = 0; i < cashRings.length; i += 1) {
      const ring = cashRings[i];
      const d = Math.hypot(veh.x - ring.x, veh.y - ring.y, veh.z - ring.z);
      if (ring.inside) {
        if (d > ring.radius + 4.0) {
          ring.inside = false;
        }
      } else if (d <= ring.radius + 1.8 && ring.cooldown <= 0) {
        ring.inside = true;
        ring.cooldown = 2.5;
        ring.popTimer = 0.35;
        impacts.push({
          kind: 'ring',
          damage: 0,
          impulse: [0, 0, 0],
          crushY: 0,
          frontCrumple: 0,
          cashBonus: ring.cashBonus,
          xpBonus: ring.xpBonus,
          label: ring.cashBonus >= 100 ? 'GOLD RING +$100!' : 'CASH RING +$50!',
          sound: 'cash',
          ignite: false,
          explode: false,
          ejectRagdoll: false,
        });
      }
    }

    // 3. Derby Arena rim containment + AI Car collisions
    const ddx = veh.x - DERBY_CX;
    const ddz = veh.z - DERBY_CZ;
    const rho = Math.hypot(ddx / DERBY_RX, ddz / DERBY_RZ);
    if (rho > 0.99 && rho < 1.15 && veh.y < 8.5) {
      const ang = Math.abs(Math.atan2(ddx, -ddz));
      if (ang > 0.22 && activeCtx.canHit('derby_rim_bounce', 0.45)) {
        const len = Math.hypot(ddx, ddz) || 1;
        impacts.push({
          kind: 'pillar',
          damage: 5,
          impulse: [(-ddx / len) * 10.0, 2.5, (-ddz / len) * 10.0],
          crushY: 0,
          frontCrumple: 0.08,
          cashBonus: 20,
          xpBonus: 12,
          label: 'DERBY WALL BOUNCE!',
          sound: 'crash',
          ignite: false,
          explode: false,
          ejectRagdoll: false,
        });
      }
    }

    if (rho < 1.15) {
      for (let i = 0; i < aiCars.length; i += 1) {
        const ai = aiCars[i];
        if (ai.wrecked || ai.hitCooldown > 0) continue;
        const adx = veh.x - ai.x;
        const adz = veh.z - ai.z;
        const dist = Math.hypot(adx, adz);
        if (dist < 3.2 && Math.abs(veh.y - ai.y) < 2.8) {
          const relSpeed = Math.max(10, Math.hypot(veh.vx - ai.vx, veh.vz - ai.vz));
          ai.hp = Math.max(0, ai.hp - (24 + relSpeed * 0.85));
          ai.hitCooldown = 0.45;
          const inv = dist > 1e-4 ? 1 / dist : 1;
          const nx = adx * inv;
          const nz = adz * inv;
          // Knock AI car away
          ai.vx = -nx * (10 + relSpeed * 0.55);
          ai.vz = -nz * (10 + relSpeed * 0.55);
          ai.x -= nx * 0.8;
          ai.z -= nz * 0.8;

          if (ai.hp <= 0) {
            ai.wrecked = true;
            ai.respawnTimer = 6.0;
          }

          impacts.push({
            kind: 'ai_car',
            damage: clamp(10 + relSpeed * 0.55, 10, 28),
            impulse: [nx * 11.0, 2.5, nz * 11.0],
            crushY: 0.05,
            frontCrumple: clamp(0.18 + relSpeed * 0.01, 0.18, 0.45),
            cashBonus: ai.wrecked ? 150 : 65,
            xpBonus: ai.wrecked ? 60 : 25,
            label: ai.wrecked ? `WRECKED ${ai.name.toUpperCase()}!` : `SMASHED ${ai.name.toUpperCase()}!`,
            sound: ai.wrecked ? 'explosion' : 'crash',
            ignite: ai.wrecked,
            explode: ai.wrecked,
            ejectRagdoll: ai.wrecked,
          });
        }
      }
    }

    // 4. Breakable C4 Explosives Wall (collision OR pending manual blast)
    if (c4State.pendingManualBlast) {
      c4State.pendingManualBlast = false;
      const dC4 = Math.hypot(veh.x - 185.0, veh.z - 35.0);
      if (dC4 <= 16.0) {
        const pushX = veh.x <= 185.0 ? -15.0 : 15.0;
        const lateralKick = clamp((veh.z - 35.0) * 1.2, -6, 6);
        impacts.push({
          kind: 'c4',
          damage: 42,
          impulse: [pushX, 11.5, lateralKick],
          crushY: 0.12,
          frontCrumple: 0.58,
          cashBonus: 180,
          xpBonus: 85,
          label: 'C4 EXPLOSIVES BOOM! +$180',
          sound: 'explosion',
          ignite: true,
          explode: true,
          ejectRagdoll: true,
        });
      }
    } else if (
      c4State.intact
      && veh.x >= 181.5
      && veh.x <= 188.5
      && veh.z >= 27.0
      && veh.z <= 43.0
      && veh.y < 5.5
    ) {
      const dirX = veh.vx >= 0 ? 1 : -1;
      detonateC4Wall(dirX);
      const lateralKick = clamp((veh.z - 35.0) * 1.1, -6, 6);
      impacts.push({
        kind: 'c4',
        damage: 42,
        impulse: [-dirX * 15.0, 11.5, lateralKick],
        crushY: 0.12,
        frontCrumple: 0.58,
        cashBonus: 180,
        xpBonus: 85,
        label: 'C4 EXPLOSIVES BOOM! +$180',
        sound: 'explosion',
        ignite: true,
        explode: true,
        ejectRagdoll: true,
      });
    }

    // 5. Solid Blue/White Striped Crash Test Barrier Wall at x = 196, z in [25, 45]
    if (
      veh.x >= 192.8
      && veh.x <= 198.5
      && veh.z >= 24.5
      && veh.z <= 45.5
      && veh.y < 6.0
      && activeCtx.canHit('crash_test_wall', 0.55)
    ) {
      const spd = Math.max(12, veh.speed);
      const pushDir = veh.x <= 196.0 ? -1 : 1;
      impacts.push({
        kind: 'crash_wall',
        damage: clamp(16 + spd * 0.75, 16, 48),
        impulse: [pushDir * Math.max(12, spd * 0.65), 3.0, 0],
        crushY: 0,
        frontCrumple: clamp(0.25 + spd * 0.012, 0.25, 0.75),
        cashBonus: 110,
        xpBonus: 55,
        label: 'CRASH TEST WALL! +$110',
        sound: 'crash',
        ignite: spd > 32,
        explode: false,
        ejectRagdoll: spd > 36,
      });
    }

    return impacts;
  };

  const c4Zone = getZoneById('crash_c4_wall');
  const manualTriggerSpots = [{
    zoneId: 'crash_c4_wall',
    machineName: 'C4 Explosives Wall',
    pos: [...c4Zone.padCenter],
    radius: c4Zone.padRadius + 14,
    triggerLabel: c4Zone.triggerLabel || 'DETONATE C4',
    shortLabel: 'C4',
  }];

  const triggerZoneMachine = (zoneId) => {
    if (zoneId !== 'crash_c4_wall') return null;
    if (!c4State.intact) {
      restoreC4Wall();
    }
    detonateC4Wall(1);
    c4State.pendingManualBlast = true;
    return {
      triggered: true,
      zoneId: 'crash_c4_wall',
      machineName: 'C4 Explosives Wall',
      message: 'C4 EXPLOSIVES DETONATED! BOOM!',
    };
  };

  const getActiveAlerts = (pos) => {
    if (!pos) return [];
    const px = Array.isArray(pos) ? pos[0] : pos.x;
    const pz = Array.isArray(pos) ? pos[2] : pos.z;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return [];
    if (Math.hypot(px - 185, pz - 35) <= 36) {
      return [{
        id: 'crash_c4_ready',
        zoneId: 'crash_c4_wall',
        text: c4State.intact ? 'C4 WALL ARMED — SMASH OR TAP DETONATE C4!' : 'C4 WALL DETONATED! TAP AGAIN TO RE-BLAST!',
        severity: c4State.intact ? 'warn' : 'info',
        triggerable: true,
        triggerLabel: 'DETONATE C4',
        shortLabel: 'C4',
      }];
    }
    return [];
  };

  const resetBreakables = () => {
    restoreC4Wall();
    for (let i = 0; i < cashRings.length; i += 1) {
      cashRings[i].inside = false;
      cashRings[i].cooldown = 0;
      cashRings[i].popTimer = 0;
    }
    for (let i = 0; i < aiCars.length; i += 1) {
      const ai = aiCars[i];
      ai.hp = ai.maxHp;
      ai.wrecked = false;
      ai.respawnTimer = 0;
      ai.hitCooldown = 0;
      ai.x = ai.spawnX;
      ai.z = ai.spawnZ;
      ai.vx = 0;
      ai.vz = 0;
      ai.speed = ai.baseSpeed;
      ai.frontBumper.visible = true;
      ai.bodyGroup.rotation.z = 0;
      ai.flameCone.visible = false;
      for (let s = 0; s < ai.smokePuffs.length; s += 1) ai.smokePuffs[s].visible = false;
      ai.y = sampleDerbyHeightLocal(ai.x, ai.z);
      syncAiCarTransform(ai);
    }
    localCooldowns.clear();
  };

  const getAiVehicles = () => aiCars.map((ai) => ({
    id: ai.id,
    name: ai.name,
    isMikey: ai.isMikey,
    color: ai.color,
    position: [ai.x, ai.y, ai.z],
    velocity: [ai.vx, ai.vy, ai.vz],
    yaw: ai.yaw,
    speed: ai.speed,
    hp: Math.round(ai.hp),
    maxHp: ai.maxHp,
    integrity: Math.round((ai.hp / ai.maxHp) * 100),
    damaged: ai.hp < 75,
    wrecked: ai.wrecked,
    active: !ai.wrecked,
  }));

  const surfaceRegions = [
    {
      id: 'ski_jump',
      priority: 30,
      minX: -193.5,
      maxX: -176.5,
      minZ: -176.0,
      maxZ: -124.0,
      sample: sampleSkiJump,
    },
    {
      id: 'mega_ramp',
      priority: 30,
      minX: -8.5,
      maxX: 8.5,
      minZ: 132.0,
      maxZ: 162.0,
      sample: sampleMegaRamp,
    },
    {
      id: 'mega_ramp_rainbow_wall',
      priority: 25,
      minX: -44.0,
      maxX: -24.0,
      minZ: 166.0,
      maxZ: 186.0,
      sample: sampleRainbowWall,
    },
    {
      id: 'derby_arena',
      priority: 25,
      minX: 115.0,
      maxX: 205.0,
      minZ: 118.0,
      maxZ: 218.0,
      sample: sampleDerbyArena,
    },
    {
      id: 'crash_c4_water_basin',
      priority: 20,
      minX: 172.0,
      maxX: 204.0,
      minZ: 21.0,
      maxZ: 49.0,
      sample: sampleC4WaterBasin,
    },
  ];

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const g of ownedGeometries) g.dispose();
    for (const m of ownedMaterials) m.dispose();
    for (const t of ownedTextures) t.dispose();
    ownedGeometries.clear();
    ownedMaterials.clear();
    ownedTextures.clear();
  };

  return {
    group,
    surfaceRegions,
    update,
    queryHazards,
    triggerZoneMachine,
    getManualTriggerSpots: () => manualTriggerSpots,
    getActiveAlerts,
    resetBreakables,
    getAiVehicles,
    getStuntStates: () => ({
      c4Intact: c4State.intact,
      ringRotY: cashRings[0].group.rotation.y,
      ringCount: cashRings.length,
    }),
    dispose,
  };
}
