import { resolveAsset, findEntryByTitle, findEntry } from "./pod-format.js";
import { replaceExtension, archiveTitle, normalizeArchiveName } from "../shared/path-utils.js";
import { loadGroundBoxes } from "./gbox-loader.js";
import { decodeBinModel } from "./bin-decoder.js";
import { loadRaceTrackLayer } from "./racetrack-loader.js";
import { podRawSide } from "./texture-decoder.js";

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
  doc.origin = detectSitOrigin(sitLines);
  doc.prefix = prefixFromName(lvlName);

  // Parse LVL (embedded terrain references)
  const lvlEntry = findEntryFlexible(podIndex, lvlName);
  if (lvlEntry) parseLvlSection(podIndex, getBytes, lvlEntry, doc);

  // Parse SIT metadata (after LVL)
  parseSitMetadata(sitLines, doc);

  return doc;
}

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

  // Sky texture (line 10 = RAW, line 11 = ACT)
  if (lines.length > 10) {
    const skyRawName = normalizeArchiveName(lines[10]);
    if (skyRawName && !skyRawName.startsWith("NULL") && skyRawName.endsWith(".RAW")) {
      const skyEntry = resolveArtAsset(podIndex, skyRawName);
      if (skyEntry) {
        const skyActName = lines.length > 11 ? normalizeArchiveName(lines[11]) : null;
        const skyActEntry = skyActName ? resolveAsset(podIndex, skyActName) : null;
        doc.skyTexture = {
          name: skyRawName,
          data: getBytes(skyEntry),
          actData: skyActEntry ? getBytes(skyActEntry) : doc.palette,
        };
      }
    }
  }

  // Music (line 14), fog (15), LTE (16)
  if (lines.length > 14) {
    const musicEntry = resolveAsset(podIndex, normalizeArchiveName(lines[14]));
    if (musicEntry) doc.musicName = archiveTitle(lines[14]);
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

function parseSitMetadata(sitLines, doc) {
  // !Race Track Name
  const nameIdx = indexOfLine(sitLines, "!Race Track Name");
  if (nameIdx >= 0 && nameIdx + 1 < sitLines.length) doc.trackName = sitLines[nameIdx + 1].trim();

  // Race Track Locale
  const localeIdx = indexOfLine(sitLines, "Race Track Locale");
  if (localeIdx >= 0 && localeIdx + 1 < sitLines.length) doc.localeName = sitLines[localeIdx + 1].trim();

  // Track Race Type
  const typeIdx = indexOfLine(sitLines, "Track Race Type");
  if (typeIdx >= 0 && typeIdx + 1 < sitLines.length) doc.trackType = trackTypeFromValue(parseLeadingInt(sitLines[typeIdx + 1]));

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

  // Courses
  parseCourses(sitLines, doc);

  // Backdrop
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
    box.position = parseLegacyWorldTriplet(lines[iposIdx + 1], doc.terrain.rawBytesPerCell);
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

  return box;
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
      segment.start = parseLegacyWorldTriplet(lines[cstartIdx + 1], doc.terrain.rawBytesPerCell);
    }
    const cendIdx = indexOfLinePrefix(lines, "cend", cursor);
    if (cendIdx >= 0 && cendIdx + 1 < lines.length) {
      segment.end = parseLegacyWorldTriplet(lines[cendIdx + 1], doc.terrain.rawBytesPerCell);
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
  return { cursor };
}

function parseBackdrop(sitLines, doc) {
  const section = indexOfLine(sitLines, "*** Backdrop ***");
  if (section < 0 || section + 4 >= sitLines.length) return;
  const countLine = sitLines[section + 2];
  const comma = countLine.indexOf(",");
  const backdropCount = comma >= 0 ? parseLeadingInt(countLine.slice(comma + 1)) : 0;
  if (backdropCount >= 1) {
    const modelName = normalizeArchiveName(sitLines[section + 4]);
    if (modelName) doc.backdropModelName = modelName;
  }
}

function parseTrucks(sitLines, doc) {
  const rbpc = doc.terrain.rawBytesPerCell;

  // Slot 0: player truck. Data follows "*** Your Truck (Not used anymore) ***" with no block delimiter.
  const playerSection = indexOfLine(sitLines, "*** Your Truck (Not used anymore) ***");
  if (playerSection >= 0) {
    doc.trucks.push(parseTruckBlock(sitLines, playerSection + 1, rbpc));
  }

  // Slots 1+: NPC vehicles under "*** Vehicles ***"
  const vehicleSection = indexOfLine(sitLines, "*** Vehicles ***");
  if (vehicleSection < 0 || vehicleSection + 1 >= sitLines.length) return;
  const count = parseLeadingInt(sitLines[vehicleSection + 1]);
  let cursor = vehicleSection + 2;
  for (let i = 0; i < count; i++) {
    cursor = nextBlockStart(sitLines, cursor);
    if (cursor < 0) return;
    doc.trucks.push(parseTruckBlock(sitLines, cursor + 1, rbpc));
    cursor++;
  }
}

function parseTruckBlock(lines, startIdx, rawBytesPerCell) {
  const truck = { position: [0, 0, 0], theta: 0, phi: 0, psi: 0, name: "" };
  const nameIdx = indexOfLinePrefix(lines, "truckFile", startIdx);
  if (nameIdx >= 0 && nameIdx + 1 < lines.length) {
    truck.name = lines[nameIdx + 1].trim();
  }
  const iposIdx = indexOfLinePrefix(lines, "ipos", startIdx);
  if (iposIdx >= 0 && iposIdx + 1 < lines.length) {
    truck.position = parseLegacyWorldTriplet(lines[iposIdx + 1], rawBytesPerCell);
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
  // CLR bytes per cell: 1 or 2
  if (clrData) {
    const cells = gridSize * gridSize;
    doc.terrain.clrBytesPerCell = clrData.length === cells ? 1 : 2;
  }
}

// .SIT positions are feet; Traxx stores them as ipos = 2*feet horizontally and feet/2
// vertically, wrapping negatives into the 16384-unit world (TrackPODFile.cpp Pod1SitToIpos).
//
// Traxx itself has to quantise, because ipos is an int: the original truncated with
// `2*(int)atof(..)`, which lost half-steps and made positions walk downward on every
// load/save round trip, and the Community Patch 3 fork fixed that by carrying a separate
// 1/256-of-a-step fraction per axis (xfraction/yfraction/zfraction). A viewer never writes
// the file back, so it needs neither the split nor the quantisation: keeping the value as a
// float is strictly more precise than either.
function parseLegacyWorldTriplet(value, rawBytesPerCell) {
  const parts = value.split(",");
  if (parts.length < 3) return [0, 0, 0];
  const vDiv = rawBytesPerCell === 2 ? 4.0 : 2.0;
  let x = 2 * parseFloat(parts[0].trim());
  let y = 2 * parseFloat(parts[2].trim());
  const z = parseFloat(parts[1].trim()) / vDiv;
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  if (x < 0) x += 16384;
  if (y < 0) y += 16384;
  return [x, y, Number.isFinite(z) ? z : 0];
}

function detectSitOrigin(sitLines) {
  const content = sitLines.join("\n").toUpperCase();
  if (content.includes("MTM1") || content.includes("MONSTER TRUCK MADNESS 1")) return "MTM1";
  if (content.includes("CPR") || content.includes("CART PRECISION RACING")) return "CPR";
  return "MTM2";
}

function trackTypeFromValue(v) {
  // MTM2 values: 0=unset, 1=drag, 2=circuit, 3=rally, 4=rumble
  return ["UNKNOWN", "DRAG", "CIRCUIT", "RALLY", "RUMBLE"][v] ?? "UNKNOWN";
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
    gameType: "", weatherMask: 0xFFFF, musicName: "", prefix: "",
    ambientSound: 0, levelValue: 0,
    sunVector: [0, -1, 0], sunPosition: [0, 1000, 0],
    sunIntensity: 255, shadowIntensity: 128,
    waterLevel: 0,
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
    fogMap: null,
  };
}
