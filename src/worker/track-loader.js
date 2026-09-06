import { findSitEntries, findLvlEntries, readPodEntryBytes, resolveAsset } from "./pod-format.js";
import { parseSitTrack } from "./sit-parser.js";
import { parseLvlTrack } from "./lvl-parser.js";
import { buildTerrainMesh } from "./terrain-builder.js";
import { decodeBinModel } from "./bin-decoder.js";
import { decodeRawTexture } from "./texture-decoder.js";
import { archiveTitle, normalizeArchiveName } from "../shared/path-utils.js";

/**
 * Lists available tracks in a POD index.
 * Returns [{name, index, format}]
 * For LVL-based (TV/F3/HB) PODs, filters out tunnel interior levels.
 */
export function listTrackChoices(podIndex) {
  const sitEntries = findSitEntries(podIndex);
  if (sitEntries.length > 0) {
    return sitEntries.map((e, i) => ({ name: archiveTitle(e.name).replace(/\.SI[T2]$/i, ""), index: i, format: "SIT", entry: e }));
  }
  const lvlEntries = findLvlEntries(podIndex);
  const filtered = lvlEntries.filter((e) => {
    const norm = normalizeArchiveName(e.name);
    return !norm.includes("DEMO/") && !norm.includes("INTRO/") && !norm.includes("SEQUENCE/");
  });
  return (filtered.length ? filtered : lvlEntries).map((e, i) => ({
    name: archiveTitle(e.name).replace(/\.LVL$/i, ""), index: i, format: "LVL", entry: e,
  }));
}

/**
 * Async version that also filters tunnel LVL entries by reading their header.
 */
export async function listTrackChoicesAsync(podIndex, opfsPath) {
  const sitEntries = findSitEntries(podIndex);
  if (sitEntries.length > 0) {
    const choices = [];
    for (let i = 0; i < sitEntries.length; i++) {
      const e = sitEntries[i];
      const fileName = archiveTitle(e.name);
      choices.push({
        name: await readSitDisplayName(opfsPath, e) ?? fileName.replace(/\.SI[T2]$/i, ""),
        fileName,
        index: i,
        format: "SIT",
        entry: e,
      });
    }
    return choices;
  }
  const lvlEntries = findLvlEntries(podIndex);
  const filtered = lvlEntries.filter((e) => {
    const norm = normalizeArchiveName(e.name);
    return !norm.includes("DEMO/") && !norm.includes("INTRO/") && !norm.includes("SEQUENCE/");
  });
  const candidates = filtered.length ? filtered : lvlEntries;

  // Filter tunnel levels by reading the third line of each LVL header
  const surface = [];
  for (const e of candidates) {
    try {
      // Read only first 512 bytes - enough for the header lines
      const partialEntry = { ...e, length: Math.min(e.length, 512) };
      const bytes = await readPodEntryBytes(opfsPath, partialEntry);
      const text = new TextDecoder("latin1").decode(bytes);
      const line2 = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")[2]?.trim().toUpperCase() ?? "";
      if (!line2.endsWith(".TNL")) surface.push(e);
    } catch {
      surface.push(e);  // include on read error
    }
  }
  return surface.map((e, i) => ({
    name: archiveTitle(e.name).replace(/\.LVL$/i, ""), fileName: archiveTitle(e.name), index: i, format: "LVL", entry: e,
  }));
}

