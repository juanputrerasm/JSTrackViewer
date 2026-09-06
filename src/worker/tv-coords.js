/*
  TV-family world coordinates.

  Terminal Velocity, Fury3 and F!Zone store every map position the same way, in .DEF object
  placements, .NAV navigation points, .PUP powerup drops and .TDF tunnel mouths alike:

    X, Z  horizontal, 2^20 units per terrain cell, signed, wrapping on the 256-cell map
    Y     height, 2^15 units per altitude step (the 0..255 range of the .RAW heightfield)

  Both scales are measured, not assumed. Sampling FURY3.POD's ATMOS level at
  ((x >> 20) % 256, (z >> 20) % 256) gives a terrain height that equals (y >> 15) exactly, for
  every placement in the file, and each .NAV target list's position matches the placement of
  the enemy it names to the unit.

  That second fact is why the definition Y offset matters (see def-loader.js): placements are
  authored flush with the ground, so nothing in a placement record can lift an object.
*/

/** Horizontal units per terrain cell. */
export const TV_UNITS_PER_CELL = 1 << 20;

/** Vertical units per heightfield altitude step. */
export const TV_UNITS_PER_HEIGHT_STEP = 1 << 15;

/** Editor world units per terrain cell, matching CELL_SIZE in terrain-builder. */
const EDITOR_CELL_SIZE = 64;

/**
 * Converts a raw TV-family (x, y, z) triple to the viewer's editor-space [x, y, altitude].
 *
 * Coordinates are frequently negative in shipped content, so the horizontal wrap is required
 * rather than defensive. Positions land on cell centres, which is where the editor placed
 * them: everything in these files is positioned per square.
 */
export function tvPlacementToEditor(x, y, z, gridSize) {
  const g = gridSize > 0 ? gridSize : 256;
  const gx = Math.floor(x / TV_UNITS_PER_CELL);
  const gz = Math.floor(z / TV_UNITS_PER_CELL);
  const wrappedX = ((gx % g) + g) % g;
  const wrappedZ = ((gz % g) + g) % g;
  return [
    wrappedX * EDITOR_CELL_SIZE + EDITOR_CELL_SIZE / 2,
    wrappedZ * EDITOR_CELL_SIZE + EDITOR_CELL_SIZE / 2,
    tvHeightToAltitude(y),
  ];
}

/** Converts a raw TV-family Y to a heightfield altitude step. */
export function tvHeightToAltitude(y) {
  return Math.max(0, Math.floor(y / TV_UNITS_PER_HEIGHT_STEP));
}

/** Splits a comma-separated integer triple, or null when the line is not one. */
export function parseIntTriple(line) {
  const parts = String(line ?? "").split(",");
  if (parts.length < 3) return null;
  const out = [];
  for (let i = 0; i < 3; i++) {
    const v = parseInt(parts[i].trim(), 10);
    if (Number.isNaN(v)) return null;
    out.push(v);
  }
  return out;
}

/*
  Splits a side file into trimmed lines.

  These files are CRLF and many end with a DOS EOF (0x1A) on its own line, which is padding
  rather than data. Stripping it here keeps every caller from having to know.
*/
export function toDataLines(bytes) {
  return new TextDecoder("latin1")
    .decode(bytes)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\x1a/g, "").trim());
}
