/*
  Community Patch 4's physics (OpenMTM2 docs/CP4_EXE_ANALYSIS.md 10 and 11): MTM2's vehicle model with a
  fixed 40 ms tick, a few clamps, computer-truck grip and a triangle collision solver. Its author published
  no source code; every value here is read from the CP4 beta 0.52 executable (monster.exe 2.0.52.2) and is
  the default of the INI key named beside it.
*/
import { MTM2_RULES } from "../mtm2/constants.js";
/** The [Collision] defaults (11.1). */
export const CP4_TRIANGLES = Object.freeze({
    supportSpokes: 9, // supportSpokes
    supportProfile: true, // supportProfile 1
    supportPick: 1, // supportPick (used only with the profile off)
    supportCylinder: true, // supportCylinder 1
    supportCylHoldTicks: 3, // supportCylHoldTicks
    supportSlackFt: 0.5, // supportSlackIn 6 / 12
    supportComprMaxFt: 2, // supportComprMaxTenthFt 20 / 10
    supportClampSmall: true, // supportClampSmall 1
    cylinderTreadClip: true, // cylinderTreadClip 1
    wallSkipDrivable: true, // wallSkipDrivable 1
    wallShortPropPct: 0, // wallShortPropPct 0
    climbBlend: true, // climbBlend 1
    climbBlendLo: 0.35, // climbBlendLoPct 35
    climbBlendHi: 1, // climbBlendHiPct 100
    climbLiftGuard: false, // climbLiftGuard 0
    dropFromHit: true, // dropFromHit 1
    wallComprMaxFt: 1, // wallComprMaxTenthFt 10 / 10
    wallDampRefFtPerSec: 0, // wallDampRefFtPerSec 0
    wallCorrect: 0.3, // wallCorrectPct 30
    wallCylinder: true, // wallCylinder 1
    phantomCornerFt: 3, // phantomCornerTenthFt 30 / 10
    boxOnTri: true, // boxOnTri 1
    smallPropImpulse: false, // smallPropImpulse 0
    smallPropMaxG: 1, // smallPropMaxGPct 100
});
/** CP4's rules with triangle collision (`collisionMode` 1, the default). */
export const CP4_RULES = Object.freeze({
    ...MTM2_RULES,
    id: "cp4",
    tickS: 0xa3d / 65536, // deltaT, 40 ms (10.2)
    substepS: 0.01, // simSubstepMs 10
    suspVelMaxFtPerSec: 20, // suspVelMaxFtPerSec
    terrainComprMaxFt: 6, // terrainComprMaxFt
    restNeedsContacts: 3, // gRestClampGroundedOnly 1
    surfaceAtPoint: true,
    aiGrip: 1.3, // aiGrip 130
    dragCpuGrip: 1.5, // gDragGripMul
    dragCpuSteerSlew: 1.5, // gDragSteerGainMul
    sonicTireCf: 3, // tire_cf
    sonicStraightBrake: 0.45, // straight_brake_scaler
    sonicCurveSpeed: 1.25, // curve_speed_scaler
    impulseCap: true, // impulseCap 1
    bottomPropShare: 0.4, // bottomPropPct 40
    smallPropRatio: 2, // smallPropRatioPct 200
    offCentreCollision: true, // offCentreCollision 1
    collisionMode: 1, // [Game] collisionMode 1
    triangles: CP4_TRIANGLES,
});
/** CP4's rules with classic box collision (`collisionMode` 0): the clamps above still apply (11.10). */
export const CP4_CLASSIC_RULES = Object.freeze({ ...CP4_RULES, collisionMode: 0 });
export function isCp4Rules(id) {
    return id === "cp4";
}
/** CP4's rules for a collision mode: "classic" (or 0) for box faces, anything else for triangles. */
export function cp4Rules(collision) {
    return collision === "classic" || collision === 0 ? CP4_CLASSIC_RULES : CP4_RULES;
}
/**
 * The substeps of one tick (10.2): `n` steps of `dt` each. CP4 splits a tick only online or when asked
 * (`simSubstepOffline`), into round(tick / substep) clamped 2..8, and only when the tick is more than
 * 1.25 substeps long.
 */
export function cp4Substeps(rules, split) {
    const tick = rules.tickS ?? 0.04;
    const sub = rules.substepS ?? 0;
    if (!split || !(sub > 0) || !(tick > 1.25 * sub))
        return { n: 1, dt: tick };
    const n = Math.max(2, Math.min(8, Math.round(tick / sub)));
    return { n, dt: tick / n };
}
