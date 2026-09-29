import { resolveAsset } from "./pod-format.js";
import { replaceExtension, archiveTitle, normalizeArchiveName } from "../shared/path-utils.js";
import { loadGroundBoxes } from "./gbox-loader.js";
import { loadUndergroundLayers, HB_UNDERGROUND_BIAS } from "./hb-underground.js";
import { loadDefObjects } from "./def-loader.js";
import { decodeBinModel } from "./bin-decoder.js";
import { podRawSide } from "./texture-decoder.js";
import { parseNavPoints } from "./nav-parser.js";
import { parseHbNavPoints } from "./hb-nav-parser.js";
import { parseHbBriefing } from "./hb-briefing.js";
import { parseTunnelDefs } from "./tdf-parser.js";
import { parsePowerups } from "./pup-parser.js";
import { parseAnimations } from "./ani-parser.js";
import {
  SKY_PALETTE_FIRST_SLOT, isNullAssetName, parseTexList, parseTty as parseTtyEntries, parseTvLvl, skyGradient, skyHorizon,
  tvLvlFallbackName,
} from "../vendor/openphotex/index.js";

/*
  Terminal Velocity, Fury3 and Hellbender levels, from a .LVL entry in a POD archive.

  Reading the .LVL and its side files is OpenPhotex's (parseTvLvl, parseDef, the .NAV/.PUP/
  .TDF/.ANI readers and friends). This file resolves the names they give against the archive
  and assembles the viewer's TrackDoc.
*/

/**
 * Parses TV-family/HB tracks from a primary LVL entry in a POD archive.
 * Returns a partial TrackDoc.
 */
