import { splitEvoLines, evoLabel, evoNumbers, evoUnquote, evoFieldLine } from "./evo-text.js";

/*
  Evo .SIT: the scene script.

  Both games share a header and a `*** Course ***` section but their `*** Boxes ***`
  sections are different enough to need separate readers:

    v6 (Evo 1)  sequential `Box N of M` records of alternating label/value lines.
    v7 (Evo 2)  a class registry, a name list, then brace-delimited instances.

  The header is what distinguishes an Evo .SIT from the MTM-family one the viewer already
  reads. Line 0 is the literal word `version` and line 1 is the number; the MTM reader takes
  line 0 as the .LVL path, so pointed at an Evo track it looks for an asset called "version",
  finds no terrain and then misparses every box. Detection therefore happens before any
  parser is chosen - see isEvoSit below.
*/

const HEADER_LVL_LINE = 2;

/** True when the .SIT bytes are an Evo scene script rather than an MTM-family one. */
export function isEvoSit(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64));
  const lines = head.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if ((lines[0] ?? "").trim().toLowerCase() !== "version") return false;
  const version = Number.parseInt((lines[1] ?? "").trim(), 10);
  return Number.isFinite(version) && version >= 1 && version <= 99;
}

/** The Evo generation a .SIT version belongs to: v6 is Evo 1, v7 and later are Evo 2. */
export function evoGameForSitVersion(version) {
  return version >= 7 ? 2 : 1;
}

export function parseEvoSit(bytes, sourceName) {
  const lines = splitEvoLines(bytes);
  const version = Number.parseInt((lines[1] ?? "").trim(), 10);
  if (!Number.isFinite(version)) throw new Error(`${sourceName}: unreadable .SIT version line`);

  const sit = {
    sourceName,
    version,
    game: evoGameForSitVersion(version),
    lvlName: (lines[HEADER_LVL_LINE] ?? "").trim(),
    ...parseHeader(lines),
    boxes: [],
    courses: [],
    warnings: [],
  };

  const boxesAt = lines.findIndex((line) => line.trim() === "*** Boxes ***");
  if (boxesAt >= 0) {
    const { boxes, warnings } = version >= 7
      ? parseBoxesV7(lines, boxesAt, sourceName)
      : parseBoxesV6(lines, boxesAt, sourceName);
    sit.boxes = boxes;
    sit.warnings.push(...warnings);
  } else {
    sit.warnings.push(`${sourceName}: no *** Boxes *** section`);
  }

  const courseAt = lines.findIndex((line) => line.trim() === "*** Course ***");
  if (courseAt >= 0) sit.courses = parseCourses(lines, courseAt);

  return sit;
}

/*
  Header fields the viewer actually uses.

  These are label/value pairs like the rest of the file, so they are found by label rather
  than by line number: a track whose description spans a different number of lines still
  reads correctly. Vehicles, race state, autopilot and damage are deliberately not read.
*/
function parseHeader(lines) {
  const header = { trackName: "", author: "", raceType: 0, ambientSound: 0, trackLength: 0, weatherMask: 0, logoName: "" };
  const limit = Math.min(lines.length, 40);
  for (let i = 0; i < limit; i++) {
    const label = evoLabel(lines[i]);
    const value = (lines[i + 1] ?? "").trim();
    if (label === "Race Track Name") header.trackName = value;
    else if (label === "authorName") header.author = value;
    else if (label === "Track Logo .BMP file") header.logoName = value;
    else if (label === "Track Race Type") header.raceType = Number.parseInt(value, 10) || 0;
    else if (label === "ambient sound,track length,weather mask") {
      const [ambient, length, weather] = evoNumbers(value);
      header.ambientSound = ambient ?? 0;
      header.trackLength = length ?? 0;
      header.weatherMask = weather ?? 0;
    }
  }
  return header;
}

