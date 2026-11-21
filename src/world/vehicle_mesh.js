/**
 * Modular 12-Vehicle 3D Builder with Detachable/Hinged Parts, Progressive
 * Deformation, Tuk-Tuk 5 Cockpit Bulbs, and Center-of-Mass Debris Cloning
 * (Contract #11).
 *
 * Coordinate convention (shared with vehicles.js, zones.js, camera.js, M2A/M2B/M3):
 *   - Origin (0, 0, 0) rests at ground contact center (y = 0.000 = bottom of tires).
 *   - Local +Z = FRONT (nose/headlights), -Z = REAR (trunk/taillights),
 *     +Y = UP, +X = VEHICLE LEFT.
 *   - WebKit Guardrails 1 & 2: zero renderer.compile, 100% createStandardMaterial
 *     with metalness <= 0.20, enforceMaterialGuardrails(root) on non-IBL scenes,
 *     borrowed textures from textures.js are NEVER mutated or disposed.
 */

import * as THREE from '../../vendor/three.module.min.js';
import { createStandardMaterial, enforceMaterialGuardrails } from '../core/materials.js';
import { getVehicleById } from '../data/vehicles.js';

const hasOwn = Object.prototype.hasOwnProperty;

const BODY_TYPE_TO_BUILDER = {
  sedan: 'sedan',
  hatchback: 'compact',
  compact: 'compact',
  van: 'van',
  box_truck: 'box_truck',
  semi: 'semi_truck',
  semi_truck: 'semi_truck',
  bus: 'school_bus',
  school_bus: 'school_bus',
  tuk_tuk: 'tuk_tuk',
  micro: 'smart_micro',
  smart_micro: 'smart_micro',
  pickup: 'pickup',
  beetle: 'beetle',
  monster: 'monster_truck',
  monster_truck: 'monster_truck',
  rally: 'rally_raider',
  rally_raider: 'rally_raider',
};

const SCORCH_COLOR = new THREE.Color(0x1f1d1b);
const GLASS_INTACT_COLOR = new THREE.Color(0x9fd7ff);
const GLASS_CRACKED_COLOR = new THREE.Color(0xdce8f2);

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

function clamp01(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function parseColorSafe(input, fallbackHex) {
  const out = new THREE.Color();
  const tryApply = (val) => {
    if (val === null || val === undefined || val === '') return false;
    if (val instanceof THREE.Color) {
      out.copy(val);
      return Number.isFinite(out.r) && Number.isFinite(out.g) && Number.isFinite(out.b);
    }
    if (typeof val === 'number' && Number.isFinite(val)) {
      out.setHex(val >>> 0);
      return true;
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
        out.set(trimmed);
        return true;
      }
      if (/^0x[0-9a-fA-F]{6}$/.test(trimmed)) {
        out.setHex(parseInt(trimmed, 16));
        return true;
      }
    }
    return false;
  };
  if (tryApply(input)) return out;
  if (tryApply(fallbackHex)) return out;
  out.set('#e53935');
  return out;
}

function resolveVec3Array(val, fallback) {
  if (Array.isArray(val) && val.length >= 3) {
    const x = Number(val[0]);
    const y = Number(val[1]);
    const z = Number(val[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      return [x, y, z];
    }
  }
  return [fallback[0], fallback[1], fallback[2]];
}

function resolveVehicleSpec(vehicleDef) {
  let raw = vehicleDef;
  if (typeof raw === 'string') {
    raw = getVehicleById(raw);
  }
  if (!raw || typeof raw !== 'object') {
    raw = getVehicleById('sedan');
  }

  // Resolve fallback catalog entry by id or bodyType
  let base = getVehicleById(typeof raw.id === 'string' ? raw.id : 'sedan');
  if (
    typeof raw.id !== 'string'
    || (base.id === 'sedan' && raw.id !== 'sedan' && typeof raw.bodyType === 'string')
  ) {
    const mappedId = BODY_TYPE_TO_BUILDER[String(raw.bodyType || '').toLowerCase()];
    if (mappedId) base = getVehicleById(mappedId);
  }

  const dims = raw.dimensions && typeof raw.dimensions === 'object' ? raw.dimensions : {};
  const w = Number.isFinite(Number(dims.w)) && Number(dims.w) > 0.2 ? Number(dims.w) : base.dimensions.w;
  const h = Number.isFinite(Number(dims.h)) && Number(dims.h) > 0.2 ? Number(dims.h) : base.dimensions.h;
  const l = Number.isFinite(Number(dims.l)) && Number(dims.l) > 0.5 ? Number(dims.l) : base.dimensions.l;
  const wheelRadius = Number.isFinite(Number(raw.wheelRadius)) && Number(raw.wheelRadius) > 0.05
    ? Number(raw.wheelRadius)
    : base.wheelRadius;
  const wheelCount = Number.isFinite(Number(raw.wheelCount)) && Number(raw.wheelCount) >= 3
    ? Math.round(Number(raw.wheelCount))
    : base.wheelCount;

  const bodyTypeRaw = String(raw.bodyType || base.bodyType || 'sedan').toLowerCase();
  const idRaw = String(raw.id || base.id || 'sedan').toLowerCase();
  const builderKey = BODY_TYPE_TO_BUILDER[bodyTypeRaw] || BODY_TYPE_TO_BUILDER[idRaw] || 'sedan';

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : base.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : base.name,
    bodyType: bodyTypeRaw,
    builderKey,
    defaultColor: raw.defaultColor || base.defaultColor || '#e53935',
    dimensions: { w, h, l },
    wheelRadius,
    wheelCount,
    seatOffset: resolveVec3Array(raw.seatOffset, base.seatOffset),
    cockpitOffset: resolveVec3Array(raw.cockpitOffset, base.cockpitOffset),
    defaultPlate: typeof raw.defaultPlate === 'string' && raw.defaultPlate.trim()
      ? raw.defaultPlate.trim()
      : (base.defaultPlate || 'RCD 247'),
    hasCockpitBulbs: Boolean(raw.hasCockpitBulbs ?? base.hasCockpitBulbs ?? (builderKey === 'tuk_tuk')),
    liveryNumber: typeof raw.liveryNumber === 'string'
      ? raw.liveryNumber
      : (base.liveryNumber || (builderKey === 'rally_raider' ? '101' : '')),
  };
}

function cloneStandaloneSubtree(sourceObj) {
  const clone = sourceObj.clone(true);
  clone.traverse((node) => {
    if (!node.isMesh) return;
    if (node.geometry && typeof node.geometry.clone === 'function') {
      node.geometry = node.geometry.clone();
    }
    if (Array.isArray(node.material)) {
      node.material = node.material.map((m) => (m && typeof m.clone === 'function' ? m.clone() : m));
    } else if (node.material && typeof node.material.clone === 'function') {
      node.material = node.material.clone();
    }
  });
  return clone;
}

/**
 * Builds a complete, modular, deformable 3D Roblox vehicle for any of the 12
 * catalog vehicles (Contract #11).
 *
 * @param {object|string|null} vehicleDef
 * @param {string|number|THREE.Color|null} [colorHex]
 * @param {object|null} [textures]
 * @param {THREE.Scene|null} [scene]
 */
