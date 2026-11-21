/**
 * Blocky Roblox R15-Style Avatars (JJ & Mikey_Turtle) + Multi-Limb Ragdoll
 * (Contract #10).
 *
 * Coordinate convention (shared with vehicles.js, camera.js, M2A/M2B/M3):
 *   - Local +Z = avatar FRONT (face / eyes), -Z = BACK, +Y = UP, +X = avatar LEFT.
 *   - Seated mode places pelvis bottom at y ~ 0 (seatOffset) with top-of-hood <= 0.635 m
 *     and face front <= +0.08 m so both JJ (with rear-draped bunny ears) and Mikey
 *     fit cleanly inside all 12 vehicles (including rally_raider 0.74 m headroom and
 *     tuk_tuk +0.33 m cockpit-camera Z clearance).
 *   - Standing mode places shoe soles cleanly on y = 0.000 m.
 *   - WebKit Guardrail 1 & 2 compliant: zero renderer.compile, 100% createStandardMaterial
 *     with metalness <= 0.20, bespoke 128x128 SRGBColorSpace CanvasTextures disposed on dispose().
 */

import * as THREE from '../../vendor/three.module.min.js';
import { createStandardMaterial } from '../core/materials.js';

const RAGDOLL_GRAVITY = 24.0;
const RAGDOLL_RADIUS = 0.24;
const RAGDOLL_BOUNCE = 0.36;
const MAX_RAGDOLL_SPEED = 65.0;

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

