/**
 * Economy, Per-Vehicle Progression, Trick/Crash Combo Scorecard & Leaderboard
 * State (Contracts #6, #7, #13, #14).
 *
 * Tracks starting cash ($1,500), monotonically non-decreasing player XP & Level
 * across repairs and vehicle swaps, per-vehicle Garage levels, capped 4-row
 * Stunt/Crash Combo Feed, Car Football & Derby scores, and Mikey_Turtle rival
 * cash progression. All timers advance strictly by fixed-step dt.
 */

import { VEHICLES } from '../data/vehicles.js';

const STARTING_CASH = 1500;
const STARTING_MIKEY_CASH = 1250;
const MAX_TRICK_ROWS = 4;
const MAX_TRICK_TEXT_LEN = 26;
const TRICK_ROW_TTL_SEC = 5.2;
const COMBO_WINDOW_SEC = 6.5;

const PART_LABELS = Object.freeze({
  frontBumper: 'FRONT BUMPER',
  rearBumper: 'REAR BUMPER',
  hood: 'HOOD',
  fenderF: 'FENDER',
  windshield: 'WINDSHIELD',
  doorL: 'LEFT DOOR',
  doorR: 'RIGHT DOOR',
  trunk: 'TRUNK',
  cargoBox: 'CARGO BOX',
  bench: 'REAR BENCH',
  roof: 'ROOF',
  canopy: 'CANOPY',
  wheelFL: 'FL WHEEL',
  wheelFR: 'FR WHEEL',
  wheelRL: 'RL WHEEL',
  wheelRR: 'RR WHEEL',
  wheelF: 'FRONT WHEEL',
});

function xpNeededForLevel(level) {
  return 150 + Math.max(0, level - 1) * 100;
}

const finiteNonNegInt = (v, max = 1e9) => (
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(max, Math.round(v)) : 0
);

