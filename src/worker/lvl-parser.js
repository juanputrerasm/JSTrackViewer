import { resolveAsset } from "./pod-format.js";
import { replaceExtension, archiveTitle, normalizeArchiveName } from "../shared/path-utils.js";
import { loadGroundBoxes } from "./gbox-loader.js";
import { loadDefObjects } from "./def-loader.js";
import { podRawSide } from "./texture-decoder.js";

/**
 * Parses TV-family/HB tracks from a primary LVL entry in a POD archive.
 * Returns a partial TrackDoc.
 */
export function parseLvlTrack(podIndex, getBytes, lvlEntry, podComment) {
  const lvlText = new TextDecoder("latin1").decode(getBytes(lvlEntry));
  const lines = toLines(lvlText);
  const doc = createDoc(podComment, inferLvlOrigin(lines));
  doc.prefix = prefixFromName(lvlEntry.name);

  if (lines.length < 22) {
    doc.trackName = prettyLvlName(lvlEntry.name);
    return doc;
  }

  doc.terrain.gridSize = 256;
  doc.terrain.rawBytesPerCell = 1;
  doc.trackName = displayNameForLvl(lines, lvlEntry.name);

  // Line 2: RAW terrain (or TNL tunnel network - skip for now)
  const rawOrTnl = normalizeArchiveName(lines[2]);
  if (rawOrTnl && !rawOrTnl.startsWith("NULL.") && !rawOrTnl.endsWith(".TNL")) {
    const rawEntry = resolveLvlDataAsset(podIndex, rawOrTnl);
    if (rawEntry) {
      doc.terrain.rawName = rawOrTnl;
      doc.terrain.rawData = getBytes(rawEntry);
    }
  }

  // Line 3: CLR
  const clrName = normalizeArchiveName(lines[3]);
  if (clrName && !clrName.startsWith("NULL.")) {
    const clrEntry = resolveLvlDataAsset(podIndex, clrName);
    if (clrEntry) {
      doc.terrain.clrName = clrName;
      doc.terrain.clrData = getBytes(clrEntry);
    }
  }

  // Line 4: ACT palette
  const actName = normalizeArchiveName(lines[4]);
  if (actName && !actName.startsWith("NULL.")) {
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
  const texName = normalizeArchiveName(lines[5]);
  if (texName && !texName.startsWith("NULL.")) {
    const texEntry = resolveLvlDataAsset(podIndex, texName);
    if (texEntry) {
      loadTexList(podIndex, getBytes, texEntry, doc);
      const ttyEntry = resolveLvlDataAsset(podIndex, replaceExtension(texName, ".TTY"));
      if (ttyEntry) parseTty(getBytes(ttyEntry), doc);
    }
  }

  // Line 10: sky RAW texture
  if (lines.length > 10) {
    const skyName = normalizeArchiveName(lines[10]);
    if (skyName.endsWith(".RAW") && !skyName.startsWith("NULL.")) {
      const skyEntry = resolveAsset(podIndex, skyName);
      if (skyEntry) {
        const skyData = getBytes(skyEntry);
        const skyActEntry = resolveAsset(podIndex, replaceExtension(skyName, ".ACT"));
        const skyAct = skyActEntry ? getBytes(skyActEntry) : doc.palette;
        const skySide = podRawSide(skyData.length) || 64;
        doc.skyTexture = { name: skyName, data: skyData, actData: skyAct, width: skySide, height: skySide };
      }
    }
  }

  // Line 12: DEF objects
  if (lines.length > 12) {
    const defTitle = normalizeArchiveName(lines[12]);
    if (defTitle && !defTitle.startsWith("NULL.")) {
      inferTerrain(doc);  // need gridSize before DEF
      const { boxes, models } = loadDefObjects(podIndex, getBytes, defTitle, doc.terrain.gridSize, doc.origin);
      doc.boxes.push(...boxes);
      for (const [k, v] of Object.entries(models)) doc.models[k] = v;
    }
  }

  // Line 14: music, 15: fog, 16: LTE
  if (lines.length > 14) {
    const musicEntry = resolveAsset(podIndex, normalizeArchiveName(lines[14]));
    if (musicEntry) doc.musicName = archiveTitle(lines[14]);
  }
  if (lines.length > 16) {
    const lteEntry = resolveAsset(podIndex, normalizeArchiveName(lines[16]));
    if (lteEntry) {
      doc.terrain.lteName = normalizeArchiveName(lines[16]);
      doc.terrain.lteData = getBytes(lteEntry);
    }
  }

  // Lighting
  if (lines.length > 17) doc.sunVector = parseIntTriplet(lines[17]) ?? doc.sunVector;
  if (lines.length > 18) doc.shadowIntensity = parseLeadingInt(lines[18]);
  if (lines.length > 19) doc.sunPosition = parseIntTriplet(lines[19]) ?? doc.sunPosition;
  if (lines.length > 20) doc.sunIntensity = parseLeadingInt(lines[20]);
  if (lines.length > 21) doc.levelValue = parseLeadingInt(lines[21]);

  inferTerrain(doc);

  // Ground boxes
  if (doc.terrain.rawData && rawOrTnl && !rawOrTnl.endsWith(".TNL")) {
    doc.groundBoxes = loadGroundBoxes(podIndex, getBytes, rawOrTnl, doc.terrain.gridSize);
  }

  return doc;
}

// ── Helpers ──────────────────────────────────────────────────────

function loadTexList(podIndex, getBytes, texEntry, doc) {
  const text = new TextDecoder("latin1").decode(getBytes(texEntry));
  const lines = toNonEmptyLines(text);
  const count = parseInt(lines[0] ?? "0", 10);
  for (let i = 0; i < count && i + 1 < lines.length; i++) {
    const name = normalizeArchiveName(lines[i + 1]);
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

function parseIntTriplet(value) {
  const parts = value.split(",");
  if (parts.length < 3) return null;
  return [parseInt(parts[0].trim(), 10), parseInt(parts[1].trim(), 10), parseInt(parts[2].trim(), 10)];
}

function parseLeadingInt(value) { return parseInt((value ?? "").trim(), 10) || 0; }

function prefixFromName(name) {
  const title = archiveTitle(name).toUpperCase();
  const dot = title.lastIndexOf(".");
  const base = dot >= 0 ? title.slice(0, dot) : title;
  return base.slice(0, Math.min(8, base.length));
}

function displayNameForLvl(lines, entryName) {
  if (lines.length > 22) {
    const candidate = lines[22].trim();
    if (candidate && !candidate.startsWith("!") && !candidate.startsWith(";") && candidate.toLowerCase() !== "null") return candidate;
  }
  return prettyLvlName(entryName);
}

function inferLvlOrigin(lines) {
  return lines.some((line) => line.trim() === "!New ground additions") ? "HB" : "TV/F3";
}

function prettyLvlName(name) {
  const title = archiveTitle(name);
  return title.endsWith(".LVL") ? title.slice(0, -4) : title;
}

function toLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function toNonEmptyLines(text) {
  return toLines(text).map((l) => l.trim()).filter(Boolean);
}

function createDoc(podComment, origin) {
  return {
    origin,
    podComment: podComment ?? "",
    trackName: "", localeName: "", trackType: "UNKNOWN",
    gameType: "", weatherMask: 0xFFFF, musicName: "", prefix: "",
    ambientSound: 0, levelValue: 0,
    sunVector: [0, -1, 0], sunPosition: [0, 1000, 0],
    sunIntensity: 255, shadowIntensity: 128,
    waterLevel: 0,
    terrain: { gridSize: 256, rawBytesPerCell: 1, clrBytesPerCell: 1, rawName: "", clrName: "", lteName: "", rawData: null, clrData: null, lteData: null },
    palette: null,
    textures: [],
    modelTextures: [],
    models: {},
    boxes: [],
    groundBoxes: [],
    primaryCourse: { segments: [] },
    extendedCourses: [],
    trucks: [],
    backdropModelName: null,
    skyTexture: null,
    fogMap: null,
  };
}