export function parseLvlTrack(podIndex, getBytes, lvlEntry, podComment) {
  const lvl = parseTvLvl(getBytes(lvlEntry));
  const doc = createDoc(podComment, lvl.origin);
  doc.prefix = prefixFromName(lvlEntry.name);

  if (!lvl.complete) {
    doc.trackName = tvLvlFallbackName(lvlEntry.name);
    return doc;
  }

  doc.terrain.gridSize = 256;
  doc.terrain.rawBytesPerCell = 1;
  doc.trackName = lvl.displayName ?? tvLvlFallbackName(lvlEntry.name);

  /*
    Line 2: the RAW heightfield, or a .TNL spine when this is a tunnel level.

    Tunnel interiors are not rendered: they are separate levels that only read as tunnels from
    inside. A surface level's tunnels are surfaced instead as entrance and exit markers, from
    the .TDF on line 9, which is the complete list including the ones the .NAV leaves out.
  */
  const rawOrTnl = lvl.rawOrTnlName;
  if (!isNullAssetName(rawOrTnl) && !rawOrTnl.endsWith(".TNL")) {
    const rawEntry = resolveLvlDataAsset(podIndex, rawOrTnl);
    if (rawEntry) {
      doc.terrain.rawName = rawOrTnl;
      doc.terrain.rawData = getBytes(rawEntry);
    }
  }

  // Line 3: CLR
  const clrName = lvl.clrName;
  if (!isNullAssetName(clrName)) {
    const clrEntry = resolveLvlDataAsset(podIndex, clrName);
    if (clrEntry) {
      doc.terrain.clrName = clrName;
      doc.terrain.clrData = getBytes(clrEntry);
    }
  }

  // Line 4: ACT palette
  const actName = lvl.actName;
  if (!isNullAssetName(actName)) {
    const actEntry = resolveAsset(podIndex, actName);
    if (actEntry) {
      doc.palette = getBytes(actEntry).slice(0, 768);
      // Fog map
      const fogMapTitle = replaceExtension(actName, ".MAP");
      const fogEntry = resolveAsset(podIndex, "FOG/" + archiveTitle(fogMapTitle)) ?? resolveAsset(podIndex, fogMapTitle);
      if (fogEntry) doc.fogMap = getBytes(fogEntry);
    }
  }

  // Line 5: TEX
  const texName = lvl.texName;
  if (!isNullAssetName(texName)) {
    const texEntry = resolveLvlDataAsset(podIndex, texName);
    if (texEntry) {
      loadTexList(podIndex, getBytes, texEntry, doc);
      const ttyEntry = resolveLvlDataAsset(podIndex, replaceExtension(texName, ".TTY"));
      if (ttyEntry) parseTty(getBytes(ttyEntry), doc);
    }
  }

  /*
    Lines 10 and 11: the sky, read the way the engine reads it (GAME.EXE 0x17be0).

    Line 10 names a 64x64 sky texture, or the sentinel STARS.VOX / SPACE.VOX (a 0-byte entry)
    for a star field. Every sky texture in TV, Fury3 and Hellbender is drawn only in palette
    slots 240-254, which are black in every .ACT: the engine fills them at load by opening the
    line 11 ACT, seeking to colour 192 and copying 16 colours into slots 240-255. So one
    shared SKY.RAW is recoloured per level (BLUESKY, DSRTSKY, LAVASKY ...), and the 16th
    colour, slot 255, is the horizon: the engine clears the screen to it before drawing the
    sky, and the last row of the .FOG table maps every colour onto it.
  */
  if (lvl.skyName !== null) {
    const skyName = lvl.skyName;
    const gradient = lvl.skyActName !== null ? readSkyGradient(podIndex, getBytes, lvl.skyActName) : null;
    if (skyName.endsWith(".VOX")) {
      doc.tvSky = { stars: true, gradient: gradient ?? new Uint8Array(48), horizon: [0, 0, 0] };
    } else if (skyName.endsWith(".RAW") && !skyName.startsWith("NULL.")) {
      const skyEntry = resolveAsset(podIndex, skyName);
      if (skyEntry) {
        const skyData = getBytes(skyEntry);
        const skySide = podRawSide(skyData.length) || 64;
        let skyAct;
        if (gradient) {
          skyAct = new Uint8Array(768);
          skyAct.set(gradient, SKY_PALETTE_FIRST_SLOT * 3);
          doc.tvSky = { stars: false, gradient, horizon: skyHorizon(gradient) };
        } else {
          const skyActEntry = resolveAsset(podIndex, replaceExtension(skyName, ".ACT"));
          skyAct = skyActEntry ? getBytes(skyActEntry) : doc.palette;
        }
        doc.skyTexture = { name: skyName, data: skyData, actData: skyAct, width: skySide, height: skySide };
      }
    }
  }

  // Line 12: DEF objects
  if (lvl.defName !== null) {
    const defTitle = lvl.defName;
    if (!isNullAssetName(defTitle)) {
      inferTerrain(doc);  // need gridSize before DEF
      const { boxes, models } = loadDefObjects(podIndex, getBytes, defTitle, doc.terrain.gridSize, doc.origin);
      doc.boxes.push(...boxes);
      for (const [k, v] of Object.entries(models)) doc.models[k] = v;
    }
  }

  /*
    Lines 1, 7, 8, 9 and 13: the map-content side files.

    Read after the DEF because they share its coordinate space and, in the case of .NAV, index
    its placement list. Each parser is total: a malformed side file costs its own marker layer
    and nothing else.

    Hellbender uses the same header slots and the same .PUP, .TDF and .ANI records as
    Terminal Velocity and Fury3, so those three readers are shared. What it does NOT share is
    the placement scale - its coordinates are the .DEF's 16.16 world units rather than the TV
    2^20-per-cell ones - so `origin` is threaded into the two readers that carry positions.

    Its .NAV is a different record shape and gets its own reader; see hb-nav-parser.js. Line 1
    is a Hellbender-only briefing file, `null.txt` in every TV and Fury3 level.
  */
  if (doc.origin === "HB" && lvl.briefingName !== null) {
    const txtName = lvl.briefingName;
    if (!isNullAssetName(txtName)) {
      const txtEntry = resolveLvlDataAsset(podIndex, txtName);
      if (txtEntry) doc.briefing = parseHbBriefing(getBytes(txtEntry));
    }
  }

  if (lvl.pupName !== null) {
    const pupName = lvl.pupName;
    if (!isNullAssetName(pupName)) {
      const pupEntry = resolveLvlDataAsset(podIndex, pupName);
      if (pupEntry) {
        doc.powerups = parsePowerups(getBytes(pupEntry), doc.terrain.gridSize, doc.origin);
        loadPowerupModels(podIndex, getBytes, doc);
      }
    }
  }
  if (lvl.aniName !== null) {
    const aniName = lvl.aniName;
    if (!isNullAssetName(aniName)) {
      const aniEntry = resolveLvlDataAsset(podIndex, aniName);
      if (aniEntry) doc.animations = parseAnimations(getBytes(aniEntry));
    }
  }
  if (lvl.tdfName !== null) {
    const tdfName = lvl.tdfName;
    if (!isNullAssetName(tdfName)) {
      const tdfEntry = resolveLvlDataAsset(podIndex, tdfName);
      if (tdfEntry) doc.tunnels = parseTunnelDefs(getBytes(tdfEntry), doc.terrain.gridSize, doc.origin);
    }
  }
  if (lvl.navName !== null) {
    const navName = lvl.navName;
    if (!isNullAssetName(navName)) {
      const navEntry = resolveLvlDataAsset(podIndex, navName);
      if (navEntry) {
        const navBytes = getBytes(navEntry);
        doc.navPoints = doc.origin === "HB"
          ? parseHbNavPoints(navBytes, doc.terrain.gridSize)
          : parseNavPoints(navBytes, doc.terrain.gridSize);
      }
    }
  }

  // Line 14: music, 15: fog, 16: LTE. Named from the line rather than from whether the file
  // resolves here; see sit-parser.js for the archive that made that distinction matter.
  if (lvl.musicLine !== null) {
    const musicName = normalizeArchiveName(lvl.musicLine);
    if (!isNullAssetName(musicName)) doc.musicName = archiveTitle(lvl.musicLine);
  }
  if (lvl.lteName !== null) {
    const lteEntry = resolveAsset(podIndex, lvl.lteName);
    if (lteEntry) {
      doc.terrain.lteName = lvl.lteName;
      doc.terrain.lteData = getBytes(lteEntry);
    }
  }

  // Lighting
  if (lvl.lineCount > 17) doc.sunVector = lvl.sunVector ?? doc.sunVector;
  if (lvl.shadowIntensity !== null) doc.shadowIntensity = lvl.shadowIntensity;
  if (lvl.lineCount > 19) doc.sunPosition = lvl.sunPosition ?? doc.sunPosition;
  if (lvl.sunIntensity !== null) doc.sunIntensity = lvl.sunIntensity;
  if (lvl.levelValue !== null) doc.levelValue = lvl.levelValue;

  inferTerrain(doc);

  // Ground boxes
  if (doc.terrain.rawData && rawOrTnl && !rawOrTnl.endsWith(".TNL")) {
    doc.groundBoxes = loadGroundBoxes(podIndex, getBytes, rawOrTnl, doc.terrain.gridSize);

    /*
      Hellbender's cavern: a second heightfield pair and a second ground-box layer on the same
      grid, found by stem like the ground boxes above. See hb-underground.js.
    */
    if (doc.origin === "HB") {
      doc.underground = loadUndergroundLayers(podIndex, getBytes, rawOrTnl, doc.terrain.gridSize);
      if (doc.underground) {
        doc.undergroundBoxes = loadGroundBoxes(podIndex, getBytes, rawOrTnl, doc.terrain.gridSize,
          { lower: ".RA4", upper: ".RA5", faces: ".CL2", heightOffset: HB_UNDERGROUND_BIAS });
      }
    }
  }

  return doc;
}