/*
  v6 boxes: `*** Boxes ***`, a count, then that many

    Box N of M ------------------
    wPos / <x,y,z>
    wOrient / <x,y,z>
    model / <name>.smf
    ... mass, bvel, p,q,r, !type,flags, priority, @sound effect entries, #parent,
        $timePerFrame, %castShadowOnMe

  Records are read by label rather than by offset within the record, so the physics fields
  are skipped by simply not having a case for them - the walk never loses its place. The
  `@sound effect entries` label is followed by TWO value lines (both usually empty), which a
  positional reader would desynchronize on; a label-driven one does not care.

  The record header line is the synchronization point: anything between one `Box N of M` and
  the next belongs to that box, and the section ends at the next `***` banner.
*/
function parseBoxesV6(lines, start, sourceName) {
  const boxes = [];
  const warnings = [];
  const declared = Number.parseInt((lines[start + 1] ?? "").trim(), 10) || 0;

  let current = null;
  for (let i = start + 2; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.startsWith("***")) break;
    if (/^Box\s+\d+\s+of\s+\d+/i.test(trimmed)) {
      current = { sourceClass: "Box", schemaVersion: 6, fields: {} };
      boxes.push(current);
      continue;
    }
    if (!current || !trimmed) continue;

    const label = evoLabel(raw);
    if (!label) continue;
    const value = (lines[i + 1] ?? "").trim();
    switch (label) {
      case "wPos":            current.fields.wPos = value; i++; break;
      case "wOrient":         current.fields.wOrient = value; i++; break;
      case "model":           current.fields.staticName = value; i++; break;
      case "type,flags":      current.fields.typeFlags = value; i++; break;
      case "parent":          current.fields.parent = value; i++; break;
      case "timePerFrame":    current.fields.timePerFrame = value; i++; break;
      case "castShadowOnMe":  current.fields.castShadowOnMe = value; i++; break;
      case "priority":        current.fields.priority = value; i++; break;
      // Physics and audio: consumed so the walk stays aligned, then dropped.
      case "mass": case "bvel": case "p,q,r": i++; break;
      case "sound effect entries": i += 2; break;
      default: break;
    }
  }

  if (declared && boxes.length !== declared) {
    warnings.push(`${sourceName}: .SIT declares ${declared} boxes, read ${boxes.length}`);
  }
  return { boxes: boxes.map(normalizeBox), warnings };
}

/*
  v7 boxes: a class registry, a name list, then `{ N ClassName ... } ClassName` instances.

    // boxTypeList
    15
    CVehicle 6            <- the integer is the class's SERIALIZED SCHEMA VERSION, not a count
    ...
    // boxCount
    426
    // Box name list
    1 CCollide
    ...
    // Box data list
    { 1 CCollide
        ""                    // name
        "SK1PEIR.SMF"         // staticName
        41.1267,24.409,200    // size
        ...
    } CCollide

  Every value line carries a `// fieldName` comment naming the field it holds. That was
  checked across all 874 instances of the four stock Evo 2 tracks - 11 distinct classes,
  zero unlabeled lines - so this reader is driven entirely by those labels and needs no
  per-class schema table. A class it has never seen, or a field inserted into an existing
  class, costs it nothing: unknown labels are preserved in `sourceFields` and the instance
  still yields its position, orientation and model.

  Instances are delimited by braces, so an unreadable one is skipped to its closing brace
  rather than desynchronizing the rest of the section.
*/
function parseBoxesV7(lines, start, sourceName) {
  const boxes = [];
  const warnings = [];

  const registry = new Map();
  let declaredCount = 0;
  let dataAt = -1;

  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "// boxTypeList") {
      const typeCount = Number.parseInt((lines[i + 1] ?? "").trim(), 10) || 0;
      for (let t = 0; t < typeCount; t++) {
        const parts = (lines[i + 2 + t] ?? "").trim().split(/\s+/);
        if (parts.length >= 2) registry.set(parts[0], Number.parseInt(parts[1], 10) || 0);
      }
      i += 1 + typeCount;
    } else if (trimmed === "// boxCount") {
      declaredCount = Number.parseInt((lines[i + 1] ?? "").trim(), 10) || 0;
      i++;
    } else if (trimmed === "// Box data list") {
      dataAt = i + 1;
      break;
    }
  }

  if (dataAt < 0) {
    warnings.push(`${sourceName}: v7 .SIT has no "// Box data list"`);
    return { boxes, warnings };
  }

  for (let i = dataAt; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("***")) break;
    if (!trimmed.startsWith("{")) continue;

    const opening = /^\{\s*(\d+)\s+(\w+)/.exec(trimmed);
    const sourceClass = opening?.[2] ?? "unknown";
    const box = {
      sourceClass,
      schemaVersion: registry.get(sourceClass) ?? null,
      instanceId: opening ? Number.parseInt(opening[1], 10) : boxes.length + 1,
      fields: {},
      sourceFields: {},
    };

    i++;
    let closed = false;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim().startsWith("}")) { closed = true; break; }
      const { value, field } = evoFieldLine(line);
      if (field) {
        box.sourceFields[field] = value;
        if (field === "staticName") box.fields.staticName = evoUnquote(value);
        else if (field === "name") box.fields.name = evoUnquote(value);
        else if (field === "wPos") box.fields.wPos = value;
        else if (field === "wOrient") box.fields.wOrient = value;
        else if (field === "size") box.fields.size = value;
        else if (field === "parent") box.fields.parent = value;
        else if (field === "timePerFrame") box.fields.timePerFrame = value;
        else if (field === "castShadowOnMe") box.fields.castShadowOnMe = value;
        else if (field === "priority") box.fields.priority = value;
      }
      i++;
    }
    if (!closed) {
      warnings.push(`${sourceName}: unterminated ${sourceClass} instance at line ${i}`);
      break;
    }
    boxes.push(box);
  }

  if (declaredCount && boxes.length !== declaredCount) {
    warnings.push(`${sourceName}: .SIT declares ${declaredCount} boxes, read ${boxes.length}`);
  }
  return { boxes: boxes.map(normalizeBox), warnings };
}

