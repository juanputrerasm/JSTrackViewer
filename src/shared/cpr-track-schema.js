/*
  CART Precision Racing track layer schema.

  A CPR track is not a free-form mesh. It is a fixed 20 point cross section extruded along up
  to 700 segments. Every point and every section between two points has a fixed role, and the
  track editor names them on screen.

  Everything in this file is transcribed from the string tables in CPREDIT.EXE (the
  "Demented(R) Track Editor(TM)") and cross-checked against DATA\LAGUNA.TRK extracted from
  LAGUNA.POD. See docs/CPR_TRACK_LAYER_ANALYSIS.md for the full derivation.
*/

/*
  The 20 cross section point names, CPREDIT.EXE 0x1ac990. These are what the wall editor
  prints for its "Section : %s" line. Every CPR track record has pointCount 20 and
  segmentCount 19, so this table is a hard invariant rather than a heuristic.

  The layout is a mirrored double carriageway: a Main band on each side of a Pit grass
  median. A segment with no pit lane collapses one band to zero width by repeating its
  points, which is why plist is full of duplicated coordinates.
*/
export const CPR_POINT_NAMES = [
  "Left unused 1",
  "Left unused 2",
  "Left tree",
  "Left shoulder",
  "Left shoulder/Curb",
  "Curb/Main",
  "Main",
  "Main/Pit curb",
  "Pit curb/Pit grass",
  "Pit grass",
  "Pit grass",
  "Pit grass/Pit curb",
  "Pit curb/Main",
  "Main",
  "Main/Curb",
  "Curb/Right shoulder",
  "Right shoulder",
  "Right tree",
  "Right unused 1",
  "Right unused 2",
];

/*
  Structural role of each of the 19 sections, which is the per-segment `type` array in the
  TRK. Measured across all 331 Laguna segments the distribution is {0: 3641, 1: 1324,
  2: 1324}, i.e. exactly four curb slots and four road slots per segment, and they land on
  the sections the names above call curbs and Main.

  This is the slot role, NOT the painted surface type. The painted surface type lives in the
  second column of the .TTX, see CPR_SURFACE_TYPES.
*/
export const CPR_SLOT_OFF_TRACK = 0;
export const CPR_SLOT_CURB      = 1;
export const CPR_SLOT_ROAD      = 2;

export const CPR_SLOT_NAMES = ["Off track", "Curb", "Road"];

/*
  The mirror axis of the cross section, between the two "Pit grass" points at 9 and 10.

  Points 0..9 are the left half and points 10..19 the right half, so a wall below the
  midpoint looks at the track on its right (toward increasing pointOffset) and a wall at or
  above it looks left. That is what decides which face of a wall is ever seen.
*/
export const CPR_CROSS_SECTION_MIDPOINT = 10;

/*
  Painted surface type, CPREDIT.EXE 0x1acafa. Cycled with `t` in the track texture editor and
  stored once per texture, not per section, which is why it lives in the .TTX and not the
  .TRK. Arne Martin's guide calls index 3 "sand"; the editor itself says Dirt.
*/
export const CPR_SURFACE_TYPES = ["Road", "Curb", "Grass", "Dirt", "Rocks"];

/*
  Wall types, CPREDIT.EXE 0x1aca99. These are the values stored in the TRK `wallType` array
  and they are exactly the 1..7 the guide documents against the number keys in the wall
  editor, with 0 meaning no wall.
*/
export const CPR_WALL_TYPE_NAMES = [
  "None.",
  "Short wall",
  "Tall wall",
  "Short wall with catch fencing",
  "Very tall",
  "Wall-catch-wall",
  "Wall med",
  "Tree",
];

/*
  A packed texture reference, used by both `!texture` (road) and `wallTexture` (walls).

    bits 0..11   index into the .TTX texture list
    bits 12..13  which of the 4 sub textures inside that RAW

  The guide states the second field outright: "each raw-file containing wall-textures contain
  4 textures. To change between the four use R." Rendering LG4SIGN1.RAW and LG4SIGN5.RAW from
  LAGUNA.POD shows the four are stacked VERTICALLY as 256x64 strips, one advertising panel
  each, not side by side.
*/
export const CPR_TEXTURE_INDEX_MASK = 0x0fff;
export const CPR_TEXTURE_SLICE_COUNT = 4;

export function cprTextureIndex(value) {
  return (value ?? 0) & CPR_TEXTURE_INDEX_MASK;
}

export function cprTextureSlice(value) {
  return ((value ?? 0) >> 12) & (CPR_TEXTURE_SLICE_COUNT - 1);
}

/*
  Section texture coordinates.

  Every `!texture` line is `index,u1,u2,u3,u4`, and CPREDIT.EXE prints them back as
  "u1: %f, u2: %f, u3: %f, u4: %f". They are 16.16 fixed point over a 0..256 space, so the
  overwhelmingly common (262144, 16384000, 262144, 16384000) decodes to
  (0.0156, 0.9766, 0.0156, 0.9766): map the texture once across the section, inset two pixels
  at each edge so bilinear filtering does not bleed the neighbouring column.

  This matters because the road textures are half-carriageway tiles with the white edge line
  baked into one side (RD4A on the left, RD4B on the right). Tiling U by world width repeats
  that line across the road surface instead of leaving it at the edge.
*/
export function cprTextureU(fixed) {
  return (fixed ?? 0) / 65536 / 256;
}

