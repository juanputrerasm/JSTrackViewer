import { resolveAsset, findEntryByTitle, findEntry } from "./pod-format.js";
import { replaceExtension, archiveTitle, normalizeArchiveName } from "../shared/path-utils.js";
import { loadGroundBoxes } from "./gbox-loader.js";
import { decodeBinModel } from "./bin-decoder.js";
import { loadRaceTrackLayer } from "./racetrack-loader.js";
import { podRawSide } from "./texture-decoder.js";
import { cprCheckpointRole } from "../shared/cpr-track-schema.js";
import { CPR_HEIGHT_DIVISOR, CPR_HEIGHT_UNIT_SCALE } from "../shared/terrain-height.js";
import { parseMtmLvl, parseMtmSit, parseTexList, parseTty as parseTtyEntries, sitTrackTypeName } from "../vendor/openphotex/index.js";

/*
  MTM1, MTM2 and CPR tracks, from a .SIT entry in a POD archive.

  Reading the .SIT, its .LVL, the .TEX texture list and the .TTY type table is OpenPhotex's
  (parseMtmSit, parseMtmLvl and friends). This file resolves the assets they name against the
  archive and assembles the viewer's TrackDoc, with the viewer's own CPR choices on top.
*/

/**
 * Parses MTM2/MTM1/CPR tracks from a SIT entry in a POD archive.
 * Returns a partial TrackDoc (terrain data, courses, boxes, metadata).
 */
export function parseSitTrack(podIndex, getBytes, sitEntry, podComment) {
  const sit = parseMtmSit(getBytes(sitEntry), sitEntry.title ?? "");
  if (!sit.lineCount) throw new Error("SIT entry is empty");

  const lvlName = sit.lvlName;
  const doc = createDoc(podComment);
  doc.origin = sit.origin;
  doc.prefix = prefixFromName(lvlName);

  // Parse LVL (embedded terrain references)
  const lvlEntry = findEntryFlexible(podIndex, lvlName);
  if (lvlEntry) parseLvlSection(podIndex, getBytes, lvlEntry, doc);

  // SIT metadata (after LVL)
  applySitMetadata(sit, doc);

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
  const lvl = parseMtmLvl(getBytes(lvlEntry));
  if (!lvl) return;

  // Line 2: RAW
  const rawName = lvl.rawName;
  const rawEntry = resolveTrackDataAsset(podIndex, rawName);
  if (rawEntry) {
    doc.terrain.rawName = rawName;
    doc.terrain.rawData = getBytes(rawEntry);
  }

  // Line 3: CLR
  const clrName = lvl.clrName;
  const clrEntry = resolveTrackDataAsset(podIndex, clrName);
  if (clrEntry) {
    doc.terrain.clrName = clrName;
    doc.terrain.clrData = getBytes(clrEntry);
  }

  // Line 4: ACT palette
  const actName = lvl.actName;
  const actEntry = resolveAsset(podIndex, actName);
  if (actEntry) {
    doc.palette = getBytes(actEntry).slice(0, 768);
    // Load fog map
    const fogMapName = replaceExtension(actName, ".MAP");
    const fogEntry = resolveAsset(podIndex, "FOG/" + archiveTitle(fogMapName)) ?? resolveAsset(podIndex, fogMapName);
    if (fogEntry) doc.fogMap = getBytes(fogEntry);
  }

  // Line 5: TEX texture list
  const texName = lvl.texName;
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
  if (lvl.skyRawName) {
    const skyRawName = lvl.skyRawName;
    const skyEntry = resolveArtAsset(podIndex, skyRawName);
    if (skyEntry) {
      const skyActName = lvl.skyActName;
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

  /*
    Music (line 14), fog (15), LTE (16).

    The music name is taken from the line, not from whether the file resolves in this archive.
    MTM 2 keeps its soundtrack in MUSIC.POD rather than in the track POD - every one of its
    levels names a .WAV at this line (aztec.wav, rockx.wav, surf.wav ...) and none of them
    ship beside the track - so resolving first reported "no music" for the entire game. MTM 1
    and CPR name a .MOD that does sit in the same archive, which is why this only ever showed
    up on MTM 2.
  */
  if (lvl.musicName !== null) {
    const musicName = normalizeArchiveName(lvl.musicName);
    if (musicName && !musicName.startsWith("NULL.")) doc.musicName = archiveTitle(lvl.musicName);
  }
  if (lvl.lteName !== null) {
    const lteEntry = resolveAsset(podIndex, lvl.lteName);
    if (lteEntry) { doc.terrain.lteName = lvl.lteName; doc.terrain.lteData = getBytes(lteEntry); }
  }

  // Lighting
  if (lvl.lineCount > 17) doc.sunVector = lvl.sunVector ?? doc.sunVector;
  if (lvl.shadowIntensity !== null) doc.shadowIntensity = lvl.shadowIntensity;
  if (lvl.lineCount > 19) doc.sunPosition = lvl.sunPosition ?? doc.sunPosition;
  if (lvl.sunIntensity !== null) doc.sunIntensity = lvl.sunIntensity;
  if (lvl.levelValue !== null) doc.levelValue = lvl.levelValue;

  // Water level, in legacy height steps.
  if (lvl.waterHeight !== null) doc.waterLevel = Math.round(lvl.waterHeight / 4);

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

function applySitMetadata(sit, doc) {
  if (sit.trackName !== null) doc.trackName = sit.trackName;
  if (sit.localeName !== null) doc.localeName = sit.localeName;
  if (sit.trackTypeCode !== null) doc.trackType = sitTrackTypeName(sit.trackTypeCode, doc.origin);
  if (sit.redbookTrack !== null) doc.redbookTrack = sit.redbookTrack;
  if (sit.ambientSound !== null) {
    doc.ambientSound = sit.ambientSound;
    doc.weatherMask = sit.weatherMask;
  }
  // Ramps, boxes, then the top-crush parts (see BOXTYPE_CRUSH in OpenPhotex).
  doc.boxes.push(...sit.boxes);
  if (sit.primaryCourse) doc.primaryCourse.segments.push(...sit.primaryCourse.segments);
  doc.extendedCourses.push(...sit.extendedCourses);
  // Stadium (arena) then Backdrop; the two are alternatives, and which one wins is settled
  // where the model is actually loaded.
  if (sit.arena) doc.arena = sit.arena;
  if (sit.backdropModelNames) {
    doc.backdropModelNames = sit.backdropModelNames;
    doc.backdropModelName = doc.backdropModelNames[0] ?? null;
  }
  doc.trucks.push(...sit.trucks);
}

// ── Helpers ──────────────────────────────────────────────────────

function loadTexList(podIndex, getBytes, texEntry, doc, preserveSlots) {
  for (const name of parseTexList(getBytes(texEntry))) {
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
  for (const { name, type, depth } of parseTtyEntries(bytes)) {
    const tex = doc.textures.find((t) => archiveTitle(t.name) === archiveTitle(name));
    if (tex) { tex.type = type; tex.depth = depth; }
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
