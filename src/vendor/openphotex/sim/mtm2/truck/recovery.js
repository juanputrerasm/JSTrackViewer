/*
  Stuck trucks: the reset, the helicopter and its flight (MTM2_PHYSICS.md §10.3).

  `heliTimer` is both the stuck count-down (negative) and the flight time (positive).
  - `updateStuck` is the check the game runs inside the position integrator; `stepTruck` calls
    it when the step context carries a `recovery` context.
  - `resetTruck` lifts the truck 10 ft, levels it and faces it down the course (the player).
  - `liftOff` starts the helicopter; `helicopterStep` replaces the truck step while it flies.
  - `pressHelicopterKey` is the player's Helicopter key.
*/
import { DIFFICULTY } from "../constants.js";
import { eulerToMatrix, wrapPi } from "../math.js";
import { isArc } from "../world/course.js";
export const STUCK_LIMIT_S = -5;
export const STUCK_SPEED = 15;
export const RESET_LIFT_FT = 10;
export const FLIGHT_S = 15;
export const FLIGHT_QUEUE_S = 5;
export const CARRY_S = 10;
export const HOVER_RATE = 5;
export const HOVER_DESCENT_S = 4;
export const HELI_KEY_TIMER = -15;
export const HELI_IDLE_RPM = 800;
const noWheelDown = (s) => s.tires.every((t) => !t.onGround);
/** The truck's radius (+0xfb8): to the outer edge of the front right tire. */
export function truckRadius(p) {
    const hub = p.hubs[0];
    return Math.hypot(Math.abs(hub[0]) + p.tireWidthFt * 0.5, hub[2] + p.tireRadiusFt);
}
function zeroMotion(s) {
    s.bvel.fill(0);
    s.rates.fill(0);
}
function headingTo(dx, dz) {
    return Math.atan2(dx, dz);
}
/** The point an arc reaches at a heading from its centre. */
function arcPoint(seg, angle) {
    return [seg.centre[0] + Math.sin(angle) * seg.radius, seg.centre[1], seg.centre[2] + Math.cos(angle) * seg.radius];
}
/**
 * The reset (0x46fd30): only while racing, with hull contacts and no wheel down. Returns whether
 * it happened. `contacts` is this step's hull contact count.
 */
export function resetTruck(s, rc, contacts) {
    if (!rc.racing || contacts <= 0 || !noWheelDown(s))
        return false;
    s.heliTimer = 0;
    zeroMotion(s);
    s.euler[0] = 0;
    s.euler[1] = 0;
    s.pos[1] += RESET_LIFT_FT;
    const seg = rc.segment;
    if (!rc.summit && seg) {
        const target = isArc(seg) ? arcPoint(seg, seg.exitAngle) : seg.end;
        s.euler[2] = headingTo(target[0] - s.pos[0], target[2] - s.pos[2]);
    }
    eulerToMatrix(s.euler[0], s.euler[1], s.euler[2], s.matrix);
    return true;
}
/**
 * The lift-off (0x470190): while racing with hull contacts and no wheel down, or whenever the
 * stuck timer is below -5 s. Returns whether it happened.
 */
export function liftOff(s, p, ground, rc, contacts) {
    const stuck = s.heliTimer < STUCK_LIMIT_S;
    if (!stuck && (!rc.racing || contacts <= 0 || !noWheelDown(s)))
        return false;
    s.heliTimer = FLIGHT_S + FLIGHT_QUEUE_S * (rc.othersInFlight ?? 0);
    const carry = { pitch: s.euler[0] * 0.1, roll: s.euler[1] * 0.1, heading: 0, x: 0, z: 0 };
    const seg = rc.segment;
    if (!rc.summit && seg) {
        let target, dir;
        if (isArc(seg)) {
            target = arcPoint(seg, seg.entryAngle);
            const prev = rc.previous && !isArc(rc.previous) ? rc.previous : null;
            dir = prev ? headingTo(prev.end[0] - prev.start[0], prev.end[2] - prev.start[2]) : s.euler[2];
        }
        else {
            target = seg.start;
            dir = headingTo(seg.end[0] - seg.start[0], seg.end[2] - seg.start[2]);
        }
        carry.x = (s.pos[0] - target[0]) * 0.1;
        carry.z = (s.pos[2] - target[2]) * 0.1;
        carry.heading = wrapPi(s.euler[2] - dir) * 0.1;
    }
    s.carry = carry;
    let hover = s.pos[1] - ground.height(s.pos[0], s.pos[2]);
    if (hover < 0)
        hover = truckRadius(p) * 2;
    s.hover = hover;
    zeroMotion(s);
    return true;
}
/** The Professional CPU reset (0x46f7b0): onto its segment's start, 10 ft up, facing along it. */
export function cpuResetTruck(s, rc) {
    const seg = rc.segment;
    zeroMotion(s);
    s.heliTimer = 0;
    s.euler[0] = 0;
    s.euler[1] = 0;
    if (seg && !isArc(seg)) {
        s.pos[0] = seg.start[0];
        s.pos[1] = seg.start[1] + RESET_LIFT_FT;
        s.pos[2] = seg.start[2];
        s.euler[2] = headingTo(seg.end[0] - seg.start[0], seg.end[2] - seg.start[2]);
    }
    else {
        s.pos[1] += RESET_LIFT_FT;
    }
    eulerToMatrix(s.euler[0], s.euler[1], s.euler[2], s.matrix);
}
/**
 * The stuck checks of the position integrator (§10.3), after the velocity update. `speed` is
 * the world speed, `contacts` this step's hull contact count, `atRest` whether the step zeroed
 * the velocity. Performs the reset or lift-off it decides on and returns which.
 */
