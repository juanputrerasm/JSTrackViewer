/*
  Moving objects (MTM2_PHYSICS.md §14.18): type 10 boxes that slide along their SIT `bvel` every
  frame, riding on the terrain or on the deck of a ground box they are above, wrapping round the
  world. TPARK's train is one; any type 10 box moves the same way. For a truck a moving object is
  an immovable box that stands still where it is each frame.
*/
import { groundHeightAt } from "../world/terrain.js";
const WORLD_FT = 8192;
/**
 * The height under (x, z) for a body whose centre is at `y` (`0x502350`): a ground box's top when
 * the cell has one whose lower height is below `y`, else the terrain (Snow-aware). `ra0` / `ra1`
 * are the level's lower and upper ground-box heights (2 ft steps).
 */
export function groundBoxHeightAt(terrain, ra0, ra1, x, z, y, snow = false) {
    if (ra0 && ra1) {
        // The game works in 1/256 ft integers, cells 8192 units wide.
        const xi = Math.trunc(x * 256), zi = Math.trunc(z * 256), yi = Math.trunc(y * 256);
        let col = (xi & 0x1fe000) >> 13, row = (zi & 0x1fe000) >> 13;
        // On a cell's west (north) edge, a higher neighbouring box top wins.
        if (col << 13 === xi) {
            const west = (col - 1) & 255;
            if (ra1[row * 256 + col] < ra1[row * 256 + west])
                col = west;
        }
        if (row << 13 === zi) {
            const north = (row - 1) & 255;
            if (ra1[row * 256 + col] < ra1[north * 256 + col])
                row = north;
        }
        const i = row * 256 + col;
        // Lower and upper in the grid's 1/64 ft, against the centre's y in the same units.
        if (ra0[i] * 128 < Math.trunc(yi / 4) && ra0[i] !== ra1[i])
            return ra1[i] * 2;
    }
    return groundHeightAt(terrain, x, z, snow);
}
/** One frame of a moving object (§14.18): along `bvel` on x and z, at half its height above the ground. */
export function stepMovingObject(box, bvel, terrain, ra0, ra1, dt, snow = false) {
    let x = box.pos[0] + bvel[0] * dt;
    let z = box.pos[2] + bvel[2] * dt;
    box.pos[1] = groundBoxHeightAt(terrain, ra0, ra1, x, z, box.pos[1], snow) + box.half[1];
    if (x > WORLD_FT)
        x -= WORLD_FT;
    if (x < 0)
        x += WORLD_FT;
    if (z > WORLD_FT)
        z -= WORLD_FT;
    if (z < 0)
        z += WORLD_FT;
    box.pos[0] = x;
    box.pos[2] = z;
}
