/**
 * Application Bootstrapper & Subsystem Coordinator (Contracts #0-#14).
 *
 * Enforces all 4 iPad Safari WebKit Guardrails:
 *   - Guardrail 1: Zero pre-RAF shader compilation and zero synchronous
 *     renderer.render() before loop.start(). Frame 1 renders live 3D Roblox
 *     hub behind #start-overlay inside the first real requestAnimationFrame.
 *   - Guardrail 2: Calls enforceMaterialGuardrails(scene) on boot and after
 *     every vehicle spawn, paint swatch change, and zone teleport.
 *   - Guardrail 3: All UI controls bind via bindHudTouchAction / bindHoldControl;
 *     audio unlocks strictly on first user gesture; zero ms dedup timers.
 *   - Guardrail 4: Garage & Teleport modals enforce >= 450 ms backdrop guard.
 */

import { enforceMaterialGuardrails } from './core/materials.js';
import { createSceneContext } from './core/scene.js';
import { createGameLoop } from './core/loop.js';
import { createCameraController } from './core/camera.js';
import { createTestSeam } from './core/seam.js';
import { getZoneById } from './data/zones.js';
import { createTextureLibrary } from './world/textures.js';
import { createRobloxAvatar } from './world/avatars.js';
import { createDestructionWorld } from './world/arena.js';
import { createParticleSystem } from './fx/particles.js';
import { createAudioEngine } from './fx/audio.js';
import { createScoringSystem } from './sim/scoring.js';
import { createPhysicsSim } from './sim/physics.js';
import { createHudController } from './ui/hud.js';
import { createGarageModal } from './ui/garage_modal.js';
import { createTeleportModal } from './ui/teleport_modal.js';

