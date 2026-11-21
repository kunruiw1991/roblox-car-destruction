/**
 * Zero-roll Chase, Cockpit & Close-Orbit Camera Controller (Contract #4).
 *
 * UNIFIED +Z VEHICLE FORWARD CONVENTION (matching zones.js & vehicles.js):
 *   - Vehicle local +Z = FRONT, -Z = REAR, +Y = UP, +X = VEHICLE LEFT.
 *   - Default forwardSign = +1 -> forward = [Math.sin(yaw), 0, Math.cos(yaw)].
 *   - When yaw = 0, chase camera sits BEHIND at -Z looking FORWARD toward +Z.
 *   - Cockpit offset [ox, oy, oz] (oz > 0 toward windshield) transforms via
 *     Three.js Y-rotation: worldX = pos.x + ox*cos(yaw) + oz*sin(yaw),
 *     worldZ = pos.z - ox*sin(yaw) + oz*cos(yaw).
 *
 * ZERO-ROLL INVARIANT:
 *   aimZeroRoll() sets camera.rotation.order = 'YXZ' and
 *   camera.rotation.set(pitch, yaw, 0), mathematically guaranteeing
 *   camera.rotation.z === 0 AND Math.abs(camera.matrixWorld.elements[1]) < 1e-6.
 */

import * as THREE from '../../vendor/three.module.min.js';

const MODES = Object.freeze(['chase', 'cockpit', 'orbit_close']);
const TWO_PI = Math.PI * 2;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function finiteOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function wrapAngle(a) {
  let r = (a + Math.PI) % TWO_PI;
  if (r < 0) r += TWO_PI;
  return r - Math.PI;
}

function readVec3(input, fx, fy, fz, out) {
  if (Array.isArray(input) && input.length >= 3) {
    out.set(finiteOr(input[0], fx), finiteOr(input[1], fy), finiteOr(input[2], fz));
    return out;
  }
  if (input && typeof input === 'object') {
    out.set(finiteOr(input.x, fx), finiteOr(input.y, fy), finiteOr(input.z, fz));
    return out;
  }
  out.set(fx, fy, fz);
  return out;
}

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {HTMLCanvasElement|null} canvas
 */
