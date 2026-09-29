import { resolveAsset, findEntryByTitle, findEntry } from "./pod-format.js";
import { replaceExtension, archiveTitle, normalizeArchiveName } from "../shared/path-utils.js";
import { loadGroundBoxes } from "./gbox-loader.js";
import { decodeBinModel } from "./bin-decoder.js";
import { loadRaceTrackLayer } from "./racetrack-loader.js";
import { podRawSide } from "./texture-decoder.js";
import { cprCheckpointRole } from "../shared/cpr-track-schema.js";
import {
  CPR_HEIGHT_DIVISOR, CPR_HEIGHT_UNIT_SCALE, LEGACY_ALTITUDE_DIVISOR,
} from "../shared/terrain-height.js";

/**
 * Parses MTM2/MTM1/CPR tracks from a SIT entry in a POD archive.
 * Returns a partial TrackDoc (terrain data, courses, boxes, metadata).
 */
export function parseSitTrack(podIndex, getBytes, sitEntry, podComment) {
  const sitText = new TextDecoder("latin1").decode(getBytes(sitEntry));
  const sitLines = toLines(sitText);
  if (!sitLines.length) throw new Error("SIT entry is empty");

  const lvlName = normalizeArchiveName(sitLines[0]);
  const doc = createDoc(podComment);
  doc.origin = detectSitOrigin(sitLines, sitEntry.title ?? "");
  doc.prefix = prefixFromName(lvlName);

  // Parse LVL (embedded terrain references)
  const lvlEntry = findEntryFlexible(podIndex, lvlName);
  if (lvlEntry) parseLvlSection(podIndex, getBytes, lvlEntry, doc);

  // Parse SIT metadata (after LVL)
  parseSitMetadata(sitLines, doc);

  if (doc.origin === "CPR") {
    applyCprStandInMasses(doc.boxes);
    markCprTreesAsBillboards(doc.boxes);
    // What each checkpoint is for; see cprCheckpointRole.
    const checkpointCount = doc.boxes.filter((box) => box.type === 6).length;
    for (const box of doc.boxes) {
      if (box.type === 6) box.checkpointRole = cprCheckpointRole(box.checkpointSequence, checkpointCount);
    }
  }

  return doc;
}

/** Sky gradient: ACT colours 192-207 go into palette slots 240-255; see parseLvlSection. */
const SKY_PALETTE_FIRST_SLOT = 240;
const SKY_GRADIENT_START = 192 * 3;
const SKY_GRADIENT_END = SKY_GRADIENT_START + 16 * 3;

