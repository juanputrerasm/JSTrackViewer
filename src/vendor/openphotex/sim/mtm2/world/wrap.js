/*
  The world as a torus (OpenMTM2 docs/MONSTER_EXE_ANALYSIS.md, "The wrapping world"): 8192 ft a side, or W = 32 N
  ft in a track format version 6 world of N cells (section 8.1). Every function takes the world's side, `worldFt`,
  8192 by default.

  The game keeps a truck inside the one world by wrapping its x and z every frame (`0x5559c0`): above 8192 it takes
  8192 off, below zero it adds 8192. `wrapTruck` is that. The game takes no distance the short way round, so two
  things either side of the seam do not meet until one is wrapped across; the pair tests here do take the short way
  (`wrapDelta`, `withNearest`), which is the port's: a truck meets the same box from either side of the seam.
*/
import { WORLD_FT } from "../constants.js";
/** A coordinate brought into the world, [0, W). */
export function wrapCoord(v, worldFt = WORLD_FT) {
    const w = v % worldFt;
    return w < 0 ? w + worldFt : w;
}
/** A difference of two coordinates taken the short way round: in [-W / 2, W / 2). */
export function wrapDelta(d, worldFt = WORLD_FT) {
    const half = worldFt / 2;
    const w = (d + half) % worldFt;
    return (w < 0 ? w + worldFt : w) - half;
}
/** The whole worlds to add to `v` so that it is the copy nearest `to`. */
export function nearestShift(v, to, worldFt = WORLD_FT) {
    return wrapDelta(v - to, worldFt) - (v - to);
}
/** A negative load position brought into the world (objects, ramps, top-crush cars, course ends): + W, as the game adds 8192. */
export function wrapLoadCoord(v, worldFt = WORLD_FT) {
    return v < 0 ? v + worldFt : v;
}
/**
 * Wrap a truck's position as the game does each frame: x and z alone, a world at a time. Its last position goes with
 * it (the game keeps none; the pair tests here cast rays from it). Returns the `[dx, dz]` added, zeros when it stayed.
 */
export function wrapTruck(s, worldFt = WORLD_FT) {
    const shift = [0, 0];
    for (const [k, axis] of [[0, 0], [1, 2]]) {
        if (s.pos[axis] > worldFt)
            shift[k] = -worldFt;
        else if (s.pos[axis] < 0)
            shift[k] = worldFt;
        if (shift[k]) {
            s.pos[axis] += shift[k];
            s.prevPos[axis] += shift[k];
        }
    }
    return shift;
}
/**
 * Run `test` with the truck moved by whole worlds to the copy nearest (x, z), then move it back by the same, keeping
 * whatever the test did to it. For a pair test against something that stands across the seam.
 */
export function withNearest(s, x, z, test, worldFt = WORLD_FT) {
    const dx = nearestShift(s.pos[0], x, worldFt), dz = nearestShift(s.pos[2], z, worldFt);
    if (!dx && !dz)
        return test();
    s.pos[0] += dx;
    s.pos[2] += dz;
    s.prevPos[0] += dx;
    s.prevPos[2] += dz;
    try {
        return test();
    }
    finally {
        s.pos[0] -= dx;
        s.pos[2] -= dz;
        s.prevPos[0] -= dx;
        s.prevPos[2] -= dz;
    }
}