export function createVehicleVisual(vehicleDef, colorHex, textures = null, scene = null) {
  const def = resolveVehicleSpec(vehicleDef);
  const targetScene = scene || null;
  const basePaintColor = parseColorSafe(colorHex, def.defaultColor);
  const plateCode = def.defaultPlate;

  const ownedGeoms = [];
  const ownedMats = [];
  const ownedTextures = [];
  const paintMaterials = [];
  const headlights = [];
  const taillights = [];
  const auxLightMaterials = [];
  const cockpitBulbMaterials = [];
  const wheels = [];
  const partsMap = {};
  const partMeta = new Map();

  let steeringControlObj = null;
  let steeringControlAxis = 'z';
  let steeringControlSign = -1.35;

  const trackGeom = (geo) => {
    ownedGeoms.push(geo);
    return geo;
  };
  const makeMat = (params, isPaint = false) => {
    const mat = createStandardMaterial(params, targetScene);
    ownedMats.push(mat);
    if (isPaint) paintMaterials.push(mat);
    return mat;
  };

  // Core shared PBR material palette (ALL metalness strictly <= 0.20!)
  const paintMat = makeMat({
    name: `${def.id}_paint`,
    color: basePaintColor.clone(),
    roughness: 0.36,
    metalness: 0.14,
  }, true);

  const paintAccentMat = makeMat({
    name: `${def.id}_paint_accent`,
    color: basePaintColor.clone(),
    roughness: 0.42,
    metalness: 0.12,
  }, true);

  const trimDarkMat = makeMat({
    name: `${def.id}_trim_dark`,
    color: 0x22272e,
    roughness: 0.72,
    metalness: 0.08,
  });

  const chassisMat = makeMat({
    name: `${def.id}_chassis`,
    color: 0x1a1e24,
    roughness: 0.78,
    metalness: 0.10,
  });

  const chromeMat = makeMat({
    name: `${def.id}_chrome`,
    color: 0xd9e1e8,
    roughness: 0.26,
    metalness: 0.20,
  });

  const tireMat = makeMat({
    name: `${def.id}_tire`,
    color: 0x1f242b,
    roughness: 0.88,
    metalness: 0.04,
  });

  const rimMat = makeMat({
    name: `${def.id}_rim`,
    color: 0xcbd5e1,
    roughness: 0.30,
    metalness: 0.20,
  });

  const interiorMat = makeMat({
    name: `${def.id}_interior`,
    color: 0x374151,
    roughness: 0.82,
    metalness: 0.04,
  });

  const seatMat = makeMat({
    name: `${def.id}_seat`,
    color: 0x475569,
    roughness: 0.80,
    metalness: 0.04,
  });

  const glassMat = makeMat({
    name: `${def.id}_glass`,
    color: GLASS_INTACT_COLOR.clone(),
    roughness: 0.16,
    metalness: 0.12,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const darkGlassMat = makeMat({
    name: `${def.id}_dark_glass`,
    color: 0x1e293b,
    roughness: 0.18,
    metalness: 0.14,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const crackMat = makeMat({
    name: `${def.id}_crack`,
    color: 0xe2e8f0,
    roughness: 0.65,
    metalness: 0.04,
    transparent: true,
    opacity: 0.90,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const headlightMat = makeMat({
    name: `${def.id}_headlight`,
    color: 0xfffde7,
    emissive: 0xfff59d,
    emissiveIntensity: 0.88,
    roughness: 0.20,
    metalness: 0.08,
  });

  const taillightMat = makeMat({
    name: `${def.id}_taillight`,
    color: 0xd32f2f,
    emissive: 0xff1744,
    emissiveIntensity: 0.78,
    roughness: 0.24,
    metalness: 0.08,
  });

  const amberMat = makeMat({
    name: `${def.id}_amber`,
    color: 0xffb300,
    emissive: 0xff9100,
    emissiveIntensity: 0.65,
    roughness: 0.28,
    metalness: 0.08,
  });
  auxLightMaterials.push(amberMat);

  // Borrowed textures from textures.js (NEVER disposed here!)
  const plateTex = textures && typeof textures.makePlateTexture === 'function'
    ? textures.makePlateTexture(plateCode)
    : null;
  const plateMat = makeMat({
    name: `${def.id}_plate`,
    color: plateTex ? 0xffffff : 0xf1f5f9,
    map: plateTex || null,
    roughness: 0.48,
    metalness: 0.05,
  });

  // Root & structural groups (NOT added to scene; caller mounts visual.root)
  const root = new THREE.Group();
  root.name = `vehicle_${def.id}`;
  root.userData.vehicleId = def.id;

  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'bodyGroup';
  root.add(bodyGroup);

  const pillarsGroup = new THREE.Group();
  pillarsGroup.name = 'pillarsGroup';
  bodyGroup.add(pillarsGroup);

  const wheelsGroup = new THREE.Group();
  wheelsGroup.name = 'wheelsGroup';
  root.add(wheelsGroup);

  // Geometry helpers
  const addBox = (parent, w, h, d, mat, pos = [0, 0, 0], rot = null, opts = {}) => {
    const mesh = new THREE.Mesh(trackGeom(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
    mesh.castShadow = opts.castShadow ?? true;
    mesh.receiveShadow = opts.receiveShadow ?? true;
    if (opts.name) mesh.name = opts.name;
    parent.add(mesh);
    return mesh;
  };

  const addCyl = (parent, rTop, rBot, len, segs, mat, pos = [0, 0, 0], rot = null, opts = {}) => {
    const mesh = new THREE.Mesh(trackGeom(new THREE.CylinderGeometry(rTop, rBot, len, segs)), mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
    mesh.castShadow = opts.castShadow ?? true;
    mesh.receiveShadow = opts.receiveShadow ?? true;
    if (opts.name) mesh.name = opts.name;
    parent.add(mesh);
    return mesh;
  };

  const addPlate = (parent, pos, isRear, customMat = null, scaleW = 0.44, scaleH = 0.21) => {
    const mesh = new THREE.Mesh(
      trackGeom(new THREE.PlaneGeometry(scaleW, scaleH)),
      customMat || plateMat,
    );
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.y = isRear ? Math.PI : 0;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = isRear ? 'plate_rear' : 'plate_front';
    parent.add(mesh);
    return mesh;
  };

  const addHeadlight = (parent, w, h, d, pos, round = false) => {
    const geo = round
      ? trackGeom(new THREE.CylinderGeometry(w * 0.5, w * 0.5, d, 12))
      : trackGeom(new THREE.BoxGeometry(w, h, d));
    const mesh = new THREE.Mesh(geo, headlightMat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    if (round) mesh.rotation.x = Math.PI / 2;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = 'headlight_lens';
    parent.add(mesh);
    headlights.push(mesh);
    return mesh;
  };

  const addTaillight = (parent, w, h, d, pos) => {
    const mesh = new THREE.Mesh(trackGeom(new THREE.BoxGeometry(w, h, d)), taillightMat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = 'taillight_lens';
    parent.add(mesh);
    taillights.push(mesh);
    return mesh;
  };

  const registerPart = (key, mesh, threshold, meta = {}) => {
    mesh.name = `part_${key}`;
    const homePos = mesh.position.clone();
    const homeRot = mesh.rotation.clone();
    partsMap[key] = {
      key,
      mesh,
      homePos,
      homeRot,
      state: 'intact',
      threshold,
    };

    // Capture exact mesh-local bounds for front/rear bumpers so syncTransforms()
    // can enforce an analytical ground-clearance floor clamp under any crush/skew/loosen pose.
    let localBounds = null;
    if (meta.zone === 'front' || meta.zone === 'rear') {
      const savedP = mesh.position.clone();
      const savedR = mesh.rotation.clone();
      const savedS = mesh.scale.clone();
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      mesh.scale.set(1, 1, 1);
      mesh.updateMatrixWorld(true);
      const lb = new THREE.Box3().setFromObject(mesh);
      mesh.position.copy(savedP);
      mesh.rotation.copy(savedR);
      mesh.scale.copy(savedS);
      mesh.updateMatrixWorld(true);
      if (!lb.isEmpty()) {
        localBounds = {
          minX: lb.min.x,
          maxX: lb.max.x,
          minY: lb.min.y,
          maxY: lb.max.y,
          minZ: lb.min.z,
          maxZ: lb.max.z,
        };
      }
    }

    partMeta.set(key, {
      loosenPos: meta.loosenPos || [0, 0, 0],
      loosenRot: meta.loosenRot || [0, 0, 0],
      zone: meta.zone || 'body',
      isWheel: Boolean(meta.isWheel),
      wheelSide: meta.wheelSide || 0,
      wheelRadius: meta.wheelRadius || def.wheelRadius,
      tireW: meta.tireW || 0.26,
      cabinH: meta.cabinH || 0.65,
      localBounds,
    });
    return mesh;
  };

  // Exact geometry-aligned pillar bridging (botY, botZ) -> (topY, topZ)
  const addBridgingPillar = (parent, x, wX, dZ, mat, botY, botZ, topY, topZ, opts = {}) => {
    const dy = topY - botY;
    const dz = topZ - botZ;
    const len = Math.hypot(dy, dz);
    const rx = Math.atan2(dz, dy);
    return addBox(
      parent,
      wX,
      len + 0.03,
      dZ,
      mat,
      [x, (botY + topY) * 0.5, (botZ + topZ) * 0.5],
      [rx, 0, 0],
      opts,
    );
  };

  // Shared interior builder (open cabin: low floor, dashboard well below cockpitOffset,
  // steering wheel, front seat back — zero occlusion of cockpitOffset!)
  const buildCabinInterior = (w, floorY, dashZ, seatPos, roofY, hasSteeringWheel = true) => {
    const innerW = Math.max(0.7, w - 0.24);
    const dashTopY = Math.min(def.cockpitOffset[1] - 0.24, floorY + 0.52);
    const dashH = Math.max(0.18, dashTopY - floorY);
    addBox(bodyGroup, innerW, dashH, 0.30, interiorMat, [0, floorY + dashH * 0.5, dashZ], null, { name: 'dashboard' });

    // Seat cushion & seat back at seatOffset
    addBox(bodyGroup, Math.min(innerW * 0.72, 1.15), 0.12, 0.44, seatMat, [seatPos[0], seatPos[1] - 0.06, seatPos[2]], null, { name: 'seat_base' });
    addBox(bodyGroup, Math.min(innerW * 0.72, 1.15), 0.46, 0.11, seatMat, [seatPos[0], seatPos[1] + 0.22, seatPos[2] - 0.22], [-0.14, 0, 0], { name: 'seat_back' });

    if (hasSteeringWheel) {
      const wheelPivot = new THREE.Group();
      wheelPivot.name = 'steering_wheel';
      wheelPivot.position.set(seatPos[0], Math.min(dashTopY + 0.02, seatPos[1] + 0.28), dashZ - 0.18);
      wheelPivot.rotation.x = 0.42;
      bodyGroup.add(wheelPivot);

      addCyl(wheelPivot, 0.025, 0.025, 0.20, 8, trimDarkMat, [0, 0, 0.09], [Math.PI / 2, 0, 0], { castShadow: false });
      const rim = new THREE.Mesh(
        trackGeom(new THREE.TorusGeometry(0.16, 0.024, 8, 16)),
        trimDarkMat,
      );
      rim.castShadow = false;
      wheelPivot.add(rim);
      addBox(wheelPivot, 0.28, 0.032, 0.025, chromeMat, [0, 0, 0], null, { castShadow: false });

      steeringControlObj = wheelPivot;
      steeringControlAxis = 'z';
      steeringControlSign = -1.35;
    }

    // Store ceiling margin reference
    return { roofY };
  };

  // Windshield placement calculator & builder with dark spiderweb crack overlay
  // and strict cockpit near-plane guard (>= 0.38 m ahead of cockpitOffset[2]).
  const computeWindshieldPlacement = (height, centerY, desiredZ, tiltRad) => {
    const halfH = height * 0.5;
    const sinT = Math.sin(tiltRad);
    const cosT = Math.cos(tiltRad);
    const halfTiltBack = Math.abs(sinT) * halfH + 0.028;
    const minCenterZ = def.cockpitOffset[2] + 0.388 + halfTiltBack;
    const finalZ = Math.max(desiredZ, minCenterZ);
    return {
      finalZ,
      wsTopZ: finalZ + halfH * sinT,
      wsBotZ: finalZ - halfH * sinT,
      wsTopY: centerY + halfH * cosT,
      wsBotY: centerY - halfH * cosT,
    };
  };

  let crackOverlayGroup = null;
  const buildWindshieldPart = (width, height, centerY, desiredZ, tiltRad, threshold = 0.34, frameMat = trimDarkMat) => {
    const ws = computeWindshieldPlacement(height, centerY, desiredZ, tiltRad);
    const finalZ = ws.finalZ;

    const wsGroup = new THREE.Group();
    wsGroup.position.set(0, centerY, finalZ);
    wsGroup.rotation.set(tiltRad, 0, 0);
    bodyGroup.add(wsGroup);

    // Translucent glass pane (castShadow = false, depthWrite = false)
    addBox(wsGroup, width, height, 0.024, glassMat, [0, 0, 0], null, {
      castShadow: false,
      receiveShadow: false,
      name: 'windshield_pane',
    });
    // Perimeter slim gasket frame
    addBox(wsGroup, width + 0.04, 0.04, 0.04, frameMat, [0, height * 0.5, 0], null, { castShadow: false });
    addBox(wsGroup, width + 0.04, 0.04, 0.04, frameMat, [0, -height * 0.5, 0], null, { castShadow: false });

    // Spiderweb crack strips (hidden intact, revealed when damaged or loosened)
    const cracks = new THREE.Group();
    cracks.name = 'windshield_cracks';
    cracks.visible = false;
    wsGroup.add(cracks);
    const crackSpecs = [
      [0.0, 0.02, 0.016, width * 0.58, 0.022, 0.42],
      [-0.08, -0.02, 0.016, width * 0.46, 0.020, -0.58],
      [0.14, 0.05, 0.016, width * 0.36, 0.018, 1.05],
      [-0.18, 0.06, 0.016, width * 0.32, 0.018, -1.12],
      [0.04, -0.05, 0.016, width * 0.42, 0.016, 0.14],
    ];
    for (let i = 0; i < crackSpecs.length; i += 1) {
      const [cx, cy, cz, clen, cw, rz] = crackSpecs[i];
      addBox(cracks, clen, cw, 0.008, crackMat, [cx, cy, cz], [0, 0, rz], {
        castShadow: false,
        receiveShadow: false,
      });
    }
    crackOverlayGroup = cracks;

    registerPart('windshield', wsGroup, threshold, {
      loosenPos: [0, 0.04, 0.05],
      loosenRot: [-0.12, 0.06, 0.08],
      zone: 'windshield',
    });
    return { wsGroup, ...ws };
  };

  // Front-hinged outward "bird style" door builder
  // Pivot at front pillar (sideSign * halfW, doorY, frontZ); door panel extends REARWARD along -Z.
  // doorL (+X): rotY = -0.82 swings outward +X. doorR (-X): rotY = +0.82 swings outward -X.
  const buildHingedDoor = (key, sideSign, hingeX, centerY, frontZ, doorLen, doorH, mat, threshold, extraFn = null) => {
    const doorPivot = new THREE.Group();
    doorPivot.position.set(sideSign * hingeX, centerY, frontZ);
    bodyGroup.add(doorPivot);

    const thick = 0.08;
    // Lower solid door panel extending rearward (-Z)
    addBox(doorPivot, thick, doorH, doorLen, mat, [0, 0, -doorLen * 0.5], null, { name: `${key}_panel` });
    // Door handle
    addBox(
      doorPivot,
      0.032,
      0.04,
      0.16,
      trimDarkMat,
      [sideSign * (thick * 0.5 + 0.014), doorH * 0.24, -doorLen * 0.72],
      null,
      { castShadow: false },
    );
    // Side wing mirror mounted near front corner
    addBox(
      doorPivot,
      0.14,
      0.09,
      0.10,
      trimDarkMat,
      [sideSign * (thick * 0.5 + 0.08), doorH * 0.48, -0.14],
      null,
      { castShadow: false },
    );

    if (typeof extraFn === 'function') {
      extraFn(doorPivot, sideSign, thick, doorLen, doorH);
    }

    registerPart(key, doorPivot, threshold, {
      loosenPos: [sideSign * 0.03, -0.02, 0],
      loosenRot: [0.04, sideSign > 0 ? -0.82 : 0.82, sideSign * 0.05],
      zone: sideSign > 0 ? 'doorL' : 'doorR',
    });
    return doorPivot;
  };

  // Shared 16-segment wheel geometry cache (exact y = 0.000 grounding!)
  const wheelGeomCache = new Map();
  const getTireGeom = (r, w) => {
    const k = `t_${r.toFixed(4)}_${w.toFixed(4)}`;
    if (!wheelGeomCache.has(k)) {
      const geo = trackGeom(new THREE.CylinderGeometry(r, r, w, 16));
      geo.rotateZ(Math.PI / 2);
      wheelGeomCache.set(k, geo);
    }
    return wheelGeomCache.get(k);
  };
  const getRimGeom = (r, w) => {
    const k = `r_${r.toFixed(4)}_${w.toFixed(4)}`;
    if (!wheelGeomCache.has(k)) {
      const geo = trackGeom(new THREE.CylinderGeometry(r, r, w, 12));
      geo.rotateZ(Math.PI / 2);
      wheelGeomCache.set(k, geo);
    }
    return wheelGeomCache.get(k);
  };

  const buildSingleWheelAssembly = (radius, tireW, isMonster = false, hubChrome = false) => {
    const spinGroup = new THREE.Group();
    spinGroup.name = 'wheel_spin';

    const rCore = isMonster ? Math.max(0.1, radius - 0.045) : radius;
    const tireMesh = new THREE.Mesh(getTireGeom(rCore, tireW), tireMat);
    tireMesh.castShadow = true;
    tireMesh.receiveShadow = true;
    spinGroup.add(tireMesh);

    const rimR = rCore * (isMonster ? 0.46 : 0.56);
    const rimMesh = new THREE.Mesh(
      getRimGeom(rimR, tireW + 0.014),
      hubChrome ? chromeMat : rimMat,
    );
    rimMesh.castShadow = false;
    rimMesh.receiveShadow = true;
    spinGroup.add(rimMesh);

    // 5-spoke / cross wheel spokes for unmistakable spinning motion
    const spokeLen = rimR * 1.65;
    const spokeT = Math.max(0.035, rimR * 0.19);
    const spoke1 = new THREE.Mesh(
      trackGeom(new THREE.BoxGeometry(tireW + 0.024, spokeLen, spokeT)),
      trimDarkMat,
    );
    const spoke2 = new THREE.Mesh(
      trackGeom(new THREE.BoxGeometry(tireW + 0.024, spokeT, spokeLen)),
      trimDarkMat,
    );
    spoke1.castShadow = false;
    spoke2.castShadow = false;
    spinGroup.add(spoke1, spoke2);

    // Monster truck 12 radial chunky tread lugs (divisible by 4 -> exact bottom at -radius!)
    if (isMonster) {
      const lugH = 0.045;
      const lugLen = 0.11;
      const lugW = tireW * 0.94;
      const lugGeo = trackGeom(new THREE.BoxGeometry(lugW, lugH, lugLen));
      const lugDist = rCore + lugH * 0.5; // 0.815 + 0.0225 = 0.8375 -> outer = 0.860 exact!
      for (let i = 0; i < 12; i += 1) {
        const theta = (i * Math.PI * 2) / 12;
        const lug = new THREE.Mesh(lugGeo, tireMat);
        lug.position.set(0, Math.cos(theta) * lugDist, Math.sin(theta) * lugDist);
        lug.rotation.x = theta;
        lug.castShadow = false;
        lug.receiveShadow = true;
        spinGroup.add(lug);
      }
    }

    return spinGroup;
  };

  const addWheelPart = ({
    key,
    x,
    z,
    radius,
    tireW,
    side,
    isFront,
    isRear,
    steerFactor,
    threshold,
    isMonster = false,
    hubChrome = false,
    tandemOffsetZ = 0,
  }) => {
    const partGroup = new THREE.Group();
    partGroup.position.set(x, radius, z);
    wheelsGroup.add(partGroup);

    const offsets = tandemOffsetZ > 0 ? [+tandemOffsetZ, -tandemOffsetZ] : [0];
    for (let i = 0; i < offsets.length; i += 1) {
      const steerPivot = new THREE.Group();
      steerPivot.name = `${key}_steer_${i}`;
      steerPivot.position.set(0, 0, offsets[i]);
      partGroup.add(steerPivot);

      const spinGroup = buildSingleWheelAssembly(radius, tireW, isMonster, hubChrome);
      steerPivot.add(spinGroup);

      wheels.push({
        partKey: key,
        group: partGroup,
        steerPivot,
        spinGroup,
        radius,
        side,
        isFront,
        isRear,
        steerFactor,
        homePos: partGroup.position.clone(),
      });
    }

    const tiltSign = side === 0 ? 1 : side;
    const safeLiftY = tireW * 0.22;
    registerPart(key, partGroup, threshold, {
      loosenPos: [side * 0.08, safeLiftY, 0],
      loosenRot: [0, tiltSign * (isFront ? 0.18 : -0.14), tiltSign * 0.26],
      zone: 'wheel',
      isWheel: true,
      wheelSide: side,
      wheelRadius: radius,
      tireW,
    });
    return partGroup;
  };

  const addStandardFourWheels = ({
    x,
    zF,
    zR,
    radius,
    tireW,
    rearSteer = 0,
    isMonster = false,
    hubChrome = false,
    tandemRearOffsetZ = 0,
  }) => {
    addWheelPart({ key: 'wheelFL', x: +x, z: zF, radius, tireW, side: +1, isFront: true, isRear: false, steerFactor: 1.0, threshold: 0.74, isMonster, hubChrome });
    addWheelPart({ key: 'wheelFR', x: -x, z: zF, radius, tireW, side: -1, isFront: true, isRear: false, steerFactor: 1.0, threshold: 0.79, isMonster, hubChrome });
    addWheelPart({ key: 'wheelRL', x: +x, z: zR, radius, tireW, side: +1, isFront: false, isRear: true, steerFactor: rearSteer, threshold: 0.85, isMonster, hubChrome, tandemOffsetZ: tandemRearOffsetZ });
    addWheelPart({ key: 'wheelRR', x: -x, z: zR, radius, tireW, side: -1, isFront: false, isRear: true, steerFactor: rearSteer, threshold: 0.90, isMonster, hubChrome, tandemOffsetZ: tandemRearOffsetZ });
  };

  // =========================================================================
  // 12 DISTINCT SILHOUETTE BUILDERS (ALL +Z FRONT, y = 0.000 TIRE CONTACT)
  // =========================================================================

  const { w, h, l } = def.dimensions;
  const R = def.wheelRadius;
  let cabinHeightRef = Math.max(0.50, h * 0.42);

  const buildSedanLike = (variant) => {
    const isRally = variant === 'rally_raider';
    const isCompact = variant === 'compact';
    const y0 = isRally || isCompact ? 0.24 : 0.28;
    const beltY = isRally ? 0.84 : (isCompact ? 0.88 : 0.88);
    const roofY = h - 0.04;
    cabinHeightRef = roofY - beltY;
    const halfW = w * 0.5;
    const halfL = l * 0.5;
    const bodyW = w - 0.08;

    const wheelX = isRally ? 0.94 : (isCompact ? 0.86 : 0.92);
    const zF = isRally ? 1.36 : (isCompact ? 1.20 : 1.36);
    const zR = isRally ? -1.36 : (isCompact ? -1.24 : -1.36);
    const tireW = isRally ? 0.28 : (isCompact ? 0.24 : 0.26);

    addStandardFourWheels({ x: wheelX, zF, zR, radius: R, tireW });

    // Open-frame A/B/C pillars aligned seamlessly with windshield placement
    const cabinW = bodyW - 0.18;
    const pillarH = Math.max(0.36, roofY - beltY);
    const wsTilt = -0.34;
    const wsHeight = pillarH / Math.cos(wsTilt);
    const wsDesiredZ = isCompact ? 0.90 : (isRally ? 0.94 : 1.00);
    const ws = computeWindshieldPlacement(wsHeight, beltY + pillarH * 0.50, wsDesiredZ, wsTilt);

    // Lower chassis & rocker sills
    addBox(bodyGroup, bodyW - 0.08, 0.16, l - 0.34, chassisMat, [0, y0 + 0.08, 0], null, { name: 'chassis_core' });
    // Front engine bay & seamless cowl block supporting windshield base
    const cowlStartZ = isCompact ? 0.78 : 0.86;
    const frontCoreLen = Math.max(0.65, halfL - cowlStartZ - 0.12);
    addBox(bodyGroup, bodyW - 0.04, beltY - y0 - 0.06, frontCoreLen, paintMat, [0, y0 + (beltY - y0) * 0.5, cowlStartZ + frontCoreLen * 0.5], null, { name: 'front_body' });

    // Rear quarter body
    const rearCabinEndZ = isCompact ? -1.24 : -0.96;
    const rearCoreLen = Math.max(0.42, Math.abs(-halfL + 0.14 - rearCabinEndZ));
    addBox(bodyGroup, bodyW - 0.04, beltY - y0 - 0.06, rearCoreLen, paintMat, [0, y0 + (beltY - y0) * 0.5, rearCabinEndZ - rearCoreLen * 0.5], null, { name: 'rear_body' });

    // Side rockers & black lower trim skirts
    addBox(bodyGroup, 0.10, 0.18, l - 0.52, trimDarkMat, [halfW - 0.05, y0 + 0.09, 0], null, { name: 'skirt_l' });
    addBox(bodyGroup, 0.10, 0.18, l - 0.52, trimDarkMat, [-(halfW - 0.05), y0 + 0.09, 0], null, { name: 'skirt_r' });

    // Front grille + headlights + rear taillights
    addBox(bodyGroup, bodyW * 0.52, 0.24, 0.08, trimDarkMat, [0, y0 + 0.34, halfL - 0.08], null, { name: 'front_grille' });
    addHeadlight(bodyGroup, 0.36, 0.16, 0.08, [halfW - 0.32, y0 + 0.38, halfL - 0.07]);
    addHeadlight(bodyGroup, 0.36, 0.16, 0.08, [-(halfW - 0.32), y0 + 0.38, halfL - 0.07]);
    addTaillight(bodyGroup, 0.38, 0.16, 0.08, [halfW - 0.32, y0 + 0.42, -(halfL - 0.09)]);
    addTaillight(bodyGroup, 0.38, 0.16, 0.08, [-(halfW - 0.32), y0 + 0.42, -(halfL - 0.09)]);

    const cZ = isCompact ? -1.42 : -0.96;
    const bZ = -0.10;
    for (const sx of [1, -1]) {
      addBridgingPillar(pillarsGroup, sx * (cabinW * 0.5 - 0.04), 0.08, 0.08, paintMat, beltY, ws.wsBotZ, roofY, ws.wsTopZ);
      addBox(pillarsGroup, 0.08, pillarH, 0.09, trimDarkMat, [sx * (cabinW * 0.5 - 0.04), beltY + pillarH * 0.5, bZ]);
      addBox(pillarsGroup, 0.10, pillarH, 0.12, paintMat, [sx * (cabinW * 0.5 - 0.04), beltY + pillarH * 0.5, cZ], [isCompact ? 0.16 : 0.28, 0, 0]);
    }
    // Rear window glass (except compact where rear glass lives on rear hatch)
    if (!isCompact) {
      addBox(pillarsGroup, cabinW - 0.14, pillarH * 0.86, 0.022, glassMat, [0, beltY + pillarH * 0.50, cZ - 0.12], [0.34, 0, 0], { castShadow: false, receiveShadow: false });
    }

    // Interior
    buildCabinInterior(bodyW, y0 + 0.14, ws.wsBotZ - 0.16, def.seatOffset, roofY, true);

    // Rally Raider signature competition details (#101 decals, wide black fender flares, 4-pod fog lights, hood vents, roof scoop, exhausts)
    const rallyNumTex = isRally && textures && typeof textures.makeNumberTexture === 'function'
      ? textures.makeNumberTexture(def.liveryNumber || '101', '#fdd835')
      : null;
    const rallyNumMat = isRally ? makeMat({
      name: 'rally_number_101',
      color: rallyNumTex ? 0xffffff : 0xfdd835,
      map: rallyNumTex || null,
      roughness: 0.42,
      metalness: 0.06,
    }) : null;

    if (isRally) {
      // Wide black wheel-arch fender flares
      for (const sx of [1, -1]) {
        addBox(bodyGroup, 0.14, 0.34, 0.96, trimDarkMat, [sx * (halfW - 0.02), y0 + 0.34, zF]);
        addBox(bodyGroup, 0.14, 0.34, 0.96, trimDarkMat, [sx * (halfW - 0.02), y0 + 0.34, zR]);
      }
      // Twin chrome exhaust pipes
      addCyl(bodyGroup, 0.045, 0.045, 0.24, 8, chromeMat, [0.46, y0 + 0.08, -(halfL - 0.04)], [Math.PI / 2, 0, 0], { castShadow: false });
      addCyl(bodyGroup, 0.045, 0.045, 0.24, 8, chromeMat, [-0.46, y0 + 0.08, -(halfL - 0.04)], [Math.PI / 2, 0, 0], { castShadow: false });
    }

    // --- DETACHABLE PART 1: frontBumper ---
    const frontBumper = new THREE.Group();
    frontBumper.position.set(0, y0 + 0.14, halfL - 0.02);
    bodyGroup.add(frontBumper);
    addBox(frontBumper, w - 0.02, 0.26, 0.20, isRally ? trimDarkMat : paintAccentMat, [0, 0, 0]);
    addBox(frontBumper, w - 0.18, 0.08, 0.06, trimDarkMat, [0, -0.05, 0.09], null, { castShadow: false });
    addPlate(frontBumper, [0, 0.0, 0.106], false);
    if (isRally) {
      // 4-pod rally fog light bar mounted on front bumper!
      addBox(frontBumper, 1.04, 0.06, 0.08, trimDarkMat, [0, 0.20, 0.05]);
      for (const fx of [-0.36, -0.12, 0.12, 0.36]) {
        addCyl(frontBumper, 0.085, 0.075, 0.10, 10, trimDarkMat, [fx, 0.25, 0.06], [Math.PI / 2, 0, 0], { castShadow: false });
        addHeadlight(frontBumper, 0.13, 0.13, 0.03, [fx, 0.25, 0.115], true);
      }
    }
    registerPart('frontBumper', frontBumper, 0.14, {
      loosenPos: [0, -0.04, 0.11],
      loosenRot: [0.10, 0.12, -0.09],
      zone: 'front',
    });

    // --- DETACHABLE PART 2: rearBumper ---
    const rearBumper = new THREE.Group();
    rearBumper.position.set(0, y0 + 0.15, -(halfL - 0.02));
    bodyGroup.add(rearBumper);
    addBox(rearBumper, w - 0.02, 0.26, 0.20, isRally ? trimDarkMat : paintAccentMat, [0, 0, 0]);
    addPlate(rearBumper, [0, 0.02, -0.106], true);
    registerPart('rearBumper', rearBumper, 0.18, {
      loosenPos: [0, -0.04, -0.10],
      loosenRot: [-0.10, -0.12, 0.09],
      zone: 'rear',
    });

    // --- DETACHABLE PART 3: hood (rear-hinged at windshield cowl, extends +Z) ---
    const hoodStartZ = ws.wsBotZ - 0.04;
    const hoodLen = Math.max(0.75, halfL - hoodStartZ - 0.06);
    const hood = new THREE.Group();
    hood.position.set(0, beltY, hoodStartZ);
    bodyGroup.add(hood);
    addBox(hood, bodyW - 0.06, 0.08, hoodLen, paintMat, [0, -0.02, hoodLen * 0.5]);
    if (isRally) {
      addBox(hood, 0.38, 0.018, hoodLen - 0.08, trimDarkMat, [0, 0.026, hoodLen * 0.5], null, { castShadow: false });
      addBox(hood, 0.28, 0.045, 0.26, trimDarkMat, [0, 0.042, hoodLen * 0.35], null, { castShadow: false });
      // #101 hood decal readable upright from chase camera behind car
      const hoodDecal = new THREE.Mesh(trackGeom(new THREE.PlaneGeometry(0.62, 0.62)), rallyNumMat);
      hoodDecal.position.set(0, 0.036, hoodLen * 0.62);
      hoodDecal.rotation.order = 'YXZ';
      hoodDecal.rotation.set(-Math.PI / 2, Math.PI, 0);
      hoodDecal.castShadow = false;
      hood.add(hoodDecal);
    }
    registerPart('hood', hood, 0.28, {
      loosenPos: [0, 0.04, 0.02],
      loosenRot: [-0.42, 0.06, 0.05],
      zone: 'hood',
    });

    // --- DETACHABLE PART 4: windshield ---
    buildWindshieldPart(cabinW - 0.10, wsHeight, beltY + pillarH * 0.50, wsDesiredZ, wsTilt, 0.34);

    // --- DETACHABLE PARTS 5 & 6: doorL & doorR (front-hinged outward "bird style") ---
    const doorFrontZ = isCompact ? 0.78 : 0.86;
    const doorLen = isCompact ? 1.64 : 1.74;
    const doorH = beltY - y0 - 0.08;
    const doorExtra = isRally ? (pivot, sx, thick, len) => {
      const decal = new THREE.Mesh(trackGeom(new THREE.PlaneGeometry(0.52, 0.44)), rallyNumMat);
      decal.position.set(sx * (thick * 0.5 + 0.008), 0.02, -len * 0.50);
      decal.rotation.y = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
      decal.castShadow = false;
      pivot.add(decal);
    } : null;
    buildHingedDoor('doorL', +1, halfW - 0.04, y0 + 0.06 + doorH * 0.5, doorFrontZ, doorLen, doorH, paintMat, 0.42, doorExtra);
    buildHingedDoor('doorR', -1, halfW - 0.04, y0 + 0.06 + doorH * 0.5, doorFrontZ, doorLen, doorH, paintMat, 0.46, doorExtra);

    // --- DETACHABLE PART 7: trunk / rear hatch (front-hinged, extends -Z -> rotX = +0.48 pops UP) ---
    const trunk = new THREE.Group();
    if (isCompact) {
      trunk.position.set(0, roofY - 0.02, -1.44);
      bodyGroup.add(trunk);
      const hatchH = roofY - y0 - 0.22;
      addBox(trunk, bodyW - 0.14, hatchH * 0.50, 0.10, paintMat, [0, -hatchH * 0.72, -0.28], [0.14, 0, 0]);
      addBox(trunk, cabinW - 0.16, hatchH * 0.48, 0.03, glassMat, [0, -hatchH * 0.24, -0.14], [0.22, 0, 0], { castShadow: false, receiveShadow: false });
    } else {
      const trunkLen = Math.max(0.70, Math.abs(-halfL + 0.12 - (-1.02)));
      trunk.position.set(0, beltY, -1.02);
      bodyGroup.add(trunk);
      addBox(trunk, bodyW - 0.10, 0.10, trunkLen, paintMat, [0, -0.02, -trunkLen * 0.5]);
      if (isRally) {
        // Tall iconic black/yellow rear wing spoiler mounted on trunk!
        addBox(trunk, 0.06, 0.34, 0.18, trimDarkMat, [0.58, 0.18, -trunkLen + 0.14]);
        addBox(trunk, 0.06, 0.34, 0.18, trimDarkMat, [-0.58, 0.18, -trunkLen + 0.14]);
        addBox(trunk, w - 0.08, 0.06, 0.34, trimDarkMat, [0, 0.36, -trunkLen + 0.10], [0.10, 0, 0]);
        addBox(trunk, 0.05, 0.18, 0.38, paintAccentMat, [halfW - 0.06, 0.36, -trunkLen + 0.10]);
        addBox(trunk, 0.05, 0.18, 0.38, paintAccentMat, [-(halfW - 0.06), 0.36, -trunkLen + 0.10]);
      }
    }
    registerPart('trunk', trunk, 0.54, {
      loosenPos: [0, 0.05, -0.04],
      loosenRot: [0.48, -0.06, 0.04],
      zone: 'trunk',
    });

    // --- DETACHABLE PART 8: roof (front edge aligned flush with windshield top) ---
    const roofRearZ = isCompact ? -1.43 : -1.02;
    const roofFrontZ = ws.wsTopZ + 0.02;
    const roofLen = roofFrontZ - roofRearZ;
    const roofZ = (roofFrontZ + roofRearZ) * 0.5;
    const roof = new THREE.Group();
    roof.position.set(0, roofY, roofZ);
    bodyGroup.add(roof);
    addBox(roof, cabinW, 0.08, roofLen, paintMat, [0, 0, 0]);
    if (isRally) {
      // Roof air scoop
      addBox(roof, 0.34, 0.10, 0.42, trimDarkMat, [0, 0.06, 0.36]);
    }
    registerPart('roof', roof, 0.64, {
      loosenPos: [0.04, -0.06, -0.02],
      loosenRot: [0.09, 0.06, 0.12],
      zone: 'roof',
      cabinH: cabinHeightRef,
    });
  };

  const buildVan = () => {
    const y0 = 0.34;
    const beltY = 1.24;
    const roofY = h - 0.05;
    cabinHeightRef = roofY - beltY;
    const halfW = w * 0.5;
    const halfL = l * 0.5;
    const bodyW = w - 0.06;

    addStandardFourWheels({ x: 0.98, zF: 1.58, zR: -1.52, radius: R, tireW: 0.30 });

    // Lower chassis & front nose block
    addBox(bodyGroup, bodyW - 0.10, 0.20, l - 0.30, chassisMat, [0, y0 + 0.10, 0]);
    addBox(bodyGroup, bodyW, beltY - y0, 0.92, paintMat, [0, y0 + (beltY - y0) * 0.5, halfL - 0.52]);

    // Full tall boxy commercial cargo sides (open cab front, full slab rear panels)
    const cargoLen = 3.25;
    const cargoZ = -0.88;
    addBox(bodyGroup, 0.12, roofY - y0 - 0.06, cargoLen, paintMat, [halfW - 0.06, y0 + (roofY - y0) * 0.5, cargoZ]);
    addBox(bodyGroup, 0.12, roofY - y0 - 0.06, cargoLen, paintMat, [-(halfW - 0.06), y0 + (roofY - y0) * 0.5, cargoZ]);
    // Dark horizontal side rub-strip & sliding-door groove
    addBox(bodyGroup, 0.04, 0.14, cargoLen + 0.4, trimDarkMat, [halfW + 0.005, y0 + 0.40, cargoZ + 0.1]);
    addBox(bodyGroup, 0.04, 0.14, cargoLen + 0.4, trimDarkMat, [-(halfW + 0.005), y0 + 0.40, cargoZ + 0.1]);
    addBox(bodyGroup, 0.03, 0.05, 1.35, trimDarkMat, [-(halfW + 0.01), beltY + 0.02, -0.35], null, { castShadow: false });
    // Cargo bulkhead behind front seat
    addBox(bodyGroup, bodyW - 0.24, roofY - y0 - 0.12, 0.10, interiorMat, [0, y0 + (roofY - y0) * 0.5, 0.32]);

    // Front grille & lights
    addBox(bodyGroup, bodyW * 0.56, 0.32, 0.08, trimDarkMat, [0, y0 + 0.44, halfL - 0.06]);
    addHeadlight(bodyGroup, 0.34, 0.24, 0.08, [halfW - 0.30, y0 + 0.48, halfL - 0.05]);
    addHeadlight(bodyGroup, 0.34, 0.24, 0.08, [-(halfW - 0.30), y0 + 0.48, halfL - 0.05]);
    addTaillight(bodyGroup, 0.20, 0.46, 0.08, [halfW - 0.16, y0 + 0.62, -(halfL - 0.06)]);
    addTaillight(bodyGroup, 0.20, 0.46, 0.08, [-(halfW - 0.16), y0 + 0.62, -(halfL - 0.06)]);

    // Front A-pillars aligned seamlessly with windshield placement
    const pillarH = roofY - beltY;
    const wsTilt = -0.18;
    const wsHeight = pillarH / Math.cos(wsTilt);
    const ws = computeWindshieldPlacement(wsHeight, beltY + pillarH * 0.50, 1.98, wsTilt);
    for (const sx of [1, -1]) {
      addBridgingPillar(pillarsGroup, sx * (halfW - 0.08), 0.10, 0.10, paintMat, beltY, ws.wsBotZ, roofY, ws.wsTopZ);
    }

    buildCabinInterior(bodyW, y0 + 0.16, ws.wsBotZ - 0.24, def.seatOffset, roofY, true);

    // 1. frontBumper
    const frontBumper = new THREE.Group();
    frontBumper.position.set(0, y0 + 0.16, halfL - 0.01);
    bodyGroup.add(frontBumper);
    addBox(frontBumper, w, 0.30, 0.22, trimDarkMat, [0, 0, 0]);
    addPlate(frontBumper, [0, 0.0, 0.115], false);
    registerPart('frontBumper', frontBumper, 0.14, { loosenPos: [0, -0.12, 0.10], loosenRot: [0.16, 0.14, -0.18], zone: 'front' });

    // 2. rearBumper
    const rearBumper = new THREE.Group();
    rearBumper.position.set(0, y0 + 0.16, -(halfL - 0.01));
    bodyGroup.add(rearBumper);
    addBox(rearBumper, w, 0.28, 0.22, trimDarkMat, [0, 0, 0]);
    addPlate(rearBumper, [0, 0.01, -0.115], true);
    registerPart('rearBumper', rearBumper, 0.18, { loosenPos: [0, -0.12, -0.10], loosenRot: [-0.16, -0.14, 0.16], zone: 'rear' });

    // 3. hood (short steep van hood meeting windshield base seamlessly)
    const hoodStartZ = ws.wsBotZ - 0.04;
    const hoodLen = Math.max(0.45, halfL - hoodStartZ - 0.06);
    const hood = new THREE.Group();
    hood.position.set(0, beltY, hoodStartZ);
    bodyGroup.add(hood);
    addBox(hood, bodyW - 0.06, 0.10, hoodLen, paintMat, [0, -0.04, hoodLen * 0.5], [0.18, 0, 0]);
    registerPart('hood', hood, 0.28, { loosenPos: [0, 0.04, 0.02], loosenRot: [-0.42, 0.05, 0.05], zone: 'hood' });

    // 4. windshield
    buildWindshieldPart(bodyW - 0.22, wsHeight, beltY + pillarH * 0.50, 1.98, wsTilt, 0.34);

    // 5 & 6. doorL & doorR
    buildHingedDoor('doorL', +1, halfW - 0.04, y0 + (beltY - y0) * 0.5, 1.72, 1.04, beltY - y0 - 0.06, paintMat, 0.42);
    buildHingedDoor('doorR', -1, halfW - 0.04, y0 + (beltY - y0) * 0.5, 1.72, 1.04, beltY - y0 - 0.06, paintMat, 0.46);

    // 7. trunk (twin rear barn doors)
    const trunk = new THREE.Group();
    trunk.position.set(0, roofY - 0.08, -(halfL - 0.08));
    bodyGroup.add(trunk);
    const rearDoorH = roofY - y0 - 0.26;
    addBox(trunk, bodyW - 0.18, rearDoorH, 0.10, paintMat, [0, -rearDoorH * 0.5, 0]);
    addBox(trunk, 0.04, rearDoorH - 0.10, 0.12, trimDarkMat, [0, -rearDoorH * 0.5, -0.01], null, { castShadow: false });
    addBox(trunk, bodyW * 0.34, 0.48, 0.04, darkGlassMat, [bodyW * 0.22, -0.34, -0.05], null, { castShadow: false });
    addBox(trunk, bodyW * 0.34, 0.48, 0.04, darkGlassMat, [-bodyW * 0.22, -0.34, -0.05], null, { castShadow: false });
    registerPart('trunk', trunk, 0.54, { loosenPos: [0, 0.06, -0.08], loosenRot: [0.46, -0.08, 0.05], zone: 'trunk' });

    // 8. roof (flat ribbed commercial roof aligned flush with windshield top)
    const roofRearZ = -2.53;
    const roofFrontZ = ws.wsTopZ + 0.02;
    const roofLen = roofFrontZ - roofRearZ;
    const roofZ = (roofFrontZ + roofRearZ) * 0.5;
    const roof = new THREE.Group();
    roof.position.set(0, roofY, roofZ);
    bodyGroup.add(roof);
    addBox(roof, bodyW - 0.04, 0.10, roofLen, paintMat, [0, 0, 0]);
    for (let rz = -1.6; rz <= 1.2; rz += 0.70) {
      addBox(roof, bodyW - 0.24, 0.04, 0.08, paintAccentMat, [0, 0.06, rz], null, { castShadow: false });
    }
    registerPart('roof', roof, 0.64, { loosenPos: [0.05, -0.06, 0], loosenRot: [0.08, 0.06, 0.11], zone: 'roof', cabinH: cabinHeightRef });
  };

  const buildBoxTruck = () => {
    const y0 = 0.44;
    const beltY = 1.66;
    const cabRoofY = 2.58;
    cabinHeightRef = cabRoofY - beltY;
    const halfW = w * 0.5;
    const halfL = l * 0.5;
    const cabW = 2.26;
    const cabHalfW = cabW * 0.5;

    // Non-recolorable crisp white 26 ft cargo box material (NEVER added to paintMaterials!)
    const cargoWhiteMat = makeMat({
      name: 'box_truck_cargo_white',
      color: 0xf4f6f8,
      roughness: 0.46,
      metalness: 0.06,
    }, false);

    addStandardFourWheels({ x: 1.06, zF: 2.38, zR: -1.95, radius: R, tireW: 0.38 });

    // Exposed heavy steel ladder frame rails
    addBox(bodyGroup, 0.16, 0.22, l - 0.40, chassisMat, [0.46, y0 + 0.24, -0.10]);
    addBox(bodyGroup, 0.16, 0.22, l - 0.40, chassisMat, [-0.46, y0 + 0.24, -0.10]);
    addBox(bodyGroup, 1.35, 0.16, 0.22, chassisMat, [0, y0 + 0.24, 0.40]);
    addBox(bodyGroup, 1.35, 0.16, 0.22, chassisMat, [0, y0 + 0.24, -2.90]);

    // Recolorable short-nose truck cab (z in [1.55, 3.60])
    addBox(bodyGroup, cabW, beltY - y0 - 0.14, 0.88, paintMat, [0, y0 + 0.14 + (beltY - y0 - 0.14) * 0.5, 3.10]);
    addBox(bodyGroup, cabW, cabRoofY - y0 - 0.14, 0.18, paintMat, [0, y0 + 0.14 + (cabRoofY - y0 - 0.14) * 0.5, 1.64]);
    addBox(bodyGroup, cabW - 0.10, 0.22, 1.95, chassisMat, [0, y0 + 0.20, 2.55]);

    // Cab A-pillars aligned seamlessly with windshield placement
    const pillarH = cabRoofY - beltY;
    const wsTilt = -0.14;
    const wsHeight = pillarH / Math.cos(wsTilt);
    const ws = computeWindshieldPlacement(wsHeight, beltY + pillarH * 0.50, 3.20, wsTilt);
    for (const sx of [1, -1]) {
      addBridgingPillar(pillarsGroup, sx * (cabHalfW - 0.07), 0.10, 0.10, paintMat, beltY, ws.wsBotZ, cabRoofY, ws.wsTopZ);
    }

    // Grille, headlights & taillights
    addBox(bodyGroup, cabW * 0.58, 0.44, 0.08, chromeMat, [0, y0 + 0.58, halfL - 0.10]);
    addHeadlight(bodyGroup, 0.34, 0.22, 0.08, [cabHalfW - 0.26, y0 + 0.52, halfL - 0.09]);
    addHeadlight(bodyGroup, 0.34, 0.22, 0.08, [-(cabHalfW - 0.26), y0 + 0.52, halfL - 0.09]);
    addTaillight(bodyGroup, 0.28, 0.14, 0.08, [halfW - 0.34, y0 + 0.32, -(halfL - 0.08)]);
    addTaillight(bodyGroup, 0.28, 0.14, 0.08, [-(halfW - 0.34), y0 + 0.32, -(halfL - 0.08)]);

    buildCabinInterior(cabW, y0 + 0.32, ws.wsBotZ - 0.24, def.seatOffset, cabRoofY, true);

    // 1. frontBumper
    const frontBumper = new THREE.Group();
    frontBumper.position.set(0, y0 + 0.20, halfL - 0.02);
    bodyGroup.add(frontBumper);
    addBox(frontBumper, cabW + 0.12, 0.30, 0.24, chromeMat, [0, 0, 0]);
    addPlate(frontBumper, [0, 0, 0.125], false);
    registerPart('frontBumper', frontBumper, 0.14, { loosenPos: [0, -0.12, 0.12], loosenRot: [0.16, 0.14, -0.18], zone: 'front' });

    // 2. rearBumper (rear steel step bar)
    const rearBumper = new THREE.Group();
    rearBumper.position.set(0, y0 + 0.14, -(halfL - 0.02));
    bodyGroup.add(rearBumper);
    addBox(rearBumper, w - 0.08, 0.24, 0.22, trimDarkMat, [0, 0, 0]);
    addPlate(rearBumper, [0, 0, -0.115], true);
    registerPart('rearBumper', rearBumper, 0.18, { loosenPos: [0, -0.12, -0.10], loosenRot: [-0.16, -0.14, 0.16], zone: 'rear' });

    // 3. hood (aligned cleanly with windshield base)
    const hoodStartZ = ws.wsBotZ - 0.04;
    const hoodLen = Math.max(0.36, halfL - hoodStartZ - 0.06);
    const hood = new THREE.Group();
    hood.position.set(0, beltY, hoodStartZ);
    bodyGroup.add(hood);
    addBox(hood, cabW - 0.08, 0.10, hoodLen, paintMat, [0, -0.02, hoodLen * 0.5], [0.10, 0, 0]);
    registerPart('hood', hood, 0.28, { loosenPos: [0, 0.05, 0.02], loosenRot: [-0.42, 0.05, 0.05], zone: 'hood' });

    // 4. windshield
    buildWindshieldPart(cabW - 0.22, wsHeight, beltY + pillarH * 0.50, 3.20, wsTilt, 0.34);

    // 5 & 6. doorL & doorR (cab doors)
    buildHingedDoor('doorL', +1, cabHalfW - 0.04, y0 + 0.14 + (beltY - y0 - 0.14) * 0.5, 2.86, 1.12, beltY - y0 - 0.20, paintMat, 0.42);
    buildHingedDoor('doorR', -1, cabHalfW - 0.04, y0 + 0.14 + (beltY - y0 - 0.14) * 0.5, 2.86, 1.12, beltY - y0 - 0.20, paintMat, 0.46);

    // 7. cargoBox (26 ft crisp white cargo box — stays white when setColor() recolors cab!)
    const boxH = h - 0.96; // 3.15 - 0.96 = 2.19 m
    const boxLen = 5.02;
    const cargoBox = new THREE.Group();
    cargoBox.position.set(0, 0.96 + boxH * 0.5, -1.08);
    bodyGroup.add(cargoBox);
    addBox(cargoBox, w, boxH, boxLen, cargoWhiteMat, [0, 0, 0], null, { name: 'cargo_box_shell' });
    // Silver aluminum corner extrusions & vertical panel ribs
    for (const sx of [1, -1]) {
      addBox(cargoBox, 0.06, 0.08, boxLen + 0.02, chromeMat, [sx * (halfW - 0.02), boxH * 0.5 - 0.03, 0], null, { castShadow: false });
      addBox(cargoBox, 0.06, 0.08, boxLen + 0.02, chromeMat, [sx * (halfW - 0.02), -boxH * 0.5 + 0.03, 0], null, { castShadow: false });
      for (let rz = -2.0; rz <= 2.0; rz += 1.0) {
        addBox(cargoBox, 0.03, boxH - 0.18, 0.05, chromeMat, [sx * (halfW + 0.005), 0, rz], null, { castShadow: false });
      }
    }
    // Roll-up rear shutter door grooves
    addBox(cargoBox, w - 0.24, boxH - 0.22, 0.05, chromeMat, [0, 0, -boxLen * 0.5 - 0.01], null, { castShadow: false });
    for (let ry = -0.80; ry <= 0.80; ry += 0.32) {
      addBox(cargoBox, w - 0.30, 0.025, 0.07, trimDarkMat, [0, ry, -boxLen * 0.5 - 0.015], null, { castShadow: false });
    }
    // Amber top clearance lights on front cargo overhang
    for (const cx of [-0.95, 0, 0.95]) {
      addBox(cargoBox, 0.14, 0.08, 0.08, amberMat, [cx, boxH * 0.5 - 0.10, boxLen * 0.5 + 0.02], null, { castShadow: false });
    }
    registerPart('cargoBox', cargoBox, 0.54, {
      loosenPos: [0.10, 0.08, -0.14],
      loosenRot: [0.08, -0.10, 0.14],
      zone: 'cargoBox',
    });

    // 8. roof (cab roof aligned flush with windshield top + clearance lamps)
    const roofRearZ = 1.59;
    const roofFrontZ = ws.wsTopZ + 0.02;
    const roofLen = roofFrontZ - roofRearZ;
    const roofZ = (roofFrontZ + roofRearZ) * 0.5;
    const roof = new THREE.Group();
    roof.position.set(0, cabRoofY, roofZ);
    bodyGroup.add(roof);
    addBox(roof, cabW, 0.10, roofLen, paintMat, [0, 0, 0]);
    for (const cx of [-0.60, 0, 0.60]) {
      addBox(roof, 0.12, 0.06, 0.08, amberMat, [cx, 0.07, roofLen * 0.5 - 0.08], null, { castShadow: false });
    }
    registerPart('roof', roof, 0.64, { loosenPos: [0.05, -0.06, 0], loosenRot: [0.09, 0.06, 0.12], zone: 'roof', cabinH: cabinHeightRef });
  };

  const buildSemiTruck = () => {
    const y0 = 0.48;
    const beltY = 1.98;
    const cabRoofY = 3.10;
    cabinHeightRef = cabRoofY - beltY;
    const halfW = w * 0.5;
    const halfL = l * 0.5;
    const cabW = 2.40;
    const cabHalfW = cabW * 0.5;

    // 6x4 tandem dual rear axles (6 wheels touching y = 0.000!)
    addStandardFourWheels({
      x: 1.08,
      zF: 2.58,
      zR: -2.28, // midpoint of zR1=-1.66 and zR2=-2.90
      radius: R,
      tireW: 0.38,
      hubChrome: true,
      tandemRearOffsetZ: 0.62,
    });

    // Heavy twin steel frame rails spanning full tractor length
    addBox(bodyGroup, 0.18, 0.26, l - 0.36, chassisMat, [0.46, y0 + 0.36, 0]);
    addBox(bodyGroup, 0.18, 0.26, l - 0.36, chassisMat, [-0.46, y0 + 0.36, 0]);

    // Exposed rear fifth-wheel trailer hitch plate
    addCyl(bodyGroup, 0.48, 0.52, 0.12, 12, trimDarkMat, [0, y0 + 0.58, -2.28]);
    addBox(bodyGroup, 1.40, 0.10, 1.20, trimDarkMat, [0, y0 + 0.50, -2.28]);

    // Side cylindrical chrome diesel fuel tanks + steps
    for (const sx of [1, -1]) {
      addCyl(bodyGroup, 0.30, 0.30, 1.80, 12, chromeMat, [sx * (cabHalfW - 0.12), y0 + 0.32, -0.05], [Math.PI / 2, 0, 0]);
      // Front wheel fenders
      addBox(bodyGroup, 0.44, 0.42, 1.24, paintMat, [sx * (halfW - 0.22), y0 + 0.62, 2.58]);
    }

    // Tall chrome slatted front grille + headlights
    addBox(bodyGroup, 1.54, 1.18, 0.16, chromeMat, [0, y0 + 0.88, halfL - 0.16], null, { name: 'semi_grille' });
    for (let gy = y0 + 0.46; gy <= y0 + 1.30; gy += 0.18) {
      addBox(bodyGroup, 1.38, 0.04, 0.20, trimDarkMat, [0, gy, halfL - 0.14], null, { castShadow: false });
    }
    addHeadlight(bodyGroup, 0.34, 0.22, 0.10, [halfW - 0.34, y0 + 0.64, halfL - 0.24]);
    addHeadlight(bodyGroup, 0.34, 0.22, 0.10, [-(halfW - 0.34), y0 + 0.64, halfL - 0.24]);
    addTaillight(bodyGroup, 0.26, 0.14, 0.08, [0.56, y0 + 0.36, -(halfL - 0.08)]);
    addTaillight(bodyGroup, 0.26, 0.14, 0.08, [-0.56, y0 + 0.36, -(halfL - 0.08)]);

    // Engine bay core under long nose
    addBox(bodyGroup, 1.52, 1.04, 1.55, paintMat, [0, y0 + 0.88, 2.86]);

    // Cab floor & A-pillars aligned seamlessly with windshield placement
    addBox(bodyGroup, cabW - 0.12, 0.24, 1.48, chassisMat, [0, y0 + 0.52, 1.15]);
    const pillarH = cabRoofY - beltY;
    const wsTilt = -0.06;
    const wsHeight = (pillarH * 0.96) / Math.cos(wsTilt);
    const ws = computeWindshieldPlacement(wsHeight, beltY + pillarH * 0.50, 2.15, wsTilt);
    for (const sx of [1, -1]) {
      addBridgingPillar(pillarsGroup, sx * (cabHalfW - 0.08), 0.12, 0.12, paintMat, beltY, ws.wsBotZ, cabRoofY, ws.wsTopZ);
      // Twin tall vertical chrome exhaust stacks reaching y = 3.35 m!
      addCyl(bodyGroup, 0.09, 0.09, 2.40, 10, chromeMat, [sx * (cabHalfW + 0.08), 2.15, 0.28], null, { name: sx > 0 ? 'exhaust_stack_l' : 'exhaust_stack_r' });
      addCyl(bodyGroup, 0.10, 0.09, 0.18, 10, trimDarkMat, [sx * (cabHalfW + 0.08), 3.32, 0.28], [-0.25, 0, 0], { castShadow: false });
    }

    buildCabinInterior(cabW, y0 + 0.66, ws.wsBotZ - 0.26, def.seatOffset, cabRoofY, true);

    // 1. frontBumper (massive chrome bull bumper)
    const frontBumper = new THREE.Group();
    frontBumper.position.set(0, y0 + 0.22, halfL - 0.02);
    bodyGroup.add(frontBumper);
    addBox(frontBumper, w, 0.38, 0.26, chromeMat, [0, 0, 0]);
    addPlate(frontBumper, [0, 0, 0.136], false);
    registerPart('frontBumper', frontBumper, 0.14, { loosenPos: [0, -0.14, 0.12], loosenRot: [0.16, 0.14, -0.18], zone: 'front' });

    // 2. rearBumper (rear frame cross-bumper & mudflaps)
    const rearBumper = new THREE.Group();
    rearBumper.position.set(0, y0 + 0.24, -(halfL - 0.04));
    bodyGroup.add(rearBumper);
    addBox(rearBumper, w - 0.12, 0.22, 0.20, trimDarkMat, [0, 0.08, 0]);
    addBox(rearBumper, 0.58, 0.44, 0.04, trimDarkMat, [0.95, -0.14, -0.02], null, { castShadow: false });
    addBox(rearBumper, 0.58, 0.44, 0.04, trimDarkMat, [-0.95, -0.14, -0.02], null, { castShadow: false });
    addPlate(rearBumper, [0, 0.08, -0.106], true);
    registerPart('rearBumper', rearBumper, 0.18, { loosenPos: [0, -0.12, -0.12], loosenRot: [-0.16, -0.14, 0.16], zone: 'rear' });

    // 3. hood (long classic semi hood joining windshield cowl)
    const hoodStartZ = ws.wsBotZ - 0.04;
    const hoodLen = Math.max(1.30, halfL - hoodStartZ - 0.12);
    const hood = new THREE.Group();
    hood.position.set(0, beltY - 0.02, hoodStartZ);
    bodyGroup.add(hood);
    addBox(hood, 1.56, 0.18, hoodLen, paintMat, [0, -0.06, hoodLen * 0.5]);
    addBox(hood, 0.12, 0.05, hoodLen - 0.12, chromeMat, [0, 0.05, hoodLen * 0.5], null, { castShadow: false });
    registerPart('hood', hood, 0.28, { loosenPos: [0, 0.06, 0.04], loosenRot: [-0.42, 0.06, 0.05], zone: 'hood' });

    // 4. windshield (tall split semi windshield)
    buildWindshieldPart(cabW - 0.22, wsHeight, beltY + pillarH * 0.50, 2.15, wsTilt, 0.34);

    // 5 & 6. doorL & doorR
    buildHingedDoor('doorL', +1, cabHalfW - 0.04, y0 + 0.64 + (beltY - (y0 + 0.64)) * 0.5, 1.94, 1.38, beltY - (y0 + 0.64), paintMat, 0.42);
    buildHingedDoor('doorR', -1, cabHalfW - 0.04, y0 + 0.64 + (beltY - (y0 + 0.64)) * 0.5, 1.94, 1.38, beltY - (y0 + 0.64), paintMat, 0.46);

    // 7. trunk (tall sleeper cab compartment behind driver seats)
    const trunk = new THREE.Group();
    trunk.position.set(0, y0 + 0.62, 0.34);
    bodyGroup.add(trunk);
    const sleeperH = cabRoofY - (y0 + 0.62);
    addBox(trunk, cabW, sleeperH, 1.32, paintMat, [0, sleeperH * 0.5, -0.66]);
    addBox(trunk, cabW + 0.04, 0.44, 0.58, darkGlassMat, [0, sleeperH * 0.66, -0.66], null, { castShadow: false });
    registerPart('trunk', trunk, 0.54, { loosenPos: [0.06, 0.06, -0.10], loosenRot: [0.22, -0.08, 0.12], zone: 'trunk' });

    // 8. roof (cab + sleeper roof aligned flush with windshield top + chrome horns & amber marker lights)
    const roofRearZ = -0.51;
    const roofFrontZ = ws.wsTopZ + 0.02;
    const roofLen = roofFrontZ - roofRearZ;
    const roofZ = (roofFrontZ + roofRearZ) * 0.5;
    const roof = new THREE.Group();
    roof.position.set(0, cabRoofY, roofZ);
    bodyGroup.add(roof);
    addBox(roof, cabW + 0.06, 0.14, roofLen, paintMat, [0, 0, 0]);
    for (const cx of [-0.72, -0.36, 0, 0.36, 0.72]) {
      addBox(roof, 0.10, 0.06, 0.08, amberMat, [cx, 0.10, roofLen * 0.5 - 0.08], null, { castShadow: false });
    }
    addCyl(roof, 0.05, 0.03, 0.54, 8, chromeMat, [0.68, 0.12, roofLen * 0.5 - 0.42], [Math.PI / 2, 0, 0], { castShadow: false });
    addCyl(roof, 0.05, 0.03, 0.54, 8, chromeMat, [-0.68, 0.12, roofLen * 0.5 - 0.42], [Math.PI / 2, 0, 0], { castShadow: false });
    registerPart('roof', roof, 0.64, { loosenPos: [0.05, -0.06, 0], loosenRot: [0.09, 0.06, 0.12], zone: 'roof', cabinH: cabinHeightRef });
  };

  const buildSchoolBus = () => {
    const y0 = 0.44;
    const beltY = 1.68;
    const roofY = h - 0.06;
    cabinHeightRef = roofY - beltY;
    const halfL = l * 0.5;
    // Keep lower body strictly narrower than outer tire sidewall (wheelX + tireW/2 = 1.28 > 1.20)
    // to eliminate coplanar body/wheel z-fighting while staying inside catalog width (2.60 m).
    const bodyW = 2.40;
    const bodyHalfW = bodyW * 0.5;

    const redStopMat = makeMat({
      name: 'bus_stop_red',
      color: 0xd32f2f,
      roughness: 0.46,
      metalness: 0.06,
    }, false);
    const whiteTrimMat = makeMat({
      name: 'bus_white',
      color: 0xf8fafc,
      roughness: 0.52,
      metalness: 0.04,
    }, false);
    const busRearTex = textures && typeof textures.makePlateTexture === 'function'
      ? textures.makePlateTexture('SCHOOL BUS')
      : null;
    const busRearSignMat = makeMat({
      name: 'bus_rear_sign',
      color: busRearTex ? 0xffffff : 0xfdd835,
      map: busRearTex || null,
      roughness: 0.48,
      metalness: 0.05,
    }, false);

    const wheelX = 1.10;
    const tireW = 0.36;
    const zF = 2.65;
    const zR = -2.45;
    addStandardFourWheels({ x: wheelX, zF, zR, radius: R, tireW });

    // Compute aligned windshield first so cab body, roof, A-pillars & dashboard join seamlessly
    const pillarH = roofY - beltY;
    const wsTilt = -0.08;
    const wsHeight = (pillarH * 0.96) / Math.cos(wsTilt);
    const ws = computeWindshieldPlacement(wsHeight, beltY + pillarH * 0.50, 4.10, wsTilt);

    const busRearZ = -(halfL - 0.14); // -4.46
    const cabFrontZ = ws.wsBotZ + 0.02; // ~4.19
    const entryStartZ = 3.24;
    const wheelArchTopY = 1.12; // 8 cm clear above tire top (2*R = 1.04)

    // Recessed inner steel chassis core strictly inside inner tire sidewalls (halfW = 0.84 < 0.92)
    addBox(bodyGroup, 1.68, 0.24, l - 0.30, chassisMat, [0, y0 + 0.12, 0]);

    // Continuous full-width yellow waist band strictly ABOVE wheel arches (y in [1.12, 1.68])
    const upperH = beltY - wheelArchTopY;
    const upperMainLen = entryStartZ - busRearZ;
    const upperMainZ = (entryStartZ + busRearZ) * 0.5;
    addBox(bodyGroup, bodyW, upperH, upperMainLen, paintMat, [0, wheelArchTopY + upperH * 0.5, upperMainZ]);

    // Left-side (+X) cab waist alongside front entry door bay (right side -X stays open for doorR)
    const cabSideLen = cabFrontZ - entryStartZ;
    const cabSideZ = (cabFrontZ + entryStartZ) * 0.5;
    addBox(bodyGroup, 0.24, upperH, cabSideLen, paintMat, [bodyHalfW - 0.12, wheelArchTopY + upperH * 0.5, cabSideZ]);
    // Recessed dark entry step-well floor inside right-side (-X) entry bay
    addBox(bodyGroup, 0.52, 0.14, cabSideLen - 0.06, chassisMat, [-(bodyHalfW - 0.26), y0 + 0.14, cabSideZ]);

    // Segmented lower yellow side skirts (y in [0.56, 1.12]) with clean wheel-arch cutouts around zF & zR
    const skirtBotY = y0 + 0.12;
    const skirtH = wheelArchTopY - skirtBotY;
    const skirtMidY = skirtBotY + skirtH * 0.5;
    const archPad = R + 0.12;
    const rearSkirtEndZ = zR - archPad;
    const rearSkirtLen = Math.max(0.4, rearSkirtEndZ - busRearZ);
    addBox(bodyGroup, bodyW, skirtH, rearSkirtLen, paintMat, [0, skirtMidY, (busRearZ + rearSkirtEndZ) * 0.5]);

    const midSkirtStartZ = zR + archPad;
    const midSkirtEndZ = zF - archPad;
    const midSkirtLen = Math.max(0.4, midSkirtEndZ - midSkirtStartZ);
    addBox(bodyGroup, bodyW, skirtH, midSkirtLen, paintMat, [0, skirtMidY, (midSkirtStartZ + midSkirtEndZ) * 0.5]);

    const frontSkirtStartZ = zF + archPad;
    const frontSkirtLen = Math.max(0.3, cabFrontZ - frontSkirtStartZ);
    addBox(bodyGroup, 0.24, skirtH, frontSkirtLen, paintMat, [bodyHalfW - 0.12, skirtMidY, (frontSkirtStartZ + cabFrontZ) * 0.5]);

    // Subtle dark wheel-arch eyebrows above front & rear cutouts
    for (const sx of [1, -1]) {
      for (const az of [zF, zR]) {
        addBox(bodyGroup, 0.04, 0.07, archPad * 2 + 0.06, trimDarkMat, [sx * (bodyHalfW + 0.008), wheelArchTopY + 0.02, az], null, { castShadow: false });
      }
    }

    // Full-width short-nose front radiator cowling cleanly bridging cabFrontZ to front grille
    const noseBackZ = cabFrontZ - 0.14;
    const noseFrontZ = halfL - 0.12;
    const noseLen = Math.max(0.32, noseFrontZ - noseBackZ);
    const noseH = beltY - y0 - 0.16;
    addBox(bodyGroup, bodyW - 0.08, noseH, noseLen, paintMat, [0, y0 + 0.12 + noseH * 0.5, (noseBackZ + noseFrontZ) * 0.5]);

    // Iconic black horizontal side rub-stripes (NEVER recolored, strictly above wheel arches, clear of doorR!)
    const leftStripeLen = cabFrontZ - busRearZ;
    const leftStripeZ = (cabFrontZ + busRearZ) * 0.5;
    addBox(bodyGroup, 0.03, 0.12, leftStripeLen, trimDarkMat, [bodyHalfW + 0.012, 1.26, leftStripeZ], null, { castShadow: false });
    addBox(bodyGroup, 0.03, 0.10, leftStripeLen, trimDarkMat, [bodyHalfW + 0.012, beltY - 0.06, leftStripeZ], null, { castShadow: false });
    addBox(bodyGroup, 0.03, 0.12, upperMainLen, trimDarkMat, [-(bodyHalfW + 0.012), 1.26, upperMainZ], null, { castShadow: false });
    addBox(bodyGroup, 0.03, 0.10, upperMainLen, trimDarkMat, [-(bodyHalfW + 0.012), beltY - 0.06, upperMainZ], null, { castShadow: false });

    // Front A-pillars aligned flush with windshield left/right edges
    for (const sx of [1, -1]) {
      addBridgingPillar(pillarsGroup, sx * (bodyHalfW - 0.06), 0.12, 0.12, paintMat, beltY, ws.wsBotZ, roofY, ws.wsTopZ);
    }

    // 7 passenger side windows per side + pillars + left driver window + interior bench rows
    const winStep = (entryStartZ - (busRearZ + 0.08)) / 7;
    for (let i = 0; i <= 7; i += 1) {
      const pz = entryStartZ - i * winStep;
      for (const sx of [1, -1]) {
        addBox(pillarsGroup, 0.10, pillarH, 0.14, paintMat, [sx * (bodyHalfW - 0.06), beltY + pillarH * 0.5, pz]);
      }
      if (i < 7) {
        const wz = pz - winStep * 0.5;
        for (const sx of [1, -1]) {
          addBox(pillarsGroup, 0.03, pillarH * 0.76, winStep - 0.16, glassMat, [sx * (bodyHalfW - 0.04), beltY + pillarH * 0.48, wz], null, { castShadow: false, receiveShadow: false });
        }
        // Interior passenger bench seats
        if (i >= 1) {
          addBox(bodyGroup, 0.78, 0.56, 0.36, seatMat, [0.68, y0 + 0.62, wz], null, { castShadow: false });
          addBox(bodyGroup, 0.78, 0.56, 0.36, seatMat, [-0.68, y0 + 0.62, wz], null, { castShadow: false });
        }
      }
    }
    // Driver-side (+X) front window glass (right side -X is reserved for bi-fold entry doorR!)
    addBox(pillarsGroup, 0.03, pillarH * 0.76, Math.max(0.50, cabSideLen - 0.24), glassMat, [bodyHalfW - 0.04, beltY + pillarH * 0.48, cabSideZ - 0.04], null, { castShadow: false, receiveShadow: false });

    // Front grille, headlights & taillights
    addBox(bodyGroup, 1.46, 0.56, 0.08, trimDarkMat, [0, y0 + 0.68, halfL - 0.12]);
    addHeadlight(bodyGroup, 0.24, 0.24, 0.08, [0.88, y0 + 0.66, halfL - 0.11], true);
    addHeadlight(bodyGroup, 0.24, 0.24, 0.08, [-0.88, y0 + 0.66, halfL - 0.11], true);
    addTaillight(bodyGroup, 0.22, 0.22, 0.08, [bodyHalfW - 0.22, y0 + 0.88, -(halfL - 0.08)]);
    addTaillight(bodyGroup, 0.22, 0.22, 0.08, [-(bodyHalfW - 0.22), y0 + 0.88, -(halfL - 0.08)]);

    // Dashboard strictly enclosed inside full-width cab body (x in [-1.08, +1.08] < +-1.20, z ~ 3.93 < 4.19!)
    buildCabinInterior(bodyW, y0 + 0.22, ws.wsBotZ - 0.24, def.seatOffset, roofY, true);

    // 1. frontBumper (keeps RCD 107 front plate intact!)
    const frontBumper = new THREE.Group();
    frontBumper.position.set(0, y0 + 0.22, halfL - 0.02);
    bodyGroup.add(frontBumper);
    addBox(frontBumper, bodyW + 0.12, 0.34, 0.22, trimDarkMat, [0, 0, 0]);
    addPlate(frontBumper, [0, 0, 0.116], false);
    registerPart('frontBumper', frontBumper, 0.14, { loosenPos: [0, -0.10, 0.10], loosenRot: [0.14, 0.14, -0.14], zone: 'front' });

    // 2. rearBumper (keeps SCHOOL BUS rear plate intact!)
    const rearBumper = new THREE.Group();
    rearBumper.position.set(0, y0 + 0.22, -(halfL - 0.02));
    bodyGroup.add(rearBumper);
    addBox(rearBumper, bodyW + 0.12, 0.34, 0.22, trimDarkMat, [0, 0, 0]);
    addPlate(rearBumper, [0, 0, -0.116], true, busRearSignMat, 0.64, 0.26);
    registerPart('rearBumper', rearBumper, 0.18, { loosenPos: [0, -0.10, -0.10], loosenRot: [-0.14, -0.14, 0.14], zone: 'rear' });

    // 3. hood (bus front service hood meeting windshield base & nose cleanly)
    const hoodStartZ = ws.wsBotZ - 0.06;
    const hoodLen = Math.max(0.36, noseFrontZ - hoodStartZ + 0.02);
    const hood = new THREE.Group();
    hood.position.set(0, beltY - 0.06, hoodStartZ);
    bodyGroup.add(hood);
    addBox(hood, bodyW - 0.16, 0.12, hoodLen, paintMat, [0, -0.02, hoodLen * 0.5], [0.06, 0, 0]);
    registerPart('hood', hood, 0.28, { loosenPos: [0, 0.05, 0.04], loosenRot: [-0.42, 0.05, 0.05], zone: 'hood' });

    // 4. windshield
    buildWindshieldPart(bodyW - 0.24, wsHeight, beltY + pillarH * 0.50, 4.10, wsTilt, 0.34);

    // 5. doorL (driver side panel proud of left wall + hinged red octagonal STOP arm!)
    buildHingedDoor('doorL', +1, bodyHalfW + 0.045, beltY - 0.10, 4.06, 0.80, 0.96, paintMat, 0.42, (pivot) => {
      const stopArm = new THREE.Mesh(trackGeom(new THREE.CylinderGeometry(0.24, 0.24, 0.04, 8)), redStopMat);
      stopArm.rotation.z = Math.PI / 2;
      stopArm.position.set(0.08, 0.10, -0.40);
      stopArm.castShadow = false;
      pivot.add(stopArm);
      addBox(pivot, 0.05, 0.08, 0.28, whiteTrimMat, [0.09, 0.10, -0.40], null, { castShadow: false });
    });

    // 6. doorR (bi-fold entry door sitting cleanly in recessed entry bay with zero solid-wall overlap!)
    buildHingedDoor('doorR', -1, bodyHalfW + 0.015, y0 + 0.18 + (roofY - y0 - 0.28) * 0.5, 4.06, 0.80, roofY - y0 - 0.32, trimDarkMat, 0.46, (pivot) => {
      addBox(pivot, 0.04, 1.15, 0.62, glassMat, [-0.025, 0.22, -0.40], null, { castShadow: false, receiveShadow: false });
    });

    // 7. trunk (rear emergency exit door + "SCHOOL BUS" header plate)
    const trunk = new THREE.Group();
    trunk.position.set(0, roofY - 0.12, -(halfL - 0.12));
    bodyGroup.add(trunk);
    const rearH = roofY - y0 - 0.28;
    addBox(trunk, bodyW - 0.08, rearH, 0.12, paintMat, [0, -rearH * 0.5, 0]);
    addBox(trunk, 1.05, 0.96, 0.04, darkGlassMat, [0, -0.78, -0.06], null, { castShadow: false });
    addPlate(trunk, [0, -0.18, -0.072], true, busRearSignMat, 1.48, 0.34);
    registerPart('trunk', trunk, 0.54, { loosenPos: [0, 0.06, -0.08], loosenRot: [0.44, -0.06, 0.05], zone: 'trunk' });

    // 8. roof (long yellow roof aligned flush with windshield top + hatches + brow flashers)
    const roofRearZ = busRearZ;
    const roofFrontZ = ws.wsTopZ + 0.02;
    const roofLen = roofFrontZ - roofRearZ;
    const roofZ = (roofFrontZ + roofRearZ) * 0.5;
    const roof = new THREE.Group();
    roof.position.set(0, roofY, roofZ);
    bodyGroup.add(roof);
    addBox(roof, bodyW, 0.14, roofLen, paintMat, [0, 0, 0]);
    addBox(roof, 0.78, 0.07, 0.78, whiteTrimMat, [0, 0.09, 1.40], null, { castShadow: false });
    addBox(roof, 0.78, 0.07, 0.78, whiteTrimMat, [0, 0.09, -1.80], null, { castShadow: false });
    // Front brow warning flashers mounted flush at roof front edge
    const browZ = roofLen * 0.5 - 0.01;
    addBox(roof, 0.24, 0.18, 0.06, redStopMat, [0.84, -0.02, browZ], null, { castShadow: false });
    addBox(roof, 0.24, 0.18, 0.06, redStopMat, [-0.84, -0.02, browZ], null, { castShadow: false });
    addBox(roof, 0.24, 0.18, 0.06, amberMat, [0.52, -0.02, browZ], null, { castShadow: false });
    addBox(roof, 0.24, 0.18, 0.06, amberMat, [-0.52, -0.02, browZ], null, { castShadow: false });
    registerPart('roof', roof, 0.64, { loosenPos: [0.05, -0.06, 0], loosenRot: [0.08, 0.06, 0.10], zone: 'roof', cabinH: cabinHeightRef });
  };

  const buildTukTuk = () => {
    const y0 = 0.24;
    const beltY = 0.92;
    const canopyY = h - 0.05; // 1.83 m
    cabinHeightRef = canopyY - beltY;
    const halfW = w * 0.5;
    const halfL = l * 0.5;

    // Non-recolorable authentic Tuk-Tuk materials: white accent band, black canvas canopy, bright teal rear bench!
    const whiteBandMat = makeMat({
      name: 'tuktuk_white_band',
      color: 0xf8fafc,
      roughness: 0.45,
      metalness: 0.05,
    }, false);
    const canopyMat = makeMat({
      name: 'tuktuk_black_canopy',
      color: 0x1b2028,
      roughness: 0.85,
      metalness: 0.04,
    }, false);
    const tealBenchMat = makeMat({
      name: 'tuktuk_teal_bench',
      color: 0x14b8a6,
      roughness: 0.58,
      metalness: 0.05,
    }, false);

    // 3 WHEELS: single centered front wheelF + rear pair wheelRL / wheelRR
    addWheelPart({ key: 'wheelF', x: 0, z: 1.06, radius: R, tireW: 0.20, side: 0, isFront: true, isRear: false, steerFactor: 1.0, threshold: 0.74 });
    addWheelPart({ key: 'wheelRL', x: +0.64, z: -0.88, radius: R, tireW: 0.22, side: +1, isFront: false, isRear: true, steerFactor: 0, threshold: 0.82 });
    addWheelPart({ key: 'wheelRR', x: -0.64, z: -0.88, radius: R, tireW: 0.22, side: -1, isFront: false, isRear: true, steerFactor: 0, threshold: 0.88 });

    // Lower steel floor pan & rear engine housing
    addBox(bodyGroup, w - 0.14, 0.14, l - 0.48, chassisMat, [0, y0 + 0.07, -0.08]);
    // Front fork struts framing single centered front wheel
    addCyl(bodyGroup, 0.032, 0.032, 0.62, 8, chromeMat, [0.14, 0.58, 1.06], [-0.14, 0, 0]);
    addCyl(bodyGroup, 0.032, 0.032, 0.62, 8, chromeMat, [-0.14, 0.58, 1.06], [-0.14, 0, 0]);

    // Sculpted Tuk-Tuk nose shield + white lower stripe + single centered round headlight
    addBox(bodyGroup, 1.18, 0.56, 0.36, paintMat, [0, y0 + 0.46, 1.24]);
    addBox(bodyGroup, 1.20, 0.18, 0.38, whiteBandMat, [0, y0 + 0.18, 1.24], null, { castShadow: false });
    addBox(bodyGroup, w - 0.10, 0.52, 0.62, paintMat, [0, y0 + 0.40, -1.10]);
    addBox(bodyGroup, w - 0.08, 0.16, 0.64, whiteBandMat, [0, y0 + 0.16, -1.10], null, { castShadow: false });

    // Single round classic Tuk-Tuk nose headlight + twin amber turn pods + taillights
    addCyl(bodyGroup, 0.15, 0.14, 0.10, 12, chromeMat, [0, y0 + 0.54, 1.41], [Math.PI / 2, 0, 0], { castShadow: false });
    addHeadlight(bodyGroup, 0.24, 0.24, 0.04, [0, y0 + 0.54, 1.46], true);
    addBox(bodyGroup, 0.10, 0.08, 0.06, amberMat, [0.46, y0 + 0.54, 1.42], null, { castShadow: false });
    addBox(bodyGroup, 0.10, 0.08, 0.06, amberMat, [-0.46, y0 + 0.54, 1.42], null, { castShadow: false });
    addTaillight(bodyGroup, 0.22, 0.12, 0.06, [0.52, y0 + 0.48, -1.42]);
    addTaillight(bodyGroup, 0.22, 0.12, 0.06, [-0.52, y0 + 0.48, -1.42]);

    // Open-air tubular canopy support struts (A-posts aligned along windshield edges; sides wide open!)
    const strutH = canopyY - beltY;
    const wsTilt = -0.08;
    const wsHeight = 0.76;
    const wsCenterY = 1.39;
    const ws = computeWindshieldPlacement(wsHeight, wsCenterY, 1.36, wsTilt);
    for (const sx of [1, -1]) {
      addBridgingPillar(pillarsGroup, sx * 0.56, 0.052, 0.052, trimDarkMat, beltY, ws.wsBotZ, canopyY, ws.wsTopZ);
      addCyl(pillarsGroup, 0.028, 0.028, strutH, 8, trimDarkMat, [sx * 0.66, beltY + strutH * 0.5, -1.24], [0.06, 0, 0]);
      addCyl(pillarsGroup, 0.026, 0.026, strutH, 8, trimDarkMat, [sx * 0.66, beltY + strutH * 0.5, 0.04]);
    }

    // Driver seat + Tuk-Tuk cockpit handlebars & twin round mirrors
    // Sized & placed so ALL grips, mirrors & bulbs stay strictly inside NDC (-1, 1) across
    // Landscape (1180x820), Classic Portrait (768x1024), AND iPad Air Portrait (820x1180) on frame 1 & settled!
    addBox(bodyGroup, 0.56, 0.12, 0.42, interiorMat, [0, def.seatOffset[1] - 0.06, def.seatOffset[2]]);
    addBox(bodyGroup, 0.54, 0.36, 0.09, interiorMat, [0, def.seatOffset[1] + 0.16, def.seatOffset[2] - 0.20]);

    const handlebarGroup = new THREE.Group();
    handlebarGroup.name = 'tuktuk_handlebars';
    handlebarGroup.position.set(0, 1.04, 1.25);
    bodyGroup.add(handlebarGroup);
    addCyl(handlebarGroup, 0.026, 0.030, 0.30, 8, chromeMat, [0, -0.14, 0.03], [-0.20, 0, 0], { castShadow: false });
    addCyl(handlebarGroup, 0.018, 0.018, 0.34, 8, chromeMat, [0, 0.01, 0], [0, 0, Math.PI / 2], { castShadow: false });
    // Rubber grips (outer tips strictly within x in [-0.185, +0.185], world y ~ 1.05, z ~ 1.25)
    addCyl(handlebarGroup, 0.022, 0.022, 0.084, 8, trimDarkMat, [0.138, 0.01, 0.0], [0, 0.10, Math.PI / 2], { castShadow: false, name: 'handlebar_grip_L' });
    addCyl(handlebarGroup, 0.022, 0.022, 0.084, 8, trimDarkMat, [-0.138, 0.01, 0.0], [0, -0.10, Math.PI / 2], { castShadow: false, name: 'handlebar_grip_R' });
    // Center speedometer pod
    addCyl(handlebarGroup, 0.056, 0.056, 0.05, 10, trimDarkMat, [0, 0.045, 0.04], [0.45, 0, 0], { castShadow: false });
    // Twin round wing mirrors mounted on handlebar stalks (world x = +-0.168, y = 1.15, z = 1.30, r = 0.032)
    for (const sx of [1, -1]) {
      addCyl(handlebarGroup, 0.009, 0.009, 0.11, 6, chromeMat, [sx * 0.150, 0.06, 0.028], [0.24, 0, -sx * 0.28], { castShadow: false });
      addCyl(handlebarGroup, 0.032, 0.032, 0.020, 12, chromeMat, [sx * 0.168, 0.11, 0.05], [Math.PI / 2, sx * 0.12, 0], { castShadow: false, name: sx > 0 ? 'mirror_L' : 'mirror_R' });
    }
    steeringControlObj = handlebarGroup;
    steeringControlAxis = 'y';
    steeringControlSign = 0.85;

    // 1. frontBumper (chrome curved push bar)
    const frontBumper = new THREE.Group();
    frontBumper.position.set(0, y0 + 0.12, halfL - 0.02);
    bodyGroup.add(frontBumper);
    addBox(frontBumper, 1.06, 0.14, 0.14, chromeMat, [0, 0, 0]);
    addPlate(frontBumper, [0, 0.02, 0.078], false, null, 0.36, 0.17);
    registerPart('frontBumper', frontBumper, 0.14, { loosenPos: [0, -0.06, 0.10], loosenRot: [0.14, 0.14, -0.14], zone: 'front' });

    // 2. rearBumper
    const rearBumper = new THREE.Group();
    rearBumper.position.set(0, y0 + 0.12, -(halfL - 0.02));
    bodyGroup.add(rearBumper);
    addBox(rearBumper, w - 0.06, 0.16, 0.16, chromeMat, [0, 0, 0]);
    addPlate(rearBumper, [0, 0.02, -0.086], true, null, 0.38, 0.18);
    registerPart('rearBumper', rearBumper, 0.18, { loosenPos: [0, -0.06, -0.10], loosenRot: [-0.14, -0.14, 0.14], zone: 'rear' });

    // 3. fenderF (painted single front wheel mudguard)
    const fenderF = new THREE.Group();
    fenderF.position.set(0, 0.62, 1.06);
    bodyGroup.add(fenderF);
    addBox(fenderF, 0.30, 0.09, 0.64, paintMat, [0, 0.02, 0.04]);
    addBox(fenderF, 0.30, 0.18, 0.12, paintMat, [0, -0.06, 0.32], [0.42, 0, 0]);
    registerPart('fenderF', fenderF, 0.25, { loosenPos: [0.06, 0.06, 0.10], loosenRot: [-0.36, 0.22, 0.18], zone: 'front' });

    // 4. windshield (Tuk-Tuk clear front pane joining nose shield & canopy brow cleanly)
    buildWindshieldPart(1.10, wsHeight, wsCenterY, 1.36, wsTilt, 0.32, trimDarkMat);

    // 5 & 6. doorL & doorR (low open-side entry panels)
    buildHingedDoor('doorL', +1, halfW - 0.06, y0 + 0.30, 0.92, 1.62, 0.38, paintMat, 0.40);
    buildHingedDoor('doorR', -1, halfW - 0.06, y0 + 0.30, 0.92, 1.62, 0.38, paintMat, 0.45);

    // 7. bench (bright teal rear passenger bench!)
    const bench = new THREE.Group();
    bench.position.set(0, y0 + 0.38, -0.68);
    bodyGroup.add(bench);
    addBox(bench, w - 0.30, 0.18, 0.56, tealBenchMat, [0, 0, 0], null, { name: 'tuktuk_bench_seat' });
    addBox(bench, w - 0.30, 0.54, 0.14, tealBenchMat, [0, 0.32, -0.24], [-0.12, 0, 0], { name: 'tuktuk_bench_back' });
    addBox(bench, 0.10, 0.22, 0.54, trimDarkMat, [(w - 0.34) * 0.5, 0.14, 0], null, { castShadow: false });
    addBox(bench, 0.10, 0.22, 0.54, trimDarkMat, [-(w - 0.34) * 0.5, 0.14, 0], null, { castShadow: false });
    registerPart('bench', bench, 0.54, { loosenPos: [0.08, 0.08, -0.10], loosenRot: [0.24, 0.18, -0.16], zone: 'trunk' });

    // 8. canopy (black canvas roof + 5 GLOWING COLORED HANGING COCKPIT LIGHT BULBS!)
    const canopy = new THREE.Group();
    canopy.position.set(0, canopyY, -0.02);
    bodyGroup.add(canopy);
    addBox(canopy, w - 0.08, 0.10, l - 0.24, canopyMat, [0, 0, 0], null, { name: 'tuktuk_canopy_top' });
    addBox(canopy, w - 0.20, 0.06, l - 0.56, canopyMat, [0, 0.06, -0.04], null, { castShadow: false });
    // Front canopy brow valance meeting windshield top
    addBox(canopy, 1.24, 0.12, 0.08, canopyMat, [0, -0.06, 1.32], null, { castShadow: false });

    // 5 glowing colored hanging cockpit bulbs strictly inside Landscape & Portrait cockpit FOV!
    // World target: y = 1.46 (local y = 1.46 - 1.83 = -0.37), z = +1.30 (local z = +1.32),
    // x = [-0.155, -0.0775, 0, +0.0775, +0.155], radius = 0.030 m
    if (def.hasCockpitBulbs) {
      const bulbColors = [0xffe100, 0x00e5ff, 0xffffff, 0x2979ff, 0xffe100];
      const bulbXs = [-0.155, -0.0775, 0.0, 0.0775, 0.155];
      const bulbGeo = trackGeom(new THREE.SphereGeometry(0.030, 10, 8));
      const cordGeo = trackGeom(new THREE.CylinderGeometry(0.0045, 0.0045, 0.29, 6));
      const socketGeo = trackGeom(new THREE.CylinderGeometry(0.014, 0.016, 0.028, 8));
      const bulbRow = new THREE.Group();
      bulbRow.name = 'tuktuk_cockpit_bulbs';
      canopy.add(bulbRow);

      for (let i = 0; i < 5; i += 1) {
        const bx = bulbXs[i];
        const bCol = bulbColors[i];
        const bulbMat = makeMat({
          name: `tuktuk_bulb_${i}`,
          color: bCol,
          emissive: bCol,
          emissiveIntensity: 1.15,
          roughness: 0.18,
          metalness: 0.04,
        }, false);
        cockpitBulbMaterials.push(bulbMat);

        const cord = new THREE.Mesh(cordGeo, trimDarkMat);
        cord.position.set(bx, -0.195, 1.32);
        cord.castShadow = false;
        bulbRow.add(cord);

        const socket = new THREE.Mesh(socketGeo, trimDarkMat);
        socket.position.set(bx, -0.34, 1.32);
        socket.castShadow = false;
        bulbRow.add(socket);

        const bulb = new THREE.Mesh(bulbGeo, bulbMat);
        bulb.name = `cockpit_bulb_${i}`;
        bulb.position.set(bx, -0.37, 1.32); // world y = 1.83 - 0.37 = 1.46 m, z = 1.30 m!
        bulb.castShadow = false;
        bulb.receiveShadow = false;
        bulbRow.add(bulb);
      }
    }

    registerPart('canopy', canopy, 0.64, { loosenPos: [0.06, -0.06, -0.04], loosenRot: [0.10, 0.08, 0.14], zone: 'roof', cabinH: cabinHeightRef });
  };

  const buildPickupOrMonster = (isMonster) => {
    const y0 = isMonster ? 1.50 : 0.44;
    const beltY = isMonster ? 2.22 : 1.16;
    const roofY = h - 0.05;
    cabinHeightRef = roofY - beltY;
    const halfW = w * 0.5;
    const halfL = l * 0.5;
    const bodyW = isMonster ? 2.24 : (w - 0.08);
    const bodyHalfW = bodyW * 0.5;

    const wheelX = isMonster ? 1.26 : 0.98;
    const zF = isMonster ? 1.76 : 1.68;
    const zR = isMonster ? -1.76 : -1.62;
    const tireW = isMonster ? 0.62 : 0.32;

    addStandardFourWheels({
      x: wheelX,
      zF,
      zR,
      radius: R,
      tireW,
      rearSteer: isMonster ? -0.35 : 0, // Monster truck 4WS rear counter-steer!
      isMonster,
      hubChrome: isMonster,
    });

    if (isMonster) {
      // Exposed Monster Truck solid axles, driveshafts & 4 bright yellow/lime coil-over struts!
      const strutLimeMat = makeMat({
        name: 'monster_strut_lime',
        color: 0xc6ff00,
        roughness: 0.36,
        metalness: 0.14,
      }, false);

      // Solid front & rear axle tubes + differentials
      addCyl(bodyGroup, 0.09, 0.09, wheelX * 2 - 0.25, 10, chassisMat, [0, R, zF], [0, 0, Math.PI / 2]);
      addCyl(bodyGroup, 0.09, 0.09, wheelX * 2 - 0.25, 10, chassisMat, [0, R, zR], [0, 0, Math.PI / 2]);
      addBox(bodyGroup, 0.34, 0.34, 0.34, trimDarkMat, [0, R, zF]);
      addBox(bodyGroup, 0.34, 0.34, 0.34, trimDarkMat, [0, R, zR]);
      // Center transfer case & angled driveshafts sloping cleanly down into front (+Z) & rear (-Z) diffs
      addBox(bodyGroup, 0.56, 0.42, 0.88, trimDarkMat, [0, y0 - 0.14, 0]);
      addCyl(bodyGroup, 0.055, 0.055, 1.82, 8, chromeMat, [0, (R + y0 - 0.14) * 0.5, zF * 0.5], [-1.29, 0, 0]);
      addCyl(bodyGroup, 0.055, 0.055, 1.82, 8, chromeMat, [0, (R + y0 - 0.14) * 0.5, zR * 0.5], [1.29, 0, 0]);

      // 4 bright yellow/lime coil-over suspension struts connecting axles to lifted frame!
      const strutLen = (y0 + 0.08) - R;
      for (const sx of [1, -1]) {
        for (const az of [zF, zR]) {
          addCyl(bodyGroup, 0.095, 0.095, strutLen, 10, strutLimeMat, [sx * 0.84, R + strutLen * 0.5, az], [0, 0, sx * 0.14], { name: 'monster_coilover_strut' });
          addCyl(bodyGroup, 0.042, 0.042, strutLen + 0.12, 8, chromeMat, [sx * 0.84, R + strutLen * 0.5, az], [0, 0, sx * 0.14], { castShadow: false });
        }
      }
      // Lifted steel truss sub-frame
      addBox(bodyGroup, 0.16, 0.20, l - 0.60, chassisMat, [0.58, y0, 0]);
      addBox(bodyGroup, 0.16, 0.20, l - 0.60, chassisMat, [-0.58, y0, 0]);
    } else {
      // Standard pickup chassis + side running boards + black wheel fender flares
      addBox(bodyGroup, bodyW - 0.16, 0.22, l - 0.36, chassisMat, [0, y0 + 0.11, 0]);
      for (const sx of [1, -1]) {
        addBox(bodyGroup, 0.16, 0.07, 1.76, trimDarkMat, [sx * (bodyHalfW + 0.04), y0 + 0.06, 0.30]);
        addBox(bodyGroup, 0.12, 0.28, 1.04, trimDarkMat, [sx * (bodyHalfW + 0.02), y0 + 0.36, zF]);
        addBox(bodyGroup, 0.12, 0.28, 1.04, trimDarkMat, [sx * (bodyHalfW + 0.02), y0 + 0.36, zR]);
      }
    }

    // Compute aligned windshield first so A-pillars, cowl, hood & roof join seamlessly
    const pillarH = roofY - beltY;
    const wsTilt = -0.22;
    const wsHeight = pillarH / Math.cos(wsTilt);
    const wsDesiredZ = isMonster ? 1.32 : 1.42;
    const ws = computeWindshieldPlacement(wsHeight, beltY + pillarH * 0.50, wsDesiredZ, wsTilt);

    // Front engine compartment & cowl supporting windshield base seamlessly
    const cowlStartZ = 1.12;
    const frontLen = Math.max(0.90, halfL - cowlStartZ - 0.12);
    addBox(bodyGroup, bodyW, beltY - y0 - 0.06, frontLen, paintMat, [0, y0 + (beltY - y0) * 0.5, cowlStartZ + frontLen * 0.5]);

    // Open recessed dark-bedliner rear bed (z in [-halfL + 0.18, -0.45])
    const bedStartZ = -0.44;
    const bedEndZ = -(halfL - 0.18);
    const bedLen = Math.abs(bedStartZ - bedEndZ);
    const bedCenterZ = (bedStartZ + bedEndZ) * 0.5;
    const bedWallH = beltY - y0 - 0.04;
    // Recessed dark bedliner floor
    addBox(bodyGroup, bodyW - 0.24, 0.12, bedLen, chassisMat, [0, y0 + 0.16, bedCenterZ], null, { name: 'bedliner_floor' });
    // Painted outer bed side walls + dark inner liners
    for (const sx of [1, -1]) {
      addBox(bodyGroup, 0.16, bedWallH, bedLen, paintMat, [sx * (bodyHalfW - 0.08), y0 + bedWallH * 0.5, bedCenterZ]);
    }
    // Cab back wall separating cabin from open bed
    addBox(bodyGroup, bodyW - 0.08, roofY - y0 - 0.08, 0.14, paintMat, [0, y0 + (roofY - y0) * 0.5, bedStartZ + 0.07]);
    addBox(bodyGroup, bodyW - 0.42, (roofY - beltY) * 0.72, 0.04, glassMat, [0, beltY + (roofY - beltY) * 0.46, bedStartZ - 0.01], null, { castShadow: false, receiveShadow: false });

    // Bed roll-bar / roll-cage hoops behind cab
    const hoopY = roofY - 0.04;
    for (const sx of [1, -1]) {
      addCyl(bodyGroup, 0.055, 0.055, hoopY - beltY + 0.14, 8, isMonster ? chromeMat : trimDarkMat, [sx * (bodyHalfW - 0.22), beltY + (hoopY - beltY) * 0.46, bedStartZ - 0.16]);
      addCyl(bodyGroup, 0.048, 0.048, 0.92, 8, isMonster ? chromeMat : trimDarkMat, [sx * (bodyHalfW - 0.22), beltY + 0.30, bedStartZ - 0.54], [0.76, 0, 0]);
    }
    addCyl(bodyGroup, 0.055, 0.055, bodyW - 0.40, 8, isMonster ? chromeMat : trimDarkMat, [0, hoopY + 0.02, bedStartZ - 0.16], [0, 0, Math.PI / 2]);

    // Front grille & lights
    addBox(bodyGroup, bodyW * 0.58, 0.34, 0.08, isMonster ? chromeMat : trimDarkMat, [0, y0 + 0.42, halfL - 0.10]);
    addHeadlight(bodyGroup, 0.34, 0.22, 0.08, [bodyHalfW - 0.28, y0 + 0.44, halfL - 0.09]);
    addHeadlight(bodyGroup, 0.34, 0.22, 0.08, [-(bodyHalfW - 0.28), y0 + 0.44, halfL - 0.09]);
    addTaillight(bodyGroup, 0.18, 0.36, 0.08, [bodyHalfW - 0.12, y0 + 0.44, -(halfL - 0.12)]);
    addTaillight(bodyGroup, 0.18, 0.36, 0.08, [-(bodyHalfW - 0.12), y0 + 0.44, -(halfL - 0.12)]);

    // Open-frame cab A & B pillars aligned flush with windshield edges
    for (const sx of [1, -1]) {
      addBridgingPillar(pillarsGroup, sx * (bodyHalfW - 0.08), 0.10, 0.10, paintMat, beltY, ws.wsBotZ, roofY, ws.wsTopZ);
      addBox(pillarsGroup, 0.09, pillarH, 0.10, trimDarkMat, [sx * (bodyHalfW - 0.08), beltY + pillarH * 0.5, 0.38]);
    }

    buildCabinInterior(bodyW, y0 + 0.16, ws.wsBotZ - 0.24, def.seatOffset, roofY, true);

    // 1. frontBumper (bull-bar steel bumper)
    const frontBumper = new THREE.Group();
    frontBumper.position.set(0, y0 + 0.16, halfL - 0.02);
    bodyGroup.add(frontBumper);
    addBox(frontBumper, bodyW + 0.08, 0.26, 0.22, isMonster ? chromeMat : trimDarkMat, [0, 0, 0]);
    // Bull bar push guard
    addBox(frontBumper, 1.10, 0.06, 0.08, trimDarkMat, [0, 0.30, 0.12]);
    addBox(frontBumper, 0.06, 0.30, 0.08, trimDarkMat, [0.44, 0.16, 0.12]);
    addBox(frontBumper, 0.06, 0.30, 0.08, trimDarkMat, [-0.44, 0.16, 0.12]);
    addPlate(frontBumper, [0, 0, 0.118], false);
    registerPart('frontBumper', frontBumper, 0.14, { loosenPos: [0, -0.12, 0.12], loosenRot: [0.16, 0.14, -0.18], zone: 'front' });

    // 2. rearBumper
    const rearBumper = new THREE.Group();
    rearBumper.position.set(0, y0 + 0.16, -(halfL - 0.04));
    bodyGroup.add(rearBumper);
    addBox(rearBumper, bodyW + 0.06, 0.24, 0.22, isMonster ? chromeMat : trimDarkMat, [0, 0, 0]);
    addPlate(rearBumper, [0, 0, -0.116], true);
    registerPart('rearBumper', rearBumper, 0.18, { loosenPos: [0, -0.12, -0.10], loosenRot: [-0.16, -0.14, 0.16], zone: 'rear' });

    // 3. hood (rear-hinged at windshield base; Monster Truck adds exposed chrome V8 blower scoop!)
    const hoodStartZ = ws.wsBotZ - 0.04;
    const hoodLen = Math.max(0.95, halfL - hoodStartZ - 0.08);
    const hood = new THREE.Group();
    hood.position.set(0, beltY, hoodStartZ);
    bodyGroup.add(hood);
    addBox(hood, bodyW - 0.08, 0.10, hoodLen, paintMat, [0, -0.02, hoodLen * 0.5]);
    if (isMonster) {
      // Exposed chrome supercharger blower scoop rising out of Monster Truck hood!
      addBox(hood, 0.52, 0.28, 0.62, chromeMat, [0, 0.16, hoodLen * 0.45], null, { name: 'monster_blower' });
      addBox(hood, 0.46, 0.14, 0.10, trimDarkMat, [0, 0.22, hoodLen * 0.45 + 0.32], null, { castShadow: false });
      addCyl(hood, 0.06, 0.06, 0.06, 10, taillightMat, [0.12, 0.22, hoodLen * 0.45 + 0.35], [Math.PI / 2, 0, 0], { castShadow: false });
      addCyl(hood, 0.06, 0.06, 0.06, 10, taillightMat, [-0.12, 0.22, hoodLen * 0.45 + 0.35], [Math.PI / 2, 0, 0], { castShadow: false });
    }
    registerPart('hood', hood, 0.28, { loosenPos: [0, 0.05, 0.02], loosenRot: [-0.42, 0.06, 0.05], zone: 'hood' });

    // 4. windshield
    buildWindshieldPart(bodyW - 0.22, wsHeight, beltY + pillarH * 0.50, wsDesiredZ, wsTilt, 0.34);

    // 5 & 6. doorL & doorR
    const doorLen = 1.56;
    buildHingedDoor('doorL', +1, bodyHalfW - 0.04, y0 + (beltY - y0) * 0.5, 1.12, doorLen, beltY - y0 - 0.08, paintMat, 0.42);
    buildHingedDoor('doorR', -1, bodyHalfW - 0.04, y0 + (beltY - y0) * 0.5, 1.12, doorLen, beltY - y0 - 0.08, paintMat, 0.46);

    // 7. trunk (bottom-hinged pickup/monster tailgate -> rotX = -0.85 drops top edge BACKWARD!)
    const tailgateH = bedWallH - 0.04;
    const trunk = new THREE.Group();
    trunk.position.set(0, y0 + 0.16, bedEndZ);
    bodyGroup.add(trunk);
    addBox(trunk, bodyW - 0.26, tailgateH, 0.10, paintMat, [0, tailgateH * 0.5, 0]);
    addBox(trunk, 0.24, 0.07, 0.12, trimDarkMat, [0, tailgateH - 0.14, -0.02], null, { castShadow: false });
    registerPart('trunk', trunk, 0.54, {
      loosenPos: [0, -0.02, -0.04],
      loosenRot: [-0.85, 0.04, 0.04],
      zone: 'trunk',
    });

    // 8. roof (aligned flush with windshield top & cab back wall)
    const roofRearZ = -0.45;
    const roofFrontZ = ws.wsTopZ + 0.02;
    const roofLen = roofFrontZ - roofRearZ;
    const roofZ = (roofFrontZ + roofRearZ) * 0.5;
    const roof = new THREE.Group();
    roof.position.set(0, roofY, roofZ);
    bodyGroup.add(roof);
    addBox(roof, bodyW - 0.12, 0.09, roofLen, paintMat, [0, 0, 0]);
    if (isMonster) {
      // Top off-road light pods on Monster Truck roof
      for (const lx of [-0.48, -0.16, 0.16, 0.48]) {
        addHeadlight(roof, 0.14, 0.12, 0.08, [lx, 0.10, roofLen * 0.5 - 0.14], true);
      }
    }
    registerPart('roof', roof, 0.64, { loosenPos: [0.05, -0.06, 0], loosenRot: [0.09, 0.06, 0.12], zone: 'roof', cabinH: cabinHeightRef });
  };

  const buildSmartMicro = () => {
    const y0 = 0.24;
    const beltY = 0.88;
    const roofY = h - 0.04; // 1.52 m
    cabinHeightRef = roofY - beltY;
    const halfW = w * 0.5;
    const halfL = l * 0.5;
    const bodyW = w - 0.06;

    // Wheels pushed right to the 4 corners!
    addStandardFourWheels({ x: 0.74, zF: 0.94, zR: -0.96, radius: R, tireW: 0.20 });

    // Compact dark Tridion safety cell chassis + C-pillar frame (never recolored!)
    const pillarH = roofY - beltY;
    const wsTilt = -0.26;
    const wsHeight = pillarH / Math.cos(wsTilt);
    const ws = computeWindshieldPlacement(wsHeight, beltY + pillarH * 0.50, 0.84, wsTilt);

    addBox(bodyGroup, bodyW - 0.10, 0.18, l - 0.24, trimDarkMat, [0, y0 + 0.09, 0]);
    const frontCowlLen = Math.max(0.60, (halfL - 0.06) - 0.62);
    addBox(bodyGroup, bodyW - 0.04, beltY - y0 - 0.06, frontCowlLen, paintMat, [0, y0 + (beltY - y0) * 0.5, 0.62 + frontCowlLen * 0.5]);
    addBox(bodyGroup, bodyW - 0.04, beltY - y0 - 0.06, 0.42, paintMat, [0, y0 + (beltY - y0) * 0.5, -(halfL - 0.28)]);

    // Contrasting dark charcoal Tridion A-pillars (aligned flush with windshield) & rear safety cell pillars
    for (const sx of [1, -1]) {
      addBridgingPillar(pillarsGroup, sx * (halfW - 0.09), 0.09, 0.10, trimDarkMat, beltY, ws.wsBotZ, roofY, ws.wsTopZ);
      addBox(pillarsGroup, 0.12, pillarH + 0.20, 0.32, trimDarkMat, [sx * (halfW - 0.08), beltY + pillarH * 0.44, -0.98], [0.10, 0, 0]);
      addBox(bodyGroup, 0.10, 0.16, l - 0.36, trimDarkMat, [sx * (halfW - 0.06), y0 + 0.10, 0]);
    }

    // Front grille & cute wide micro headlights + taillights
    addBox(bodyGroup, 0.78, 0.20, 0.08, trimDarkMat, [0, y0 + 0.34, halfL - 0.06]);
    addHeadlight(bodyGroup, 0.26, 0.22, 0.08, [halfW - 0.24, y0 + 0.44, halfL - 0.06], true);
    addHeadlight(bodyGroup, 0.26, 0.22, 0.08, [-(halfW - 0.24), y0 + 0.44, halfL - 0.06], true);
    addTaillight(bodyGroup, 0.24, 0.28, 0.08, [halfW - 0.22, y0 + 0.48, -(halfL - 0.06)]);
    addTaillight(bodyGroup, 0.24, 0.28, 0.08, [-(halfW - 0.22), y0 + 0.48, -(halfL - 0.06)]);

    buildCabinInterior(bodyW, y0 + 0.14, ws.wsBotZ - 0.18, def.seatOffset, roofY, true);

    // 1. frontBumper
    const frontBumper = new THREE.Group();
    frontBumper.position.set(0, y0 + 0.14, halfL - 0.01);
    bodyGroup.add(frontBumper);
    addBox(frontBumper, w - 0.02, 0.24, 0.18, paintAccentMat, [0, 0, 0]);
    addPlate(frontBumper, [0, 0, 0.096], false, null, 0.38, 0.18);
    registerPart('frontBumper', frontBumper, 0.14, { loosenPos: [0, -0.05, 0.10], loosenRot: [0.12, 0.12, -0.10], zone: 'front' });

    // 2. rearBumper
    const rearBumper = new THREE.Group();
    rearBumper.position.set(0, y0 + 0.14, -(halfL - 0.01));
    bodyGroup.add(rearBumper);
    addBox(rearBumper, w - 0.02, 0.24, 0.18, trimDarkMat, [0, 0, 0]);
    addPlate(rearBumper, [0, 0, -0.096], true, null, 0.38, 0.18);
    registerPart('rearBumper', rearBumper, 0.18, { loosenPos: [0, -0.05, -0.10], loosenRot: [-0.12, -0.12, 0.10], zone: 'rear' });

    // 3. hood (stubby sloped front nose panel joining windshield cowl)
    const hoodStartZ = ws.wsBotZ - 0.04;
    const hoodLen = Math.max(0.42, halfL - hoodStartZ - 0.05);
    const hood = new THREE.Group();
    hood.position.set(0, beltY, hoodStartZ);
    bodyGroup.add(hood);
    addBox(hood, bodyW - 0.08, 0.09, hoodLen, paintMat, [0, -0.05, hoodLen * 0.5], [0.24, 0, 0]);
    registerPart('hood', hood, 0.28, { loosenPos: [0, 0.04, 0.02], loosenRot: [-0.42, 0.06, 0.05], zone: 'hood' });

    // 4. windshield
    buildWindshieldPart(bodyW - 0.20, wsHeight, beltY + pillarH * 0.50, 0.84, wsTilt, 0.34);

    // 5 & 6. doorL & doorR (single wide micro doors)
    buildHingedDoor('doorL', +1, halfW - 0.04, y0 + (beltY - y0) * 0.5, 0.62, 1.38, beltY - y0 - 0.08, paintMat, 0.42);
    buildHingedDoor('doorR', -1, halfW - 0.04, y0 + (beltY - y0) * 0.5, 0.62, 1.38, beltY - y0 - 0.08, paintMat, 0.46);

    // 7. trunk (upright rear micro hatch)
    const trunk = new THREE.Group();
    trunk.position.set(0, roofY - 0.06, -1.16);
    bodyGroup.add(trunk);
    const hatchH = roofY - y0 - 0.22;
    addBox(trunk, bodyW - 0.20, hatchH * 0.48, 0.10, paintMat, [0, -hatchH * 0.72, -0.14]);
    addBox(trunk, bodyW - 0.26, hatchH * 0.46, 0.03, darkGlassMat, [0, -hatchH * 0.24, -0.12], [0.08, 0, 0], { castShadow: false, receiveShadow: false });
    registerPart('trunk', trunk, 0.54, { loosenPos: [0, 0.05, -0.05], loosenRot: [0.48, -0.06, 0.05], zone: 'trunk' });

    // 8. roof (panoramic dark-tinted glass roof inside Tridion frame aligned flush with windshield top!)
    const roofRearZ = -1.05;
    const roofFrontZ = ws.wsTopZ + 0.02;
    const rLen = roofFrontZ - roofRearZ;
    const roofZ = (roofFrontZ + roofRearZ) * 0.5;
    const roof = new THREE.Group();
    roof.position.set(0, roofY, roofZ);
    bodyGroup.add(roof);
    const rW = bodyW - 0.12;
    // Tridion perimeter frame
    addBox(roof, rW, 0.07, 0.16, trimDarkMat, [0, 0, rLen * 0.5 - 0.08]);
    addBox(roof, rW, 0.07, 0.16, trimDarkMat, [0, 0, -(rLen * 0.5 - 0.08)]);
    addBox(roof, 0.14, 0.07, rLen, trimDarkMat, [rW * 0.5 - 0.07, 0, 0]);
    addBox(roof, 0.14, 0.07, rLen, trimDarkMat, [-(rW * 0.5 - 0.07), 0, 0]);
    // Panoramic tinted glass skylight
    addBox(roof, rW - 0.24, 0.04, rLen - 0.28, darkGlassMat, [0, 0.01, 0], null, { castShadow: false, receiveShadow: false, name: 'panoramic_glass_roof' });
    registerPart('roof', roof, 0.64, { loosenPos: [0.04, -0.05, 0], loosenRot: [0.09, 0.06, 0.12], zone: 'roof', cabinH: cabinHeightRef });
  };

  const buildBeetle = () => {
    const y0 = 0.26;
    const beltY = 0.86;
    const roofY = h - 0.04; // 1.48 m
    cabinHeightRef = roofY - beltY;
    const halfW = w * 0.5;
    const halfL = l * 0.5;
    const bodyW = w - 0.14;

    addStandardFourWheels({ x: 0.80, zF: 1.26, zR: -1.26, radius: R, tireW: 0.22, hubChrome: true });

    // Lower chassis & running boards
    addBox(bodyGroup, bodyW - 0.12, 0.16, l - 0.36, chassisMat, [0, y0 + 0.08, 0]);
    for (const sx of [1, -1]) {
      addBox(bodyGroup, 0.18, 0.06, 1.38, trimDarkMat, [sx * (halfW - 0.08), y0 + 0.08, 0]);
      // Iconic bulging rounded Beetle wheel fenders (front & rear arches)
      addCyl(bodyGroup, 0.44, 0.44, 0.32, 12, paintMat, [sx * (halfW - 0.16), y0 + 0.34, 1.26], [0, 0, Math.PI / 2]);
      addCyl(bodyGroup, 0.44, 0.44, 0.32, 12, paintMat, [sx * (halfW - 0.16), y0 + 0.34, -1.26], [0, 0, Math.PI / 2]);
      // Iconic round bug-eye headlights atop front fenders!
      addCyl(bodyGroup, 0.14, 0.15, 0.18, 12, chromeMat, [sx * (halfW - 0.22), y0 + 0.58, 1.56], [Math.PI / 2, 0, 0]);
      addHeadlight(bodyGroup, 0.22, 0.22, 0.04, [sx * (halfW - 0.22), y0 + 0.58, 1.66], true);
      // Small oval retro taillights on rear fenders
      addTaillight(bodyGroup, 0.14, 0.20, 0.10, [sx * (halfW - 0.22), y0 + 0.46, -1.66]);
    }

    // Center front & rear rounded body tubs
    addBox(bodyGroup, bodyW - 0.28, beltY - y0 - 0.12, 0.92, paintMat, [0, y0 + 0.30, 1.26]);
    addBox(bodyGroup, bodyW - 0.28, beltY - y0 - 0.10, 0.96, paintMat, [0, y0 + 0.32, -1.22]);

    // Arched cabin pillars aligned flush with windshield placement
    const cabinW = bodyW - 0.18;
    const pillarH = roofY - beltY;
    const wsTilt = -0.26;
    const wsHeight = pillarH * 0.94;
    const ws = computeWindshieldPlacement(wsHeight, beltY + pillarH * 0.48, 0.88, wsTilt);
    for (const sx of [1, -1]) {
      addBridgingPillar(pillarsGroup, sx * (cabinW * 0.5 - 0.05), 0.08, 0.08, paintMat, ws.wsBotY - 0.02, ws.wsBotZ, ws.wsTopY, ws.wsTopZ);
      addBox(pillarsGroup, 0.08, pillarH, 0.09, paintMat, [sx * (cabinW * 0.5 - 0.05), beltY + pillarH * 0.50, -0.06]);
      addBox(pillarsGroup, 0.10, pillarH * 0.96, 0.12, paintMat, [sx * (cabinW * 0.5 - 0.05), beltY + pillarH * 0.46, -0.86], [0.42, 0, 0]);
    }
    // Rounded split rear window
    addBox(pillarsGroup, cabinW - 0.26, pillarH * 0.68, 0.024, glassMat, [0, beltY + pillarH * 0.46, -1.02], [0.56, 0, 0], { castShadow: false, receiveShadow: false });

    buildCabinInterior(bodyW, y0 + 0.14, ws.wsBotZ - 0.20, def.seatOffset, roofY, true);

    // 1. frontBumper (slim chrome tube bumper with vertical overriders)
    const frontBumper = new THREE.Group();
    frontBumper.position.set(0, y0 + 0.16, halfL - 0.04);
    bodyGroup.add(frontBumper);
    addBox(frontBumper, w - 0.10, 0.11, 0.12, chromeMat, [0, 0, 0]);
    addBox(frontBumper, 0.07, 0.24, 0.14, chromeMat, [0.42, 0.04, 0.02]);
    addBox(frontBumper, 0.07, 0.24, 0.14, chromeMat, [-0.42, 0.04, 0.02]);
    addPlate(frontBumper, [0, -0.01, 0.070], false, null, 0.38, 0.18);
    registerPart('frontBumper', frontBumper, 0.14, { loosenPos: [0, -0.05, 0.10], loosenRot: [0.12, 0.12, -0.10], zone: 'front' });

    // 2. rearBumper (slim chrome tube bumper)
    const rearBumper = new THREE.Group();
    rearBumper.position.set(0, y0 + 0.16, -(halfL - 0.04));
    bodyGroup.add(rearBumper);
    addBox(rearBumper, w - 0.10, 0.11, 0.12, chromeMat, [0, 0, 0]);
    addBox(rearBumper, 0.07, 0.24, 0.14, chromeMat, [0.42, 0.04, -0.02]);
    addBox(rearBumper, 0.07, 0.24, 0.14, chromeMat, [-0.42, 0.04, -0.02]);
    addPlate(rearBumper, [0, -0.01, -0.070], true, null, 0.38, 0.18);
    registerPart('rearBumper', rearBumper, 0.18, { loosenPos: [0, -0.05, -0.10], loosenRot: [-0.12, -0.12, 0.10], zone: 'rear' });

    // 3. hood (sloped rounded front bonnet meeting windshield base cleanly)
    const hoodStartZ = ws.wsBotZ - 0.04;
    const hoodLen = Math.max(0.84, halfL - hoodStartZ - 0.14);
    const hood = new THREE.Group();
    hood.position.set(0, beltY - 0.02, hoodStartZ);
    bodyGroup.add(hood);
    addBox(hood, bodyW - 0.44, 0.12, hoodLen, paintMat, [0, -0.08, hoodLen * 0.5], [0.22, 0, 0]);
    addBox(hood, 0.06, 0.04, hoodLen - 0.12, chromeMat, [0, -0.01, hoodLen * 0.5], [0.22, 0, 0], { castShadow: false });
    registerPart('hood', hood, 0.28, { loosenPos: [0, 0.04, 0.02], loosenRot: [-0.42, 0.06, 0.05], zone: 'hood' });

    // 4. windshield
    buildWindshieldPart(cabinW - 0.12, wsHeight, beltY + pillarH * 0.48, 0.88, wsTilt, 0.34);

    // 5 & 6. doorL & doorR
    buildHingedDoor('doorL', +1, bodyW * 0.5 - 0.02, y0 + (beltY - y0) * 0.5, 0.64, 1.32, beltY - y0 - 0.08, paintMat, 0.42);
    buildHingedDoor('doorR', -1, bodyW * 0.5 - 0.02, y0 + (beltY - y0) * 0.5, 0.64, 1.32, beltY - y0 - 0.08, paintMat, 0.46);

    // 7. trunk (fastback rear engine deck with dark cooling louvers)
    const trunk = new THREE.Group();
    trunk.position.set(0, beltY + 0.04, -1.04);
    bodyGroup.add(trunk);
    addBox(trunk, bodyW - 0.44, 0.12, 0.88, paintMat, [0, -0.16, -0.44], [-0.44, 0, 0]);
    for (let lz = -0.22; lz >= -0.58; lz -= 0.12) {
      addBox(trunk, bodyW - 0.72, 0.025, 0.05, trimDarkMat, [0, -0.06 + (lz + 0.22) * 0.45, lz], [-0.44, 0, 0], { castShadow: false });
    }
    registerPart('trunk', trunk, 0.54, { loosenPos: [0, 0.05, -0.04], loosenRot: [0.48, -0.06, 0.05], zone: 'trunk' });

    // 8. roof (classic multi-segment arched Beetle dome roof with front brow meeting windshield top!)
    const roof = new THREE.Group();
    const roofCenterZ = -0.12;
    roof.position.set(0, roofY, roofCenterZ);
    bodyGroup.add(roof);
    addBox(roof, cabinW - 0.04, 0.09, 1.06, paintMat, [0, 0, 0]);
    const browStartZ = 0.38;
    const browEndZ = ws.wsTopZ + 0.02;
    const browStartY = roofY - 0.01;
    const browEndY = ws.wsTopY;
    const browDz = browEndZ - browStartZ;
    const browDy = browEndY - browStartY;
    const browLen = Math.hypot(browDz, browDy) + 0.04;
    const browRotX = Math.atan2(-browDy, browDz);
    addBox(
      roof,
      cabinW - 0.10,
      0.08,
      browLen,
      paintMat,
      [0, (browStartY + browEndY) * 0.5 - roofY, (browStartZ + browEndZ) * 0.5 - roofCenterZ],
      [browRotX, 0, 0],
    );
    addBox(roof, cabinW - 0.10, 0.08, 0.56, paintMat, [0, -0.08, -0.68], [-0.34, 0, 0]);
    registerPart('roof', roof, 0.64, { loosenPos: [0.04, -0.05, 0], loosenRot: [0.09, 0.06, 0.12], zone: 'roof', cabinH: cabinHeightRef });
  };

  // Dispatch exact silhouette builder
  switch (def.builderKey) {
    case 'compact':
      buildSedanLike('compact');
      break;
    case 'rally_raider':
      buildSedanLike('rally_raider');
      break;
    case 'van':
      buildVan();
      break;
    case 'box_truck':
      buildBoxTruck();
      break;
    case 'semi_truck':
      buildSemiTruck();
      break;
    case 'school_bus':
      buildSchoolBus();
      break;
    case 'tuk_tuk':
      buildTukTuk();
      break;
    case 'pickup':
      buildPickupOrMonster(false);
      break;
    case 'monster_truck':
      buildPickupOrMonster(true);
      break;
    case 'smart_micro':
      buildSmartMicro();
      break;
    case 'beetle':
      buildBeetle();
      break;
    case 'sedan':
    default:
      buildSedanLike('sedan');
      break;
  }

  // Enforce Guardrail 2 on the entire constructed vehicle tree (when non-IBL)
  if (!targetScene || !targetScene.environment) {
    enforceMaterialGuardrails(root);
  }

  // =========================================================================
  // RUNTIME STATE, DEFORMATION, LOOSENING, DETACHMENT, RESET & DISPOSAL
  // =========================================================================

  let curDamage = 0;
  let curCrushY = 0;
  let curFrontCrumple = 0;
  let curSideSkew = 0;
  let curSpinRad = 0;
  let curSteerRad = 0;
  let lightsOn = true;
  let disposed = false;

  const _tmpColor = new THREE.Color();
  const _tmpWorldPos = new THREE.Vector3();
  const _tmpWorldQuat = new THREE.Quaternion();
  const _tmpWorldScale = new THREE.Vector3();
  const _tmpBox = new THREE.Box3();
  const _tmpCenter = new THREE.Vector3();
  const _tmpSize = new THREE.Vector3();

  function syncPaintAndGlass() {
    const d = curDamage;
    const fc = curFrontCrumple;
    const cy = curCrushY;

    // Non-destructive paint scorch blend for damage > 0.25
    const scorchT = d > 0.25 ? ((d - 0.25) / 0.75) * 0.68 : 0;
    _tmpColor.copy(basePaintColor).lerp(SCORCH_COLOR, scorchT);
    const paintRough = 0.36 + scorchT * 0.76;
    for (let i = 0; i < paintMaterials.length; i += 1) {
      paintMaterials[i].color.copy(_tmpColor);
      paintMaterials[i].roughness = clamp(paintRough, 0.36, 0.90);
    }

    // Progressive windshield frost + spiderweb crack overlay
    const wsLoose = hasOwn.call(partsMap, 'windshield') && partsMap.windshield.state === 'loose';
    const crack = clamp01(Math.max(d * 1.15 - 0.15, fc * 1.1, cy * 0.9, wsLoose ? 0.85 : 0));
    glassMat.opacity = 0.34 + crack * 0.52; // 0.34 intact -> 0.86 cracked
    glassMat.color.copy(GLASS_INTACT_COLOR).lerp(GLASS_CRACKED_COLOR, crack);
    glassMat.roughness = 0.16 + crack * 0.68;
    if (crackOverlayGroup) {
      crackOverlayGroup.visible = crack > 0.35;
    }
  }

  function syncTransforms() {
    const cy = curCrushY;
    const fc = curFrontCrumple;
    const sk = curSideSkew;

    // Body core pancake crush, accordion front compression & chassis skew (keeps chassis > y = 0!)
    const rollZ = sk * 0.11;
    bodyGroup.scale.set(
      1 + cy * 0.12 + fc * 0.05,
      Math.max(0.50, 1 - cy * 0.44),
      Math.max(0.76, 1 - fc * 0.14),
    );
    bodyGroup.rotation.set(
      0,
      sk * 0.07,
      rollZ,
    );
    bodyGroup.position.set(0, Math.abs(Math.sin(rollZ)) * (w * 0.56) + cy * 0.02, 0);

    // Greenhouse pillars compress heavily under top crush
    pillarsGroup.scale.set(1, Math.max(0.40, 1 - cy * 0.48), 1);

    // Order-independent per-part transforms computed strictly from immutable homePos / homeRot
    const keys = Object.keys(partsMap);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const entry = partsMap[k];
      if (entry.state === 'detached') continue;
      const meta = partMeta.get(k);
      const mesh = entry.mesh;

      let px = entry.homePos.x;
      let py = entry.homePos.y;
      let pz = entry.homePos.z;
      let rx = entry.homeRot.x;
      let ry = entry.homeRot.y;
      let rz = entry.homeRot.z;
      let sx = 1;
      let sy = 1;
      let sz = 1;

      // Deformation contribution by zone
      if (meta.zone === 'front') {
        pz -= fc * 0.32;
        py -= fc * 0.02;
        ry += sk * 0.12;
        rz += sk * 0.05;
      } else if (meta.zone === 'hood') {
        pz -= fc * 0.20;
        rx -= fc * 0.22 + cy * 0.04;
        rz += sk * 0.06;
        sz = Math.max(0.74, 1 - fc * 0.20);
      } else if (meta.zone === 'rear') {
        pz += fc * 0.08;
        ry -= sk * 0.08;
      } else if (meta.zone === 'trunk') {
        rx += cy * 0.08;
        rz += sk * 0.06;
      } else if (meta.zone === 'cargoBox') {
        sy = Math.max(0.58, 1 - cy * 0.36);
        sx = 1 + cy * 0.10;
        py -= cy * 0.32;
        rz += sk * 0.07;
      } else if (meta.zone === 'roof') {
        py -= cy * meta.cabinH * 0.38;
        sx = 1 + cy * 0.08;
        rx += fc * 0.04;
        rz += sk * 0.06;
      } else if (meta.zone === 'doorL') {
        ry -= cy * 0.12 + Math.abs(sk) * 0.10;
        rz += sk * 0.06;
      } else if (meta.zone === 'doorR') {
        ry += cy * 0.12 + Math.abs(sk) * 0.10;
        rz += sk * 0.06;
      } else if (meta.zone === 'windshield') {
        py -= cy * 0.14;
        rx -= fc * 0.12;
      } else if (meta.isWheel) {
        // Outward negative camber under heavy crush (analytically grounded at y >= 0!)
        const camber = cy > 0.25 ? (cy - 0.25) * 0.34 : 0;
        const sideSign = meta.wheelSide === 0 ? 1 : meta.wheelSide;
        rz += sideSign * camber;
      }

      // Additive loose pose when state === 'loose'
      if (entry.state === 'loose') {
        px += meta.loosenPos[0];
        py += meta.loosenPos[1];
        pz += meta.loosenPos[2];
        rx += meta.loosenRot[0];
        ry += meta.loosenRot[1];
        rz += meta.loosenRot[2];
      }

      if (meta.isWheel) {
        // Analytical tilted-cylinder clearance so tilted/cambered/steered wheels NEVER clip below y = 0
        const absTilt = Math.abs(rz);
        const exactMinY = meta.wheelRadius * Math.cos(absTilt)
          + (meta.tireW * 0.5 + meta.wheelRadius * 0.35) * Math.sin(absTilt);
        py = Math.max(py, exactMinY);
      } else if ((meta.zone === 'front' || meta.zone === 'rear') && meta.localBounds) {
        // Exact analytical ground-clearance floor clamp in bodyGroup's scaled & rolled frame so
        // intact, loosened, or heavily deformed/skewed bumpers NEVER penetrate below y = 0!
        const lb = meta.localBounds;
        const bodyScaleX = bodyGroup.scale.x;
        const bodyScaleY = bodyGroup.scale.y;
        const bodyPosY = bodyGroup.position.y;
        const sinRoll = Math.sin(rollZ);
        const cosRoll = Math.cos(rollZ);

        // Exact XYZ Euler rotation rows 0 (X) and 1 (Y) for part rotation (rx, ry, rz)
        const cRx = Math.cos(rx);
        const sRx = Math.sin(rx);
        const cRy = Math.cos(ry);
        const sRy = Math.sin(ry);
        const cRz = Math.cos(rz);
        const sRz = Math.sin(rz);

        const m00 = cRy * cRz;
        const m01 = -cRy * sRz;
        const m02 = sRy;
        const m10 = cRx * sRz + sRx * sRy * cRz;
        const m11 = cRx * cRz - sRx * sRy * sRz;
        const m12 = -sRx * cRy;

        // Linear world-Y weights along part local axes (scaled by sx, sy, sz)
        const ax = (bodyScaleX * sinRoll * m00 + bodyScaleY * cosRoll * m10) * sx;
        const ay = (bodyScaleX * sinRoll * m01 + bodyScaleY * cosRoll * m11) * sy;
        const az = (bodyScaleX * sinRoll * m02 + bodyScaleY * cosRoll * m12) * sz;

        const minLocalYContrib = (ax >= 0 ? ax * lb.minX : ax * lb.maxX)
          + (ay >= 0 ? ay * lb.minY : ay * lb.maxY)
          + (az >= 0 ? az * lb.minZ : az * lb.maxZ);

        const denom = Math.max(0.05, bodyScaleY * cosRoll);
        const minPy = (0.015 - bodyPosY - bodyScaleX * sinRoll * px - minLocalYContrib) / denom;
        if (py < minPy) {
          py = minPy;
        }
      }

      mesh.position.set(px, py, pz);
      mesh.rotation.set(rx, ry, rz);
      mesh.scale.set(sx, sy, sz);
    }

    syncPaintAndGlass();
  }

  function applyDeformation(damageRatio = 0, crushY = 0, frontCrumple = 0, sideSkew = 0) {
    if (disposed) return;
    curDamage = clamp01(damageRatio);
    curCrushY = clamp01(crushY);
    curFrontCrumple = clamp01(frontCrumple);
    curSideSkew = Number.isFinite(sideSkew) ? clamp(sideSkew, -1, 1) : 0;
    syncTransforms();
  }

  function loosenPart(partKey) {
    if (disposed || !hasOwn.call(partsMap, partKey)) return false;
    const entry = partsMap[partKey];
    if (entry.state !== 'intact') return false;
    entry.state = 'loose';
    syncTransforms();
    return true;
  }

  function detachPart(partKey) {
    if (disposed || !hasOwn.call(partsMap, partKey)) return null;
    const entry = partsMap[partKey];
    if (entry.state === 'detached') return null;

    root.updateMatrixWorld(true);
    entry.mesh.matrixWorld.decompose(_tmpWorldPos, _tmpWorldQuat, _tmpWorldScale);

    // Standalone center-of-mass recentered clone (race-free against dispose() & resetVisuals())
    const innerClone = cloneStandaloneSubtree(entry.mesh);
    innerClone.visible = true;
    innerClone.position.set(0, 0, 0);
    innerClone.rotation.set(0, 0, 0);
    innerClone.quaternion.identity();
    innerClone.scale.copy(_tmpWorldScale);
    innerClone.updateMatrixWorld(true);

    _tmpBox.setFromObject(innerClone);
    if (!_tmpBox.isEmpty()) {
      _tmpBox.getCenter(_tmpCenter);
      _tmpBox.getSize(_tmpSize);
    } else {
      _tmpCenter.set(0, 0, 0);
      _tmpSize.set(0.4, 0.4, 0.4);
    }

    innerClone.position.copy(_tmpCenter).negate();

    const debrisRoot = new THREE.Group();
    debrisRoot.name = `debris_${def.id}_${partKey}`;
    debrisRoot.add(innerClone);

    const worldPos = _tmpCenter.clone().applyQuaternion(_tmpWorldQuat).add(_tmpWorldPos);
    const worldQuat = _tmpWorldQuat.clone();
    const debrisRadius = clamp(_tmpSize.length() * 0.30, 0.18, 1.25);

    debrisRoot.userData = {
      partKey,
      ownsGeometry: true,
      ownsMaterial: true,
      ownsTextures: false,
      debrisRadius,
    };

    entry.state = 'detached';
    entry.mesh.visible = false;
    if (partKey === 'windshield') {
      syncPaintAndGlass();
    }

    return {
      mesh: debrisRoot,
      worldPos,
      worldQuat,
    };
  }

  function setWheelSpin(spinRad = 0, steerRad = 0) {
    if (disposed) return;
    curSpinRad = Number.isFinite(spinRad) ? spinRad : 0;
    curSteerRad = Number.isFinite(steerRad) ? clamp(steerRad, -0.75, 0.75) : 0;

    for (let i = 0; i < wheels.length; i += 1) {
      const wh = wheels[i];
      wh.steerPivot.rotation.y = curSteerRad * wh.steerFactor;
      wh.spinGroup.rotation.x = curSpinRad;
    }

    if (steeringControlObj) {
      steeringControlObj.rotation[steeringControlAxis] = curSteerRad * steeringControlSign;
    }
  }

  function setLights(on) {
    if (disposed) return;
    lightsOn = Boolean(on);
    headlightMat.emissiveIntensity = lightsOn ? 0.88 : 0.0;
    taillightMat.emissiveIntensity = lightsOn ? 0.78 : 0.05;
    for (let i = 0; i < auxLightMaterials.length; i += 1) {
      auxLightMaterials[i].emissiveIntensity = lightsOn ? 0.65 : 0.0;
    }
    for (let i = 0; i < cockpitBulbMaterials.length; i += 1) {
      cockpitBulbMaterials[i].emissiveIntensity = lightsOn ? 1.15 : 0.05;
    }
  }

  function setColor(hex) {
    if (disposed) return;
    basePaintColor.copy(parseColorSafe(hex, def.defaultColor));
    syncPaintAndGlass();
  }

  function resetVisuals() {
    if (disposed) return;
    curDamage = 0;
    curCrushY = 0;
    curFrontCrumple = 0;
    curSideSkew = 0;

    const keys = Object.keys(partsMap);
    for (let i = 0; i < keys.length; i += 1) {
      const entry = partsMap[keys[i]];
      entry.state = 'intact';
      entry.mesh.visible = true;
    }

    syncTransforms();
    setWheelSpin(0, 0);
    setLights(true);
    root.updateMatrixWorld(true);
  }

  function getIntactPartCount() {
    let count = 0;
    const keys = Object.keys(partsMap);
    for (let i = 0; i < keys.length; i += 1) {
      if (partsMap[keys[i]].state === 'intact') count += 1;
    }
    return count;
  }

  function getTotalPartCount() {
    return Object.keys(partsMap).length;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (root.parent) {
      root.parent.remove(root);
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

  // Ensure initial pristine transforms & matrices are synced
  syncTransforms();
  setLights(true);
  root.updateMatrixWorld(true);

  return {
    root,
    bodyGroup,
    partsMap,
    wheels,
    plateCode,
    headlights,
    taillights,
    applyDeformation,
    loosenPart,
    detachPart,
    setWheelSpin,
    setLights,
    setColor,
    resetVisuals,
    getIntactPartCount,
    getTotalPartCount,
    dispose,
  };
}