function parseLvlSection(podIndex, getBytes, lvlEntry, doc) {
  const lvlText = new TextDecoder("latin1").decode(getBytes(lvlEntry));
  const lines = toLines(lvlText);
  if (lines.length < 6) return;

  // Line 2: RAW
  const rawName = normalizeArchiveName(lines[2]);
  const rawEntry = resolveTrackDataAsset(podIndex, rawName);
  if (rawEntry) {
    doc.terrain.rawName = rawName;
    doc.terrain.rawData = getBytes(rawEntry);
  }

  // Line 3: CLR
  const clrName = normalizeArchiveName(lines[3]);
  const clrEntry = resolveTrackDataAsset(podIndex, clrName);
  if (clrEntry) {
    doc.terrain.clrName = clrName;
    doc.terrain.clrData = getBytes(clrEntry);
  }

  // Line 4: ACT palette
  const actName = normalizeArchiveName(lines[4]);
  const actEntry = resolveAsset(podIndex, actName);
  if (actEntry) {
    doc.palette = getBytes(actEntry).slice(0, 768);
    // Load fog map
    const fogMapName = replaceExtension(actName, ".MAP");
    const fogEntry = resolveAsset(podIndex, "FOG/" + archiveTitle(fogMapName)) ?? resolveAsset(podIndex, fogMapName);
    if (fogEntry) doc.fogMap = getBytes(fogEntry);
  }

  // Line 5: TEX texture list
  const texName = normalizeArchiveName(lines[5]);
  const texEntry = resolveTrackDataAsset(podIndex, texName);
  if (texEntry) {
    loadTexList(podIndex, getBytes, texEntry, doc, false);
    // TTY
    const ttyName = replaceExtension(texName, ".TTY");
    const ttyEntry = resolveTrackDataAsset(podIndex, ttyName);
    if (ttyEntry) parseTty(getBytes(ttyEntry), doc);
  }

  /*
    Sky texture (line 10 = RAW, line 11 = ACT).

    MTM1 draws its sky the way Terminal Velocity does, as a flat textured ceiling recoloured
    per level: ALIENSKY.RAW and NEWSKY.RAW only use palette slots 244-251, which are black in
    every .ACT, and the level's line 11 ACT (EARTHSKY, SUNSET) supplies colours 192-207 for
    slots 240-255. Decoding the RAW through that ACT directly gives a black square. So when
    the ACT carries those sixteen colours they are copied into place, exactly as lvl-parser.js
    does for TV, and the last of them is the horizon colour. `classicSky` records that, and
    the scene offers it as MTM1's Classic sky.
  */
  if (lines.length > 10) {
    const skyRawName = normalizeArchiveName(lines[10]);
    if (skyRawName && !skyRawName.startsWith("NULL") && skyRawName.endsWith(".RAW")) {
      const skyEntry = resolveArtAsset(podIndex, skyRawName);
      if (skyEntry) {
        const skyActName = lines.length > 11 ? normalizeArchiveName(lines[11]) : null;
        const skyActEntry = skyActName ? resolveAsset(podIndex, skyActName) : null;
        const skyActData = skyActEntry ? getBytes(skyActEntry) : null;
        const skyData = getBytes(skyEntry);
        // Only a sky drawn entirely in the gradient slots is recoloured; any other RAW keeps its ACT.
        const gradientSky = skyData.length > 0 && skyData.every((index) => index >= SKY_PALETTE_FIRST_SLOT);
        const gradient = gradientSky && skyActData?.length >= SKY_GRADIENT_END
          ? new Uint8Array(skyActData.subarray(SKY_GRADIENT_START, SKY_GRADIENT_END))
          : null;
        let actData = skyActData ?? doc.palette;
        if (gradient) {
          actData = new Uint8Array(768);
          if (doc.palette) actData.set(doc.palette.subarray(0, 768));
          actData.set(gradient, SKY_PALETTE_FIRST_SLOT * 3);
          doc.classicSky = { gradient: [...gradient], horizon: [...gradient.subarray(45, 48)] };
        }
        doc.skyTexture = { name: skyRawName, data: skyData, actData };
      }
    }
  }

  /*
    Music (line 14), fog (15), LTE (16).

    The music name is taken from the line, not from whether the file resolves in this archive.
    MTM 2 keeps its soundtrack in MUSIC.POD rather than in the track POD - every one of its
    levels names a .WAV at this line (aztec.wav, rockx.wav, surf.wav ...) and none of them
    ship beside the track - so resolving first reported "no music" for the entire game. MTM 1
    and CPR name a .MOD that does sit in the same archive, which is why this only ever showed
    up on MTM 2.
  */
  if (lines.length > 14) {
    const musicName = normalizeArchiveName(lines[14]);
    if (musicName && !musicName.startsWith("NULL.")) doc.musicName = archiveTitle(lines[14]);
  }
  if (lines.length > 16) {
    const lteEntry = resolveAsset(podIndex, normalizeArchiveName(lines[16]));
    if (lteEntry) { doc.terrain.lteName = normalizeArchiveName(lines[16]); doc.terrain.lteData = getBytes(lteEntry); }
  }

  // Lighting
  if (lines.length > 17) doc.sunVector = parseIntTriplet(lines[17]) ?? doc.sunVector;
  if (lines.length > 18) doc.shadowIntensity = parseLeadingInt(lines[18]);
  if (lines.length > 19) doc.sunPosition = parseIntTriplet(lines[19]) ?? doc.sunPosition;
  if (lines.length > 20) doc.sunIntensity = parseLeadingInt(lines[20]);
  if (lines.length > 21) doc.levelValue = parseLeadingInt(lines[21]);

  // Water level
  const waterIdx = indexOfLine(lines, "!waterHeight");
  if (waterIdx >= 0 && waterIdx + 1 < lines.length) {
    doc.waterLevel = Math.round(parseLeadingInt(lines[waterIdx + 1]) / 4);
  }

  // Infer terrain grid
  inferTerrain(doc);

  // Ground boxes from RA0/RA1/CL0
  if (doc.terrain.rawData) {
    doc.groundBoxes = loadGroundBoxes(podIndex, getBytes, rawName, doc.terrain.gridSize);
  }

  loadRaceTrackLayer(podIndex, getBytes, rawName, doc);
}

/*
  Weights for the CPR scenery a car is meant to knock about.

  CPREDIT's box type menu reads Undefined, Sign, Barricade, Tree, Cone, Crushed Car,
  Checkpoint: the same numbering MTM2 uses, where its CONE.BIN is type 4 and its RR4SIGN signs
  are type 1. CPREDIT also has "Set Box Mass", but every stock CPR object is saved with mass 0,
  which the drive colliders read as immovable.

  So a CPR Cone (4) or Sign (1) with no mass of its own takes MTM2's value for the same object,
  in slugs as the file stores them: 0.093243 for a cone (about 3 lb) and 7.770249 for a sign
  (about 250 lb). Nothing else is touched: a tent, a walkway or an Undefined box keeps mass 0.

  The stock tracks never actually use types 1 or 4. Their cones (LG4CONE, VN4CONEA) and
  Laguna's distance marker boards (LG3MIL1-4) are all saved as type 0, so those models are
  read as the Cone and Sign they are.
*/
const CPR_TYPE_SIGN = 1;
const CPR_TYPE_CONE = 4;
const CPR_STAND_IN_MASS = { [CPR_TYPE_SIGN]: 7.770249, [CPR_TYPE_CONE]: 0.093243 };
const CPR_MODEL_TYPE = [
  [/^(LG4CONE|VN4CONEA)\.BIN$/i, CPR_TYPE_CONE],
  [/^LG3MIL[1-4]\.BIN$/i, CPR_TYPE_SIGN],
];

