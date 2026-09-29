/*
  CART Precision Racing's track layer: the .TRK road surface, its .TTX texture list, and the
  schema that names what every slot, wall and texture reference means.

  A CPR track is not a free-form mesh. It is a fixed 20 point cross section extruded along up
  to 700 segments. Every point and every section between two points has a fixed role, and the
  track editor names them on screen.

  The tables are transcribed from the string tables in CPREDIT.EXE (the "Demented(R) Track
  Editor(TM)") and cross-checked against DATA\LAGUNA.TRK extracted from LAGUNA.POD. Ported from
  JSTrackViewer's src/shared/cpr-track-schema.js and src/worker/racetrack-loader.js; the scene
  transforms and the calibrated wall height stay in the viewer.
*/
import { normalizePodPath } from "../pod/paths.js";
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
export const CPR_SLOT_CURB = 1;
export const CPR_SLOT_ROAD = 2;
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
  appears in a .TTX. The fence is implied by the wall type (see CPR_CATCH_FENCE_NAMES).

  The guide's only statement about tree walls is that one is "about three times higher than
  the tall wall", hence 9 units against the tall wall's 3.
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
  The catch fence texture, in preference order. CATCH3D is the 256x256 hardware-accelerated
  version and CATCH the 64x64 software one. Both live in STARTUP.POD, so a track POD loaded on
  its own has neither.
*/
export const CPR_CATCH_FENCE_NAMES = ["ART/CATCH3D.RAW", "ART/CATCH.RAW"];
const decoder = new TextDecoder("latin1");
/*
  The .TRK is labelled text: every value follows a line naming it. The header runs
  CRaceTrack.trackCount, trackBackground, scale and length; then each record runs pointCount,
  segmentCount, curveFlag, p (the anchor), type, plist, !texture, wallType, wallTexture, h,
  pointOffset, !altitude (with grade, %interpGrade and the widths), ^heightOffset.

  Returns null when the file has no track count. A record that breaks the label order ends
  the list there, keeping the records read before it.
*/
export function parseCprTrk(input) {
    const lines = toLines(typeof input === "string" ? input : decoder.decode(input));
    const countLabel = indexOfLine(lines, "CRaceTrack.trackCount");
    if (countLabel < 0 || countLabel + 1 >= lines.length)
        return null;
    const trackCount = parseIntValue(lines[countLabel + 1], 0);
    let cursor = indexOfLine(lines, "pointCount", countLabel + 2);
    const headerEnd = cursor >= 0 ? cursor : lines.length;
    const header = (label) => {
        const at = indexOfLine(lines, `CRaceTrack.${label}`);
        return at >= 0 && at + 1 < headerEnd ? lines[at + 1] : null;
    };
    const number = (value) => (value === null ? null : parseFloatValue(value, 0));
    const surfaces = [];
    for (let i = 0; i < trackCount && cursor >= 0 && cursor < lines.length; i++) {
        const parsed = parseSurface(lines, cursor);
        if (!parsed)
            break;
        surfaces.push(parsed.surface);
        cursor = parsed.nextIndex;
    }
    return { trackCount, background: header("trackBackground"), scale: number(header("scale")), length: number(header("length")), surfaces };
}
/*
  The .TTX: a count line, then `name,surfaceType` per texture. Entries with an empty name are
  skipped but still use up their line, so indexes into the list stay those of the file only
  when no line is blank; the stock files have none.
*/
export function parseCprTtx(input) {
    const lines = toLines(typeof input === "string" ? input : decoder.decode(input));
    const textureCount = parseIntValue(lines[0] ?? "0", 0);
    const out = [];
    for (let i = 0; i < textureCount && i + 1 < lines.length; i++) {
        const parts = lines[i + 1].split(",");
        const name = normalizePodPath(parts[0] ?? "");
        if (!name)
            continue;
        out.push({ name, flags: parts.length > 1 ? parseIntValue(parts[1], 0) : 0 });
    }
    return out;
}
/*
  Whether a cross section slot is collapsed to zero width on this segment.

  pointOffset is the lateral offset of each point from the centreline, in feet, and is the
  direct answer. At Laguna segment 0 it runs -48, -48, -48, -36, -24, -24, 0, 24 ... so the
  two Left unused slots and every pit slot are flat against their neighbour.

  Falling back to comparing the positions covers a track whose pointOffset block failed to
  parse, since a collapsed slot repeats its coordinates in plist as well.
*/
export function isDegenerateSlot(surface, lane) {
    const offsets = surface.pointOffsets;
    if (offsets && offsets.length > lane + 1)
        return offsets[lane] === offsets[lane + 1];
    const points = surface.points ?? [];
    const a = points[lane];
    const b = points[lane + 1];
    if (!a || !b)
        return true;
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
/** The centreline of a cross section, halfway between the two mirror points 9 and 10. */
function sectionCentre(surface) {
    const points = surface?.points ?? [];
    const a = points[CPR_CROSS_SECTION_MIDPOINT - 1] ?? points[0];
    const b = points[CPR_CROSS_SECTION_MIDPOINT] ?? a;
    if (!a || !b)
        return null;
    return [(a[0] + b[0]) / 2, (a[2] + b[2]) / 2];
}
/*
  Whether a track is a closed circuit, so its last segment runs on into its first.

  The .TRK stores one record per segment and each record owns the stretch from itself to the
  next, so the last record's stretch, back to record 0, has no following record to reach.
  Nothing in the file says "closed". Every stock track is, though, and all 17 end one ordinary
  segment short of their start (Laguna: 30.0 ft, against a median segment of 35.8 ft and a
  longest of 108.8 ft; Rio, the widest, 59.9 ft against a longest of 56.5 ft).

  So a track counts as closed when the gap from its last section back to its first is no
  longer than 1.5 times its own longest segment, and runs the same way the track does, which
  keeps a point-to-point layout whose ends happen to lie near each other from being joined
  across. A last section sitting ON the first needs no closing segment.
*/
export function cprTrackIsClosed(surfaces) {
    const n = surfaces?.length ?? 0;
    if (!surfaces || n < 3)
        return false;
    const centres = surfaces.map(sectionCentre);
    if (centres.some((c) => !c))
        return false;
    const c = centres;
    let longest = 0;
    for (let i = 0; i + 1 < n; i++) {
        const length = Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]);
        if (length > longest)
            longest = length;
    }
    const last = c[n - 1];
    const gapX = c[0][0] - last[0];
    const gapZ = c[0][1] - last[1];
    const gap = Math.hypot(gapX, gapZ);
    if (gap < 1 || gap > longest * 1.5)
        return false;
    const dirX = last[0] - c[n - 2][0];
    const dirZ = last[1] - c[n - 2][1];
    return dirX * gapX + dirZ * gapZ > 0;
}
/**
 * The [from, to] record pairs whose stretch exists, in order: each record to the next, plus
 * the last back to the first on a closed circuit.
 */
