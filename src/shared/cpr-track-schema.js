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
  CRaceTrack::makeWallList would have to be disassembled to read them. 9 feet is derived from
  the art instead. Wall panel RAWs are 256x64 per strip, and Laguna averages
  11816.64 / 331 = 35.7 feet per segment, so a panel that spans one segment at the texture's
  own 4:1 aspect is 8.9 feet tall. That also matches what a trackside advertising hoarding
  actually is.

  Treat this as calibrated rather than known. It is the one number in this file that is not
  read off the data.
*/
export const CPR_WALL_PART_HEIGHT_FT = 9;

/*
  A CPR track point is in feet. The viewer places it with x and z scaled by 2 world units per
  foot, and altitude scaled by heightScale/zDivisor. Wall heights have to use the altitude
  transform so they stay consistent with the track surface when the height slider moves.
*/
export function cprFeetToWorldY(feet, heightScale, zDivisor) {
  return (feet * (heightScale ?? 3)) / (zDivisor || 2);
}
