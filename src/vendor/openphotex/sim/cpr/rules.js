/*
  CART Precision Racing's rules and tables (OpenMTM2 docs/CPR_PHYSICS.md): the constants of the
  car model that every car shares, each with the address it was read from.
*/
import { MTM2_RULES } from "../mtm2/constants.js";
export const CPR_RULES = Object.freeze({ ...MTM2_RULES, id: "cpr" });
export function isCprRules(id) {
    return id === "cpr";
}
/** The car as the constructor makes it (CART.EXE 0x4b2b00; CPR_PHYSICS.md 2.1). */
export const CPR_CAR = Object.freeze({
    /** Weight without fuel (+0x164c) and with 35 gallons (+0x1654), lb; fuel weighs 6.75 lb a gallon (+0x900 236.25 lb). */
    dryWeightLb: 1675,
    fuelLbPerGallon: 6.75,
    /** Roll, pitch, yaw inertia, slug ft² (+0x1660, +0x1664, +0x1668). */
    inertia: Object.freeze([200, 400, 400]),
    /** Drag reference area (+0x167c) and side area (+0x1678), ft². */
    refAreaFt2: 15,
    sideAreaFt2: 150,
    /** Rev limit (+0x3dc, 0x466a6000) and upshift rpm (+0x7f0, 0x46629000). */
    revLimit: 15000,
    upshiftRpm: 14500,
});
/** Air density at sea level, slug/ft³ (0x463810 with ambient temperature off). */
export const CPR_AIR_DENSITY = 0.002377;
/** Load sensitivity (0x5ec430 front, 0x5ec488 rear): mu every 100 lb from 0, held at the last entry; times 1.1875 (0x5b23d8). */
export const CPR_MU_FRONT = Object.freeze([2.3, 2.217, 2.13, 2.05, 1.97, 1.885, 1.8, 1.715, 1.63, 1.55, 1.47, 1.385, 1.3, 1.22]);
export const CPR_MU_REAR = Object.freeze([
    2.35, 2.3, 2.25, 2.2, 2.15, 2.1, 2.05, 2, 1.95, 1.9, 1.85, 1.8, 1.75, 1.7, 1.65, 1.6, 1.55, 1.5, 1.45, 1.4,
]);
export const CPR_MU_SCALE = 1.1875;
/** The load-sensitive mu of a front (`front`) or rear tire under `loadLb`. */
export function cprMu(loadLb, front) {
    const table = front ? CPR_MU_FRONT : CPR_MU_REAR;
    const x = Math.max(0, loadLb) / 100;
    const i = Math.floor(x);
    if (i >= table.length - 1)
        return table[table.length - 1] * CPR_MU_SCALE;
    return (table[i] + (table[i + 1] - table[i]) * (x - i)) * CPR_MU_SCALE;
}
/**
 * The force curve of the combined slip (0x475480, table 0x5ec4e0 in steps of 0.25 to 6, then 0x5ec548 in steps of 10):
 * 0 at no slip, 1 at 2.75, falling slowly past it.
 */
const FORCE_CURVE = [0, 0.245, 0.465, 0.643, 0.774, 0.865, 0.924, 0.961, 0.983, 0.994, 0.999, 1.0];
export function cprForceFactor(slip) {
    const s = Math.abs(slip);
    const x = s / 0.25;
    if (x < FORCE_CURVE.length - 1) {
        const i = Math.floor(x);
        return FORCE_CURVE[i] + (FORCE_CURVE[i + 1] - FORCE_CURVE[i]) * (x - i);
    }
    // From 1.0 at 2.75 to 0.941 at 6, then on to 0.82 (held there).
    if (s <= 6)
        return 1 - (0.059 * (s - 2.75)) / 3.25;
    return Math.max(0.82, 0.941 - (0.121 * (s - 6)) / 60);
}
/** Grip by compound and weather (tire +0x88, 0xa45244): [dry, rain] for compounds 0, 1 and the rain tire (4). */
export function cprCompoundGrip(compound, rain) {
    if (compound === 4)
        return rain ? 0.9 : 0.7;
    if (compound === 1)
        return rain ? 0.5 : 0.95;
    return rain ? 0.6 : 1;
}
/**
 * Grip by surface (CPR_PHYSICS.md 6.2): Road 1.0, Curb 0.9, Grass 0.6, Dirt 0.7, Rocks 0.7. The port's ground carries
 * MTM2's types (a CPR track maps Road and Curb to 1, Grass to 6, Dirt to 2, Rocks to 12: worker/cpr-road.js), so a curb
 * reads as road. Another game's surfaces under CPR's car take the nearest of these (the port's rule).
 */
export function cprSurfaceGrip(mtm2Type) {
    switch (mtm2Type) {
        case 1:
        case 3:
        case 4: return 1;
        case 6:
        case 7: return 0.6;
        case 2:
        case 8:
        case 9:
        case 10: return 0.7;
        case 12: return 0.7;
        case 13: return 0.2;
        case 14:
        case 11: return 0.4;
        default: return 0.8;
    }
}
/** Engine friction torque every 1,000 rpm from 0 to 15,000, lb-ft (0x5ec3f0). */
export const CPR_FRICTION = Object.freeze([8, 9, 10, 12, 16, 20, 28, 35, 42, 50, 62, 75, 87.4, 99.6, 112.8, 126.8]);
/**
 * Net torque at full throttle every 1,000 rpm, lb-ft: **the port's**. The game builds torque from a mixture table, a boost
 * table, the air density and the fuel flow (0x475580), whose composition is not traced; this curve gives a 1998 CART
 * engine's figure instead, about 850 hp at 14,000 rpm.
 */
export const CPR_TORQUE = Object.freeze([120, 140, 160, 180, 200, 220, 240, 258, 275, 290, 303, 313, 319, 322, 319, 300]);
const tableAt = (table, rpm, step) => {
    const x = Math.max(0, rpm) / step;
    const i = Math.floor(x);
    if (i >= table.length - 1)
        return table[table.length - 1];
    return table[i] + (table[i + 1] - table[i]) * (x - i);
};
/** The engine's torque at the flywheel, lb-ft: the throttle's share of the curve less the friction (engine braking shut). */
export function cprEngineTorque(rpm, throttle) {
    const net = tableAt(CPR_TORQUE, rpm, 1000), friction = tableAt(CPR_FRICTION, rpm, 1000);
    return throttle * (net + friction) - friction;
}
/** Dampers (CPR_PHYSICS.md 6.1): the force at damper speed `v` (ft/s) for a slow and a fast click. */
export function cprDamperForce(v, slow, fast) {
    const a = Math.abs(v);
    const slowLine = 60 + 13.33 * slow + 175 * a;
    const fastSlope = 700 + (fast / 6) * ((60 + 13.33 * slow + 30) * 2.39981 - 700);
    return Math.sign(v) * Math.min(slowLine, fastSlope * a);
}
/** The draft factor (0x470370): `gap` the time to the car ahead, s; `side` the lateral share. */
export function cprDraft(gap, side) {
    const g = Math.max(0, Math.min(1, gap)), s = Math.max(0, Math.min(1, side));
    return 1 - 0.6 * (1 - g) ** 4 * (1 - s);
}