function readVec3(input, out, fx = 0, fy = 0, fz = 0) {
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

function findAncestorScene(obj) {
  let cur = obj;
  while (cur) {
    if (cur.isScene) return cur;
    cur = cur.parent;
  }
  return null;
}

function createRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
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

function createFaceCanvasTexture(resolvedStyle) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (resolvedStyle === 'mikey') {
    // Bright green turtle hood frame with soft lighter-green face oval
    ctx.fillStyle = '#43a047';
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#81c784';
    ctx.beginPath();
    drawRoundedRect(ctx, 14, 18, 100, 94, 24);
    ctx.fill();

    // Subtle green cheek highlights
    ctx.fillStyle = 'rgba(255, 241, 118, 0.35)';
    ctx.beginPath();
    ctx.ellipse(30, 78, 10, 6, 0, 0, Math.PI * 2);
    ctx.ellipse(98, 78, 10, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Big cute cartoon turtle eyes (white sclera + dark pupils + sparkle)
    for (const ex of [42, 86]) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(ex, 52, 15, 18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1b5e20';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = '#111827';
      ctx.beginPath();
      ctx.ellipse(ex, 54, 8.5, 11, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex - 3.5, 48, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex + 3.0, 58, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Small cute nostrils
    ctx.fillStyle = '#2e7d32';
    ctx.beginPath();
    ctx.arc(58, 70, 2.2, 0, Math.PI * 2);
    ctx.arc(70, 70, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // Cheerful wide turtle smile
    ctx.strokeStyle = '#1b5e20';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(64, 74, 22, 0.18 * Math.PI, 0.82 * Math.PI);
    ctx.stroke();

    // Subtle lower lip gleam
    ctx.strokeStyle = '#a5d6a7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(64, 82, 14, 0.28 * Math.PI, 0.72 * Math.PI);
    ctx.stroke();
  } else {
    // Classic Roblox JJ crisp white face with friendly smiling eyes & grin
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, size, size);

    // Soft rosy cheeks
    ctx.fillStyle = 'rgba(255, 138, 128, 0.36)';
    ctx.beginPath();
    ctx.ellipse(27, 74, 11, 7, 0, 0, Math.PI * 2);
    ctx.ellipse(101, 74, 11, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // Happy eyebrows
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(42, 42, 12, 1.15 * Math.PI, 1.85 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(86, 42, 12, 1.15 * Math.PI, 1.85 * Math.PI);
    ctx.stroke();

    // Bold Roblox oval black eyes with crisp catchlights
    for (const ex of [42, 86]) {
      ctx.fillStyle = '#111827';
      ctx.beginPath();
      ctx.ellipse(ex, 55, 8.5, 12.5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex - 2.6, 50, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex + 2.2, 59, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Friendly wide Roblox smile
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(64, 74, 24, 0.12 * Math.PI, 0.88 * Math.PI);
    ctx.quadraticCurveTo(64, 83, 64 + 24 * Math.cos(0.12 * Math.PI), 74 + 24 * Math.sin(0.12 * Math.PI));
    ctx.fill();

    // Crisp white teeth band inside grin
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(64, 83, 14, 4.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates an articulated blocky Roblox R15-style avatar ('jj' or 'mikey')
 * supporting seated driving, steering animation, squash-proof multi-limb
 * ragdoll physics with ground bouncing, seat reset, and clean disposal.
 *
 * @param {'jj'|'mikey'|string} [style='jj']
 * @param {THREE.Scene|null} [scene=null]
 */
export function createRobloxAvatar(style = 'jj', scene = null) {
  const s = String(style ?? 'jj').trim().toLowerCase();
  const resolvedStyle = (s === 'mikey' || s === 'mikey_turtle' || s === 'turtle') ? 'mikey' : 'jj';
  const defaultScene = scene && typeof scene.add === 'function' ? scene : null;

  const ownedGeoms = [];
  const ownedMats = [];
  const ownedTextures = [];

  const trackGeom = (geo) => {
    ownedGeoms.push(geo);
    return geo;
  };
  const makeMat = (params) => {
    const mat = createStandardMaterial(params, defaultScene);
    ownedMats.push(mat);
    return mat;
  };
  const makeBox = (w, h, d, mat, pos = null, name = '') => {
    const mesh = new THREE.Mesh(trackGeom(new THREE.BoxGeometry(w, h, d)), mat);
    if (pos) mesh.position.set(pos[0], pos[1], pos[2]);
    if (name) mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  // Materials (all metalness strictly <= 0.10, Guardrail 2 compliant)
  const faceTex = createFaceCanvasTexture(resolvedStyle);
  if (faceTex) ownedTextures.push(faceTex);

  const isMikey = resolvedStyle === 'mikey';

  const primaryMat = makeMat({
    name: `${resolvedStyle}_primary`,
    color: isMikey ? 0x43a047 : 0xe53935,
    roughness: 0.62,
    metalness: 0.05,
  });
  const shadeMat = makeMat({
    name: `${resolvedStyle}_shade`,
    color: isMikey ? 0x2e7d32 : 0xb71c1c,
    roughness: 0.68,
    metalness: 0.05,
  });
  const accentMat = makeMat({
    name: `${resolvedStyle}_accent`,
    color: isMikey ? 0xfdd835 : 0xf8fafc,
    roughness: 0.56,
    metalness: 0.04,
  });
  const pantsMat = makeMat({
    name: `${resolvedStyle}_pants`,
    color: isMikey ? 0x43a047 : 0x1c2026,
    roughness: 0.72,
    metalness: 0.04,
  });
  const handMat = makeMat({
    name: `${resolvedStyle}_hand`,
    color: isMikey ? 0x43a047 : 0xf8fafc,
    roughness: 0.55,
    metalness: 0.04,
  });
  const shoeMat = makeMat({
    name: `${resolvedStyle}_shoe`,
    color: isMikey ? 0x2e7d32 : 0xf8fafc,
    roughness: 0.58,
    metalness: 0.05,
  });
  const soleMat = makeMat({
    name: `${resolvedStyle}_sole`,
    color: isMikey ? 0x1b5e20 : 0x374151,
    roughness: 0.80,
    metalness: 0.04,
  });
  const headSideMat = makeMat({
    name: `${resolvedStyle}_head_side`,
    color: isMikey ? 0x43a047 : 0xf8fafc,
    roughness: 0.55,
    metalness: 0.04,
  });
  const headFaceMat = makeMat({
    name: `${resolvedStyle}_head_face`,
    color: 0xffffff,
    map: faceTex || null,
    roughness: 0.52,
    metalness: 0.04,
  });

  // Extra style-specific materials
  const earPinkMat = isMikey ? null : makeMat({
    name: 'jj_ear_pink',
    color: 0xff8a80,
    roughness: 0.66,
    metalness: 0.03,
  });
  const shellLightMat = isMikey ? makeMat({
    name: 'mikey_shell_light',
    color: 0x66bb6a,
    roughness: 0.60,
    metalness: 0.06,
  }) : null;
  const shellRimMat = isMikey ? makeMat({
    name: 'mikey_shell_rim',
    color: 0xffee58,
    roughness: 0.60,
    metalness: 0.05,
  }) : null;

  // Root & articulated R15 joint hierarchy
  const group = new THREE.Group();
  group.name = `roblox_avatar_${resolvedStyle}`;
  group.userData.avatarStyle = resolvedStyle;

  const pelvis = new THREE.Group();
  pelvis.name = 'pelvis';
  group.add(pelvis);

  // Pelvis / waist block
  pelvis.add(makeBox(0.36, 0.095, 0.21, isMikey ? primaryMat : pantsMat, [0, 0, 0], 'pelvis_mesh'));

  // Torso pivot
  const torsoPivot = new THREE.Group();
  torsoPivot.name = 'torso_pivot';
  torsoPivot.position.set(0, 0.045, 0);
  pelvis.add(torsoPivot);

  torsoPivot.add(makeBox(0.38, 0.29, 0.22, primaryMat, [0, 0.145, 0], 'torso_mesh'));

  if (!isMikey) {
    // JJ red hoodie hem, kangaroo pocket, collar & white drawstrings
    torsoPivot.add(makeBox(0.39, 0.045, 0.23, shadeMat, [0, 0.022, 0], 'hoodie_hem'));
    torsoPivot.add(makeBox(0.24, 0.095, 0.028, shadeMat, [0, 0.085, 0.114], 'kangaroo_pocket'));
    torsoPivot.add(makeBox(0.26, 0.042, 0.23, shadeMat, [0, 0.278, 0], 'hoodie_collar'));
    torsoPivot.add(makeBox(0.016, 0.095, 0.014, accentMat, [0.052, 0.225, 0.118], 'drawstring_l'));
    torsoPivot.add(makeBox(0.016, 0.095, 0.014, accentMat, [-0.052, 0.225, 0.118], 'drawstring_r'));
  } else {
    // Mikey yellow belly panel (plastron) with subtle horizontal crease bars
    torsoPivot.add(makeBox(0.265, 0.225, 0.026, accentMat, [0, 0.142, 0.112], 'turtle_belly'));
    torsoPivot.add(makeBox(0.24, 0.012, 0.008, shadeMat, [0, 0.175, 0.126], 'belly_crease_1'));
    torsoPivot.add(makeBox(0.24, 0.012, 0.008, shadeMat, [0, 0.108, 0.126], 'belly_crease_2'));

    // Mikey sculpted multi-layer green turtle shell on torso back (-Z)
    const shellGroup = new THREE.Group();
    shellGroup.name = 'turtle_shell';
    torsoPivot.add(shellGroup);
    shellGroup.add(makeBox(0.355, 0.295, 0.032, shellRimMat, [0, 0.148, -0.124], 'shell_rim'));
    shellGroup.add(makeBox(0.33, 0.275, 0.060, shadeMat, [0, 0.148, -0.156], 'shell_body'));
    shellGroup.add(makeBox(0.235, 0.205, 0.038, shellLightMat, [0, 0.148, -0.190], 'shell_cap'));
    // Central dorsal scutes along spine
    shellGroup.add(makeBox(0.095, 0.052, 0.020, shadeMat, [0, 0.212, -0.212], 'shell_scute_top'));
    shellGroup.add(makeBox(0.110, 0.058, 0.022, shadeMat, [0, 0.148, -0.214], 'shell_scute_mid'));
    shellGroup.add(makeBox(0.095, 0.052, 0.020, shadeMat, [0, 0.084, -0.212], 'shell_scute_bot'));
  }

  // Head pivot
  const headPivot = new THREE.Group();
  headPivot.name = 'head_pivot';
  headPivot.position.set(0, 0.295, 0);
  torsoPivot.add(headPivot);

  // Head cube with 6-material array so face texture maps onto +Z (index 4)
  const headMesh = new THREE.Mesh(
    trackGeom(new THREE.BoxGeometry(0.225, 0.215, 0.215)),
    [headSideMat, headSideMat, headSideMat, headSideMat, headFaceMat, headSideMat],
  );
  headMesh.position.set(0, 0.11, 0);
  headMesh.name = 'head_mesh';
  headMesh.castShadow = true;
  headMesh.receiveShadow = true;
  headPivot.add(headMesh);

  let earLBase = null;
  let earLTip = null;
  let earRBase = null;
  let earRTip = null;

  if (!isMikey) {
    // JJ red hood shell framing the white face (+Z face remains fully exposed)
    headPivot.add(makeBox(0.256, 0.024, 0.244, primaryMat, [0, 0.225, -0.008], 'hood_top'));
    headPivot.add(makeBox(0.256, 0.236, 0.036, primaryMat, [0, 0.112, -0.116], 'hood_back'));
    headPivot.add(makeBox(0.024, 0.232, 0.238, primaryMat, [0.122, 0.112, -0.008], 'hood_left'));
    headPivot.add(makeBox(0.024, 0.232, 0.238, primaryMat, [-0.122, 0.112, -0.008], 'hood_right'));
    headPivot.add(makeBox(0.258, 0.024, 0.026, shadeMat, [0, 0.218, 0.106], 'hood_brow_rim'));

    // Two articulated 2-segment floppy red bunny ears
    const buildBunnyEar = (sideSign, prefix) => {
      const basePivot = new THREE.Group();
      basePivot.name = `${prefix}_base`;
      // Mounted near back-top of hood so rear-draped seated pose keeps max Y <= 0.635 m
      basePivot.position.set(sideSign * 0.080, 0.205, -0.055);
      headPivot.add(basePivot);

      basePivot.add(makeBox(0.068, 0.155, 0.040, primaryMat, [0, 0.077, 0], `${prefix}_upper`));
      basePivot.add(makeBox(0.038, 0.125, 0.008, earPinkMat, [0, 0.075, 0.021], `${prefix}_upper_inner`));

      const tipPivot = new THREE.Group();
      tipPivot.name = `${prefix}_tip_pivot`;
      tipPivot.position.set(0, 0.150, 0);
      basePivot.add(tipPivot);

      tipPivot.add(makeBox(0.056, 0.145, 0.036, primaryMat, [0, 0.072, 0], `${prefix}_tip`));
      tipPivot.add(makeBox(0.030, 0.112, 0.008, earPinkMat, [0, 0.070, 0.019], `${prefix}_tip_inner`));
      return { basePivot, tipPivot };
    };

    const earL = buildBunnyEar(+1, 'ear_l');
    const earR = buildBunnyEar(-1, 'ear_r');
    earLBase = earL.basePivot;
    earLTip = earL.tipPivot;
    earRBase = earR.basePivot;
    earRTip = earR.tipPivot;
  } else {
    // Mikey rounded green turtle hood (top dome cap + bevel + back/side hood wrap; seated max Y <= 0.634 m)
    headPivot.add(makeBox(0.252, 0.018, 0.240, primaryMat, [0, 0.220, -0.005], 'turtle_hood_top'));
    headPivot.add(makeBox(0.200, 0.012, 0.195, shadeMat, [0, 0.230, -0.008], 'turtle_hood_crown'));
    headPivot.add(makeBox(0.250, 0.232, 0.032, shadeMat, [0, 0.112, -0.115], 'turtle_hood_back'));
    headPivot.add(makeBox(0.022, 0.226, 0.228, primaryMat, [0.120, 0.112, -0.006], 'turtle_hood_left'));
    headPivot.add(makeBox(0.022, 0.226, 0.228, primaryMat, [-0.120, 0.112, -0.006], 'turtle_hood_right'));
  }

  // Arms (left = +X, right = -X)
  const buildArm = (sideSign, prefix) => {
    const upperPivot = new THREE.Group();
    upperPivot.name = `${prefix}_upper_pivot`;
    upperPivot.position.set(sideSign * 0.25, 0.245, 0);
    torsoPivot.add(upperPivot);

    upperPivot.add(makeBox(0.12, 0.16, 0.125, primaryMat, [0, -0.08, 0], `${prefix}_upper`));

    const lowerPivot = new THREE.Group();
    lowerPivot.name = `${prefix}_lower_pivot`;
    lowerPivot.position.set(0, -0.155, 0);
    upperPivot.add(lowerPivot);

    lowerPivot.add(makeBox(0.112, 0.135, 0.118, primaryMat, [0, -0.068, 0], `${prefix}_lower`));
    // Cuff + white glove (JJ) or green turtle hand (Mikey)
    lowerPivot.add(makeBox(0.118, 0.022, 0.122, shadeMat, [0, -0.124, 0], `${prefix}_cuff`));
    lowerPivot.add(makeBox(0.118, 0.078, 0.118, handMat, [0, -0.165, 0], `${prefix}_hand`));

    return { upperPivot, lowerPivot };
  };

  const armL = buildArm(+1, 'arm_l');
  const armR = buildArm(-1, 'arm_r');

  // Legs (left = +X, right = -X)
  const buildLeg = (sideSign, prefix) => {
    const hipPivot = new THREE.Group();
    hipPivot.name = `${prefix}_hip_pivot`;
    hipPivot.position.set(sideSign * 0.095, -0.02, 0);
    pelvis.add(hipPivot);

    hipPivot.add(makeBox(0.165, 0.22, 0.17, pantsMat, [0, -0.11, 0], `${prefix}_thigh`));
    if (!isMikey) {
      // JJ crisp white side stripe on outer black pant leg
      hipPivot.add(makeBox(0.018, 0.214, 0.044, accentMat, [sideSign * 0.084, -0.11, 0], `${prefix}_stripe_upper`));
    }

    const kneePivot = new THREE.Group();
    kneePivot.name = `${prefix}_knee_pivot`;
    kneePivot.position.set(0, -0.22, 0);
    hipPivot.add(kneePivot);

    kneePivot.add(makeBox(0.158, 0.155, 0.162, pantsMat, [0, -0.078, 0], `${prefix}_calf`));
    if (!isMikey) {
      kneePivot.add(makeBox(0.018, 0.150, 0.042, accentMat, [sideSign * 0.080, -0.078, 0], `${prefix}_stripe_lower`));
    }
    // Sneaker / turtle foot: bottom at -0.182 - 0.0375 = -0.2195 -> standing y = 0.0005 m!
    kneePivot.add(makeBox(0.172, 0.056, 0.235, shoeMat, [0, -0.172, 0.030], `${prefix}_shoe`));
    kneePivot.add(makeBox(0.176, 0.020, 0.240, soleMat, [0, -0.2095, 0.030], `${prefix}_sole`));

    return { hipPivot, kneePivot };
  };

  const legL = buildLeg(+1, 'leg_l');
  const legR = buildLeg(-1, 'leg_r');

  // Animation & Ragdoll state
  let seated = false;
  let currentSteer = 0;
  let ragdolling = false;
  let disposed = false;
  let idlePhase = 0;

  const rng = createRng(isMikey ? 77713 : 42429);
  const linVel = new THREE.Vector3();
  const angVel = new THREE.Vector3();

  // Pre-allocated scratch math (zero per-frame allocations)
  const _tmpPos = new THREE.Vector3();
  const _tmpQuat = new THREE.Quaternion();
  const _tmpAxis = new THREE.Vector3();
  const _tmpDeltaQ = new THREE.Quaternion();
  const _tmpVec = new THREE.Vector3();

  // Articulated limb spring-pendulum states for ragdoll tumbling
  const limbSprings = [
    { obj: armL.upperPivot, axis: 'x', ang: 0, vel: 0, rest: -0.4, min: -2.6, max: 1.3, k: 24, damp: 3.4, couple: 0.9 },
    { obj: armL.upperPivot, axis: 'z', ang: 0, vel: 0, rest: 0.45, min: -0.3, max: 2.2, k: 22, damp: 3.4, couple: 0.7 },
    { obj: armR.upperPivot, axis: 'x', ang: 0, vel: 0, rest: -0.4, min: -2.6, max: 1.3, k: 24, damp: 3.4, couple: -0.9 },
    { obj: armR.upperPivot, axis: 'z', ang: 0, vel: 0, rest: -0.45, min: -2.2, max: 0.3, k: 22, damp: 3.4, couple: -0.7 },
    { obj: armL.lowerPivot, axis: 'x', ang: 0, vel: 0, rest: -0.35, min: -1.6, max: 0.2, k: 28, damp: 3.8, couple: 0.5 },
    { obj: armR.lowerPivot, axis: 'x', ang: 0, vel: 0, rest: -0.35, min: -1.6, max: 0.2, k: 28, damp: 3.8, couple: -0.5 },
    { obj: legL.hipPivot, axis: 'x', ang: 0, vel: 0, rest: -0.25, min: -1.8, max: 1.1, k: 22, damp: 3.6, couple: 0.8 },
    { obj: legR.hipPivot, axis: 'x', ang: 0, vel: 0, rest: 0.25, min: -1.8, max: 1.1, k: 22, damp: 3.6, couple: -0.8 },
    { obj: legL.kneePivot, axis: 'x', ang: 0, vel: 0, rest: 0.35, min: 0.0, max: 2.0, k: 26, damp: 3.8, couple: 0.5 },
    { obj: legR.kneePivot, axis: 'x', ang: 0, vel: 0, rest: 0.35, min: 0.0, max: 2.0, k: 26, damp: 3.8, couple: -0.5 },
    { obj: headPivot, axis: 'x', ang: 0, vel: 0, rest: 0.0, min: -0.55, max: 0.55, k: 34, damp: 4.2, couple: 0.4 },
    { obj: headPivot, axis: 'z', ang: 0, vel: 0, rest: 0.0, min: -0.50, max: 0.50, k: 34, damp: 4.2, couple: 0.4 },
  ];

  if (earLBase && earLTip && earRBase && earRTip) {
    limbSprings.push(
      { obj: earLBase, axis: 'x', ang: -0.25, vel: 0, rest: -0.28, min: -2.1, max: 0.45, k: 18, damp: 2.6, couple: 1.1 },
      { obj: earRBase, axis: 'x', ang: -0.25, vel: 0, rest: -0.28, min: -2.1, max: 0.45, k: 18, damp: 2.6, couple: 1.1 },
      { obj: earLTip, axis: 'x', ang: -0.35, vel: 0, rest: -0.35, min: -1.8, max: 0.65, k: 16, damp: 2.4, couple: 1.2 },
      { obj: earRTip, axis: 'x', ang: -0.35, vel: 0, rest: -0.35, min: -1.8, max: 0.65, k: 16, damp: 2.4, couple: 1.2 },
    );
  }

  function applyPose() {
    if (ragdolling) return;

    torsoPivot.rotation.set(0, 0, 0);
    headPivot.rotation.set(0, 0, 0);

    if (seated) {
      pelvis.position.set(0, 0.055, -0.04);

      // Seated thighs pointing forward (+Z), knees tucked downward into footwell
      legL.hipPivot.rotation.set(-1.52, 0.06, 0.04);
      legR.hipPivot.rotation.set(-1.52, -0.06, -0.04);
      legL.kneePivot.rotation.set(1.02, 0, 0);
      legR.kneePivot.rotation.set(1.02, 0, 0);

      // Right-hand-rule steering: left turn (+steer CCW) dips left arm (+X) and lifts right arm (-X)
      const st = currentSteer;
      armL.upperPivot.rotation.set(-1.12 + st * 0.24, 0, -0.08 - st * 0.18);
      armR.upperPivot.rotation.set(-1.12 - st * 0.24, 0, 0.08 - st * 0.18);
      armL.lowerPivot.rotation.set(-0.35, 0, 0);
      armR.lowerPivot.rotation.set(-0.35, 0, 0);

      torsoPivot.rotation.set(0.04, st * 0.16, -st * 0.08);
      headPivot.rotation.set(-0.02, st * 0.34, -st * 0.05);

      if (earLBase && earLTip && earRBase && earRTip) {
        // Folded neatly backward (-Z) behind headrest, flaring outward away from head (RHR: -Z flares +X left ear outward)
        earLBase.rotation.set(-1.58, 0, -0.24 - st * 0.18);
        earRBase.rotation.set(-1.58, 0, 0.24 - st * 0.18);
        earLTip.rotation.set(-0.45, 0, -0.08);
        earRTip.rotation.set(-0.45, 0, 0.08);
      }
    } else {
      // Standing Roblox idle pose (shoe bottoms at y = 0.0005 m)
      pelvis.position.set(0, 0.46, 0);

      legL.hipPivot.rotation.set(0, 0, 0.02);
      legR.hipPivot.rotation.set(0, 0, -0.02);
      legL.kneePivot.rotation.set(0, 0, 0);
      legR.kneePivot.rotation.set(0, 0, 0);

      armL.upperPivot.rotation.set(0.05, 0, 0.10);
      armR.upperPivot.rotation.set(0.05, 0, -0.10);
      armL.lowerPivot.rotation.set(-0.10, 0, 0);
      armR.lowerPivot.rotation.set(-0.10, 0, 0);

      if (earLBase && earLTip && earRBase && earRTip) {
        // Perky standing floppy bunny ears flaring outward (\ /)
        earLBase.rotation.set(-0.22, 0, -0.24);
        earRBase.rotation.set(-0.22, 0, 0.24);
        earLTip.rotation.set(-0.38, 0, -0.14);
        earRTip.rotation.set(-0.38, 0, 0.14);
      }
    }
  }

  function setSeated(bool) {
    if (disposed) return;
    seated = Boolean(bool);
    if (!ragdolling) {
      applyPose();
    }
  }

  function setSteerAngle(rad) {
    if (disposed) return;
    currentSteer = Number.isFinite(rad) ? clamp(rad, -0.75, 0.75) : 0;
    if (seated && !ragdolling) {
      applyPose();
    }
  }

  function startRagdoll(velVec3) {
    if (disposed) return;

    if (group.parent) {
      group.parent.updateWorldMatrix(true, false);
    }
    group.updateWorldMatrix(true, false);
    group.getWorldPosition(_tmpPos);
    group.getWorldQuaternion(_tmpQuat);

    const targetScene = defaultScene || findAncestorScene(group);
    if (group.parent && group.parent !== targetScene) {
      group.parent.remove(group);
    }
    if (targetScene && typeof targetScene.add === 'function' && group.parent !== targetScene) {
      targetScene.add(group);
    }

    // Preserve world position & orientation, and reset scale to (1,1,1) so
    // ejecting from a pancake-crushed vehicle never leaves a squashed avatar!
    group.position.copy(_tmpPos);
    group.quaternion.copy(_tmpQuat);
    group.scale.set(1, 1, 1);

    pelvis.position.set(0, 0, 0);
    ragdolling = true;
    seated = false;

    // Coerce and clamp ejection velocity
    readVec3(velVec3, _tmpVec, 0, 0, 0);
    _tmpVec.set(
      clamp(_tmpVec.x, -MAX_RAGDOLL_SPEED, MAX_RAGDOLL_SPEED),
      clamp(_tmpVec.y, -MAX_RAGDOLL_SPEED, MAX_RAGDOLL_SPEED),
      clamp(_tmpVec.z, -MAX_RAGDOLL_SPEED, MAX_RAGDOLL_SPEED),
    );

    if (_tmpVec.lengthSq() < 1.0) {
      // Stationary manual EJECT: playful upward & forward ejection pop in world space
      _tmpVec.set((rng() - 0.5) * 3.0, 5.8, 2.2).applyQuaternion(_tmpQuat);
      if (_tmpVec.y < 4.8) _tmpVec.y = 5.6;
    }
    linVel.copy(_tmpVec);

    const speedFactor = clamp(linVel.length() / 10.0, 0.7, 2.2);
    angVel.set(
      (rng() > 0.5 ? 1 : -1) * (4.5 + rng() * 4.5) * speedFactor,
      (rng() - 0.5) * 8.0 * speedFactor,
      (rng() > 0.5 ? 1 : -1) * (4.0 + rng() * 4.5) * speedFactor,
    );

    // Pop JJ's ears out from folded seated pose and seed wild limb flailing
    if (earLBase && earLTip && earRBase && earRTip) {
      earLBase.rotation.set(-0.28, 0, -0.26);
      earRBase.rotation.set(-0.28, 0, 0.26);
      earLTip.rotation.set(-0.35, 0, -0.10);
      earRTip.rotation.set(-0.35, 0, 0.10);
    }

    for (let i = 0; i < limbSprings.length; i += 1) {
      const sp = limbSprings[i];
      sp.ang = clamp(sp.obj.rotation[sp.axis], sp.min, sp.max);
      sp.vel = (rng() - 0.5) * 14.0 * speedFactor;
    }
  }

  function updateRagdoll(dt, groundYFn) {
    if (disposed) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const stepDt = Math.min(dt, 0.05);

    if (!ragdolling) {
      // Subtle living ear sway for JJ while seated/standing
      if (earLBase && earRBase) {
        idlePhase += stepDt * 3.2;
        const sway = Math.sin(idlePhase) * 0.035;
        if (seated) {
          earLBase.rotation.z = -0.24 - currentSteer * 0.18 - sway;
          earRBase.rotation.z = 0.24 - currentSteer * 0.18 + sway;
        } else {
          earLBase.rotation.z = -0.24 - sway;
          earRBase.rotation.z = 0.24 + sway;
        }
      }
      return;
    }

    // Gravity + mild air drag
    linVel.y -= RAGDOLL_GRAVITY * stepDt;
    const airDrag = Math.exp(-0.25 * stepDt);
    linVel.multiplyScalar(airDrag);

    group.position.addScaledVector(linVel, stepDt);

    // Singularity-free quaternion angular integration
    const angSpeed = angVel.length();
    if (angSpeed > 1e-4) {
      _tmpAxis.copy(angVel).multiplyScalar(1 / angSpeed);
      const dAngle = Math.min(angSpeed * stepDt, 1.2);
      _tmpDeltaQ.setFromAxisAngle(_tmpAxis, dAngle);
      group.quaternion.premultiply(_tmpDeltaQ).normalize();
    }

    // Ground bounce & friction
    let groundY = 0;
    if (typeof groundYFn === 'function') {
      const rawG = groundYFn(group.position.x, group.position.z);
      if (Number.isFinite(rawG)) groundY = rawG;
    }

    const minY = groundY + RAGDOLL_RADIUS;
    if (group.position.y < minY) {
      group.position.y = minY;
      if (linVel.y < -1.2) {
        const impact = Math.abs(linVel.y);
        linVel.y = impact * RAGDOLL_BOUNCE;
        // Impart ground-roll torque and kick limbs on bounce
        angVel.x += (linVel.z * 0.35) + (rng() - 0.5) * impact * 0.45;
        angVel.z += (-linVel.x * 0.35) + (rng() - 0.5) * impact * 0.45;
        for (let i = 0; i < limbSprings.length; i += 1) {
          limbSprings[i].vel += (rng() - 0.5) * Math.min(impact * 1.4, 14.0);
        }
      } else {
        linVel.y = 0;
      }

      const groundLinFric = Math.exp(-5.5 * stepDt);
      const groundAngFric = Math.exp(-5.0 * stepDt);
      linVel.x *= groundLinFric;
      linVel.z *= groundLinFric;
      angVel.multiplyScalar(groundAngFric);

      if (linVel.lengthSq() < 0.015 && angVel.lengthSq() < 0.02) {
        linVel.set(0, 0, 0);
        angVel.set(0, 0, 0);
      }
    }

    // Damped spring-pendulum limb tumble
    const spinEnergy = clamp(angVel.length(), 0, 14);
    for (let i = 0; i < limbSprings.length; i += 1) {
      const sp = limbSprings[i];
      const coupleTorque = sp.couple * spinEnergy * 0.65;
      const acc = -sp.k * (sp.ang - sp.rest) - sp.damp * sp.vel + coupleTorque;
      sp.vel += acc * stepDt;
      sp.ang += sp.vel * stepDt;
      if (sp.ang < sp.min) {
        sp.ang = sp.min;
        if (sp.vel < 0) sp.vel *= -0.3;
      } else if (sp.ang > sp.max) {
        sp.ang = sp.max;
        if (sp.vel > 0) sp.vel *= -0.3;
      }
      sp.obj.rotation[sp.axis] = sp.ang;
    }

    // Final NaN guard
    if (
      !Number.isFinite(group.position.x)
      || !Number.isFinite(group.position.y)
      || !Number.isFinite(group.position.z)
    ) {
      group.position.set(0, minY, 0);
      linVel.set(0, 0, 0);
    }
    if (
      !Number.isFinite(group.quaternion.x)
      || !Number.isFinite(group.quaternion.y)
      || !Number.isFinite(group.quaternion.z)
      || !Number.isFinite(group.quaternion.w)
    ) {
      group.quaternion.identity();
      angVel.set(0, 0, 0);
    }
  }

  function resetToSeat(parentGroup, localPos) {
    if (disposed) return;
    ragdolling = false;
    linVel.set(0, 0, 0);
    angVel.set(0, 0, 0);
    for (let i = 0; i < limbSprings.length; i += 1) {
      limbSprings[i].vel = 0;
    }

    if (parentGroup && typeof parentGroup.add === 'function') {
      if (group.parent && group.parent !== parentGroup) {
        group.parent.remove(group);
      }
      if (group.parent !== parentGroup) {
        parentGroup.add(group);
      }
    }

    readVec3(localPos, _tmpPos, 0, 0, 0);
    group.position.copy(_tmpPos);
    group.quaternion.identity();
    group.rotation.set(0, 0, 0);
    group.scale.set(1, 1, 1);

    seated = true;
    currentSteer = 0;
    applyPose();
    group.updateMatrixWorld(true);
  }

  function isRagdolling() {
    return ragdolling;
  }

  function getWorldPosition(target) {
    const out = target && typeof target.set === 'function' ? target : new THREE.Vector3();
    if (group.parent) {
      group.parent.updateWorldMatrix(true, false);
    }
    group.updateWorldMatrix(true, false);
    return group.getWorldPosition(out);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    ragdolling = false;
    if (group.parent) {
      group.parent.remove(group);
    }
    for (let i = 0; i < ownedGeoms.length; i += 1) {
      ownedGeoms[i].dispose();
    }
    for (let i = 0; i < ownedMats.length; i += 1) {
      ownedMats[i].dispose();
    }
    for (let i = 0; i < ownedTextures.length; i += 1) {
      ownedTextures[i].dispose();
    }
    ownedGeoms.length = 0;
    ownedMats.length = 0;
    ownedTextures.length = 0;
  }

  // Initialize standing pose by default (shoes cleanly on y = 0)
  applyPose();

  return {
    group,
    setSeated,
    setSteerAngle,
    startRagdoll,
    updateRagdoll,
    resetToSeat,
    isRagdolling,
    getWorldPosition,
    dispose,
  };
}
