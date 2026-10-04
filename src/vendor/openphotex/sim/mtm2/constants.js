/*
  Every number the Monster Truck Madness 2 simulation uses, with where it comes from.

  Source: OpenMTM2's docs/MTM2_PHYSICS.md ("§n") and docs/MONSTER_EXE_ANALYSIS.md ("A§n"),
  both derived from MONSTER.EXE 2.00.42. Nothing here is fitted or tuned.

  Units: feet, seconds, radians, pounds (weights), slugs (masses), pounds-force.
*/
/** Gravity, ft/s² (§8.7). */
export const G = 32.174;
/** 1 / G: pounds to slugs (§8.7). */
export const INV_G = 0.031081;
/** Air and water densities used for drag, slug/ft³ (§2.3). */
export const AIR_DENSITY = 0.002377;
export const WATER_DRAG_DENSITY = 0.15;
/** Terrain grid (§2.1): 256 × 256 cells of 32 ft, heights in 2 ft steps. */
export const TERRAIN_CELLS = 256;
export const CELL_FT = 32;
export const WORLD_FT = TERRAIN_CELLS * CELL_FT; // 8192
export const HEIGHT_STEP_FT = 2;
/** Weather states (A§13) and their grip factors (§2.3). */
export const WEATHER = Object.freeze({
    CLEAR: 0, CLOUDY: 1, FOGGY: 2, DENSE_FOG: 3, RAIN: 4, SNOW: 5, DUSK: 6, NIGHT: 7, PITCH_BLACK: 8,
});
export function weatherGrip(weather) {
    if (weather === WEATHER.RAIN)
        return 0.8;
    if (weather === WEATHER.SNOW)
        return 0.6;
    return 1;
}
/** Difficulty (A§6.5). */
export const DIFFICULTY = Object.freeze({ ROOKIE: 0, INTERMEDIATE: 1, PROFESSIONAL: 2 });
/** Race modes, the SIT's track type code (A§6). */
export const RACE_MODE = Object.freeze({ DRAG: 1, CIRCUIT: 2, RALLY: 3, SUMMIT: 4 });
/** Gear numbers (A§8.3): 1 Park, 2 Reverse, 3 Neutral, 4..6 first to third. */
export const GEAR = Object.freeze({ PARK: 1, REVERSE: 2, NEUTRAL: 3, FIRST: 4, SECOND: 5, THIRD: 6 });
/*
  Truck defaults (§3.1, A§8.4): every truck gets these; the TRK supplies only geometry.
*/
export const TRUCK = Object.freeze({
    bodyWeightLb: 6000,
    axleWeightLb: 2000,
    /** Roll (p, about body z), pitch (q, about x), yaw (r, about y) inertias, slug ft². */
    inertia: Object.freeze([5000, 5000, 7500]),
    /** Centre of gravity relative to the body origin, ft. */
    cgOffset: Object.freeze([0, -3, 0]),
    tireRadiusFt: 3,
    tireWidthFt: 4,
    /** Default hub anchors (x, y, z) when a TRK gives none: right x = +4, left x = -4. */
    frontAxleZ: 5.67,
    rearAxleZ: -4,
    hubY: -4,
    hubHalfTrackX: 4,
    maxWheelbaseFt: 11.6,
    articulationLimit: 0.5,
    bumpTravelFt: 2,
    torqueSplit: Object.freeze({ front: 0.2, rear: 0.8 }),
    /** Aero areas facing x, y, z (ft²) and their coefficients (§5.4). */
    aeroArea: Object.freeze([125, 150, 75]),
    aeroCd: Object.freeze([5, 1.5, 1.5]),
});
/** Engine (A§8.4): T(rpm) = scale · (a·rpm² + b·rpm + c), lb ft. */
export const ENGINE = Object.freeze({
    torqueScale: 1700,
    a: -2.367e-8,
    b: 9.467e-5,
    c: 0.905,
    idleRpm: 800,
    maxRpm: 8500,
    upshiftRpm: 7000,
    downshiftRpm: 3500,
});
/** Overall gear ratios by gear number (A§8.4); 0 for Park and Neutral. */
export const GEAR_RATIOS = Object.freeze([0, 0, -60, 0, 40.467, 24.017, 16.45]);
/** Transfer gear by Garage setting / 100 (A§8.5): settings 600..2000. */
export const TRANSFER_TABLE = Object.freeze([
    0, 0, 0, 0, 0, 0, 1.682, 1.609, 1.565, 1.5, 1.4, 1.36, 1.306, 1.269, 1.222, 1.185, 1.143, 1.107,
    1.069, 1.034, 1.0,
]);
export const DEFAULT_TRANSFER_SETTING = 1500;
/** Transfer ratio multiplier by difficulty (A§8.5). */
export const TRANSFER_DIFFICULTY = Object.freeze([1.25, 1, 0.75]);
/** Static sag by suspension setting (§3.2): soft, medium, hard. */
export const SUSPENSION_SAG_FT = Object.freeze([1, 0.75, 0.5]);
export const SPRING_SHARE = 0.5;
export const DAMPER_FACTOR = 3.5;
/** Base friction coefficient by ground type, index = TTY value / 100 (§2.3). */
export const SURFACE_MU = Object.freeze([
    1.0, 1.0, 0.9, 0.4, 0.4, 0.7, 0.7, 0.6, 0.2, 0.3, 0.8, 0.8, 0.6, 0.4,
]);
/** Ground types whose drag density is water's (§2.3). */
export const WATER_TYPES = new Set([3, 13]);
/** The type reported below the water level, and in Snow (§2.3). */
export const DEEP_WATER_TYPE = 13;
export const FROZEN_WATER_TYPE = 8;
/** Grip by tire cut (shallow, medium, deep) per ground type (A§8.6). */
export const CUT_FACTORS = Object.freeze([
    [1.0, 1.0, 1.0], // 0 default
    [1.0, 0.9, 0.8], // 1 cement
    [0.9, 1.0, 0.9], // 2 dirt
    [0.8, 0.9, 1.0], // 3 water
    [0.8, 0.9, 1.0], // 4 mud
    [0.8, 0.9, 1.0], // 5 sand
    [0.9, 1.0, 0.9], // 6 grass
    [0.8, 0.9, 1.0], // 7 gravel
    [0.6, 0.8, 1.0], // 8 ice
    [0.6, 0.8, 1.0], // 9 snow
    [0.9, 1.0, 0.9], // 10 metal
    [0.9, 1.0, 0.9], // 11 wood
    [0.8, 0.9, 1.0], // 12 rocks
]);
/** Tire grip factor K (§5.1); 2.0 for CPU trucks on Professional on a Sonic track. */
export const TIRE_GRIP_K = 1.75;
export const TIRE_GRIP_K_SONIC_PRO = 2.0;
/** Hull contact friction factor (§6). */
export const HULL_FRICTION_K = 0.5;
/**
 * Lateral force coefficient against slip angle in radians (§5.3), as stored (0x647568): linear
 * between points, signed to oppose the slip. Note the stored ±π/2 points differ (−1.5707,
 * +1.5708).
 */
