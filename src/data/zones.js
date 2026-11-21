/**
 * Destruction World Zones & Teleport Table (Contract #7).
 *
 * WORLD COORDINATE & YAW CONVENTION (shared by M1 camera.js, M2A vehicle_mesh.js, M2B arena.js, M3 physics.js):
 * - Right-handed Three.js Y-up space, 480m x 480m world (X, Z in [-240, +240]).
 * - Vehicle local +Z = FRONT, -Z = REAR, +Y = UP, +X = VEHICLE LEFT.
 * - Forward vector from yaw: forward = [Math.sin(yaw), 0, Math.cos(yaw)].
 * - Heading from spawn (sx, sz) to target (tx, tz): yaw = Math.atan2(tx - sx, tz - sz).
 * - Turning LEFT (CCW from +Y) increments yaw (+dYaw); turning RIGHT decrements yaw (-dYaw).
 * - Cardinal values: South (+Z) = 0, East (+X) = Math.PI/2, North (-Z) = Math.PI, West (-X) = -Math.PI/2.
 */

export const WORLD_HALF_SIZE = 240;
export const FORWARD_CONVENTION = '+Z';

export function yawToForward(yaw) {
  return [Math.sin(yaw), 0, Math.cos(yaw)];
}

export const ZONE_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'crushers', label: 'Crushers',         icon: '🔨' }),
  Object.freeze({ id: 'ramps',    label: 'Ramps & Stunts',   icon: '🚀' }),
  Object.freeze({ id: 'arenas',   label: 'Arenas & Hub',     icon: '🏟️' }),
  Object.freeze({ id: 'hazards',  label: 'Trains & Hazards', icon: '🌋' }),
]);