/*
  How a wall of each type is stacked.

  The guide says "On walls higher than short wall you can change which part of the wall you
  want to apply texture to by pressing W", and wallTexture stores exactly four parts per
  point. Which of those four are actually authored is measurable: for a given wall type, a
  part that is meaningful varies from wall to wall, and a part that is leftover collapses
  onto a single default value (4103 at Laguna). Counting distinct values per part across
  LAGUNA.TRK gives:

    type 1 Short wall                     part 0 authored, 1..3 collapse   -> 1 part
    type 3 Short wall with catch fencing  part 0 authored, 1..3 collapse   -> 1 part + fence
    type 6 Wall med                       parts 0,1 authored               -> 2 parts
    type 2 Tall wall                      parts 0,1,2 authored             -> 3 parts
    type 4 Very tall                      all four authored                -> 4 parts
    type 5 Wall-catch-wall                parts 0,1 authored, 2,3 leftover -> wall, fence, wall

  which is self-consistent with the editor's own names, and the "Wall-catch-wall" name pins
  down where the fence sits in type 5.

  The catch fencing itself is never one of those four textures. CPREDIT.EXE references
  art\catch3d.raw and art\catch.raw directly, both ship in STARTUP.POD, and neither ever
  appears in a .TTX. The fence is implied by the wall type.

  `units` is a multiple of CPR_WALL_PART_HEIGHT_FT. The guide's only statement about tree
  walls is that one is "about three times higher than the tall wall", hence 9 units against
  the tall wall's 3.
*/
export const CPR_WALL_LAYERS = {
  1: [{ part: 0, units: 1 }],
  2: [{ part: 0, units: 1 }, { part: 1, units: 1 }, { part: 2, units: 1 }],
  3: [{ part: 0, units: 1 }, { fence: true, units: 2 }],
  4: [{ part: 0, units: 1 }, { part: 1, units: 1 }, { part: 2, units: 1 }, { part: 3, units: 1 }],
  5: [{ part: 0, units: 1 }, { fence: true, units: 2 }, { part: 1, units: 1 }],
  6: [{ part: 0, units: 1 }, { part: 1, units: 1 }],
  7: [{ part: 0, units: 9 }],
};

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