export function cprSegmentPairs(surfaces) {
    const n = surfaces?.length ?? 0;
    const pairs = [];
    for (let i = 0; i + 1 < n; i++)
        pairs.push([i, i + 1]);
    if (cprTrackIsClosed(surfaces))
        pairs.push([n - 1, 0]);
    return pairs;
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
  is the highest. A side with no wall is drawn out to its last slot.

  Slot `lane` runs from point `lane` to point `lane + 1`, so the left clip drops slots below
  the wall point and the right clip drops slots from the wall point on.

  Returns an inclusive slot range; empty when first > last.
*/
export function cprVisibleSlots(surface) {
    const pointCount = surface?.points?.length ?? 0;
    const walls = surface?.wallTypes ?? [];
    let first = 0;
    let last = pointCount - 2;
    for (let point = 0; point < CPR_CROSS_SECTION_MIDPOINT && point < pointCount; point++) {
        if (CPR_WALL_LAYERS[walls[point] ?? 0]) {
            first = point;
            break;
        }
    }
    for (let point = pointCount - 1; point >= CPR_CROSS_SECTION_MIDPOINT; point--) {
        if (CPR_WALL_LAYERS[walls[point] ?? 0]) {
            last = point - 1;
            break;
        }
    }
    return { first, last };
}
/*
  What each of a CPR track's five courses is for (CPREDIT guide, "E, course editor"). Courses
  are the AI's paths, chains of straight segments the game joins with constant radius curves.
  `lap` says whether the course closes into a full lap; course 4 is only pit row.
*/
export const CPR_COURSE_PURPOSES = [
    { name: "AI line 1", detail: "racing line, full lap", lap: true },
    { name: "AI line 2", detail: "racing line, full lap", lap: true },
    { name: "AI line 3", detail: "racing line, full lap", lap: true },
    { name: "Pit road", detail: "full lap through pit entry and exit, right of pit row", lap: true },
    { name: "Pit row", detail: "pit stalls only, not a lap, left of pit row", lap: false },
];
export const CPR_CHECKPOINT_ROLES = ["pitEntry", "pitSpeedLimit", "pitSpeedLimitEnd", "startFinish"];
export function cprCheckpointRole(sequence, count) {
    if (count < CPR_CHECKPOINT_ROLES.length)
        return "gate";
    return CPR_CHECKPOINT_ROLES[sequence] ?? "gate";
}
export function isCprPitCheckpoint(role) {
    return role === "pitEntry" || role === "pitSpeedLimit" || role === "pitSpeedLimitEnd";
}
function parseSurface(lines, cursor) {
    if (cursor + 8 >= lines.length || lines[cursor] !== "pointCount")
        return null;
    const pointCount = parseIntValue(lines[cursor + 1], -1);
    const segmentCount = readIntAfterLabel(lines, cursor + 2, "segmentCount", -1);
    const curveFlag = readIntAfterLabel(lines, cursor + 4, "curveFlag", 0);
    if (pointCount <= 0 || segmentCount <= 0)
        return null;
    const surface = {
        curveFlag,
        anchor: parseFloatList(lines[cursor + 7], 3),
        segmentTypes: [],
        points: [],
        textureIndexes: [],
        textureCoordinates: [],
        wallTypes: [],
        wallTextures: [],
        normal: [0, 0, 0],
        pointOffsets: [],
        altitude: 0,
        grade: 0,
        interpolatedGrade: 0,
        width: 0,
        interpolatedWidth: 0,
        heightOffsets: [],
    };
    let index = cursor + 8;
    if (lines[index] !== "type")
        return null;
    surface.segmentTypes = readIntList(lines, index + 1, segmentCount);
    index += 1 + segmentCount;
    if (lines[index] !== "plist")
        return null;
    surface.points = readFloatLists(lines, index + 1, pointCount, 3);
    index += 1 + pointCount;
    if (lines[index] !== "!texture")
        return null;
    for (let i = 0; i < segmentCount; i++) {
        const values = parseIntList(lines[index + 1 + i]);
        surface.textureIndexes.push(values.length ? values[0] : 0);
        surface.textureCoordinates.push(values);
    }
    index += 1 + segmentCount;
    if (lines[index] !== "wallType")
        return null;
    surface.wallTypes = readIntList(lines, index + 1, pointCount);
    index += 1 + pointCount;
    if (lines[index] !== "wallTexture")
        return null;
    for (let i = 0; i < pointCount; i++) {
        surface.wallTextures.push(parseIntList(lines[index + 1 + i]));
    }
    index += 1 + pointCount;
    if (lines[index] !== "h")
        return null;
    surface.normal = parseFloatList(lines[index + 1], 3);
    index += 2;
    if (lines[index] !== "pointOffset")
        return null;
    surface.pointOffsets = readFloatList(lines, index + 1, pointCount);
    index += 1 + pointCount;
    if (lines[index] !== "!altitude")
        return null;
    surface.altitude = parseFloatValue(lines[index + 1], 0);
    surface.grade = readFloatAfterLabel(lines, index + 2, "grade", 0);
    surface.interpolatedGrade = readFloatAfterLabel(lines, index + 4, "%interpGrade", 0);
    const widths = parseFloatList(lines[index + 7], 2);
    surface.width = widths[0] ?? 0;
    surface.interpolatedWidth = widths[1] ?? surface.width;
    index += 8;
    if (lines[index] !== "^heightOffset")
        return null;
    surface.heightOffsets = readFloatList(lines, index + 1, pointCount);
    return { surface, nextIndex: index + 1 + pointCount };
}
function readIntAfterLabel(lines, index, label, fallback) {
    return lines[index] === label ? parseIntValue(lines[index + 1], fallback) : fallback;
}
function readFloatAfterLabel(lines, index, label, fallback) {
    return lines[index] === label ? parseFloatValue(lines[index + 1], fallback) : fallback;
}
function readIntList(lines, start, count) {
    return Array.from({ length: count }, (_, i) => parseIntValue(lines[start + i], 0));
}
function readFloatList(lines, start, count) {
    return Array.from({ length: count }, (_, i) => parseFloatValue(lines[start + i], 0));
}
function readFloatLists(lines, start, count, maxCount) {
    return Array.from({ length: count }, (_, i) => parseFloatList(lines[start + i], maxCount));
}
function parseIntList(value) {
    return (value ?? "").split(",").map((part) => parseIntValue(part, 0));
}
function parseFloatList(value, maxCount) {
    return (value ?? "").split(",", maxCount).map((part) => parseFloatValue(part, 0));
}
function parseIntValue(value, fallback) {
    const n = parseInt((value ?? "").trim(), 10);
    return Number.isFinite(n) ? n : fallback;
}
function parseFloatValue(value, fallback) {
    const n = parseFloat((value ?? "").trim());
    return Number.isFinite(n) ? n : fallback;
}
function indexOfLine(lines, value, start = 0) {
    for (let i = Math.max(0, start); i < lines.length; i++) {
        if (lines[i] === value)
            return i;
    }
    return -1;
}
function toLines(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
}
