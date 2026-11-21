/**
 * All 8 Mechanical Destruction Machines (Act I Crushers + Railroad Trains + Act II RGB Shredders):
 *   1. hydraulic_press   — Alternating Top/Side Hydraulic Press Bay
 *   2. wrecking_balls    — Twin Swinging Steel Wrecking Balls (110° counter-phase + dual-ball pacing)
 *   3. spinning_hammers  — 4 Staggered Cross-Bar (+) Spinning Orange Hammers
 *   4. nail_hammer       — Swinging Giant Black Nail-Hammer (STRIKE ZONE)
 *   5. giant_hammer      — 22m Wooden Truss Tower & Chained Barrel Drop Weight (DROP ZONE)
 *   6. spike_drop        — Crane Hopper + 14 Bouncing Instanced Spiked Naval Mines
 *   7. train_crossing    — Dual-Track Crossing, Double-Arch Hill Tunnels & Blue/Yellow 3-Car Trains
 *   8. shredder_tunnels  — Red, Green (centerline 1.0m gap), & Orange (sloped chute + overhead drum)
 *
 * Self-contained M2B WorldSection (zero imports from avatars.js / vehicle_mesh.js / particles.js).
 * Strictly enforces non-IBL metalness <= 0.20 via createStandardMaterial(), clones shared
 * textures before modifying UV repeats/rotations, and uses InstancedMesh for repetitive props.
 */

import * as THREE from '../../vendor/three.module.min.js';
import { createStandardMaterial } from '../core/materials.js';
import { getZoneById } from '../data/zones.js';

const ORANGE_SLOPE = 0.24; // 2.40m rise over 10.0m run
const ORANGE_INV_LEN = 1 / Math.hypot(ORANGE_SLOPE, 1.0);
const ORANGE_NY = ORANGE_INV_LEN;
const ORANGE_NZ = ORANGE_SLOPE * ORANGE_INV_LEN;

export const ORANGE_SHREDDER_SURFACE_REGION = {
  id: 'shredder_orange_chute',
  priority: 15,
  minX: 187.2,
  maxX: 196.8,
  minZ: -124.0,
  maxZ: -98.0,
  sample(x, z) {
    if (x < 187.2 || x > 196.8 || z < -124.0 || z > -98.0) return null;
    if (z >= -108.0) {
      return { y: (2.40 * (-98.0 - z)) / 10.0, gx: 0, gz: -ORANGE_SLOPE };
    }
    if (z >= -114.0) {
      return { y: 2.40, gx: 0, gz: 0 };
    }
    return { y: (2.40 * (z + 124.0)) / 10.0, gx: 0, gz: ORANGE_SLOPE };
  },
};

export function getOrangeChuteHeight(x, z) {
  const s = ORANGE_SHREDDER_SURFACE_REGION.sample(x, z);
  return s ? s.y : null;
}

export function getOrangeChuteNormal(x, z) {
  const s = ORANGE_SHREDDER_SURFACE_REGION.sample(x, z);
  if (!s) return null;
  if (s.gz === 0) return [0, 1, 0];
  return [0, ORANGE_NY, -Math.sign(s.gz) * ORANGE_NZ];
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function distPointToSegment2D(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-8) {
    return { dist: Math.hypot(px - ax, pz - az), t: 0.5 };
  }
  const t = clamp(((px - ax) * abx + (pz - az) * abz) / lenSq, 0, 1);
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return { dist: Math.hypot(px - cx, pz - cz), t };
}

function makeImpact({
  kind,
  damage = 0,
  impulse = [0, 0, 0],
  crushY = 0,
  frontCrumple = 0,
  cashBonus = 0,
  xpBonus = 0,
  label = '',
  sound = 'crash',
  ignite = false,
  explode = false,
  ejectRagdoll = false,
}) {
  return {
    kind,
    damage: Number.isFinite(damage) ? Math.max(0, damage) : 0,
    impulse: [
      Number.isFinite(impulse[0]) ? impulse[0] : 0,
      Number.isFinite(impulse[1]) ? impulse[1] : 0,
      Number.isFinite(impulse[2]) ? impulse[2] : 0,
    ],
    crushY: clamp(Number.isFinite(crushY) ? crushY : 0, 0, 1),
    frontCrumple: clamp(Number.isFinite(frontCrumple) ? frontCrumple : 0, 0, 1),
    cashBonus: Number.isFinite(cashBonus) ? Math.max(0, cashBonus) : 0,
    xpBonus: Number.isFinite(xpBonus) ? Math.max(0, xpBonus) : 0,
    label: String(label || ''),
    sound: String(sound || 'crash'),
    ignite: Boolean(ignite),
    explode: Boolean(explode),
    ejectRagdoll: Boolean(ejectRagdoll),
  };
}

// Reusable 3-circle longitudinal vehicle body extractor (zero per-frame GC allocations)
const BODY_SCRATCH = {
  valid: false,
  id: 'player',
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  speed: 0,
  w: 2.05,
  h: 1.50,
  l: 4.55,
  halfW: 1.025,
  halfL: 2.275,
  circleR: 1.0455,
  circles: [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ],
};

function extractVehicleBody(raw) {
  if (!raw || typeof raw !== 'object' || raw.valid === false) {
    BODY_SCRATCH.valid = false;
    return BODY_SCRATCH;
  }
  let x;
  let y;
  let z;
  if (raw.valid === true && typeof raw.x === 'number' && typeof raw.z === 'number') {
    x = raw.x;
    y = raw.y;
    z = raw.z;
  } else {
    const pos = raw.position || raw.pos;
    x = Array.isArray(pos) ? pos[0] : pos?.x;
    y = Array.isArray(pos) ? pos[1] : pos?.y;
    z = Array.isArray(pos) ? pos[2] : pos?.z;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    BODY_SCRATCH.valid = false;
    return BODY_SCRATCH;
  }
  let vx = 0;
  let vy = 0;
  let vz = 0;
  if (raw.valid === true && typeof raw.vx === 'number') {
    vx = raw.vx;
    vy = raw.vy;
    vz = raw.vz;
  } else {
    const vel = raw.velocity || raw.vel;
    const rvx = Array.isArray(vel) ? vel[0] : vel?.x;
    const rvy = Array.isArray(vel) ? vel[1] : vel?.y;
    const rvz = Array.isArray(vel) ? vel[2] : vel?.z;
    vx = Number.isFinite(rvx) ? rvx : 0;
    vy = Number.isFinite(rvy) ? rvy : 0;
    vz = Number.isFinite(rvz) ? rvz : 0;
  }
  const yaw = Number.isFinite(raw.yaw) ? raw.yaw : 0;
  const speed = Number.isFinite(raw.speed) ? raw.speed : Math.hypot(vx, vy, vz);
  const w = Number.isFinite(raw.dimensions?.w) ? raw.dimensions.w : 2.05;
  const h = Number.isFinite(raw.dimensions?.h) ? raw.dimensions.h : 1.50;
  const l = Number.isFinite(raw.dimensions?.l) ? raw.dimensions.l : 4.55;
  const halfW = w * 0.5;
  const halfL = l * 0.5;
  const fwdX = Math.sin(yaw);
  const fwdZ = Math.cos(yaw);
  const off = 0.65 * halfL;

  BODY_SCRATCH.valid = true;
  BODY_SCRATCH.id = String(raw.id || raw.vehicleId || 'player');
  BODY_SCRATCH.x = x;
  BODY_SCRATCH.y = y;
  BODY_SCRATCH.z = z;
  BODY_SCRATCH.vx = vx;
  BODY_SCRATCH.vy = vy;
  BODY_SCRATCH.vz = vz;
  BODY_SCRATCH.yaw = yaw;
  BODY_SCRATCH.speed = speed;
  BODY_SCRATCH.w = w;
  BODY_SCRATCH.h = h;
  BODY_SCRATCH.l = l;
  BODY_SCRATCH.halfW = halfW;
  BODY_SCRATCH.halfL = halfL;
  BODY_SCRATCH.circleR = halfW * 1.02;

  BODY_SCRATCH.circles[0].x = x + fwdX * off;
  BODY_SCRATCH.circles[0].z = z + fwdZ * off;
  BODY_SCRATCH.circles[1].x = x;
  BODY_SCRATCH.circles[1].z = z;
  BODY_SCRATCH.circles[2].x = x - fwdX * off;
  BODY_SCRATCH.circles[2].z = z - fwdZ * off;

  return BODY_SCRATCH;
}

function hullOverlapsCircle2D(body, cx, cz, r) {
  const thresh = r + body.circleR;
  const threshSq = thresh * thresh;
  let bestDistSq = Infinity;
  let bestDx = 0;
  let bestDz = 0;
  for (let i = 0; i < 3; i += 1) {
    const dx = body.circles[i].x - cx;
    const dz = body.circles[i].z - cz;
    const dSq = dx * dx + dz * dz;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestDx = dx;
      bestDz = dz;
    }
  }
  if (bestDistSq <= threshSq) {
    return { hit: true, dist: Math.sqrt(bestDistSq), dx: bestDx, dz: bestDz };
  }
  return { hit: false, dist: Math.sqrt(bestDistSq), dx: bestDx, dz: bestDz };
}

function hullOverlapsAABB2D(body, minX, maxX, minZ, maxZ) {
  const r = body.circleR;
  const rSq = r * r;
  for (let i = 0; i < 3; i += 1) {
    const cx = body.circles[i].x;
    const cz = body.circles[i].z;
    const nearX = clamp(cx, minX, maxX);
    const nearZ = clamp(cz, minZ, maxZ);
    const dx = cx - nearX;
    const dz = cz - nearZ;
    if (dx * dx + dz * dz <= rSq) {
      return true;
    }
  }
  return false;
}