/*
  CPR's Tree type (3 in CPREDIT's menu) is MTM2's "Always Face" (type 8): every one of the
  1,643 stock CPR type 3 objects is a tree or a palm, and their models are single flat quads
  that only read as trees turned toward the camera. Marked here rather than by type number in
  the scene, because type 3 in MTM2 is something else entirely (hay bales, solid).
*/
const CPR_TYPE_TREE = 3;

function markCprTreesAsBillboards(boxes) {
  for (const box of boxes) {
    if (box.type === CPR_TYPE_TREE) box.billboard = true;
  }
}

function applyCprStandInMasses(boxes) {
  for (const box of boxes) {
    if (box.mass) continue;
    const byModel = CPR_MODEL_TYPE.find(([pattern]) => pattern.test(box.modelName ?? ""));
    const kind = byModel ? byModel[1] : box.type;
    const mass = CPR_STAND_IN_MASS[kind];
    if (mass) box.mass = mass;
  }
}

function parseSitMetadata(sitLines, doc) {
  // !Race Track Name
  const nameIdx = indexOfLine(sitLines, "!Race Track Name");
  if (nameIdx >= 0 && nameIdx + 1 < sitLines.length) doc.trackName = sitLines[nameIdx + 1].trim();

  // Race Track Locale
  const localeIdx = indexOfLine(sitLines, "Race Track Locale");
  if (localeIdx >= 0 && localeIdx + 1 < sitLines.length) doc.localeName = sitLines[localeIdx + 1].trim();

  // Track Race Type
  const typeIdx = indexOfLine(sitLines, "Track Race Type");
  if (typeIdx >= 0 && typeIdx + 1 < sitLines.length) {
    doc.trackType = trackTypeFromValue(parseLeadingInt(sitLines[typeIdx + 1]), doc.origin);
  }

  /*
    @Redbook Audio Track: the CD audio track the game plays on this course.

    MTM 1 and CPR have no ambient-sound field at all - the line below is one of the two
    markers that identify an MTM 2 .SIT in the first place - and this is what they carry
    instead. Reading it means those two games report the audio they actually name rather than
    an empty row.
  */
  const redbookIdx = indexOfLine(sitLines, "@Redbook Audio Track");
  if (redbookIdx >= 0 && redbookIdx + 1 < sitLines.length) {
    doc.redbookTrack = parseLeadingInt(sitLines[redbookIdx + 1]);
  }

  // ambient sound, length, weather mask
  const ambientIdx = indexOfLine(sitLines, "!ambient sound,track length,weather mask");
  if (ambientIdx >= 0 && ambientIdx + 1 < sitLines.length) {
    const parts = sitLines[ambientIdx + 1].split(",");
    if (parts.length >= 3) {
      doc.ambientSound = parseLeadingInt(parts[0]);
      doc.weatherMask = parseLeadingInt(parts[2]);
    }
  }

  // Boxes (*** Ramps *** and *** Boxes ***)
  parseBoxSection(sitLines, "*** Ramps ***", doc, true);
  parseBoxSection(sitLines, "*** Boxes ***", doc, false);
  parseTopCrushSection(sitLines, doc);

  // Courses
  parseCourses(sitLines, doc);

  // Stadium (arena) then Backdrop. Order matches the SIT itself; the two are alternatives,
  // and which one wins is settled where the model is actually loaded.
  parseArena(sitLines, doc);
  parseBackdrop(sitLines, doc);

  // Trucks
  parseTrucks(sitLines, doc);
}

function parseBoxSection(lines, sectionHeader, doc, isRamp) {
  const section = indexOfLine(lines, sectionHeader);
  if (section < 0 || section + 1 >= lines.length) return;
  const count = parseLeadingInt(lines[section + 1]);
  let cursor = section + 2;
  let checkpointSequence = 0;
  for (let i = 0; i < count; i++) {
    cursor = nextBlockStart(lines, cursor);
    if (cursor < 0) return;
    const box = parseBoxBlock(lines, cursor, isRamp, doc);
    if (box && !isRamp && box.type === 6) box.checkpointSequence = checkpointSequence++;
    if (box) doc.boxes.push(box);
    cursor++;
  }
}