// ── Helpers ──────────────────────────────────────────────────────

/*
  The 16-colour sky gradient from a level's line 11 ACT (see skyGradient in OpenPhotex). Null
  when the ACT is missing.
*/
function readSkyGradient(podIndex, getBytes, actLine) {
  const actName = normalizeArchiveName(actLine);
  if (isNullAssetName(actName)) return null;
  const entry = resolveAsset(podIndex, actName);
  return entry ? skyGradient(getBytes(entry)) : null;
}

/*
  Decodes the pickup model for each typed powerup, when the open archive has it.

  The stock POWER*.BIN models ship in STARTUP.POD, not in a level archive, so on a stock
  TV.pod or FURY3.POD this finds nothing and the powerups stay markers. A pickup whose model
  is missing just keeps its modelName with no entry in doc.models, and the scene draws the
  marker alone.
*/
function loadPowerupModels(podIndex, getBytes, doc) {
  for (const powerup of doc.powerups ?? []) {
    const name = powerup.modelName;
    if (!name || doc.models[name]) continue;
    const entry = resolveAsset(podIndex, name);
    if (entry) doc.models[name] = decodeBinModel(getBytes(entry), name, doc.origin);
  }
}

function loadTexList(podIndex, getBytes, texEntry, doc) {
  for (const name of parseTexList(getBytes(texEntry))) {
    const dataEntry = resolveTerrainTextureAsset(podIndex, name);
    const tex = { name, data: null, width: 64, height: 64, type: 0, depth: 0 };
    if (dataEntry) {
      tex.data = getBytes(dataEntry);
      // Any square power-of-two tile 32..1024, not just 64 and 256 (fork: Pod1RawSide).
      tex.width = podRawSide(tex.data.length) || 64;
      tex.height = tex.width;
    }
    const texActEntry = resolveTerrainTextureAsset(podIndex, replaceExtension(name, ".ACT"));
    if (texActEntry) tex.actData = getBytes(texActEntry);
    doc.textures.push(tex);
  }
}

