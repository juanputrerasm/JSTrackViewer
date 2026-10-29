/*
  Box objects for collisions (MTM2_PHYSICS.md §7.3, §14.14).

  A box is centred on its position, with half extents along its own x, y and z, a rotation
  (body to world, row-major, like the truck's) and a world velocity. A mass of 0 is immovable.
  Ground boxes are rebuilt around each truck every frame from the level's .RA0 / .RA1 layers.
*/
import { eulerToMatrix } from "../math.js";
import { wrapCoord } from "../world/wrap.js";
/** The corner order of the game's box setup (§14.15). */
const CORNERS = [
    [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1], [-1, 1, -1], [1, 1, -1], [-1, -1, -1], [1, -1, -1],
];
/** A box from its centre, full sizes (x, y, z) and angles (theta, phi, psi). */
export function createBox(pos, size, mass = 0, angles = [0, 0, 0]) {
    const half = [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5];
    const matrix = new Float64Array(9);
    eulerToMatrix(angles[0], angles[1], angles[2], matrix);
    const points = new Float64Array(24);
    CORNERS.forEach((c, i) => points.set([c[0] * half[0], c[1] * half[1], c[2] * half[2]], i * 3));
    return {
        pos: [pos[0], pos[1], pos[2]], matrix, vel: [0, 0, 0], half, mass,
        radius: Math.hypot(half[0], half[1], half[2]), type: -1, dynamic: mass >= 1,
        bvel: new Float64Array(3), rates: new Float64Array(3), euler: Float64Array.from([angles[0], angles[1], angles[2]]),
        force: new Float64Array(3), moment: new Float64Array(3),
        points, depths: new Float64Array(8).fill(-9999), normals: new Float64Array(24).map((_, i) => (i % 3 === 1 ? 1 : 0)),
        contactCount: 0, impactForce: 0,
    };
}
/** Checkpoints (6), type 7 and camera-facing billboards (8) never collide (§14.15). */
const NON_COLLIDING_TYPES = new Set([6, 7, 8]);
/** Whether a level box is a collision object at a MONSTER.INI detail level (§14.15). */
export function levelBoxCollides(box, detailLevel = 2) {
    return !NON_COLLIDING_TYPES.has(box.type) && (box.priority ?? 0) <= detailLevel;
}
/**
 * A level box as a collision object (§14.15): centred on its position, rotated by its angles,
 * sized by its model's vertex bounds when it has a model (else the SIT's sizes). Camera-facing
 * types 8 and 9 take the larger of length and width for both, halved. Null without a position.
 */
export function createLevelBox(box, bounds = null) {
    if (!box.positionFt)
        return null;
    let width, height, length;
    if (bounds) {
        width = bounds.max[0] - bounds.min[0];
        height = bounds.max[1] - bounds.min[1];
        length = bounds.max[2] - bounds.min[2];
    }
    else {
        [length, width, height] = box.sizeFt ?? [0, 0, 0];
    }
    if (box.type === 8 || box.type === 9) {
        const side = Math.max(length, width) * 0.5;
        length = width = side;
    }
    const out = createBox(box.positionFt, [width, height, length], box.mass, [box.theta, box.phi, box.psi]);
    out.type = box.type;
    return out;
}
/** For a truck of `truckMass` slugs, a box is pushable only when 0 < mass < truckMass (§7.3). */
export function boxIsImmovableFor(box, truckMass) {
    return !(box.mass > 0 && box.mass < truckMass);
}
export const GROUND_BOX_CELL_FT = 32;
export const MAX_GROUND_BOXES = 600;
/**
 * The ground boxes around a point (§14.14): every cell of the 3 x 3 around it whose lower
 * (`ra0`) and upper (`ra1`) heights differ. Heights are 2 ft steps; neighbours wrap at the map
 * edge. Each box is placed beside the point, whichever side of the edge its cell is on (the port's:
 * the game places it by its own cell, a world away from a truck at the other edge). Every face is
 * solid, as in the game: a wheel climbs onto a box only when its hub was above the top the step
 * before (§14.14 step 3), so a step taller than the hub is a wall. `stepFt` is the feet to a height
 * step, for a level whose steps are not MTM2's 2 ft (Hellbender's are 1.5).
 */
export function groundBoxesAround(ra0, ra1, x, z, out = [], stepFt = 2) {
    const col = (Math.trunc(x * 256) >> 13) & 255;
    const row = (Math.trunc(z * 256) >> 13) & 255;
    // Where the point's own copy of the world begins. A neighbouring cell across the map's edge is read wrapped, as in
    // the game, but its box is placed beside the point (the game places it a world away, where the truck never meets it).
    const baseX = x - wrapCoord(x), baseZ = z - wrapCoord(z);
    for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
            const c = (col + dc) & 255, r = (row + dr) & 255;
            const i = r * 256 + c;
            const lo = ra0[i] * stepFt, hi = ra1[i] * stepFt;
            if (lo === hi)
                continue;
            const h = hi - lo;
            // The game's centre is in whole feet (its steps are 2 ft); a level of another step keeps the true middle.
            const box = createBox([baseX + (col + dc) * GROUND_BOX_CELL_FT + 16, lo + (stepFt === 2 ? Math.trunc(h / 2) : h / 2), baseZ + (row + dr) * GROUND_BOX_CELL_FT + 16], [GROUND_BOX_CELL_FT, h, GROUND_BOX_CELL_FT]);
            out.push(box);
            if (out.length > MAX_GROUND_BOXES)
                throw new Error("Too many ground boxes.");
        }
    }
    return out;
}
