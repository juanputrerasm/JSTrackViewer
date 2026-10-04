/*
  The player's keyboard controls (MONSTER_EXE_ANALYSIS.md §7, routine 0x584490).

  - Keys ramp the pedals rather than switching them. The routine scales the frame time by
    0x7fff / 0x10000 first, so every rate below runs at about half its stored value: the
    throttle and brakes rise at 3.5 × dt′ and fall at 8 × dt′, dt′ ≈ dt / 2.
  - With automatic shifting, braking while stopped or rolling backwards selects Reverse and
    the brake key then drives; accelerating in Reverse selects first gear again. In a drag race
    this waits until the truck has passed more than 3 course segments.
  - Without automatic shifting, releasing the accelerator leaves the throttle where it is
    (only braking clears it). That is what the code does; it is noted for checking in play.
  - Steering keeps the shaped angle s. Each frame the linear angle 0.45 · (|s| / 0.45)^(1/e)
    is recovered with the previous exponent, moved by dt′ while a turn key is held (and back
    towards 0 at 4 × dt′ when not), clamped to ±0.45, and shaped again:
    s = sign · 0.45 · (|lin| / 0.45)^e, e = (1 + 0.25 · response) · clamp(|v_fwd| · 0.025, 1, 1.1).
  - The rear wheels steer −0.33 × the front, and −0.4125 × in drag mode.
*/
import { CONTROLS, GEAR } from "../constants.js";
/** The routine's frame-time scale: a 16.16 multiply by 0x7fff. */
export const KEY_DT_SCALE = 0x7fff / 0x10000;
export function createControlState(gear = GEAR.FIRST) {
    return {
        throttle: 0, brakeFront: 0, brakeRear: 0, steer: 0, rearSteer: 0, gear, shiftRequest: 0,
        steerExponent: 1 + 0.25,
    };
}
/** Apply one frame of keyboard input to the pedals, gear selection and steering. */
export function applyKeyboard(c, keys, ctx) {
    const dt = ctx.dt * KEY_DT_SCALE;
    const up = CONTROLS.rampUpPerSec * dt;
    const down = CONTROLS.rampDownPerSec * dt;
    const dragGate = ctx.dragMode && ctx.segments < 4;
    if (keys.accelerate) {
        if (ctx.autoShift && !dragGate && c.gear === GEAR.REVERSE)
            c.gear = GEAR.FIRST;
        c.brakeFront = 0;
        c.brakeRear = 0;
        c.throttle = Math.min(1, c.throttle + up);
    }
    else if (c.gear !== GEAR.REVERSE && ctx.autoShift && c.throttle !== 0) {
        c.throttle = Math.max(0, c.throttle - down);
    }
    if (!keys.brake) {
        if (c.brakeFront !== 0 || c.brakeRear !== 0) {
            c.brakeFront = Math.max(0, c.brakeFront - down);
            c.brakeRear = Math.max(0, c.brakeRear - down);
        }
        if (c.gear === GEAR.REVERSE && ctx.autoShift && c.throttle !== 0)
            c.throttle = Math.max(0, c.throttle - down);
    }
    else if (!ctx.autoShift || c.gear === GEAR.PARK || dragGate || ctx.forwardSpeed > 0) {
        c.throttle = 0;
        c.brakeFront = Math.min(1, c.brakeFront + up);
        c.brakeRear = Math.min(1, c.brakeRear + up);
    }
    else {
        c.gear = GEAR.REVERSE;
        c.brakeFront = 0;
        c.brakeRear = 0;
        c.throttle = Math.min(1, c.throttle + up);
    }
    steerKeys(c, keys.left, keys.right, dt, ctx);
    if (keys.shiftDown)
        c.shiftRequest = -1;
    if (keys.shiftUp)
        c.shiftRequest = 1;
}
function steerKeys(c, left, right, dt, ctx) {
    const lock = CONTROLS.steerLock;
    const sign = c.steer < 0 ? -1 : 1;
    let lin = sign * lock * Math.pow(Math.abs(c.steer) / lock, 1 / c.steerExponent);
    const back = dt * CONTROLS.steerReturnFactor;
    if (left) {
        lin -= dt;
        if (lin < -lock)
            lin = -lock;
    }
    else if (lin < 0) {
        lin += back;
        if (lin > 0)
            lin = 0;
    }
    if (right) {
        lin += dt;
        if (lin > lock)
            lin = lock;
    }
    else if (lin > 0) {
        lin -= back;
        if (lin < 0)
            lin = 0;
    }
    const speedFactor = Math.min(1.1, Math.max(1, Math.abs(ctx.forwardSpeed * 0.025)));
    c.steerExponent = ((ctx.steeringResponse ?? 1) * 0.25 + 1) * speedFactor;
    c.steer = (lin < 0 ? -1 : 1) * lock * Math.pow(Math.abs(lin) / lock, c.steerExponent);
    c.rearSteer = rearSteer(c.steer, ctx.dragMode);
}
/** The rear axle's steering angle for a front angle. */
export function rearSteer(front, dragMode) {
    const rear = front * CONTROLS.rearSteerFactor;
    return dragMode ? rear * CONTROLS.rearSteerDragFactor : rear;
}
