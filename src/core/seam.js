/**
 * Read-Only Live Inspection & Deterministic Stepping Seam (Contract #14).
 *
 * Exposes window.__ROBLOX_CAR_CRASH__ with strictly genuine live state
 * snapshots, non-IBL material audit (delegating to auditSceneMaterials),
 * canvas stats (delegating to sceneCtx.getCanvasStats), and deterministic
 * fixed-step stepping (delegating to loop.stepFrames).
 */

import { auditSceneMaterials } from './materials.js';

function finiteNum(val, fallback = 0) {
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

function finiteVec3(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return [0, 0, 0];
  return [
    finiteNum(arr[0], 0),
    finiteNum(arr[1], 0),
    finiteNum(arr[2], 0),
  ];
}

/**
 * Creates the frozen Contract #14 inspection seam object.
 *
 * @param {object} deps
 */
export function createTestSeam({
  sceneCtx,
  loop,
  cameraCtrl,
  getStateSnapshot,
}) {
  return Object.freeze({
    getState() {
      const snap = typeof getStateSnapshot === 'function' ? getStateSnapshot() : {};
      const counts = snap.hudActionCounts && typeof snap.hudActionCounts === 'object'
        ? { ...snap.hudActionCounts }
        : {};
      const camRoll = sceneCtx && sceneCtx.camera && sceneCtx.camera.rotation
        ? finiteNum(sceneCtx.camera.rotation.z, 0)
        : 0;
      const maxInt = Math.max(1, finiteNum(snap.maxIntegrity, 100));
      const integrity = Math.min(maxInt, Math.max(0, finiteNum(snap.integrity, maxInt)));
      const totalParts = Math.max(0, Math.round(finiteNum(snap.totalParts, 12)));
      const detachedParts = Math.min(totalParts, Math.max(0, Math.round(finiteNum(snap.detachedParts, 0))));
      const nitro = Math.min(100, Math.max(0, finiteNum(snap.nitro, 100)));

      return {
        started: Boolean(snap.started),
        frameCount: Math.max(0, Math.floor(finiteNum(loop ? loop.getFrameCount() : 0, 0))),
        firstRafDone: Boolean(loop && loop.isFirstRafDone()),
        compileBeforeFirstRaf: Boolean(sceneCtx && Number(sceneCtx.getCompileBeforeFirstRaf()) > 0),
        vehicleId: String(snap.vehicleId || 'sedan'),
        vehicleColor: String(snap.vehicleColor || '#e53935'),
        zoneId: String(snap.zoneId || 'hub_lab'),
        integrity,
        maxIntegrity: maxInt,
        detachedParts,
        totalParts,
        cash: Math.max(0, finiteNum(snap.cash, 0)),
        xp: Math.max(0, finiteNum(snap.xp, 0)),
        level: Math.max(1, Math.floor(finiteNum(snap.level, 1))),
        speedKmh: Math.max(0, finiteNum(snap.speedKmh, 0)),
        nitro,
        onFire: Boolean(snap.onFire),
        wrecked: Boolean(snap.wrecked),
        ragdolling: Boolean(snap.ragdolling),
        activeModal: snap.activeModal === 'garage' || snap.activeModal === 'teleport'
          ? snap.activeModal
          : null,
        cameraMode: String(cameraCtrl && typeof cameraCtrl.getMode === 'function' ? cameraCtrl.getMode() : 'chase'),
        cameraRoll: camRoll,
        position: finiteVec3(snap.position),
        velocity: finiteVec3(snap.velocity),
        hudActionCounts: counts,
        lastAlert: String(snap.lastAlert || ''),
        trickComboCount: Math.max(0, Math.floor(finiteNum(snap.trickComboCount, 0))),
      };
    },

    getMaterialAudit() {
      return auditSceneMaterials(sceneCtx ? sceneCtx.scene : null, 0.22);
    },

    getCanvasStats() {
      if (sceneCtx && typeof sceneCtx.getCanvasStats === 'function') {
        return sceneCtx.getCanvasStats();
      }
      return { width: 0, height: 0, dpr: 1, isSoftwareGpu: false };
    },

    stepFrames(count, dt = 1 / 60) {
      if (loop && typeof loop.stepFrames === 'function') {
        return loop.stepFrames(count, dt);
      }
      return 0;
    },
  });
}
