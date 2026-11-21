/**
 * Open Demolition Lab Hub, Terrain, Roads, #101 Rally Raider Turntable,
 * Breakable Glass Showroom, Molten Lava Pit & Obby Bridge, and Car Football Pitch.
 *
 * Self-contained M2B WorldSection (zero imports from avatars.js / vehicle_mesh.js / particles.js).
 * Strictly enforces non-IBL metalness <= 0.20 via createStandardMaterial(), clones shared
 * textures before modifying UV repeats/offsets, and disposes only owned resources.
 */

import * as THREE from '../../vendor/three.module.min.js';
import { createStandardMaterial } from '../core/materials.js';
import { WORLD_HALF_SIZE } from '../data/zones.js';

const R_RING_INNER = 49;
const R_RING_OUTER = 59;

// Car Football pitch reconciled coordinates: (74, 0, 162), 44m x 28m
const FOOTBALL_CX = 74;
const FOOTBALL_CZ = 162;
const FOOTBALL_HALF_W = 22; // x in [52, 96]
const FOOTBALL_HALF_D = 14; // z in [148, 176]
const FOOTBALL_GOAL_HALF_Z = 5.5;
const FOOTBALL_BALL_R = 2.1;

// Lava Pit & Lava Obby Bridge coordinates
const LAVA_MIN_X = -187;
const LAVA_MAX_X = -143;
const LAVA_MIN_Z = 137;
const LAVA_MAX_Z = 179;
const LAVA_DEPTH = -1.10;
const BRIDGE_Y = 1.60;

// Verified non-overlapping blocky Roblox tree coordinates
// Clear of all 14 zone pads, ring road, connector spurs, Car Football [44,104]x[140,180],
// mega_ramp [-46,36]x[116,222], derby_arena [108,212]x[118,226], ski_jump [-230,-140]x[-215,75],
// and train_crossing [-128,128]x[-168,-132].
const TREE_POSITIONS = [
  // Interior park clusters
  [36, -112], [44, -116], [38, -124],
  [-40, -110], [-48, -118], [-36, -124],
  [38, 114], [46, 120],
  [-46, 114], [-54, 122], [-56, 136],
  [128, -42], [136, -36], [134, -48],
  [132, 92], [140, 86], [144, 98],
  [-136, 32], [-144, 26], [-138, 42],
  [-124, -46], [-132, -52],
  // Perimeter scenic trees
  [-120, -228], [-60, -228], [0, -228], [60, -228], [120, -228], [180, -228], [226, -226],
  [228, -190], [228, -120], [228, -60], [228, 0], [228, 80], [228, 140], [228, 210],
  [226, 226], [104, 228], [46, 228], [-20, 228], [-80, 228], [-140, 228], [-200, 228], [-226, 226],
  [-228, 180], [-228, 120], [-228, 60], [-228, 0], [-228, -60], [218, 226],
];

// Connector spurs linking hub, ring road, and all outer destruction zones (y = 0.020)
// Spur #4 stops at z = -116 to meet train_crossing's crossing road (z in [-170, -114]) seamlessly.
const CONNECTOR_SPURS = [
  [[0, 22], [0, 54]],              // 1. Hub South -> Ring
  [[24, 0], [54, 0]],              // 2. Hub East -> Ring
  [[-24, 0], [-54, 0]],            // 3. Hub West -> Ring
  [[0, -54], [0, -116]],           // 4. Ring -> train_crossing (stops at -116)
  [[0, 54], [0, 122]],             // 5. Ring -> mega_ramp
  [[38.2, -38.2], [78, -42]],      // 6. Ring -> hydraulic_press
  [[53.4, 8], [74, 8]],            // 7. Ring -> wrecking_balls
  [[38.2, 38.2], [76, 52]],        // 8. Ring -> spinning_hammers
  [[-53.1, -10], [-78, -10]],      // 9. Ring -> nail_hammer
  [[-38.2, -38.2], [-82, -54]],    // 10. Ring -> giant_hammer
  [[-38.2, 38.2], [-82, 48]],      // 11. Ring -> spike_drop
  [[76, 106], [74, 144]],          // 12. spinning_hammers -> Car Football (74, 162)
  [[98, 140], [156, 124]],         // 13. Car Football -> derby_arena North gate
  [[128, 16], [152, 35]],          // 14. wrecking_balls -> crash_c4_wall
  [[102, -68], [178, -76]],        // 15. hydraulic_press -> shredder_tunnels
  [[-106, 82], [-165, 125]],       // 16. spike_drop -> lava_obby
];

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
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

function sampleLavaObbyBridge(x, z) {
  // Entry ramp: x in [-171, -159], z in [131, 138] -> smooth cosine 0 -> BRIDGE_Y
  if (x >= -171 && x <= -159 && z >= 131 && z <= 138) {
    const t = (z - 131) / 7;
    const halfH = BRIDGE_Y * 0.5;
    return {
      y: halfH * (1 - Math.cos(Math.PI * t)),
      gx: 0,
      gz: halfH * (Math.PI / 7) * Math.sin(Math.PI * t),
    };
  }
  // Entry deck: x in [-171, -159], z in (138, 142.0]
  if (x >= -171 && x <= -159 && z > 138 && z <= 142.0) {
    return { y: BRIDGE_Y, gx: 0, gz: 0 };
  }
  // Wide Y-fork split junction platform: x in [-176.5, -153.5], z in [142.0, 146.5]
  // Connects entry deck seamlessly to both Left (+X) Safe Bridge and Right (-X) Skull Catapult
  if (x >= -176.5 && x <= -153.5 && z >= 142.0 && z <= 146.5) {
    return { y: BRIDGE_Y, gx: 0, gz: 0 };
  }
  // Left SAFE bridge (+X under +Z forward): x in [-161.5, -153.5], z in (146.5, 178.0]
  if (x >= -161.5 && x <= -153.5 && z > 146.5 && z <= 178.0) {
    return { y: BRIDGE_Y, gx: 0, gz: 0 };
  }
  // Left SAFE exit ramp: x in [-161.5, -153.5], z in (178.0, 185.0] -> smooth cosine BRIDGE_Y -> 0
  if (x >= -161.5 && x <= -153.5 && z > 178.0 && z <= 185.0) {
    const t = (z - 178.0) / 7;
    const halfH = BRIDGE_Y * 0.5;
    return {
      y: halfH * (1 + Math.cos(Math.PI * t)),
      gx: 0,
      gz: -halfH * (Math.PI / 7) * Math.sin(Math.PI * t),
    };
  }
  // Right SKULL catapult stub (-X under +Z forward): x in [-176.5, -168.5], z in (146.5, 160.0]
  if (x >= -176.5 && x <= -168.5 && z > 146.5 && z <= 160.0) {
    return { y: BRIDGE_Y, gx: 0, gz: 0 };
  }
  return null;
}

function sampleLavaPit(x, z) {
  if (x < LAVA_MIN_X || x > LAVA_MAX_X || z < LAVA_MIN_Z || z > LAVA_MAX_Z) {
    return null;
  }
  const bx = bevel1D(x, LAVA_MIN_X, LAVA_MAX_X, 3.0);
  const bz = bevel1D(z, LAVA_MIN_Z, LAVA_MAX_Z, 3.0);
  return {
    y: LAVA_DEPTH * bx.val * bz.val,
    gx: LAVA_DEPTH * bx.deriv * bz.val,
    gz: LAVA_DEPTH * bx.val * bz.deriv,
  };
}

