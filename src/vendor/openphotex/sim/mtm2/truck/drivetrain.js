/*
  Engine, gearbox and drive force (MTM2_PHYSICS.md §5.2; MONSTER_EXE_ANALYSIS.md §8.4, §8.5).

  - The engine rpm is updated inside each tire's longitudinal step, so it chases four targets
    per step, one per tire in FR, FL, RR, RL order. On the ground the target comes from that
    tire's forward speed (at least 800 rpm); in the air from the wheel's spin, at least
    throttle × limit, wound down by the brake.
  - Torque follows the curve, times the throttle, times 1.1 for computer trucks on Professional
    on a Sonic track or 0.9 for a human driver with automatic shifting.
  - The gearbox shifts instantly: automatically between first and third gear at 7000 and 3500
    rpm, or on request with manual shifting.
*/
import { DIFFICULTY, ENGINE, GEAR, GEAR_RATIOS, MPH_10 } from "../constants.js";
const RPM_PER_RAD_S = 60 / (2 * Math.PI);
/** Torque curve at full throttle, lb ft. */
export function engineTorque(rpm) {
    return ENGINE.torqueScale * ((ENGINE.a * rpm + ENGINE.b) * rpm + ENGINE.c);
}
/** The overall ratio of a gear number (0 in Park and Neutral). */
export function gearRatio(gear) {
    return GEAR_RATIOS[gear] ?? 0;
}
/** The rpm a tire on the ground asks of the engine. */
export function groundTargetRpm(transfer, gear, forwardSpeed, tireRadius, throttle) {
    const ratio = gearRatio(gear);
    const target = ratio === 0
        ? throttle * ENGINE.maxRpm
        : Math.abs((transfer * ratio * forwardSpeed * 60) / (tireRadius * 2 * Math.PI));
    return target < ENGINE.idleRpm ? ENGINE.idleRpm : target;
}
/**
 * The rpm a tire in the air asks of the engine: the wheel's spin, at least throttle × limit, no
 * more than the limit, then wound towards 0 by (16000 · brake + 3200) · dt.
 */
export function airTargetRpm(transfer, gear, wheelSpin, throttle, brake, dt) {
    let target = gearRatio(gear) * wheelSpin * transfer * RPM_PER_RAD_S;
    const floor = throttle * ENGINE.maxRpm;
    if (target < floor)
        target = floor;
    if (target > ENGINE.maxRpm)
        target = ENGINE.maxRpm;
    const wind = (brake * 16000 + 3200) * dt;
    if (target >= 0) {
        target -= wind;
        if (target < 0)
            target = 0;
    }
    else {
        target += wind;
        if (target > 0)
            target = 0;
    }
    return target;
}
/** The wheel spin (rad/s) a free wheel takes from the engine rpm, or null in Park and Neutral. */
export function wheelSpinFromRpm(rpm, transfer, gear) {
    const ratio = gearRatio(gear);
    return ratio === 0 ? null : rpm / (ratio * transfer * RPM_PER_RAD_S);
}
/** One tire's pull on the rpm: a first-order lag with rate 1/s. Capped at the limit on the ground. */
export function chaseRpm(rpm, target, dt, capAtLimit) {
    const next = rpm + (target - rpm) * dt;
    return capAtLimit && next > ENGINE.maxRpm ? ENGINE.maxRpm : next;
}
/** Engine torque delivered at this rpm and throttle, with the driver gains, lb ft. */
export function deliveredTorque(rpm, throttle, driver) {
    let torque = throttle * engineTorque(rpm);
    if (!driver.human && driver.difficulty === DIFFICULTY.PROFESSIONAL && driver.sonicTrack)
        torque *= 1.1;
    if (driver.human && driver.autoShift)
        torque *= 0.9;
    return torque;
}
/** Drive force at one tire, lbf: half of its axle's share of the torque at the contact. */
export function driveForce(transfer, gear, torque, tireRadius, axleSplit) {
    return transfer * gearRatio(gear) * (torque / tireRadius) * axleSplit * 0.5;
}
/**
 * The gearbox step (0x477520). Automatic: up above 7000 rpm from first or second, down below
 * 3500 rpm from second or third; requests are ignored. Manual: up to third, down from second or
 * third at any speed, down from Neutral or Reverse only when not rolling forward. Park holds both
 * brakes on.
 */
export function stepGearbox(box, ctx) {
    const { rpm, autoShift } = ctx;
    const up = autoShift
        ? rpm > ENGINE.upshiftRpm && box.gear >= GEAR.FIRST && box.gear <= GEAR.SECOND
        : box.shiftRequest > 0 && box.gear < GEAR.THIRD;
    if (up)
        box.gear = ctx.dragStaging && box.gear === GEAR.PARK ? GEAR.NEUTRAL : box.gear + 1;
    const down = autoShift
        ? rpm < ENGINE.downshiftRpm && box.gear >= GEAR.SECOND
        : box.shiftRequest < 0 && (box.gear > GEAR.FIRST || (box.gear > GEAR.PARK && ctx.forwardSpeed <= 0));
    if (down)
        box.gear = ctx.dragStaging && box.gear === GEAR.NEUTRAL ? GEAR.PARK : box.gear - 1;
    box.shiftRequest = 0;
    if (box.gear === GEAR.PARK) {
        box.brakeFront = 1;
        box.brakeRear = 1;
    }
}
/** Below this speed a tire holds the truck still (static hold, §5.2). */
export const STATIC_HOLD_SPEED = MPH_10;