function resolveTerrainTextureAsset(podIndex, name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized) return null;
  if (/[\\/]/.test(normalized)) return resolveAsset(podIndex, normalized);
  const title = archiveTitle(normalized);
  return resolveAsset(podIndex, "ART/" + title) ?? resolveAsset(podIndex, normalized);
}

function resolveLvlDataAsset(podIndex, name) {
  const normalized = normalizeArchiveName(name);
  if (!normalized) return null;
  if (/[\\/]/.test(normalized)) return resolveAsset(podIndex, normalized);
  const title = archiveTitle(normalized);
  return resolveAsset(podIndex, "DATA/" + title) ?? resolveAsset(podIndex, normalized);
}

function parseTty(bytes, doc) {
  for (const { name, type, depth } of parseTtyEntries(bytes)) {
    const tex = doc.textures.find((t) => archiveTitle(t.name) === archiveTitle(name));
    if (tex) { tex.type = type; tex.depth = depth; }
  }
}

function inferTerrain(doc) {
  const { rawData, clrData } = doc.terrain;
  let gridSize = 256;
  let rawBytesPerCell = 1;
  if (rawData) {
    const n1 = Math.round(Math.sqrt(rawData.length));
    if (n1 * n1 === rawData.length && n1 >= 64 && n1 <= 2048) { gridSize = n1; rawBytesPerCell = 1; }
    else { const n2 = Math.round(Math.sqrt(rawData.length / 2)); if (n2 * n2 * 2 === rawData.length && n2 >= 64) { gridSize = n2; rawBytesPerCell = 2; } }
  } else if (clrData) {
    const n1 = Math.round(Math.sqrt(clrData.length));
    if (n1 * n1 === clrData.length && n1 >= 64) gridSize = n1;
    else { const n2 = Math.round(Math.sqrt(clrData.length / 2)); if (n2 * n2 * 2 === clrData.length && n2 >= 64) gridSize = n2; }
  }
  doc.terrain.gridSize = gridSize;
  doc.terrain.rawBytesPerCell = rawBytesPerCell;
  if (clrData) {
    const cells = gridSize * gridSize;
    doc.terrain.clrBytesPerCell = clrData.length === cells ? 1 : 2;
  }
}

function prefixFromName(name) {
  const title = archiveTitle(name).toUpperCase();
  const dot = title.lastIndexOf(".");
  const base = dot >= 0 ? title.slice(0, dot) : title;
  return base.slice(0, Math.min(8, base.length));
}

function createDoc(podComment, origin) {
  return {
    origin,
    podComment: podComment ?? "",
    trackName: "", localeName: "", trackType: "UNKNOWN",
    // The TV-family .LVL header carries none of these four; see sit-parser.js for why they
    // are null rather than defaulted.
    gameType: "", weatherMask: null, musicName: "", prefix: "",
    ambientSound: null, redbookTrack: null, levelValue: 0,
    sunVector: [0, -1, 0], sunPosition: [0, 1000, 0],
    sunIntensity: 255, shadowIntensity: 128,
    waterLevel: null,
    terrain: { gridSize: 256, rawBytesPerCell: 1, clrBytesPerCell: 1, rawName: "", clrName: "", lteName: "", rawData: null, clrData: null, lteData: null },
    palette: null,
    textures: [],
    modelTextures: [],
    models: {},
    boxes: [],
    groundBoxes: [],
    underground: null,
    undergroundBoxes: [],
    primaryCourse: { segments: [] },
    extendedCourses: [],
    trucks: [],
    backdropModelName: null,
    skyTexture: null,
    fogMap: null,
    briefing: null,
    navPoints: [],
    tunnels: [],
    powerups: [],
    animations: [],
  };
}