async function readSitDisplayName(opfsPath, entry) {
  try {
    const bytes = await readPodEntryBytes(opfsPath, entry);
    const lines = new TextDecoder("latin1")
      .decode(bytes)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim());
    const idx = lines.findIndex((line) => line === "!Race Track Name");
    const name = idx >= 0 ? lines[idx + 1]?.trim() : "";
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Loads a track from a POD index, given a choice from listTrackChoices.
 * Returns a serializable trackResult with transferable terrain buffers.
 */
export async function loadTrack(podIndex, getBytes, choice, heightScale) {
  const hs = heightScale ?? 4;
  let doc;

  if (choice.format === "SIT") {
    doc = parseSitTrack(podIndex, getBytes, choice.entry, podIndex.comment);
  } else {
    doc = parseLvlTrack(podIndex, getBytes, choice.entry, podIndex.comment);
  }

  // Hydrate BIN models for boxes
  hydrateModels(podIndex, getBytes, doc);

  // Decode model textures (unique textures referenced by models)
  const modelTextures = decodeModelTextures(podIndex, getBytes, doc);

  const terrainHeightScale = effectiveTerrainHeightScale(doc.origin, hs);

  // Build terrain geometry
  let terrainMesh = null;
  if (doc.terrain.rawData) {
    terrainMesh = buildTerrainMesh(doc.terrain, doc.palette, doc.textures, terrainHeightScale, doc.origin);
  }

  // Decode sky texture if present
  let skyTextureDecoded = null;
  if (doc.skyTexture?.data) {
    try {
      skyTextureDecoded = decodeRawTexture(doc.skyTexture.data, doc.skyTexture.actData ?? doc.palette, doc.skyTexture.name);
    } catch { /**/ }
  }

  // Compute stats
  const stats = {
    gridSize: doc.terrain.gridSize,
    textureCount: doc.textures.length,
    objectCount: doc.boxes.length,
    groundBoxCount: doc.groundBoxes.length,
    primarySegmentCount: doc.primaryCourse.segments.length,
    extendedCourseCount: doc.extendedCourses.length,
  };

  // Prepare serializable result (terrain buffers as transferables)
  const result = {
    origin: doc.origin,
    podComment: doc.podComment,
    trackName: doc.trackName || choice.name,
    localeName: doc.localeName,
    trackType: doc.trackType,
    gameType: doc.gameType,
    weatherMask: doc.weatherMask,
    musicName: doc.musicName,
    prefix: doc.prefix,
    ambientSound: doc.ambientSound,
    waterLevel: doc.waterLevel,
    sunVector: doc.sunVector,
    sunIntensity: doc.sunIntensity,
    shadowIntensity: doc.shadowIntensity,

    terrain: terrainMesh ? {
      ...terrainMesh,
      rawData: doc.terrain.rawData ? doc.terrain.rawData.slice().buffer : null,
      rawBytesPerCell: doc.terrain.rawBytesPerCell ?? 1,
    } : null,
    skyTexture: skyTextureDecoded ? { rgba: skyTextureDecoded.rgba.buffer, width: skyTextureDecoded.width, height: skyTextureDecoded.height } : null,

    primaryCourse: serializeCourse(doc.primaryCourse),
    extendedCourses: doc.extendedCourses.map(serializeCourse),

    boxes: doc.boxes.map((b) => ({ ...b, position: [...b.position] })),
    groundBoxes: doc.groundBoxes.map((g) => ({ ...g })),
    trucks: doc.trucks.map((t) => ({ ...t })),

    models: serializeModels(doc.models),
    modelTextures,

    stats,
  };

  return result;
}

function hydrateModels(podIndex, getBytes, doc) {
  const needed = new Set(doc.boxes.map((b) => b.modelName).filter(Boolean));
  if (doc.backdropModelName) needed.add(doc.backdropModelName);
  for (const name of needed) {
    if (doc.models[name]) continue;
    const entry = resolveAsset(podIndex, name);
    if (entry) {
      const bytes = getBytes(entry);
      doc.models[name] = decodeBinModel(bytes, name);
    }
  }
}

function decodeModelTextures(podIndex, getBytes, doc) {
  const textures = [];
  const seen = new Set();
  const transparentTextureNames = new Set();
  for (const model of Object.values(doc.models)) {
    for (const mesh of model.meshes ?? []) {
      if (mesh.transparent && mesh.textureName) transparentTextureNames.add(mesh.textureName);
    }
  }
  for (const model of Object.values(doc.models)) {
    for (const name of model.textureNames ?? []) {
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = resolveAsset(podIndex, name) ?? resolveAsset(podIndex, name.replace(/\.[^.]+$/, ".RAW"));
      if (!entry) continue;
      const rawBytes = getBytes(entry);
      const actEntry = resolveAsset(podIndex, name.replace(/\.[^.]+$/, ".ACT"));
      const actBytes = actEntry ? getBytes(actEntry) : doc.palette;
      try {
        const options = transparentTextureNames.has(name)
          ? { cutout: true }
          : undefined;
        const decoded = decodeRawTexture(rawBytes, actBytes, name, options);
        textures.push({ name, rgba: decoded.rgba.buffer, width: decoded.width, height: decoded.height });
      } catch { /**/ }
    }
  }
  return textures;
}

function serializeModels(models) {
  const out = {};
  for (const [k, model] of Object.entries(models)) {
    const meshes = (model.meshes ?? []).map((m) => ({
      textureName: m.textureName,
      color: m.color,
      transparent: m.transparent === true,
      positions: m.positions.buffer,
      normals: m.normals.buffer,
      uvs: m.uvs.buffer,
    }));
    out[k] = { name: model.name, format: model.format, baseZ: model.baseZ, magnifyPower: model.magnifyPower, meshes };
  }
  return out;
}

function serializeCourse(course) {
  return { segments: (course?.segments ?? []).map((s) => ({ start: [...s.start], end: [...s.end], speedLimit: s.speedLimit, trackWidth: s.trackWidth })) };
}

function effectiveTerrainHeightScale(origin, requestedHeightScale) {
  return origin === "HB" ? 3 : (requestedHeightScale ?? 4);
}
