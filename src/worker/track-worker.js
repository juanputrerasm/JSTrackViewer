import { indexPodFile, readPodEntryBytes } from "./pod-format.js";
import { listTrackChoicesAsync } from "./track-loader.js";

let podIndex = null;
let podOpfsPath = null;

// Cache for POD entry bytes (keyed by "offset_length")
const _byteCache = new Map();

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    let result;
    if (type === "indexPod") {
      podOpfsPath = payload.opfsPodPath;
      _byteCache.clear();
      podIndex = await indexPodFile(podOpfsPath);
      podIndex.comment = podIndex.comment ?? "";
      result = { comment: podIndex.comment, entryCount: podIndex.entries.length };

    } else if (type === "listTrackChoices") {
      if (!podIndex) throw new Error("No POD indexed.");
      const choices = await listTrackChoicesAsync(podIndex, podOpfsPath);
      result = { choices };

    } else if (type === "loadTrack") {
      if (!podIndex) throw new Error("No POD indexed.");
      const { choiceIndex, heightScale } = payload;
      const choices = await listTrackChoicesAsync(podIndex, podOpfsPath);
      if (choiceIndex < 0 || choiceIndex >= choices.length) throw new Error(`Invalid choice: ${choiceIndex}`);
      result = await loadTrackAsync(podIndex, podOpfsPath, choices[choiceIndex], heightScale ?? 4);

    } else {
      throw new Error(`Unknown message type: ${type}`);
    }

    const transfers = collectTransfers(result);
    self.postMessage({ id, ok: true, payload: result }, transfers);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};

async function getBytes(entry) {
  const k = entry.offset + "_" + entry.length;
  const cached = _byteCache.get(k);
  if (cached) return cached;
  const bytes = await readPodEntryBytes(podOpfsPath, entry);
  _byteCache.set(k, bytes);
  return bytes;
}