/*
  One placement, in Evo world units and still on Evo axes (x east, y up, z north).

  Both generations write `wPos` as (x, height, z) and `wOrient` as a radian triple whose
  THIRD component is the heading. Neither is an MTM `ipos`/`theta,phi,psi` record, and
  running them through the legacy world-triplet decoder produces coordinates off by orders
  of magnitude - so nothing here is shared with the MTM path.
*/
function normalizeBox(box) {
  const position = evoNumbers(box.fields.wPos ?? "");
  const orient = evoNumbers(box.fields.wOrient ?? "");
  const size = evoNumbers(box.fields.size ?? "");
  const [type, flags] = evoNumbers(box.fields.typeFlags ?? "");
  return {
    sourceClass: box.sourceClass,
    schemaVersion: box.schemaVersion,
    name: box.fields.name ?? "",
    modelName: (box.fields.staticName ?? "").trim(),
    position: position.length === 3 ? position : [0, 0, 0],
    // (pitch, roll, heading). The heading is verified; see EVO_YAW_SIGN in evo-scene.js.
    orient: orient.length === 3 ? orient : [0, 0, 0],
    size: size.length === 3 ? size : null,
    boxType: Number.isFinite(type) ? type : null,
    boxFlags: Number.isFinite(flags) ? flags : null,
    parent: Number.parseInt(box.fields.parent ?? "0", 10) || 0,
    timePerFrame: Number.parseFloat(box.fields.timePerFrame ?? "0") || 0,
    castShadowOnMe: (box.fields.castShadowOnMe ?? "0").trim() !== "0",
    sourceFields: box.sourceFields ?? null,
  };
}

/*
  `*** Course ***`: one or more racing lines, each a run of segments.

    c1Count,course_direction
    ********************************************* N
    ctype,cspeed_type
    cstart / <x,y,z>
    cend   / <x,y,z>
    cdec_point,cspeed,lastentry
    &cSpeedLimit,cTrackWidth

  A track carries several of these runs back to back (ASPEN has three) and the banner
  numbering restarts at 1 each time, which is what separates them. Only the centreline is
  kept; checkpoints and race rules are out of scope for a viewer.
*/
function parseCourses(lines, start) {
  const courses = [];
  let current = null;
  let previousIndex = Infinity;

  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("*** ")) break;

    const banner = /^\*{5,}\s*(\d+)$/.exec(trimmed);
    if (banner) {
      const index = Number.parseInt(banner[1], 10);
      if (!current || index <= previousIndex) {
        current = { segments: [] };
        courses.push(current);
      }
      previousIndex = index;

      const segment = { start: [0, 0, 0], end: [0, 0, 0], speedLimit: 0, trackWidth: 0 };
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const label = evoLabel(lines[j]);
        const value = lines[j + 1] ?? "";
        if (label === "cstart") { segment.start = triple(value); j++; }
        else if (label === "cend") { segment.end = triple(value); j++; }
        else if (label === "cSpeedLimit,cTrackWidth") {
          const [limit, width] = evoNumbers(value);
          segment.speedLimit = limit ?? 0;
          segment.trackWidth = width ?? 0;
          j++;
          break;
        }
      }
      current.segments.push(segment);
    }
  }
  return courses.filter((course) => course.segments.length > 0);
}

function triple(value) {
  const parts = evoNumbers(value);
  return parts.length === 3 ? parts : [0, 0, 0];
}
