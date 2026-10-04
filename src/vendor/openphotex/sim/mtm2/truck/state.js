/*
  A truck's dynamic state (MTM2_PHYSICS.md §1): plain arrays and numbers, structured-cloneable.

  Position `pos` is world feet, `bvel` body-axis velocity (z forward), `euler` the angles
  (theta pitch, phi roll, psi yaw) and `rates` the body rates (p roll, q pitch, r yaw).
*/
import { GEAR, ENGINE } from "../constants.js";
import { createControlState } from "./controls.js";
/** A truck at rest at `pos`, facing `heading` (psi, 0 = +z). */
export function createTruckState(pos, heading = 0, gear = GEAR.FIRST) {
    return {
        pos: Float64Array.from([pos[0], pos[1], pos[2]]),
        bvel: new Float64Array(3),
        euler: Float64Array.from([0, 0, heading]),
        rates: new Float64Array(3),
        rpm: ENGINE.idleRpm,
        controls: createControlState(gear),
        wheelSpin: new Float64Array(4),
        wheelAngle: new Float64Array(4),
        onGround: new Uint8Array(4),
        axleAngle: new Float64Array(2),
        heliTimer: 0,
    };
}