function parseBoxBlock(lines, blockStart, isRamp, doc) {
  // BOXTYPE_RAMP is 99 (Include/TrackPODBox.h:37). It used to be tagged 8, which is
  // TYPE_NO_COLLIDE_FACING, so every ramp was routed into the camera-facing billboard group
  // and drawn as a billboarded collision prism instead of a wedge.
  const box = { position: [0, 0, 0], theta: 0, phi: 0, psi: 0, length: 64, width: 64, height: 64, modelName: "", mass: 0, type: isRamp ? 99 : 0, flags: 0, checkpointSequence: -1 };
  const blockEnd = nextBlockStart(lines, blockStart + 1);
  const endIndex = blockEnd >= 0 ? blockEnd : lines.length;

  const iposIdx = indexOfLinePrefix(lines, "ipos", blockStart, endIndex);
  if (iposIdx >= 0 && iposIdx + 1 < lines.length) {
    box.position = parseLegacyWorldTriplet(lines[iposIdx + 1]);
  }

  const anglesIdx = indexOfLinePrefix(lines, "theta,phi,psi", blockStart, endIndex);
  if (anglesIdx >= 0 && anglesIdx + 1 < lines.length) {
    const a = parseFloatTriplet(lines[anglesIdx + 1]);
    box.theta = a[0]; box.phi = a[1]; box.psi = a[2];
  }

  const modelIdx = indexOfLinePrefix(lines, "model", blockStart, endIndex);
  if (modelIdx >= 0 && modelIdx + 1 < lines.length) {
    box.modelName = normalizeArchiveName(lines[modelIdx + 1]);
  }
  const dimIdx = indexOfLinePrefix(lines, "length,width,height", blockStart, endIndex);
  if (dimIdx >= 0 && dimIdx + 1 < lines.length) {
    const sz = parseFloatTriplet(lines[dimIdx + 1]);
    box.length = Math.round(sz[0]); box.width = Math.round(sz[1]); box.height = Math.round(sz[2]);
  }

  if (!isRamp) {
    const typeFlagsIdx = indexOfLinePrefix(lines, "!type,flags", blockStart, endIndex);
    if (typeFlagsIdx >= 0 && typeFlagsIdx + 1 < lines.length) {
      const parts = lines[typeFlagsIdx + 1].split(",");
      box.type = parseLeadingInt(parts[0] ?? "0");
      box.flags = parseLeadingInt(parts[1] ?? "0");
    }
  }

  const massIdx = indexOfLinePrefix(lines, "mass", blockStart, endIndex);
  if (massIdx >= 0 && massIdx + 1 < lines.length) box.mass = parseFloat(lines[massIdx + 1]) || 0;

  // Velocity in feet per second, as written. Type 10 objects ("moving - use bvel" in Traxx's
  // notes) travel along it, which is TPARK's train; every other box carries zeros.
  const bvelIdx = indexOfLinePrefix(lines, "bvel", blockStart, endIndex);
  if (bvelIdx >= 0 && bvelIdx + 1 < lines.length) box.bvel = parseFloatTriplet(lines[bvelIdx + 1]);

  return box;
}

/*
  *** Top Crush *** - the cars a truck flattens by driving over them.

  Traxx writes these as their own section rather than as boxes (TrackPODFile.cpp:2594-2680),
  and each record is two objects:

    ipos / modelName          the part that never changes (MTM1's WREC2.BIN, the chassis)
    ipos2 / cabModelName      an animated BIN with two frames, before and after crushing,
                              which the game morphs between the further the object is crushed

  ipos2 is ipos plus the editor's crush offset, so the cab sits where the author put it on the
  body. Both are ordinary world triplets. The rest (mass, bvel, p,q,r) is the usual physics
  state and carries zeros in every stock record, so it is not kept.

  Each part becomes a box of type BOXTYPE_CRUSH (98, Include/TrackPODBox.h). The cab carries
  `crushRole: "cab"`, which is what tells the scene to drive its frames from the crush amount
  instead of playing them as a loop, and drive mode to make it a collider that gives way.
*/
const BOXTYPE_CRUSH = 98;

function parseTopCrushSection(lines, doc) {
  const section = indexOfLine(lines, "*** Top Crush ***");
  if (section < 0 || section + 1 >= lines.length) return;
  const count = parseLeadingInt(lines[section + 1]);
  const sectionEnd = indexOfLine(lines, "*** Course ***");
  const limit = sectionEnd > section ? sectionEnd : lines.length;
  let cursor = section + 2;
  for (let i = 0; i < count; i++) {
    cursor = nextBlockStart(lines, cursor);
    if (cursor < 0 || cursor >= limit) return;
    const blockEnd = Math.min(limit, nextBlockStart(lines, cursor + 1) >= 0 ? nextBlockStart(lines, cursor + 1) : limit);
    const valueAfter = (label) => {
      for (let k = cursor + 1; k < blockEnd - 1; k++) if (lines[k].trim() === label) return lines[k + 1].trim();
      return null;
    };
    const ipos = valueAfter("ipos");
    const ipos2 = valueAfter("ipos2") ?? ipos;
    const angles = parseFloatTriplet(valueAfter("theta,phi,psi") ?? "0,0,0");
    const modelOf = (value) => {
      const name = value ? normalizeArchiveName(value) : "";
      return name && !name.startsWith("NULL") ? name : "";
    };
    const common = {
      theta: angles[0], phi: angles[1], psi: angles[2],
      length: 64, width: 64, height: 64, mass: 0, type: BOXTYPE_CRUSH, flags: 0,
      checkpointSequence: -1, crushGroup: i,
    };
    if (ipos) {
      doc.boxes.push({ ...common, position: parseLegacyWorldTriplet(ipos), modelName: modelOf(valueAfter("modelName")), crushRole: "body" });
      doc.boxes.push({ ...common, position: parseLegacyWorldTriplet(ipos2), modelName: modelOf(valueAfter("cabModelName")), crushRole: "cab" });
    }
    cursor = blockEnd;
  }
}