export const ZONES = Object.freeze([
  Object.freeze({
    id: 'hub_lab',
    name: 'Demolition Lab Hub',
    category: 'arenas',
    color: '#43a047',
    description: 'Central roundabout, #101 Rally Raider turntable & shatterable glass Demolition Lab.',
    spawnPos: Object.freeze([0, 0.5, 14]),
    spawnYaw: Math.PI,
    smashTarget: Object.freeze([0, 0, -22]),
    smashSpeed: 36,
    padCenter: Object.freeze([0, 0, 0]),
    padRadius: 32,
    hasManualTrigger: false,
    triggerLabel: '',
  }),
  Object.freeze({
    id: 'hydraulic_press',
    name: 'Hydraulic Press Bay',
    category: 'crushers',
    color: '#fdd835',
    description: 'Crushing from above & sides! Drive into the yellow/black bay and flatten your car.',
    spawnPos: Object.freeze([78, 0.5, -42]),
    spawnYaw: Math.PI,
    smashTarget: Object.freeze([78, 0, -68]),
    smashSpeed: 24,
    padCenter: Object.freeze([78, 0, -68]),
    padRadius: 22,
    hasManualTrigger: true,
    triggerLabel: 'CRUSH PRESS',
  }),
  Object.freeze({
    id: 'wrecking_balls',
    name: 'Swinging Wrecking Balls',
    category: 'crushers',
    color: '#fb8c00',
    description: 'Twin giant steel pendulum spheres swinging across a 2-lane gantry road.',
    spawnPos: Object.freeze([74, 0.5, 8]),
    spawnYaw: Math.PI / 2,
    smashTarget: Object.freeze([104, 0, 8]),
    smashSpeed: 38,
    padCenter: Object.freeze([104, 0, 8]),
    padRadius: 24,
    hasManualTrigger: false,
    triggerLabel: '',
  }),
  Object.freeze({
    id: 'spinning_hammers',
    name: 'Spinning Orange Hammers',
    category: 'crushers',
    color: '#ff5722',
    description: 'Four spinning orange demolition arms that juggle cars and flip box trucks.',
    spawnPos: Object.freeze([76, 0.5, 52]),
    spawnYaw: 0,
    smashTarget: Object.freeze([76, 0, 82]),
    smashSpeed: 30,
    padCenter: Object.freeze([76, 0, 82]),
    padRadius: 24,
    hasManualTrigger: false,
    triggerLabel: '',
  }),
  Object.freeze({
    id: 'nail_hammer',
    name: 'Nail Hammer Strike Zone',
    category: 'crushers',
    color: '#fbc02d',
    description: 'Park on the STRIKE ZONE circle and swing down the giant black Nail Hammer.',
    spawnPos: Object.freeze([-78, 0.5, -10]),
    spawnYaw: -Math.PI / 2,
    smashTarget: Object.freeze([-104, 0, -10]),
    smashSpeed: 24,
    padCenter: Object.freeze([-104, 0, -10]),
    padRadius: 22,
    hasManualTrigger: true,
    triggerLabel: 'DROP NAIL',
  }),
  Object.freeze({
    id: 'giant_hammer',
    name: 'Giant Hammer Tower',
    category: 'crushers',
    color: '#8d6e63',
    description: 'Tall wooden truss DROP ZONE tower dropping a massive chained barrel weight.',
    spawnPos: Object.freeze([-82, 0.5, -54]),
    spawnYaw: Math.PI,
    smashTarget: Object.freeze([-82, 0, -82]),
    smashSpeed: 24,
    padCenter: Object.freeze([-82, 0, -82]),
    padRadius: 24,
    hasManualTrigger: true,
    triggerLabel: 'DROP HAMMER',
  }),
  Object.freeze({
    id: 'spike_drop',
    name: 'Spike Drop Zone',
    category: 'hazards',
    color: '#455a64',
    description: 'Park inside the hazard box and rain down an avalanche of spiked naval mines.',
    spawnPos: Object.freeze([-82, 0.5, 48]),
    spawnYaw: 0,
    smashTarget: Object.freeze([-82, 0, 74]),
    smashSpeed: 24,
    padCenter: Object.freeze([-82, 0, 74]),
    padRadius: 22,
    hasManualTrigger: true,
    triggerLabel: 'DROP MINES',
  }),
  Object.freeze({
    id: 'train_crossing',
    name: 'Railroad Train Crossing',
    category: 'hazards',
    color: '#1e88e5',
    description: 'Can a School Bus stop the speeding diesel freight train? Find out on the tracks!',
    spawnPos: Object.freeze([0, 0.5, -122]),
    spawnYaw: Math.PI,
    smashTarget: Object.freeze([0, 0, -150]),
    smashSpeed: 26,
    padCenter: Object.freeze([0, 0, -150]),
    padRadius: 28,
    hasManualTrigger: true,
    triggerLabel: 'SUMMON TRAIN',
  }),
  Object.freeze({
    id: 'shredder_tunnels',
    name: 'RGB Shredder Tunnels',
    category: 'crushers',
    color: '#e53935',
    description: 'Red, Green & Orange EMPLOYEES ONLY bays packed with rotating spiked steel drums.',
    spawnPos: Object.freeze([178, 0.5, -76]),
    spawnYaw: Math.PI,
    smashTarget: Object.freeze([178, 0, -110]),
    smashSpeed: 34,
    padCenter: Object.freeze([178, 0, -110]),
    padRadius: 30,
    hasManualTrigger: false,
    triggerLabel: '',
  }),
  Object.freeze({
    id: 'ski_jump',
    name: 'Giant Ski Jump (50-1500)',
    category: 'ramps',
    color: '#00acc1',
    description: 'Boost down the mountain runway past 50 to 1500 stud signs for massive trick combos!',
    spawnPos: Object.freeze([-185, 24.5, -168]),
    spawnYaw: 0,
    smashTarget: Object.freeze([-185, 7, -124]),
    smashSpeed: 48,
    padCenter: Object.freeze([-185, 0, -135]),
    padRadius: 38,
    hasManualTrigger: false,
    triggerLabel: '',
  }),
  Object.freeze({
    id: 'mega_ramp',
    name: 'Mega Ramp & 360° Loop',
    category: 'ramps',
    color: '#8e24aa',
    description: 'Giant incline launch ramp, 360° silver loop-de-loop, Rainbow Wall & cash rings.',
    spawnPos: Object.freeze([0, 0.5, 122]),
    spawnYaw: 0,
    smashTarget: Object.freeze([0, 8, 162]),
    smashSpeed: 46,
    padCenter: Object.freeze([0, 0, 160]),
    padRadius: 34,
    hasManualTrigger: false,
    triggerLabel: '',
  }),
  Object.freeze({
    id: 'derby_arena',
    name: 'Banked Derby & Football',
    category: 'arenas',
    color: '#e91e63',
    description: 'Multicolored tiled banked-wall Derby bowl with AI rivals plus Car Football!',
    spawnPos: Object.freeze([160, 0.5, 138]),
    spawnYaw: 0,
    smashTarget: Object.freeze([160, 0, 168]),
    smashSpeed: 35,
    padCenter: Object.freeze([160, 0, 168]),
    padRadius: 38,
    hasManualTrigger: false,
    triggerLabel: '',
  }),
  Object.freeze({
    id: 'crash_c4_wall',
    name: 'Crash Test & C4 Wall',
    category: 'hazards',
    color: '#d32f2f',
    description: 'High-speed blue-lined crash test runway straight into a C4 Explosives block wall.',
    spawnPos: Object.freeze([152, 0.5, 35]),
    spawnYaw: Math.PI / 2,
    smashTarget: Object.freeze([185, 0, 35]),
    smashSpeed: 42,
    padCenter: Object.freeze([185, 0, 35]),
    padRadius: 26,
    hasManualTrigger: true,
    triggerLabel: 'DETONATE C4',
  }),
  Object.freeze({
    id: 'lava_obby',
    name: 'Lava Pit & Lava Obby',
    category: 'hazards',
    color: '#ff3d00',
    description: 'Drive the Lava Obby bridge: Checkmark ✓ safe left or Skull ☠ catapult right!',
    spawnPos: Object.freeze([-165, 0.5, 125]),
    spawnYaw: 0,
    smashTarget: Object.freeze([-165, 0, 155]),
    smashSpeed: 30,
    padCenter: Object.freeze([-165, 0, 155]),
    padRadius: 32,
    hasManualTrigger: false,
    triggerLabel: '',
  }),
]);

const ZONE_BY_ID = new Map(ZONES.map((z) => [z.id, z]));

/**
 * O(1) zone lookup; falls back cleanly to 'hub_lab' for unknown/empty ids.
 *
 * @param {string} id
 */
export function getZoneById(id) {
  if (typeof id === 'string' && ZONE_BY_ID.has(id)) {
    return ZONE_BY_ID.get(id);
  }
  return ZONES[0];
}
