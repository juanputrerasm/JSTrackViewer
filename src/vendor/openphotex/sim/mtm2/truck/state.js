/*
  A truck's dynamic state (MTM2_PHYSICS.md §1, §14): plain arrays and numbers, structured-cloneable.

  Position `pos` is world feet, `bvel` body-axis velocity (z forward), `euler` the angles
  (theta pitch, phi roll, psi yaw) and `rates` the body rates (p roll, q pitch, r yaw), as the
  game names them. `matrix` is the body-to-world rotation the step keeps in step with `euler`.

  Tires are in the order FR, FL, RR, RL; axles front, rear. The 16 contact points are the 12 hull
  (scrape) points followed by the 4 tire contact points, all in body feet.
*/
import { GEAR, ENGINE } from "../constants.js";
import { eulerToMatrix } from "../math.js";
import { createControlState } from "./controls.js";
function tire() {
    return {
        compression: 0, extensionRate: 0, penetration: -9999, lever: 0, normal: [0, 1, 0], onGround: false,
        spin: 0, angle: 0, pitchG: 0, rollG: 0, load: 0, grip: 0,
        hub: [0, 0, 0], contact: [0, 0, 0], velocity: [0, 0, 0], force: [0, 0, 0],
        waterDepth: 0, waterPoint: [0, 0, 0],
    };
}
/**
 * A truck at `pos`, facing `heading` (psi, 0 = +z). With `params` the axles start at rest on their
 * static anchors and the contact points are the truck's hull and tire points.
 */
export function createTruckState(pos, heading = 0, gear = GEAR.FIRST, params) {
    const points = new Float64Array(16 * 3);
    params?.scrapePoints.slice(0, 12).forEach((p, i) => points.set(p, i * 3));
    const axles = [0, 2].map((t) => ({ articulation: 0, travel: params ? params.hubs[t][1] : -4 }));
    const state = {
        pos: Float64Array.from([pos[0], pos[1], pos[2]]),
        bvel: new Float64Array(3),
        euler: Float64Array.from([0, 0, heading]),
        rates: new Float64Array(3),
        matrix: new Float64Array(9),
        rpm: ENGINE.idleRpm,
        controls: createControlState(gear),
        tires: [tire(), tire(), tire(), tire()],
        axles,
        points,
        depths: new Float64Array(16).fill(-9999),
        normals: new Float64Array(16 * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)),
        waterDepths: new Float64Array(16),
        contactCount: 0,
        heliTimer: 0,
        carry: { pitch: 0, roll: 0, heading: 0, x: 0, z: 0 },
        hover: 0,
        impulseMoment: 0,
        impactForce: 0,
        splash: false,
    };
    eulerToMatrix(0, 0, heading, state.matrix);
    return state;
}