function parseCourses(lines, doc) {
  const courseSection = indexOfLine(lines, "*** Course ***");
  if (courseSection >= 0 && courseSection + 2 < lines.length) {
    const count = parseLeadingInt(lines[courseSection + 2]);
    const { cursor } = parseCourseBlocks(lines, courseSection + 3, count, doc.primaryCourse, doc);
    // Extended courses
    const extSection = indexOfLine(lines, "@*********** Extended Course Definitions *************");
    if (extSection >= 0 && extSection + 1 < lines.length) {
      const extCount = Math.min(4, parseLeadingInt(lines[extSection + 1]));
      let c = extSection + 2;
      for (let i = 0; i < extCount && c < lines.length; i++) {
        const course = { segments: [] };
        const segCount = c + 1 < lines.length ? parseLeadingInt(lines[c + 1]) : 0;
        const result = parseCourseBlocks(lines, c + 2, segCount, course, doc);
        c = result.cursor;
        if (course.segments.length) doc.extendedCourses.push(course);
      }
    }
  }
}

function parseCourseBlocks(lines, startCursor, count, course, doc) {
  let cursor = startCursor;
  for (let i = 0; i < count; i++) {
    cursor = nextBlockStart(lines, cursor);
    if (cursor < 0) return { cursor: lines.length };
    const segment = { start: [0, 0, 0], end: [0, 0, 0], speedLimit: 0, trackWidth: 64 };

    const cstartIdx = indexOfLinePrefix(lines, "cstart", cursor);
    if (cstartIdx >= 0 && cstartIdx + 1 < lines.length) {
      segment.start = parseLegacyWorldTriplet(lines[cstartIdx + 1]);
    }
    const cendIdx = indexOfLinePrefix(lines, "cend", cursor);
    if (cendIdx >= 0 && cendIdx + 1 < lines.length) {
      segment.end = parseLegacyWorldTriplet(lines[cendIdx + 1]);
    }
    const swIdx = indexOfLinePrefix(lines, "&cSpeedLimit,cTrackWidth", cursor);
    if (swIdx >= 0 && swIdx + 1 < lines.length) {
      const parts = lines[swIdx + 1].split(",");
      segment.speedLimit = parseLeadingFloat(parts[0] ?? "0");
      segment.trackWidth = parseLeadingFloat(parts[1] ?? "64");
    }
    course.segments.push(segment);
    cursor++;
  }
  // Extended-course callers need the next [Course N] header, not a position inside the
  // final segment body. Returning immediately after its delimiter made every course after
  // the first read `1,0` (ctype) as its segment count and appear to contain one segment.
  while (cursor < lines.length && !lines[cursor].startsWith("[Course ")) cursor++;
  return { cursor };
}

/*
  *** Stadium *** - the arena.

  An arena track carries its model here rather than in the Backdrop block, and the writer
  then emits backdropCount 0 (TrackPODFile.cpp:5288-5318), so a parser that reads only the
  Backdrop block sees an arena track as having no model at all. That is why arena tracks
  currently render with nothing where the stadium should be.

  Two line formats, discriminated by the leading '!' (TrackPODFile.cpp:2686-2737):

    !stadiumFlag,x,z,sx,sz,stadiumModelName      MTM2: placed, with a grid footprint
    1,120,100,14,14,arena.bin

    stadiumFlag,stadiumModelName                 older form: model only, placed at 0,0
    1,arena.bin

  A leading flag of 0 means the block is present but the track is not an arena.

  sx/sz are the footprint in grid cells. NEITHER renderer reads them - they exist for the
  editor's placement UI and for the game's own terrain flattening - so they are carried
  here for reporting and nothing else. Placement comes from x/z plus the model's own
  anchor vertex; see placeArena in track-worker.js.
*/
function parseArena(sitLines, doc) {
  const section = indexOfLine(sitLines, "*** Stadium ***");
  if (section < 0 || section + 2 >= sitLines.length) return;

  const header = (sitLines[section + 1] ?? "").trim();
  const fields = (sitLines[section + 2] ?? "").split(",");
  if (!parseLeadingInt(fields[0])) return;

  if (header.startsWith("!stadiumFlag")) {
    if (fields.length < 6) return;
    const modelName = normalizeArchiveName(fields[5]);
    if (!modelName) return;
    doc.arena = {
      modelName,
      x: parseLeadingInt(fields[1]),
      y: parseLeadingInt(fields[2]),
      sx: parseLeadingInt(fields[3]),
      sy: parseLeadingInt(fields[4]),
    };
  } else if (header.startsWith("stadiumFlag")) {
    if (fields.length < 2) return;
    const modelName = normalizeArchiveName(fields[1]);
    if (!modelName) return;
    doc.arena = { modelName, x: 0, y: 0, sx: 0, sy: 0 };
  }
}


function parseBackdrop(sitLines, doc) {
  const section = indexOfLine(sitLines, "*** Backdrop ***");
  if (section < 0 || section + 4 >= sitLines.length) return;
  const countLine = sitLines[section + 2];
  const comma = countLine.indexOf(",");
  const backdropCount = comma >= 0 ? parseLeadingInt(countLine.slice(comma + 1)) : 0;
  doc.backdropModelNames = [];
  for (let i = 0; i < Math.min(backdropCount, 64); i++) {
    const line = sitLines[section + 4 + i];
    if (!line || line.startsWith("***")) break;
    const modelName = normalizeArchiveName(line);
    if (modelName) doc.backdropModelNames.push(modelName);
  }
  doc.backdropModelName = doc.backdropModelNames[0] ?? null;
}

