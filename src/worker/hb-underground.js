import { resolveAsset } from "./pod-format.js";
import { archiveTitle, normalizeArchiveName, replaceExtension } from "../shared/path-utils.js";

/*
  Hellbender's underground.

  A Hellbender level is not two levels. Terminal Velocity and Fury3 put their interiors in
  separate .LVL files and name them from a .TDF; Hellbender's underground is the same level,
  on the same 128-square grid, in the same .DEF and .NAV, distinguished only by altitude. What
  makes it drawable is six companion files the level never names - they are found by stem,
  the way .RA0/.RA1/.CL0 already are - which describe a second world beneath the first:

    RAW  1 B/cell   surface heightfield                    (already drawn)
    CLR  2 B/cell   surface texture per cell               (already drawn)
    RA0  1 B/cell   surface ground-box lower bound         (already drawn)
    RA1  1 B/cell   surface ground-box upper bound         (already drawn)
    CL0  12 B/cell  surface ground-box face textures       (already drawn)

    RA2  1 B/cell   cavern FLOOR heightfield
    RA3  1 B/cell   cavern CEILING heightfield
    CL1  4 B/cell   cavern floor texture, then ceiling texture
    RA4  1 B/cell   cavern ground-box lower bound
    RA5  1 B/cell   cavern ground-box upper bound
    CL2  12 B/cell  cavern ground-box face textures

  All eleven are exactly these sizes in all 26 shipped levels, with no exceptions.

  THE BIAS. The cavern grids are byte heightfields like the surface one, but they are biased
  down by a full byte: an altitude of `value - 256`. That is measured, not assumed. Of the
  2,950 .DEF placements Hellbender authors at a negative altitude - the ones the viewer used
  to hide outright - 2,862, or 97%, land between `RA2 - 256` and `RA3 - 256` at their own
  cell, with 21 below the floor, 7 above the ceiling and 60 in cells the layer says are solid.
  The 105 underground .NAV points agree at 104 of 105. Nothing else fits: against the raw
  unbiased grids the same placements miss by a median of 255 altitude steps.

  HOLLOW CELLS. RA3 equals RA2 wherever there is no cavern, and that is most of the map:
  160,630 of 426,008 cells across the game are hollow, and KREASH has none at all while FLOAT,
  ROID, ROID2, ROID3 and SHIP are hollow everywhere. So the floor and ceiling meshes are
  masked to the hollow cells rather than covering the grid.

  WHICH HALF OF CL1 IS WHICH. CL1 holds two of the same 2-byte texture words the .CLR uses,
  and the file does not label them. Three independent signals put the floor first:

    - every texture whose name says ceiling or roof is in the second field, 76 uses to 0;
    - textures whose name says floor lean the other way, 2,451 uses in the first field to
      1,976 in the second;
    - the second field repeats that cell's own SURFACE texture in 54,281 of 160,630 hollow
      cells, against 10,453 for the first, which is what a shallow cavern roofed by the
      underside of the ground above it should look like.

  A fourth test, whether each field is better predicted by the floor height or the ceiling
  height, came out too close to call either way and is not counted. So this is a strong
  reading rather than a proven one, and swapping the two would cost a texture swap and
  nothing structural.
*/

/** Altitude bias on the cavern grids, in heightfield steps. */
export const HB_UNDERGROUND_BIAS = -256;

/** Bytes per cell in each companion grid. */
const CL1_BYTES_PER_CELL = 4;
const CLR_BYTES_PER_CELL = 2;

/**
 * Reads a Hellbender level's cavern layers.
 *
 * Returns null when the level has no cavern, when a companion file is missing, or when one is
 * the wrong size - a viewer that loses this layer still draws the surface.
 */
export function loadUndergroundLayers(podIndex, getBytes, rawName, gridSize) {
  const cells = gridSize * gridSize;
  const grid = (ext, bytesPerCell) => {
    const entry = resolveDataAsset(podIndex, replaceExtension(rawName, ext));
    if (!entry) return null;
    const bytes = getBytes(entry);
    return bytes.length >= cells * bytesPerCell ? bytes : null;
  };

  const floorHeights = grid(".RA2", 1);
  const ceilingHeights = grid(".RA3", 1);
  const colours = grid(".CL1", CL1_BYTES_PER_CELL);
  if (!floorHeights || !ceilingHeights) return null;

  /*
    The mask, and the reason it is not simply `ceiling > floor`.

    A one-step gap is the editor's way of writing "solid" in a level that still has to store a
    number, and HOTH3 is the case that shows it: every one of its 6,425 non-equal cells has a
    gap of exactly 2 and the level has no underground section at all. Requiring a real gap
    keeps a sliver of z-fighting geometry out of every such level.
  */
  const hollowMask = new Uint8Array(cells);
  let hollow = 0;
  for (let i = 0; i < cells; i++) {
    if (ceilingHeights[i] - floorHeights[i] > MINIMUM_CAVERN_HEIGHT) {
      hollowMask[i] = 1;
      hollow++;
    }
  }
  if (!hollow) return null;

  /*
    The mask is grown by one cell, and that is what closes the cavern.

    A cavern needs walls where it meets solid rock, and Hellbender authors none: of the 24,963
    hollow-to-solid boundary edges in the shipped game, only 7% have a cavern ground box on the
    hollow side and 5% on the solid side, so the boxes are furniture rather than walls.

    They are not needed. In a solid cell the ceiling grid equals the floor grid, so the two
    surfaces meet there exactly. Including the ring of solid cells around each cavern lets the
    floor rise and the ceiling drop into that seam, and the volume closes itself out of the
    same two heightfields - no wall geometry, and no guess about what a wall should look like.
    Masking to the hollow cells alone leaves the cavern open to the sky at every edge.
  */
  const mask = new Uint8Array(cells);
  for (let z = 0; z < gridSize; z++) {
    for (let x = 0; x < gridSize; x++) {
      const i = x + z * gridSize;
      if (hollowMask[i]) { mask[i] = 1; continue; }
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= gridSize || nz >= gridSize) continue;
        if (hollowMask[nx + nz * gridSize]) { mask[i] = 1; break; }
      }
    }
  }

  // CL1 interleaves the two texture words per cell; the mesh builder wants a plain .CLR grid,
  // so they are split here rather than teaching it a second layout.
  const floorClr = new Uint8Array(cells * CLR_BYTES_PER_CELL);
  const ceilingClr = new Uint8Array(cells * CLR_BYTES_PER_CELL);
  if (colours) {
    for (let i = 0; i < cells; i++) {
      const src = i * CL1_BYTES_PER_CELL;
      const dst = i * CLR_BYTES_PER_CELL;
      floorClr[dst] = colours[src];
      floorClr[dst + 1] = colours[src + 1];
      ceilingClr[dst] = colours[src + 2];
      ceilingClr[dst + 1] = colours[src + 3];
    }
  }

  return { gridSize, hollowCellCount: hollow, mask, floorHeights, ceilingHeights, floorClr, ceilingClr };
}

/** A gap this small or smaller is the editor writing "solid", not a cavern. */
const MINIMUM_CAVERN_HEIGHT = 2;

/** The eight neighbours a quad's corner samples can reach into. */
const NEIGHBOURS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

function resolveDataAsset(podIndex, name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized) return null;
  if (/[\\/]/.test(normalized)) return resolveAsset(podIndex, normalized);
  const title = archiveTitle(normalized);
  return resolveAsset(podIndex, "DATA/" + title) ?? resolveAsset(podIndex, normalized);
}
