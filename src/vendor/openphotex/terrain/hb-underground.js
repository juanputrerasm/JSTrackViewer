/*
  Hellbender's underground.

  Ported from JSTrackViewer's src/worker/hb-underground.js, which found the companion files and
  decoded them in one pass. This is the decoding half; the caller finds .RA2, .RA3 and .CL1
  beside the heightfield by stem.

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

  THE BIAS. The cavern grids are byte heightfields like the surface one, biased so that byte
  255 is altitude 0, the surface datum: an altitude of `value - 255`. HELLBEND.EXE's level
  loader (0x412c3e) stores every .RA2, .RA3, .RA4 and .RA5 byte as `(byte - 255) << 7`, against
  `byte << 7` for the surface grids, so the value is the engine's own. The data agrees: of the
  2,950 .DEF placements Hellbender authors at a negative altitude, 97% land between the floor
  and the ceiling of their own cell, and the 105 underground .NAV points agree at 104 of 105.
  An earlier reading measured the bias as 256, one step off, within that test's tolerance.

  HOLLOW CELLS. RA3 equals RA2 wherever there is no cavern, and that is most of the map:
  160,630 of 426,008 cells across the game are hollow, and KREASH has none at all while FLOAT,
  ROID, ROID2, ROID3 and SHIP are hollow everywhere. So the floor and ceiling meshes are
  masked to the hollow cells rather than covering the grid. The engine's cavern floor renderer
  (0x418d70) likewise skips a cell whose RA3 equals its RA2 at all four corners.

  WHICH HALF OF CL1 IS WHICH. CL1 holds two of the same texture words the .CLR uses. The
  engine settles the order: its cavern floor renderer (0x418d70) draws with the first word and
  its ceiling renderer (0x419230) with the second. The data agreed before the code was read:
  every texture whose name says ceiling or roof is in the second field (76 uses to 0), and the
  second field repeats the cell's own surface texture far more often than the first, as a
  shallow cavern roofed by the underside of the ground above it should.

  ONE OR TWO BYTES PER WORD. The loader decides each texture grid's width by its size: a .CLR
  of 0x4000 bytes on the 128 grid (one byte per cell), a .CL0/.CL2 of 0x18000 (one byte per
  face) or a .CL1 of 0x8000 (one byte per word) is read a byte at a time, each byte becoming a
  word with no mirror or rotation. No shipped level uses the narrow form, but it is legal.
*/
/** Altitude bias on the cavern grids, in heightfield steps. */
export const HB_UNDERGROUND_BIAS = -255;
/** Bytes per cell in each companion grid. */
const CL1_BYTES_PER_CELL = 4;
const CLR_BYTES_PER_CELL = 2;
/**
 * Decode a Hellbender cavern from its .RA2 (floor), .RA3 (ceiling) and .CL1 (textures).
 *
 * Returns null when the level has no cavern, or when the floor or ceiling grid is missing or
 * the wrong size; a viewer that loses this layer still draws the surface.
 */
export function decodeHbUnderground(ra2, ra3, cl1, gridSize) {
    const cells = gridSize * gridSize;
    const grid = (bytes, bytesPerCell) => (bytes && bytes.length >= cells * bytesPerCell ? bytes : null);
    const floorHeights = grid(ra2, 1);
    const ceilingHeights = grid(ra3, 1);
    // Two texture words per cell, each two bytes wide or, in the narrow form, one.
    const colourWidth = cl1 && cl1.length >= cells * CL1_BYTES_PER_CELL ? 2 : (cl1 && cl1.length >= cells * 2 ? 1 : 0);
    const colours = colourWidth ? cl1 : null;
    if (!floorHeights || !ceilingHeights)
        return null;
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
    if (!hollow)
        return null;
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
            if (hollowMask[i]) {
                mask[i] = 1;
                continue;
            }
            for (const [dx, dz] of NEIGHBOURS) {
                const nx = x + dx;
                const nz = z + dz;
                if (nx < 0 || nz < 0 || nx >= gridSize || nz >= gridSize)
                    continue;
                if (hollowMask[nx + nz * gridSize]) {
                    mask[i] = 1;
                    break;
                }
            }
        }
    }
    // CL1 interleaves the two texture words per cell; the mesh builder wants a plain .CLR grid,
    // so they are split here rather than teaching it a second layout.
    const floorClr = new Uint8Array(cells * CLR_BYTES_PER_CELL);
    const ceilingClr = new Uint8Array(cells * CLR_BYTES_PER_CELL);
    if (colours && colourWidth === 2) {
        for (let i = 0; i < cells; i++) {
            const src = i * CL1_BYTES_PER_CELL;
            const dst = i * CLR_BYTES_PER_CELL;
            floorClr[dst] = colours[src];
            floorClr[dst + 1] = colours[src + 1];
            ceilingClr[dst] = colours[src + 2];
            ceilingClr[dst + 1] = colours[src + 3];
        }
    }
    else if (colours) {
        for (let i = 0; i < cells; i++) {
            floorClr[i * CLR_BYTES_PER_CELL] = colours[i * 2];
            ceilingClr[i * CLR_BYTES_PER_CELL] = colours[i * 2 + 1];
        }
    }
    return { gridSize, hollowCellCount: hollow, mask, floorHeights, ceilingHeights, floorClr, ceilingClr };
}
/** A gap this small or smaller is the editor writing "solid", not a cavern. */
const MINIMUM_CAVERN_HEIGHT = 2;
/** The eight neighbours a quad's corner samples can reach into. */
const NEIGHBOURS = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
];