/*
  Whether a cross section slot is collapsed to zero width on this segment.

  pointOffset is the lateral offset of each point from the centreline, in feet, and is the
  direct answer. At Laguna segment 0 it runs -48, -48, -48, -36, -24, -24, 0, 24 ... so the
  two Left unused slots and every pit slot are flat against their neighbour.

  Falling back to comparing the world positions covers a track whose pointOffset block failed
  to parse, since a collapsed slot repeats its coordinates in plist as well.
*/
export function isDegenerateSlot(surface, lane) {
  const offsets = surface.pointOffsets;
  if (offsets && offsets.length > lane + 1) return offsets[lane] === offsets[lane + 1];
  const points = surface.points ?? [];
  const a = points[lane];
  const b = points[lane + 1];
  if (!a || !b) return true;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** The centreline of a cross section, halfway between the two mirror points 9 and 10. */
function sectionCentre(surface) {
  const points = surface?.points ?? [];
  const a = points[CPR_CROSS_SECTION_MIDPOINT - 1] ?? points[0];
  const b = points[CPR_CROSS_SECTION_MIDPOINT] ?? a;
  if (!a || !b) return null;
  return [(a[0] + b[0]) / 2, (a[2] + b[2]) / 2];
}

/*
  Whether a track is a closed circuit, so its last segment runs on into its first.

  The .TRK stores one record per segment and each record owns the stretch from itself to the
  next, so the last record's stretch, back to record 0, has no following record to reach and
  was never drawn: a one-segment hole at the start/finish line. Nothing in the file says
  "closed". Every stock track is, though, and all 17 end one ordinary segment short of their
  start (Laguna: 30.0 ft, against a median segment of 35.8 ft and a longest of 108.8 ft;
  Rio, the widest, 59.9 ft against a longest of 56.5 ft).

  So a track counts as closed when the gap from its last section back to its first is no
  longer than 1.5 times its own longest segment, and runs the same way the track does, which
  keeps a point-to-point layout whose ends happen to lie near each other from being joined
  across. A last section sitting ON the first needs no closing segment.
*/
export function cprTrackIsClosed(surfaces) {
  const n = surfaces?.length ?? 0;
  if (n < 3) return false;
  const centres = surfaces.map(sectionCentre);
  if (centres.some((c) => !c)) return false;

  let longest = 0;
  for (let i = 0; i + 1 < n; i++) {
    const length = Math.hypot(centres[i + 1][0] - centres[i][0], centres[i + 1][1] - centres[i][1]);
    if (length > longest) longest = length;
  }
  const last = centres[n - 1];
  const gapX = centres[0][0] - last[0];
  const gapZ = centres[0][1] - last[1];
  const gap = Math.hypot(gapX, gapZ);
  if (gap < 1 || gap > longest * 1.5) return false;

  const dirX = last[0] - centres[n - 2][0];
  const dirZ = last[1] - centres[n - 2][1];
  return dirX * gapX + dirZ * gapZ > 0;
}

/**
 * The [from, to] record pairs whose stretch is drawn, in order: each record to the next, plus
 * the last back to the first on a closed circuit. The scene and the drive colliders both build
 * from this, so what is drawn and what is solid cannot disagree.
 */
export function cprSegmentPairs(surfaces) {
  const n = surfaces?.length ?? 0;
  const pairs = [];
  for (let i = 0; i + 1 < n; i++) pairs.push([i, i + 1]);
  if (cprTrackIsClosed(surfaces)) pairs.push([n - 1, 0]);
  return pairs;
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

/*
  The cross section slots the game actually draws: everything between the outermost wall on
  each side, and nothing beyond.

  A record keeps its full 20 point section, including the tree and unused slots outside the
  shoulder walls (Laguna segment 0 has 12 ft of "Left tree" to "Left shoulder" beyond its left
  wall), and CPR's renderer never shows them: in the game the track layer stops dead at its
  walls, with the terrain taking over behind. So a slot is drawn only when it lies on the
  road side of both walls. The left half's walls are points below CPR_CROSS_SECTION_MIDPOINT
  and the outermost one is the lowest index; the right half's are the rest and the outermost
  is the highest. A side with no wall is drawn out to its last slot, as before.

  Slot `lane` runs from point `lane` to point `lane + 1`, so the left clip drops slots below
  the wall point and the right clip drops slots from the wall point on. Walls come from the
  owning record, the same one that decides whether a wall is drawn.

  @returns {{ first: number, last: number }} inclusive slot range; empty when first > last
*/
export function cprVisibleSlots(surface) {
  const pointCount = surface?.points?.length ?? 0;
  const walls = surface?.wallTypes ?? [];
  let first = 0;
  let last = pointCount - 2;
  for (let point = 0; point < CPR_CROSS_SECTION_MIDPOINT && point < pointCount; point++) {
    if (CPR_WALL_LAYERS[walls[point] ?? 0]) { first = point; break; }
  }
  for (let point = pointCount - 1; point >= CPR_CROSS_SECTION_MIDPOINT; point--) {
    if (CPR_WALL_LAYERS[walls[point] ?? 0]) { last = point - 1; break; }
  }
  return { first, last };
}

/*
  What each of a CPR track's five courses is for (docs/CPREDIT_GUIDE.md, "E, course editor").
  Courses are the AI's paths, chains of straight segments the game joins with constant radius
  curves. `lap` says whether the course closes into a full lap; course 4 is only pit row.
*/
export const CPR_COURSE_PURPOSES = [
  { name: "AI line 1", detail: "racing line, full lap", lap: true },
  { name: "AI line 2", detail: "racing line, full lap", lap: true },
  { name: "AI line 3", detail: "racing line, full lap", lap: true },
  { name: "Pit road", detail: "full lap through pit entry and exit, right of pit row", lap: true },
  { name: "Pit row", detail: "pit stalls only, not a lap, left of pit row", lap: false },
];

/*
  The role of each CPR checkpoint, from its place in the file.

  CPREDIT's guide lists what a track's 4 to 7 checkpoints are: start and finish, pit speed
  limit start, pit lane start, pit speed limit end, and the rest ordinary. All 17 stock
  tracks put them in the same order. The first three sit in the pit lane: 0 on the pit entry
  road, 1 where pit row begins and 2 where it ends, between 61 and 248 ft off the racing line
  on every track. 3 is the start and finish, on the circuit beside pit row and the grid.
  4 and up are ordinary gates out on the circuit, 486 ft or more from pit row. A lap runs
  from 3 through the ordinary gates back to 3; the pit gates are not part of it.

  A track with fewer than the four the guide requires is read as plain gates.
*/
export const CPR_CHECKPOINT_ROLES = ["pitEntry", "pitSpeedLimit", "pitSpeedLimitEnd", "startFinish"];

export const CPR_CHECKPOINT_LABELS = {
  pitEntry: "PIT ENTRY",
  pitSpeedLimit: "PIT LIMIT",
  pitSpeedLimitEnd: "PIT LIMIT END",
  startFinish: "S/F",
};

export function cprCheckpointRole(sequence, count) {
  if (count < CPR_CHECKPOINT_ROLES.length) return "gate";
  return CPR_CHECKPOINT_ROLES[sequence] ?? "gate";
}

export function isCprPitCheckpoint(role) {
  return role === "pitEntry" || role === "pitSpeedLimit" || role === "pitSpeedLimitEnd";
}