export const LATERAL_TABLE = Object.freeze([
    [-3.1416, 0], [-3.0543, 0.5], [-2.9671, 0.8], [-2.9248, 0.9], [-2.7925, 1], [-2.7053, 1],
    [-1.5707, 0.95], [-0.4363, 1], [-0.3491, 1], [-0.2618, 0.9], [-0.1745, 0.8], [-0.0873, 0.5],
    [0, 0], [0.0873, -0.5], [0.1745, -0.8], [0.2618, -0.9], [0.3491, -1], [0.4363, -1],
    [1.5708, -0.95], [2.7053, -1], [2.7925, -1], [2.9248, -0.9], [2.9671, -0.8], [3.0543, -0.5],
    [3.1416, 0],
]);
/** Speeds where behaviour changes, ft/s (§8.7): 10, 20, 40, 70 mph. */
export const MPH_10 = 14.67;
export const MPH_20 = 29.34;
export const MPH_40 = 58.68;
export const MPH_70 = 102.69;
/** Controls (A§7). */
export const CONTROLS = Object.freeze({
    rampUpPerSec: 3.5,
    rampDownPerSec: 8,
    steerLock: 0.45,
    steerReturnFactor: 4,
    rearSteerFactor: -0.33,
    rearSteerDragFactor: 1.25,
});
/**
 * The step the original's per-step laws were tuned at (hypothesis: about 1/30 s, see
 * OpenMTM2's docs/PLAN.md "Step-length policy"). Fractions applied "per step" in the original
 * are converted with it.
 */
export const REFERENCE_DT = 1 / 30;
/** Longest physics substep (§4, A§8.1). */
export const MAX_SUBSTEP = 0.1;