export function createCameraController(camera, canvas) {
  let modeIndex = 0;
  let orbitYawOffset = 0;
  let orbitPitchOffset = 0;
  let dragCooldown = 0;
  let shakeTrauma = 0;
  let shakeTime = 0;
  let initialized = false;
  let disposed = false;

  let orbitPointerId = null;
  let lastPointerX = 0;
  let lastPointerY = 0;

  const smoothCamPos = new THREE.Vector3(0, 5, -10);
  const smoothLookPos = new THREE.Vector3(0, 1.5, 4);
  const lastTargetPos = new THREE.Vector3();

  // Reusable scratch vectors (zero per-frame allocations)
  const targetPos = new THREE.Vector3();
  const targetVel = new THREE.Vector3();
  const focusPos = new THREE.Vector3();
  const desiredCamPos = new THREE.Vector3();
  const desiredLookPos = new THREE.Vector3();
  const finalCamPos = new THREE.Vector3();
  const finalLookPos = new THREE.Vector3();
  const cockpitLocal = new THREE.Vector3();
  const fwdVec = new THREE.Vector3();

  camera.up.set(0, 1, 0);
  camera.rotation.order = 'YXZ';
  camera.rotation.z = 0;

  /**
   * Positions and aims camera from camPos to lookPos using Three.js's -Z camera
   * axis under YXZ Euler order with roll locked strictly to 0.
   */
  const aimZeroRoll = (camPos, lookPos) => {
    const dx = lookPos.x - camPos.x;
    const dy = lookPos.y - camPos.y;
    const dz = lookPos.z - camPos.z;
    const horiz = Math.max(0.001, Math.hypot(dx, dz));
    const camYaw = Math.atan2(-dx, -dz);
    const camPitch = clamp(Math.atan2(dy, horiz), -1.25, 1.25);

    camera.position.copy(camPos);
    camera.up.set(0, 1, 0);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(camPitch, camYaw, 0);
    camera.updateMatrixWorld();
  };

  // Single-finger open-canvas drag orbit (does NOT reject e.isPrimary === false
  // so players can hold GAS/steer with one thumb and orbit with the other).
  const onPointerDown = (e) => {
    if (disposed || !canvas) return;
    if (e.target !== canvas) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (orbitPointerId !== null) return;

    orbitPointerId = e.pointerId !== undefined ? e.pointerId : 'mouse';
    lastPointerX = finiteOr(e.clientX, 0);
    lastPointerY = finiteOr(e.clientY, 0);
    dragCooldown = 3.0;

    if (e.cancelable) e.preventDefault();
    if (e.pointerId !== undefined) {
      try {
        canvas.setPointerCapture?.(e.pointerId);
      } catch (_) {
        // Synthetic events or detached nodes may disallow pointer capture.
      }
    }
  };

  const onPointerMove = (e) => {
    if (disposed || orbitPointerId === null) return;
    const pid = e.pointerId !== undefined ? e.pointerId : 'mouse';
    if (pid !== orbitPointerId) return;

    const x = finiteOr(e.clientX, lastPointerX);
    const y = finiteOr(e.clientY, lastPointerY);
    const dx = clamp(x - lastPointerX, -160, 160);
    const dy = clamp(y - lastPointerY, -160, 160);
    lastPointerX = x;
    lastPointerY = y;

    orbitYawOffset = wrapAngle(orbitYawOffset - dx * 0.0065);
    orbitPitchOffset = clamp(orbitPitchOffset + dy * 0.0045, -0.35, 0.55);
    dragCooldown = 3.0;

    if (e.cancelable) e.preventDefault();
  };

  const releaseOrbit = (e) => {
    if (orbitPointerId === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== orbitPointerId) return;
    const pid = orbitPointerId;
    orbitPointerId = null;
    if (canvas && typeof pid === 'number') {
      try {
        if (canvas.hasPointerCapture?.(pid)) {
          canvas.releasePointerCapture(pid);
        }
      } catch (_) {
        // Ignore release errors when pointer already released.
      }
    }
  };

  const onWindowBlur = () => {
    releaseOrbit();
  };

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.hidden) {
      releaseOrbit();
    }
  };

  if (canvas && typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', releaseOrbit);
    canvas.addEventListener('pointercancel', releaseOrbit);
    canvas.addEventListener('lostpointercapture', releaseOrbit);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerup', releaseOrbit);
    window.addEventListener('pointercancel', releaseOrbit);
    window.addEventListener('blur', onWindowBlur);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  const update = (dt, targetState = {}) => {
    const clampedDt = clamp(finiteOr(dt, 1 / 60), 0.001, 0.1);
    const state = targetState && typeof targetState === 'object' ? targetState : {};

    readVec3(state.position, 0, 0.5, 0, targetPos);
    readVec3(state.velocity, 0, 0, 0, targetVel);

    // Unified +Z vehicle forward convention (default forwardSign = +1).
    const forwardSign = state.forwardSign === -1 ? -1 : 1;
    let yaw = finiteOr(state.yaw, 0);
    let fwdX = forwardSign * Math.sin(yaw);
    let fwdZ = forwardSign * Math.cos(yaw);

    if (state.forward) {
      readVec3(state.forward, fwdX, 0, fwdZ, fwdVec);
      const flen = Math.hypot(fwdVec.x, fwdVec.z);
      if (flen > 1e-4) {
        fwdX = fwdVec.x / flen;
        fwdZ = fwdVec.z / flen;
        yaw = Math.atan2(fwdX, fwdZ);
      }
    }

    const speedKmh = finiteOr(state.speedKmh, Math.hypot(targetVel.x, targetVel.z) * 3.6);
    const isAirborne = Boolean(state.isAirborne || targetPos.y > 2.2);
    const dimL = finiteOr(state.dimensions && state.dimensions.l, 4.55);
    const dimH = finiteOr(state.dimensions && state.dimensions.h, 1.50);
    const sizeScale = clamp(Math.max(dimL / 4.55, dimH / 1.50), 0.85, 1.85);
    const isPortrait = camera.aspect < 0.92;
    const speedRatio = clamp(Math.abs(speedKmh) / 140, 0, 1.2);
    const mode = MODES[modeIndex];

    const jumpDist = initialized ? targetPos.distanceTo(lastTargetPos) : Infinity;
    const shouldSnap = !initialized || state.snap === true || jumpDist > 22;
    lastTargetPos.copy(targetPos);

    if (dragCooldown > 0 && orbitPointerId === null) {
      dragCooldown = Math.max(0, dragCooldown - clampedDt);
    }

    if (mode === 'chase' && orbitPointerId === null && dragCooldown <= 0 && Math.abs(speedKmh) > 12) {
      orbitYawOffset *= Math.exp(-1.4 * clampedDt);
      if (Math.abs(orbitYawOffset) < 0.003) orbitYawOffset = 0;
    }

    focusPos.set(targetPos.x, targetPos.y + Math.max(0.85, dimH * 0.62), targetPos.z);

    let targetFov = isPortrait ? 64 : 58;

    if (mode === 'cockpit') {
      readVec3(state.cockpitOffset, 0, 1.18, 0.52, cockpitLocal);
      const ox = cockpitLocal.x;
      const oy = cockpitLocal.y;
      const oz = cockpitLocal.z * forwardSign;
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);

      // Three.js Y-rotation of local cockpit offset into world space.
      desiredCamPos.set(
        targetPos.x + ox * cosY + oz * sinY,
        targetPos.y + oy,
        targetPos.z - ox * sinY + oz * cosY,
      );

      const baseHeading = Math.atan2(fwdX, fwdZ);
      const lookYaw = baseHeading + clamp(orbitYawOffset, -1.1, 1.1);
      const lookPitch = clamp(orbitPitchOffset, -0.25, 0.30);
      const cosP = Math.cos(lookPitch);
      desiredLookPos.set(
        desiredCamPos.x + Math.sin(lookYaw) * cosP * 24,
        desiredCamPos.y + Math.sin(lookPitch) * 24,
        desiredCamPos.z + Math.cos(lookYaw) * cosP * 24,
      );

      smoothCamPos.copy(desiredCamPos);
      smoothLookPos.copy(desiredLookPos);
      targetFov = 68 + speedRatio * 5;
    } else if (mode === 'orbit_close') {
      const dist = (isPortrait ? 7.4 : 6.0) * sizeScale;
      const baseHeight = (isPortrait ? 2.8 : 2.3) * sizeScale;
      const baseElev = Math.atan2(baseHeight, dist);
      const elev = clamp(baseElev + orbitPitchOffset, 0.14, 1.15);
      const radius = Math.hypot(dist, baseHeight);
      const horizDist = radius * Math.cos(elev);
      const vertHeight = Math.max(0.75, radius * Math.sin(elev));

      const baseHeading = Math.atan2(fwdX, fwdZ);
      const orbitHeading = baseHeading + orbitYawOffset;
      const dirX = Math.sin(orbitHeading);
      const dirZ = Math.cos(orbitHeading);

      desiredCamPos.set(
        focusPos.x - dirX * horizDist,
        Math.max(focusPos.y + 0.75, focusPos.y + vertHeight),
        focusPos.z - dirZ * horizDist,
      );
      desiredLookPos.copy(focusPos);

      if (shouldSnap) {
        smoothCamPos.copy(desiredCamPos);
        smoothLookPos.copy(desiredLookPos);
      } else {
        const posAlpha = 1 - Math.exp(-9.5 * clampedDt);
        const lookAlpha = 1 - Math.exp(-12.0 * clampedDt);
        smoothCamPos.lerp(desiredCamPos, posAlpha);
        smoothLookPos.lerp(desiredLookPos, lookAlpha);
      }
      targetFov = isPortrait ? 60 : 54;
    } else {
      // Default 'chase' mode: behind vehicle along -forward, looking forward toward +forward.
      const dist = (isPortrait ? 11.4 : 9.2) * sizeScale + speedRatio * 2.4 + (isAirborne ? 2.2 : 0);
      const baseHeight = (isPortrait ? 4.8 : 3.9) * sizeScale + (isAirborne ? 1.0 : 0);
      const baseElev = Math.atan2(baseHeight, dist);
      const elev = clamp(baseElev + orbitPitchOffset, 0.12, 1.12);
      const radius = Math.hypot(dist, baseHeight);
      const horizDist = radius * Math.cos(elev);
      const vertHeight = Math.max(0.75, radius * Math.sin(elev));

      const baseHeading = Math.atan2(fwdX, fwdZ);
      const orbitHeading = baseHeading + orbitYawOffset;
      const dirX = Math.sin(orbitHeading);
      const dirZ = Math.cos(orbitHeading);

      desiredCamPos.set(
        focusPos.x - dirX * horizDist,
        Math.max(focusPos.y + 0.75, focusPos.y + vertHeight),
        focusPos.z - dirZ * horizDist,
      );

      const lookAhead = (3.2 * sizeScale + speedRatio * 2.5) * Math.max(0, Math.cos(orbitYawOffset));
      desiredLookPos.set(
        focusPos.x + fwdX * lookAhead,
        focusPos.y + 0.35,
        focusPos.z + fwdZ * lookAhead,
      );

      if (shouldSnap) {
        smoothCamPos.copy(desiredCamPos);
        smoothLookPos.copy(desiredLookPos);
      } else {
        const posAlpha = 1 - Math.exp(-7.5 * clampedDt);
        const lookAlpha = 1 - Math.exp(-10.5 * clampedDt);
        smoothCamPos.lerp(desiredCamPos, posAlpha);
        smoothLookPos.lerp(desiredLookPos, lookAlpha);
      }
      targetFov = (isPortrait ? 64 : 58) + speedRatio * 8.5;
    }

    initialized = true;

    // Smooth FOV update (only rebuild projection matrix when visibly changed).
    const fovAlpha = shouldSnap ? 1 : (1 - Math.exp(-6.0 * clampedDt));
    const nextFov = camera.fov + (targetFov - camera.fov) * fovAlpha;
    if (Math.abs(nextFov - camera.fov) > 0.05) {
      camera.fov = nextFov;
      camera.updateProjectionMatrix();
    }

    finalCamPos.copy(smoothCamPos);
    finalLookPos.copy(smoothLookPos);

    // Zero-roll translational impact shake along horizontal camera-right + world +Y.
    if (shakeTrauma > 0) {
      shakeTime += clampedDt;
      const amp = shakeTrauma * shakeTrauma * 0.55;
      const ldx = finalLookPos.x - finalCamPos.x;
      const ldz = finalLookPos.z - finalCamPos.z;
      const lLen = Math.max(0.001, Math.hypot(ldx, ldz));
      const rightX = -ldz / lLen;
      const rightZ = ldx / lLen;

      const jitterX = (Math.sin(shakeTime * 53.0) * 0.65 + Math.cos(shakeTime * 89.0) * 0.35) * amp;
      const jitterY = (Math.cos(shakeTime * 67.0) * 0.65 + Math.sin(shakeTime * 113.0) * 0.35) * amp * 0.72;

      finalCamPos.x += rightX * jitterX;
      finalCamPos.y += jitterY;
      finalCamPos.z += rightZ * jitterX;
      finalLookPos.x += rightX * jitterX * 0.35;
      finalLookPos.y += jitterY * 0.35;
      finalLookPos.z += rightZ * jitterX * 0.35;

      shakeTrauma *= Math.exp(-5.5 * clampedDt);
      if (shakeTrauma < 0.002) shakeTrauma = 0;
    }

    aimZeroRoll(finalCamPos, finalLookPos);
  };

  const cycleMode = () => {
    modeIndex = (modeIndex + 1) % MODES.length;
    if (MODES[modeIndex] === 'cockpit') {
      orbitYawOffset = clamp(orbitYawOffset, -0.5, 0.5);
      orbitPitchOffset = 0;
    }
    return MODES[modeIndex];
  };

  const getMode = () => MODES[modeIndex];

  const addShake = (intensity = 0.5) => {
    const val = finiteOr(intensity, 0);
    if (val <= 0) return;
    shakeTrauma = Math.min(1.5, shakeTrauma + clamp(val, 0, 1.5));
  };

  const resetOrbit = () => {
    orbitYawOffset = 0;
    orbitPitchOffset = 0;
    dragCooldown = 0;
  };

  const getOrbitAngles = () => ({
    yaw: orbitYawOffset,
    pitch: orbitPitchOffset,
  });

  const dispose = () => {
    if (disposed) return;
    releaseOrbit();
    disposed = true;
    orbitPointerId = null;

    if (canvas && typeof canvas.removeEventListener === 'function') {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', releaseOrbit);
      canvas.removeEventListener('pointercancel', releaseOrbit);
      canvas.removeEventListener('lostpointercapture', releaseOrbit);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerup', releaseOrbit);
      window.removeEventListener('pointercancel', releaseOrbit);
      window.removeEventListener('blur', onWindowBlur);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };

  return {
    update,
    cycleMode,
    getMode,
    addShake,
    resetOrbit,
    getOrbitAngles,
    dispose,
  };
}
