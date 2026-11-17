/*
  Moving objects (MTM2_PHYSICS.md §14.18): type 10 boxes that slide along their SIT `bvel` every
  frame, riding on the terrain or on the deck of a ground box they are above, wrapping round the
  world. TPARK's train is one; any type 10 box moves the same way. For a truck a moving object is
  an immovable box that stands still where it is each frame.
*/
import { groundHeightAt, terrainCells } from "../world/terrain.js";
/**
 * The height under (x, z) for a body whose centre is at `y` (`0x502350`): a ground box's top when
 * the cell has one whose lower height is below `y`, else the terrain (Snow-aware). `ra0` / `ra1`
 * are the level's lower and upper ground-box heights (2 ft steps; see GroundBoxScale for others). The cell mask and
 * row stride are the terrain's N (`terrain.cells`, 256 unless a track format version 6 world says 512).
 */
export function groundBoxHeightAt(terrain, ra0, ra1, x, z, y, snow = false, { stepFt = 2, baseFt = 0 } = {}) {
    if (ra0 && ra1) {
        const n = terrainCells(terrain), m = n - 1;
        // The game works in 1/256 ft integers, cells 8192 units wide: the cell is (pos >> 13) & (N - 1).
        const xi = Math.trunc(x * 256), zi = Math.trunc(z * 256), yi = Math.trunc(y * 256);
        let col = (xi >> 13) & m, row = (zi >> 13) & m;
        // On a cell's west (north) edge, a higher neighbouring box top wins.
        if (col << 13 === xi) {
            const west = (col - 1) & m;
            if (ra1[row * n + col] < ra1[row * n + west])
                col = west;
        }
        if (row << 13 === zi) {
            const north = (row - 1) & m;
            if (ra1[row * n + col] < ra1[north * n + col])
                row = north;
        }
        const i = row * n + col;
        // Lower and upper in the grid's 1/64 ft, against the centre's y in the same units.
        if ((baseFt + ra0[i] * stepFt) * 64 < Math.trunc(yi / 4) && ra0[i] !== ra1[i])
            return baseFt + ra1[i] * stepFt;
    }
    return groundHeightAt(terrain, x, z, snow);
}
/** One frame of a moving object (§14.18): along `bvel` on x and z, at half its height above the ground. */
export function stepMovingObject(box, bvel, terrain, ra0, ra1, dt, snow = false, scale = {}) {
    // The world wraps at W = 32 N ft (8192 in retail).
    const worldFt = terrainCells(terrain) * 32;
    let x = box.pos[0] + bvel[0] * dt;
    let z = box.pos[2] + bvel[2] * dt;
    box.pos[1] = groundBoxHeightAt(terrain, ra0, ra1, x, z, box.pos[1], snow, scale) + box.half[1];
    if (x > worldFt)
        x -= worldFt;
    if (x < 0)
        x += worldFt;
    if (z > worldFt)
        z -= worldFt;
    if (z < 0)
        z += worldFt;
    box.pos[0] = x;
    box.pos[2] = z;
}
