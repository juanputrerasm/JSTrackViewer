/*
  4x4 Evolution 2's smoothed ground (OpenMTM2 docs/EVO2_EXE_ANALYSIS.md, "Ground").

  Each 32 ft cell keeps a 4 x 4 grid of heights 8 ft apart (CGround, 0x469b20). At the game's high
  detail they are filled by a cardinal spline of tension 0 (Catmull-Rom) through the cell corners
  (0x46a160): along x on the cell's first row, along z on its first column, then every other row
  along x from the first column's values; each value rounded and held in 0..0xFFE0. The height query
  (0x471cb0) reads that grid, so the trucks drive on the same surface that is drawn.
*/
/** Sub-heights per cell side, and their spacing in feet. */
export const EVO_SUB = 4, EVO_SUB_FT = 8;
const GRID = 256, MASK = GRID - 1, FINE = GRID * EVO_SUB;
/** Catmull-Rom weights of p0..p3 at t (0x5c7780 with tension 0). */
function weights(t) {
    const t2 = t * t, t3 = t2 * t;
    return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
}
const W = [0.25, 0.5, 0.75].map(weights);
const blend = (w, a, b, c, d) => Math.max(0, Math.min(0xffe0, Math.round(w[0] * a + w[1] * b + w[2] * c + w[3] * d)));
/**
 * The fine grid of a 256 x 256 heightfield of corners (the level .RAW, 1/32 ft units, rows along z):
 * 1024 x 1024 heights in the same units, 8 ft apart, rows along z, the world wrapping as the corners do.
 * Sub-height (sz, sx) of cell (row, col) is at `(row * 4 + sz) * 1024 + col * 4 + sx`.
 */
export function evoSmoothHeights(corners) {
    const out = new Uint16Array(FINE * FINE);
    const at = (row, col) => corners[(row & MASK) * GRID + (col & MASK)];
    const put = (row, col, sz, sx, v) => { out[(row * EVO_SUB + sz) * FINE + col * EVO_SUB + sx] = v; };
    const get = (row, col, sz, sx) => out[((row & MASK) * EVO_SUB + sz) * FINE + (col & MASK) * EVO_SUB + sx];
    // The corners, then the first row along x and the first column along z.
    for (let row = 0; row < GRID; row++)
        for (let col = 0; col < GRID; col++) {
            put(row, col, 0, 0, at(row, col));
            for (let k = 0; k < 3; k++) {
                put(row, col, 0, k + 1, blend(W[k], at(row, col - 1), at(row, col), at(row, col + 1), at(row, col + 2)));
                put(row, col, k + 1, 0, blend(W[k], at(row - 1, col), at(row, col), at(row + 1, col), at(row + 2, col)));
            }
        }
    // Every other row along x, from the first column's values of the cells either side.
    for (let row = 0; row < GRID; row++)
        for (let col = 0; col < GRID; col++) {
            for (let sz = 1; sz < EVO_SUB; sz++) {
                const a = get(row, col - 1, sz, 0), b = get(row, col, sz, 0), c = get(row, col + 1, sz, 0), d = get(row, col + 2, sz, 0);
                for (let k = 0; k < 3; k++)
                    put(row, col, sz, k + 1, blend(W[k], a, b, c, d));
            }
        }
    return out;
}