function parseTrucks(sitLines, doc) {

  /*
    Slot 0: the player's own truck, under "*** Your Truck (Not used anymore) ***" with no block
    delimiter. The section header says what it is worth: it is a saved player slot rather than
    a vehicle standing on the grid, so it is flagged and the scene does not draw a marker for
    it. The flag, rather than the index, is what says so - Evo has no such slot, and all eight
    of its vehicles are real grid positions.
  */
  const playerSection = indexOfLine(sitLines, "*** Your Truck (Not used anymore) ***");
  if (playerSection >= 0) {
    doc.trucks.push({ ...parseTruckBlock(sitLines, playerSection + 1), playerSlot: true });
  }

  // Slots 1+: NPC vehicles under "*** Vehicles ***"
  const vehicleSection = indexOfLine(sitLines, "*** Vehicles ***");
  if (vehicleSection < 0 || vehicleSection + 1 >= sitLines.length) return;
  const count = parseLeadingInt(sitLines[vehicleSection + 1]);
  let cursor = vehicleSection + 2;
  for (let i = 0; i < count; i++) {
    cursor = nextBlockStart(sitLines, cursor);
    if (cursor < 0) return;
    doc.trucks.push(parseTruckBlock(sitLines, cursor + 1));
    cursor++;
  }
}

function parseTruckBlock(lines, startIdx) {
  const truck = { position: [0, 0, 0], theta: 0, phi: 0, psi: 0, name: "" };
  const nameIdx = indexOfLinePrefix(lines, "truckFile", startIdx);
  if (nameIdx >= 0 && nameIdx + 1 < lines.length) {
    truck.name = lines[nameIdx + 1].trim();
  }
  const iposIdx = indexOfLinePrefix(lines, "ipos", startIdx);
  if (iposIdx >= 0 && iposIdx + 1 < lines.length) {
    truck.position = parseLegacyWorldTriplet(lines[iposIdx + 1]);
  }
  const anglesIdx = indexOfLinePrefix(lines, "theta,phi,psi", startIdx);
  if (anglesIdx >= 0 && anglesIdx + 1 < lines.length) {
    const a = parseFloatTriplet(lines[anglesIdx + 1]);
    truck.theta = a[0]; truck.phi = a[1]; truck.psi = a[2];
  }
  return truck;
}

// ── Helpers ──────────────────────────────────────────────────────

function loadTexList(podIndex, getBytes, texEntry, doc, preserveSlots) {
  const text = new TextDecoder("latin1").decode(getBytes(texEntry));
  const lines = toNonEmptyLines(text);
  const count = parseInt(lines[0] ?? "0", 10);
  for (let i = 0; i < count && i + 1 < lines.length; i++) {
    const name = normalizeArchiveName(lines[i + 1]);
    const dataEntry = resolveArtAsset(podIndex, name);
    const tex = { name, data: null, width: 64, height: 64, type: 0, depth: 0 };
    if (dataEntry) {
      tex.data = getBytes(dataEntry);
      // Any square power-of-two tile 32..1024, not just 64 and 256 (fork: Pod1RawSide).
      tex.width = podRawSide(tex.data.length) || 64;
      tex.height = tex.width;
    }
    // Per-texture ACT
    const texActName = replaceExtension(name, ".ACT");
    const texActEntry = resolveArtAsset(podIndex, texActName);
    if (texActEntry) tex.actData = getBytes(texActEntry);
    doc.textures.push(tex);
  }
}

function resolveTrackDataAsset(podIndex, name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized) return null;
  if (/[\\/]/.test(normalized)) return resolveAsset(podIndex, normalized);
  const title = archiveTitle(normalized);
  return resolveAsset(podIndex, "DATA/" + title) ?? resolveAsset(podIndex, normalized);
}

function resolveArtAsset(podIndex, name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized) return null;
  if (/[\\/]/.test(normalized)) return resolveAsset(podIndex, normalized);
  const title = archiveTitle(normalized);
  return resolveAsset(podIndex, "ART/" + title) ?? resolveAsset(podIndex, normalized);
}

function parseTty(bytes, doc) {
  const lines = toNonEmptyLines(new TextDecoder("latin1").decode(bytes));
  const count = parseInt(lines[0] ?? "0", 10);
  for (let i = 0; i < count && i + 1 < lines.length; i++) {
    const line = lines[i + 1].toUpperCase();
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const name = line.slice(0, comma);
    const value = parseInt(line.slice(comma + 1), 10) || 0;
    const tex = doc.textures.find((t) => archiveTitle(t.name) === archiveTitle(name));
    if (tex) { tex.type = Math.floor(value / 100); tex.depth = value % 100; }
  }
}

