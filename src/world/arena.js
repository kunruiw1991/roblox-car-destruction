/**
 * Unified 3D Roblox Destruction World Assembler & Spatial Hazard API (Contract #13).
 *
 * Composes hub_lab.js, crushers.js, and stunts_arenas.js into one seamless 480m x 480m
 * sandbox world, enforces non-IBL material guardrails on boot, drives all machine/AI/ball
 * animations, serves analytical ground heights & unit normals via a priority-sorted
 * SurfaceRegion registry, and exposes deterministic HazardImpact & manual trigger APIs.
 */

import * as THREE from '../../vendor/three.module.min.js';
import { enforceMaterialGuardrails } from '../core/materials.js';
import { createTextureLibrary } from './textures.js';
import { createHubLabWorld } from './hub_lab.js';
import { createCrushers } from './crushers.js';
import { createStuntsAndArenas } from './stunts_arenas.js';

const MAX_IMPULSE_MAG = 42.0;

const SEVERITY_RANK = {
  danger: 0,
  warn: 1,
  info: 2,
};

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function finiteOr(val, fallback) {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function positiveFiniteOr(val, fallback) {
  return typeof val === 'number' && Number.isFinite(val) && val > 0 ? val : fallback;
}

function sanitizeImpact(raw) {
  const imp = Array.isArray(raw.impulse) ? raw.impulse : [0, 0, 0];
  let ix = finiteOr(imp[0], 0);
  let iy = finiteOr(imp[1], 0);
  let iz = finiteOr(imp[2], 0);
  const mag = Math.hypot(ix, iy, iz);
  if (mag > MAX_IMPULSE_MAG && mag > 1e-6) {
    const scale = MAX_IMPULSE_MAG / mag;
    ix *= scale;
    iy *= scale;
    iz *= scale;
  }

  return {
    kind: String(raw.kind || 'pillar'),
    damage: Math.max(0, finiteOr(raw.damage, 0)),
    impulse: [ix, iy, iz],
    crushY: clamp(finiteOr(raw.crushY, 0), 0, 1),
    frontCrumple: clamp(finiteOr(raw.frontCrumple, 0), 0, 1),
    cashBonus: Math.max(0, finiteOr(raw.cashBonus, 0)),
    xpBonus: Math.max(0, finiteOr(raw.xpBonus, 0)),
    label: String(raw.label || ''),
    sound: String(raw.sound || 'crash'),
    ignite: Boolean(raw.ignite),
    explode: Boolean(raw.explode),
    ejectRagdoll: Boolean(raw.ejectRagdoll),
  };
}

/**
 * Creates the complete unified 3D Roblox Car Destruction world and mounts it into `scene`.
 *
 * @param {THREE.Scene} scene
 * @param {ReturnType<import('./textures.js').createTextureLibrary>|null} [textures]
 */
export function createDestructionWorld(scene, textures = null) {
  const ownsTextureLib = !textures;
  const texLib = textures || createTextureLibrary();

  const root = new THREE.Group();
  root.name = 'destruction_world';

  const hubLab = createHubLabWorld(scene, texLib);
  const crushers = createCrushers(scene, texLib);
  const stuntsArenas = createStuntsAndArenas(scene, texLib);
  const sections = [hubLab, crushers, stuntsArenas];

  for (let i = 0; i < sections.length; i += 1) {
    root.add(sections[i].group);
  }

  if (scene && typeof scene.add === 'function') {
    scene.add(root);
  }

  // Guardrail 2: sweep scene materials & Sprites immediately after mounting world
  enforceMaterialGuardrails(scene || root);

  // Collect & priority-sort all analytical SurfaceRegions (descending priority)
  const sortedRegions = [];
  for (let i = 0; i < sections.length; i += 1) {
    const list = sections[i].surfaceRegions;
    if (Array.isArray(list)) {
      for (let j = 0; j < list.length; j += 1) {
        sortedRegions.push(list[j]);
      }
    }
  }
  sortedRegions.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  const sampleWorldSurface = (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return { y: 0, nx: 0, ny: 1, nz: 0 };
    }
    for (let i = 0; i < sortedRegions.length; i += 1) {
      const r = sortedRegions[i];
      if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) continue;
      const hit = r.sample(x, z);
      if (hit !== null) {
        const y = finiteOr(hit.y, 0);
        const gx = clamp(finiteOr(hit.gx, 0), -4.0, 4.0);
        const gz = clamp(finiteOr(hit.gz, 0), -4.0, 4.0);
        const inv = 1 / Math.hypot(gx, 1, gz);
        return { y, nx: -gx * inv, ny: inv, nz: -gz * inv };
      }
    }
    return { y: 0, nx: 0, ny: 1, nz: 0 };
  };

  const getGroundHeight = (x, z) => sampleWorldSurface(x, z).y;

  const getSlopeNormal = (x, z, out = null) => {
    const s = sampleWorldSurface(x, z);
    const target = out && typeof out.set === 'function' ? out : new THREE.Vector3();
    return target.set(s.nx, s.ny, s.nz);
  };

  // Pre-allocated normalized vehicleState struct (zero per-frame allocations)
  const normVeh = {
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
    speedKmh: 0,
    dimensions: { w: 2.1, h: 1.5, l: 4.5 },
    radius: 2.0,
    mass: 1600,
    isAirborne: false,
  };

  const normalizeVehicleState = (raw) => {
    if (!raw || typeof raw !== 'object') {
      normVeh.valid = false;
      return normVeh;
    }
    const pos = raw.position || raw.pos;
    const x = Array.isArray(pos) ? pos[0] : pos?.x;
    const y = Array.isArray(pos) ? pos[1] : pos?.y;
    const z = Array.isArray(pos) ? pos[2] : pos?.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      normVeh.valid = false;
      return normVeh;
    }

    const vel = raw.velocity || raw.vel;
    const vx = finiteOr(Array.isArray(vel) ? vel[0] : vel?.x, 0);
    const vy = finiteOr(Array.isArray(vel) ? vel[1] : vel?.y, 0);
    const vz = finiteOr(Array.isArray(vel) ? vel[2] : vel?.z, 0);
    const yaw = finiteOr(raw.yaw, 0);
    const speed = Number.isFinite(raw.speed)
      ? Math.max(0, raw.speed)
      : (Number.isFinite(raw.speedKmh) ? Math.max(0, raw.speedKmh / 3.6) : Math.hypot(vx, vy, vz));
    const speedKmh = Number.isFinite(raw.speedKmh) ? Math.max(0, raw.speedKmh) : speed * 3.6;

    const w = positiveFiniteOr(raw.dimensions?.w, 2.1);
    const h = positiveFiniteOr(raw.dimensions?.h, 1.5);
    const l = positiveFiniteOr(raw.dimensions?.l, 4.5);
    const radius = Number.isFinite(raw.radius) && raw.radius > 0 ? raw.radius : Math.max(w, l) * 0.44;
    const mass = Number.isFinite(raw.mass) && raw.mass > 0 ? raw.mass : 1600;
    const isAirborne = typeof raw.isAirborne === 'boolean'
      ? raw.isAirborne
      : (y > getGroundHeight(x, z) + 0.65);

    normVeh.valid = true;
    normVeh.id = String(raw.id || raw.vehicleId || 'player');
    normVeh.x = x;
    normVeh.y = y;
    normVeh.z = z;
    normVeh.vx = vx;
    normVeh.vy = vy;
    normVeh.vz = vz;
    normVeh.yaw = yaw;
    normVeh.speed = speed;
    normVeh.speedKmh = speedKmh;
    normVeh.dimensions.w = w;
    normVeh.dimensions.h = h;
    normVeh.dimensions.l = l;
    normVeh.radius = radius;
    normVeh.mass = mass;
    normVeh.isAirborne = isAirborne;
    return normVeh;
  };

  let simTime = 0;
  let disposed = false;
  const hazardCooldowns = new Map();

  const hazardCtx = {
    get simTime() {
      return simTime;
    },
    canHit(key, cooldownSec = 0.4) {
      const cd = finiteOr(cooldownSec, 0.4);
      const last = hazardCooldowns.get(key);
      if (last !== undefined && simTime - last < cd) {
        return false;
      }
      hazardCooldowns.set(key, simTime);
      return true;
    },
  };

  const update = (dt, vehicleState = null) => {
    if (disposed) return;
    const safeDt = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 0;
    simTime += safeDt;
    const veh = normalizeVehicleState(vehicleState);
    for (let i = 0; i < sections.length; i += 1) {
      sections[i].update(safeDt, veh);
    }
  };

  const queryHazards = (vehicleState = null) => {
    if (disposed) return [];
    const veh = normalizeVehicleState(vehicleState);
    const results = [];
    for (let i = 0; i < sections.length; i += 1) {
      const list = sections[i].queryHazards(veh, hazardCtx);
      if (Array.isArray(list)) {
        for (let j = 0; j < list.length; j += 1) {
          if (list[j]) results.push(sanitizeImpact(list[j]));
        }
      }
    }
    return results;
  };

  const triggerZoneMachine = (zoneId) => {
    if (disposed) {
      return { triggered: false, machineName: '', zoneId: String(zoneId || ''), message: '' };
    }
    for (let i = 0; i < sections.length; i += 1) {
      if (typeof sections[i].triggerZoneMachine === 'function') {
        const res = sections[i].triggerZoneMachine(zoneId);
        if (res) return res;
      }
    }
    return {
      triggered: false,
      machineName: '',
      zoneId: String(zoneId || ''),
      message: 'No triggerable machine in this zone.',
    };
  };

  const triggerNearestMachine = (pos) => {
    if (disposed || !pos) {
      return {
        triggered: false,
        machineName: '',
        zoneId: null,
        message: 'Drive closer to a crusher or C4 wall!',
      };
    }
    const px = Array.isArray(pos) ? pos[0] : pos.x;
    const pz = Array.isArray(pos) ? pos[2] : pos.z;
    if (!Number.isFinite(px) || !Number.isFinite(pz)) {
      return {
        triggered: false,
        machineName: '',
        zoneId: null,
        message: 'Drive closer to a crusher or C4 wall!',
      };
    }

    let bestSpot = null;
    let bestDist = Infinity;
    for (let i = 0; i < sections.length; i += 1) {
      const spots = typeof sections[i].getManualTriggerSpots === 'function'
        ? sections[i].getManualTriggerSpots()
        : [];
      for (let j = 0; j < spots.length; j += 1) {
        const sp = spots[j];
        const d = Math.hypot(px - sp.pos[0], pz - sp.pos[2]);
        const reach = Math.max((sp.radius || 24) + 10, 42);
        if (d <= reach && d < bestDist) {
          bestDist = d;
          bestSpot = sp;
        }
      }
    }
    if (!bestSpot) {
      return {
        triggered: false,
        machineName: '',
        zoneId: null,
        message: 'Drive closer to a crusher or C4 wall!',
      };
    }
    return triggerZoneMachine(bestSpot.zoneId);
  };

  const resetBreakables = () => {
    if (disposed) return;
    hazardCooldowns.clear();
    for (let i = 0; i < sections.length; i += 1) {
      if (typeof sections[i].resetBreakables === 'function') {
        sections[i].resetBreakables();
      }
    }
  };

  const getAiVehicles = () => {
    if (disposed || typeof stuntsArenas.getAiVehicles !== 'function') return [];
    return stuntsArenas.getAiVehicles();
  };

  const getSoccerBallState = () => {
    if (typeof hubLab.getSoccerBallState === 'function') {
      return hubLab.getSoccerBallState();
    }
    return {
      position: [74, 2.1, 162],
      velocity: [0, 0, 0],
      radius: 2.1,
      blueScore: 0,
      orangeScore: 0,
      lastScorer: null,
      goalCooldown: 0,
      pitchCenter: [74, 0, 162],
    };
  };

  const getActiveAlerts = (pos = null) => {
    if (disposed) return [];
    const alerts = [];
    for (let i = 0; i < sections.length; i += 1) {
      if (typeof sections[i].getActiveAlerts === 'function') {
        const list = sections[i].getActiveAlerts(pos);
        if (Array.isArray(list)) {
          for (let j = 0; j < list.length; j += 1) {
            if (list[j]) alerts.push(list[j]);
          }
        }
      }
    }
    alerts.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
    return alerts;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (let i = 0; i < sections.length; i += 1) {
      if (typeof sections[i].dispose === 'function') {
        sections[i].dispose();
      }
    }
    if (root.parent && typeof root.parent.remove === 'function') {
      root.parent.remove(root);
    } else if (scene && typeof scene.remove === 'function') {
      scene.remove(root);
    }
    hazardCooldowns.clear();
    if (ownsTextureLib && typeof texLib.dispose === 'function') {
      texLib.dispose();
    }
  };

  return {
    root,
    update,
    getGroundHeight,
    getSlopeNormal,
    queryHazards,
    triggerNearestMachine,
    triggerZoneMachine,
    resetBreakables,
    getAiVehicles,
    getSoccerBallState,
    getActiveAlerts,
    dispose,
  };
}
