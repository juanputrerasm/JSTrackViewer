/*
  CART Precision Racing track layer schema.

  The format knowledge (point and slot names, wall types and stacking, texture references,
  closed circuits, visible slots, courses and checkpoint roles) is OpenPhotex's, in
  src/cpr/track.ts, and is re-exported here. What stays is how this viewer places and labels
  it. See docs/CPR_TRACK_LAYER_ANALYSIS.md for the full derivation.
*/
export {
  CPR_POINT_NAMES, CPR_SLOT_OFF_TRACK, CPR_SLOT_CURB, CPR_SLOT_ROAD, CPR_SLOT_NAMES, CPR_CROSS_SECTION_MIDPOINT,
  CPR_SURFACE_TYPES, CPR_WALL_TYPE_NAMES, CPR_TEXTURE_INDEX_MASK, CPR_TEXTURE_SLICE_COUNT, cprTextureIndex,
  cprTextureSlice, cprTextureU, CPR_WALL_LAYERS, isDegenerateSlot, cprTrackIsClosed, cprSegmentPairs,
  cprVisibleSlots, CPR_COURSE_PURPOSES, CPR_CHECKPOINT_ROLES, cprCheckpointRole, isCprPitCheckpoint,
} from "../vendor/openphotex/index.js";

/*
  Height of one wall panel, in feet.

  Not recoverable from the strings: the real values are hardcoded in the engine, and
  CRaceTrack::makeWallList would have to be disassembled to read them.

  4.5 feet is calibrated against the original game. The first estimate was 9 feet, from the
  art: wall panel RAWs are 256x64 per strip and Laguna averages 11816.64 / 331 = 35.7 feet per
  segment, so a panel spanning one segment at the texture's 4:1 aspect would be 8.9 feet.
  That looked right only while CPR altitude was converted at half scale (`/ 4` into 2 ft
  steps), which drew a 9 ft panel at 4.5 ft. Once altitude moved to its true `/ 2`, walls came
  out twice as tall as in-game screenshots of Laguna, so a panel does not span one segment at
  the texture's own aspect; it is half that height.

  Treat this as calibrated rather than known. It is the one number in this file that is not
  read off the data.
*/
export const CPR_WALL_PART_HEIGHT_FT = 4.5;

/*
  A CPR track point is in feet. The viewer places it with x and z scaled by 2 world units per
  foot, and altitude scaled by heightScale/zDivisor. Wall heights have to use the altitude
  transform so they stay consistent with the track surface when the height slider moves.
*/
export function cprFeetToWorldY(feet, heightScale, zDivisor) {
  return (feet * (heightScale ?? 3)) / (zDivisor || 2);
}

/**
 * A .TRK point [x, altitude, along] in scene units: the transform the road layer is drawn with.
 * Horizontal keeps the historical truncation to whole feet; altitude is feet over zDivisor.
 */
export function cprPointToScene(point, heightScale, worldSize, zDivisor) {
  if (!point || point.length < 3) return [0, 0, 0];
  const wx = 2 * Math.trunc(point[0]);
  const wy = 2 * Math.trunc(point[2]);
  return [wx, (point[1] / zDivisor) * heightScale, worldSize - wy];
}

/** On-screen labels for the CPR checkpoint roles (cprCheckpointRole). */
export const CPR_CHECKPOINT_LABELS = {
  pitEntry: "PIT ENTRY",
  pitSpeedLimit: "PIT LIMIT",
  pitSpeedLimitEnd: "PIT LIMIT END",
  startFinish: "S/F",
};