function buildPolarRingRoadGeometry(rInner, rOuter, segments = 64, vRepeats = 28) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const normals = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const angle = t * Math.PI * 2;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const vBase = i * 2;
    // Inner vertex (u = 0)
    positions[vBase * 3] = c * rInner;
    positions[vBase * 3 + 1] = 0;
    positions[vBase * 3 + 2] = s * rInner;
    normals[vBase * 3 + 1] = 1;
    uvs[vBase * 2] = 0;
    uvs[vBase * 2 + 1] = t * vRepeats;
    // Outer vertex (u = 1)
    positions[(vBase + 1) * 3] = c * rOuter;
    positions[(vBase + 1) * 3 + 1] = 0;
    positions[(vBase + 1) * 3 + 2] = s * rOuter;
    normals[(vBase + 1) * 3 + 1] = 1;
    uvs[(vBase + 1) * 2] = 1;
    uvs[(vBase + 1) * 2 + 1] = t * vRepeats;
    if (i < segments) {
      indices.push(vBase, vBase + 2, vBase + 1, vBase + 1, vBase + 2, vBase + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function buildCosineRampGeometry(width, zStart, zEnd, yStart, yEnd, segments = 10) {
  const halfW = width * 0.5;
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const z = zStart + (zEnd - zStart) * t;
    const y = yStart + (yEnd - yStart) * 0.5 * (1 - Math.cos(Math.PI * t));
    const vBase = i * 2;
    // Left (-X)
    positions[vBase * 3] = -halfW;
    positions[vBase * 3 + 1] = y;
    positions[vBase * 3 + 2] = z;
    uvs[vBase * 2] = 0;
    uvs[vBase * 2 + 1] = t * 2;
    // Right (+X)
    positions[(vBase + 1) * 3] = halfW;
    positions[(vBase + 1) * 3 + 1] = y;
    positions[(vBase + 1) * 3 + 2] = z;
    uvs[(vBase + 1) * 2] = 1;
    uvs[(vBase + 1) * 2 + 1] = t * 2;
    if (i < segments) {
      indices.push(vBase, vBase + 2, vBase + 1, vBase + 1, vBase + 2, vBase + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function makeSoccerBallTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2;
  for (let x = 0; x < 256; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 128);
    ctx.stroke();
  }
  const spots = [
    [32, 32], [96, 32], [160, 32], [224, 32],
    [64, 64], [128, 64], [192, 64], [0, 64], [256, 64],
    [32, 96], [96, 96], [160, 96], [224, 96],
  ];
  ctx.fillStyle = '#111827';
  for (let i = 0; i < spots.length; i += 1) {
    const [cx, cy] = spots[i];
    ctx.beginPath();
    for (let k = 0; k < 5; k += 1) {
      const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
      const px = cx + Math.cos(a) * 14;
      const py = cy + Math.sin(a) * 12;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function makeFootballScoreboardCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return { canvas, tex };
}

function drawFootballScoreboard(canvas, tex, blueScore, orangeScore, bannerText) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  // Dark stadium scoreboard frame
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, w - 10, h - 10);

  // Header
  ctx.fillStyle = '#f8fafc';
  ctx.font = '900 32px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('CAR FOOTBALL', w * 0.5, 42);

  // Blue badge
  ctx.fillStyle = '#1e88e5';
  ctx.fillRect(28, 76, 180, 96);
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 26px system-ui, sans-serif';
  ctx.fillText('BLUE', 118, 102);
  ctx.font = '900 54px system-ui, sans-serif';
  ctx.fillText(String(blueScore), 118, 146);

  // Dash
  ctx.fillStyle = '#fde047';
  ctx.font = '900 56px system-ui, sans-serif';
  ctx.fillText('-', w * 0.5, 128);

  // Orange badge
  ctx.fillStyle = '#fb8c00';
  ctx.fillRect(w - 208, 76, 180, 96);
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 26px system-ui, sans-serif';
  ctx.fillText('ORANGE', w - 118, 102);
  ctx.font = '900 54px system-ui, sans-serif';
  ctx.fillText(String(orangeScore), w - 118, 146);

  // Subtitle
  ctx.fillStyle = '#fde047';
  ctx.font = '800 24px system-ui, sans-serif';
  ctx.fillText(bannerText || 'FIRST TO 3 WINS', w * 0.5, 214);

  tex.needsUpdate = true;
}

function normalizeVehInput(raw) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, radius: 2.0 };
  }
  if (raw.valid === false) return raw;
  if (typeof raw.x === 'number' && typeof raw.z === 'number' && raw.valid === true) {
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
  const vx = Number.isFinite(Array.isArray(vel) ? vel[0] : vel?.x) ? (Array.isArray(vel) ? vel[0] : vel.x) : 0;
  const vy = Number.isFinite(Array.isArray(vel) ? vel[1] : vel?.y) ? (Array.isArray(vel) ? vel[1] : vel.y) : 0;
  const vz = Number.isFinite(Array.isArray(vel) ? vel[2] : vel?.z) ? (Array.isArray(vel) ? vel[2] : vel.z) : 0;
  const speed = Number.isFinite(raw.speed) ? raw.speed : Math.hypot(vx, vy, vz);
  const w = Number.isFinite(raw.dimensions?.w) ? raw.dimensions.w : 2.1;
  const l = Number.isFinite(raw.dimensions?.l) ? raw.dimensions.l : 4.5;
  const radius = Number.isFinite(raw.radius) ? raw.radius : Math.max(w, l) * 0.44;
  return { valid: true, x, y, z, vx, vy, vz, speed, radius };
}

/**
 * Builds the Open Demolition Lab Hub, Terrain, Roads, #101 Turntable,
 * Breakable Glass Showroom, Lava Pit + Obby Bridge, and Car Football Pitch.
 *
 * @param {THREE.Scene} scene
 * @param {ReturnType<import('./textures.js').createTextureLibrary>} textures
 */
export function createHubLabWorld(scene, textures) {
  const group = new THREE.Group();
  group.name = 'hub_lab_root';

  const ownedGeometries = new Set();
  const ownedMaterials = new Set();
  const ownedTextures = new Set();
  const ownedInstanced = new Set();

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
  const trackInst = (m) => {
    ownedInstanced.add(m);
    return m;
  };
  const cloneTex = (baseTex, rx = 1, ry = 1) => {
    const t = baseTex.clone();
    t.repeat.set(rx, ry);
    t.needsUpdate = true;
    ownedTextures.add(t);
    return t;
  };

  // Shared materials (strictly metalness <= 0.20 via createStandardMaterial)
  const darkSteelMat = trackMat(createStandardMaterial({ color: 0x1e293b, roughness: 0.42, metalness: 0.18 }, scene));
  const yellowPaintMat = trackMat(createStandardMaterial({ color: 0xfdd835, roughness: 0.34, metalness: 0.16 }, scene));
  const darkTrimMat = trackMat(createStandardMaterial({ color: 0x263238, roughness: 0.48, metalness: 0.14 }, scene));
  const whiteTrimMat = trackMat(createStandardMaterial({ color: 0xf8fafc, roughness: 0.45, metalness: 0.06 }, scene));
  const tireMat = trackMat(createStandardMaterial({ color: 0x181c22, roughness: 0.85, metalness: 0.04 }, scene));
  const hubCapMat = trackMat(createStandardMaterial({ color: 0xd1d5db, roughness: 0.36, metalness: 0.18 }, scene));
  const basaltMat = trackMat(createStandardMaterial({ color: 0x374151, roughness: 0.90, metalness: 0.04 }, scene));
  const redTrapMat = trackMat(createStandardMaterial({ color: 0xdc2626, roughness: 0.42, metalness: 0.14 }, scene));
  const greenSafeMat = trackMat(createStandardMaterial({ color: 0x2e7d32, roughness: 0.55, metalness: 0.06 }, scene));
  const blueGoalMat = trackMat(createStandardMaterial({ color: 0x1e88e5, roughness: 0.42, metalness: 0.14 }, scene));
  const orangeGoalMat = trackMat(createStandardMaterial({ color: 0xfb8c00, roughness: 0.42, metalness: 0.14 }, scene));
  const netMat = trackMat(createStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.34,
    roughness: 0.8,
    metalness: 0.0,
    side: THREE.DoubleSide,
  }, scene));
  const signFrameMat = trackMat(createStandardMaterial({ color: 0x1e293b, roughness: 0.5, metalness: 0.16 }, scene));

  const makeSignBoard = (title, subtitle, bg, fg, w, h, doubleSided = false) => {
    const tex = textures.makeSignTexture(title, subtitle, bg, fg);
    const mat = trackMat(createStandardMaterial({
      map: tex,
      emissive: 0x222222,
      emissiveMap: tex,
      emissiveIntensity: 0.25,
      roughness: 0.62,
      metalness: 0.04,
      side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    }, scene));
    return new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(w, h)), mat);
  };

  // =========================================================================
  // A. GREEN STUD TERRAIN, HORIZON SKIRT, PERIMETER CURBS, HILLS & TREES
  // =========================================================================
  const worldSize = WORLD_HALF_SIZE * 2; // 480m
  const turfTex = cloneTex(textures.grassGrid, 60, 60);
  const turfMesh = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(worldSize, worldSize)),
    trackMat(createStandardMaterial({ map: turfTex, roughness: 0.88, metalness: 0.02 }, scene)),
  );
  turfMesh.name = 'main_green_turf';
  turfMesh.rotation.x = -Math.PI / 2;
  turfMesh.position.y = 0.0;
  turfMesh.receiveShadow = true;
  group.add(turfMesh);

  // Outer horizon skirt (y = -0.08) so no sky gap shows past +-240 inside 460m far plane
  const skirtMesh = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(760, 760)),
    trackMat(createStandardMaterial({ color: 0x3db536, roughness: 0.92, metalness: 0.0 }, scene)),
  );
  skirtMesh.name = 'outer_horizon_skirt';
  skirtMesh.rotation.x = -Math.PI / 2;
  skirtMesh.position.y = -0.08;
  group.add(skirtMesh);

  // 4 Perimeter boundary curbs along |x|, |z| = 236
  const curbTex = cloneTex(textures.hazardStripes, 60, 1);
  const curbMat = trackMat(createStandardMaterial({ map: curbTex, roughness: 0.65, metalness: 0.08 }, scene));
  const curbNSGeo = trackGeo(new THREE.BoxGeometry(474, 1.4, 1.6));
  const curbEWGeo = trackGeo(new THREE.BoxGeometry(1.6, 1.4, 474));
  for (const zPos of [-236, 236]) {
    const m = new THREE.Mesh(curbNSGeo, curbMat);
    m.position.set(0, 0.7, zPos);
    m.receiveShadow = true;
    group.add(m);
  }
  for (const xPos of [-236, 236]) {
    const m = new THREE.Mesh(curbEWGeo, curbMat);
    m.position.set(xPos, 0.7, 0);
    m.receiveShadow = true;
    group.add(m);
  }

  // Blocky Roblox perimeter hills strictly outside +-252
  const unitBoxGeo = trackGeo(new THREE.BoxGeometry(1, 1, 1));
  const hillLightMat = trackMat(createStandardMaterial({ color: 0x43a047, roughness: 0.90, metalness: 0.02 }, scene));
  const hillDarkMat = trackMat(createStandardMaterial({ color: 0x388e3c, roughness: 0.90, metalness: 0.02 }, scene));
  const hillSpecs = [];
  for (let i = 0; i < 7; i += 1) {
    const span = -210 + i * 70;
    const hA = 14 + ((i * 7) % 18);
    const hB = 12 + ((i * 11 + 5) % 20);
    hillSpecs.push([span, hA * 0.5, -268 - (i % 2) * 14, 54, hA, 32]);
    hillSpecs.push([span + 12, hB * 0.5, 268 + (i % 2) * 14, 52, hB, 32]);
    hillSpecs.push([-268 - (i % 2) * 14, hB * 0.5, span, 32, hB, 52]);
    hillSpecs.push([268 + (i % 2) * 14, hA * 0.5, span - 10, 32, hA, 54]);
  }
  const lightHills = hillSpecs.filter((_, idx) => idx % 2 === 0);
  const darkHills = hillSpecs.filter((_, idx) => idx % 2 === 1);
  const dummy = new THREE.Object3D();
  const buildHillInstances = (list, mat, name) => {
    const inst = trackInst(new THREE.InstancedMesh(unitBoxGeo, mat, list.length));
    inst.name = name;
    for (let i = 0; i < list.length; i += 1) {
      const [hx, hy, hz, sx, sy, sz] = list[i];
      dummy.position.set(hx, hy, hz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  };
  buildHillInstances(lightHills, hillLightMat, 'horizon_hills_light');
  buildHillInstances(darkHills, hillDarkMat, 'horizon_hills_dark');

  // 50 Instanced blocky Roblox trees (3 draw calls total)
  const trunkMat = trackMat(createStandardMaterial({ color: 0x795548, roughness: 0.88, metalness: 0.02 }, scene));
  const crownLowMat = trackMat(createStandardMaterial({ color: 0x2e7d32, roughness: 0.85, metalness: 0.02 }, scene));
  const crownHighMat = trackMat(createStandardMaterial({ color: 0x43a047, roughness: 0.82, metalness: 0.02 }, scene));
  const trunkInst = trackInst(new THREE.InstancedMesh(trackGeo(new THREE.BoxGeometry(1.1, 4.4, 1.1)), trunkMat, TREE_POSITIONS.length));
  const crownLowInst = trackInst(new THREE.InstancedMesh(trackGeo(new THREE.BoxGeometry(4.4, 3.2, 4.4)), crownLowMat, TREE_POSITIONS.length));
  const crownHighInst = trackInst(new THREE.InstancedMesh(trackGeo(new THREE.BoxGeometry(2.9, 2.2, 2.9)), crownHighMat, TREE_POSITIONS.length));
  trunkInst.name = 'roblox_trees_trunks';
  crownLowInst.name = 'roblox_trees_crowns_low';
  crownHighInst.name = 'roblox_trees_crowns_high';
  for (let i = 0; i < TREE_POSITIONS.length; i += 1) {
    const [tx, tz] = TREE_POSITIONS[i];
    const s = 0.88 + ((i * 19) % 7) * 0.05;
    const rotY = ((i * 37) % 16) * 0.2;
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(s, s, s);
    dummy.position.set(tx, 2.2 * s, tz);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(tx, 5.4 * s, tz);
    dummy.updateMatrix();
    crownLowInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(tx, 7.6 * s, tz);
    dummy.updateMatrix();
    crownHighInst.setMatrixAt(i, dummy.matrix);
  }
  trunkInst.instanceMatrix.needsUpdate = true;
  crownLowInst.instanceMatrix.needsUpdate = true;
  crownHighInst.instanceMatrix.needsUpdate = true;
  group.add(trunkInst, crownLowInst, crownHighInst);

  // =========================================================================
  // B. HUB PLAZA, POLAR-UV RING ROAD & NON-OVERLAPPING CONNECTOR SPURS
  // =========================================================================
  // Hub concrete plaza (y = 0.022)
  const hubPadTex = cloneTex(textures.concretePad, 9, 9);
  const hubPlaza = new THREE.Mesh(
    trackGeo(new THREE.CircleGeometry(27, 48)),
    trackMat(createStandardMaterial({ map: hubPadTex, roughness: 0.82, metalness: 0.04 }, scene)),
  );
  hubPlaza.name = 'hub_concrete_plaza';
  hubPlaza.rotation.x = -Math.PI / 2;
  hubPlaza.position.y = 0.022;
  hubPlaza.receiveShadow = true;
  group.add(hubPlaza);

  // Straight South-to-North asphalt boulevard guiding spawn (0, 14) straight into DEMOLITION LAB (-18)
  const boulevardTex = cloneTex(textures.asphaltRoad, 1, 3.75);
  const boulevard = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(11, 45)),
    trackMat(createStandardMaterial({ map: boulevardTex, roughness: 0.84, metalness: 0.04 }, scene)),
  );
  boulevard.name = 'hub_boulevard';
  boulevard.rotation.x = -Math.PI / 2;
  boulevard.position.set(0, 0.032, 4.5); // spans z in [-18, +27]
  boulevard.receiveShadow = true;
  group.add(boulevard);

  // 2-lane dashed asphalt Ring Road (R_INNER = 49, R_OUTER = 59, y = 0.028)
  const ringRoadTex = cloneTex(textures.asphaltRoad, 1, 1);
  const ringRoadMesh = new THREE.Mesh(
    trackGeo(buildPolarRingRoadGeometry(R_RING_INNER, R_RING_OUTER, 64, 28)),
    trackMat(createStandardMaterial({ map: ringRoadTex, roughness: 0.84, metalness: 0.04 }, scene)),
  );
  ringRoadMesh.name = 'asphalt_ring_road';
  ringRoadMesh.position.y = 0.028;
  ringRoadMesh.receiveShadow = true;
  group.add(ringRoadMesh);

  // 16 Flat asphalt connector spurs (y = 0.020 — cleanly under ring road 0.028 and pads 0.025+)
  const spurMatCache = new Map();
  for (let i = 0; i < CONNECTOR_SPURS.length; i += 1) {
    const [[x1, z1], [x2, z2]] = CONNECTOR_SPURS[i];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const vRep = Math.max(1, Math.round(len / 12));
    let mat = spurMatCache.get(vRep);
    if (!mat) {
      const tex = cloneTex(textures.asphaltRoad, 1, vRep);
      mat = trackMat(createStandardMaterial({ map: tex, roughness: 0.84, metalness: 0.04 }, scene));
      spurMatCache.set(vRep, mat);
    }
    const mesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(9.0, len)), mat);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.y = Math.atan2(dx, dz);
    mesh.position.set((x1 + x2) * 0.5, 0.020, (z1 + z2) * 0.5);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // =========================================================================
  // C. RALLY RAIDER #101 ROTATING TURNTABLE AT (16, 0, -3) & LEFT HUB SIGN
  // =========================================================================
  const TURNTABLE_X = 16;
  const TURNTABLE_Z = -3;
  const turntableRoot = new THREE.Group();
  turntableRoot.name = 'rally_raider_turntable';
  turntableRoot.position.set(TURNTABLE_X, 0, TURNTABLE_Z);
  group.add(turntableRoot);

  const ttCurbTex = cloneTex(textures.hazardStripes, 8, 1);
  const ttCurb = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(5.8, 6.1, 0.34, 24)),
    trackMat(createStandardMaterial({ map: ttCurbTex, roughness: 0.62, metalness: 0.08 }, scene)),
  );
  ttCurb.position.y = 0.17;
  ttCurb.receiveShadow = true;
  turntableRoot.add(ttCurb);

  const turntableDeckGroup = new THREE.Group();
  turntableDeckGroup.name = 'turntable_rotating_deck';
  turntableDeckGroup.position.y = 0.34;
  turntableRoot.add(turntableDeckGroup);

  const ttDisk = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(5.05, 5.15, 0.22, 24)),
    yellowPaintMat,
  );
  ttDisk.position.y = 0.11;
  ttDisk.receiveShadow = true;
  turntableDeckGroup.add(ttDisk);

  // 4 Radial dark stripes so rotation is unmistakable
  const stripeGeo = trackGeo(new THREE.BoxGeometry(0.32, 0.03, 9.6));
  for (let i = 0; i < 2; i += 1) {
    const s = new THREE.Mesh(stripeGeo, darkTrimMat);
    s.position.y = 0.23;
    s.rotation.y = i * (Math.PI / 2);
    turntableDeckGroup.add(s);
  }

  // Self-contained stylized #101 Rally Raider display car (local +Z = front)
  const displayCar = new THREE.Group();
  displayCar.name = 'rally_raider_101_display';
  displayCar.position.y = 0.22;
  turntableDeckGroup.add(displayCar);

  const chassis = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.12, 0.56, 4.45)), yellowPaintMat);
  chassis.position.y = 0.58;
  chassis.castShadow = true;
  displayCar.add(chassis);

  const splitter = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.18, 0.14, 4.55)), darkTrimMat);
  splitter.position.y = 0.28;
  displayCar.add(splitter);

  const cabin = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.74, 0.54, 1.80)), darkTrimMat);
  cabin.position.set(0, 1.12, -0.15);
  cabin.castShadow = true;
  displayCar.add(cabin);

  const glassMatDisplay = trackMat(createStandardMaterial({
    color: 0x64b5f6,
    roughness: 0.18,
    metalness: 0.16,
  }, scene));
  const windshieldDisp = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.62, 0.42, 1.84)), glassMatDisplay);
  windshieldDisp.position.set(0, 1.10, -0.15);
  displayCar.add(windshieldDisp);

  const hoodScoop = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.68, 0.14, 0.85)), darkTrimMat);
  hoodScoop.position.set(0, 0.90, 1.05);
  displayCar.add(hoodScoop);

  // Twin-strut rear rally spoiler
  const wing = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.08, 0.12, 0.44)), darkTrimMat);
  wing.position.set(0, 1.38, -1.95);
  displayCar.add(wing);
  const strutGeo = trackGeo(new THREE.BoxGeometry(0.10, 0.52, 0.22));
  for (const sx of [-0.68, 0.68]) {
    const st = new THREE.Mesh(strutGeo, darkTrimMat);
    st.position.set(sx, 1.12, -1.95);
    displayCar.add(st);
  }

  // Headlights (+Z front) & taillights (-Z rear)
  const headLightMat = trackMat(createStandardMaterial({
    color: 0xfff59d,
    emissive: 0xfff59d,
    emissiveIntensity: 0.55,
    roughness: 0.25,
    metalness: 0.08,
  }, scene));
  const tailLightMat = trackMat(createStandardMaterial({
    color: 0xef4444,
    emissive: 0xdc2626,
    emissiveIntensity: 0.55,
    roughness: 0.30,
    metalness: 0.08,
  }, scene));
  const lampGeo = trackGeo(new THREE.BoxGeometry(0.42, 0.18, 0.06));
  for (const lx of [-0.68, 0.68]) {
    const hl = new THREE.Mesh(lampGeo, headLightMat);
    hl.position.set(lx, 0.62, 2.24);
    displayCar.add(hl);
    const tl = new THREE.Mesh(lampGeo, tailLightMat);
    tl.position.set(lx, 0.64, -2.24);
    displayCar.add(tl);
  }

  // 4 wheels
  const wheelGeo = trackGeo(new THREE.CylinderGeometry(0.40, 0.40, 0.32, 14));
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = trackGeo(new THREE.CylinderGeometry(0.22, 0.22, 0.34, 10));
  rimGeo.rotateZ(Math.PI / 2);
  for (const [wx, wz] of [[-1.02, 1.34], [1.02, 1.34], [-1.02, -1.34], [1.02, -1.34]]) {
    const w = new THREE.Mesh(wheelGeo, tireMat);
    w.position.set(wx, 0.40, wz);
    displayCar.add(w);
    const r = new THREE.Mesh(rimGeo, hubCapMat);
    r.position.set(wx, 0.40, wz);
    displayCar.add(r);
  }

  // #101 side decals + RCD 101 plates
  const decal101Mat = trackMat(createStandardMaterial({
    map: textures.makeNumberTexture('101', '#fdd835'),
    roughness: 0.45,
    metalness: 0.06,
  }, scene));
  const decalGeo = trackGeo(new THREE.PlaneGeometry(0.76, 0.76));
  const decalL = new THREE.Mesh(decalGeo, decal101Mat);
  decalL.position.set(1.07, 0.60, 0.10);
  decalL.rotation.y = Math.PI / 2;
  displayCar.add(decalL);
  const decalR = new THREE.Mesh(decalGeo, decal101Mat);
  decalR.position.set(-1.07, 0.60, 0.10);
  decalR.rotation.y = -Math.PI / 2;
  displayCar.add(decalR);

  const plate101Mat = trackMat(createStandardMaterial({
    map: textures.makePlateTexture('RCD 101'),
    roughness: 0.50,
    metalness: 0.06,
  }, scene));
  const plateGeo = trackGeo(new THREE.PlaneGeometry(0.80, 0.40));
  const plateF = new THREE.Mesh(plateGeo, plate101Mat);
  plateF.position.set(0, 0.46, 2.24);
  displayCar.add(plateF);
  const plateB = new THREE.Mesh(plateGeo, plate101Mat);
  plateB.position.set(0, 0.46, -2.24);
  plateB.rotation.y = Math.PI;
  displayCar.add(plateB);

  // Showcase signboard at (23.0, 0, -11.2) strictly clear of turntable Box3 & rotated toward spawn (0, 14)
  const buildStandingSign = (x, z, rotY, title, subtitle, bg, fg, w = 5.8, h = 2.6, name = '') => {
    const sg = new THREE.Group();
    if (name) sg.name = name;
    sg.position.set(x, 0, z);
    sg.rotation.y = rotY;
    // Posts terminate cleanly at sign bottom and are recessed in Z (0.22 < 0.36 backing < +-0.19 faces)
    const postH = 3.6 - h * 0.5;
    const postGeo = trackGeo(new THREE.BoxGeometry(0.28, postH, 0.22));
    for (const px of [-w * 0.36, w * 0.36]) {
      const p = new THREE.Mesh(postGeo, darkSteelMat);
      p.position.set(px, postH * 0.5, 0);
      sg.add(p);
    }
    const backing = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w + 0.24, h + 0.24, 0.36)), signFrameMat);
    backing.position.set(0, 3.6, 0);
    sg.add(backing);
    const front = makeSignBoard(title, subtitle, bg, fg, w, h, false);
    front.position.set(0, 3.6, 0.19);
    sg.add(front);
    const back = makeSignBoard(title, subtitle, bg, fg, w, h, false);
    back.position.set(0, 3.6, -0.19);
    back.rotation.y = Math.PI;
    sg.add(back);
    group.add(sg);
    return sg;
  };
  buildStandingSign(23.0, -11.2, -0.45, 'RALLY RAIDER #101', 'ROTATING SHOWCASE', '#1e293b', '#fde047', 5.8, 2.6, 'standing_sign_rally_raider');

  // Left Hub welcome billboard at (-16, 0, -3) + 2 decorative bollards (clear of [-10, +10])
  buildStandingSign(-16, -3, 0.55, 'DEMOLITION LAB', 'DRIVE STRAIGHT TO SMASH GLASS!', '#0f172a', '#4ade80', 6.4, 2.8, 'standing_sign_demolition_lab');
  const bollardTex = cloneTex(textures.hazardStripes, 2, 1);
  const bollardMat = trackMat(createStandardMaterial({ map: bollardTex, roughness: 0.55, metalness: 0.10 }, scene));
  const bollardGeo = trackGeo(new THREE.CylinderGeometry(0.32, 0.36, 1.35, 10));
  for (const [bx, bz] of [[-13.5, 1.2], [-18.5, -6.8]]) {
    const b = new THREE.Mesh(bollardGeo, bollardMat);
    b.position.set(bx, 0.68, bz);
    group.add(b);
  }

  // =========================================================================
  // D. BREAKABLE GLASS DEMOLITION LAB SHOWROOM AT (0, 0, -24.5)
  // =========================================================================
  const labGroup = new THREE.Group();
  labGroup.name = 'demolition_lab_showroom';
  group.add(labGroup);

  const labFloorTex = cloneTex(textures.concretePad, 4, 3);
  const labFloor = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(20.4, 0.10, 13.4)),
    trackMat(createStandardMaterial({ map: labFloorTex, roughness: 0.78, metalness: 0.04 }, scene)),
  );
  labFloor.position.set(0, 0.05, -24.5);
  labFloor.receiveShadow = true;
  labGroup.add(labFloor);

  // Structural black-steel columns — NO center column at x = 0 so 9.6m bay is 100% open glass!
  const colGeo = trackGeo(new THREE.BoxGeometry(0.55, 9.0, 0.55));
  const labColCoords = [
    [-10, -18], [-4.8, -18], [4.8, -18], [10, -18],
    [-10, -31], [-4.8, -31], [4.8, -31], [10, -31],
  ];
  for (let i = 0; i < labColCoords.length; i += 1) {
    const [cx, cz] = labColCoords[i];
    const col = new THREE.Mesh(colGeo, darkSteelMat);
    col.position.set(cx, 4.5, cz);
    col.castShadow = true;
    labGroup.add(col);
  }
  const labCornerPillars = [[-10, -18], [10, -18], [-10, -31], [10, -31]];

  // Horizontal beams at y = 4.5 and y = 9.0 + roof slab
  const beamXGeo = trackGeo(new THREE.BoxGeometry(20.6, 0.45, 0.55));
  const beamZGeo = trackGeo(new THREE.BoxGeometry(0.55, 0.45, 13.6));
  for (const by of [4.5, 9.0]) {
    for (const bz of [-18, -31]) {
      const b = new THREE.Mesh(beamXGeo, darkSteelMat);
      b.position.set(0, by, bz);
      labGroup.add(b);
    }
    for (const bx of [-10, 10]) {
      const b = new THREE.Mesh(beamZGeo, darkSteelMat);
      b.position.set(bx, by, -24.5);
      labGroup.add(b);
    }
  }
  const roofSlab = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(20.8, 0.35, 13.8)), darkSteelMat);
  roofSlab.position.set(0, 9.2, -24.5);
  roofSlab.castShadow = true;
  labGroup.add(roofSlab);

  // Upper 2nd-floor intact tinted glass facade (y in [4.65, 8.85])
  const upperGlassMat = trackMat(createStandardMaterial({
    color: 0x7dd3fc,
    emissive: 0x0c4a6e,
    emissiveIntensity: 0.16,
    transparent: true,
    opacity: 0.36,
    roughness: 0.15,
    metalness: 0.14,
    side: THREE.DoubleSide,
  }, scene));
  const upperFront = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(19.6, 4.1, 0.14)), upperGlassMat);
  upperFront.position.set(0, 6.75, -18.0);
  labGroup.add(upperFront);
  const upperBack = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(19.6, 4.1, 0.14)), upperGlassMat);
  upperBack.position.set(0, 6.75, -31.0);
  labGroup.add(upperBack);
  const upperSideGeo = trackGeo(new THREE.BoxGeometry(0.14, 4.1, 12.6));
  for (const ux of [-10, 10]) {
    const us = new THREE.Mesh(upperSideGeo, upperGlassMat);
    us.position.set(ux, 6.75, -24.5);
    labGroup.add(us);
  }

  // Rooftop "DEMOLITION LAB" billboard at (0, 10.9, -18.0) facing South (+Z) toward spawn
  const roofSignBack = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(14.4, 3.3, 0.34)), signFrameMat);
  roofSignBack.position.set(0, 10.9, -18.0);
  labGroup.add(roofSignBack);
  const roofSignF = makeSignBoard('DEMOLITION LAB', 'BREAKABLE GLASS SHOWROOM', '#0f172a', '#ffffff', 14.0, 3.0, false);
  roofSignF.position.set(0, 10.9, -17.81);
  labGroup.add(roofSignF);
  const roofSignB = makeSignBoard('DEMOLITION LAB', 'BREAKABLE GLASS SHOWROOM', '#0f172a', '#ffffff', 14.0, 3.0, false);
  roofSignB.position.set(0, 10.9, -18.19);
  roofSignB.rotation.y = Math.PI;
  labGroup.add(roofSignB);

  // 12 Shatterable ground-floor glass wall panels (y in [0.2, 4.4])
  const breakGlassMat = trackMat(createStandardMaterial({
    color: 0x93e5ff,
    emissive: 0x164e63,
    emissiveIntensity: 0.22,
    transparent: true,
    opacity: 0.48,
    roughness: 0.12,
    metalness: 0.16,
    side: THREE.DoubleSide,
  }, scene));
  const paneTrimMat = trackMat(createStandardMaterial({ color: 0xe0f2fe, roughness: 0.28, metalness: 0.12 }, scene));

  const paneDefs = [
    // Front facade (z = -18.0, 4 panes)
    { id: 'front_0', cx: -7.4, cz: -18.0, w: 4.6, d: 0.18 },
    { id: 'front_1', cx: -2.4, cz: -18.0, w: 4.6, d: 0.18 },
    { id: 'front_2', cx: 2.4, cz: -18.0, w: 4.6, d: 0.18 },
    { id: 'front_3', cx: 7.4, cz: -18.0, w: 4.6, d: 0.18 },
    // Interior partition (z = -22.5, 2 panes — right at smashTarget [0, 0, -22]!)
    { id: 'mid_0', cx: -2.4, cz: -22.5, w: 4.6, d: 0.18 },
    { id: 'mid_1', cx: 2.4, cz: -22.5, w: 4.6, d: 0.18 },
    // Rear facade (z = -31.0, 2 center panes)
    { id: 'rear_0', cx: -2.4, cz: -31.0, w: 4.6, d: 0.18 },
    { id: 'rear_1', cx: 2.4, cz: -31.0, w: 4.6, d: 0.18 },
    // West & East sides (2 panes each)
    { id: 'west_0', cx: -10.0, cz: -21.25, w: 0.18, d: 5.8 },
    { id: 'west_1', cx: -10.0, cz: -27.75, w: 0.18, d: 5.8 },
    { id: 'east_0', cx: 10.0, cz: -21.25, w: 0.18, d: 5.8 },
    { id: 'east_1', cx: 10.0, cz: -27.75, w: 0.18, d: 5.8 },
  ];

  const paneGeoEW = trackGeo(new THREE.BoxGeometry(4.6, 4.2, 0.18));
  const paneGeoNS = trackGeo(new THREE.BoxGeometry(0.18, 4.2, 5.8));
  const glHighlightEW = trackGeo(new THREE.BoxGeometry(3.8, 0.12, 0.22));
  const glHighlightNS = trackGeo(new THREE.BoxGeometry(0.22, 0.12, 4.8));

  const glassPanes = paneDefs.map((def) => {
    const isEW = def.w > def.d;
    const mesh = new THREE.Group();
    mesh.name = `lab_glass_${def.id}`;
    mesh.position.set(def.cx, 2.3, def.cz);
    const plate = new THREE.Mesh(isEW ? paneGeoEW : paneGeoNS, breakGlassMat);
    mesh.add(plate);
    // Crisp specular glare stripe so transparent glass pops clearly against bright sky
    const glare = new THREE.Mesh(isEW ? glHighlightEW : glHighlightNS, paneTrimMat);
    glare.position.y = 1.1;
    mesh.add(glare);
    labGroup.add(mesh);
    return {
      id: def.id,
      mesh,
      cx: def.cx,
      cz: def.cz,
      halfW: def.w * 0.5,
      halfD: def.d * 0.5,
      broken: false,
    };
  });

  // Pooled translucent glass shard burst meshes (36 total, 6 per shatter)
  const shardGeo = trackGeo(new THREE.BoxGeometry(0.55, 0.45, 0.12));
  const shardPool = [];
  let shardCursor = 0;
  for (let i = 0; i < 36; i += 1) {
    const m = new THREE.Mesh(shardGeo, breakGlassMat);
    m.visible = false;
    labGroup.add(m);
    shardPool.push({
      mesh: m,
      active: false,
      life: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      rx: 0,
      ry: 0,
    });
  }

  const spawnGlassShards = (cx, cz, vehVx, vehVz) => {
    for (let k = 0; k < 6; k += 1) {
      const s = shardPool[shardCursor];
      shardCursor = (shardCursor + 1) % shardPool.length;
      const spread = (k - 2.5) * 0.65;
      s.active = true;
      s.life = 0.95;
      s.mesh.visible = true;
      s.mesh.position.set(cx + spread * 0.6, 1.2 + (k % 3) * 0.9, cz + (k % 2 === 0 ? 0.2 : -0.2));
      s.mesh.rotation.set(k * 0.6, k * 0.9, 0);
      s.vx = vehVx * 0.45 + spread * 2.4;
      s.vy = 4.0 + (k % 3) * 2.2;
      s.vz = vehVz * 0.45 + ((k % 2 === 0 ? -1 : 1) * 2.5);
      s.rx = 5.5 + k;
      s.ry = 4.2 - k * 0.7;
    }
  };

  // =========================================================================
  // E. LAVA PIT & RAISED LAVA OBBY BRIDGE AT (-165, 0, 155)
  // =========================================================================
  const lavaGroup = new THREE.Group();
  lavaGroup.name = 'lava_obby_zone';
  group.add(lavaGroup);

  const lavaTex = cloneTex(textures.lavaMagma, 5, 5);
  const lavaMat = trackMat(createStandardMaterial({
    map: lavaTex,
    emissive: 0xff4500,
    emissiveIntensity: 0.72,
    roughness: 0.42,
    metalness: 0.04,
  }, scene));
  // Render glowing magma surface just above turf (y = 0.045) so fiery lava lake is vividly
  // visible from every angle while vehicles physically sink into the recessed -1.10m pit!
  const lavaPlane = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(44, 42)), lavaMat);
  lavaPlane.name = 'molten_lava_surface';
  lavaPlane.rotation.x = -Math.PI / 2;
  lavaPlane.position.set(-165, 0.045, 158);
  lavaGroup.add(lavaPlane);

  // Dark basalt rim framing the lava pit (leaving North entry, South exit, and East drive-in open)
  const addBasaltWall = (x, z, w, d, h = 1.6) => {
    const m = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), basaltMat);
    m.position.set(x, -1.1 + h * 0.5, z);
    lavaGroup.add(m);
  };
  addBasaltWall(-187.8, 158, 1.8, 44);      // West rim
  addBasaltWall(-180, 136.5, 16, 1.8);      // North-West rim
  addBasaltWall(-151, 136.5, 16, 1.8);      // North-East rim
  addBasaltWall(-174.5, 179.5, 27, 1.8);    // South-West rim
  addBasaltWall(-147.5, 179.5, 10, 1.8);    // South-East rim
  addBasaltWall(-142.2, 143.5, 1.8, 13);    // East-North rim (gap z in [150,162])
  addBasaltWall(-142.2, 170.5, 1.8, 17);    // East-South rim

  // Raised Cobblestone & Timber Obby Bridge matching sampleLavaObbyBridge()
  const obbyStoneTex = cloneTex(textures.concretePad, 2, 2);
  const obbyStoneMat = trackMat(createStandardMaterial({ map: obbyStoneTex, roughness: 0.85, metalness: 0.04 }, scene));
  const obbyWoodTex = cloneTex(textures.woodTruss, 2, 6);
  const obbyWoodMat = trackMat(createStandardMaterial({ map: obbyWoodTex, roughness: 0.78, metalness: 0.04 }, scene));

  // Entry smooth cosine ramp (x in [-171, -159], z in [131, 138])
  const entryRampGeo = trackGeo(buildCosineRampGeometry(12, 131, 138, 0, BRIDGE_Y, 10));
  const entryRamp = new THREE.Mesh(entryRampGeo, obbyStoneMat);
  entryRamp.position.x = -165;
  entryRamp.receiveShadow = true;
  lavaGroup.add(entryRamp);

  // Entry deck (x in [-171, -159], z in [138, 142.0], top y = 1.60)
  const entryDeck = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(12, 0.5, 4.0)), obbyStoneMat);
  entryDeck.position.set(-165, BRIDGE_Y - 0.25, 140.0);
  entryDeck.receiveShadow = true;
  lavaGroup.add(entryDeck);

  // Wide Y-fork split junction platform (x in [-176.5, -153.5], z in [142.0, 146.5], top y = 1.60)
  const splitPlatform = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(23.0, 0.5, 4.5)), obbyStoneMat);
  splitPlatform.position.set(-165, BRIDGE_Y - 0.25, 144.25);
  splitPlatform.receiveShadow = true;
  lavaGroup.add(splitPlatform);

  // Left SAFE bridge (+X, driver's LEFT: x in [-161.5, -153.5], z in [146.5, 178.0])
  const safeBridge = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(8.0, 0.45, 31.5)), obbyWoodMat);
  safeBridge.position.set(-157.5, BRIDGE_Y - 0.225, 162.25);
  safeBridge.receiveShadow = true;
  lavaGroup.add(safeBridge);

  // Subtle green guide curbs on Left safe bridge
  const safeRailGeo = trackGeo(new THREE.BoxGeometry(0.32, 0.35, 31.5));
  for (const rx of [-161.3, -153.7]) {
    const r = new THREE.Mesh(safeRailGeo, greenSafeMat);
    r.position.set(rx, BRIDGE_Y + 0.17, 162.25);
    lavaGroup.add(r);
  }

  // Left SAFE exit cosine ramp (x in [-161.5, -153.5], z in [178.0, 185.0])
  const exitRampGeo = trackGeo(buildCosineRampGeometry(8.0, 178.0, 185.0, BRIDGE_Y, 0, 10));
  const exitRamp = new THREE.Mesh(exitRampGeo, obbyStoneMat);
  exitRamp.position.x = -157.5;
  exitRamp.receiveShadow = true;
  lavaGroup.add(exitRamp);

  // Right SKULL catapult stub (-X, driver's RIGHT: x in [-176.5, -168.5], z in [146.5, 160.0])
  const skullDeck = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(8.0, 0.45, 13.5)), obbyStoneMat);
  skullDeck.position.set(-172.5, BRIDGE_Y - 0.225, 153.25);
  skullDeck.receiveShadow = true;
  lavaGroup.add(skullDeck);

  // Stone piers supporting bridge decks neatly underneath (top y = 1.35 < deck bottom 1.375)
  const pierGeo = trackGeo(new THREE.BoxGeometry(2.2, 2.2, 2.2));
  for (const [px, pz] of [
    [-169, 142], [-161, 142],
    [-157.5, 154], [-157.5, 166], [-157.5, 176],
    [-172.5, 155],
  ]) {
    const pier = new THREE.Mesh(pierGeo, basaltMat);
    pier.position.set(px, 0.25, pz);
    lavaGroup.add(pier);
  }

  // Animated spring catapult plate on Right (-X) fork hinged at z = 159.0
  const catapultPivot = new THREE.Group();
  catapultPivot.name = 'lava_obby_catapult_plate';
  catapultPivot.position.set(-172.5, BRIDGE_Y + 0.05, 159.0);
  lavaGroup.add(catapultPivot);

  const catTex = cloneTex(textures.hazardStripes, 3, 2);
  const catPlate = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(6.8, 0.24, 7.6)),
    trackMat(createStandardMaterial({ map: catTex, color: 0xffb4a2, roughness: 0.48, metalness: 0.12 }, scene)),
  );
  catPlate.position.set(0, 0.12, -3.8);
  catapultPivot.add(catPlate);

  // Red warning bar & coiled springs under catapult plate
  const catBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(6.8, 0.18, 0.55)), redTrapMat);
  catBar.position.set(0, 0.26, -7.2);
  catapultPivot.add(catBar);

  const SPRING_BASE_H = 0.20;
  const SPRING_REST_Y = BRIDGE_Y + 0.08; // top = 1.60 + 0.08 + 0.10 = 1.78 < 1.80 (tucked beneath plate top 1.89)
  const springGeo = trackGeo(new THREE.CylinderGeometry(0.45, 0.45, SPRING_BASE_H, 10));
  const springs = [];
  for (const sx of [-174.4, -170.6]) {
    const sp = new THREE.Mesh(springGeo, hubCapMat);
    sp.position.set(sx, SPRING_REST_Y, 153.5);
    lavaGroup.add(sp);
    springs.push(sp);
  }

  // Overhead Split Signpost Portal Arch at z = 146.5 (height >= 5.6m clear, NEVER blocks x = -165!)
  const portalPillarGeo = trackGeo(new THREE.BoxGeometry(0.9, 8.2, 0.9));
  for (const ax of [-177.2, -152.8]) {
    const p = new THREE.Mesh(portalPillarGeo, darkSteelMat);
    p.position.set(ax, 4.1, 146.5);
    lavaGroup.add(p);
  }
  const portalBeam = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(25.4, 0.7, 0.9)), darkSteelMat);
  portalBeam.position.set(-165, 8.0, 146.5);
  lavaGroup.add(portalBeam);

  // Left Sign (+X = -157.5, Driver's LEFT approaching +Z): Green Checkmark SAFE
  const safeSignF = makeSignBoard('✓ SAFE PATH', 'LEFT BRIDGE', '#15803d', '#ffffff', 7.4, 2.8, true);
  safeSignF.position.set(-157.5, 6.4, 146.0);
  safeSignF.rotation.y = Math.PI; // faces -Z toward spawnPos (-165, 125)
  lavaGroup.add(safeSignF);

  // Right Sign (-X = -172.5, Driver's RIGHT approaching +Z): Red Skull TRAP
  const skullSignF = makeSignBoard('☠ SKULL TRAP', 'DO NOT ENTER!', '#991b1b', '#fde047', 7.4, 2.8, true);
  skullSignF.position.set(-172.5, 6.4, 146.0);
  skullSignF.rotation.y = Math.PI;
  lavaGroup.add(skullSignF);

  // Celebratory Obby Finish Arch at (-157.5, 0, 187)
  for (const fx of [-162.0, -153.0]) {
    const p = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.65, 6.8, 0.65)), blueGoalMat);
    p.position.set(fx, 3.4, 187.0);
    lavaGroup.add(p);
  }
  const finishSign = makeSignBoard('OBBY CLEAR!', 'BONUS +$100', '#1d4ed8', '#fde047', 8.6, 2.4, true);
  finishSign.position.set(-157.5, 6.2, 187.0);
  finishSign.rotation.y = Math.PI;
  lavaGroup.add(finishSign);

  // =========================================================================
  // F. CAR FOOTBALL PITCH AT (74, 0, 162) & INTERACTIVE ROLLING SOCCER BALL
  // =========================================================================
  const footballGroup = new THREE.Group();
  footballGroup.name = 'car_football_pitch';
  group.add(footballGroup);

  const pitchTex = cloneTex(textures.grassGrid, 8, 5);
  const pitchMesh = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(FOOTBALL_HALF_W * 2, FOOTBALL_HALF_D * 2)),
    trackMat(createStandardMaterial({ map: pitchTex, color: 0x9df59d, roughness: 0.85, metalness: 0.02 }, scene)),
  );
  pitchMesh.rotation.x = -Math.PI / 2;
  pitchMesh.position.set(FOOTBALL_CX, 0.024, FOOTBALL_CZ);
  pitchMesh.receiveShadow = true;
  footballGroup.add(pitchMesh);

  // Crisp white pitch lines (y = 0.036)
  const addLine = (x, z, w, d) => {
    const m = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(w, d)), whiteTrimMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.036, z);
    footballGroup.add(m);
  };
  addLine(FOOTBALL_CX, FOOTBALL_CZ - FOOTBALL_HALF_D + 0.3, FOOTBALL_HALF_W * 2, 0.45);
  addLine(FOOTBALL_CX, FOOTBALL_CZ + FOOTBALL_HALF_D - 0.3, FOOTBALL_HALF_W * 2, 0.45);
  addLine(FOOTBALL_CX - FOOTBALL_HALF_W + 0.3, FOOTBALL_CZ, 0.45, FOOTBALL_HALF_D * 2);
  addLine(FOOTBALL_CX + FOOTBALL_HALF_W - 0.3, FOOTBALL_CZ, 0.45, FOOTBALL_HALF_D * 2);
  addLine(FOOTBALL_CX, FOOTBALL_CZ, 0.45, FOOTBALL_HALF_D * 2); // halfway line

  const centerRing = new THREE.Mesh(trackGeo(new THREE.RingGeometry(4.9, 5.3, 32)), whiteTrimMat);
  centerRing.rotation.x = -Math.PI / 2;
  centerRing.position.set(FOOTBALL_CX, 0.037, FOOTBALL_CZ);
  footballGroup.add(centerRing);

  // Low sideline curbs with 14m open North & South drive-in entrances (x in [67, 81])
  const sideCurbGeo = trackGeo(new THREE.BoxGeometry(15.0, 0.55, 0.65));
  for (const cz of [FOOTBALL_CZ - FOOTBALL_HALF_D - 0.3, FOOTBALL_CZ + FOOTBALL_HALF_D + 0.3]) {
    for (const cx of [FOOTBALL_CX - 14.5, FOOTBALL_CX + 14.5]) {
      const c = new THREE.Mesh(sideCurbGeo, whiteTrimMat);
      c.position.set(cx, 0.28, cz);
      footballGroup.add(c);
    }
  }

  // Blue Goal (West: x in [47.5, 52]) & Orange Goal (East: x in [96, 100.5])
  const buildGoal = (mouthX, dirOut, mat, name) => {
    const g = new THREE.Group();
    g.name = name;
    const goalH = 5.2;
    const goalD = 4.5;
    const postGeo = trackGeo(new THREE.BoxGeometry(0.45, goalH, 0.45));
    for (const gz of [FOOTBALL_CZ - FOOTBALL_GOAL_HALF_Z, FOOTBALL_CZ + FOOTBALL_GOAL_HALF_Z]) {
      const frontPost = new THREE.Mesh(postGeo, mat);
      frontPost.position.set(mouthX, goalH * 0.5, gz);
      g.add(frontPost);
      const backPost = new THREE.Mesh(postGeo, mat);
      backPost.position.set(mouthX + dirOut * goalD, goalH * 0.5, gz);
      g.add(backPost);
      const sideBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(goalD, 0.4, 0.4)), mat);
      sideBar.position.set(mouthX + dirOut * goalD * 0.5, goalH, gz);
      g.add(sideBar);
    }
    const crossBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.45, 0.45, FOOTBALL_GOAL_HALF_Z * 2 + 0.45)), mat);
    crossBar.position.set(mouthX, goalH, FOOTBALL_CZ);
    g.add(crossBar);
    const backTopBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.4, 0.4, FOOTBALL_GOAL_HALF_Z * 2 + 0.4)), mat);
    backTopBar.position.set(mouthX + dirOut * goalD, goalH, FOOTBALL_CZ);
    g.add(backTopBar);

    // Translucent goal nets (back + top + 2 sides)
    const backNet = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(FOOTBALL_GOAL_HALF_Z * 2, goalH)), netMat);
    backNet.position.set(mouthX + dirOut * goalD, goalH * 0.5, FOOTBALL_CZ);
    backNet.rotation.y = Math.PI / 2;
    g.add(backNet);
    const topNet = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(goalD, FOOTBALL_GOAL_HALF_Z * 2)), netMat);
    topNet.position.set(mouthX + dirOut * goalD * 0.5, goalH, FOOTBALL_CZ);
    topNet.rotation.x = -Math.PI / 2;
    g.add(topNet);
    const sideNetGeo = trackGeo(new THREE.PlaneGeometry(goalD, goalH));
    for (const gz of [FOOTBALL_CZ - FOOTBALL_GOAL_HALF_Z, FOOTBALL_CZ + FOOTBALL_GOAL_HALF_Z]) {
      const sn = new THREE.Mesh(sideNetGeo, netMat);
      sn.position.set(mouthX + dirOut * goalD * 0.5, goalH * 0.5, gz);
      g.add(sn);
    }
    footballGroup.add(g);
  };
  buildGoal(FOOTBALL_CX - FOOTBALL_HALF_W, -1, blueGoalMat, 'football_goal_blue');
  buildGoal(FOOTBALL_CX + FOOTBALL_HALF_W, +1, orangeGoalMat, 'football_goal_orange');

  // Dynamic owned 512x256 Scoreboard at (74, 6.2, 144.8)
  const { canvas: scoreCanvas, tex: scoreTex } = makeFootballScoreboardCanvas();
  trackTex(scoreTex);
  drawFootballScoreboard(scoreCanvas, scoreTex, 0, 0, 'FIRST TO 3 WINS');

  const scoreGroup = new THREE.Group();
  scoreGroup.position.set(FOOTBALL_CX, 0, 144.8);
  footballGroup.add(scoreGroup);
  for (const sx of [-4.4, 4.4]) {
    const leg = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.55, 4.0, 0.36)), darkSteelMat);
    leg.position.set(sx, 2.0, 0);
    scoreGroup.add(leg);
  }
  const scoreBack = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(11.8, 4.5, 0.45)), signFrameMat);
  scoreBack.position.set(0, 6.2, 0);
  scoreGroup.add(scoreBack);
  const scoreMat = trackMat(createStandardMaterial({
    map: scoreTex,
    emissive: 0x222222,
    emissiveMap: scoreTex,
    emissiveIntensity: 0.30,
    roughness: 0.50,
    metalness: 0.06,
  }, scene));
  const scoreFaceF = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(11.5, 4.2)), scoreMat);
  scoreFaceF.position.set(0, 6.2, 0.24);
  scoreGroup.add(scoreFaceF);
  const scoreFaceB = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(11.5, 4.2)), scoreMat);
  scoreFaceB.position.set(0, 6.2, -0.24);
  scoreFaceB.rotation.y = Math.PI;
  scoreGroup.add(scoreFaceB);

  // Interactive Giant Soccer Ball (R = 2.1m)
  const ballTex = trackTex(makeSoccerBallTexture());
  const ballMesh = new THREE.Mesh(
    trackGeo(new THREE.SphereGeometry(FOOTBALL_BALL_R, 20, 14)),
    trackMat(createStandardMaterial({ map: ballTex, roughness: 0.42, metalness: 0.06 }, scene)),
  );
  ballMesh.name = 'car_football_ball';
  ballMesh.position.set(FOOTBALL_CX, FOOTBALL_BALL_R, FOOTBALL_CZ);
  ballMesh.castShadow = true;
  footballGroup.add(ballMesh);

  // =========================================================================
  // RUNTIME STATE & ANIMATION
  // =========================================================================
  let elapsed = 0;
  let catapultAnim = 0; // 0 = rest, >0 active snap/reset timer
  const catapultDuration = 1.15;

  const ball = {
    x: FOOTBALL_CX,
    y: FOOTBALL_BALL_R,
    z: FOOTBALL_CZ,
    vx: 0,
    vy: 0,
    vz: 0,
    blueScore: 0,
    orangeScore: 0,
    lastScorer: null,
    goalTimer: 0,
  };
  const pendingGoalImpacts = [];
  const scratchAxis = new THREE.Vector3();
  const scratchQuat = new THREE.Quaternion();

  // Internal fallback cooldown map when called standalone without ctx
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

  const resetBallCenter = () => {
    ball.x = FOOTBALL_CX;
    ball.y = FOOTBALL_BALL_R;
    ball.z = FOOTBALL_CZ;
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
    ballMesh.position.set(ball.x, ball.y, ball.z);
  };

  const update = (dt, rawVeh) => {
    const safeDt = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 0;
    if (safeDt <= 0) return;
    elapsed += safeDt;
    defaultCtx.simTime = elapsed;

    // 1. Rotate #101 Rally Raider turntable continuously
    turntableDeckGroup.rotation.y += 0.65 * safeDt;

    // 2. Scroll cloned lava UVs & gently pulse magma emissive
    lavaTex.offset.x = (elapsed * 0.06) % 1;
    lavaTex.offset.y = (elapsed * 0.045) % 1;
    lavaMat.emissiveIntensity = 0.58 + 0.16 * Math.sin(elapsed * 2.6);

    // 3. Animate shattered Demolition Lab glass shards
    for (let i = 0; i < shardPool.length; i += 1) {
      const s = shardPool[i];
      if (!s.active) continue;
      s.life -= safeDt;
      if (s.life <= 0) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      s.vy -= 18.0 * safeDt;
      s.mesh.position.x += s.vx * safeDt;
      s.mesh.position.y += s.vy * safeDt;
      s.mesh.position.z += s.vz * safeDt;
      if (s.mesh.position.y < 0.25) {
        s.mesh.position.y = 0.25;
        s.vy = Math.abs(s.vy) * 0.35;
        s.vx *= 0.82;
        s.vz *= 0.82;
      }
      s.mesh.rotation.x += s.rx * safeDt;
      s.mesh.rotation.y += s.ry * safeDt;
    }

    // 4. Animate Lava Obby Skull Catapult plate (+pitch swings North tip UPWARD!) & springs
    if (catapultAnim > 0) {
      catapultAnim = Math.max(0, catapultAnim - safeDt);
      const t = catapultDuration - catapultAnim;
      let pitch = 0;
      if (t < 0.14) {
        pitch = 0.72 * (t / 0.14);
      } else if (t < 0.54) {
        pitch = 0.72;
      } else {
        pitch = 0.72 * Math.max(0, 1 - (t - 0.54) / 0.61);
      }
      catapultPivot.rotation.x = pitch;
      const stretch = 1 + Math.sin(Math.abs(pitch)) * 12.0;
      const springY = BRIDGE_Y - 0.02 + SPRING_BASE_H * 0.5 * stretch;
      for (let i = 0; i < springs.length; i += 1) {
        springs[i].scale.y = stretch;
        springs[i].position.y = springY;
      }
    } else if (catapultPivot.rotation.x !== 0) {
      catapultPivot.rotation.x = 0;
      for (let i = 0; i < springs.length; i += 1) {
        springs[i].scale.y = 1;
        springs[i].position.y = SPRING_REST_Y;
      }
    }

    // 5. Update interactive Car Football soccer ball physics
    const veh = normalizeVehInput(rawVeh);
    if (ball.goalTimer > 0) {
      ball.goalTimer -= safeDt;
      if (ball.goalTimer <= 0) {
        ball.goalTimer = 0;
        if (ball.blueScore >= 3 || ball.orangeScore >= 3) {
          ball.blueScore = 0;
          ball.orangeScore = 0;
          drawFootballScoreboard(scoreCanvas, scoreTex, 0, 0, 'FIRST TO 3 WINS');
        } else {
          drawFootballScoreboard(scoreCanvas, scoreTex, ball.blueScore, ball.orangeScore, 'FIRST TO 3 WINS');
        }
        resetBallCenter();
      }
    }

    if (veh.valid) {
      const dx = ball.x - veh.x;
      const dz = ball.z - veh.z;
      const dist = Math.hypot(dx, dz);
      const minDist = FOOTBALL_BALL_R + veh.radius;
      if (dist < minDist && Math.abs(ball.y - (veh.y + 0.9)) < 3.4) {
        const inv = dist > 1e-4 ? 1 / dist : 1;
        const nx = dist > 1e-4 ? dx * inv : 1;
        const nz = dist > 1e-4 ? dz * inv : 0;
        ball.x = veh.x + nx * (minDist + 0.06);
        ball.z = veh.z + nz * (minDist + 0.06);
        const kick = clamp(veh.speed * 1.35, 10, 38);
        ball.vx = nx * kick + veh.vx * 0.45;
        ball.vz = nz * kick + veh.vz * 0.45;
        ball.vy = Math.max(ball.vy, clamp(veh.speed * 0.20, 1.5, 7.0));
      }
    }

    ball.vy -= 18.0 * safeDt;
    ball.x += ball.vx * safeDt;
    ball.y += ball.vy * safeDt;
    ball.z += ball.vz * safeDt;

    if (ball.y < FOOTBALL_BALL_R) {
      ball.y = FOOTBALL_BALL_R;
      ball.vy = Math.abs(ball.vy) > 1.2 ? -ball.vy * 0.55 : 0;
    }

    const drag = Math.exp(-0.65 * safeDt);
    ball.vx *= drag;
    ball.vz *= drag;
    if (Math.hypot(ball.vx, ball.vz) < 0.05) {
      ball.vx = 0;
      ball.vz = 0;
    }

    // Pitch sideline containment (z in [150.1, 173.9])
    const zMin = FOOTBALL_CZ - FOOTBALL_HALF_D + FOOTBALL_BALL_R;
    const zMax = FOOTBALL_CZ + FOOTBALL_HALF_D - FOOTBALL_BALL_R;
    if (ball.z < zMin) {
      ball.z = zMin;
      ball.vz = Math.abs(ball.vz) * 0.72;
    } else if (ball.z > zMax) {
      ball.z = zMax;
      ball.vz = -Math.abs(ball.vz) * 0.72;
    }

    // Endline containment outside goal mouth; allow ball into goal boxes inside mouth
    const inGoalMouth = Math.abs(ball.z - FOOTBALL_CZ) < FOOTBALL_GOAL_HALF_Z - 0.2;
    const xMinField = FOOTBALL_CX - FOOTBALL_HALF_W + FOOTBALL_BALL_R;
    const xMaxField = FOOTBALL_CX + FOOTBALL_HALF_W - FOOTBALL_BALL_R;
    const xMinNet = FOOTBALL_CX - FOOTBALL_HALF_W - 4.2 + FOOTBALL_BALL_R;
    const xMaxNet = FOOTBALL_CX + FOOTBALL_HALF_W + 4.2 - FOOTBALL_BALL_R;

    if (!inGoalMouth) {
      if (ball.x < xMinField) {
        ball.x = xMinField;
        ball.vx = Math.abs(ball.vx) * 0.72;
      } else if (ball.x > xMaxField) {
        ball.x = xMaxField;
        ball.vx = -Math.abs(ball.vx) * 0.72;
      }
    } else {
      if (ball.x < xMinNet) {
        ball.x = xMinNet;
        ball.vx = Math.abs(ball.vx) * 0.35;
      } else if (ball.x > xMaxNet) {
        ball.x = xMaxNet;
        ball.vx = -Math.abs(ball.vx) * 0.35;
      }
    }

    // Goal detection
    if (ball.goalTimer <= 0 && Math.abs(ball.z - FOOTBALL_CZ) < FOOTBALL_GOAL_HALF_Z) {
      if (ball.x > FOOTBALL_CX + FOOTBALL_HALF_W + 0.4) {
        ball.blueScore += 1;
        ball.lastScorer = 'blue';
        ball.goalTimer = 2.0;
        const winBanner = ball.blueScore >= 3 ? 'BLUE WINS! RESETTING...' : 'GOAL! BLUE SCORES!';
        drawFootballScoreboard(scoreCanvas, scoreTex, ball.blueScore, ball.orangeScore, winBanner);
        pendingGoalImpacts.push({
          kind: 'ring',
          damage: 0,
          impulse: [0, 0, 0],
          crushY: 0,
          frontCrumple: 0,
          cashBonus: 250,
          xpBonus: 120,
          label: `GOAL! BLUE ${ball.blueScore} - ${ball.orangeScore} ORANGE`,
          sound: 'trick',
          ignite: false,
          explode: false,
          ejectRagdoll: false,
        });
      } else if (ball.x < FOOTBALL_CX - FOOTBALL_HALF_W - 0.4) {
        ball.orangeScore += 1;
        ball.lastScorer = 'orange';
        ball.goalTimer = 2.0;
        const winBanner = ball.orangeScore >= 3 ? 'ORANGE WINS! RESETTING...' : 'GOAL! ORANGE SCORES!';
        drawFootballScoreboard(scoreCanvas, scoreTex, ball.blueScore, ball.orangeScore, winBanner);
        pendingGoalImpacts.push({
          kind: 'ring',
          damage: 0,
          impulse: [0, 0, 0],
          crushY: 0,
          frontCrumple: 0,
          cashBonus: 250,
          xpBonus: 120,
          label: `GOAL! BLUE ${ball.blueScore} - ${ball.orangeScore} ORANGE`,
          sound: 'trick',
          ignite: false,
          explode: false,
          ejectRagdoll: false,
        });
      }
    }

    // True rolling spin quaternion
    const hSpd = Math.hypot(ball.vx, ball.vz);
    if (hSpd > 0.05) {
      scratchAxis.set(ball.vz / hSpd, 0, -ball.vx / hSpd).normalize();
      scratchQuat.setFromAxisAngle(scratchAxis, (hSpd * safeDt) / FOOTBALL_BALL_R);
      ballMesh.quaternion.premultiply(scratchQuat);
    }
    ballMesh.position.set(ball.x, ball.y, ball.z);
  };

  const queryHazards = (rawVeh, ctx) => {
    const impacts = [];
    // Flush any queued Car Football goal celebration impacts
    while (pendingGoalImpacts.length > 0) {
      impacts.push(pendingGoalImpacts.shift());
    }

    const veh = normalizeVehInput(rawVeh);
    if (!veh.valid) return impacts;
    const activeCtx = ctx || defaultCtx;

    // 1. Breakable Glass Demolition Lab panels (12 panes)
    if (veh.x > -14 && veh.x < 14 && veh.z > -35 && veh.z < -14 && veh.y < 4.8) {
      for (let i = 0; i < glassPanes.length; i += 1) {
        const pane = glassPanes[i];
        if (pane.broken) continue;
        if (
          Math.abs(veh.x - pane.cx) < pane.halfW + veh.radius * 0.85
          && Math.abs(veh.z - pane.cz) < pane.halfD + veh.radius * 0.85
        ) {
          pane.broken = true;
          pane.mesh.visible = false;
          spawnGlassShards(pane.cx, pane.cz, veh.vx, veh.vz);
          impacts.push({
            kind: 'glass',
            damage: 10,
            impulse: [-veh.vx * 0.08, 0.4, -veh.vz * 0.08],
            crushY: 0,
            frontCrumple: 0.10,
            cashBonus: 65,
            xpBonus: 30,
            label: 'GLASS SHATTER!',
            sound: 'glass',
            ignite: false,
            explode: false,
            ejectRagdoll: false,
          });
        }
      }

      // Corner showroom steel pillars
      for (let i = 0; i < labCornerPillars.length; i += 1) {
        const [px, pz] = labCornerPillars[i];
        const dx = veh.x - px;
        const dz = veh.z - pz;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.65 + veh.radius * 0.72 && activeCtx.canHit(`lab_pillar_${i}`, 0.45)) {
          const inv = dist > 1e-4 ? 1 / dist : 1;
          impacts.push({
            kind: 'pillar',
            damage: 14,
            impulse: [dx * inv * 11, 1.5, dz * inv * 11],
            crushY: 0,
            frontCrumple: 0.16,
            cashBonus: 25,
            xpBonus: 12,
            label: 'SHOWROOM PILLAR!',
            sound: 'crash',
            ignite: false,
            explode: false,
            ejectRagdoll: false,
          });
        }
      }
    }

    // 2. #101 Rally Raider Turntable bump around (16, -3)
    const tdx = veh.x - TURNTABLE_X;
    const tdz = veh.z - TURNTABLE_Z;
    const tDist = Math.hypot(tdx, tdz);
    if (tDist < 4.8 + veh.radius && veh.y < 3.5 && activeCtx.canHit('hub_turntable', 0.50)) {
      const inv = tDist > 1e-4 ? 1 / tDist : 1;
      impacts.push({
        kind: 'pillar',
        damage: 8,
        impulse: [tdx * inv * 10, 1.5, tdz * inv * 10],
        crushY: 0,
        frontCrumple: 0.12,
        cashBonus: 20,
        xpBonus: 10,
        label: 'TURNTABLE BUMP!',
        sound: 'crash',
        ignite: false,
        explode: false,
        ejectRagdoll: false,
      });
    }

    // 3. Lava Obby Skull Catapult (-X fork: x in [-176.3, -168.7], z in [151, 160])
    if (
      Math.abs(veh.x - (-172.5)) < 3.8
      && veh.z >= 151.0
      && veh.z <= 160.0
      && veh.y >= 0.8
      && veh.y < 3.4
      && activeCtx.canHit('lava_catapult', 1.25)
    ) {
      catapultAnim = catapultDuration;
      impacts.push({
        kind: 'catapult',
        damage: 24,
        impulse: [7.5, 22.0, 12.0],
        crushY: 0,
        frontCrumple: 0.15,
        cashBonus: 95,
        xpBonus: 60,
        label: 'SKULL CATAPULT!',
        sound: 'explosion',
        ignite: false,
        explode: false,
        ejectRagdoll: true,
      });
    }

    // 4. Lava Obby Safe Finish Bonus at (-157.5, 187)
    if (
      Math.abs(veh.x - (-157.5)) < 4.4
      && Math.abs(veh.z - 187.0) < 2.6
      && veh.y < 4.5
      && activeCtx.canHit('lava_obby_finish', 5.0)
    ) {
      impacts.push({
        kind: 'ring',
        damage: 0,
        impulse: [0, 0, 0],
        crushY: 0,
        frontCrumple: 0,
        cashBonus: 100,
        xpBonus: 60,
        label: 'OBBY CLEAR! +$100',
        sound: 'cash',
        ignite: false,
        explode: false,
        ejectRagdoll: false,
      });
    }

    // 5. Molten Lava Pit hazard (inside pit and below bridge surface)
    if (
      veh.x >= LAVA_MIN_X + 0.5
      && veh.x <= LAVA_MAX_X - 0.5
      && veh.z >= LAVA_MIN_Z + 0.5
      && veh.z <= LAVA_MAX_Z - 0.5
      && veh.y < 0.65
      && sampleLavaObbyBridge(veh.x, veh.z) === null
      && activeCtx.canHit('molten_lava', 0.55)
    ) {
      impacts.push({
        kind: 'lava',
        damage: 14,
        impulse: [0, 1.2, 0],
        crushY: 0.04,
        frontCrumple: 0,
        cashBonus: 40,
        xpBonus: 25,
        label: 'MOLTEN LAVA!',
        sound: 'crash',
        ignite: true,
        explode: false,
        ejectRagdoll: false,
      });
    }

    return impacts;
  };

  const resetBreakables = () => {
    for (let i = 0; i < glassPanes.length; i += 1) {
      glassPanes[i].broken = false;
      glassPanes[i].mesh.visible = true;
    }
    for (let i = 0; i < shardPool.length; i += 1) {
      shardPool[i].active = false;
      shardPool[i].mesh.visible = false;
    }
    catapultAnim = 0;
    catapultPivot.rotation.x = 0;
    for (let i = 0; i < springs.length; i += 1) {
      springs[i].scale.y = 1;
      springs[i].position.y = SPRING_REST_Y;
    }
    if (ball.blueScore >= 3 || ball.orangeScore >= 3) {
      ball.blueScore = 0;
      ball.orangeScore = 0;
      ball.lastScorer = null;
      drawFootballScoreboard(scoreCanvas, scoreTex, 0, 0, 'FIRST TO 3 WINS');
    } else if (ball.goalTimer > 0) {
      drawFootballScoreboard(scoreCanvas, scoreTex, ball.blueScore, ball.orangeScore, 'FIRST TO 3 WINS');
    }
    ball.goalTimer = 0;
    pendingGoalImpacts.length = 0;
    resetBallCenter();
    localCooldowns.clear();
  };

  const getSoccerBallState = () => ({
    position: [ball.x, ball.y, ball.z],
    velocity: [ball.vx, ball.vy, ball.vz],
    radius: FOOTBALL_BALL_R,
    blueScore: ball.blueScore,
    orangeScore: ball.orangeScore,
    lastScorer: ball.lastScorer,
    goalCooldown: Math.max(0, ball.goalTimer),
    pitchCenter: [FOOTBALL_CX, 0, FOOTBALL_CZ],
  });

  const getActiveAlerts = (pos) => {
    if (!pos) return [];
    const px = Array.isArray(pos) ? pos[0] : pos.x;
    const pz = Array.isArray(pos) ? pos[2] : pos.z;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return [];
    if (Math.hypot(px - (-165), pz - 155) <= 34) {
      return [{
        id: 'lava_obby_hint',
        zoneId: 'lava_obby',
        text: 'LAVA OBBY: LEFT ✓ SAFE • RIGHT ☠ CATAPULT!',
        severity: 'warn',
        triggerable: false,
        triggerLabel: '',
        shortLabel: '',
      }];
    }
    return [];
  };

  const surfaceRegions = [
    {
      id: 'lava_obby_bridge',
      priority: 20,
      minX: -176.5,
      maxX: -153.5,
      minZ: 131.0,
      maxZ: 185.0,
      sample: sampleLavaObbyBridge,
    },
    {
      id: 'lava_pit',
      priority: 10,
      minX: LAVA_MIN_X,
      maxX: LAVA_MAX_X,
      minZ: LAVA_MIN_Z,
      maxZ: LAVA_MAX_Z,
      sample: sampleLavaPit,
    },
  ];

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const inst of ownedInstanced) inst.dispose();
    for (const g of ownedGeometries) g.dispose();
    for (const m of ownedMaterials) m.dispose();
    for (const t of ownedTextures) t.dispose();
    ownedInstanced.clear();
    ownedGeometries.clear();
    ownedMaterials.clear();
    ownedTextures.clear();
  };

  return {
    group,
    surfaceRegions,
    update,
    queryHazards,
    triggerZoneMachine: () => null,
    getManualTriggerSpots: () => [],
    getActiveAlerts,
    resetBreakables,
    getSoccerBallState,
    getGlassState: () => ({
      total: glassPanes.length,
      intact: glassPanes.filter((p) => !p.broken).length,
      broken: glassPanes.filter((p) => p.broken).length,
    }),
    getTurntableRotation: () => turntableDeckGroup.rotation.y,
    dispose,
  };
}