function inferTerrain(doc) {
  const { rawData, clrData, lteData } = doc.terrain;
  let gridSize = 256;
  let rawBytesPerCell = 1;
  if (rawData) {
    const n1 = Math.round(Math.sqrt(rawData.length));
    if (n1 * n1 === rawData.length && n1 >= 64 && n1 <= 2048) { gridSize = n1; rawBytesPerCell = 1; }
    else {
      const n2 = Math.round(Math.sqrt(rawData.length / 2));
      if (n2 * n2 * 2 === rawData.length && n2 >= 64 && n2 <= 2048) { gridSize = n2; rawBytesPerCell = 2; }
    }
  } else if (clrData) {
    const n2 = Math.round(Math.sqrt(clrData.length / 2));
    if (n2 * n2 * 2 === clrData.length && n2 >= 64 && n2 <= 2048) gridSize = n2;
    else { const n1 = Math.round(Math.sqrt(clrData.length)); if (n1 * n1 === clrData.length && n1 >= 64 && n1 <= 2048) gridSize = n1; }
  }
  doc.terrain.gridSize = gridSize;
  doc.terrain.rawBytesPerCell = rawBytesPerCell;
  /*
    A 16-bit grid behind a SIT is CPR's, 10.6 fixed point: native height = raw16 / 64.0,
    fraction kept, in 4 ft CPR steps; heightUnitScale 2 turns those into the 2 ft steps the
    rest of the viewer (and every BIN model) is scaled for. See shared/terrain-height.js.
    MTM1 and MTM2 terrain is one byte per cell (none of their stock PODs holds a
    131,072-byte grid). Evo's 16-bit grid is 11.5 and comes through its own loader.
  */
  const cpr = rawBytesPerCell === 2;
  doc.terrain.heightDivisor = cpr ? CPR_HEIGHT_DIVISOR : null;
  doc.terrain.heightUnitScale = cpr ? CPR_HEIGHT_UNIT_SCALE : 1;
  // CPR splits its terrain cells on alternating diagonals; see cellSplit in terrain-builder.js.
  doc.terrain.cellSplit = cpr ? "checkerboard" : "fixed";
  // CLR bytes per cell: 1 or 2
  if (clrData) {
    const cells = gridSize * gridSize;
    doc.terrain.clrBytesPerCell = clrData.length === cells ? 1 : 2;
  }
}

// .SIT positions are feet; Traxx stores them as ipos = 2*feet horizontally and feet/2
// vertically, wrapping negatives into the 16384-unit world (TrackPODFile.cpp Pod1SitToIpos).
//
// That holds for CPR too. CPR's own reading, altitude / 4, gives 4 ft CPR steps, which the
// viewer carries as 2 ft legacy steps like the terrain, so the divisor is 2 for all three
// games. This used to be `/ 4` for CPR, which drew every CPR object at half its height above
// the ground against a model drawn at full size, and buried it.
//
// Traxx itself has to quantise, because ipos is an int: the original truncated with
// `2*(int)atof(..)`, which lost half-steps and made positions walk downward on every
// load/save round trip, and the Community Patch 3 fork fixed that by carrying a separate
// 1/256-of-a-step fraction per axis (xfraction/yfraction/zfraction). A viewer never writes
// the file back, so it needs neither the split nor the quantisation: keeping the value as a
// float is strictly more precise than either.
function parseLegacyWorldTriplet(value) {
  const parts = value.split(",");
  if (parts.length < 3) return [0, 0, 0];
  const vDiv = LEGACY_ALTITUDE_DIVISOR;
  let x = 2 * parseFloat(parts[0].trim());
  let y = 2 * parseFloat(parts[2].trim());
  const z = parseFloat(parts[1].trim()) / vDiv;
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  if (x < 0) x += 16384;
  if (y < 0) y += 16384;
  return [x, y, Number.isFinite(z) ? z : 0];
}

/*
  Which game a SIT came from.

  A SIT carries no version field and never names its game. The previous check searched the
  whole file for "MTM1" and "CPR", and neither string occurs in any of the 47 stock SIT files
  across the three families (MTM1 14, MTM2 15, CPR 18), so both branches were dead and every
  track was reported as MTM2.

  The families are told apart by their record schema instead, which is stable because MTM2
  added records to the MTM1 format and CPR forked that format for open wheel racing:

    CPR   adds a pit stop and driver aid block
    MTM2  adds weather and stadium records
    MTM1  has neither

  Every marker below appears in all of its own family's stock SITs and in none of the other
  two families'. MTM1 is the residual and has no marker of its own, because its schema is a
  strict subset of MTM2's: "no weather mask and no stadium record" is what being an MTM1
  track consists of. The cost of that is that a SIT too damaged to carry either record reads
  as MTM1 rather than MTM2, which loses the terrain overlap in buildAtlas.
*/
const CPR_SIT_MARKERS = [
  "^currentPitStop",
  "@ap.guy2follow,ap.lineOffset,ap.place,ap.pit",
  "*** VARLOW ***",
];
const MTM2_SIT_MARKERS = [
  "!ambient sound,track length,weather mask",
  "!stadiumFlag,x,z,sx,sz,stadiumModelName",
];

