/*
  Terminal Velocity and Fury3 chambers: rooms inside the rock, roofed by a mirrored copy of
  their own floor.

  The engine (TV GAME.EXE 0x3d0a0 and 0x3d5e0, Fury3 0x43f3d0; docs/TV_GAME_EXE_ANALYSIS.md 2.3)
  builds no geometry for a chamber's roof. It is derived from the heightfield:

    - a floor sample of height h has a ceiling sample at 255 + (255 - h) = 510 - h, facing down,
      so where the floor reaches 255 at the chamber wall the ceiling comes down to 255 too and
      the room closes itself;
    - the ceiling of cell (cx, cz) is textured with the .CLR word of cell (cx + 10, cz), which is
      what the F!Zone manual means by "ten squares to the right";
    - the engine switches to drawing chambers when the camera is below altitude 255 and there is
      solid rock 7 cells away on all four axes, so a chamber is a hollow enclosed by rock within
      7 cells in each direction.

  Altitude 255 is solid rock: a cell whose four corners are all 255 is a rock top, which the
  game never draws (0x3caf0 skips such a triangle), and which the viewer can hide (rockCells)
  to look down into the chambers from above.

  The viewer draws every chamber at once, rather than the 15 x 15 window around the camera the
  engine draws, so the test is made per cell: a cell is a chamber cell when it is not rock and
  each of the four axis directions reaches a rock cell within 7 cells.
*/

/** How far the engine looks for rock in each axis direction. */
const CHAMBER_REACH = 7;

/** The .CLR column offset a ceiling takes its texture from. */
const CEILING_TEXTURE_OFFSET = 10;

const ROCK = 255;

/**
 * The chamber layer of a TV-family heightfield, or null when the level has none. Returns the
 * ceiling as a 16-bit grid (heights 255..510 do not fit a byte), its texture grid, the cells to
 * draw, and every rock-top cell.
 */
export function buildTvChambers(terrain) {
  const gridSize = terrain?.gridSize ?? 256;
  const raw = terrain?.rawData;
  const cells = gridSize * gridSize;
  if (!raw || raw.length < cells || (terrain.rawBytesPerCell ?? 1) !== 1) return null;

  const at = (x, z) => raw[Math.min(gridSize - 1, Math.max(0, x)) + Math.min(gridSize - 1, Math.max(0, z)) * gridSize];
  const rock = new Uint8Array(cells);
  const rockCells = [];
  for (let z = 0; z < gridSize; z++) {
    for (let x = 0; x < gridSize; x++) {
      if (at(x, z) === ROCK && at(x + 1, z) === ROCK && at(x + 1, z + 1) === ROCK && at(x, z + 1) === ROCK) {
        rock[x + z * gridSize] = 1;
        rockCells.push(x + z * gridSize);
      }
    }
  }
  if (!rockCells.length) return null;

  const rockWithin = (x, z, dx, dz) => {
    for (let k = 1; k <= CHAMBER_REACH; k++) {
      const nx = x + dx * k, nz = z + dz * k;
      if (nx < 0 || nz < 0 || nx >= gridSize || nz >= gridSize) return false;
      if (rock[nx + nz * gridSize]) return true;
    }
    return false;
  };
  const mask = new Uint8Array(cells);
  let chamberCells = 0;
  for (let z = 0; z < gridSize; z++) {
    for (let x = 0; x < gridSize; x++) {
      const cell = x + z * gridSize;
      if (rock[cell]) continue;
      if (rockWithin(x, z, 1, 0) && rockWithin(x, z, -1, 0) && rockWithin(x, z, 0, 1) && rockWithin(x, z, 0, -1)) {
        mask[cell] = 1;
        chamberCells++;
      }
    }
  }

  // 510 - h for every sample, as a little-endian 16-bit grid read with divisor 1.
  const ceiling = new Uint8Array(cells * 2);
  for (let i = 0; i < cells; i++) {
    const h = 2 * ROCK - raw[i];
    ceiling[2 * i] = h & 0xff;
    ceiling[2 * i + 1] = h >> 8;
  }

  // The ceiling's texture: the .CLR word ten cells along the row, wrapping.
  const clr = terrain.clrData;
  const clrBytes = terrain.clrBytesPerCell ?? 2;
  const ceilingClr = new Uint8Array(cells * 2);
  if (clr && clr.length >= cells * clrBytes) {
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        const src = ((x + CEILING_TEXTURE_OFFSET) % gridSize) + z * gridSize;
        const dst = (x + z * gridSize) * 2;
        ceilingClr[dst] = clr[src * clrBytes];
        ceilingClr[dst + 1] = clrBytes === 2 ? clr[src * clrBytes + 1] : 0;
      }
    }
  }

  return {
    ceilingHeights: ceiling,
    ceilingClr,
    mask: chamberCells ? mask : null,
    chamberCells,
    rockCells: Uint32Array.from(rockCells),
  };
}