function bootstrap() {
  const canvas = document.getElementById('game-canvas');
  if (!canvas) {
    return;
  }

  let sceneCtx;
  try {
    sceneCtx = createSceneContext(canvas);
  } catch (_) {
    // createSceneContext already revealed #webgl-fallback on WebGL failure.
    return;
  }

  const textures = createTextureLibrary();
  const world = createDestructionWorld(sceneCtx.scene, textures);
  const particles = createParticleSystem(sceneCtx.scene);
  const audio = createAudioEngine();
  const avatar = createRobloxAvatar('jj', sceneCtx.scene);
  const cameraCtrl = createCameraController(sceneCtx.camera, canvas);

  let started = false;
  let activeModal = null; // null | 'garage' | 'teleport'
  let lastGarageCash = -1;
  let lastAlert = '';
  let transientAlertText = '';
  let transientAlertTone = 'warn';
  let transientAlertTimer = 0;

  // Strictly the 10 discrete HUD buttons (NO aggregate total key!)
  const hudActionCounts = {
    play: 0,
    garage: 0,
    teleport: 0,
    camera: 0,
    ragdoll: 0,
    audio: 0,
    auto_smash: 0,
    tnt: 0,
    repair: 0,
    machine_trigger: 0,
  };

  const recordHudAction = (key) => {
    if (Object.prototype.hasOwnProperty.call(hudActionCounts, key)) {
      hudActionCounts[key] += 1;
    }
  };

  const setTransientAlert = (text, tone = 'warn', durationSec = 2.6) => {
    const clean = String(text || '').trim();
    if (!clean) return;
    transientAlertText = clean;
    transientAlertTone = tone;
    transientAlertTimer = Math.max(0.4, Number(durationSec) || 2.4);
    lastAlert = clean;
  };

  const scoring = createScoringSystem({
    onLevelUp: (newLevel, bonusCash) => {
      audio.playTrick();
      setTransientAlert(`LEVEL UP! LVL ${newLevel} +$${bonusCash}`, 'info', 2.8);
    },
  });

  const sim = createPhysicsSim({
    scene: sceneCtx.scene,
    world,
    particles,
    audio,
    avatar,
    scoring,
    textures,
    cameraCtrl,
    initialVehicleId: 'sedan',
    initialZoneId: 'hub_lab',
    onAlert: setTransientAlert,
  });

  // Guardrail 2: sweep full assembled world + starter vehicle materials on boot
  enforceMaterialGuardrails(sceneCtx.scene);

  // Forward declarations for mutual modal coordination
  let hud = null;
  let garageModal = null;
  let teleportModal = null;

  const syncModalState = (modalName, isOpen) => {
    if (isOpen) {
      activeModal = modalName;
      sim.cancelAutoSmash();
    } else if (activeModal === modalName) {
      activeModal = null;
    }
    hud?.setModalOpen(activeModal !== null);
  };

  const closeActiveModal = () => {
    if (activeModal === 'garage') {
      garageModal?.close();
    } else if (activeModal === 'teleport') {
      teleportModal?.close();
    }
  };

  const buildGarageSyncPayload = () => {
    const simSnap = sim.getSnapshot();
    const scoreSnap = scoring.getState(simSnap.vehicleId);
    return {
      activeVehicleId: simSnap.vehicleId,
      activeColorHex: simSnap.vehicleColor,
      cash: scoreSnap.cash,
      ownedIds: scoring.getOwnedSet(),
      vehicleLevels: scoring.getVehicleLevelsMap(),
    };
  };

  garageModal = createGarageModal({
    onAudioUnlock: () => audio.unlock(),
    onOpenChange: (isOpen) => syncModalState('garage', isOpen),
    onSelectPaint: (swatch) => {
      if (!swatch) return;
      sim.setPaintColor(swatch.hex);
      enforceMaterialGuardrails(sceneCtx.scene);
      audio.playButton();
    },
    onSelectVehicle: (vehicleDef, colorHex) => {
      if (!vehicleDef) return;
      const buyResult = scoring.buyOrTryVehicle(vehicleDef);
      if (!buyResult.allowed) return;
      sim.selectVehicle(vehicleDef.id, colorHex);
      enforceMaterialGuardrails(sceneCtx.scene);
      if (buyResult.purchased) {
        audio.playCash(vehicleDef.price);
        setTransientAlert(`BOUGHT ${vehicleDef.name.toUpperCase()}!`, 'info', 2.4);
      } else if (buyResult.freeTrial) {
        audio.playButton();
        setTransientAlert(`FREE TRIAL: ${vehicleDef.name.toUpperCase()}`, 'info', 2.4);
      } else {
        audio.playButton();
      }
    },
  });

  teleportModal = createTeleportModal({
    onAudioUnlock: () => audio.unlock(),
    onOpenChange: (isOpen) => syncModalState('teleport', isOpen),
    onSelectZone: (zoneDef) => {
      if (!zoneDef) return;
      sim.teleportToZone(zoneDef.id);
      enforceMaterialGuardrails(sceneCtx.scene);
      audio.playButton();
    },
  });

  hud = createHudController({
    onAudioUnlock: () => audio.unlock(),
    onHudAction: recordHudAction,
    onPlay: () => {
      if (!started) {
        started = true;
        hud.setStarted(true);
        audio.playButton();
        setTransientAlert('SMASH EVERYTHING! TAP 🚀 SMASH!', 'info', 2.4);
      }
    },
    onOpenGarage: () => {
      if (!started) return;
      if (teleportModal.isOpen()) teleportModal.close();
      audio.playButton();
      const payload = buildGarageSyncPayload();
      lastGarageCash = payload.cash;
      garageModal.open(payload);
    },
    onOpenTeleport: () => {
      if (!started) return;
      if (garageModal.isOpen()) garageModal.close();
      audio.playButton();
      teleportModal.open({ activeZoneId: sim.getSnapshot().zoneId });
    },
    onCycleCamera: () => {
      if (!started) return cameraCtrl.getMode();
      audio.playButton();
      return cameraCtrl.cycleMode();
    },
    onToggleRagdoll: () => {
      if (!started) return;
      sim.toggleRagdoll();
    },
    onToggleAudio: () => {
      if (!started) return audio.isMuted();
      const nextMuted = !audio.isMuted();
      audio.setMuted(nextMuted);
      if (!nextMuted) audio.playButton();
      return audio.isMuted();
    },
    onAutoSmash: () => {
      if (!started) return;
      audio.playButton();
      sim.startAutoSmash();
    },
    onThrowTnt: () => {
      if (!started) return;
      sim.triggerTnt();
    },
    onRepair: () => {
      if (!started) return;
      audio.playButton();
      sim.repairAndReset();
    },
    onMachineTrigger: () => {
      if (!started) return;
      const snap = sim.getSnapshot();
      if (snap.wrecked) {
        audio.playButton();
        setTransientAlert('WRECKED! Tap FIX or CARS', 'wrecked', 4.0);
        return;
      }
      const activeTriggerAlert = world.getActiveAlerts(snap.position).find((a) => a && a.triggerable);
      if (activeTriggerAlert && activeTriggerAlert.zoneId) {
        sim.queueZoneTrigger(activeTriggerAlert.zoneId);
        return;
      }
      const zone = getZoneById(snap.zoneId);
      if (zone && zone.hasManualTrigger) {
        sim.queueZoneTrigger(zone.id);
      } else {
        sim.queueNearestTrigger();
      }
    },
    onHorn: () => {
      if (started && !sim.getSnapshot().wrecked) audio.playHorn();
    },
    onEscape: closeActiveModal,
  });

  hud.setStarted(false);
  hud.updateCameraButton(cameraCtrl.getMode());
  hud.updateAudioButton(audio.isMuted());

  // Exact 60 Hz fixed-step update order required by M2B crushers/trains:
  // pending triggers -> kinematics -> world.update -> world.queryHazards ->
  // impacts -> scoring -> particles -> avatar -> camera + sunTarget -> audio
  const onUpdate = (fixedDt) => {
    if (transientAlertTimer > 0) {
      transientAlertTimer = Math.max(0, transientAlertTimer - fixedDt);
      if (transientAlertTimer <= 0) {
        transientAlertText = '';
      }
    }

    const worldActive = started && activeModal === null;

    // 1. Flush queued manual / Auto-Smash triggers BEFORE world.update
    if (worldActive) {
      sim.flushPendingTriggers();
    }

    // 2. Step driving / stunt / Auto-Smash kinematics
    if (worldActive) {
      sim.stepKinematics(fixedDt, hud.getControls());
    }

    // 3. Advance world machines, trains, AI cars & football physics
    if (worldActive) {
      const vehForWorld = sim.getWorldVehicleState();
      world.update(fixedDt, vehForWorld);
    }

    // 4. Query deterministic HazardImpacts and apply damage/debris/scoring
    if (worldActive) {
      const impacts = world.queryHazards(sim.getWorldVehicleState());
      if (impacts.length > 0) {
        sim.applyHazardImpacts(impacts);
      }
    }

    const snap = sim.getSnapshot();

    // 5. Advance scoring combos, trick feed & soccer/rival updates
    scoring.update(fixedDt, world, snap.vehicleId, started && activeModal === null);

    // 6. Advance pooled particles & tumbling detached parts
    particles.update(fixedDt, world.getGroundHeight);

    // 7. Advance avatar ragdoll / seated bunny-ear animation
    avatar.updateRagdoll(fixedDt, world.getGroundHeight);
    avatar.setSteerAngle(sim.getSteerAngle());

    // 8. Update zero-roll camera & shadow frustum follow target
    cameraCtrl.update(fixedDt, sim.getCameraTarget(!started));
    sceneCtx.updateSunTarget(snap.position[0], snap.position[2]);

    // 9. Update engine synth
    const engineActive = started && !snap.wrecked && activeModal === null;
    const speedRatio = engineActive
      ? Math.min(1.5, snap.speedKmh / Math.max(40, snap.maxSpeedKmh))
      : 0;
    audio.updateEngine(
      speedRatio,
      snap.enginePitch,
      engineActive && snap.isBoosting,
      engineActive && snap.isDrifting,
    );
  };

  let loop = null;

  const onRender = () => {
    if (loop && loop.isFirstRafDone()) {
      sceneCtx.markFirstRafDone();
    }

    // Hide driver avatar only in cockpit view when seated so cockpit stays clear
    avatar.group.visible = avatar.isRagdolling() || cameraCtrl.getMode() !== 'cockpit';

    if (started) {
      const snap = sim.getSnapshot();
      const scoreSnap = scoring.getState(snap.vehicleId);
      const zone = getZoneById(snap.zoneId);
      const worldAlerts = world.getActiveAlerts(snap.position);
      const topWorldAlert = worldAlerts.length > 0 ? worldAlerts[0] : null;

      // Alert priority: wrecked > onFire > activeTransientAlert > worldAlert
      let alertText = '';
      let alertTone = 'warn';
      if (snap.wrecked) {
        alertText = 'WRECKED! Tap FIX or CARS';
        alertTone = 'wrecked';
      } else if (snap.onFire) {
        alertText = 'CAR ON FIRE! GET OUT!';
        alertTone = 'danger';
      } else if (transientAlertTimer > 0 && transientAlertText) {
        alertText = transientAlertText;
        alertTone = transientAlertTone;
      } else if (topWorldAlert && topWorldAlert.text) {
        alertText = topWorldAlert.text;
        alertTone = topWorldAlert.severity === 'danger'
          ? 'danger'
          : (topWorldAlert.severity === 'info' ? 'info' : 'warn');
      }

      if (alertText) {
        lastAlert = alertText;
      }

      const triggerAlert = worldAlerts.find((a) => a && a.triggerable) || null;
      const machineShortLabel = triggerAlert && triggerAlert.shortLabel
        ? triggerAlert.shortLabel
        : '';
      const machineAriaLabel = (triggerAlert && triggerAlert.triggerLabel)
        || (zone && zone.triggerLabel)
        || 'Trigger Crusher Machine';
      const machineReady = !snap.wrecked && Boolean(triggerAlert || (zone && zone.hasManualTrigger));

      hud.render({
        cash: scoreSnap.cash,
        mikeyCash: scoreSnap.mikeyCash,
        detachedParts: snap.detachedParts,
        totalParts: snap.totalParts,
        level: scoreSnap.level,
        integrity: snap.integrity,
        maxIntegrity: snap.maxIntegrity,
        nitro: snap.nitro,
        onFire: snap.onFire,
        speedKmh: snap.speedKmh,
        gear: snap.gear,
        cameraMode: cameraCtrl.getMode(),
        ragdolling: snap.ragdolling,
        autoSmashActive: snap.autoSmashActive,
        zoneId: snap.zoneId,
        machineShortLabel,
        machineAriaLabel,
        machineReady,
        alertText,
        alertTone,
        trickFeed: scoring.getTrickFeed(),
      });

      // Keep open Garage modal cash badge & BUY/TRY FREE CTAs live-synced with HUD cash
      if (garageModal.isOpen() && scoreSnap.cash !== lastGarageCash) {
        lastGarageCash = scoreSnap.cash;
        garageModal.syncState(buildGarageSyncPayload());
      }
    }

    sceneCtx.renderer.render(sceneCtx.scene, sceneCtx.camera);
  };

  loop = createGameLoop({
    fixedDt: 1 / 60,
    isSoftwareGpu: sceneCtx.isSoftwareGpu,
    onUpdate,
    onRender,
  });

  // Expose live Contract #14 verification seam before first rAF
  window.__ROBLOX_CAR_CRASH__ = createTestSeam({
    sceneCtx,
    loop,
    cameraCtrl,
    getStateSnapshot: () => {
      const snap = sim.getSnapshot();
      const scoreSnap = scoring.getState(snap.vehicleId);
      return {
        started,
        vehicleId: snap.vehicleId,
        vehicleColor: snap.vehicleColor,
        zoneId: snap.zoneId,
        integrity: snap.integrity,
        maxIntegrity: snap.maxIntegrity,
        detachedParts: snap.detachedParts,
        totalParts: snap.totalParts,
        cash: scoreSnap.cash,
        xp: scoreSnap.xp,
        level: scoreSnap.level,
        speedKmh: snap.speedKmh,
        nitro: snap.nitro,
        onFire: snap.onFire,
        wrecked: snap.wrecked,
        ragdolling: snap.ragdolling,
        activeModal,
        position: snap.position,
        velocity: snap.velocity,
        hudActionCounts,
        lastAlert,
        trickComboCount: scoreSnap.trickComboCount,
      };
    },
  });

  // Clean teardown on page unload
  window.addEventListener('pagehide', () => {
    loop.stop();
    hud.dispose();
    garageModal.dispose();
    teleportModal.dispose();
    sim.dispose();
    world.dispose();
    particles.dispose();
    avatar.dispose();
    cameraCtrl.dispose();
    audio.dispose();
    textures.dispose();
    sceneCtx.dispose();
  }, { once: true });

  // Guardrail 1: Frame 1 renders organically inside the first real rAF!
  loop.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
