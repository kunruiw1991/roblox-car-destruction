/**
 * 3D Arcade-Realistic Driving, Slope/Ballistic Physics, 14-Zone Auto-Smash,
 * TNT / .50 Hand Cannon, Staged Destruction & Zero-Soft-Lock Recovery
 * (Contracts #0, #6, #7, #9, #10, #11, #12, #13).
 *
 * Coordinate convention (shared with zones.js, camera.js, M2A, M2B):
 *   - Local +Z = vehicle FRONT, -Z = REAR, +Y = UP, +X = VEHICLE LEFT
 *   - forward = [Math.sin(yaw), 0, Math.cos(yaw)]
 *   - left    = [Math.cos(yaw), 0, -Math.sin(yaw)]
 *   - Left steer increments yaw (+dYaw CCW) while driving forward.
 */

import * as THREE from '../../vendor/three.module.min.js';
import { enforceMaterialGuardrails } from '../core/materials.js';
import { getVehicleById } from '../data/vehicles.js';
import { WORLD_HALF_SIZE, ZONES, getZoneById, yawToForward } from '../data/zones.js';
import { createVehicleVisual } from '../world/vehicle_mesh.js';

const GRAVITY = 24.0;
const AIR_DRAG = 0.16;
const WORLD_LIMIT = WORLD_HALF_SIZE - 5.2; // 234.8 m inner curb face
const MAX_INTEGRITY = 100;

const PARK_AND_TRIGGER_ZONES = Object.freeze({
  hydraulic_press: Object.freeze({ triggerDist: 5.5, parkDist: 2.2, maxWait: 2.5 }),
  nail_hammer: Object.freeze({ triggerDist: 6.5, parkDist: 2.2, maxWait: 2.5 }),
  giant_hammer: Object.freeze({ triggerDist: 9.5, parkDist: 2.2, maxWait: 2.6 }),
  spike_drop: Object.freeze({ triggerDist: 11.0, parkDist: 2.2, maxWait: 2.8 }),
  train_crossing: Object.freeze({ triggerDist: 12.0, parkDist: 2.0, maxWait: 2.8 }),
});

const DRIVE_THROUGH_OVERSHOOT = Object.freeze({
  hub_lab: 14.0,
  wrecking_balls: 16.0,
  spinning_hammers: 16.0,
  shredder_tunnels: 14.0,
  crash_c4_wall: 14.0,
});

const LAVA_OBBY_WAYPOINTS = Object.freeze([
  Object.freeze([-165.0, 141.5]), // Climb entry ramp onto split deck
  Object.freeze([-172.5, 144.8]), // Shift to right -X lane while on split deck
  Object.freeze([-172.5, 155.5]), // Drive straight onto Skull Catapult plate
]);

const SKI_MILESTONES = Object.freeze([50, 150, 300, 500, 800, 1100, 1500]);