function buildOrangeChuteGeometry() {
  // Exact match to ORANGE_SHREDDER_SURFACE_REGION:
  // x in [187.4, 196.6] (w=9.2), z in [-124, -98], peak y=2.40 on z in [-114, -108]
  const zCoords = [-124.0, -114.0, -108.0, -98.0];
  const yCoords = [0.0, 2.40, 2.40, 0.0];
  const halfW = 4.6;
  const positions = [];
  const uvs = [];
  const indices = [];

  // Top surface (front-facing UP: +Z x +X = +Y)
  for (let i = 0; i < zCoords.length; i += 1) {
    const z = zCoords[i];
    const y = yCoords[i];
    const v = (z + 124.0) / 8.0;
    positions.push(-halfW, y, z, halfW, y, z);
    uvs.push(0, v, 1, v);
  }
  for (let i = 0; i < zCoords.length - 1; i += 1) {
    const b = i * 2;
    indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds all 8 mechanical crusher, train, mine, and shredder zones.
 *
 * @param {THREE.Scene} scene
 * @param {ReturnType<import('./textures.js').createTextureLibrary>} textures
 */
export function createCrushers(scene, textures) {
  const group = new THREE.Group();
  group.name = 'crushers_root';

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
  const trackInst = (m) => {
    ownedInstanced.add(m);
    return m;
  };
  const cloneTex = (baseTex, rx = 1, ry = 1, rot = 0) => {
    const t = baseTex.clone();
    t.repeat.set(rx, ry);
    if (rot !== 0) {
      t.center.set(0.5, 0.5);
      t.rotation = rot;
    }
    t.needsUpdate = true;
    ownedTextures.add(t);
    return t;
  };

  // Shared material pool (ALL strictly metalness <= 0.20 via createStandardMaterial!)
  const yellowSteelMat = trackMat(createStandardMaterial({ color: 0xfbc02d, metalness: 0.16, roughness: 0.42 }, scene));
  const blueSteelMat = trackMat(createStandardMaterial({ color: 0x2c5282, metalness: 0.18, roughness: 0.44 }, scene));
  const darkSteelMat = trackMat(createStandardMaterial({ color: 0x334155, metalness: 0.18, roughness: 0.42 }, scene));
  const blackIronMat = trackMat(createStandardMaterial({ color: 0x1f2937, metalness: 0.20, roughness: 0.35 }, scene));
  const silverSteelMat = trackMat(createStandardMaterial({ color: 0xcbd5e1, metalness: 0.20, roughness: 0.30 }, scene));
  const orangeArmMat = trackMat(createStandardMaterial({ color: 0xff5722, metalness: 0.14, roughness: 0.40 }, scene));
  const redMat = trackMat(createStandardMaterial({ color: 0xdc2626, metalness: 0.14, roughness: 0.44 }, scene));
  const greenMat = trackMat(createStandardMaterial({ color: 0x2e7d32, metalness: 0.14, roughness: 0.44 }, scene));
  const orangeBayMat = trackMat(createStandardMaterial({ color: 0xe65100, metalness: 0.14, roughness: 0.44 }, scene));
  const whiteMat = trackMat(createStandardMaterial({ color: 0xf4f6f8, metalness: 0.08, roughness: 0.50 }, scene));
  const gravelMat = trackMat(createStandardMaterial({ color: 0x64748b, metalness: 0.04, roughness: 0.92 }, scene));
  const tunnelDarkMat = trackMat(createStandardMaterial({ color: 0x0b1120, metalness: 0.02, roughness: 0.95 }, scene));
  const beaconOffMat = trackMat(createStandardMaterial({ color: 0x7f1d1d, metalness: 0.10, roughness: 0.45 }, scene));
  const beaconOnMat = trackMat(createStandardMaterial({
    color: 0xff1744,
    emissive: 0xff1744,
    emissiveIntensity: 0.85,
    metalness: 0.10,
    roughness: 0.30,
  }, scene));
  const headlightMat = trackMat(createStandardMaterial({
    color: 0xfef08a,
    emissive: 0xfde047,
    emissiveIntensity: 0.90,
    metalness: 0.08,
    roughness: 0.25,
  }, scene));
  const trainBlueMat = trackMat(createStandardMaterial({ color: 0x1565c0, metalness: 0.18, roughness: 0.38 }, scene));
  const trainYellowMat = trackMat(createStandardMaterial({ color: 0xfacc15, metalness: 0.16, roughness: 0.40 }, scene));
  const cabGlassMat = trackMat(createStandardMaterial({ color: 0x93c5fd, metalness: 0.14, roughness: 0.22 }, scene));

  const woodMat = trackMat(createStandardMaterial({ map: cloneTex(textures.woodTruss, 1, 5), metalness: 0.04, roughness: 0.78 }, scene));
  const woodTieMat = trackMat(createStandardMaterial({ map: cloneTex(textures.woodTruss, 1, 1), metalness: 0.04, roughness: 0.82 }, scene));
  const hillGrassMat = trackMat(createStandardMaterial({ map: cloneTex(textures.grassGrid, 3, 2), metalness: 0.02, roughness: 0.88 }, scene));
  const concrete3x3Mat = trackMat(createStandardMaterial({ map: cloneTex(textures.concretePad, 3, 3), metalness: 0.04, roughness: 0.84 }, scene));
  const hazard4x1Mat = trackMat(createStandardMaterial({ map: cloneTex(textures.hazardStripes, 4, 1), metalness: 0.08, roughness: 0.56 }, scene));
  const hazard6x1Mat = trackMat(createStandardMaterial({ map: cloneTex(textures.hazardStripes, 6, 1), metalness: 0.08, roughness: 0.56 }, scene));

  const makeSignPanel = (title, subtitle, bg, fg, w, h) => {
    const tex = textures.makeSignTexture(title, subtitle, bg, fg);
    const mat = trackMat(createStandardMaterial({
      map: tex,
      emissive: 0x222222,
      emissiveMap: tex,
      emissiveIntensity: 0.28,
      roughness: 0.65,
      metalness: 0.02,
    }, scene));
    return new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(w, h)), mat);
  };

  const buildControlPedestal = (parent, x, z, buttonMat = redMat) => {
    const p = new THREE.Group();
    p.position.set(x, 0, z);
    const post = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.9, 1.5, 0.9)), yellowSteelMat);
    post.position.y = 0.75;
    p.add(post);
    const top = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.1, 0.2, 1.1)), darkSteelMat);
    top.position.y = 1.55;
    p.add(top);
    const btn = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.32, 0.36, 0.24, 12)), buttonMat);
    btn.position.y = 1.72;
    p.add(btn);
    parent.add(p);
  };

  // =========================================================================
  // MACHINE 1: HYDRAULIC PRESS BAY (78, 0, -68)
  // =========================================================================
  const pressGroup = new THREE.Group();
  pressGroup.name = 'machine_hydraulic_press';
  group.add(pressGroup);

  const pressConcrete = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(18, 0.05, 28)),
    trackMat(createStandardMaterial({ map: cloneTex(textures.concretePad, 3, 5), metalness: 0.04, roughness: 0.84 }, scene)),
  );
  pressConcrete.position.set(78, 0.0, -68);
  pressConcrete.receiveShadow = true;
  pressGroup.add(pressConcrete);

  const pressBayFloor = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(10.0, 0.04, 12.0)), darkSteelMat);
  pressBayFloor.position.set(78, 0.025, -68);
  pressBayFloor.receiveShadow = true;
  pressGroup.add(pressBayFloor);

  // Hazard border framing the steel bay floor (top y = 0.052)
  const borderNSGeo = trackGeo(new THREE.BoxGeometry(12.0, 0.024, 1.0));
  const borderEWGeo = trackGeo(new THREE.BoxGeometry(1.0, 0.024, 12.0));
  for (const bz of [-61.5, -74.5]) {
    const b = new THREE.Mesh(borderNSGeo, hazard4x1Mat);
    b.position.set(78, 0.040, bz);
    pressGroup.add(b);
  }
  for (const bx of [72.5, 83.5]) {
    const b = new THREE.Mesh(borderEWGeo, hazard4x1Mat);
    b.position.set(bx, 0.040, -68);
    pressGroup.add(b);
  }

  // 4 Yellow gantry pillars (clear width 10.2m: X in [72.9, 83.1])
  const pressPillars = [
    [72.2, -62.8],
    [83.8, -62.8],
    [72.2, -73.2],
    [83.8, -73.2],
  ];
  const pressPillarGeo = trackGeo(new THREE.BoxGeometry(1.4, 11.5, 1.4));
  for (let i = 0; i < pressPillars.length; i += 1) {
    const [px, pz] = pressPillars[i];
    const col = new THREE.Mesh(pressPillarGeo, yellowSteelMat);
    col.position.set(px, 5.75, pz);
    col.castShadow = true;
    pressGroup.add(col);
  }

  // Blue steel crown beam + lower hazard trim
  const pressCrown = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(14.0, 2.2, 13.0)), blueSteelMat);
  pressCrown.position.set(78, 11.8, -68);
  pressCrown.castShadow = true;
  pressGroup.add(pressCrown);

  const crownTrim = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(14.2, 0.36, 13.2)), hazard4x1Mat);
  crownTrim.position.set(78, 10.65, -68);
  pressGroup.add(crownTrim);

  // Twin vertical hydraulic cylinder housings & dynamically stretching rams
  const cylHousingGeo = trackGeo(new THREE.CylinderGeometry(0.65, 0.65, 4.2, 14));
  const ramGeo = trackGeo(new THREE.CylinderGeometry(0.42, 0.42, 1.0, 12));
  const pressRams = [];
  for (const rx of [75.2, 80.8]) {
    const housing = new THREE.Mesh(cylHousingGeo, blueSteelMat);
    housing.position.set(rx, 8.9, -68);
    pressGroup.add(housing);
    const ram = new THREE.Mesh(ramGeo, silverSteelMat);
    ram.position.set(rx, 8.5, -68);
    pressGroup.add(ram);
    pressRams.push(ram);
  }

  // Descending Top Press Plate (8.4 x 1.6 x 10.6; bottom face open = 6.20, closed = 0.55)
  const topPlateGroup = new THREE.Group();
  topPlateGroup.name = 'hydraulic_press_top_plate';
  topPlateGroup.position.set(78, 7.0, -68);
  pressGroup.add(topPlateGroup);

  const plateUpper = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(8.4, 1.05, 10.6)), darkSteelMat);
  plateUpper.position.y = 0.275;
  plateUpper.castShadow = true;
  topPlateGroup.add(plateUpper);

  const plateSkirt = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(8.42, 0.55, 10.62)), hazard4x1Mat);
  plateSkirt.position.y = -0.525;
  topPlateGroup.add(plateSkirt);

  // Alternating Side Crusher Jaws (open inner face at lx = +-4.5, closed at +-0.85)
  const jawGeo = trackGeo(new THREE.BoxGeometry(0.8, 2.8, 9.6));
  const sideJawL = new THREE.Mesh(jawGeo, hazard4x1Mat);
  sideJawL.position.set(78 - 4.9, 1.55, -68);
  pressGroup.add(sideJawL);
  const sideJawR = new THREE.Mesh(jawGeo, hazard4x1Mat);
  sideJawR.position.set(78 + 4.9, 1.55, -68);
  pressGroup.add(sideJawR);

  const sideRamGeo = trackGeo(new THREE.CylinderGeometry(0.30, 0.30, 1.0, 10));
  sideRamGeo.rotateZ(Math.PI / 2);
  const sideRamL = new THREE.Mesh(sideRamGeo, silverSteelMat);
  sideRamL.position.set(73.0, 1.55, -68);
  pressGroup.add(sideRamL);
  const sideRamR = new THREE.Mesh(sideRamGeo, silverSteelMat);
  sideRamR.position.set(83.0, 1.55, -68);
  pressGroup.add(sideRamR);

  // Signage & Flashing Beacons
  const pressSignS = makeSignPanel('HYDRAULIC PRESS', 'CRUSHING FROM ABOVE', '#1e3a8a', '#ffffff', 11.5, 3.2);
  pressSignS.position.set(78, 11.8, -61.35);
  pressGroup.add(pressSignS);
  const pressSignN = makeSignPanel('HYDRAULIC PRESS', 'CRUSHING FROM ABOVE', '#1e3a8a', '#ffffff', 11.5, 3.2);
  pressSignN.position.set(78, 11.8, -74.65);
  pressSignN.rotation.y = Math.PI;
  pressGroup.add(pressSignN);

  buildControlPedestal(pressGroup, 85.5, -61.5, redMat);
  const beaconGeo = trackGeo(new THREE.SphereGeometry(0.42, 10, 8));
  const pressBeaconL = new THREE.Mesh(beaconGeo, beaconOffMat);
  pressBeaconL.position.set(72.2, 13.0, -62.8);
  pressGroup.add(pressBeaconL);
  const pressBeaconR = new THREE.Mesh(beaconGeo, beaconOffMat);
  pressBeaconR.position.set(83.8, 13.0, -62.8);
  pressGroup.add(pressBeaconR);

  const pressState = {
    phase: 'IDLE', // IDLE | WARNING | CLOSING | HOLD | OPENING | COOLDOWN
    timer: 0,
    cycleCount: 0,
    mode: 'top', // odd cycles = 'top', even cycles = 'side'
    plateBottomY: 6.20,
    jawInnerOffset: 4.50,
    hitsThisCycle: 0,
    hitCooldown: 0,
  };

  const syncPressVisuals = (elapsed) => {
    const topCenterY = pressState.plateBottomY + 0.8;
    topPlateGroup.position.y = topCenterY;
    const plateTopY = pressState.plateBottomY + 1.6;
    const ramLen = Math.max(0.2, 10.7 - plateTopY);
    for (let i = 0; i < pressRams.length; i += 1) {
      pressRams[i].scale.y = ramLen;
      pressRams[i].position.y = plateTopY + ramLen * 0.5;
    }

    sideJawL.position.x = 78 - (pressState.jawInnerOffset + 0.4);
    sideJawR.position.x = 78 + (pressState.jawInnerOffset + 0.4);
    const outerAnchor = 6.2;
    const sideLen = Math.max(0.2, outerAnchor - (pressState.jawInnerOffset + 0.8));
    sideRamL.scale.x = sideLen;
    sideRamL.position.x = 78 - (pressState.jawInnerOffset + 0.8 + sideLen * 0.5);
    sideRamR.scale.x = sideLen;
    sideRamR.position.x = 78 + (pressState.jawInnerOffset + 0.8 + sideLen * 0.5);

    const flash = (pressState.phase === 'WARNING' || pressState.phase === 'CLOSING' || pressState.phase === 'HOLD')
      && Math.sin(elapsed * 20) > 0;
    pressBeaconL.material = flash ? beaconOnMat : beaconOffMat;
    pressBeaconR.material = flash ? beaconOnMat : beaconOffMat;
  };

  const startPressClosing = () => {
    pressState.cycleCount += 1;
    pressState.mode = pressState.cycleCount % 2 === 1 ? 'top' : 'side';
    pressState.phase = 'CLOSING';
    pressState.timer = 0;
    pressState.hitsThisCycle = 0;
    pressState.hitCooldown = 0;
  };

  // =========================================================================
  // MACHINE 2: SWINGING WRECKING BALLS GANTRY (104, 0, 8)
  // =========================================================================
  const wbGroup = new THREE.Group();
  wbGroup.name = 'machine_wrecking_balls';
  group.add(wbGroup);

  const wbRoadTex = cloneTex(textures.asphaltRoad, 1, 3.5, Math.PI / 2);
  const wbRoad = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(46.0, 0.04, 13.0)),
    trackMat(createStandardMaterial({ map: wbRoadTex, metalness: 0.04, roughness: 0.84 }, scene)),
  );
  wbRoad.position.set(95, 0.012, 8);
  wbRoad.receiveShadow = true;
  wbGroup.add(wbRoad);

  // Red/white road curbs along wz = 1.2 and wz = 14.8
  const wbCurbGeo = trackGeo(new THREE.BoxGeometry(3.8, 0.24, 0.45));
  for (let i = 0; i < 12; i += 1) {
    const cx = 73.9 + i * 3.83;
    const mat = i % 2 === 0 ? redMat : whiteMat;
    for (const cz of [1.2, 14.8]) {
      const c = new THREE.Mesh(wbCurbGeo, mat);
      c.position.set(cx, 0.12, cz);
      wbGroup.add(c);
    }
  }

  // Tall yellow steel overhead arch gantry spanning North-South across road
  const wbColGeo = trackGeo(new THREE.BoxGeometry(1.2, 16.0, 1.2));
  const wbColumns = [
    [100.4, -0.6], [107.6, -0.6],
    [100.4, 16.6], [107.6, 16.6],
  ];
  for (let i = 0; i < wbColumns.length; i += 1) {
    const [cx, cz] = wbColumns[i];
    const col = new THREE.Mesh(wbColGeo, yellowSteelMat);
    col.position.set(cx, 8.0, cz);
    col.castShadow = true;
    wbGroup.add(col);
  }
  const wbBridge = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(9.2, 1.8, 19.6)), yellowSteelMat);
  wbBridge.position.set(104, 14.9, 8);
  wbBridge.castShadow = true;
  wbGroup.add(wbBridge);

  const wbSignW = makeSignPanel('WRECKING BALLS', 'WATCH OUT!', '#d97706', '#ffffff', 11.0, 2.8);
  wbSignW.position.set(99.35, 15.0, 8);
  wbSignW.rotation.y = -Math.PI / 2;
  wbGroup.add(wbSignW);
  const wbSignE = makeSignPanel('WRECKING BALLS', 'WATCH OUT!', '#d97706', '#ffffff', 11.0, 2.8);
  wbSignE.position.set(108.65, 15.0, 8);
  wbSignE.rotation.y = Math.PI / 2;
  wbGroup.add(wbSignE);

  // Twin massive swinging black steel wrecking balls (L = 11.8m, R = 1.95m)
  const WB_L = 11.8;
  const WB_R = 1.95;
  const WB_OMEGA = 2.7;
  const WB_AMAX = 0.48;
  const WB_PHASE_OFFSET = 1.92; // ~110 deg counter-phase

  const wbCableGeo = trackGeo(new THREE.CylinderGeometry(0.14, 0.14, WB_L, 8));
  const wbSphereGeo = trackGeo(new THREE.SphereGeometry(WB_R, 16, 12));
  const wbBandGeo = trackGeo(new THREE.TorusGeometry(WB_R * 1.01, 0.12, 8, 20));
  wbBandGeo.rotateX(Math.PI / 2);

  const wbBalls = [
    { pivotX: 100.5, phaseOffset: 0, theta: 0, wx: 100.5, wy: 2.2, wz: 8.0, pivot: null },
    { pivotX: 107.5, phaseOffset: WB_PHASE_OFFSET, theta: 0, wx: 107.5, wy: 2.2, wz: 8.0, pivot: null },
  ];
  for (let i = 0; i < wbBalls.length; i += 1) {
    const b = wbBalls[i];
    const pivot = new THREE.Group();
    pivot.name = `wrecking_ball_pivot_${i}`;
    pivot.position.set(b.pivotX, 14.0, 8.0);
    const cable = new THREE.Mesh(wbCableGeo, darkSteelMat);
    cable.position.y = -WB_L * 0.5;
    pivot.add(cable);
    const sphere = new THREE.Mesh(wbSphereGeo, blackIronMat);
    sphere.position.y = -WB_L;
    sphere.castShadow = true;
    pivot.add(sphere);
    const band = new THREE.Mesh(wbBandGeo, yellowSteelMat);
    band.position.y = -WB_L;
    pivot.add(band);
    wbGroup.add(pivot);
    b.pivot = pivot;
  }
  const wbState = { phase: 0 };

  // =========================================================================
  // MACHINE 3: SPINNING ORANGE HAMMERS (76, 0, 82)
  // =========================================================================
  const spinGroup = new THREE.Group();
  spinGroup.name = 'machine_spinning_hammers';
  group.add(spinGroup);

  const spinPad = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(28.0, 0.05, 32.0)),
    trackMat(createStandardMaterial({ map: cloneTex(textures.concretePad, 4, 5), metalness: 0.04, roughness: 0.84 }, scene)),
  );
  spinPad.position.set(76, 0.0, 82);
  spinPad.receiveShadow = true;
  spinGroup.add(spinPad);

  const spinEdgeGeo = trackGeo(new THREE.BoxGeometry(0.9, 0.03, 32.0));
  for (const sx of [62.5, 89.5]) {
    const e = new THREE.Mesh(spinEdgeGeo, hazard6x1Mat);
    e.position.set(sx, 0.04, 82);
    spinGroup.add(e);
  }

  // North Entry Sign Arch at wz = 66.2 (17.6m clear span)
  const archPostGeo = trackGeo(new THREE.BoxGeometry(1.1, 8.4, 1.1));
  for (const ax of [66.5, 85.5]) {
    const p = new THREE.Mesh(archPostGeo, yellowSteelMat);
    p.position.set(ax, 4.2, 66.2);
    spinGroup.add(p);
  }
  const spinBeam = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(20.2, 1.4, 1.1)), yellowSteelMat);
  spinBeam.position.set(76, 7.8, 66.2);
  spinGroup.add(spinBeam);
  const spinSignN = makeSignPanel('SPINNING HAMMERS', 'DANGER: ROTATING ARMS', '#c2410c', '#ffffff', 11.0, 2.8);
  spinSignN.position.set(76, 7.6, 65.6);
  spinSignN.rotation.y = Math.PI;
  spinGroup.add(spinSignN);
  const spinSignS = makeSignPanel('SPINNING HAMMERS', 'DANGER: ROTATING ARMS', '#c2410c', '#ffffff', 11.0, 2.8);
  spinSignS.position.set(76, 7.6, 66.8);
  spinGroup.add(spinSignS);

  // 4 Staggered Cross-Hammer (+) Rotating Posts (100% hit rate, zero inter-arm clipping)
  const spinSpecs = [
    { x: 71.4, z: 72.1, armY: 0.95, omega: 2.8, angle: 0.0 },
    { x: 80.6, z: 78.7, armY: 1.55, omega: -2.8, angle: 0.30 * Math.PI },
    { x: 71.4, z: 85.3, armY: 0.95, omega: 3.1, angle: 0.65 * Math.PI },
    { x: 80.6, z: 91.9, armY: 1.55, omega: -3.1, angle: 0.95 * Math.PI },
  ];
  const SPIN_ARM_R = 6.20;
  const pedGeo = trackGeo(new THREE.CylinderGeometry(0.90, 1.0, 2.4, 12));
  const hubGeo = trackGeo(new THREE.CylinderGeometry(1.12, 1.12, 0.62, 12));
  const barXGeo = trackGeo(new THREE.BoxGeometry(SPIN_ARM_R * 2, 0.42, 0.42));
  const barZGeo = trackGeo(new THREE.BoxGeometry(0.42, 0.42, SPIN_ARM_R * 2));
  const headGeo = trackGeo(new THREE.BoxGeometry(1.15, 0.95, 0.95));

  const spinPosts = spinSpecs.map((spec, idx) => {
    const postGroup = new THREE.Group();
    postGroup.position.set(spec.x, 0, spec.z);
    const ped = new THREE.Mesh(pedGeo, darkSteelMat);
    ped.position.y = 1.2;
    ped.castShadow = true;
    postGroup.add(ped);

    const rotor = new THREE.Group();
    rotor.name = `spinning_hammer_rotor_${idx}`;
    rotor.position.y = spec.armY;
    rotor.rotation.y = spec.angle;

    const hub = new THREE.Mesh(hubGeo, blackIronMat);
    rotor.add(hub);
    const bar1 = new THREE.Mesh(barXGeo, orangeArmMat);
    bar1.castShadow = true;
    rotor.add(bar1);
    const bar2 = new THREE.Mesh(barZGeo, orangeArmMat);
    bar2.castShadow = true;
    rotor.add(bar2);

    // 4 heavy hammer heads at cross tips
    for (const [hx, hz] of [[-SPIN_ARM_R, 0], [SPIN_ARM_R, 0], [0, -SPIN_ARM_R], [0, SPIN_ARM_R]]) {
      const head = new THREE.Mesh(headGeo, hazard4x1Mat);
      head.position.set(hx, 0, hz);
      rotor.add(head);
    }
    postGroup.add(rotor);
    spinGroup.add(postGroup);
    return { ...spec, rotor };
  });

  // =========================================================================
  // MACHINE 4: NAIL HAMMER STRIKE ZONE (-104, 0, -10)
  // =========================================================================
  const nailGroup = new THREE.Group();
  nailGroup.name = 'machine_nail_hammer';
  group.add(nailGroup);

  const nailApron = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(20, 0.05, 20)), concrete3x3Mat);
  nailApron.position.set(-104, 0.0, -10);
  nailApron.receiveShadow = true;
  nailGroup.add(nailApron);

  const nailPad = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(7.2, 7.2, 0.04, 28)), darkSteelMat);
  nailPad.position.set(-104, 0.03, -10);
  nailPad.receiveShadow = true;
  nailGroup.add(nailPad);

  const nailRing = new THREE.Mesh(trackGeo(new THREE.RingGeometry(7.0, 8.4, 32)), hazard6x1Mat);
  nailRing.rotation.x = -Math.PI / 2;
  nailRing.position.set(-104, 0.056, -10);
  nailGroup.add(nailRing);

  const nailStencil = makeSignPanel('STRIKE ZONE', 'STAND CLEAR', '#1f2937', '#facc15', 5.2, 2.6);
  nailStencil.rotation.order = 'YXZ';
  nailStencil.rotation.x = -Math.PI / 2;
  nailStencil.rotation.y = Math.PI / 2;
  nailStencil.position.set(-96.4, 0.06, -10);
  nailGroup.add(nailStencil);

  // North support tower at (-104, 0, -18.5)
  const nailPierGeo = trackGeo(new THREE.BoxGeometry(1.2, 14.4, 2.4));
  for (const nx of [-107.0, -101.0]) {
    const pier = new THREE.Mesh(nailPierGeo, yellowSteelMat);
    pier.position.set(nx, 7.2, -18.5);
    pier.castShadow = true;
    nailGroup.add(pier);
  }
  const nailCrossBeam = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(8.2, 1.4, 2.6)), yellowSteelMat);
  nailCrossBeam.position.set(-104, 14.0, -18.5);
  nailGroup.add(nailCrossBeam);

  const nailSignE = makeSignPanel('NAIL HAMMER', 'STRIKE ZONE • FREE DROP', '#ca8a04', '#ffffff', 7.6, 2.8);
  nailSignE.position.set(-100.35, 10.6, -18.5);
  nailSignE.rotation.y = Math.PI / 2;
  nailGroup.add(nailSignE);
  const nailSignS = makeSignPanel('NAIL HAMMER', 'STRIKE ZONE • FREE DROP', '#ca8a04', '#ffffff', 7.2, 2.6);
  nailSignS.position.set(-104, 13.6, -17.15);
  nailGroup.add(nailSignS);

  buildControlPedestal(nailGroup, -95.5, -3.0, redMat);

  // Swinging Giant Black Nail-Hammer pivoted at P = (-104, 2.0, -18.5)
  const NAIL_L = 8.5;
  const NAIL_READY_THETA = 1.32;
  const NAIL_STRIKE_THETA = -0.04;
  const nailPivot = new THREE.Group();
  nailPivot.name = 'nail_hammer_pivot';
  nailPivot.position.set(-104, 2.0, -18.5);
  nailPivot.rotation.x = -NAIL_READY_THETA;
  nailGroup.add(nailPivot);

  const nailAxle = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.45, 0.45, 7.6, 12)), silverSteelMat);
  nailAxle.rotation.z = Math.PI / 2;
  nailPivot.add(nailAxle);

  const nailHandle = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.75, 0.75, NAIL_L)), yellowSteelMat);
  nailHandle.position.set(0, 0, NAIL_L * 0.5);
  nailHandle.castShadow = true;
  nailPivot.add(nailHandle);

  const nailHead = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(4.6, 2.8, 3.2)), blackIronMat);
  nailHead.position.set(0, 0, NAIL_L);
  nailHead.castShadow = true;
  nailPivot.add(nailHead);

  const nailFace = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(4.3, 0.25, 2.9)), silverSteelMat);
  nailFace.position.set(0, -1.42, NAIL_L);
  nailPivot.add(nailFace);

  // Iconic dual rear claw prongs on top of hammer head
  const clawGeo = trackGeo(new THREE.BoxGeometry(0.85, 1.5, 0.9));
  for (const cx of [-1.05, 1.05]) {
    const claw = new THREE.Mesh(clawGeo, blackIronMat);
    claw.position.set(cx, 1.9, NAIL_L - 0.55);
    claw.rotation.x = -0.45;
    nailPivot.add(claw);
  }

  const nailState = {
    phase: 'READY', // READY | ARMING | SWINGING | IMPACT_HOLD | LIFTING | COOLDOWN
    timer: 0,
    theta: NAIL_READY_THETA,
    hitThisSwing: false,
  };

  // =========================================================================
  // MACHINE 5: GIANT HAMMER WOODEN DROP TOWER (-82, 0, -82)
  // =========================================================================
  const giantGroup = new THREE.Group();
  giantGroup.name = 'machine_giant_hammer';
  group.add(giantGroup);

  const giantApron = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(22, 0.05, 22)), concrete3x3Mat);
  giantApron.position.set(-82, 0.0, -82);
  giantApron.receiveShadow = true;
  giantGroup.add(giantApron);

  const giantPad = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(7.2, 7.2, 0.04, 28)), darkSteelMat);
  giantPad.position.set(-82, 0.03, -82);
  giantPad.receiveShadow = true;
  giantGroup.add(giantPad);

  const giantRing = new THREE.Mesh(trackGeo(new THREE.RingGeometry(7.0, 8.4, 32)), hazard6x1Mat);
  giantRing.rotation.x = -Math.PI / 2;
  giantRing.position.set(-82, 0.056, -82);
  giantGroup.add(giantRing);

  const giantStencil = makeSignPanel('DROP ZONE', 'STAND CLEAR', '#1f2937', '#facc15', 5.2, 2.6);
  giantStencil.rotation.x = -Math.PI / 2;
  giantStencil.position.set(-82, 0.06, -73.6);
  giantGroup.add(giantStencil);

  // 4-Legged 22m Wooden Truss Tower (12.4m clear drive-through width)
  const giantLegs = [
    [-88.8, -88.8], [-75.2, -88.8],
    [-88.8, -75.2], [-75.2, -75.2],
  ];
  const legGeo = trackGeo(new THREE.BoxGeometry(1.1, 22.0, 1.1));
  for (let i = 0; i < giantLegs.length; i += 1) {
    const [lx, lz] = giantLegs[i];
    const leg = new THREE.Mesh(legGeo, woodMat);
    leg.position.set(lx, 11.0, lz);
    leg.castShadow = true;
    giantGroup.add(leg);
  }
  const topDeck = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(14.8, 1.0, 14.8)), woodMat);
  topDeck.position.set(-82, 21.8, -82);
  topDeck.castShadow = true;
  giantGroup.add(topDeck);

  // 12 Timber horizontal & X-braces in 1 InstancedMesh (North/South strictly above y=6.2m!)
  const braceSpecs = [
    // South & North high crossbeams (y = 8.4 and y = 16.0 — clear headroom > 6.2m!)
    [-82, 8.4, -75.2, 13.6, 0.7, 0.7, 0, 0, 0],
    [-82, 16.0, -75.2, 13.6, 0.7, 0.7, 0, 0, 0],
    [-82, 8.4, -88.8, 13.6, 0.7, 0.7, 0, 0, 0],
    [-82, 16.0, -88.8, 13.6, 0.7, 0.7, 0, 0, 0],
    // West side horizontal & diagonal X braces
    [-88.8, 7.0, -82, 0.7, 0.7, 13.6, 0, 0, 0],
    [-88.8, 14.5, -82, 0.7, 0.7, 13.6, 0, 0, 0],
    [-88.8, 10.8, -82, 0.6, 0.6, 15.2, 0.48, 0, 0],
    [-88.8, 10.8, -82, 0.6, 0.6, 15.2, -0.48, 0, 0],
    // East side horizontal & diagonal X braces
    [-75.2, 7.0, -82, 0.7, 0.7, 13.6, 0, 0, 0],
    [-75.2, 14.5, -82, 0.7, 0.7, 13.6, 0, 0, 0],
    [-75.2, 10.8, -82, 0.6, 0.6, 15.2, 0.48, 0, 0],
    [-75.2, 10.8, -82, 0.6, 0.6, 15.2, -0.48, 0, 0],
  ];
  const braceInst = trackInst(new THREE.InstancedMesh(trackGeo(new THREE.BoxGeometry(1, 1, 1)), woodTieMat, braceSpecs.length));
  braceInst.name = 'giant_hammer_truss_braces';
  const dummy = new THREE.Object3D();
  for (let i = 0; i < braceSpecs.length; i += 1) {
    const [bx, by, bz, sx, sy, sz, rx, ry, rz] = braceSpecs[i];
    dummy.position.set(bx, by, bz);
    dummy.rotation.set(rx, ry, rz);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    braceInst.setMatrixAt(i, dummy.matrix);
  }
  braceInst.instanceMatrix.needsUpdate = true;
  giantGroup.add(braceInst);

  const giantSignS = makeSignPanel('GIANT HAMMER', 'DROP ZONE • STAND CLEAR', '#78350f', '#fde047', 11.0, 2.8);
  giantSignS.position.set(-82, 10.5, -74.5);
  giantGroup.add(giantSignS);
  const giantSignN = makeSignPanel('GIANT HAMMER', 'DROP ZONE • STAND CLEAR', '#78350f', '#fde047', 11.0, 2.8);
  giantSignN.position.set(-82, 10.5, -89.5);
  giantSignN.rotation.y = Math.PI;
  giantGroup.add(giantSignN);

  buildControlPedestal(giantGroup, -73.5, -72.5, redMat);

  // Chained iron-banded barrel weight
  const GIANT_REST_Y = 14.5;
  const GIANT_IMPACT_Y = 0.50;
  const barrelGroup = new THREE.Group();
  barrelGroup.name = 'giant_hammer_barrel_weight';
  barrelGroup.position.set(-82, GIANT_REST_Y + 2.1, -82);
  giantGroup.add(barrelGroup);

  const barrelBody = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(3.2, 3.2, 4.2, 18)),
    trackMat(createStandardMaterial({ map: cloneTex(textures.woodTruss, 3, 1), metalness: 0.04, roughness: 0.76 }, scene)),
  );
  barrelBody.castShadow = true;
  barrelGroup.add(barrelBody);

  const ironBandGeo = trackGeo(new THREE.CylinderGeometry(3.32, 3.32, 0.36, 18));
  for (const by of [-1.45, 0, 1.45]) {
    const band = new THREE.Mesh(ironBandGeo, blackIronMat);
    band.position.y = by;
    barrelGroup.add(band);
  }
  const capGeo = trackGeo(new THREE.CylinderGeometry(3.25, 3.25, 0.24, 18));
  for (const cy of [-2.05, 2.05]) {
    const cap = new THREE.Mesh(capGeo, blackIronMat);
    cap.position.y = cy;
    barrelGroup.add(cap);
  }

  // 4 Vertical chains stretching to pulley deck (y = 21.4)
  const chainGeo = trackGeo(new THREE.CylinderGeometry(0.14, 0.14, 1.0, 8));
  const giantChains = [];
  for (const [cx, cz] of [[-84.2, -84.2], [-79.8, -84.2], [-84.2, -79.8], [-79.8, -79.8]]) {
    const ch = new THREE.Mesh(chainGeo, darkSteelMat);
    ch.position.set(cx, 20, cz);
    giantGroup.add(ch);
    giantChains.push(ch);
  }

  const giantState = {
    phase: 'READY', // READY | ARMING | DROPPING | IMPACT_HOLD | RAISING | COOLDOWN
    timer: 0,
    bottomY: GIANT_REST_Y,
    velY: 0,
    hitThisDrop: false,
  };

  const syncGiantVisuals = () => {
    barrelGroup.position.y = giantState.bottomY + 2.1;
    const topY = giantState.bottomY + 4.2;
    const chainLen = Math.max(0.2, 21.4 - topY);
    for (let i = 0; i < giantChains.length; i += 1) {
      giantChains[i].scale.y = chainLen;
      giantChains[i].position.y = topY + chainLen * 0.5;
    }
  };
  syncGiantVisuals();

  // =========================================================================
  // MACHINE 6: SPIKE DROP ZONE — 14 INSTANCED BOUNCING NAVAL MINES (-82, 0, 74)
  // =========================================================================
  const spikeGroup = new THREE.Group();
  spikeGroup.name = 'machine_spike_drop';
  group.add(spikeGroup);

  const spikePad = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(18, 0.05, 18)), concrete3x3Mat);
  spikePad.position.set(-82, 0.0, 74);
  spikePad.receiveShadow = true;
  spikeGroup.add(spikePad);

  // Containment curbs on West, East, and outer South corners (North & 8.4m South exit curb-free!)
  const curbSideGeo = trackGeo(new THREE.BoxGeometry(0.6, 0.55, 18.0));
  for (const sx of [-90.5, -73.5]) {
    const c = new THREE.Mesh(curbSideGeo, hazard6x1Mat);
    c.position.set(sx, 0.28, 74);
    spikeGroup.add(c);
  }
  const curbCornerGeo = trackGeo(new THREE.BoxGeometry(4.6, 0.55, 0.6));
  for (const cx of [-88.2, -75.8]) {
    const c = new THREE.Mesh(curbCornerGeo, hazard4x1Mat);
    c.position.set(cx, 0.28, 82.7);
    spikeGroup.add(c);
  }

  const spikeStencil = makeSignPanel('SPIKE DROP ZONE', 'PARK HERE', '#1e293b', '#fde047', 8.0, 4.0);
  spikeStencil.rotation.order = 'YXZ';
  spikeStencil.rotation.x = -Math.PI / 2;
  spikeStencil.rotation.y = Math.PI;
  spikeStencil.position.set(-82, 0.052, 74);
  spikeGroup.add(spikeStencil);

  // Yellow crane gantry (14.1m clear span) + Overhead hopper with hinged trapdoors
  const craneLegGeo = trackGeo(new THREE.BoxGeometry(1.1, 17.5, 1.1));
  const craneLegs = [
    [-89.6, 66.4], [-74.4, 66.4],
    [-89.6, 81.6], [-74.4, 81.6],
  ];
  for (let i = 0; i < craneLegs.length; i += 1) {
    const [lx, lz] = craneLegs[i];
    const leg = new THREE.Mesh(craneLegGeo, yellowSteelMat);
    leg.position.set(lx, 8.75, lz);
    leg.castShadow = true;
    spikeGroup.add(leg);
  }

  // Hollow hopper frame (4 walls at y in [14.5, 17.7])
  const hopperWallX = trackGeo(new THREE.BoxGeometry(11.6, 3.2, 0.6));
  const hopperWallZ = trackGeo(new THREE.BoxGeometry(0.6, 3.2, 11.6));
  for (const hz of [68.4, 79.6]) {
    const w = new THREE.Mesh(hopperWallX, darkSteelMat);
    w.position.set(-82, 16.1, hz);
    spikeGroup.add(w);
  }
  for (const hx of [-87.6, -76.4]) {
    const w = new THREE.Mesh(hopperWallZ, darkSteelMat);
    w.position.set(hx, 16.1, 74);
    spikeGroup.add(w);
  }

  // Hinged trapdoors at y = 14.5
  const doorGeo = trackGeo(new THREE.BoxGeometry(5.3, 0.28, 10.6));
  const hopperDoorL = new THREE.Group();
  hopperDoorL.position.set(-87.3, 14.5, 74);
  const doorMeshL = new THREE.Mesh(doorGeo, hazard4x1Mat);
  doorMeshL.position.x = 2.65;
  hopperDoorL.add(doorMeshL);
  spikeGroup.add(hopperDoorL);

  const hopperDoorR = new THREE.Group();
  hopperDoorR.position.set(-76.7, 14.5, 74);
  const doorMeshR = new THREE.Mesh(doorGeo, hazard4x1Mat);
  doorMeshR.position.x = -2.65;
  hopperDoorR.add(doorMeshR);
  spikeGroup.add(hopperDoorR);

  const spikeSignN = makeSignPanel('SPIKE DROP ZONE', 'PARK HERE • DROP MINES', '#334155', '#facc15', 11.0, 2.8);
  spikeSignN.position.set(-82, 16.2, 66.2);
  spikeSignN.rotation.y = Math.PI;
  spikeGroup.add(spikeSignN);
  const spikeSignS = makeSignPanel('SPIKE DROP ZONE', 'PARK HERE • DROP MINES', '#334155', '#facc15', 11.0, 2.8);
  spikeSignS.position.set(-82, 16.2, 81.8);
  spikeGroup.add(spikeSignS);

  buildControlPedestal(spikeGroup, -72.8, 66.5, redMat);

  // 14 Animated Bouncing Spiked Naval Mines in 2 InstancedMeshes (2 draw calls total!)
  const MINE_COUNT = 14;
  const MINE_R = 1.05;
  const mineBodies = trackInst(new THREE.InstancedMesh(trackGeo(new THREE.SphereGeometry(MINE_R, 12, 10)), blackIronMat, MINE_COUNT));
  mineBodies.name = 'spike_drop_mine_bodies';
  mineBodies.frustumCulled = false;
  const mineSpikes = trackInst(new THREE.InstancedMesh(trackGeo(new THREE.ConeGeometry(0.24, 0.62, 5)), darkSteelMat, MINE_COUNT * 8));
  mineSpikes.name = 'spike_drop_mine_spikes';
  mineSpikes.frustumCulled = false;
  spikeGroup.add(mineBodies, mineSpikes);

  // 8 unit diagonal spike directions + local spike quaternions (precomputed once)
  const SPIKE_DIRS = [];
  const SPIKE_LOCAL_QUATS = [];
  const upAxis = new THREE.Vector3(0, 1, 0);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const v = new THREE.Vector3(sx, sy, sz).normalize();
        SPIKE_DIRS.push(v);
        const q = new THREE.Quaternion().setFromUnitVectors(upAxis, v);
        SPIKE_LOCAL_QUATS.push(q);
      }
    }
  }

  // Deterministic initial drop layout: 4 tight center mines + 10 surrounding mines
  const mineHomeSlots = [
    [0.0, 0.0, 0.00], [1.4, -0.8, 0.06], [-1.3, 1.0, 0.12], [0.5, 1.7, 0.18],
    [-3.1, -2.4, 0.14], [3.3, -2.2, 0.20], [-3.4, 2.5, 0.26], [3.2, 2.7, 0.30],
    [0.0, -3.9, 0.22], [0.2, 4.1, 0.34], [-4.5, 0.1, 0.28], [4.5, -0.2, 0.38],
    [-2.4, -4.3, 0.40], [2.6, 4.2, 0.44],
  ];

  const mines = mineHomeSlots.map(([ox, oz, delay], idx) => ({
    homeX: -82 + ox,
    homeY: 15.6 + (idx % 3) * 0.55,
    homeZ: 74 + oz,
    delay,
    x: -82 + ox,
    y: 15.6 + (idx % 3) * 0.55,
    z: 74 + oz,
    vx: 0,
    vy: 0,
    vz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    released: false,
    hitCd: 0,
    quat: new THREE.Quaternion(),
  }));

  const spikeState = {
    phase: 'LOADED', // LOADED | ARMING | DROPPING | RESETTING | COOLDOWN
    timer: 0,
    hitsThisDrop: 0,
    globalHitCd: 0,
  };

  // Scratch objects for zero-GC InstancedMesh matrix updates
  const scratchMat4 = new THREE.Matrix4();
  const scratchPos = new THREE.Vector3();
  const scratchScale = new THREE.Vector3(1, 1, 1);
  const scratchQuat = new THREE.Quaternion();
  const scratchEuler = new THREE.Euler();
  const scratchOffset = new THREE.Vector3();

  const syncMineInstances = () => {
    for (let i = 0; i < MINE_COUNT; i += 1) {
      const m = mines[i];
      scratchEuler.set(m.rx, m.ry, m.rz);
      m.quat.setFromEuler(scratchEuler);
      scratchPos.set(m.x, m.y, m.z);
      scratchMat4.compose(scratchPos, m.quat, scratchScale);
      mineBodies.setMatrixAt(i, scratchMat4);

      for (let k = 0; k < 8; k += 1) {
        scratchOffset.copy(SPIKE_DIRS[k]).multiplyScalar(MINE_R + 0.16).applyQuaternion(m.quat);
        scratchPos.set(m.x + scratchOffset.x, m.y + scratchOffset.y, m.z + scratchOffset.z);
        scratchQuat.multiplyQuaternions(m.quat, SPIKE_LOCAL_QUATS[k]);
        scratchMat4.compose(scratchPos, scratchQuat, scratchScale);
        mineSpikes.setMatrixAt(i * 8 + k, scratchMat4);
      }
    }
    mineBodies.instanceMatrix.needsUpdate = true;
    mineSpikes.instanceMatrix.needsUpdate = true;
  };
  syncMineInstances();

  const launchMines = () => {
    spikeState.phase = 'DROPPING';
    spikeState.timer = 0;
    spikeState.hitsThisDrop = 0;
    spikeState.globalHitCd = 0;
    for (let i = 0; i < MINE_COUNT; i += 1) {
      const m = mines[i];
      m.x = m.homeX;
      m.y = m.homeY;
      m.z = m.homeZ;
      m.vx = ((i % 5) - 2) * 0.9;
      m.vy = -1.5;
      m.vz = (((i * 3) % 5) - 2) * 0.9;
      m.released = false;
      m.hitCd = 0;
    }
  };

  // =========================================================================
  // MACHINE 7: RAILROAD CROSSING, DOUBLE-ARCH HILL TUNNELS & 2 TRAINS (0,0,-150)
  // =========================================================================
  const trainGroup = new THREE.Group();
  trainGroup.name = 'machine_train_crossing';
  group.add(trainGroup);

  // North-South crossing asphalt road (z in [-170, -114], y = 0.024)
  const crossRoad = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(14.0, 0.04, 56.0)),
    trackMat(createStandardMaterial({ map: cloneTex(textures.asphaltRoad, 1, 4), metalness: 0.04, roughness: 0.84 }, scene)),
  );
  crossRoad.position.set(0, 0.004, -142); // top y = 0.024
  crossRoad.receiveShadow = true;
  trainGroup.add(crossRoad);

  // Gravel ballast bed (|x| <= 124)
  const ballast = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(248.0, 0.03, 14.0)), gravelMat);
  ballast.position.set(0, 0.00, -150);
  ballast.receiveShadow = true;
  trainGroup.add(ballast);

  // Dual steel tracks: Track 1 (Blue, +X) wz = -148.2; Track 2 (Yellow, -X) wz = -152.2
  const TRACK1_Z = -148.2;
  const TRACK2_Z = -152.2;
  const railGeo = trackGeo(new THREE.BoxGeometry(220.0, 0.09, 0.16));
  for (const rz of [TRACK1_Z - 0.95, TRACK1_Z + 0.95, TRACK2_Z - 0.95, TRACK2_Z + 0.95]) {
    const rail = new THREE.Mesh(railGeo, silverSteelMat);
    rail.position.set(0, 0.055, rz);
    trainGroup.add(rail);
  }

  // Flush timber planks across the road crossing (X in [-7.5, +7.5])
  const plankGeo = trackGeo(new THREE.BoxGeometry(15.0, 0.04, 3.0));
  for (const tz of [TRACK1_Z, TRACK2_Z]) {
    const plank = new THREE.Mesh(plankGeo, woodTieMat);
    plank.position.set(0, 0.028, tz);
    trainGroup.add(plank);
  }

  // 220 wooden ties in 1 InstancedMesh (110 per track across X in [-110, +110])
  const tieInst = trackInst(new THREE.InstancedMesh(trackGeo(new THREE.BoxGeometry(0.32, 0.05, 2.8)), woodTieMat, 220));
  tieInst.name = 'railroad_wooden_ties';
  let tieIdx = 0;
  for (const tz of [TRACK1_Z, TRACK2_Z]) {
    for (let k = 0; k < 110; k += 1) {
      const tx = -109.0 + k * 2.0;
      dummy.position.set(tx, 0.025, tz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      tieInst.setMatrixAt(tieIdx, dummy.matrix);
      tieIdx += 1;
    }
  }
  tieInst.instanceMatrix.needsUpdate = true;
  trainGroup.add(tieInst);

  // Animated Red/White Crossbuck Gates & Flashing Beacons (visual non-blocking)
  const buildGate = (gx, gz, armDir) => {
    const g = new THREE.Group();
    g.position.set(gx, 0, gz);
    const pole = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.18, 0.22, 4.2, 8)), silverSteelMat);
    pole.position.y = 2.1;
    g.add(pole);
    const lightL = new THREE.Mesh(beaconGeo, beaconOffMat);
    lightL.position.set(-0.45, 3.4, 0.25);
    g.add(lightL);
    const lightR = new THREE.Mesh(beaconGeo, beaconOffMat);
    lightR.position.set(0.45, 3.4, 0.25);
    g.add(lightR);

    const armPivot = new THREE.Group();
    armPivot.position.set(0, 1.35, 0);
    for (let s = 0; s < 6; s += 1) {
      const seg = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.22, 0.18, 0.14)), s % 2 === 0 ? redMat : whiteMat);
      seg.position.x = armDir * (0.7 + s * 1.22);
      armPivot.add(seg);
    }
    g.add(armPivot);
    trainGroup.add(g);
    return { armPivot, lightL, lightR, armDir };
  };
  const gateSE = buildGate(8.6, -143.6, -1);
  const gateNW = buildGate(-8.6, -156.4, 1);

  // Roadside RAILROAD CROSSING & STOP signs facing South (+Z) toward spawnPos
  const addRoadSign = (x, z, title, sub, bg, fg) => {
    const post = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.24, 3.2, 0.24)), darkSteelMat);
    post.position.set(x, 1.6, z);
    trainGroup.add(post);
    const board = makeSignPanel(title, sub, bg, fg, 4.8, 2.4);
    board.position.set(x, 3.4, z + 0.15);
    trainGroup.add(board);
  };
  addRoadSign(-9.4, -142.8, 'RAILROAD CROSSING', 'LOOK BOTH WAYS', '#f8fafc', '#111827');
  addRoadSign(9.4, -140.2, 'STOP', 'HIGH SPEED TRAINS', '#dc2626', '#ffffff');

  // Twin Grey Double-Arch Concrete Hill Tunnels (strictly capped |x| <= 124!)
  const buildTunnelPortal = (signX) => {
    const tg = new THREE.Group();
    const portalX = signX * 96;
    const hillCenterX = signX * 110; // spans [96, 124] or [-124, -96]
    // 3 concrete piers forming twin track arches
    const tPierGeo = trackGeo(new THREE.BoxGeometry(2.4, 6.4, 1.4));
    for (const pz of [-155.8, -150.2, -144.6]) {
      const pier = new THREE.Mesh(tPierGeo, concrete3x3Mat);
      pier.position.set(portalX, 3.2, pz);
      tg.add(pier);
    }
    const lintel = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.8, 2.4, 14.0)), concrete3x3Mat);
    lintel.position.set(portalX, 7.2, -150.2);
    tg.add(lintel);

    // Pitch-black tunnel interior box
    const darkVoid = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(24.0, 6.2, 12.2)), tunnelDarkMat);
    darkVoid.position.set(hillCenterX, 3.1, -150.2);
    tg.add(darkVoid);

    // Blocky green Roblox hillside blocks strictly inside |x| in [96, 124], z in [-164, -136]
    const hillBaseL = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(28.0, 9.5, 7.0)), hillGrassMat);
    hillBaseL.position.set(hillCenterX, 4.75, -160.2);
    tg.add(hillBaseL);
    const hillBaseR = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(28.0, 9.5, 7.0)), hillGrassMat);
    hillBaseR.position.set(hillCenterX, 4.75, -140.2);
    tg.add(hillBaseR);
    const hillTop = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(28.0, 6.5, 28.0)), hillGrassMat);
    hillTop.position.set(hillCenterX, 11.25, -150.0);
    tg.add(hillTop);
    // Cap outer back wall (|x| = 123 +- 1 = [122, 124]) so darkVoid & gap are completely enclosed
    const hillBack = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.0, 8.2, 14.0)), hillGrassMat);
    hillBack.position.set(signX * 123.0, 4.1, -150.2);
    tg.add(hillBack);

    trainGroup.add(tg);
  };
  buildTunnelPortal(-1);
  buildTunnelPortal(1);

  // Build 2 continuously running 3-car Diesel Trains (length = 36.4m, halfL = 18.2m)
  const buildTrain = (name, trackZ, dirX, bodyMat, stripeMat, startX, baseSpeed) => {
    const root = new THREE.Group();
    root.name = name;
    root.position.set(startX, 0, trackZ);
    trainGroup.add(root);

    const cars = [];
    // Lead locomotive at local x = dirX * 12.0 (nose at dirX * 18.2)
    const loco = new THREE.Group();
    loco.position.x = dirX * 12.0;
    const locoBody = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(12.4, 3.6, 3.2)), bodyMat);
    locoBody.position.y = 2.3;
    locoBody.castShadow = true;
    loco.add(locoBody);
    const locoStripe = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(12.5, 0.55, 3.26)), stripeMat);
    locoStripe.position.y = 1.8;
    loco.add(locoStripe);
    const cabWin = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.2, 1.2, 3.28)), cabGlassMat);
    cabWin.position.set(dirX * 3.4, 3.2, 0);
    loco.add(cabWin);
    const stack = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.45, 0.52, 1.0, 10)), blackIronMat);
    stack.position.set(-dirX * 2.0, 4.4, 0);
    loco.add(stack);
    const cowcatcher = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.2, 1.1, 3.1)), darkSteelMat);
    cowcatcher.position.set(dirX * 6.3, 0.85, 0);
    loco.add(cowcatcher);
    for (const hz of [-0.95, 0.95]) {
      const hl = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.25, 0.55, 0.55)), headlightMat);
      hl.position.set(dirX * 6.25, 2.2, hz);
      loco.add(hl);
    }
    const bogie = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(10.6, 0.65, 2.7)), blackIronMat);
    bogie.position.y = 0.45;
    loco.add(bogie);
    root.add(loco);
    cars.push({ mesh: loco, localX: dirX * 12.0 });

    // 2 Freight / Passenger carriages at local x = 0 and -dirX * 12.0
    const carBodyGeo = trackGeo(new THREE.BoxGeometry(10.8, 3.3, 3.0));
    const carStripeGeo = trackGeo(new THREE.BoxGeometry(10.9, 0.48, 3.06));
    const carBogieGeo = trackGeo(new THREE.BoxGeometry(9.4, 0.62, 2.6));
    for (const off of [0, -dirX * 12.0]) {
      const car = new THREE.Group();
      car.position.x = off;
      const cb = new THREE.Mesh(carBodyGeo, bodyMat);
      cb.position.y = 2.2;
      cb.castShadow = true;
      car.add(cb);
      const cs = new THREE.Mesh(carStripeGeo, stripeMat);
      cs.position.y = 1.9;
      car.add(cs);
      const bg = new THREE.Mesh(carBogieGeo, blackIronMat);
      bg.position.y = 0.44;
      car.add(bg);
      root.add(car);
      cars.push({ mesh: car, localX: off });
    }

    return {
      name,
      root,
      cars,
      trackZ,
      dirX,
      x: startX,
      baseSpeed,
      speed: baseSpeed,
      halfL: 18.2,
    };
  };

  const TRAIN_WRAP_X = 132.0;
  // Counter-phased 180° (|blue.x| + |yellow.x| = 132) so at every phase one train approaches or is safely off-screen
  const trains = [
    buildTrain('blue_freight_train', TRACK1_Z, 1, trainBlueMat, silverSteelMat, -66.0, 40),
    buildTrain('yellow_diesel_train', TRACK2_Z, -1, trainYellowMat, darkSteelMat, -66.0, 40),
  ];

  const syncTrainVisibility = (tr) => {
    tr.root.position.x = tr.x;
    for (let c = 0; c < tr.cars.length; c += 1) {
      const carWorldX = tr.x + tr.cars[c].localX;
      tr.cars[c].mesh.visible = Math.abs(carWorldX) < 107.0;
    }
  };
  syncTrainVisibility(trains[0]);
  syncTrainVisibility(trains[1]);

  const summonTrain = (targetX = 0) => {
    const px = clamp(Number.isFinite(targetX) ? targetX : 0, -24, 24);
    // Pick the train farthest from crossing (or off-screen) so there is zero pop-in
    let chosen = trains[0];
    if (Math.abs(trains[1].x - px) > Math.abs(trains[0].x - px)) {
      chosen = trains[1];
    }
    // Position nose 40m upstream at 54 m/s (~0.74s arrival)
    chosen.x = px - chosen.dirX * (40.0 + chosen.halfL);
    chosen.speed = 54.0;
    syncTrainVisibility(chosen);
    return chosen;
  };

  // =========================================================================
  // MACHINE 8: RGB INDUSTRIAL SPIKED CAR SHREDDER TUNNELS (178, 0, -110)
  // =========================================================================
  const shredGroup = new THREE.Group();
  shredGroup.name = 'machine_shredder_tunnels';
  group.add(shredGroup);

  const shredYard = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(44.0, 0.05, 54.0)),
    trackMat(createStandardMaterial({ map: cloneTex(textures.concretePad, 5, 6), metalness: 0.04, roughness: 0.84 }, scene)),
  );
  shredYard.position.set(178, 0.0, -99);
  shredYard.receiveShadow = true;
  shredGroup.add(shredYard);

  // Master overhead banner raised cleanly above Orange Bay (y = 11.6) + backing + twin grounded support posts cleanly behind & below banner face
  const masterBanner = makeSignPanel('CAR SHREDDER TUNNELS', 'EMPLOYEES ONLY', '#1e293b', '#facc15', 22.0, 3.0);
  masterBanner.position.set(178, 11.6, -97.35);
  shredGroup.add(masterBanner);
  const masterBannerBack = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(22.3, 3.25, 0.22)), darkSteelMat);
  masterBannerBack.position.set(178, 11.6, -97.50);
  shredGroup.add(masterBannerBack);
  for (const px of [171.0, 185.0]) {
    const post = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.60, 10.1, 0.60)), darkSteelMat);
    post.position.set(px, 5.05, -97.80);
    shredGroup.add(post);
  }

  const smileyMat = trackMat(createStandardMaterial({
    map: textures.makeNumberTexture(':)', '#fdd835'),
    roughness: 0.45,
    metalness: 0.06,
  }, scene));
  const smileyBadge = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(2.4, 2.4)), smileyMat);
  smileyBadge.position.set(196.9, 5.2, -97.6);
  shredGroup.add(smileyBadge);

  // Helper to build tunnel walls + lintel sign
  const buildShredderBayShell = (cx, wallH, mat, title, bgHex) => {
    const wallGeo = trackGeo(new THREE.BoxGeometry(0.6, wallH, 26.0));
    const roofGeo = trackGeo(new THREE.BoxGeometry(10.4, 0.7, 26.0));
    for (const wx of [cx - 4.9, cx + 4.9]) {
      const w = new THREE.Mesh(wallGeo, mat);
      w.position.set(wx, wallH * 0.5, -111.0);
      w.castShadow = true;
      shredGroup.add(w);
    }
    const roof = new THREE.Mesh(roofGeo, mat);
    roof.position.set(cx, wallH + 0.35, -111.0);
    shredGroup.add(roof);

    const sign = makeSignPanel(title, 'EMPLOYEES ONLY', bgHex, '#ffffff', 9.2, 2.2);
    sign.position.set(cx, wallH + 0.4, -97.85);
    shredGroup.add(sign);
  };

  buildShredderBayShell(164.0, 6.8, redMat, 'RED SHREDDER', '#b91c1c');
  buildShredderBayShell(178.0, 6.8, greenMat, 'GREEN SHREDDER', '#15803d');
  buildShredderBayShell(192.0, 8.2, orangeBayMat, 'ORANGE SHREDDER', '#c2410c');

  // Orange Bay elevated analytical chute mesh matching ORANGE_SHREDDER_SURFACE_REGION
  const orangeChuteMesh = new THREE.Mesh(
    trackGeo(buildOrangeChuteGeometry()),
    trackMat(createStandardMaterial({ map: cloneTex(textures.concretePad, 2, 1), color: 0xfed7aa, metalness: 0.04, roughness: 0.80 }, scene)),
  );
  orangeChuteMesh.name = 'orange_shredder_chute_deck';
  orangeChuteMesh.position.x = 192.0;
  orangeChuteMesh.receiveShadow = true;
  shredGroup.add(orangeChuteMesh);

  // Solid underside block for Orange chute so it looks grounded from sides
  const orangeUnderBlock = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(9.0, 2.38, 6.0)), orangeBayMat);
  orangeUnderBlock.position.set(192.0, 1.19, -111.0);
  shredGroup.add(orangeUnderBlock);

  // Vertical Spiked Rollers (4 in Red Bay + 4 in Green Bay) + 1 Horizontal Overhead Drum in Orange Bay
  // Three.js Y-rotation moves (+X) toward (-Z) for positive omega, so West rollers (+omega) and
  // East rollers (-omega) both sweep their inner faces Northward (-Z), pulling cars into the bay!
  const vRollers = [
    // Red Bay (wx = 164 +- 3.05, R_core=1.55, tip gap = 1.40m)
    { cx: 164 - 3.05, cz: -108.0, rCore: 1.55, omega: 5.5, angle: 0.0 },
    { cx: 164 + 3.05, cz: -108.0, rCore: 1.55, omega: -5.5, angle: 0.5 },
    { cx: 164 - 3.05, cz: -115.0, rCore: 1.55, omega: 5.5, angle: 1.0 },
    { cx: 164 + 3.05, cz: -115.0, rCore: 1.55, omega: -5.5, angle: 1.5 },
    // Green Bay (CENTERLINE wx = 178 +- 2.85, R_core=1.60, tip gap = 1.00m!)
    { cx: 178 - 2.85, cz: -107.5, rCore: 1.60, omega: 6.5, angle: 0.2 },
    { cx: 178 + 2.85, cz: -107.5, rCore: 1.60, omega: -6.5, angle: 0.7 },
    { cx: 178 - 2.85, cz: -114.5, rCore: 1.60, omega: 6.5, angle: 1.2 },
    { cx: 178 + 2.85, cz: -114.5, rCore: 1.60, omega: -6.5, angle: 1.7 },
  ];

  const vDrumGeoRed = trackGeo(new THREE.CylinderGeometry(1.55, 1.55, 4.6, 14));
  const vDrumGeoGreen = trackGeo(new THREE.CylinderGeometry(1.60, 1.60, 4.6, 14));
  for (let i = 0; i < vRollers.length; i += 1) {
    const r = vRollers[i];
    const mesh = new THREE.Mesh(i < 4 ? vDrumGeoRed : vDrumGeoGreen, darkSteelMat);
    mesh.name = `shredder_vertical_drum_${i}`;
    mesh.position.set(r.cx, 2.4, r.cz);
    mesh.castShadow = true;
    shredGroup.add(mesh);
    r.mesh = mesh;
  }

  // Orange Bay horizontal overhead drum at (192.0, 4.95, -111.0), R_core=1.35, L=8.8
  // Positive X-rotation sweeps the bottom spikes (0, -1, 0) toward (-Z), propelling cars down exit chute.
  const hDrumGeo = trackGeo(new THREE.CylinderGeometry(1.35, 1.35, 8.8, 16));
  hDrumGeo.rotateZ(Math.PI / 2);
  const orangeDrumMesh = new THREE.Mesh(hDrumGeo, darkSteelMat);
  orangeDrumMesh.name = 'shredder_orange_overhead_drum';
  orangeDrumMesh.position.set(192.0, 4.95, -111.0);
  orangeDrumMesh.castShadow = true;
  shredGroup.add(orangeDrumMesh);
  const orangeDrum = { cx: 192.0, cy: 4.95, cz: -111.0, rCore: 1.35, omega: 5.8, angle: 0 };

  // 172 metallic shredder tooth cones in 1 single InstancedMesh (8*18 + 28 = 172)
  const TOTAL_SHREDDER_SPIKES = vRollers.length * 18 + 28;
  const shredderSpikesInst = trackInst(new THREE.InstancedMesh(
    trackGeo(new THREE.ConeGeometry(0.22, 0.78, 5)),
    silverSteelMat,
    TOTAL_SHREDDER_SPIKES,
  ));
  shredderSpikesInst.name = 'shredder_all_spikes';
  shredderSpikesInst.frustumCulled = false;
  shredGroup.add(shredderSpikesInst);

  const scratchSpikeDir = new THREE.Vector3();
  const syncShredderSpikes = () => {
    let idx = 0;
    // 8 vertical rollers × 18 spikes (3 rings × 6 spikes per ring)
    for (let rIdx = 0; rIdx < vRollers.length; rIdx += 1) {
      const r = vRollers[rIdx];
      r.mesh.rotation.y = r.angle;
      for (let ring = 0; ring < 3; ring += 1) {
        const sy = 1.0 + ring * 1.4;
        const ringOff = ring * 0.52;
        for (let k = 0; k < 6; k += 1) {
          const a = r.angle + ringOff + (k * Math.PI * 2) / 6;
          const dx = Math.cos(a);
          const dz = -Math.sin(a);
          const rad = r.rCore + 0.32;
          scratchPos.set(r.cx + dx * rad, sy, r.cz + dz * rad);
          scratchSpikeDir.set(dx, 0, dz);
          scratchQuat.setFromUnitVectors(upAxis, scratchSpikeDir);
          scratchMat4.compose(scratchPos, scratchQuat, scratchScale);
          shredderSpikesInst.setMatrixAt(idx, scratchMat4);
          idx += 1;
        }
      }
    }
    // Orange horizontal drum: 28 spikes (7 rows along X × 4 around circumference)
    orangeDrumMesh.rotation.x = orangeDrum.angle;
    for (let row = 0; row < 7; row += 1) {
      const sx = 192.0 - 3.6 + row * 1.2;
      const rowOff = row * 0.39;
      for (let k = 0; k < 4; k += 1) {
        const a = orangeDrum.angle + rowOff + (k * Math.PI * 2) / 4;
        const dy = Math.cos(a);
        const dz = Math.sin(a);
        const rad = orangeDrum.rCore + 0.30;
        scratchPos.set(sx, orangeDrum.cy + dy * rad, orangeDrum.cz + dz * rad);
        scratchSpikeDir.set(0, dy, dz);
        scratchQuat.setFromUnitVectors(upAxis, scratchSpikeDir);
        scratchMat4.compose(scratchPos, scratchQuat, scratchScale);
        shredderSpikesInst.setMatrixAt(idx, scratchMat4);
        idx += 1;
      }
    }
    shredderSpikesInst.instanceMatrix.needsUpdate = true;
  };
  syncShredderSpikes();

  // =========================================================================
  // UNIFIED UPDATE, HAZARD QUERY, TRIGGER & ALERT LOOP
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
  const bayHitCounts = { red: 0, green: 0, orange: 0 };
  const trainApproach = {
    valid: false,
    prevX: 0,
    prevZ: 0,
    prevVz: 0,
    accelEst: 0,
  };

  const update = (dt, rawVeh) => {
    const safeDt = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 0;
    if (safeDt <= 0) return;
    simTime += safeDt;
    defaultCtx.simTime = simTime;

    const body = extractVehicleBody(rawVeh);

    // -----------------------------------------------------------------------
    // 1. Update Hydraulic Press
    // -----------------------------------------------------------------------
    pressState.hitCooldown = Math.max(0, pressState.hitCooldown - safeDt);
    const inPressBay = body.valid
      && Math.abs(body.x - 78) <= 5.2
      && Math.abs(body.z - (-68)) <= 6.8
      && body.y <= 5.0;

    if (pressState.phase === 'IDLE') {
      pressState.plateBottomY = 6.20;
      pressState.jawInnerOffset = 4.50;
      if (inPressBay) {
        pressState.phase = 'WARNING';
        pressState.timer = 0;
      }
    } else if (pressState.phase === 'WARNING') {
      pressState.timer += safeDt;
      if (pressState.timer >= 0.65) {
        startPressClosing();
      }
    } else if (pressState.phase === 'CLOSING') {
      pressState.timer += safeDt;
      const t = clamp(pressState.timer / 0.55, 0, 1);
      const ease = t * t;
      if (pressState.mode === 'top') {
        pressState.plateBottomY = 6.20 + (0.55 - 6.20) * ease;
        pressState.jawInnerOffset = 4.50;
      } else {
        pressState.plateBottomY = 6.20 + (3.60 - 6.20) * ease;
        pressState.jawInnerOffset = 4.50 + (0.85 - 4.50) * ease;
      }
      if (t >= 1) {
        pressState.phase = 'HOLD';
        pressState.timer = 0;
      }
    } else if (pressState.phase === 'HOLD') {
      pressState.timer += safeDt;
      if (pressState.timer >= 0.45) {
        pressState.phase = 'OPENING';
        pressState.timer = 0;
      }
    } else if (pressState.phase === 'OPENING') {
      pressState.timer += safeDt;
      const t = clamp(pressState.timer / 1.15, 0, 1);
      if (pressState.mode === 'top') {
        pressState.plateBottomY = 0.55 + (6.20 - 0.55) * t;
        pressState.jawInnerOffset = 4.50;
      } else {
        pressState.plateBottomY = 3.60 + (6.20 - 3.60) * t;
        pressState.jawInnerOffset = 0.85 + (4.50 - 0.85) * t;
      }
      if (t >= 1) {
        pressState.plateBottomY = 6.20;
        pressState.jawInnerOffset = 4.50;
        pressState.phase = 'COOLDOWN';
        pressState.timer = 0;
      }
    } else if (pressState.phase === 'COOLDOWN') {
      pressState.timer += safeDt;
      if (pressState.timer >= 1.40) {
        pressState.phase = 'IDLE';
        pressState.timer = 0;
      }
    }
    syncPressVisuals(simTime);

    // -----------------------------------------------------------------------
    // 2. Update Wrecking Balls (110° counter-phase + observable-vx dual-ball pacing)
    // -----------------------------------------------------------------------
    let wEff = WB_OMEGA;
    if (body.valid && body.x >= 76.0 && body.x <= 105.5 && Math.abs(body.z - 8.0) <= 6.5 && body.vx > 4.0) {
      let bestErr = Infinity;
      let bestTArr = 0.5;
      for (let i = 0; i < wbBalls.length; i += 1) {
        const bx = wbBalls[i].pivotX;
        if (bx <= body.x - 0.5) continue;
        const tArr = Math.max(0.08, (bx - body.x) / body.vx);
        const pred = wbState.phase + wbBalls[i].phaseOffset + WB_OMEGA * tArr;
        const target = Math.round(pred / Math.PI) * Math.PI;
        const err = target - pred;
        if (Math.abs(err) < Math.abs(bestErr)) {
          bestErr = err;
          bestTArr = tArr;
        }
      }
      if (Number.isFinite(bestErr)) {
        wEff = clamp(WB_OMEGA + bestErr / bestTArr, 0.55 * WB_OMEGA, 1.75 * WB_OMEGA);
      }
    }
    wbState.phase += wEff * safeDt;
    for (let i = 0; i < wbBalls.length; i += 1) {
      const b = wbBalls[i];
      const theta = WB_AMAX * Math.sin(wbState.phase + b.phaseOffset);
      b.theta = theta;
      b.pivot.rotation.x = -theta;
      b.wx = b.pivotX;
      b.wy = 14.0 - WB_L * Math.cos(theta);
      b.wz = 8.0 + WB_L * Math.sin(theta);
    }

    // -----------------------------------------------------------------------
    // 3. Update Spinning Orange Hammers
    // -----------------------------------------------------------------------
    for (let i = 0; i < spinPosts.length; i += 1) {
      const p = spinPosts[i];
      p.angle += p.omega * safeDt;
      p.rotor.rotation.y = p.angle;
    }

    // -----------------------------------------------------------------------
    // 4. Update Nail Hammer
    // -----------------------------------------------------------------------
    const inNailPad = body.valid && Math.hypot(body.x - (-104), body.z - (-10)) <= 7.8 && body.y <= 5.0;
    if (nailState.phase === 'READY') {
      nailState.theta = NAIL_READY_THETA;
      if (inNailPad) {
        nailState.phase = 'ARMING';
        nailState.timer = 0;
      }
    } else if (nailState.phase === 'ARMING') {
      nailState.timer += safeDt;
      if (nailState.timer >= 0.50) {
        nailState.phase = 'SWINGING';
        nailState.timer = 0;
        nailState.hitThisSwing = false;
      }
    } else if (nailState.phase === 'SWINGING') {
      nailState.timer += safeDt;
      const t = clamp(nailState.timer / 0.34, 0, 1);
      const ease = t * t * t;
      nailState.theta = NAIL_READY_THETA + (NAIL_STRIKE_THETA - NAIL_READY_THETA) * ease;
      if (t >= 1) {
        nailState.phase = 'IMPACT_HOLD';
        nailState.timer = 0;
      }
    } else if (nailState.phase === 'IMPACT_HOLD') {
      nailState.timer += safeDt;
      if (nailState.timer >= 0.45) {
        nailState.phase = 'LIFTING';
        nailState.timer = 0;
      }
    } else if (nailState.phase === 'LIFTING') {
      nailState.timer += safeDt;
      const t = clamp(nailState.timer / 1.25, 0, 1);
      nailState.theta = NAIL_STRIKE_THETA + (NAIL_READY_THETA - NAIL_STRIKE_THETA) * t;
      if (t >= 1) {
        nailState.theta = NAIL_READY_THETA;
        nailState.phase = 'COOLDOWN';
        nailState.timer = 0;
      }
    } else if (nailState.phase === 'COOLDOWN') {
      nailState.timer += safeDt;
      if (nailState.timer >= 1.20) {
        nailState.phase = 'READY';
        nailState.timer = 0;
      }
    }
    nailPivot.rotation.x = -nailState.theta;

    // -----------------------------------------------------------------------
    // 5. Update Giant Hammer Wooden Tower
    // -----------------------------------------------------------------------
    const inGiantPad = body.valid && Math.hypot(body.x - (-82), body.z - (-82)) <= 7.8 && body.y <= 5.5;
    if (giantState.phase === 'READY') {
      giantState.bottomY = GIANT_REST_Y;
      giantState.velY = 0;
      if (inGiantPad) {
        giantState.phase = 'ARMING';
        giantState.timer = 0;
      }
    } else if (giantState.phase === 'ARMING') {
      giantState.timer += safeDt;
      if (giantState.timer >= 0.55) {
        giantState.phase = 'DROPPING';
        giantState.timer = 0;
        giantState.velY = 0;
        giantState.hitThisDrop = false;
      }
    } else if (giantState.phase === 'DROPPING') {
      giantState.velY += 42.0 * safeDt;
      giantState.bottomY -= giantState.velY * safeDt;
      if (giantState.bottomY <= GIANT_IMPACT_Y) {
        giantState.bottomY = GIANT_IMPACT_Y;
        giantState.velY = 0;
        giantState.phase = 'IMPACT_HOLD';
        giantState.timer = 0;
      }
    } else if (giantState.phase === 'IMPACT_HOLD') {
      giantState.timer += safeDt;
      if (giantState.timer >= 0.55) {
        giantState.phase = 'RAISING';
        giantState.timer = 0;
      }
    } else if (giantState.phase === 'RAISING') {
      giantState.timer += safeDt;
      const t = clamp(giantState.timer / 2.10, 0, 1);
      giantState.bottomY = GIANT_IMPACT_Y + (GIANT_REST_Y - GIANT_IMPACT_Y) * t;
      if (t >= 1) {
        giantState.bottomY = GIANT_REST_Y;
        giantState.phase = 'COOLDOWN';
        giantState.timer = 0;
      }
    } else if (giantState.phase === 'COOLDOWN') {
      giantState.timer += safeDt;
      if (giantState.timer >= 1.20) {
        giantState.phase = 'READY';
        giantState.timer = 0;
      }
    }
    syncGiantVisuals();

    // -----------------------------------------------------------------------
    // 6. Update Spike Drop Zone (14 Instanced Naval Mines)
    // -----------------------------------------------------------------------
    spikeState.globalHitCd = Math.max(0, spikeState.globalHitCd - safeDt);
    const inSpikeBox = body.valid
      && Math.abs(body.x - (-82)) <= 7.8
      && Math.abs(body.z - 74) <= 7.8
      && body.y <= 5.5;

    if (spikeState.phase === 'LOADED') {
      hopperDoorL.rotation.z = 0;
      hopperDoorR.rotation.z = 0;
      if (inSpikeBox) {
        spikeState.phase = 'ARMING';
        spikeState.timer = 0;
      }
    } else if (spikeState.phase === 'ARMING') {
      spikeState.timer += safeDt;
      const openT = clamp(spikeState.timer / 0.50, 0, 1);
      hopperDoorL.rotation.z = -1.15 * openT;
      hopperDoorR.rotation.z = 1.15 * openT;
      if (spikeState.timer >= 0.50) {
        launchMines();
      }
    } else if (spikeState.phase === 'DROPPING') {
      spikeState.timer += safeDt;
      hopperDoorL.rotation.z = -1.15;
      hopperDoorR.rotation.z = 1.15;
      for (let i = 0; i < MINE_COUNT; i += 1) {
        const m = mines[i];
        m.hitCd = Math.max(0, m.hitCd - safeDt);
        if (spikeState.timer < m.delay) continue;
        m.released = true;
        m.vy -= 28.0 * safeDt;
        m.x += m.vx * safeDt;
        m.y += m.vy * safeDt;
        m.z += m.vz * safeDt;

        if (m.y < MINE_R) {
          m.y = MINE_R;
          m.vy = Math.abs(m.vy) > 1.4 ? Math.abs(m.vy) * 0.52 : 0;
          m.vx *= 0.86;
          m.vz *= 0.86;
        }
        if (m.x < -89.2) {
          m.x = -89.2;
          m.vx = Math.abs(m.vx) * 0.72;
        } else if (m.x > -74.8) {
          m.x = -74.8;
          m.vx = -Math.abs(m.vx) * 0.72;
        }
        if (m.z < 66.5) {
          m.z = 66.5;
          m.vz = Math.abs(m.vz) * 0.72;
        } else if (m.z > 81.5) {
          m.z = 81.5;
          m.vz = -Math.abs(m.vz) * 0.72;
        }
        m.rx += m.vz * 0.75 * safeDt;
        m.rz -= m.vx * 0.75 * safeDt;
        m.ry += 0.9 * safeDt;
      }
      syncMineInstances();
      if (spikeState.timer >= 3.80) {
        spikeState.phase = 'RESETTING';
        spikeState.timer = 0;
      }
    } else if (spikeState.phase === 'RESETTING') {
      spikeState.timer += safeDt;
      const t = clamp(spikeState.timer / 0.70, 0, 1);
      for (let i = 0; i < MINE_COUNT; i += 1) {
        const m = mines[i];
        m.x += (m.homeX - m.x) * Math.min(1, safeDt * 8);
        m.y += (m.homeY - m.y) * Math.min(1, safeDt * 8);
        m.z += (m.homeZ - m.z) * Math.min(1, safeDt * 8);
      }
      hopperDoorL.rotation.z = -1.15 * (1 - t);
      hopperDoorR.rotation.z = 1.15 * (1 - t);
      syncMineInstances();
      if (t >= 1) {
        for (let i = 0; i < MINE_COUNT; i += 1) {
          const m = mines[i];
          m.x = m.homeX;
          m.y = m.homeY;
          m.z = m.homeZ;
          m.vx = 0;
          m.vy = 0;
          m.vz = 0;
          m.released = false;
        }
        syncMineInstances();
        spikeState.phase = 'COOLDOWN';
        spikeState.timer = 0;
      }
    } else if (spikeState.phase === 'COOLDOWN') {
      spikeState.timer += safeDt;
      if (spikeState.timer >= 1.40) {
        spikeState.phase = 'LOADED';
        spikeState.timer = 0;
      }
    }

    // -----------------------------------------------------------------------
    // 7. Update Railroad Crossing & Speeding Diesel Trains
    // -----------------------------------------------------------------------
    const movingNorthTowardTracks = body.valid
      && Math.abs(body.x) <= 16.0
      && body.y <= 5.5
      && body.z >= -156.5
      && body.z <= -121.5
      && body.vz < -0.1;
    const movingSouthTowardTracks = body.valid
      && Math.abs(body.x) <= 16.0
      && body.y <= 5.5
      && body.z >= -176.0
      && body.z <= -144.0
      && body.vz > 0.1;
    const lingeringNearTracks = body.valid
      && Math.abs(body.x) <= 16.0
      && body.y <= 5.5
      && body.z >= -156.5
      && body.z <= -132.0;
    const inTrainZone = movingNorthTowardTracks || movingSouthTowardTracks || lingeringNearTracks;

    if (inTrainZone) {
      // Track vehicle longitudinal acceleration from consecutive frames for exact kinematic ETA
      if (
        trainApproach.valid
        && Math.hypot(body.x - trainApproach.prevX, body.z - trainApproach.prevZ) <= 5.0
      ) {
        const approachSign = movingSouthTowardTracks ? 1 : -1;
        const dvApproach = (body.vz - trainApproach.prevVz) * approachSign;
        const instAccel = clamp(dvApproach / safeDt, 0, 35.0);
        trainApproach.accelEst = trainApproach.accelEst * 0.45 + instAccel * 0.55;
      } else {
        trainApproach.accelEst = 0;
      }
      trainApproach.valid = true;
      trainApproach.prevX = body.x;
      trainApproach.prevZ = body.z;
      trainApproach.prevVz = body.vz;

      const computeTrackETA = (tr) => {
        if (movingNorthTowardTracks) {
          if (body.z + body.halfL < tr.trackZ - 1.55) return null; // already cleared this track
          const dz = Math.max(0, body.z - tr.trackZ);
          if (dz <= 0.6) return 0.20;
          const v = Math.max(0, -body.vz);
          const a = trainApproach.accelEst;
          let tRaw;
          if (a > 0.5) {
            tRaw = (-v + Math.sqrt(v * v + 2.0 * a * dz)) / a;
          } else {
            const vEst = v < 10.0 ? Math.max(12.0, v + 5.0) : v;
            tRaw = dz / vEst;
          }
          return clamp(tRaw, 0.16, 2.35);
        }
        if (movingSouthTowardTracks) {
          if (body.z - body.halfL > tr.trackZ + 1.55) return null;
          const dz = Math.max(0, tr.trackZ - body.z);
          if (dz <= 0.6) return 0.20;
          const v = Math.max(0, body.vz);
          const a = trainApproach.accelEst;
          let tRaw;
          if (a > 0.5) {
            tRaw = (-v + Math.sqrt(v * v + 2.0 * a * dz)) / a;
          } else {
            const vEst = v < 10.0 ? Math.max(12.0, v + 5.0) : v;
            tRaw = dz / vEst;
          }
          return clamp(tRaw, 0.16, 2.35);
        }
        // Parked or slow near/on tracks
        return 0.55;
      };

      // Evaluate each train on unpassed tracks: prefer smooth speed modulation with zero repositioning
      let bestNatural = null;
      let bestNaturalCost = Infinity;
      const candidates = [];

      for (let i = 0; i < trains.length; i += 1) {
        const tr = trains[i];
        const tArrive = computeTrackETA(tr);
        if (tArrive === null) continue;
        const noseX = tr.x + tr.dirX * tr.halfL;
        const upstream = (body.x - noseX) * tr.dirX; // > 0 upstream, < 0 nose passed body.x
        const tailUpstream = upstream + 2.0 * tr.halfL; // > 0 while train tail hasn't passed body.x
        candidates.push({ tr, tArrive, upstream, tailUpstream });

        const maxReach = 86.0 * tArrive - 2.0;
        const minSpanRemain = 20.0 * tArrive + 2.5;
        if (upstream <= maxReach && tailUpstream >= minSpanRemain) {
          const reqSpeed = clamp((upstream + 8.0) / Math.max(0.16, tArrive), 20.0, 86.0);
          const cost = Math.abs(reqSpeed - tr.baseSpeed);
          if (cost < bestNaturalCost) {
            bestNaturalCost = cost;
            bestNatural = { tr, reqSpeed };
          }
        }
      }

      if (bestNatural) {
        bestNatural.tr.speed = bestNatural.reqSpeed;
      } else if (candidates.length > 0) {
        // Cue an off-screen train (strictly outside +-25m chase-cam FOV: |tr.x - body.x| > 46m)
        let pick = null;
        let bestOffDist = -1;
        for (let i = 0; i < candidates.length; i += 1) {
          const c = candidates[i];
          const absDist = Math.abs(c.tr.x - body.x);
          if (absDist > 46.0 && absDist > bestOffDist) {
            bestOffDist = absDist;
            pick = c;
          }
        }
        if (pick) {
          const cueNoseDist = clamp(pick.tArrive * 62.0 - 6.0, 27.5, 68.0);
          pick.tr.x = body.x - pick.tr.dirX * (cueNoseDist + pick.tr.halfL);
          pick.tr.speed = clamp((cueNoseDist + 8.0) / Math.max(0.16, pick.tArrive), 24.0, 86.0);
        } else {
          // Rare fallback if manual spam put both trains close and receding: clear farthest out rapidly
          let farTr = candidates[0].tr;
          if (candidates.length > 1 && Math.abs(candidates[1].tr.x - body.x) > Math.abs(farTr.x - body.x)) {
            farTr = candidates[1].tr;
          }
          farTr.speed = 86.0;
        }
      }
    } else {
      trainApproach.valid = false;
      trainApproach.accelEst = 0;
    }

    let anyTrainNearCrossing = false;
    for (let i = 0; i < trains.length; i += 1) {
      const tr = trains[i];
      tr.x += tr.dirX * tr.speed * safeDt;
      if (tr.dirX > 0 && tr.x > TRAIN_WRAP_X) {
        tr.x = -TRAIN_WRAP_X;
        tr.speed = tr.baseSpeed;
      } else if (tr.dirX < 0 && tr.x < -TRAIN_WRAP_X) {
        tr.x = TRAIN_WRAP_X;
        tr.speed = tr.baseSpeed;
      } else if (!inTrainZone && tr.speed !== tr.baseSpeed) {
        if (tr.speed > tr.baseSpeed) {
          tr.speed = Math.max(tr.baseSpeed, tr.speed - 14.0 * safeDt);
        } else {
          tr.speed = Math.min(tr.baseSpeed, tr.speed + 14.0 * safeDt);
        }
      }
      syncTrainVisibility(tr);
      if (Math.abs(tr.x) < 58.0) {
        anyTrainNearCrossing = true;
      }
    }

    // Smooth crossbuck gate arms & 4Hz alternating red beacons
    const targetGateAngle = anyTrainNearCrossing ? 0.0 : 1.43; // 0 = horizontal down, 1.43 rad = 82 deg up
    const blinkA = anyTrainNearCrossing && Math.sin(simTime * Math.PI * 8) > 0;
    const blinkB = anyTrainNearCrossing && !blinkA;
    for (const g of [gateSE, gateNW]) {
      const signedTarget = g.armDir * targetGateAngle;
      g.armPivot.rotation.z += (signedTarget - g.armPivot.rotation.z) * Math.min(1, safeDt * 6.0);
      g.lightL.material = blinkA ? beaconOnMat : beaconOffMat;
      g.lightR.material = blinkB ? beaconOnMat : beaconOffMat;
    }

    // -----------------------------------------------------------------------
    // 8. Update RGB Shredder Rollers & 172 Instanced Spikes
    // -----------------------------------------------------------------------
    for (let i = 0; i < vRollers.length; i += 1) {
      vRollers[i].angle += vRollers[i].omega * safeDt;
    }
    orangeDrum.angle += orangeDrum.omega * safeDt;
    syncShredderSpikes();
  };

  const queryHazards = (rawVeh, ctx) => {
    const body = extractVehicleBody(rawVeh);
    if (!body.valid) return [];
    const activeCtx = ctx || defaultCtx;
    const vid = body.id;
    const impacts = [];

    // -----------------------------------------------------------------------
    // 1. Hydraulic Press Hazards & Pillars
    // -----------------------------------------------------------------------
    if (Math.abs(body.x - 78) <= 12 && Math.abs(body.z - (-68)) <= 16) {
      const inBay = Math.abs(body.x - 78) <= 5.2 && Math.abs(body.z - (-68)) <= 6.8 && body.y <= 5.0;
      if (inBay && (pressState.phase === 'CLOSING' || pressState.phase === 'HOLD')
        && pressState.hitsThisCycle < 2 && pressState.hitCooldown <= 0) {
        const topContact = pressState.mode === 'top' && pressState.plateBottomY <= body.h + 0.55;
        const sideContact = pressState.mode === 'side' && pressState.jawInnerOffset <= body.halfW + 0.65;
        if (topContact || sideContact) {
          pressState.hitsThisCycle += 1;
          pressState.hitCooldown = 0.35;
          const sideSign = body.x >= 78 ? 1 : -1;
          impacts.push(makeImpact({
            kind: 'press',
            damage: 46,
            impulse: pressState.mode === 'top' ? [0, -1.5, 0] : [sideSign * -6.0, 1.5, 0],
            crushY: 0.58,
            frontCrumple: 0.25,
            cashBonus: 120,
            xpBonus: 45,
            label: pressState.mode === 'top' ? 'HYDRAULIC CRUSH!' : 'SIDE PRESS CRUSH!',
            sound: 'crush',
            ignite: pressState.hitsThisCycle >= 2,
            explode: false,
            ejectRagdoll: true,
          }));
        }
      }
      for (let i = 0; i < pressPillars.length; i += 1) {
        const [px, pz] = pressPillars[i];
        const ov = hullOverlapsCircle2D(body, px, pz, 0.95);
        if (ov.hit && activeCtx.canHit(`${vid}:press_pillar_${i}`, 0.45)) {
          const inv = ov.dist > 1e-4 ? 1 / ov.dist : 1;
          impacts.push(makeImpact({
            kind: 'pillar',
            damage: 14,
            impulse: [ov.dx * inv * 10, 1.2, ov.dz * inv * 10],
            frontCrumple: 0.16,
            cashBonus: 15,
            xpBonus: 8,
            label: 'GANTRY IMPACT!',
            sound: 'crash',
          }));
        }
      }
    }

    // -----------------------------------------------------------------------
    // 2. Wrecking Balls Hazards
    // -----------------------------------------------------------------------
    if (body.x >= 90 && body.x <= 118 && body.z >= -4 && body.z <= 20) {
      for (let i = 0; i < wbBalls.length; i += 1) {
        const b = wbBalls[i];
        if (b.wy - WB_R <= body.y + body.h + 0.25) {
          const ov = hullOverlapsCircle2D(body, b.wx, b.wz, WB_R);
          if (ov.hit && activeCtx.canHit(`${vid}:wrecking_ball_${i}`, 0.65)) {
            const lateralSign = Math.sign(Math.cos(wbState.phase + b.phaseOffset)) || (i === 0 ? 1 : -1);
            impacts.push(makeImpact({
              kind: 'wrecking_ball',
              damage: 42,
              impulse: [-body.vx * 0.35, 8.5, lateralSign * 26.0],
              crushY: 0.18,
              frontCrumple: 0.38,
              cashBonus: 132,
              xpBonus: 55,
              label: 'WRECKING BALL SMASH!',
              sound: 'crash',
              ignite: true,
              explode: false,
              ejectRagdoll: true,
            }));
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // 3. Spinning Orange Hammers (Exact 2D Segment vs 3-Circle Hull)
    // -----------------------------------------------------------------------
    if (body.x >= 60 && body.x <= 92 && body.z >= 62 && body.z <= 102) {
      for (let i = 0; i < spinPosts.length; i += 1) {
        const p = spinPosts[i];
        // Pedestal bump
        const pedOv = hullOverlapsCircle2D(body, p.x, p.z, 0.95);
        if (pedOv.hit && activeCtx.canHit(`${vid}:spin_ped_${i}`, 0.45)) {
          const inv = pedOv.dist > 1e-4 ? 1 / pedOv.dist : 1;
          impacts.push(makeImpact({
            kind: 'pillar',
            damage: 12,
            impulse: [pedOv.dx * inv * 8, 1.0, pedOv.dz * inv * 8],
            frontCrumple: 0.12,
            cashBonus: 15,
            xpBonus: 8,
            label: 'POST BUMP!',
            sound: 'crash',
          }));
        }

        // Two perpendicular cross bars matching Three.js rotor.rotation.y = p.angle:
        // Bar 1 local +X -> (cos a, -sin a); Bar 2 local +Z -> (sin a, cos a)
        if (body.y <= p.armY + 0.85) {
          const ca = Math.cos(p.angle);
          const sa = Math.sin(p.angle);
          const dirs = [
            [ca, -sa],
            [sa, ca],
          ];
          let barHit = false;
          let hitTx = 0;
          let hitTz = 0;
          for (let d = 0; d < 2 && !barHit; d += 1) {
            const [dx, dz] = dirs[d];
            const ax = p.x - dx * SPIN_ARM_R;
            const az = p.z - dz * SPIN_ARM_R;
            const bx = p.x + dx * SPIN_ARM_R;
            const bz = p.z + dz * SPIN_ARM_R;
            for (let c = 0; c < 3; c += 1) {
              const res = distPointToSegment2D(body.circles[c].x, body.circles[c].z, ax, az, bx, bz);
              if (res.dist <= body.circleR + 0.55) {
                const s = (res.t - 0.5) * 2 * SPIN_ARM_R;
                const sign = Math.sign(p.omega * (Math.abs(s) < 0.5 ? 1 : s)) || 1;
                // Derivative of (cos a, -sin a) w.r.t. a is (-sin a, -cos a); of (sin a, cos a) is (cos a, -sin a)
                if (d === 0) {
                  hitTx = -sa * sign;
                  hitTz = -ca * sign;
                } else {
                  hitTx = ca * sign;
                  hitTz = -sa * sign;
                }
                barHit = true;
                break;
              }
            }
          }
          if (barHit && activeCtx.canHit(`${vid}:spin_arm_${i}`, 0.40)) {
            impacts.push(makeImpact({
              kind: 'spinner',
              damage: 28,
              impulse: [hitTx * 19.0, 5.5, hitTz * 19.0],
              crushY: 0.08,
              frontCrumple: 0.24,
              cashBonus: 65,
              xpBonus: 32,
              label: 'HAMMER SPIN SMASH!',
              sound: 'crash',
              ignite: false,
              explode: false,
              ejectRagdoll: body.speed > 16,
            }));
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // 4. Nail Hammer Strike Zone
    // -----------------------------------------------------------------------
    if (
      (nailState.phase === 'SWINGING' || nailState.phase === 'IMPACT_HOLD')
      && nailState.theta <= 0.18
      && !nailState.hitThisSwing
      && Math.hypot(body.x - (-104), body.z - (-10)) <= 7.8
      && body.y <= 5.0
    ) {
      nailState.hitThisSwing = true;
      impacts.push(makeImpact({
        kind: 'nail_hammer',
        damage: 58,
        impulse: [0, -2.0, 2.5],
        crushY: 0.68,
        frontCrumple: 0.35,
        cashBonus: 118,
        xpBonus: 55,
        label: 'NAIL HAMMER SMASH!',
        sound: 'hammer',
        ignite: true,
        explode: false,
        ejectRagdoll: true,
      }));
    }

    // -----------------------------------------------------------------------
    // 5. Giant Hammer Drop Tower & Corner Legs
    // -----------------------------------------------------------------------
    if (Math.abs(body.x - (-82)) <= 13 && Math.abs(body.z - (-82)) <= 13) {
      if (
        (giantState.phase === 'DROPPING' || giantState.phase === 'IMPACT_HOLD')
        && !giantState.hitThisDrop
        && giantState.bottomY <= body.y + body.h + 0.55
        && Math.hypot(body.x - (-82), body.z - (-82)) <= 7.8
      ) {
        giantState.hitThisDrop = true;
        impacts.push(makeImpact({
          kind: 'giant_hammer',
          damage: 78,
          impulse: [0, -3.0, 0],
          crushY: 0.82,
          frontCrumple: 0.45,
          cashBonus: 280,
          xpBonus: 85,
          label: 'GIANT HAMMER CRUSH!',
          sound: 'hammer',
          ignite: true,
          explode: true,
          ejectRagdoll: true,
        }));
      }
      for (let i = 0; i < giantLegs.length; i += 1) {
        const [lx, lz] = giantLegs[i];
        const ov = hullOverlapsCircle2D(body, lx, lz, 0.8);
        if (ov.hit && activeCtx.canHit(`${vid}:giant_leg_${i}`, 0.45)) {
          const inv = ov.dist > 1e-4 ? 1 / ov.dist : 1;
          impacts.push(makeImpact({
            kind: 'pillar',
            damage: 16,
            impulse: [ov.dx * inv * 9, 1.2, ov.dz * inv * 9],
            frontCrumple: 0.16,
            cashBonus: 20,
            xpBonus: 10,
            label: 'TOWER LEG IMPACT!',
            sound: 'crash',
          }));
        }
      }
    }

    // -----------------------------------------------------------------------
    // 6. Spike Drop Zone Naval Mines
    // -----------------------------------------------------------------------
    if (
      spikeState.phase === 'DROPPING'
      && spikeState.hitsThisDrop < 5
      && spikeState.globalHitCd <= 0
      && Math.abs(body.x - (-82)) <= 10.5
      && Math.abs(body.z - 74) <= 10.5
    ) {
      for (let i = 0; i < MINE_COUNT; i += 1) {
        const m = mines[i];
        if (!m.released || m.hitCd > 0) continue;
        if (m.y - MINE_R <= body.y + body.h + 0.35 && m.y + MINE_R >= body.y - 0.5) {
          const ov = hullOverlapsCircle2D(body, m.x, m.z, MINE_R + 0.25);
          if (ov.hit) {
            m.hitCd = 0.65;
            spikeState.globalHitCd = 0.24;
            spikeState.hitsThisDrop += 1;
            // Bounce the naval mine dramatically upward off the car roof!
            m.vy = Math.max(8.0, Math.abs(m.vy) * 0.75 + 6.0);
            const inv = ov.dist > 1e-4 ? 1 / ov.dist : 1;
            const pushX = ov.dx * inv;
            const pushZ = ov.dz * inv;
            m.vx = -pushX * 4.5;
            m.vz = -pushZ * 4.5;
            impacts.push(makeImpact({
              kind: 'spike_mine',
              damage: 24,
              impulse: [pushX * 5.0, -1.2, pushZ * 5.0],
              crushY: 0.16,
              frontCrumple: 0.18,
              cashBonus: 78,
              xpBonus: 28,
              label: 'NAVAL MINE IMPACT!',
              sound: spikeState.hitsThisDrop >= 3 ? 'explosion' : 'crash',
              ignite: spikeState.hitsThisDrop >= 2,
              explode: spikeState.hitsThisDrop >= 4,
              ejectRagdoll: spikeState.hitsThisDrop >= 3,
            }));
            break;
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // 7. Speeding Diesel Trains
    // -----------------------------------------------------------------------
    if (Math.abs(body.z - (-150)) <= 10.0 && Math.abs(body.x) <= 118.0 && body.y <= 5.2) {
      for (let i = 0; i < trains.length; i += 1) {
        const tr = trains[i];
        const minX = tr.x - tr.halfL;
        const maxX = tr.x + tr.halfL;
        const minZ = tr.trackZ - 1.65;
        const maxZ = tr.trackZ + 1.65;
        if (hullOverlapsAABB2D(body, minX, maxX, minZ, maxZ) && activeCtx.canHit(`${vid}:train_${i}`, 0.65)) {
          const sideZ = body.z >= tr.trackZ ? 1 : -1;
          impacts.push(makeImpact({
            kind: 'train',
            damage: 72,
            impulse: [tr.dirX * 36.0, 9.5, sideZ * 8.0],
            crushY: 0.28,
            frontCrumple: 0.78,
            cashBonus: 185,
            xpBonus: 75,
            label: 'TRAIN SMASH!',
            sound: 'train',
            ignite: true,
            explode: false,
            ejectRagdoll: true,
          }));
        }
      }
    }

    // -----------------------------------------------------------------------
    // 8. RGB Shredder Tunnels (Red 164 | Green 178 | Orange 192)
    // -----------------------------------------------------------------------
    if (body.x >= 156 && body.x <= 200 && body.z >= -126 && body.z <= -96) {
      // Red Bay (wx = 164)
      if (
        Math.abs(body.x - 164.0) <= 4.3
        && body.z >= -118.5
        && body.z <= -104.5
        && body.y <= 5.0
        && activeCtx.canHit(`${vid}:shredder_red`, 0.26)
      ) {
        bayHitCounts.red += 1;
        const kickX = (164.0 - body.x) * 2.2;
        impacts.push(makeImpact({
          kind: 'shredder',
          damage: 24,
          impulse: [kickX, 4.2, -10.5],
          crushY: 0.14,
          frontCrumple: 0.30,
          cashBonus: 95,
          xpBonus: 40,
          label: 'RED SHREDDER GRIND!',
          sound: 'shredder',
        }));
      }

      // Green Bay (CENTERLINE wx = 178 — tightest twin vertical spiked rollers)
      if (
        Math.abs(body.x - 178.0) <= 4.3
        && body.z >= -118.0
        && body.z <= -104.0
        && body.y <= 5.0
        && activeCtx.canHit(`${vid}:shredder_green`, 0.26)
      ) {
        bayHitCounts.green += 1;
        const kickX = (178.0 - body.x) * 2.4;
        impacts.push(makeImpact({
          kind: 'shredder',
          damage: 32,
          impulse: [kickX, 6.0, -9.0],
          crushY: 0.22,
          frontCrumple: 0.38,
          cashBonus: 135,
          xpBonus: 55,
          label: 'GREEN SHREDDER CRUSH!',
          sound: 'shredder',
          ignite: bayHitCounts.green >= 2,
          ejectRagdoll: bayHitCounts.green >= 2,
        }));
      }

      // Orange Bay (wx = 192 — elevated chute + overhead horizontal spiked drum)
      if (
        Math.abs(body.x - 192.0) <= 4.3
        && body.z >= -114.0
        && body.z <= -108.0
        && body.y <= 5.8
        && activeCtx.canHit(`${vid}:shredder_orange`, 0.26)
      ) {
        bayHitCounts.orange += 1;
        impacts.push(makeImpact({
          kind: 'shredder',
          damage: 36,
          impulse: [0, -1.5, -14.0],
          crushY: 0.45,
          frontCrumple: 0.32,
          cashBonus: 155,
          xpBonus: 65,
          label: 'ORANGE DRUM CRUSH!',
          sound: 'shredder',
          ignite: true,
          ejectRagdoll: true,
        }));
      }
    }

    return impacts;
  };

  // Manual trigger spots (5 crusher/train manual trigger zones)
  const triggerZoneMeta = [
    { zoneId: 'hydraulic_press', machineName: 'Hydraulic Press', shortLabel: 'CRUSH' },
    { zoneId: 'nail_hammer', machineName: 'Nail Hammer', shortLabel: 'NAIL' },
    { zoneId: 'giant_hammer', machineName: 'Giant Hammer Tower', shortLabel: 'DROP' },
    { zoneId: 'spike_drop', machineName: 'Spike Drop Zone', shortLabel: 'MINES' },
    { zoneId: 'train_crossing', machineName: 'Diesel Freight Train', shortLabel: 'TRAIN' },
  ].map((meta) => {
    const z = getZoneById(meta.zoneId);
    return {
      zoneId: meta.zoneId,
      machineName: meta.machineName,
      pos: [...z.padCenter],
      radius: z.padRadius + 10,
      triggerLabel: z.triggerLabel,
      shortLabel: meta.shortLabel,
    };
  });

  const triggerZoneMachine = (zoneId) => {
    if (zoneId === 'hydraulic_press') {
      startPressClosing();
      return {
        triggered: true,
        zoneId,
        machineName: 'Hydraulic Press',
        message: pressState.mode === 'top'
          ? 'The press is about to close: leave the bay!'
          : 'SIDE PRESS CLOSING! STAND CLEAR!',
      };
    }
    if (zoneId === 'nail_hammer') {
      nailState.theta = NAIL_READY_THETA;
      nailPivot.rotation.x = -NAIL_READY_THETA;
      nailState.phase = 'SWINGING';
      nailState.timer = 0;
      nailState.hitThisSwing = false;
      return {
        triggered: true,
        zoneId,
        machineName: 'Nail Hammer',
        message: 'NAIL HAMMER DROPPING! STAND CLEAR!',
      };
    }
    if (zoneId === 'giant_hammer') {
      giantState.bottomY = GIANT_REST_Y;
      giantState.velY = 0;
      giantState.phase = 'DROPPING';
      giantState.timer = 0;
      giantState.hitThisDrop = false;
      syncGiantVisuals();
      return {
        triggered: true,
        zoneId,
        machineName: 'Giant Hammer Tower',
        message: 'GIANT HAMMER RELEASED! STAND CLEAR!',
      };
    }
    if (zoneId === 'spike_drop') {
      launchMines();
      return {
        triggered: true,
        zoneId,
        machineName: 'Spike Drop Zone',
        message: 'NAVAL MINES RELEASED! WATCH OUT!',
      };
    }
    if (zoneId === 'train_crossing') {
      const tr = summonTrain(0);
      return {
        triggered: true,
        zoneId,
        machineName: 'Diesel Freight Train',
        message: tr.dirX > 0 ? 'BLUE FREIGHT TRAIN INCOMING!' : 'YELLOW DIESEL TRAIN INCOMING!',
      };
    }
    return null;
  };

  const triggerNearestMachine = (pos) => {
    if (!pos) return { triggered: false, machineName: '', zoneId: null, message: '' };
    const px = Array.isArray(pos) ? pos[0] : pos.x;
    const pz = Array.isArray(pos) ? pos[2] : pos.z;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) {
      return { triggered: false, machineName: '', zoneId: null, message: '' };
    }
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < triggerZoneMeta.length; i += 1) {
      const spot = triggerZoneMeta[i];
      const d = Math.hypot(px - spot.pos[0], pz - spot.pos[2]);
      if (d <= Math.max(spot.radius, 36) && d < bestDist) {
        bestDist = d;
        best = spot;
      }
    }
    if (!best) return { triggered: false, machineName: '', zoneId: null, message: '' };
    return triggerZoneMachine(best.zoneId);
  };

  const getActiveAlerts = (pos) => {
    if (!pos) return [];
    const px = Array.isArray(pos) ? pos[0] : pos.x;
    const pz = Array.isArray(pos) ? pos[2] : pos.z;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return [];
    const alerts = [];

    // Hydraulic Press alert
    if (Math.hypot(px - 78, pz - (-68)) <= 28) {
      if (pressState.phase === 'WARNING' || pressState.phase === 'CLOSING') {
        alerts.push({
          id: 'hydraulic_press_closing',
          zoneId: 'hydraulic_press',
          text: 'The press is about to close: leave the bay!',
          severity: 'danger',
          triggerable: true,
          triggerLabel: 'CRUSH PRESS',
          shortLabel: 'CRUSH',
        });
      } else {
        alerts.push({
          id: 'hydraulic_press_ready',
          zoneId: 'hydraulic_press',
          text: 'HYDRAULIC PRESS READY — TAP CRUSH!',
          severity: 'info',
          triggerable: true,
          triggerLabel: 'CRUSH PRESS',
          shortLabel: 'CRUSH',
        });
      }
    }

    // Nail Hammer alert
    if (Math.hypot(px - (-104), pz - (-10)) <= 28) {
      if (nailState.phase === 'ARMING' || nailState.phase === 'SWINGING') {
        alerts.push({
          id: 'nail_hammer_strike',
          zoneId: 'nail_hammer',
          text: 'NAIL HAMMER: STAND CLEAR!',
          severity: 'danger',
          triggerable: true,
          triggerLabel: 'DROP NAIL',
          shortLabel: 'NAIL',
        });
      } else {
        alerts.push({
          id: 'nail_hammer_ready',
          zoneId: 'nail_hammer',
          text: 'STRIKE ZONE — TAP DROP NAIL!',
          severity: 'info',
          triggerable: true,
          triggerLabel: 'DROP NAIL',
          shortLabel: 'NAIL',
        });
      }
    }

    // Giant Hammer alert (including RAISING percentage!)
    if (Math.hypot(px - (-82), pz - (-82)) <= 30) {
      if (giantState.phase === 'ARMING' || giantState.phase === 'DROPPING') {
        alerts.push({
          id: 'giant_hammer_drop',
          zoneId: 'giant_hammer',
          text: 'GIANT HAMMER: STAND CLEAR!',
          severity: 'danger',
          triggerable: true,
          triggerLabel: 'DROP HAMMER',
          shortLabel: 'DROP',
        });
      } else if (giantState.phase === 'RAISING') {
        const pct = Math.round(clamp(giantState.timer / 2.10, 0, 1) * 100);
        alerts.push({
          id: 'giant_hammer_raising',
          zoneId: 'giant_hammer',
          text: `GIANT HAMMER RAISING: ${pct}%`,
          severity: 'info',
          triggerable: true,
          triggerLabel: 'DROP HAMMER',
          shortLabel: 'DROP',
        });
      } else {
        alerts.push({
          id: 'giant_hammer_ready',
          zoneId: 'giant_hammer',
          text: 'DROP ZONE — TAP DROP HAMMER!',
          severity: 'info',
          triggerable: true,
          triggerLabel: 'DROP HAMMER',
          shortLabel: 'DROP',
        });
      }
    }

    // Spike Drop alert
    if (Math.hypot(px - (-82), pz - 74) <= 28) {
      if (spikeState.phase === 'ARMING' || spikeState.phase === 'DROPPING') {
        alerts.push({
          id: 'spike_drop_incoming',
          zoneId: 'spike_drop',
          text: 'SPIKE DROP ZONE: INCOMING MINES!',
          severity: 'danger',
          triggerable: true,
          triggerLabel: 'DROP MINES',
          shortLabel: 'MINES',
        });
      } else {
        alerts.push({
          id: 'spike_drop_ready',
          zoneId: 'spike_drop',
          text: 'SPIKE DROP ZONE — TAP DROP MINES!',
          severity: 'info',
          triggerable: true,
          triggerLabel: 'DROP MINES',
          shortLabel: 'MINES',
        });
      }
    }

    // Train Crossing alert
    if (Math.hypot(px - 0, pz - (-150)) <= 32) {
      const bUpstream = px - (trains[0].x + trains[0].halfL);
      const yUpstream = (trains[1].x - trains[1].halfL) - px;
      const incoming = (bUpstream >= -36 && bUpstream <= 62) || (yUpstream >= -36 && yUpstream <= 62);
      if (incoming) {
        alerts.push({
          id: 'train_incoming',
          zoneId: 'train_crossing',
          text: 'TRAIN APPROACHING! CLEAR THE TRACKS!',
          severity: 'danger',
          triggerable: true,
          triggerLabel: 'SUMMON TRAIN',
          shortLabel: 'TRAIN',
        });
      } else {
        alerts.push({
          id: 'train_ready',
          zoneId: 'train_crossing',
          text: 'RAILROAD CROSSING — TAP SUMMON TRAIN!',
          severity: 'info',
          triggerable: true,
          triggerLabel: 'SUMMON TRAIN',
          shortLabel: 'TRAIN',
        });
      }
    }

    return alerts;
  };

  const resetBreakables = () => {
    pressState.phase = 'IDLE';
    pressState.timer = 0;
    pressState.cycleCount = 0;
    pressState.mode = 'top';
    pressState.plateBottomY = 6.20;
    pressState.jawInnerOffset = 4.50;
    pressState.hitsThisCycle = 0;
    pressState.hitCooldown = 0;
    syncPressVisuals(simTime);

    nailState.phase = 'READY';
    nailState.timer = 0;
    nailState.theta = NAIL_READY_THETA;
    nailState.hitThisSwing = false;
    nailPivot.rotation.x = -NAIL_READY_THETA;

    giantState.phase = 'READY';
    giantState.timer = 0;
    giantState.bottomY = GIANT_REST_Y;
    giantState.velY = 0;
    giantState.hitThisDrop = false;
    syncGiantVisuals();

    spikeState.phase = 'LOADED';
    spikeState.timer = 0;
    spikeState.hitsThisDrop = 0;
    spikeState.globalHitCd = 0;
    hopperDoorL.rotation.z = 0;
    hopperDoorR.rotation.z = 0;
    for (let i = 0; i < MINE_COUNT; i += 1) {
      const m = mines[i];
      m.x = m.homeX;
      m.y = m.homeY;
      m.z = m.homeZ;
      m.vx = 0;
      m.vy = 0;
      m.vz = 0;
      m.released = false;
      m.hitCd = 0;
    }
    syncMineInstances();

    bayHitCounts.red = 0;
    bayHitCounts.green = 0;
    bayHitCounts.orange = 0;
    localCooldowns.clear();
  };

  const getMachineStates = () => ({
    hydraulicPress: {
      phase: pressState.phase,
      mode: pressState.mode,
      plateBottomY: pressState.plateBottomY,
      jawInnerOffset: pressState.jawInnerOffset,
    },
    wreckingBalls: wbBalls.map((b) => ({ x: b.wx, y: b.wy, z: b.wz, theta: b.theta })),
    spinningHammers: spinPosts.map((p) => ({ x: p.x, z: p.z, angle: p.angle })),
    nailHammer: { phase: nailState.phase, theta: nailState.theta },
    giantHammer: { phase: giantState.phase, bottomY: giantState.bottomY },
    spikeDrop: { phase: spikeState.phase, hits: spikeState.hitsThisDrop },
    trains: trains.map((tr) => ({
      name: tr.name,
      x: tr.x,
      speed: tr.speed,
      visibleCarXs: tr.cars.filter((c) => c.mesh.visible).map((c) => tr.x + c.localX),
    })),
    shredder: {
      greenAngle: vRollers[4].angle,
      orangeAngle: orangeDrum.angle,
    },
  });

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
    surfaceRegions: [ORANGE_SHREDDER_SURFACE_REGION],
    update,
    queryHazards,
    getGroundHeight: getOrangeChuteHeight,
    getSlopeNormal: getOrangeChuteNormal,
    triggerNearestMachine,
    triggerZoneMachine,
    getManualTriggerSpots: () => triggerZoneMeta,
    getActiveAlerts,
    resetBreakables,
    resetMachines: resetBreakables,
    getMachineStates,
    dispose,
  };
}