function clampText(raw, maxLen = MAX_TRICK_TEXT_LEN) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1)).trimEnd()}!`;
}

/**
 * Creates the live scoring, economy, XP/level, and trick combo system.
 *
 * @param {{ onLevelUp?: (level: number, bonusCash: number) => void }} [options]
 */
export function createScoringSystem(options = {}) {
  const onLevelUp = typeof options.onLevelUp === 'function' ? options.onLevelUp : null;

  let cash = STARTING_CASH;
  let mikeyCash = STARTING_MIKEY_CASH;
  let totalXp = 0;
  let playerLevel = 1;
  let xpTowardsNext = 0;

  let totalTrickEvents = 0;
  let activeCombo = 0;
  let comboTimer = 0;
  let nextTrickId = 1;
  let mikeyTickTimer = 0;
  let mikeyTickStep = 0;

  let footballBlueScore = 0;
  let footballOrangeScore = 0;
  let derbyWrecks = 0;
  let rewardsLocked = false;

  const ownedVehicles = new Set(
    VEHICLES.filter((v) => Boolean(v.freeStarter)).map((v) => v.id),
  );

  /** @type {Map<string, { xp: number, xpInLevel: number, level: number }>} */
  const carProgress = new Map();
  for (let i = 0; i < VEHICLES.length; i += 1) {
    carProgress.set(VEHICLES[i].id, { xp: 0, xpInLevel: 0, level: 1 });
  }

  /** @type {Array<{ id: number, text: string, tone: string, age: number, ttl: number }>} */
  const trickFeed = [];

  const ensureCarEntry = (vehicleId) => {
    const id = String(vehicleId || 'sedan');
    let entry = carProgress.get(id);
    if (!entry) {
      entry = { xp: 0, xpInLevel: 0, level: 1 };
      carProgress.set(id, entry);
    }
    return entry;
  };

  const pushTrickRow = (text, tone = 'trick') => {
    const clean = clampText(text, MAX_TRICK_TEXT_LEN);
    if (!clean) return;
    trickFeed.unshift({
      id: nextTrickId,
      text: clean,
      tone,
      age: 0,
      ttl: TRICK_ROW_TTL_SEC,
    });
    nextTrickId += 1;
    while (trickFeed.length > MAX_TRICK_ROWS) {
      trickFeed.pop();
    }
  };

  const awardXp = (amount, vehicleId) => {
    const gain = finiteNonNegInt(amount);
    if (gain <= 0) return false;

    totalXp += gain;
    xpTowardsNext += gain;

    const car = ensureCarEntry(vehicleId);
    car.xp += gain;
    car.xpInLevel += gain;
    let carGuard = 0;
    while (car.xpInLevel >= xpNeededForLevel(car.level) && carGuard < 500) {
      car.xpInLevel -= xpNeededForLevel(car.level);
      car.level += 1;
      carGuard += 1;
    }

    let leveledUp = false;
    let playerGuard = 0;
    while (xpTowardsNext >= xpNeededForLevel(playerLevel) && playerGuard < 500) {
      xpTowardsNext -= xpNeededForLevel(playerLevel);
      playerLevel += 1;
      playerGuard += 1;
      const bonus = 250 * playerLevel;
      cash += bonus;
      leveledUp = true;
      pushTrickRow(`LEVEL UP! LVL ${playerLevel} +$${bonus}`, 'combo');
      if (onLevelUp) {
        onLevelUp(playerLevel, bonus);
      }
    }
    return leveledUp;
  };

  const addReward = ({
    cash: cashDelta = 0,
    xp: xpDelta = 0,
    label = '',
    tone = 'trick',
    vehicleId = 'sedan',
    countCombo = true,
    allowWhenLocked = false,
  } = {}) => {
    if (rewardsLocked && !allowWhenLocked) return null;
    const addCash = finiteNonNegInt(cashDelta);
    const addXp = finiteNonNegInt(xpDelta);

    if (addCash > 0) {
      cash += addCash;
    }

    if (label) {
      const cleanLabel = String(label).replace(/\s+/g, ' ').trim();
      const hasDollar = cleanLabel.includes('$');
      let rowText = cleanLabel;
      if (!hasDollar && addCash > 0) {
        const suffix = ` +$${addCash}`;
        const maxPrefix = Math.max(6, MAX_TRICK_TEXT_LEN - suffix.length);
        let prefix = cleanLabel;
        if (prefix.length > maxPrefix) {
          const cut = prefix.slice(0, maxPrefix);
          const sp = cut.lastIndexOf(' ');
          prefix = (sp >= 5 ? cut.slice(0, sp) : cut).replace(/[!.,;:-]+$/, '').trimEnd();
          if (prefix.length + 1 <= maxPrefix) {
            prefix = `${prefix}!`;
          }
        }
        rowText = `${prefix}${suffix}`;
      }
      pushTrickRow(rowText, tone);
    }

    if (countCombo && (addCash > 0 || addXp > 0 || label)) {
      totalTrickEvents += 1;
      activeCombo += 1;
      comboTimer = COMBO_WINDOW_SEC;
      if (activeCombo >= 3 && activeCombo % 2 === 1) {
        const comboBonus = Math.min(250, activeCombo * 25);
        cash += comboBonus;
        pushTrickRow(`TRICK COMBO x${activeCombo}! +$${comboBonus}`, 'combo');
      }
    }

    const leveledUp = awardXp(addXp, vehicleId);
    return { cash, xp: totalXp, level: playerLevel, leveledUp, activeCombo };
  };

  const onPartDetached = (partKey, vehicleId = 'sedan') => {
    if (rewardsLocked) return null;
    const partName = PART_LABELS[partKey] || 'PART';
    return addReward({
      cash: 35,
      xp: 16,
      label: `${partName} OFF!`,
      tone: 'crash',
      vehicleId,
      countCombo: true,
    });
  };

  const onStuntLanding = ({
    airTime = 0,
    flips = 0,
    rolls = 0,
    spins = 0,
    clean = true,
    crashed = false,
    vehicleId = 'sedan',
  } = {}) => {
    if (rewardsLocked) return null;
    const safeAirTime = typeof airTime === 'number' && Number.isFinite(airTime) && airTime > 0
      ? Math.min(120, airTime)
      : 0;
    const safeFlips = finiteNonNegInt(flips, 100);
    const safeRolls = finiteNonNegInt(rolls, 100);
    const safeSpins = finiteNonNegInt(spins, 100);
    const totalRot = safeFlips + safeRolls + safeSpins;
    let label = '';
    let cashBonus = 0;
    let xpBonus = 0;
    let tone = 'trick';

    if (crashed) {
      label = safeFlips > 0 || safeRolls > 0 ? 'CRASH FLIP!' : 'HARD LANDING!';
      cashBonus = 75 + totalRot * 35;
      xpBonus = 35 + totalRot * 15;
      tone = 'crash';
    } else if (safeFlips > 0 && safeRolls > 0) {
      label = 'DIAGONAL FLIP!';
      cashBonus = 160 + totalRot * 40;
      xpBonus = 70;
      tone = 'combo';
    } else if (safeFlips > 0) {
      label = safeFlips > 1 ? `${safeFlips}x MEGA FLIP!` : 'FRONT/BACK FLIP!';
      cashBonus = 110 * safeFlips;
      xpBonus = 50 * safeFlips;
      tone = 'combo';
    } else if (safeRolls > 0) {
      label = safeRolls > 1 ? `${safeRolls}x BARREL ROLL!` : 'BARREL ROLL!';
      cashBonus = 115 * safeRolls;
      xpBonus = 50 * safeRolls;
      tone = 'combo';
    } else if (safeSpins > 0) {
      label = `${safeSpins * 360} AIR SPIN!`;
      cashBonus = 95 * safeSpins;
      xpBonus = 42 * safeSpins;
      tone = 'combo';
    } else if (safeAirTime >= 0.45) {
      label = `AIR TIME ${safeAirTime.toFixed(1)}s`;
      cashBonus = finiteNonNegInt(45 + safeAirTime * 45);
      xpBonus = finiteNonNegInt(20 + safeAirTime * 18);
      tone = clean ? 'trick' : 'crash';
    }

    if (!label) return null;
    return addReward({
      cash: finiteNonNegInt(cashBonus),
      xp: finiteNonNegInt(xpBonus),
      label,
      tone,
      vehicleId,
      countCombo: true,
    });
  };

  const onSkiMarker = (studs, vehicleId = 'sedan') => {
    if (rewardsLocked) return null;
    const rawDist = finiteNonNegInt(studs, 10000);
    const dist = Math.max(50, rawDist || 50);
    const bonus = finiteNonNegInt(40 + dist * 0.25, 350);
    return addReward({
      cash: bonus,
      xp: finiteNonNegInt(20 + dist * 0.08, 1000),
      label: `SKI JUMP ${dist} STUDS!`,
      tone: 'combo',
      vehicleId,
      countCombo: true,
    });
  };

  const recordDerbyWreck = () => {
    if (rewardsLocked) return derbyWrecks;
    derbyWrecks += 1;
    return derbyWrecks;
  };

  const onDerbyWreck = (aiName, vehicleId = 'sedan') => {
    if (rewardsLocked) return null;
    derbyWrecks += 1;
    return addReward({
      cash: 150,
      xp: 60,
      label: `KO ${String(aiName || 'RIVAL').toUpperCase()}!`,
      tone: 'combo',
      vehicleId,
      countCombo: true,
    });
  };

  const buyOrTryVehicle = (vehicleDef) => {
    if (!vehicleDef || !vehicleDef.id) {
      return { allowed: true, owned: true, purchased: false, freeTrial: false };
    }
    if (vehicleDef.freeStarter || ownedVehicles.has(vehicleDef.id)) {
      return { allowed: true, owned: true, purchased: false, freeTrial: false };
    }
    const price = finiteNonNegInt(vehicleDef.price);
    if (cash >= price) {
      cash -= price;
      ownedVehicles.add(vehicleDef.id);
      return { allowed: true, owned: true, purchased: true, freeTrial: false };
    }
    if (vehicleDef.tryFree) {
      return { allowed: true, owned: false, purchased: false, freeTrial: true };
    }
    return { allowed: false, owned: false, purchased: false, freeTrial: false };
  };

  const isVehicleOwned = (id) => ownedVehicles.has(String(id || ''));

  const getOwnedSet = () => new Set(ownedVehicles);

  const getVehicleLevel = (id) => {
    const entry = carProgress.get(String(id || 'sedan'));
    return entry ? entry.level : 1;
  };

  const getVehicleLevelsMap = () => {
    const out = {};
    carProgress.forEach((val, key) => {
      out[key] = val.level;
    });
    return out;
  };

  const update = (dt, world = null, activeVehicleId = 'sedan', activePlay = false) => {
    const safeDt = typeof dt === 'number' && Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 0;
    if (safeDt <= 0) return;

    if (comboTimer > 0) {
      comboTimer = Math.max(0, comboTimer - safeDt);
      if (comboTimer <= 0) {
        activeCombo = 0;
      }
    }

    for (let i = trickFeed.length - 1; i >= 0; i -= 1) {
      trickFeed[i].age += safeDt;
      if (trickFeed[i].age >= trickFeed[i].ttl) {
        trickFeed.splice(i, 1);
      }
    }

    if (activePlay) {
      mikeyTickTimer += safeDt;
      if (mikeyTickTimer >= 7.5) {
        mikeyTickTimer -= 7.5;
        mikeyTickStep += 1;
        // Lively deterministic rival earnings on the Roblox leaderboard
        const mikeyDelta = 35 + ((mikeyTickStep * 25) % 75);
        mikeyCash += mikeyDelta;
      }
    }

    if (world && typeof world.getSoccerBallState === 'function') {
      const ball = world.getSoccerBallState();
      if (ball) {
        // Sync scoreboard counters only — hub_lab.js -> physics.js awards the canonical goal reward once
        footballBlueScore = finiteNonNegInt(ball.blueScore);
        footballOrangeScore = finiteNonNegInt(ball.orangeScore);
      }
    }
  };

  const getTrickFeed = () => trickFeed.map((row) => ({
    id: row.id,
    text: row.text,
    tone: row.tone,
  }));

  const getState = (activeVehicleId = 'sedan') => {
    const car = ensureCarEntry(activeVehicleId);
    return {
      cash,
      mikeyCash,
      xp: totalXp,
      level: playerLevel,
      carXp: car.xp,
      carLevel: car.level,
      trickComboCount: totalTrickEvents,
      activeCombo,
      footballBlueScore,
      footballOrangeScore,
      derbyWrecks,
    };
  };

  const setRewardsLocked = (locked) => {
    rewardsLocked = Boolean(locked);
  };

  const isRewardsLocked = () => rewardsLocked;

  const reset = () => {
    cash = STARTING_CASH;
    mikeyCash = STARTING_MIKEY_CASH;
    totalXp = 0;
    playerLevel = 1;
    xpTowardsNext = 0;
    totalTrickEvents = 0;
    activeCombo = 0;
    comboTimer = 0;
    mikeyTickTimer = 0;
    mikeyTickStep = 0;
    footballBlueScore = 0;
    footballOrangeScore = 0;
    derbyWrecks = 0;
    rewardsLocked = false;
    trickFeed.length = 0;
    ownedVehicles.clear();
    for (let i = 0; i < VEHICLES.length; i += 1) {
      if (VEHICLES[i].freeStarter) ownedVehicles.add(VEHICLES[i].id);
      carProgress.set(VEHICLES[i].id, { xp: 0, xpInLevel: 0, level: 1 });
    }
  };

  return {
    addReward,
    onPartDetached,
    onStuntLanding,
    onSkiMarker,
    recordDerbyWreck,
    onDerbyWreck,
    setRewardsLocked,
    isRewardsLocked,
    buyOrTryVehicle,
    isVehicleOwned,
    getOwnedSet,
    getVehicleLevel,
    getVehicleLevelsMap,
    update,
    getTrickFeed,
    getState,
    reset,
  };
}
