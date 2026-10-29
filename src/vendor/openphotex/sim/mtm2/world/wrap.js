/*
  The world as a torus (OpenMTM2 docs/MONSTER_EXE_ANALYSIS.md, "The wrapping world"): 8192 ft a side.

  The game keeps a truck inside the one world by wrapping its x and z every frame (`0x5559c0`): above 8192 it takes
  8192 off, below zero it adds 8192. `wrapTruck` is that. The game takes no distance the short way round, so two
  things either side of the seam do not meet until one is wrapped across; the pair tests here do take the short way
  (`wrapDelta`, `withNearest`), which is the port's: a truck meets the same box from either side of the seam.
*/
import { WORLD_FT } from "../constants.js";
const HALF_FT = WORLD_FT / 2;
/** A coordinate brought into the world, [0, 8192). */
export function wrapCoord(v) {
    const w = v % WORLD_FT;
    return w < 0 ? w + WORLD_FT : w;
}
/** A difference of two coordinates taken the short way round: in [-4096, 4096). */
export function wrapDelta(d) {
    const w = (d + HALF_FT) % WORLD_FT;
    return (w < 0 ? w + WORLD_FT : w) - HALF_FT;
}
/** The whole worlds to add to `v` so that it is the copy nearest `to`. */
export function nearestShift(v, to) {
    return wrapDelta(v - to) - (v - to);
}
/**
 * Wrap a truck's position as the game does each frame: x and z alone, a world at a time. Its last position goes with
 * it (the game keeps none; the pair tests here cast rays from it). Returns the `[dx, dz]` added, zeros when it stayed.
 */
export function wrapTruck(s) {
    const shift = [0, 0];
    for (const [k, axis] of [[0, 0], [1, 2]]) {
        if (s.pos[axis] > WORLD_FT)
            shift[k] = -WORLD_FT;
        else if (s.pos[axis] < 0)
            shift[k] = WORLD_FT;
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
export function withNearest(s, x, z, test) {
    const dx = nearestShift(s.pos[0], x), dz = nearestShift(s.pos[2], z);
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
