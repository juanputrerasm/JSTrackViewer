/*
  Checkpoints (MONSTER_EXE_ANALYSIS.md §6.2; set up with the level, tested by 0x485af0).

  - The checkpoints are the SIT's type 6 boxes, in file order. Each has two copies: the gate
    itself, and a detector three times as wide and twice as tall (same depth along its axis).
  - Each tick only the truck's next checkpoint is tested: a sphere pretest
    |truck - detector| < (detector radius + truck radius) · 2, then the truck's hull points are
    swept against the detector box (the truck-against-box test of §7.3, without the wheels),
    then the truck's velocity must point along the checkpoint's +z axis.
  - Crossing the detector forwards counts when the truck also overlaps the gate; otherwise it is
    a missed checkpoint (reported once until the next pass).
  - The split time is the race time minus penetration depth / speed along the axis: the moment
    the truck actually crossed.

  Box geometry: length runs along the box's z axis, width along x, height along y; the stored
  sizes are full extents. A box with a model (stock checkpoints use ckboxn.bin) takes its size
  from the model's extents instead of the SIT values (0x5495e0); the caller supplies them. The
  bounding radius is the half diagonal.
*/
import { eulerToMatrix } from "../math.js";
export const CHECKPOINT_TYPE = 6;
export const DETECTOR_WIDTH_SCALE = 3;
export const DETECTOR_HEIGHT_SCALE = 2;
export const SPHERE_PRETEST_FACTOR = 2;
function box(position, angles, size) {
    const matrix = new Array(9);
    eulerToMatrix(angles[0], angles[1], angles[2], matrix);
    const radius = Math.hypot(size[0] * 0.5, size[1] * 0.5, size[2] * 0.5);
    return { position, angles, size, matrix, radius };
}
/** The checkpoints of a level, from its boxes in file order. */
export function buildCheckpoints(boxes, modelExtents) {
    const out = [];
    for (const b of boxes) {
        if (b.type !== CHECKPOINT_TYPE)
            continue;
        const position = [b.positionFt?.[0] ?? 0, b.positionFt?.[1] ?? 0, b.positionFt?.[2] ?? 0];
        const angles = [b.theta, b.phi, b.psi];
        // SIT order is length, width, height.
        let [length, width, height] = [b.sizeFt?.[0] ?? 64, b.sizeFt?.[1] ?? 64, b.sizeFt?.[2] ?? 64];
        const fromModel = b.modelName && modelExtents ? modelExtents(b.modelName) : null;
        if (fromModel)
            [width, height, length] = fromModel;
        out.push({
            index: out.length,
            gate: box(position, angles, [width, height, length]),
            detector: box(position, angles, [width * DETECTOR_WIDTH_SCALE, height * DETECTOR_HEIGHT_SCALE, length]),
        });
    }
    return out;
}
/** The sphere pretest against a checkpoint box. */
export function withinCheckpointReach(b, truckPos, truckRadius) {
    const d = Math.hypot(truckPos[0] - b.position[0], truckPos[1] - b.position[1], truckPos[2] - b.position[2]);
    return d < (b.radius + truckRadius) * SPHERE_PRETEST_FACTOR;
}
/** A world-frame velocity's component along the checkpoint's axis (+z): positive is forwards. */
export function speedThroughCheckpoint(b, worldVelocity) {
    const m = b.matrix;
    return m[2] * worldVelocity[0] + m[5] * worldVelocity[1] + m[8] * worldVelocity[2];
}
/** The race time at which the truck crossed, from the penetration depth found this tick. */
export function checkpointCrossingTime(raceTime, depth, speedThrough) {
    return raceTime - depth / speedThrough;
}
/** Whether a point lies inside a checkpoint box (helper for tests and tools). */
export function pointInCheckpointBox(b, p) {
    const m = b.matrix;
    const dx = p[0] - b.position[0], dy = p[1] - b.position[1], dz = p[2] - b.position[2];
    const lx = m[0] * dx + m[3] * dy + m[6] * dz;
    const ly = m[1] * dx + m[4] * dy + m[7] * dz;
    const lz = m[2] * dx + m[5] * dy + m[8] * dz;
    return Math.abs(lx) <= b.size[0] / 2 && Math.abs(ly) <= b.size[1] / 2 && Math.abs(lz) <= b.size[2] / 2;
}
