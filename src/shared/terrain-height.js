/*
  Decoding one terrain RAW sample into a legacy height, in floating point.

  Every heightfield reader in the viewer - the mesh builder, its normals, the marker snap, the
  drive frame, the arena placement - goes through here, so that the grid's encoding is decided
  once and no reader can quietly disagree with the mesh it is sampling.

  The encodings, and why a 16-bit grid needs to say which one it is:

    MTM1 / MTM2 / TV / Fury3 / Hellbender
        one unsigned byte per cell, a whole legacy height step. No divisor.

    CART Precision Racing
        uint16 little-endian, 10.6 fixed point: height = raw16 / 64.0.
        Stock CPR terrain uses the low six bits almost everywhere (Laguna: 65,277 of 65,536
        cells), and the .TRK altitude it has to line up with keeps its fraction too
        (raw16 / 64 == trkAltitude / 4). Shifting the fraction away (`raw16 >>> 6`) floors
        the ground by up to 63/64 of a step under a road that is not floored.

    4x4 Evolution 1 / 2
        uint16 little-endian, 11.5 fixed point: height = raw16 / 32.0 (EVO_HEIGHT_DIVISOR in
        worker/evo/evo-coords.js).

  Both 16-bit formats are the same size and byte order and differ only in where the binary
  point sits, so the width of a cell cannot say which one a grid is. A loader that knows its
  format sets `heightDivisor` on the terrain descriptor; do not fold the two into one decoder
  keyed on byte width.

  Native units, then canonical ones.

  The viewer's canonical height is the MTM legacy step: 2 feet, drawn at heightScale scene
  units, which is also the scale BIN model geometry is drawn at (0.75 per model unit at the
  default heightScale 3). A CPR native step, raw16 / 64 == trkAltitude / 4, is 4 feet: CPR
  SIT and TRK altitudes are feet, exactly like an MTM SIT altitude. The proof is in the SIT
  files themselves. The editor drops every object so its lowest vertex touches the ground,
  and across Laguna, Mid-Ohio and Detroit that lift is -minZ / 8 CPR steps for every model,
  against -minZ / 4 MTM steps on MTM2 (Alaska): the same model depth, so one CPR step is two
  MTM steps. Decoding CPR at one step per native step drew its terrain, road and placements
  at half height against their own models, which buried every object by half its depth.

  So a descriptor carries two numbers: `heightDivisor`, the native fixed-point divisor, and
  `heightUnitScale`, canonical steps per native step (default 1). CPR is 64 and 2, Evo is 32
  and 1 in its own units, MTM has neither. The native value is exact and the unit scale is a
  power of two, so no precision is lost on the way.

  Quantisation belongs at an export boundary that demands it, never here.
*/

/** CPR terrain: uint16LE / 64.0, 10.6 fixed point, giving CPR native steps. */
export const CPR_HEIGHT_DIVISOR = 64;

/** CPR SIT/TRK altitude (feet) per CPR native step: trkAltitude / 4 == raw16 / 64. */
export const CPR_ALTITUDE_DIVISOR = 4;

/** Canonical (MTM, 2 ft) legacy steps per CPR native (4 ft) step. */
export const CPR_HEIGHT_UNIT_SCALE = 2;

/**
 * Feet of SIT or TRK altitude per canonical legacy step, for every SIT-family game.
 * For CPR this is CPR_ALTITUDE_DIVISOR / CPR_HEIGHT_UNIT_SCALE; for MTM1/MTM2 it is the
 * classic `/ 2`.
 */
export const LEGACY_ALTITUDE_DIVISOR = CPR_ALTITUDE_DIVISOR / CPR_HEIGHT_UNIT_SCALE;

/**
 * One RAW sample at byte offset `off`, as a legacy height.
 *
 * @param {Uint8Array} raw
 * @param {number} off            byte offset of the sample
 * @param {number} bytesPerCell   1 or 2
 * @param {number|null} heightDivisor  the 16-bit encoding's fixed-point divisor, if known
 * @param {number} [heightUnitScale]   canonical steps per native step, default 1
 */
export function decodeHeightSample(raw, off, bytesPerCell, heightDivisor, heightUnitScale = 1) {
  if (bytesPerCell === 1) return raw[off] ?? 0;
  const raw16 = (raw[off] ?? 0) | ((raw[off + 1] ?? 0) << 8);
  if (heightDivisor) return (raw16 / heightDivisor) * (heightUnitScale || 1);
  return legacyWholeHeight16(raw16);
}

/**
 * Compatibility reading for a 16-bit grid whose loader declared no encoding.
 *
 * This is the JTraxx `sampleLegacyHeightWhole` rule: a zero high byte is taken as an 8-bit
 * height stored two bytes wide, anything else as 10.6 fixed point floored to a whole step.
 * It discards precision and exists only so an undeclared grid builds as it always has; CPR and
 * Evo both declare a divisor and never reach it.
 */
export function legacyWholeHeight16(raw16) {
  if (raw16 < 256) return raw16;
  return raw16 >>> 6;
}

/**
 * The legacy height at grid corner (cx, cz), clamped to the grid.
 *
 * @param {object} terrain  { gridSize, rawBytesPerCell, heightDivisor, heightUnitScale }
 * @param {Uint8Array} raw
 */
export function heightAtCell(terrain, raw, cx, cz) {
  if (!raw) return 0;
  const gridSize = terrain?.gridSize ?? 256;
  const x = cx < 0 ? 0 : (cx > gridSize - 1 ? gridSize - 1 : cx);
  const z = cz < 0 ? 0 : (cz > gridSize - 1 ? gridSize - 1 : cz);
  const bytesPerCell = terrain?.rawBytesPerCell ?? 1;
  return decodeHeightSample(raw, (x + z * gridSize) * bytesPerCell, bytesPerCell,
                            terrain?.heightDivisor ?? null, terrain?.heightUnitScale ?? 1);
}
