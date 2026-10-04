/*
  The MTM2 terrain the simulation stands on (MTM2_PHYSICS.md §2.1, §2.2).

  - A 256 × 256 grid of 32 ft cells; the level's `.RAW` heightfield is the grid in file order:
    corner (row, col) is byte `row * 256 + col`, worth 2 ft per step. Rows follow z, columns x.
  - Positions are truncated to 1/256 ft and wrap at 8192 ft.
  - Each cell is two triangles, split along a diagonal that alternates in a checkerboard: when
    `row + col` is even the split runs from (row, col) to (row + 1, col + 1), otherwise along the
    other diagonal. Height is linear inside the triangle; the normal is the triangle's.
  - In Snow, ground below the water level is raised to it, flat, so frozen water is drivable.

  Ramps, ground boxes and object tops are layered on top of this by the world module.
*/
import { CELL_FT, HEIGHT_STEP_FT, TERRAIN_CELLS } from "../constants.js";
const UNITS_PER_FT = 256;
const UNITS_PER_CELL = CELL_FT * UNITS_PER_FT; // 0x2000
const MASK = TERRAIN_CELLS - 1;
export function createTerrain(heights, waterLevelFt = null) {
    if (heights.length !== TERRAIN_CELLS * TERRAIN_CELLS) {
        throw new RangeError(`terrain needs ${TERRAIN_CELLS * TERRAIN_CELLS} heights, got ${heights.length}`);
    }
    return { heights, waterLevelFt };
}
function corner(t, row, col) {
    return t.heights[(row & MASK) * TERRAIN_CELLS + (col & MASK)] * HEIGHT_STEP_FT;
}
/** The cell and in-cell fractions of a position, as the game computes them. */
function locate(x, z) {
    const xi = Math.trunc(x * UNITS_PER_FT) | 0;
    const zi = Math.trunc(z * UNITS_PER_FT) | 0;
    return {
        col: (xi >> 13) & MASK,
        row: (zi >> 13) & MASK,
        fx: (xi & (UNITS_PER_CELL - 1)) / UNITS_PER_CELL,
        fz: (zi & (UNITS_PER_CELL - 1)) / UNITS_PER_CELL,
    };
}
/** True when the cell at (row, col) splits along (row, col)-(row + 1, col + 1). */
export function cellSplitsMainDiagonal(row, col) {
    return ((row ^ col) & 1) === 0;
}
/** Bare terrain height in feet, without the Snow rule. */
export function terrainHeightAt(t, x, z) {
    const { row, col, fx, fz } = locate(x, z);
    const h00 = corner(t, row, col);
    const h01 = corner(t, row, col + 1);
    const h10 = corner(t, row + 1, col);
    const h11 = corner(t, row + 1, col + 1);
    if (cellSplitsMainDiagonal(row, col)) {
        return fz < fx
            ? h00 + (h01 - h00) * fx + (h11 - h01) * fz
            : h00 + (h11 - h10) * fx + (h10 - h00) * fz;
    }
    return fz < 1 - fx
        ? h01 + (h00 - h01) * (1 - fx) + (h10 - h00) * fz
        : h01 + (h10 - h11) * (1 - fx) + (h11 - h01) * fz;
}
/** Ground height with the Snow rule: frozen water carries the trucks. */
export function groundHeightAt(t, x, z, snow = false) {
    const h = terrainHeightAt(t, x, z);
    if (snow && t.waterLevelFt !== null && h < t.waterLevelFt)
        return t.waterLevelFt;
    return h;
}
/**
 * The upward unit normal of the triangle under (x, z), into `out`. Flat over frozen water in
 * Snow.
 */
export function groundNormalAt(t, x, z, out, snow = false) {
    if (snow && t.waterLevelFt !== null && terrainHeightAt(t, x, z) < t.waterLevelFt) {
        out[0] = 0;
        out[1] = 1;
        out[2] = 0;
        return out;
    }
    const { row, col, fx, fz } = locate(x, z);
    const h00 = corner(t, row, col);
    const h01 = corner(t, row, col + 1);
    const h10 = corner(t, row + 1, col);
    const h11 = corner(t, row + 1, col + 1);
    // Slopes of the triangle's plane, dh/dx and dh/dz, per cell (32 ft).
    let sx, sz;
    if (cellSplitsMainDiagonal(row, col)) {
        if (fz < fx) {
            sx = h01 - h00;
            sz = h11 - h01;
        }
        else {
            sx = h11 - h10;
            sz = h10 - h00;
        }
    }
    else if (fz < 1 - fx) {
        sx = h01 - h00;
        sz = h10 - h00;
    }
    else {
        sx = h11 - h10;
        sz = h11 - h01;
    }
    const len = Math.hypot(sx, CELL_FT, sz);
    out[0] = -sx / len;
    out[1] = CELL_FT / len;
    out[2] = -sz / len;
    return out;
}