const TWO_PI = Math.PI * 2;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function wrapAngle(rad) {
  if (typeof rad !== 'number' || !Number.isFinite(rad)) return 0;
  return ((((rad + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function moveToward(current, target, maxDelta) {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

function finiteOr(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Creates the full 3D driving, destruction, Auto-Smash, and TNT physics engine.
 *
 * @param {object} deps
 */
export function createPhysicsSim({
  scene,
  world,
  particles,
  audio,
  avatar,
  scoring,
  textures,
  cameraCtrl = null,
  initialVehicleId = 'sedan',
  initialZoneId = 'hub_lab',
  onAlert = null,
}) {
  const _tmpNormal = new THREE.Vector3(0, 1, 0);

  let vehicleDef = getVehicleById(initialVehicleId);
  let vehicleColor = vehicleDef.defaultColor;
  let zoneId = getZoneById(initialZoneId).id;
  let visual = null;

  // Spatial & kinematic state
  let px = 0;
  let py = 0;
  let pz = 14;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  let yaw = Math.PI;
  let pitch = 0;
  let roll = 0;
  let angVelPitch = 0;
  let angVelRoll = 0;
  let angVelYaw = 0;
  let steerAngle = 0;
  let wheelSpinRad = 0;

  // Airborne & stunt tracking
  let isAirborne = false;
  let airTime = 0;
  let airPitchAccum = 0;
  let airRollAccum = 0;
  let airYawAccum = 0;
  let skiJumpActive = false;
  let skiLaunchZ = -124;
  let skiMilestoneIdx = 0;

  // Vehicle damage & systems state
  let integrity = MAX_INTEGRITY;
  let crushY = 0;
  let frontCrumple = 0;
  let sideSkew = 0;
  let nitro = 100;
  let nitroDepleted = false;
  let onFire = false;
  let wrecked = false;
  let isBoosting = false;
  let isDrifting = false;
  let gear = 'D1';
  let speedKmh = 0;

  // Fixed-step FX & recovery timers (no wall-clock timers)
  let smokeTimer = 0;
  let fireTimer = 0;
  let nitroFxTimer = 0;
  let skidTimer = 0;
  let invertedTimer = 0;
  let curbHitCd = 0;
  let wreckHazardFxCd = 0;
  let tntShotCount = 0;
  let debrisSpreadIdx = 0;
  let pendingSnap = true;

  /** @type {Array<{ type: 'zone' | 'nearest', zoneId?: string }>} */
  const pendingTriggers = [];

  // Auto-Smash autopilot state
  const autoSmash = {
    active: false,
    zoneId: 'hub_lab',
    strategy: 'drive',
    elapsed: 0,
    triggered: false,
    hitDone: false,
    postHitTimer: 0,
    parkedTimer: 0,
    waypointIndex: 0,
    targetX: 0,
    targetZ: 0,
  };

  // Pre-allocated state objects reused across frames
  const worldVehState = {
    id: vehicleDef.id,
    vehicleId: vehicleDef.id,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    yaw: 0,
    speed: 0,
    speedKmh: 0,
    dimensions: { w: 2.05, h: 1.5, l: 4.55 },
    radius: 2.0,
    mass: 1600,
    isAirborne: false,
    wrecked: false,
  };

  const emitAlert = (text, tone = 'warn', durationSec = 2.6) => {
    if (onAlert && text) {
      onAlert(String(text), tone, durationSec);
    }
  };

  const countDetachedParts = () => {
    if (!visual || !visual.partsMap) return 0;
    const entries = Object.values(visual.partsMap);
    let count = 0;
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i] && entries[i].state === 'detached') {
        count += 1;
      }
    }
    return count;
  };

  const getTotalParts = () => {
    if (!visual || typeof visual.getTotalPartCount !== 'function') return 12;
    return visual.getTotalPartCount();
  };

  const syncVisualTransform = () => {
    if (!visual || !visual.root) return;
    visual.root.position.set(px, py, pz);
    visual.root.rotation.order = 'YXZ';
    visual.root.rotation.set(pitch, yaw, roll);
  };

  const placeAtZoneSpawn = (targetZoneId) => {
    const z = getZoneById(targetZoneId);
    zoneId = z.id;
    const sx = z.spawnPos[0];
    const sz = z.spawnPos[2];
    const groundY = world ? world.getGroundHeight(sx, sz) : 0;

    px = sx;
    py = groundY;
    pz = sz;
    vx = 0;
    vy = 0;
    vz = 0;
    yaw = z.spawnYaw;

    // Align initial pitch/roll to spawn slope (e.g. Ski Jump top platform)
    const normal = world ? world.getSlopeNormal(px, pz, _tmpNormal) : _tmpNormal.set(0, 1, 0);
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const leftX = Math.cos(yaw);
    const leftZ = -Math.sin(yaw);
    const ny = Math.max(0.25, normal.y);
    const slopeFwd = -(normal.x * fwdX + normal.z * fwdZ) / ny;
    const slopeLeft = -(normal.x * leftX + normal.z * leftZ) / ny;
    pitch = clamp(-Math.atan(slopeFwd), -0.65, 0.65);
    roll = clamp(Math.atan(slopeLeft), -0.65, 0.65);

    angVelPitch = 0;
    angVelRoll = 0;
    angVelYaw = 0;
    steerAngle = 0;
    isAirborne = false;
    airTime = 0;
    airPitchAccum = 0;
    airRollAccum = 0;
    airYawAccum = 0;
    skiJumpActive = false;
    skiMilestoneIdx = 0;
    isBoosting = false;
    isDrifting = false;
    speedKmh = 0;
    gear = 'D1';
    invertedTimer = 0;

    syncVisualTransform();
  };

  const mountVehicleVisual = (def, hex) => {
    if (avatar && avatar.group && avatar.group.parent) {
      avatar.group.parent.remove(avatar.group);
    }
    if (visual) {
      if (visual.root && visual.root.parent) {
        visual.root.parent.remove(visual.root);
      }
      if (typeof visual.dispose === 'function') {
        visual.dispose();
      }
    }

    vehicleDef = def;
    vehicleColor = hex || def.defaultColor;
    visual = createVehicleVisual(vehicleDef, vehicleColor, textures, scene);
    visual.root.rotation.order = 'YXZ';
    scene.add(visual.root);

    if (avatar && typeof avatar.resetToSeat === 'function') {
      avatar.resetToSeat(visual.bodyGroup, vehicleDef.seatOffset);
    }

    enforceMaterialGuardrails(scene);

    worldVehState.id = vehicleDef.id;
    worldVehState.vehicleId = vehicleDef.id;
    worldVehState.dimensions.w = vehicleDef.dimensions.w;
    worldVehState.dimensions.h = vehicleDef.dimensions.h;
    worldVehState.dimensions.l = vehicleDef.dimensions.l;
    worldVehState.radius = Math.max(vehicleDef.dimensions.w, vehicleDef.dimensions.l) * 0.44;
    worldVehState.mass = vehicleDef.mass;
  };

  const resetDamageState = () => {
    integrity = MAX_INTEGRITY;
    crushY = 0;
    frontCrumple = 0;
    sideSkew = 0;
    nitro = 100;
    nitroDepleted = false;
    onFire = false;
    wrecked = false;
    scoring?.setRewardsLocked?.(false);
    smokeTimer = 0;
    fireTimer = 0;
    wreckHazardFxCd = 0;
    if (visual && typeof visual.resetVisuals === 'function') {
      visual.resetVisuals();
    }
  };

  const cancelAutoSmash = () => {
    autoSmash.active = false;
    autoSmash.triggered = false;
    autoSmash.hitDone = false;
    autoSmash.postHitTimer = 0;
    autoSmash.parkedTimer = 0;
    autoSmash.elapsed = 0;
    autoSmash.waypointIndex = 0;
  };

  const queueZoneTrigger = (targetZoneId) => {
    if (wrecked) return;
    pendingTriggers.push({ type: 'zone', zoneId: targetZoneId });
  };

  const queueNearestTrigger = () => {
    if (wrecked) return;
    pendingTriggers.push({ type: 'nearest' });
  };

  const flushPendingTriggers = () => {
    if (pendingTriggers.length === 0 || !world) return null;
    if (wrecked) {
      pendingTriggers.length = 0;
      return null;
    }
    let lastResult = null;
    while (pendingTriggers.length > 0) {
      const req = pendingTriggers.shift();
      if (req.type === 'zone') {
        lastResult = world.triggerZoneMachine(req.zoneId);
      } else {
        lastResult = world.triggerNearestMachine([px, py, pz]);
      }
      if (lastResult && lastResult.triggered) {
        if (lastResult.zoneId === 'train_crossing') {
          audio?.playTrainHorn();
        } else {
          audio?.playButton();
        }
        if (lastResult.message) {
          emitAlert(lastResult.message, 'warn', 2.2);
        }
      }
    }
    return lastResult;
  };

  const detachEntryToDebris = (entry, impulseVec) => {
    if (!visual || !entry || entry.state === 'detached') return false;
    const detached = visual.detachPart(entry.key);
    if (!detached) return false;

    debrisSpreadIdx += 1;
    const angle = debrisSpreadIdx * 2.15;
    const spreadX = Math.cos(angle) * 4.2;
    const spreadZ = Math.sin(angle) * 4.2;
    const impX = finiteOr(impulseVec?.[0], 0);
    const impY = finiteOr(impulseVec?.[1], 0);
    const impZ = finiteOr(impulseVec?.[2], 0);

    const linVel = [
      clamp(vx * 0.55 + impX * 0.45 + spreadX, -32, 32),
      clamp(Math.max(5.5, vy * 0.4 + Math.abs(impY) * 0.5 + 5.5), 4.5, 22),
      clamp(vz * 0.55 + impZ * 0.45 + spreadZ, -32, 32),
    ];
    const angVel = [
      ((debrisSpreadIdx % 3) - 1) * 6.5 + 3.2,
      ((debrisSpreadIdx % 5) - 2) * 5.0 + 2.5,
      ((debrisSpreadIdx % 2) === 0 ? 1 : -1) * 7.2,
    ];

    particles?.spawnDebris(detached.mesh, detached.worldPos, detached.worldQuat, linVel, angVel);
    if (entry.key === 'windshield') {
      particles?.emitGlass(detached.worldPos, 18);
      audio?.playGlassShatter();
    } else {
      particles?.emitSparks(detached.worldPos, 10, 1.1);
    }

    scoring?.onPartDetached(entry.key, vehicleDef.id);
    particles?.spawnCashBurst(detached.worldPos, 35);
    return true;
  };

  // Unified wrecked-chassis impulse clamp: bounds horizontal speed to [-14, 14] m/s,
  // allows upward impulse ONLY near ground (py <= gY + 1.5), and strictly caps vy <= 12 m/s.
  const applyWreckedImpulse = (
    dx,
    dy,
    dz,
    dAngPitch = 0,
    dAngRoll = 0,
    { requireNearGround = false, additiveY = true } = {},
  ) => {
    const sDx = finiteOr(dx, 0);
    const sDy = finiteOr(dy, 0);
    const sDz = finiteOr(dz, 0);
    const sAngPitch = finiteOr(dAngPitch, 0);
    const sAngRoll = finiteOr(dAngRoll, 0);

    const gY = world ? world.getGroundHeight(px, pz) : 0;
    const nearGround = py <= gY + 1.5;
    if (requireNearGround && !nearGround) return;

    vx = clamp(vx + sDx, -14, 14);
    vz = clamp(vz + sDz, -14, 14);
    if (sDy > 0) {
      if (nearGround) {
        vy = additiveY
          ? clamp(vy + Math.min(sDy, 9.0), -20, 12)
          : clamp(Math.max(vy, Math.min(sDy, 12)), -20, 12);
        if (vy > 3.5) {
          isAirborne = true;
          angVelPitch = clamp(angVelPitch + sAngPitch, -4.5, 4.5);
          angVelRoll = clamp(angVelRoll + sAngRoll, -4.5, 4.5);
        }
      }
    } else if (sDy < 0) {
      vy = clamp(vy + sDy, -20, 12);
    }
  };

  const syncPartsForDamage = (extraForceDetach = 0, impulseVec = [0, 6, 0], allowDuringWreck = false) => {
    if (!visual || !visual.partsMap) return 0;
    if (wrecked && !allowDuringWreck) return 0;
    const damageRatio = clamp((MAX_INTEGRITY - integrity) / MAX_INTEGRITY, 0, 1);
    const entries = Object.values(visual.partsMap)
      .filter(Boolean)
      .sort((a, b) => (a.threshold || 0) - (b.threshold || 0));

    let detachedNow = 0;

    // 1. Threshold-based loosening & detachment
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.state === 'detached') continue;
      if (damageRatio >= entry.threshold) {
        if (detachEntryToDebris(entry, impulseVec)) {
          detachedNow += 1;
        }
      } else if (entry.state === 'intact' && damageRatio >= entry.threshold * 0.65) {
        if (visual.loosenPart(entry.key)) {
          particles?.emitSparks([px, py + 1.0, pz], 6, 0.8);
        }
      }
    }

    // 2. Force-detach lowest-threshold remaining parts on big blasts/crushes
    let remainingExtra = Math.max(0, Math.floor(extraForceDetach));
    for (let i = 0; i < entries.length && remainingExtra > 0; i += 1) {
      const entry = entries[i];
      if (entry.state === 'detached') continue;
      if (detachEntryToDebris(entry, impulseVec)) {
        detachedNow += 1;
        remainingExtra -= 1;
      }
    }

    return detachedNow;
  };

  const triggerWreck = (impulseVec = [0, 8, 0]) => {
    if (wrecked) return;
    integrity = 0;
    wrecked = true;
    onFire = true;
    cancelAutoSmash();
    pendingTriggers.length = 0;

    const center = [px, py + Math.max(0.9, vehicleDef.dimensions.h * 0.55), pz];
    visual?.setLights(false);
    visual?.applyDeformation(1.0, clamp(crushY + 0.16, 0, 1), clamp(frontCrumple + 0.22, 0, 1), sideSkew);
    particles?.emitExplosion(center, 6.2);
    audio?.playExplosion();
    cameraCtrl?.addShake(1.25);

    syncPartsForDamage(4, impulseVec, true);

    vy = clamp(Math.max(vy + 7.5, 7.5), -20, 22);
    isAirborne = true;
    angVelPitch = clamp(angVelPitch + 1.4, -4.5, 4.5);
    angVelRoll = clamp(angVelRoll + (sideSkew >= 0 ? 1.8 : -1.8), -4.5, 4.5);

    if (avatar && !avatar.isRagdolling()) {
      avatar.startRagdoll([
        vx * 0.75 + finiteOr(impulseVec[0], 0) * 0.35,
        Math.max(8.5, vy + 4.5),
        vz * 0.75 + finiteOr(impulseVec[2], 0) * 0.35,
      ]);
    }

    scoring?.addReward({
      cash: 150,
      xp: 75,
      label: 'CAR WRECKED!',
      tone: 'crash',
      vehicleId: vehicleDef.id,
      countCombo: true,
    });
    particles?.spawnCashBurst([px, py + 2.5, pz], 150);
    scoring?.setRewardsLocked?.(true);
    emitAlert('WRECKED! Tap FIX or CARS', 'wrecked', 6.0);
  };

  const playImpactSound = (impact) => {
    if (!audio) return;
    const s = impact.sound || 'crash';
    if (s === 'glass') {
      audio.playGlassShatter();
    } else if (s === 'crush') {
      audio.playCrush();
    } else if (s === 'hammer') {
      audio.playHammerDrop();
    } else if (s === 'shredder') {
      audio.playShredderGrind();
    } else if (s === 'train') {
      audio.playTrainHorn();
      audio.playCrash(1.15);
    } else if (s === 'explosion') {
      audio.playExplosion();
    } else if (s === 'cash') {
      audio.playCash(impact.cashBonus || 50);
    } else if (s === 'trick') {
      audio.playTrick();
    } else {
      audio.playCrash(clamp(0.45 + (impact.damage || 10) / 65, 0.4, 1.2));
    }
  };

  const applyHazardImpacts = (impacts) => {
    if (!Array.isArray(impacts) || impacts.length === 0) return;

    const massFactor = clamp(Math.sqrt(1600 / Math.max(400, vehicleDef.mass)), 0.52, 1.35);
    const centerPos = [px, py + Math.max(0.8, vehicleDef.dimensions.h * 0.5), pz];

    for (let i = 0; i < impacts.length; i += 1) {
      const imp = impacts[i];
      if (!imp) continue;

      const dmg = Math.max(0, finiteOr(imp.damage, 0));
      const impulse = Array.isArray(imp.impulse) ? imp.impulse : [0, 0, 0];

      // 1. Cash rings & Car Football goals (zero damage; wrecked chassis cannot farm non-goal rings)
      if (imp.kind === 'ring' && dmg <= 0) {
        const isFootballGoal = /^GOAL!/i.test(imp.label || '');
        if (wrecked && !isFootballGoal) {
          continue;
        }
        playImpactSound(imp);
        if (!wrecked) {
          nitro = clamp(nitro + 25, 0, 100);
        }
        if (imp.cashBonus > 0 || imp.xpBonus > 0 || imp.label) {
          let rewardLabel = imp.label || 'BONUS RING!';
          const goalMatch = /^GOAL!\s+BLUE\s+(\d+)\s*-\s*(\d+)\s+ORANGE$/i.exec(rewardLabel);
          if (goalMatch) {
            const scorer = world && typeof world.getSoccerBallState === 'function'
              ? world.getSoccerBallState()?.lastScorer
              : null;
            const team = scorer === 'orange' ? 'ORANGE' : 'BLUE';
            rewardLabel = `${team} GOAL ${goalMatch[1]}-${goalMatch[2]}!`;
          }
          scoring?.addReward({
            cash: imp.cashBonus,
            xp: imp.xpBonus,
            label: rewardLabel,
            tone: 'combo',
            vehicleId: vehicleDef.id,
            countCombo: true,
            allowWhenLocked: isFootballGoal,
          });
          if (imp.cashBonus > 0) {
            particles?.spawnCashBurst([px, py + 2.4, pz], imp.cashBonus);
          }
        }
        continue;
      }

      // 2. Unified post-wreck handling for ALL non-ring hazards:
      //    strictly ZERO cash/XP/combo/derbyWrecks/parts/nitro/shake/AFK-SFX/alerts;
      //    bounded near-ground physics so trains/shredders/walls push instead of clip.
      if (wrecked) {
        if (imp.kind === 'glass') {
          particles?.emitGlass(centerPos, 16);
          audio?.playGlassShatter();
        }
        if (imp.kind === 'lava') {
          continue;
        }
        const wIx = finiteOr(impulse[0], 0) * massFactor * 0.5;
        const wIy = finiteOr(impulse[1], 0) * massFactor * 0.45;
        const wIz = finiteOr(impulse[2], 0) * massFactor * 0.5;
        applyWreckedImpulse(
          wIx,
          wIy,
          wIz,
          wIy > 4.0 ? clamp(wIy * 0.06, -1.5, 1.5) : 0,
          wIy > 4.0 ? clamp((wIx - wIz) * 0.04, -1.8, 1.8) : 0,
          { requireNearGround: false, additiveY: true },
        );
        if (imp.kind !== 'glass' && wreckHazardFxCd <= 0) {
          wreckHazardFxCd = 1.2;
          particles?.emitSparks(centerPos, 8, 0.85);
        }
        continue;
      }

      // 3. Living / killing-blow hazard impact: full SFX, damage, impulse, debris, rewards
      playImpactSound(imp);

      // Apply damage & deformation
      if (dmg > 0) {
        integrity = Math.max(0, integrity - dmg);
        const damageRatio = clamp((MAX_INTEGRITY - integrity) / MAX_INTEGRITY, 0, 1);
        crushY = clamp(crushY + finiteOr(imp.crushY, 0) * 0.72, 0, 1);
        frontCrumple = clamp(frontCrumple + finiteOr(imp.frontCrumple, 0) * 0.72, 0, 1);
        const leftX = Math.cos(yaw);
        const leftZ = -Math.sin(yaw);
        const latDot = finiteOr(impulse[0], 0) * leftX + finiteOr(impulse[2], 0) * leftZ;
        const latSign = latDot === 0 ? ((i % 2 === 0) ? 1 : -1) : Math.sign(latDot);
        sideSkew = clamp(finiteOr(sideSkew, 0) + latSign * clamp(dmg / 110, 0.04, 0.32), -1, 1);
        visual?.applyDeformation(damageRatio, crushY, frontCrumple, sideSkew);
      }

      // Velocity impulse & stunt spin
      const ix = finiteOr(impulse[0], 0) * massFactor;
      const iy = finiteOr(impulse[1], 0) * massFactor;
      const iz = finiteOr(impulse[2], 0) * massFactor;
      vx = clamp(vx + ix, -55, 55);
      vy = clamp(vy + iy, -20, 32);
      vz = clamp(vz + iz, -55, 55);
      if (iy > 4.0) {
        isAirborne = true;
        angVelPitch += clamp(iy * 0.08, -2.5, 2.5);
        angVelRoll += clamp((ix - iz) * 0.06, -2.8, 2.8);
      } else if (vy > 3.5) {
        isAirborne = true;
      }

      // Impact particles & camera shake
      if (imp.kind === 'glass') {
        particles?.emitGlass(centerPos, 20);
      } else if (imp.explode) {
        particles?.emitExplosion(centerPos, 5.2);
      } else if (imp.kind === 'lava') {
        particles?.emitFire(centerPos, 1.8);
        particles?.emitSmoke(centerPos, 1.6);
      } else {
        particles?.emitSparks(centerPos, clamp(Math.round(8 + dmg * 0.45), 10, 32), 1.2);
      }
      cameraCtrl?.addShake(clamp(0.28 + dmg / 58, 0.25, 1.25));

      // Part detachment (force 1-2 flying parts on heavy crusher/train/C4 hits!)
      const extraDetach = (imp.explode || dmg >= 38) ? 2 : (dmg >= 22 ? 1 : 0);
      syncPartsForDamage(extraDetach, impulse);

      // Scoring & floating cash
      if (imp.cashBonus > 0 || imp.xpBonus > 0 || imp.label) {
        const isDerbyKo = imp.kind === 'ai_car' && imp.explode;
        if (isDerbyKo) {
          scoring?.recordDerbyWreck?.();
        }
        scoring?.addReward({
          cash: imp.cashBonus,
          xp: imp.xpBonus,
          label: imp.label || 'SMASH!',
          tone: isDerbyKo ? 'combo' : 'crash',
          vehicleId: vehicleDef.id,
          countCombo: true,
        });
        if (imp.cashBonus > 0) {
          particles?.spawnCashBurst([px, py + 2.3, pz], imp.cashBonus);
        }
        nitro = clamp(nitro + 18, 0, 100);
      }

      // Auto-Smash completion flag on meaningful impact
      if (autoSmash.active && (dmg >= 10 || imp.kind === 'catapult' || imp.kind === 'ai_car')) {
        autoSmash.hitDone = true;
      }

      // Fire / Wreck / Ragdoll escalation
      if (imp.ignite || integrity <= 35) {
        if (!onFire) {
          onFire = true;
          emitAlert('CAR ON FIRE! GET OUT!', 'danger', 3.5);
        }
      } else if (imp.label && dmg >= 20) {
        emitAlert(imp.label, 'warn', 2.2);
      }

      if (imp.ejectRagdoll && avatar && !avatar.isRagdolling()) {
        avatar.startRagdoll([
          vx * 0.75 + ix * 0.4,
          Math.max(7.5, vy + 5.5),
          vz * 0.75 + iz * 0.4,
        ]);
      }

      if (integrity <= 0 || (imp.explode && integrity <= 22)) {
        triggerWreck(impulse);
        break;
      }
    }
  };

  const triggerTnt = () => {
    const wasWrecked = wrecked;
    tntShotCount += 1;
    const isDynamite = tntShotCount % 2 === 1;
    const label = isDynamite ? 'DYNAMITE BOOM!' : '.50 CANNON BLAST!';

    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const blastPos = [px + fwdX * 0.9, py + 0.85, pz + fwdZ * 0.9];

    particles?.emitExplosion(blastPos, 5.4);
    audio?.playExplosion();
    cameraCtrl?.addShake(wasWrecked ? 0.35 : 1.05);

    const sideSign = isDynamite ? 1 : -1;
    const sideKickX = Math.cos(yaw) * sideSign * 3.8;
    const sideKickZ = -Math.sin(yaw) * sideSign * 3.8;

    if (wasWrecked) {
      // Bounded near-ground blast hop on already-wrecked chassis; zero rewards & zero C4 chain-trigger
      applyWreckedImpulse(
        -fwdX * 1.8 + sideKickX * 0.55,
        7.0,
        -fwdZ * 1.8 + sideKickZ * 0.55,
        0.7,
        sideSign * 1.0,
        { requireNearGround: true, additiveY: false },
      );
      emitAlert('WRECKED! Tap FIX or CARS', 'wrecked', 6.0);
      return;
    }

    integrity = Math.max(0, integrity - 34);
    const damageRatio = clamp((MAX_INTEGRITY - integrity) / MAX_INTEGRITY, 0, 1);
    frontCrumple = clamp(frontCrumple + 0.24, 0, 1);
    crushY = clamp(crushY + 0.10, 0, 1);
    sideSkew = clamp(sideSkew + sideSign * 0.16, -1, 1);
    visual?.applyDeformation(damageRatio, crushY, frontCrumple, sideSkew);

    // Playful bounded explosive bounce
    vx = clamp(vx - fwdX * 3.5 + sideKickX, -42, 42);
    vy = clamp(Math.max(vy + 8.5, 8.5), -20, 22);
    vz = clamp(vz - fwdZ * 3.5 + sideKickZ, -42, 42);
    isAirborne = true;
    angVelPitch = clamp(angVelPitch + 1.1, -4.5, 4.5);
    angVelRoll = clamp(angVelRoll + sideSign * 1.5, -4.5, 4.5);

    syncPartsForDamage(2, [sideKickX * 2, 10.5, sideKickZ * 2]);

    scoring?.addReward({
      cash: 115,
      xp: 50,
      label,
      tone: 'crash',
      vehicleId: vehicleDef.id,
      countCombo: true,
    });
    particles?.spawnCashBurst([px, py + 2.4, pz], 115);

    if (integrity <= 0) {
      triggerWreck([sideKickX * 2, 11.0, sideKickZ * 2]);
    } else if (integrity <= 35) {
      onFire = true;
      emitAlert('CAR ON FIRE! GET OUT!', 'danger', 3.5);
    } else {
      emitAlert(label, 'warn', 2.4);
    }

    // Chain-detonate nearby C4 wall ONLY if vehicle is still alive after this TNT shot
    if (!wrecked && Math.hypot(px - 185, pz - 35) <= 18.0) {
      queueZoneTrigger('crash_c4_wall');
    }
  };

  const toggleRagdoll = () => {
    if (!avatar) return false;
    if (wrecked) {
      emitAlert('WRECKED! Tap FIX or CARS', 'wrecked', 4.0);
      return Boolean(avatar.isRagdolling());
    }
    if (avatar.isRagdolling()) {
      if (visual) {
        avatar.resetToSeat(visual.bodyGroup, vehicleDef.seatOffset);
      }
      emitAlert('BACK IN DRIVER SEAT!', 'info', 1.8);
      return false;
    }

    const horizSpeed = Math.hypot(vx, vz);
    if (horizSpeed < 0.8) {
      // Stationary playful pop handled cleanly by avatars.js
      avatar.startRagdoll([0, 0, 0]);
    } else {
      avatar.startRagdoll([vx * 0.85, Math.max(7.0, vy + 7.5), vz * 0.85]);
    }
    audio?.playTrick();
    scoring?.addReward({
      cash: 35,
      xp: 15,
      label: 'RAGDOLL EJECT!',
      tone: 'trick',
      vehicleId: vehicleDef.id,
      countCombo: true,
    });
    emitAlert('EJECTED! Tap STAND or FIX', 'info', 2.4);
    return true;
  };

  const repairAndReset = () => {
    cancelAutoSmash();
    pendingTriggers.length = 0;
    resetDamageState();
    if (avatar && visual) {
      avatar.resetToSeat(visual.bodyGroup, vehicleDef.seatOffset);
    }
    particles?.clearDebris();
    world?.resetBreakables();
    placeAtZoneSpawn(zoneId);
    pendingSnap = true;
    cameraCtrl?.resetOrbit();
    enforceMaterialGuardrails(scene);
    emitAlert('VEHICLE REPAIRED!', 'info', 1.8);
  };

  const teleportToZone = (nextZoneId) => {
    const z = getZoneById(nextZoneId);
    cancelAutoSmash();
    pendingTriggers.length = 0;
    // Always re-seat avatar and recover wrecked vehicles on warp (zero soft-lock)
    if (wrecked || onFire) {
      resetDamageState();
    }
    if (avatar && visual) {
      avatar.resetToSeat(visual.bodyGroup, vehicleDef.seatOffset);
    }
    particles?.clearDebris();
    world?.resetBreakables();
    placeAtZoneSpawn(z.id);
    pendingSnap = true;
    cameraCtrl?.resetOrbit();
    enforceMaterialGuardrails(scene);
    emitAlert(`WARPED: ${z.name.toUpperCase()}`, 'info', 2.0);
    return z;
  };

  const selectVehicle = (nextVehicleId, colorHex = null) => {
    const nextDef = getVehicleById(nextVehicleId);
    const chosenHex = colorHex || nextDef.defaultColor;
    cancelAutoSmash();
    pendingTriggers.length = 0;
    mountVehicleVisual(nextDef, chosenHex);
    resetDamageState();
    particles?.clearDebris();
    placeAtZoneSpawn(zoneId);
    pendingSnap = true;
    cameraCtrl?.resetOrbit();
    emitAlert(`SPAWNED ${nextDef.name.toUpperCase()}!`, 'info', 2.0);
    return nextDef;
  };

  const setPaintColor = (hex) => {
    if (!hex || typeof hex !== 'string') return;
    vehicleColor = hex;
    visual?.setColor(hex);
    enforceMaterialGuardrails(scene);
  };

  const startAutoSmash = () => {
    if (wrecked) {
      repairAndReset();
    }
    if (avatar && avatar.isRagdolling() && visual) {
      avatar.resetToSeat(visual.bodyGroup, vehicleDef.seatOffset);
    }

    const z = getZoneById(zoneId);
    autoSmash.active = true;
    autoSmash.zoneId = z.id;
    autoSmash.elapsed = 0;
    autoSmash.triggered = false;
    autoSmash.hitDone = false;
    autoSmash.postHitTimer = 0;
    autoSmash.parkedTimer = 0;
    autoSmash.waypointIndex = 0;

    if (PARK_AND_TRIGGER_ZONES[z.id]) {
      autoSmash.strategy = 'park_trigger';
      autoSmash.targetX = z.smashTarget[0];
      autoSmash.targetZ = z.smashTarget[2];
    } else if (z.id === 'ski_jump' || z.id === 'mega_ramp') {
      autoSmash.strategy = 'ramp';
      autoSmash.targetX = z.id === 'ski_jump' ? -185.0 : 0.0;
      autoSmash.targetZ = z.id === 'ski_jump' ? -118.0 : 170.0;
    } else if (z.id === 'derby_arena') {
      autoSmash.strategy = 'derby';
      autoSmash.targetX = z.smashTarget[0];
      autoSmash.targetZ = z.smashTarget[2];
    } else if (z.id === 'lava_obby') {
      autoSmash.strategy = 'lava_obby';
      autoSmash.targetX = LAVA_OBBY_WAYPOINTS[0][0];
      autoSmash.targetZ = LAVA_OBBY_WAYPOINTS[0][1];
    } else {
      autoSmash.strategy = 'drive_through';
      const fwd = yawToForward(z.spawnYaw);
      const overshoot = DRIVE_THROUGH_OVERSHOOT[z.id] ?? 14.0;
      autoSmash.targetX = z.smashTarget[0] + fwd[0] * overshoot;
      autoSmash.targetZ = z.smashTarget[2] + fwd[2] * overshoot;
    }

    emitAlert('AUTO-SMASH LAUNCH!', 'warn', 1.8);
  };

  const computeAutoSmashInput = (dt, rawControls) => {
    // Only manual steering or braking cancels Auto-Smash; GAS/BOOST cooperates
    if (Math.abs(rawControls.steer) > 0.01 || rawControls.brake > 0) {
      cancelAutoSmash();
      return {
        steer: rawControls.steer,
        throttle: rawControls.throttle,
        brake: rawControls.brake,
        boost: rawControls.boost,
        parkHold: false,
        autoAccelBoost: false,
        speedCap: Infinity,
      };
    }

    autoSmash.elapsed += dt;
    if (autoSmash.elapsed >= 4.5) {
      cancelAutoSmash();
      return { steer: 0, throttle: 0, brake: 0, boost: 0, parkHold: false, autoAccelBoost: false, speedCap: Infinity };
    }

    if (autoSmash.hitDone) {
      autoSmash.postHitTimer += dt;
      if (autoSmash.postHitTimer >= 0.35) {
        cancelAutoSmash();
        return { steer: 0, throttle: 0, brake: 0, boost: 0, parkHold: false, autoAccelBoost: false, speedCap: Infinity };
      }
    }

    const z = getZoneById(autoSmash.zoneId);
    let tx = autoSmash.targetX;
    let tz = autoSmash.targetZ;
    let desiredSpeed = z.smashSpeed || 32;
    let throttle = 1;
    let brake = 0;
    let boost = 1;

    if (autoSmash.strategy === 'park_trigger') {
      const cfg = PARK_AND_TRIGGER_ZONES[z.id];
      const dist = Math.hypot(tx - px, tz - pz);

      if (!autoSmash.triggered && dist <= cfg.triggerDist) {
        autoSmash.triggered = true;
        queueZoneTrigger(z.id);
      }

      if (dist <= cfg.parkDist) {
        // Dead-center stop inside the crusher bay / tracks (hold without reverse gear)
        vx *= Math.exp(-14.0 * dt);
        vz *= Math.exp(-14.0 * dt);
        autoSmash.parkedTimer += dt;
        if (!autoSmash.triggered) {
          autoSmash.triggered = true;
          queueZoneTrigger(z.id);
        }
        if (autoSmash.parkedTimer >= cfg.maxWait) {
          cancelAutoSmash();
        }
        return { steer: 0, throttle: 0, brake: 0, boost: 0, parkHold: true, autoAccelBoost: false, speedCap: 0 };
      }

      if (dist < 10.5) {
        desiredSpeed = clamp(dist * 2.1, 4.0, z.smashSpeed || 24);
        boost = 0;
      }
    } else if (autoSmash.strategy === 'ramp') {
      if (z.id === 'ski_jump') {
        desiredSpeed = 48.0;
        if (isAirborne && pz > -124.5) {
          cancelAutoSmash();
          return { steer: 0, throttle: 0, brake: 0, boost: 0, parkHold: false, autoAccelBoost: false, speedCap: Infinity };
        }
      } else {
        // Mega Ramp: cap lip speed around 38.5 m/s so landing hits apron z in [192, 222]
        desiredSpeed = 38.5;
        if (isAirborne && pz > 162.5) {
          cancelAutoSmash();
          return { steer: 0, throttle: 0, brake: 0, boost: 0, parkHold: false, autoAccelBoost: false, speedCap: Infinity };
        }
      }
    } else if (autoSmash.strategy === 'derby') {
      const aiList = world ? world.getAiVehicles() : [];
      let bestAi = null;
      let bestDist = Infinity;
      for (let i = 0; i < aiList.length; i += 1) {
        const ai = aiList[i];
        if (!ai || ai.wrecked) continue;
        const d = Math.hypot(ai.position[0] - px, ai.position[2] - pz);
        if (d < bestDist) {
          bestDist = d;
          bestAi = ai;
        }
      }
      if (bestAi) {
        tx = bestAi.position[0] + (bestAi.velocity?.[0] || 0) * 0.16;
        tz = bestAi.position[2] + (bestAi.velocity?.[2] || 0) * 0.16;
      } else {
        tx = z.smashTarget[0];
        tz = z.smashTarget[2];
      }
      desiredSpeed = 35.0;
    } else if (autoSmash.strategy === 'lava_obby') {
      const wp = LAVA_OBBY_WAYPOINTS[autoSmash.waypointIndex];
      tx = wp[0];
      tz = wp[1];
      const dWp = Math.hypot(tx - px, tz - pz);
      if (autoSmash.waypointIndex === 0 && (pz >= 140.5 || dWp <= 3.2)) {
        autoSmash.waypointIndex = 1;
        tx = LAVA_OBBY_WAYPOINTS[1][0];
        tz = LAVA_OBBY_WAYPOINTS[1][1];
      } else if (autoSmash.waypointIndex === 1 && (px <= -170.5 || dWp <= 3.2)) {
        autoSmash.waypointIndex = 2;
        tx = LAVA_OBBY_WAYPOINTS[2][0];
        tz = LAVA_OBBY_WAYPOINTS[2][1];
      }
      desiredSpeed = autoSmash.waypointIndex === 2 ? 22.0 : 18.0;
      boost = 0;
    } else {
      // drive_through
      const dist = Math.hypot(tx - px, tz - pz);
      if (dist <= 2.5) {
        cancelAutoSmash();
        return { steer: 0, throttle: 0, brake: 0, boost: 0, parkHold: false, autoAccelBoost: false, speedCap: Infinity };
      }
      desiredSpeed = Math.max(z.smashSpeed || 34, (vehicleDef.maxSpeedKmh / 3.6) * 1.15);
    }

    const desiredYaw = Math.atan2(tx - px, tz - pz);
    const yawErr = wrapAngle(desiredYaw - yaw);
    const steer = clamp(yawErr * 2.6, -1, 1);

    // For tight waypoints (lava_obby & derby), directly assist yaw alignment cleanly
    if (!isAirborne && (autoSmash.strategy === 'lava_obby' || autoSmash.strategy === 'derby' || autoSmash.strategy === 'park_trigger')) {
      const maxAutoTurn = Math.max(vehicleDef.turnRate * 1.35, 2.8) * dt;
      yaw = wrapAngle(yaw + clamp(yawErr, -maxAutoTurn, maxAutoTurn));
    }

    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const curFwd = vx * fwdX + vz * fwdZ;
    if (curFwd > desiredSpeed + 2.0) {
      throttle = 0;
      brake = 0.65;
      boost = 0;
    } else if (curFwd > desiredSpeed) {
      throttle = 0;
      boost = 0;
    }

    return {
      steer,
      throttle,
      brake,
      boost,
      parkHold: false,
      autoAccelBoost: true,
      speedCap: desiredSpeed,
    };
  };

  const updateZoneTracking = () => {
    // Only reassign currentZoneId when driving inside another zone's padRadius
    const curZone = getZoneById(zoneId);
    const dCur = Math.hypot(px - curZone.padCenter[0], pz - curZone.padCenter[2]);
    if (dCur <= curZone.padRadius) return;

    let bestId = zoneId;
    let bestDist = Infinity;
    for (let i = 0; i < ZONES.length; i += 1) {
      const z = ZONES[i];
      const d = Math.hypot(px - z.padCenter[0], pz - z.padCenter[2]);
      if (d <= z.padRadius && d < bestDist) {
        bestDist = d;
        bestId = z.id;
      }
    }
    if (bestId !== zoneId) {
      zoneId = bestId;
    }
  };

  const hasSheerCliff = (x0, z0, x1, z1, y0) => {
    const endY = world ? world.getGroundHeight(x1, z1) : 0;
    if (endY - y0 <= 0.75) return false;
    const segDist = Math.hypot(x1 - x0, z1 - z0);
    const subDist = segDist * 0.25;
    const subMax = Math.max(0.75, subDist * 1.55 + 0.15);
    let prevSubY = y0;
    for (let k = 1; k <= 4; k += 1) {
      const t = k * 0.25;
      const sy = world ? world.getGroundHeight(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t) : 0;
      if (sy - prevSubY > subMax) return true;
      prevSubY = sy;
    }
    return false;
  };

  const stepKinematics = (dt, rawControls = { steer: 0, throttle: 0, brake: 0, boost: 0 }) => {
    const safeDt = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 1 / 60;
    const ctrl = rawControls && typeof rawControls === 'object' ? rawControls : {};
    curbHitCd = Math.max(0, curbHitCd - safeDt);
    wreckHazardFxCd = Math.max(0, wreckHazardFxCd - safeDt);

    // OOB / NaN failsafe (sanitizes all kinematic, orientation & damage fields)
    if (!Number.isFinite(pitch)) pitch = 0;
    if (!Number.isFinite(roll)) roll = 0;
    if (!Number.isFinite(angVelPitch)) angVelPitch = 0;
    if (!Number.isFinite(angVelRoll)) angVelRoll = 0;
    if (!Number.isFinite(angVelYaw)) angVelYaw = 0;
    if (!Number.isFinite(steerAngle)) steerAngle = 0;
    if (!Number.isFinite(wheelSpinRad)) wheelSpinRad = 0;
    if (!Number.isFinite(integrity)) integrity = MAX_INTEGRITY;
    if (!Number.isFinite(nitro)) nitro = 100;
    if (!Number.isFinite(crushY)) crushY = 0;
    if (!Number.isFinite(frontCrumple)) frontCrumple = 0;
    if (!Number.isFinite(sideSkew)) sideSkew = 0;

    if (
      !Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)
      || !Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)
      || !Number.isFinite(yaw) || py < -6.0
    ) {
      placeAtZoneSpawn(zoneId);
      pendingSnap = true;
      emitAlert('RECOVERED TO SPAWN!', 'info', 1.8);
      return;
    }

    // Ongoing fire & smoke effects
    const damageRatio = clamp((MAX_INTEGRITY - integrity) / MAX_INTEGRITY, 0, 1);
    const fwdX0 = Math.sin(yaw);
    const fwdZ0 = Math.cos(yaw);
    const hoodPos = [
      px + fwdX0 * (vehicleDef.dimensions.l * 0.3),
      py + vehicleDef.dimensions.h * 0.65,
      pz + fwdZ0 * (vehicleDef.dimensions.l * 0.3),
    ];

    if (onFire) {
      fireTimer += safeDt;
      if (fireTimer >= 0.10) {
        fireTimer -= 0.10;
        particles?.emitFire(hoodPos, wrecked ? 1.5 : 1.1);
        particles?.emitSmoke([hoodPos[0], hoodPos[1] + 0.4, hoodPos[2]], 1.2);
      }
      if (!wrecked) {
        integrity = Math.max(0, integrity - 5.5 * safeDt);
        visual?.applyDeformation(clamp((MAX_INTEGRITY - integrity) / MAX_INTEGRITY, 0, 1), crushY, frontCrumple, sideSkew);
        if (integrity <= 0) {
          triggerWreck([0, 8.5, 0]);
        }
      }
    } else if (integrity <= 70) {
      smokeTimer += safeDt;
      if (smokeTimer >= 0.15) {
        smokeTimer -= 0.15;
        particles?.emitSmoke(hoodPos, 0.7 + damageRatio);
      }
    }

    // Determine effective controls (auto-smash vs manual vs wrecked)
    let eff = {
      steer: clamp(finiteOr(ctrl.steer, 0), -1, 1),
      throttle: clamp(finiteOr(ctrl.throttle, 0), 0, 1),
      brake: clamp(finiteOr(ctrl.brake, 0), 0, 1),
      boost: clamp(finiteOr(ctrl.boost, 0), 0, 1),
      parkHold: false,
      autoAccelBoost: false,
      speedCap: Infinity,
    };

    if (wrecked) {
      eff.steer = 0;
      eff.throttle = 0;
      eff.brake = 0;
      eff.boost = 0;
      eff.parkHold = false;
    } else if (autoSmash.active) {
      eff = computeAutoSmashInput(safeDt, eff);
    }

    // Manual GAS/REV/NOS press after EJECT (when not wrecked or in Auto-Smash)
    // cleanly re-seats the driver so the unoccupied car never drives off-screen.
    if (
      !wrecked
      && !eff.autoAccelBoost
      && avatar
      && avatar.isRagdolling()
      && visual
      && (eff.throttle > 0 || eff.brake > 0 || eff.boost > 0)
    ) {
      avatar.resetToSeat(visual.bodyGroup, vehicleDef.seatOffset);
      emitAlert('BACK IN DRIVER SEAT!', 'info', 1.6);
    }

    // Steering angle animation & crisp return to 0 on release
    const targetSteerRad = eff.steer * 0.52;
    const steerRate = Math.abs(eff.steer) < 0.01 ? 26.0 : 12.0;
    steerAngle = moveToward(steerAngle, targetSteerRad, steerRate * safeDt);
    if (Math.abs(eff.steer) < 0.01 && Math.abs(steerAngle) < 0.01) {
      steerAngle = 0;
    }

    const groundY = world ? world.getGroundHeight(px, pz) : 0;
    const normal = world ? world.getSlopeNormal(px, pz, _tmpNormal) : _tmpNormal.set(0, 1, 0);
    const wasAirborne = isAirborne;
    if (!isAirborne && (py > groundY + 0.45 || vy > 3.5)) {
      isAirborne = true;
    }

    // Nitro tank update (strictly clamped [0, 100] with empty-tank hysteresis)
    if (eff.boost <= 0 || nitro >= 8) {
      nitroDepleted = false;
    }
    const wantsManualBoost = !wrecked && !eff.autoAccelBoost && eff.boost > 0 && !nitroDepleted && nitro > 0.2;
    const wantsAutoBoost = !wrecked && eff.autoAccelBoost && eff.boost > 0;
    isBoosting = wantsManualBoost || wantsAutoBoost;

    if (wantsManualBoost) {
      nitro = clamp(nitro - 28.0 * safeDt, 0, 100);
      if (nitro <= 0.2) {
        nitro = 0;
        nitroDepleted = true;
      }
    } else if (wantsAutoBoost) {
      // Visual boost during Auto-Smash without draining tank dry
      nitro = clamp(Math.max(25, nitro - 8.0 * safeDt), 0, 100);
    } else if (!wrecked) {
      nitro = clamp(nitro + 12.0 * safeDt, 0, 100);
    }

    if (isBoosting) {
      nitroFxTimer += safeDt;
      if (nitroFxTimer >= 0.04) {
        nitroFxTimer -= 0.04;
        const tailPos = [
          px - fwdX0 * (vehicleDef.dimensions.l * 0.52),
          py + Math.max(0.32, vehicleDef.wheelRadius * 0.85),
          pz - fwdZ0 * (vehicleDef.dimensions.l * 0.52),
        ];
        particles?.emitNitro(tailPos, [-fwdX0, 0.05, -fwdZ0]);
      }
    }

    isDrifting = false;

    if (!isAirborne) {
      // Grounded driving dynamics
      py = groundY;

      const fwdX = Math.sin(yaw);
      const fwdZ = Math.cos(yaw);
      const leftX = Math.cos(yaw);
      const leftZ = -Math.sin(yaw);

      let vFwd = vx * fwdX + vz * fwdZ;
      let vLat = vx * leftX + vz * leftZ;

      const baseMaxMs = vehicleDef.maxSpeedKmh / 3.6;
      const maxSpeedMs = eff.autoAccelBoost
        ? Math.min(eff.speedCap, Math.max(baseMaxMs * 1.35, eff.speedCap))
        : baseMaxMs * (isBoosting ? 1.35 : 1.0);
      const maxRevMs = Math.min(18.0, baseMaxMs * 0.42);
      const driveAccel = eff.autoAccelBoost
        ? Math.max(vehicleDef.accel * 1.45, 22.0)
        : vehicleDef.accel * (isBoosting ? 1.48 : 1.0);

      // Longitudinal acceleration / parkHold / braking / reverse / coasting drag
      const driveInput = eff.throttle > 0 || (wantsManualBoost && eff.brake === 0);
      if (wrecked) {
        vFwd *= Math.exp(-2.8 * safeDt);
        vFwd = moveToward(vFwd, 0, 4.5 * safeDt);
      } else if (eff.parkHold) {
        vFwd = moveToward(vFwd, 0, 32.0 * safeDt);
        vLat = moveToward(vLat, 0, 28.0 * safeDt);
      } else if (driveInput && eff.brake === 0) {
        if (vFwd < 0) {
          vFwd = moveToward(vFwd, 0, 32.0 * safeDt);
        } else if (vFwd < maxSpeedMs) {
          vFwd = Math.min(maxSpeedMs, vFwd + driveAccel * safeDt);
        } else {
          vFwd = moveToward(vFwd, maxSpeedMs, 18.0 * safeDt);
        }
      } else if (eff.brake > 0) {
        if (vFwd > 0.8) {
          vFwd = moveToward(vFwd, 0, 34.0 * safeDt);
        } else {
          const revAccel = Math.max(vehicleDef.accel * 0.72, 10.5);
          vFwd = Math.max(-maxRevMs, vFwd - revAccel * safeDt);
        }
      } else {
        // Zero-throttle coasting: ~45-55% speed decay over 1.0 s (clean T2_F04_04 stop)
        vFwd *= Math.exp(-0.58 * safeDt);
        vFwd = moveToward(vFwd, 0, 1.85 * safeDt);
      }

      // Terrain slope gravity: exact bounded downhill horizontal tangent projection
      const ny = Math.max(0.25, normal.y);
      if (!eff.parkHold) {
        const slopeAccX = GRAVITY * normal.x * normal.y * 0.72;
        const slopeAccZ = GRAVITY * normal.z * normal.y * 0.72;
        vFwd += (slopeAccX * fwdX + slopeAccZ * fwdZ) * safeDt;
        vLat += (slopeAccX * leftX + slopeAccZ * leftZ) * safeDt;
      }

      // Pre-turn world velocity (after longitudinal accel/brake/slope in old heading)
      const preVx = fwdX * vFwd + leftX * vLat;
      const preVz = fwdZ * vFwd + leftZ * vLat;

      // Steering yaw rotation (zero yaw drift when steer === 0!)
      const absFwd = Math.abs(vFwd);
      if (!wrecked && Math.abs(eff.steer) >= 0.01 && absFwd > 0.15) {
        const steerDir = vFwd >= -0.25 ? 1 : -1;
        const speedAuthority = clamp(absFwd / 3.8, 0.42, 1.0) * (1.0 - clamp(absFwd / 75.0, 0, 0.28));
        yaw = wrapAngle(yaw + eff.steer * steerDir * vehicleDef.turnRate * speedAuthority * safeDt);
      }

      // Re-project pre-turn velocity onto NEW post-turn heading basis before lateral grip
      // so sharp high-speed turns create natural lateral slip (vLat) & drift skid marks.
      const nfX = Math.sin(yaw);
      const nfZ = Math.cos(yaw);
      const nlX = Math.cos(yaw);
      const nlZ = -Math.sin(yaw);
      vFwd = preVx * nfX + preVz * nfZ;
      vLat = preVx * nlX + preVz * nlZ;

      // Lateral tire grip (tight when driving straight or Auto-Smash so release goes dead straight)
      const lateralDecay = (Math.abs(eff.steer) < 0.01 || eff.autoAccelBoost)
        ? 16.0
        : (3.0 + vehicleDef.grip * 5.6);
      vLat *= Math.exp(-lateralDecay * safeDt);
      if (Math.abs(vLat) < 0.04) vLat = 0;

      // Drift detection & rear-axle skid marks
      if (Math.abs(vLat) > 3.2 && Math.abs(vFwd) > 9.0 && !wrecked) {
        isDrifting = true;
        skidTimer += safeDt;
        if (skidTimer >= 0.07) {
          skidTimer -= 0.07;
          const rearPos = [
            px - nfX * (vehicleDef.dimensions.l * 0.34),
            py + 0.05,
            pz - nfZ * (vehicleDef.dimensions.l * 0.34),
          ];
          particles?.addSkidMark(rearPos, yaw, vehicleDef.dimensions.w * 0.78);
          particles?.emitDust(rearPos, 4);
        }
      }

      // Reconstruct world velocity from updated yaw
      vx = nfX * vFwd + nlX * vLat;
      vz = nfZ * vFwd + nlZ * vLat;

      // Project vertical velocity along terrain slope for smooth ballistic ramp liftoff
      const slopeVy = vx * (-normal.x / ny) + vz * (-normal.z / ny);
      vy = slopeVy;

      const prevX = px;
      const prevZ = pz;
      px += vx * safeDt;
      pz += vz * safeDt;

      // Re-sample ground height at new position to detect cliff walls & ramp lip liftoff
      let nextGroundY = world ? world.getGroundHeight(px, pz) : 0;
      let hitCliffWall = false;
      if (hasSheerCliff(prevX, prevZ, px, pz, py)) {
        // Sheer vertical ramp/deck side wall — deflect horizontally instead of snapping vertically up!
        const cliffX = hasSheerCliff(prevX, prevZ, px, prevZ, py);
        const cliffZ = hasSheerCliff(prevX, prevZ, prevX, pz, py);
        if (!cliffX && cliffZ) {
          pz = prevZ;
          vz *= -0.35;
          nextGroundY = world ? world.getGroundHeight(px, prevZ) : 0;
        } else if (!cliffZ && cliffX) {
          px = prevX;
          vx *= -0.35;
          nextGroundY = world ? world.getGroundHeight(prevX, pz) : 0;
        } else {
          px = prevX;
          pz = prevZ;
          vx *= -0.35;
          vz *= -0.35;
          nextGroundY = groundY;
        }
        if (hasSheerCliff(prevX, prevZ, px, pz, py)) {
          px = prevX;
          pz = prevZ;
          vx *= -0.35;
          vz *= -0.35;
          nextGroundY = groundY;
        }
        hitCliffWall = true;
        vy = 0;
        const wallSpeed = Math.hypot(preVx, preVz);
        if (wallSpeed > 6.0 && curbHitCd <= 0 && !wrecked) {
          curbHitCd = 0.35;
          particles?.emitSparks([px, py + 0.7, pz], 8, 0.8);
          audio?.playCrash(clamp(wallSpeed / 36, 0.3, 0.75));
          cameraCtrl?.addShake(0.22);
        }
      }
      const nextNormal = world ? world.getSlopeNormal(px, pz, _tmpNormal) : _tmpNormal.set(0, 1, 0);
      const predY = py + vy * safeDt;

      const isRampLaunch = !hitCliffWall && vy > 3.5 && predY > nextGroundY + 0.16;
      const isLedgeDrop = !hitCliffWall && predY > nextGroundY + 0.45;
      if (isRampLaunch || isLedgeDrop) {
        // Launched cleanly off ramp lip or drove/reversed off an elevated ledge!
        py = predY;
        isAirborne = true;
        airTime = 0;
        airPitchAccum = 0;
        airRollAccum = 0;
        airYawAccum = 0;
        if (isRampLaunch) {
          angVelPitch = clamp(-vy * 0.04, -1.2, 0.6);
          angVelRoll = eff.steer * 0.9;
          angVelYaw = eff.steer * 0.8;
        } else {
          // Gentle natural nose-tip when dropping off a flat or downward ledge
          angVelPitch = vFwd >= 0 ? 0.32 : -0.32;
          angVelRoll = eff.steer * 0.25;
          angVelYaw = eff.steer * 0.2;
        }

        // Detect Ski Jump launch for 50-1500 stud distance callouts
        if (!wrecked && isRampLaunch && px >= -196 && px <= -174 && pz >= -130 && pz <= -118) {
          skiJumpActive = true;
          skiLaunchZ = pz;
          skiMilestoneIdx = 0;
        }
      } else {
        py = nextGroundY;
        vy = 0;

        // Smooth grounded pitch & roll alignment to terrain normal
        const nextNy = Math.max(0.25, nextNormal.y);
        const sFwd = -(nextNormal.x * nfX + nextNormal.z * nfZ) / nextNy;
        const sLeft = -(nextNormal.x * nlX + nextNormal.z * nlZ) / nextNy;
        const targetPitch = clamp(-Math.atan(sFwd), -0.75, 0.75);
        const targetRoll = clamp(Math.atan(sLeft), -0.75, 0.75);
        const alignAlpha = Math.min(1, safeDt * 14.0);
        pitch += (targetPitch - pitch) * alignAlpha;
        roll += (targetRoll - roll) * alignAlpha;
        angVelPitch = 0;
        angVelRoll = 0;
        angVelYaw = 0;
      }

      // Spin wheels
      wheelSpinRad += (vFwd * safeDt) / Math.max(0.2, vehicleDef.wheelRadius || 0.38);

      // Auto self-right if somehow upside-down and stopped
      if (!wrecked && Math.hypot(vx, vz) < 2.0 && (Math.abs(pitch) > 1.8 || Math.abs(roll) > 1.8)) {
        invertedTimer += safeDt;
        if (invertedTimer >= 2.2) {
          pitch = 0;
          roll = 0;
          vy = 4.5;
          isAirborne = true;
          invertedTimer = 0;
          emitAlert('AUTO SELF-RIGHT!', 'info', 1.6);
        }
      } else {
        invertedTimer = 0;
      }
    } else {
      // Airborne ballistic flight & stunt spin
      airTime += safeDt;
      const dragFactor = Math.exp(-AIR_DRAG * safeDt);
      vy = Math.max(-28.0, (vy - GRAVITY * safeDt) * dragFactor);
      vx *= dragFactor;
      vz *= dragFactor;

      // Subtle mid-air stunt control from thumb inputs
      if (!wrecked) {
        if (Math.abs(eff.steer) > 0.01) {
          angVelRoll = clamp(angVelRoll + eff.steer * 1.8 * safeDt, -4.5, 4.5);
          angVelYaw = clamp(angVelYaw + eff.steer * 1.2 * safeDt, -3.5, 3.5);
        }
        if (eff.throttle > 0) {
          angVelPitch = clamp(angVelPitch - 0.9 * safeDt, -4.0, 4.0);
        } else if (eff.brake > 0) {
          angVelPitch = clamp(angVelPitch + 1.2 * safeDt, -4.0, 4.0);
        }
      }

      const dPitch = angVelPitch * safeDt;
      const dRoll = angVelRoll * safeDt;
      const dYaw = angVelYaw * safeDt;
      pitch = wrapAngle(pitch + dPitch);
      roll = wrapAngle(roll + dRoll);
      yaw = wrapAngle(yaw + dYaw);
      airPitchAccum += Math.abs(dPitch);
      airRollAccum += Math.abs(dRoll);
      airYawAccum += Math.abs(dYaw);

      const prevX = px;
      const prevY = py;
      const prevZ = pz;
      px += vx * safeDt;
      py += vy * safeDt;
      pz += vz * safeDt;

      // Ski jump live distance sign milestones (50..1500 studs, ~4 studs/meter)
      if (!wrecked && skiJumpActive && skiMilestoneIdx < SKI_MILESTONES.length) {
        const studs = Math.max(0, (pz - skiLaunchZ) * 4.5);
        if (studs >= SKI_MILESTONES[skiMilestoneIdx]) {
          scoring?.onSkiMarker(SKI_MILESTONES[skiMilestoneIdx], vehicleDef.id);
          audio?.playTrick();
          skiMilestoneIdx += 1;
        }
      }

      // Check touchdown (deflect laterally if penetrating below a raised deck/ramp side wall)
      let nextGroundY = world ? world.getGroundHeight(px, pz) : 0;
      if (py <= nextGroundY && prevY < nextGroundY - 1.15 && hasSheerCliff(prevX, prevZ, px, pz, prevY)) {
        const tryXG = world ? world.getGroundHeight(px, prevZ) : 0;
        const tryZG = world ? world.getGroundHeight(prevX, pz) : 0;
        const cliffX = prevY < tryXG - 1.15 && hasSheerCliff(prevX, prevZ, px, prevZ, prevY);
        const cliffZ = prevY < tryZG - 1.15 && hasSheerCliff(prevX, prevZ, prevX, pz, prevY);
        if (!cliffX && cliffZ) {
          pz = prevZ;
          vz *= -0.35;
          nextGroundY = tryXG;
        } else if (!cliffZ && cliffX) {
          px = prevX;
          vx *= -0.35;
          nextGroundY = tryZG;
        } else {
          px = prevX;
          pz = prevZ;
          vx *= -0.35;
          vz *= -0.35;
          nextGroundY = world ? world.getGroundHeight(px, pz) : 0;
        }
        if (prevY < nextGroundY - 1.15 && hasSheerCliff(prevX, prevZ, px, pz, prevY)) {
          px = prevX;
          pz = prevZ;
          vx *= -0.35;
          vz *= -0.35;
          nextGroundY = world ? world.getGroundHeight(px, pz) : 0;
        }
      }
      if (py <= nextGroundY) {
        const impactVy = Math.abs(vy);
        py = nextGroundY;
        vy = 0;
        isAirborne = false;

        if (wasAirborne && airTime > 0.25) {
          particles?.emitDust([px, py + 0.2, pz], 12);
        }

        if (!wrecked && wasAirborne && airTime > 0.25) {
          const flips = Math.floor(airPitchAccum / (Math.PI * 1.65));
          const rolls = Math.floor(airRollAccum / (Math.PI * 1.65));
          const spins = Math.floor(airYawAccum / (Math.PI * 1.65));
          const inverted = Math.abs(pitch) > 1.15 || Math.abs(roll) > 1.15;
          const hardCrash = impactVy > 14.0 || inverted;

          const stunt = scoring?.onStuntLanding({
            airTime,
            flips,
            rolls,
            spins,
            clean: !hardCrash,
            crashed: hardCrash,
            vehicleId: vehicleDef.id,
          });
          if (stunt) {
            audio?.playTrick();
            nitro = clamp(nitro + 25, 0, 100);
          }

          if (hardCrash) {
            const landDmg = clamp((impactVy - 10.0) * 1.6 + (inverted ? 14 : 0), 8, 34);
            integrity = Math.max(0, integrity - landDmg);
            const dRatio = clamp((MAX_INTEGRITY - integrity) / MAX_INTEGRITY, 0, 1);
            crushY = clamp(crushY + (inverted ? 0.16 : 0.08), 0, 1);
            visual?.applyDeformation(dRatio, crushY, frontCrumple, sideSkew);
            particles?.emitSparks([px, py + 0.5, pz], 16, 1.1);
            audio?.playCrash(clamp(impactVy / 22, 0.45, 1.1));
            cameraCtrl?.addShake(clamp(impactVy / 24, 0.35, 1.0));
            syncPartsForDamage(landDmg >= 22 ? 1 : 0, [0, 7.0, 0]);
            if (integrity <= 0) {
              triggerWreck([0, 7.5, 0]);
            } else if (integrity <= 35 && !onFire) {
              onFire = true;
              emitAlert('CAR ON FIRE! GET OUT!', 'danger', 3.5);
            }
          }
        }

        // Smooth out pitch/roll on landing (preserve wreck-pop tumble if hardCrash triggered triggerWreck)
        if (!isAirborne) {
          pitch *= 0.35;
          roll *= 0.35;
          angVelPitch = 0;
          angVelRoll = 0;
          angVelYaw = 0;
        }
        airTime = 0;
        airPitchAccum = 0;
        airRollAccum = 0;
        airYawAccum = 0;
        skiJumpActive = false;
      }
    }

    // World perimeter curb containment (+-234.8 m)
    let hitPerimeter = false;
    let curbSpeed = 0;
    if (px < -WORLD_LIMIT) {
      px = -WORLD_LIMIT;
      curbSpeed = Math.max(curbSpeed, Math.abs(vx));
      vx = Math.abs(vx) * 0.45;
      hitPerimeter = true;
    } else if (px > WORLD_LIMIT) {
      px = WORLD_LIMIT;
      curbSpeed = Math.max(curbSpeed, Math.abs(vx));
      vx = -Math.abs(vx) * 0.45;
      hitPerimeter = true;
    }
    if (pz < -WORLD_LIMIT) {
      pz = -WORLD_LIMIT;
      curbSpeed = Math.max(curbSpeed, Math.abs(vz));
      vz = Math.abs(vz) * 0.45;
      hitPerimeter = true;
    } else if (pz > WORLD_LIMIT) {
      pz = WORLD_LIMIT;
      curbSpeed = Math.max(curbSpeed, Math.abs(vz));
      vz = -Math.abs(vz) * 0.45;
      hitPerimeter = true;
    }

    if (hitPerimeter && curbSpeed > 10.0 && curbHitCd <= 0 && !wrecked) {
      curbHitCd = 0.55;
      const curbDmg = clamp((curbSpeed - 8.0) * 0.65, 5, 22);
      integrity = Math.max(0, integrity - curbDmg);
      frontCrumple = clamp(frontCrumple + 0.12, 0, 1);
      visual?.applyDeformation(clamp((MAX_INTEGRITY - integrity) / MAX_INTEGRITY, 0, 1), crushY, frontCrumple, sideSkew);
      particles?.emitSparks([px, py + 0.8, pz], 12, 1.0);
      audio?.playCrash(clamp(curbSpeed / 30, 0.4, 0.95));
      cameraCtrl?.addShake(0.42);
      syncPartsForDamage(0, [0, 5, 0]);
      if (integrity <= 0) {
        triggerWreck([0, 7, 0]);
      } else if (integrity <= 35 && !onFire) {
        onFire = true;
        emitAlert('CAR ON FIRE! GET OUT!', 'danger', 3.5);
      }
    }

    // Derive positive speed magnitude & gear readout
    const horizSpeedMs = Math.hypot(vx, vz);
    speedKmh = horizSpeedMs * 3.6;
    const fX = Math.sin(yaw);
    const fZ = Math.cos(yaw);
    const signedFwd = vx * fX + vz * fZ;
    if (!eff.parkHold && (signedFwd < -0.35 || (eff.brake > 0 && signedFwd <= 0.25 && !wrecked))) {
      gear = 'R';
    } else {
      const ratio = clamp(speedKmh / Math.max(40, vehicleDef.maxSpeedKmh), 0, 1);
      const gearNum = clamp(1 + Math.floor(ratio * 5.99), 1, 6);
      gear = `D${gearNum}`;
    }

    // Update visuals & zone detection
    visual?.setWheelSpin(wheelSpinRad, steerAngle);
    syncVisualTransform();
    updateZoneTracking();
  };

  const getWorldVehicleState = () => {
    const speedMs = Math.hypot(vx, vy, vz);
    worldVehState.id = vehicleDef.id;
    worldVehState.vehicleId = vehicleDef.id;
    worldVehState.position[0] = px;
    worldVehState.position[1] = py;
    worldVehState.position[2] = pz;
    worldVehState.velocity[0] = vx;
    worldVehState.velocity[1] = vy;
    worldVehState.velocity[2] = vz;
    worldVehState.yaw = yaw;
    worldVehState.speed = speedMs;
    worldVehState.speedKmh = speedKmh;
    worldVehState.isAirborne = isAirborne;
    worldVehState.wrecked = wrecked;
    return worldVehState;
  };

  const getCameraTarget = (titleShowcase = false) => {
    const snap = pendingSnap;
    pendingSnap = false;

    if (avatar && avatar.isRagdolling()) {
      const avPos = avatar.getWorldPosition();
      return {
        position: [avPos.x, Math.max(0.5, avPos.y), avPos.z],
        velocity: [vx * 0.4, vy * 0.4, vz * 0.4],
        yaw,
        speedKmh,
        isAirborne: avPos.y > 2.2,
        dimensions: vehicleDef.dimensions,
        cockpitOffset: vehicleDef.cockpitOffset,
        snap,
      };
    }

    return {
      position: [px, py, pz],
      velocity: [vx, vy, vz],
      yaw,
      speedKmh: titleShowcase ? 0 : speedKmh,
      isAirborne,
      dimensions: vehicleDef.dimensions,
      cockpitOffset: vehicleDef.cockpitOffset,
      snap,
    };
  };

  const getSnapshot = () => ({
    vehicleId: vehicleDef.id,
    vehicleName: vehicleDef.name,
    vehicleColor,
    enginePitch: vehicleDef.enginePitch,
    maxSpeedKmh: vehicleDef.maxSpeedKmh,
    zoneId,
    integrity,
    maxIntegrity: MAX_INTEGRITY,
    detachedParts: countDetachedParts(),
    totalParts: getTotalParts(),
    speedKmh,
    gear,
    nitro,
    onFire,
    wrecked,
    ragdolling: Boolean(avatar && avatar.isRagdolling()),
    autoSmashActive: autoSmash.active,
    isBoosting,
    isDrifting,
    steerAngle,
    position: [px, py, pz],
    velocity: [vx, vy, vz],
  });

  // Boot initial starter vehicle at hub_lab (zero pre-RAF compile/render!)
  mountVehicleVisual(vehicleDef, vehicleColor);
  placeAtZoneSpawn(zoneId);

  const dispose = () => {
    cancelAutoSmash();
    if (avatar && avatar.group && avatar.group.parent) {
      avatar.group.parent.remove(avatar.group);
    }
    if (visual) {
      if (visual.root && visual.root.parent) {
        visual.root.parent.remove(visual.root);
      }
      if (typeof visual.dispose === 'function') {
        visual.dispose();
      }
      visual = null;
    }
  };

  return {
    stepKinematics,
    flushPendingTriggers,
    applyHazardImpacts,
    triggerTnt,
    toggleRagdoll,
    repairAndReset,
    teleportToZone,
    selectVehicle,
    setPaintColor,
    startAutoSmash,
    cancelAutoSmash,
    queueZoneTrigger,
    queueNearestTrigger,
    getWorldVehicleState,
    getCameraTarget,
    getSteerAngle: () => steerAngle,
    getSnapshot,
    dispose,
  };
}
