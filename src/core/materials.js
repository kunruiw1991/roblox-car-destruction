/**
 * Material factory and non-IBL metalness guardrails (Contract #1 / Guardrail 2).
 *
 * When scene.environment is null (bright direct Roblox daylight without an IBL
 * cubemap), MeshStandardMaterial / MeshPhysicalMaterial metalness values above
 * MAX_NON_IBL_METALNESS render dark/black on iPadOS WebKit and SwiftShader.
 * Every PBR material should be created via createStandardMaterial(), and
 * enforceMaterialGuardrails(scene) sweeps scenes on boot and spawn.
 */

import * as THREE from '../../vendor/three.module.min.js';

export const MAX_NON_IBL_METALNESS = 0.20;
const DEFAULT_NON_IBL_METALNESS = 0.08;
const DEFAULT_ROUGHNESS = 0.52;

function clampNonIblMetalness(value, fallback = DEFAULT_NON_IBL_METALNESS) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  if (value === Infinity) {
    return MAX_NON_IBL_METALNESS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.min(MAX_NON_IBL_METALNESS, value);
}

/**
 * Creates a THREE.MeshStandardMaterial with non-IBL metalness capped to <= 0.20
 * whenever neither scene.environment nor params.envMap is present.
 *
 * @param {object} [params]
 * @param {THREE.Scene|null} [scene]
 * @returns {THREE.MeshStandardMaterial}
 */
export function createStandardMaterial(params = {}, scene = null) {
  const next = params && typeof params === 'object' ? { ...params } : {};
  const hasEnv = Boolean((scene && scene.environment) || next.envMap);

  if (!hasEnv) {
    next.metalness = clampNonIblMetalness(next.metalness, DEFAULT_NON_IBL_METALNESS);
  } else if (typeof next.metalness !== 'number' || !Number.isFinite(next.metalness)) {
    next.metalness = DEFAULT_NON_IBL_METALNESS;
  } else {
    next.metalness = Math.min(1, Math.max(0, next.metalness));
  }

  if (typeof next.roughness !== 'number' || !Number.isFinite(next.roughness)) {
    next.roughness = DEFAULT_ROUGHNESS;
  } else {
    next.roughness = Math.min(1, Math.max(0, next.roughness));
  }

  return new THREE.MeshStandardMaterial(next);
}

/**
 * Traverses a Three.js scene/subtree and enforces:
 *  - MeshStandardMaterial / MeshPhysicalMaterial metalness <= 0.20 when
 *    scene.environment === null (and no material.envMap)
 *  - THREE.Sprite materials have toneMapped = false and fog = false
 *
 * @param {THREE.Object3D|null} scene
 * @returns {{ checked: number, maxMetalness: number, clampedCount: number }}
 */
export function enforceMaterialGuardrails(scene) {
  if (!scene || typeof scene.traverse !== 'function') {
    return { checked: 0, maxMetalness: 0, clampedCount: 0 };
  }

  const hasSceneEnv = Boolean(scene.environment);
  const visitedMats = new Set();
  let checked = 0;
  let maxMetalness = 0;
  let clampedCount = 0;

  scene.traverse((obj) => {
    const raw = obj.material;
    if (!raw) return;
    const mats = Array.isArray(raw) ? raw : [raw];

    for (let i = 0; i < mats.length; i += 1) {
      const mat = mats[i];
      if (!mat) continue;

      if (obj.isSprite && (mat.toneMapped !== false || mat.fog !== false)) {
        mat.toneMapped = false;
        mat.fog = false;
        mat.needsUpdate = true;
      }

      if (visitedMats.has(mat)) continue;
      visitedMats.add(mat);
      checked += 1;

      const isPbr = Boolean(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial);
      const hasEnv = hasSceneEnv || Boolean(mat.envMap);
      if (!isPbr || hasEnv) continue;

      const current = mat.metalness;
      if (typeof current !== 'number' || !Number.isFinite(current) || current < 0) {
        mat.metalness = current === Infinity
          ? MAX_NON_IBL_METALNESS
          : (current < 0 ? 0 : DEFAULT_NON_IBL_METALNESS);
        mat.needsUpdate = true;
        clampedCount += 1;
      } else if (current > MAX_NON_IBL_METALNESS) {
        mat.metalness = MAX_NON_IBL_METALNESS;
        mat.needsUpdate = true;
        clampedCount += 1;
      }

      if (mat.metalness > maxMetalness) {
        maxMetalness = mat.metalness;
      }
    }
  });

  return { checked, maxMetalness, clampedCount };
}

/**
 * Read-only scene material audit helper matching Contract #14 getMaterialAudit().
 *
 * @param {THREE.Object3D|null} scene
 * @param {number} [ceiling=0.22]
 * @returns {{ hasEnvironment: boolean, checked: number, maxMetalness: number, offenders: Array<{ name: string, metalness: number }> }}
 */
export function auditSceneMaterials(scene, ceiling = 0.22) {
  const hasEnvironment = Boolean(scene && scene.environment);
  if (!scene || typeof scene.traverse !== 'function') {
    return { hasEnvironment, checked: 0, maxMetalness: 0, offenders: [] };
  }

  const visitedMats = new Set();
  const offenders = [];
  let checked = 0;
  let maxMetalness = 0;

  scene.traverse((obj) => {
    const raw = obj.material;
    if (!raw) return;
    const mats = Array.isArray(raw) ? raw : [raw];

    for (let i = 0; i < mats.length; i += 1) {
      const mat = mats[i];
      if (!mat || visitedMats.has(mat)) continue;
      visitedMats.add(mat);
      checked += 1;

      const isPbr = Boolean(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial);
      if (!isPbr) continue;

      const matHasEnv = hasEnvironment || Boolean(mat.envMap);
      if (matHasEnv) continue;

      const val = mat.metalness;
      if (typeof val === 'number' && Number.isFinite(val) && val > maxMetalness) {
        maxMetalness = val;
      }

      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > ceiling) {
        offenders.push({
          name: mat.name || obj.name || 'unnamed',
          metalness: val,
        });
      }
    }
  });

  return { hasEnvironment, checked, maxMetalness, offenders };
}