function detectSitOrigin(sitLines, sitTitle = "") {
  // Community Patch 3 writes .SI2 only for MTM2, so the extension settles it on its own and
  // covers any fork-specific SIT body this build has not seen.
  if (sitTitle.toUpperCase().endsWith(".SI2")) return "MTM2";
  const lines = new Set(sitLines.map((line) => line.trim()));
  if (CPR_SIT_MARKERS.some((marker) => lines.has(marker))) return "CPR";
  if (MTM2_SIT_MARKERS.some((marker) => lines.has(marker))) return "MTM2";
  return "MTM1";
}

/*
  "Track Race Type" means different things in the two games that write it.

    MTM1 / MTM2   0 = unset, 1 = drag, 2 = circuit, 3 = rally, 4 = rumble
    CPR           4 = road, 5 = speedway, 6 = short oval, 7 = street

  The CPR names are CPREDIT's own, from the "D. Autoset track type" prompt
  ("4 = road, 5 = speedway, 6 = short oval, 7 = street :"), and the 17 stock tracks bear them
  out: Laguna Seca, Mid-Ohio, Road America, Portland and Detroit are 4; California and
  Michigan are 5; Gateway, Homestead, Milwaukee, Nazareth and Rio are 6; Surfers Paradise,
  Long Beach, Cleveland, Toronto and Vancouver are 7. Read through the MTM table, every CPR
  road course came out as RUMBLE.
*/
const MTM_TRACK_TYPES = { 1: "DRAG", 2: "CIRCUIT", 3: "RALLY", 4: "RUMBLE" };
const CPR_TRACK_TYPES = { 4: "ROAD", 5: "SPEEDWAY", 6: "SHORT OVAL", 7: "STREET" };

function trackTypeFromValue(v, origin) {
  const table = origin === "CPR" ? CPR_TRACK_TYPES : MTM_TRACK_TYPES;
  return table[v] ?? "UNKNOWN";
}

function indexOfLine(lines, value) {
  for (let i = 0; i < lines.length; i++) { if (lines[i] === value) return i; }
  return -1;
}

function indexOfLinePrefix(lines, prefix, startIndex = 0, endIndex = lines.length) {
  for (let i = startIndex; i < endIndex && i < lines.length; i++) { if (lines[i].startsWith(prefix)) return i; }
  return -1;
}

function nextBlockStart(lines, startIndex) {
  for (let i = Math.max(0, startIndex); i < lines.length; i++) { if (lines[i].startsWith("********")) return i; }
  return -1;
}

function parseIntTriplet(value) {
  const parts = value.split(",");
  if (parts.length < 3) return null;
  return [parseInt(parts[0].trim(), 10), parseInt(parts[1].trim(), 10), parseInt(parts[2].trim(), 10)];
}

function parseFloatTriplet(value) {
  const parts = value.split(",");
  return [parseLeadingFloat(parts[0] ?? "0"), parseLeadingFloat(parts[1] ?? "0"), parseLeadingFloat(parts[2] ?? "0")];
}

function parseLeadingInt(value) { return parseInt((value ?? "").trim(), 10) || 0; }
function parseLeadingFloat(value) { return parseFloat((value ?? "").trim()) || 0; }

function prefixFromName(name) {
  const title = archiveTitle(name);
  const dot = title.lastIndexOf(".");
  const base = dot >= 0 ? title.slice(0, dot) : title;
  return base.slice(0, Math.min(8, base.length));
}

function findEntryFlexible(podIndex, name) {
  const upper = normalizeArchiveName(name);
  return podIndex.entries.find((e) => e.normalizedName === upper) ?? podIndex.entries.find((e) => e.title === archiveTitle(upper)) ?? null;
}

function toLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function toNonEmptyLines(text) {
  return toLines(text).map((l) => l.trim()).filter(Boolean);
}

function createDoc(podComment) {
  return {
    origin: "MTM2",
    podComment: podComment ?? "",
    trackName: "", localeName: "", trackType: "UNKNOWN",
    /*
      Null rather than a value: a field the file does not carry should read as absent, not as
      a default this parser invented.

      MTM 1 and CPR .SITs have no ambient-sound line, and so no weather mask, which shares it.
      !waterHeight is MTM 2 only and lives in the .LVL, not the .SIT: an MTM 1 or CPR .LVL is
      23 lines and stops before it, while every MTM 2 one carries it (AZTEC 167, Voodoo Island
      370, and 0 on the arenas, which is a real zero and still reported).
    */
    gameType: "", weatherMask: null, musicName: "", prefix: "",
    ambientSound: null, redbookTrack: null, levelValue: 0,
    sunVector: [0, -1, 0], sunPosition: [0, 1000, 0],
    sunIntensity: 255, shadowIntensity: 128,
    waterLevel: null,
    terrain: { gridSize: 256, rawBytesPerCell: 1, clrBytesPerCell: 2, rawName: "", clrName: "", lteName: "", rawData: null, clrData: null, lteData: null },
    palette: null,
    textures: [],
    modelTextures: [],
    models: {},
    boxes: [],
    groundBoxes: [],
    raceTrackTextures: [],
    raceTrackSurfaces: [],
    raceTrackFence: null,
    primaryCourse: { segments: [] },
    extendedCourses: [],
    trucks: [],
    backdropModelName: null,
    backdropModelNames: [],
    arena: null,
    fogMap: null,
  };
}