async function loadTrackAsync(podIndex, opfsPath, choice, heightScale) {
  const { parseSitTrack } = await import("./sit-parser.js");
  const { parseLvlTrack } = await import("./lvl-parser.js");
  const { buildTerrainMesh } = await import("./terrain-builder.js");
  const { decodeBinModel } = await import("./bin-decoder.js");
  const { decodeRawTexture } = await import("./texture-decoder.js");
  const { resolveAsset } = await import("./pod-format.js");
  const { replaceExtension } = await import("../shared/path-utils.js");

  // Pre-fetch all entries eagerly so parsers can call getBytes synchronously via cache
  await Promise.all(
    podIndex.entries.map((entry) => getBytes(entry).catch(() => {}))
  );

  // Sync accessor (safe because all entries are now cached)
  const syncGetBytes = (entry) => {
    const k = entry.offset + "_" + entry.length;
    const v = _byteCache.get(k);
    if (!v) throw new Error(`Cache miss for ${entry.name} (offset ${entry.offset})`);
    return v;
  };

  let doc;
  if (choice.format === "SIT") {
    doc = parseSitTrack(podIndex, syncGetBytes, choice.entry, podIndex.comment);
  } else {
    const origin = detectTvOrigin(podIndex);
    doc = parseLvlTrack(podIndex, syncGetBytes, choice.entry, podIndex.comment, origin);
  }

  // Hydrate BIN models
  const modelOrigin = doc.origin;
  for (const box of doc.boxes) {
    const name = box.modelName;
    if (!name || doc.models[name]) continue;
    const entry = resolveAsset(podIndex, name);
    if (entry) doc.models[name] = decodeBinModel(syncGetBytes(entry), name, modelOrigin);
  }
  if (doc.backdropModelName && !doc.models[doc.backdropModelName]) {
    const entry = resolveAsset(podIndex, doc.backdropModelName);
    if (entry) doc.models[doc.backdropModelName] = decodeBinModel(syncGetBytes(entry), doc.backdropModelName, modelOrigin);
  }

  // Model textures
  const modelTextures = [];
  const seen = new Set();
  for (const model of Object.values(doc.models)) {
    for (const texName of model.textureNames ?? []) {
      if (seen.has(texName)) continue;
      seen.add(texName);
      const entry = resolveAsset(podIndex, texName) ?? resolveAsset(podIndex, replaceExtension(texName, ".RAW"));
      if (!entry) continue;
      try {
        const rawBytes = syncGetBytes(entry);
        const actEntry = resolveAsset(podIndex, replaceExtension(texName, ".ACT"));
        const actBytes = actEntry ? syncGetBytes(actEntry) : doc.palette;
        const decoded = decodeRawTexture(rawBytes, actBytes, texName);
        modelTextures.push({ name: texName, rgba: decoded.rgba.buffer, width: decoded.width, height: decoded.height });
      } catch { /**/ }
    }
  }

  const raceTrackTextures = [];
  for (const tex of doc.raceTrackTextures ?? []) {
    if (!tex?.data) {
      raceTrackTextures.push({ name: tex?.name ?? "", flags: tex?.flags ?? 0, rgba: null, width: 0, height: 0 });
      continue;
    }
    try {
      const decoded = decodeRawTexture(tex.data, tex.actData ?? doc.palette, tex.name);
      raceTrackTextures.push({
        name: tex.name,
        flags: tex.flags ?? 0,
        rgba: decoded.rgba.buffer,
        width: decoded.width,
        height: decoded.height,
      });
    } catch {
      raceTrackTextures.push({ name: tex.name, flags: tex.flags ?? 0, rgba: null, width: 0, height: 0 });
    }
  }

  // Terrain mesh
  let terrainMesh = null;
  if (doc.terrain.rawData) {
    terrainMesh = buildTerrainMesh(doc.terrain, doc.palette, doc.textures, heightScale, doc.origin);
  }

  // Sky texture
  let skyTextureDecoded = null;
  if (doc.skyTexture?.data) {
    try {
      const decoded = decodeRawTexture(doc.skyTexture.data, doc.skyTexture.actData ?? doc.palette, doc.skyTexture.name);
      skyTextureDecoded = { rgba: decoded.rgba.buffer, width: decoded.width, height: decoded.height };
    } catch { /**/ }
  }

  const stats = {
    gridSize: doc.terrain.gridSize,
    textureCount: doc.textures.length,
    objectCount: doc.boxes.length,
    groundBoxCount: doc.groundBoxes.length,
    primarySegmentCount: doc.primaryCourse.segments.length,
    extendedCourseCount: doc.extendedCourses.length,
  };

  const models = {};
  for (const [k, model] of Object.entries(doc.models)) {
    models[k] = {
      name: model.name, format: model.format, baseZ: model.baseZ, magnifyPower: model.magnifyPower,
      anchor: model.anchor ?? { x: 0, y: 0, z: 0 },
      meshes: (model.meshes ?? []).map((m) => ({
        textureName: m.textureName, color: m.color, transparent: m.transparent === true,
        positions: m.positions.buffer, normals: m.normals.buffer, uvs: m.uvs.buffer,
      })),
    };
  }

  return {
    origin: doc.origin, podComment: doc.podComment,
    trackName: doc.trackName || choice.name,
    localeName: doc.localeName, trackType: doc.trackType,
    gameType: doc.gameType, weatherMask: doc.weatherMask,
    musicName: doc.musicName, prefix: doc.prefix,
    ambientSound: doc.ambientSound, waterLevel: doc.waterLevel,
    sunVector: doc.sunVector, sunIntensity: doc.sunIntensity, shadowIntensity: doc.shadowIntensity,
    terrain: terrainMesh ? {
      ...terrainMesh,
      rawData: doc.terrain.rawData ? doc.terrain.rawData.slice().buffer : null,
      rawBytesPerCell: doc.terrain.rawBytesPerCell ?? 1,
    } : null,
    skyTexture: skyTextureDecoded,
    backdropModelName: doc.backdropModelName ?? null,
    primaryCourse: serializeCourse(doc.primaryCourse),
    extendedCourses: doc.extendedCourses.map(serializeCourse),
    boxes: doc.boxes.map((b) => ({ ...b, position: [...b.position] })),
    groundBoxes: doc.groundBoxes,
    raceTrackTextures,
    raceTrackSurfaces: doc.raceTrackSurfaces ?? [],
    trucks: doc.trucks,
    models, modelTextures, stats,
  };
}

function serializeCourse(course) {
  return {
    segments: (course?.segments ?? []).map((s) => ({
      start: [...(s.start ?? [0, 0, 0])],
      end:   [...(s.end   ?? [0, 0, 0])],
      speedLimit: s.speedLimit ?? 0,
      trackWidth: s.trackWidth ?? 64,
    })),
  };
}

function detectTvOrigin(podIndex) {
  const comment = (podIndex.comment ?? "").toUpperCase();
  if (comment.includes("HELLBENDER")) return "HB";
  if (comment.includes("FURY")) return "F3";
  const hb = podIndex.entries.some((e) => e.normalizedName.includes("HELLBENDER"));
  if (hb) return "HB";
  const f3 = podIndex.entries.some((e) => e.normalizedName.includes("FURY3") || e.normalizedName.includes("FURY 3"));
  if (f3) return "F3";
  return "TV";
}

function collectTransfers(obj) {
  const transfers = [];
  if (!obj || typeof obj !== "object") return transfers;
  for (const value of Object.values(obj)) {
    if (value instanceof ArrayBuffer) transfers.push(value);
    else if (value && typeof value === "object") transfers.push(...collectTransfers(value));
  }
  return transfers;
}