export function updateStuck(s, p, ground, rc, speed, contacts, atRest, dt) {
    if (rc.autopilot && rc.racing && !rc.dragGated) {
        if (s.heliTimer <= 0 && speed < STUCK_SPEED) {
            s.heliTimer -= dt;
        }
        else if (s.heliTimer < 0) {
            s.heliTimer += dt;
            if (s.heliTimer > 0)
                s.heliTimer = 0;
        }
    }
    if (rc.player) {
        if (s.heliTimer <= 0 && contacts > 0 && noWheelDown(s)) {
            if (s.heliTimer > STUCK_LIMIT_S) {
                s.heliTimer -= dt;
                if (s.heliTimer >= STUCK_LIMIT_S)
                    return atRest ? atRestAction(s, p, ground, rc, contacts) : null;
                if (resetTruck(s, rc, contacts))
                    return "reset";
            }
        }
        else {
            s.heliTimer += dt;
            if (s.heliTimer > 0)
                s.heliTimer = 0;
        }
    }
    if (s.heliTimer < STUCK_LIMIT_S && liftOff(s, p, ground, rc, contacts))
        return "lift";
    return atRest ? atRestAction(s, p, ground, rc, contacts) : null;
}
function atRestAction(s, p, ground, rc, contacts) {
    // The caller (0x46da30) acts only in the racing state (4), not through the countdown.
    if (!rc.racing)
        return null;
    if (rc.player)
        return resetTruck(s, rc, contacts) ? "reset" : null;
    if (rc.difficulty < DIFFICULTY.PROFESSIONAL || rc.proLift)
        return liftOff(s, p, ground, rc, contacts) ? "lift" : null;
    cpuResetTruck(s, rc);
    return "cpuReset";
}
/**
 * One step of helicopter flight (0x46ed90), in place of the truck step while `heliTimer` is
 * positive.
 */
export function helicopterStep(s, ground, dt) {
    s.rpm += (HELI_IDLE_RPM - s.rpm) * dt;
    if (s.heliTimer === FLIGHT_S)
        for (const t of s.tires)
            t.onGround = false;
    const t = s.heliTimer;
    if (t < CARRY_S) {
        const c = s.carry;
        s.euler[0] -= c.pitch * dt;
        s.euler[1] -= c.roll * dt;
        s.euler[2] -= c.heading * dt;
        s.pos[0] -= c.x * dt;
        s.pos[2] -= c.z * dt;
        s.hover += (t <= HOVER_DESCENT_S ? -HOVER_RATE : HOVER_RATE) * dt;
        s.pos[1] = ground.height(s.pos[0], s.pos[2]) + s.hover;
        eulerToMatrix(s.euler[0], s.euler[1], s.euler[2], s.matrix);
    }
    s.heliTimer -= dt;
    if (s.heliTimer <= 0) {
        s.heliTimer = 0;
        s.hover = 0;
        s.depths.fill(-9999);
    }
}
/** The player's Helicopter key: call the helicopter, or drop the truck from it. */
export function pressHelicopterKey(s, rc) {
    if (rc.dragRace || rc.summit)
        return;
    if (s.heliTimer === 0) {
        s.heliTimer = HELI_KEY_TIMER;
    }
    else {
        s.heliTimer = 0;
        s.carry.heading = 0;
        s.carry.x = 0;
        s.carry.z = 0;
    }
}
