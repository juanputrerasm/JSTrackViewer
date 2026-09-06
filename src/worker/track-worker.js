import { indexPodFile, readPodEntryBytes } from "./pod-format.js";
import { listTrackChoicesAsync } from "./track-loader.js";
import { createPaletteResolver, findHdSibling } from "./palette-resolver.js";
import { decodeTrueColorTexture, hdDimensionRefusal } from "./image-decoder.js";

let podIndex = null;
let podOpfsPath = null;

// Cache for POD entry bytes (keyed by "offset_length")
const _byteCache = new Map();

/*
  Announce that the module graph evaluated.

  Without this there is no way to tell "the worker died before it could run" from "the worker
  is alive but slow", and the two look identical: the error event for a module graph that
  failed to link carries an empty message and no filename, because the failure belongs to no
  single script. A stale cached module is the usual cause, and one unresolved import kills the
  whole graph.
*/
self.postMessage({ ready: true });

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  if (id === undefined) return;
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
      result = await loadTrackAsync(podIndex, podOpfsPath, choices[choiceIndex], heightScale ?? 3);

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
    doc = parseLvlTrack(podIndex, syncGetBytes, choice.entry, podIndex.comment);
  }

  // Hydrate BIN models
  const modelOrigin = doc.origin;
  const loadModel = (name) => {
    const entry = resolveAsset(podIndex, name);
    if (!entry) return null;
    return resolveKeyframeModel(decodeBinModel(syncGetBytes(entry), name, modelOrigin),
      (frameName) => {
        const frameEntry = resolveAsset(podIndex, frameName);
        return frameEntry ? decodeBinModel(syncGetBytes(frameEntry), frameName, modelOrigin) : null;
      });
  };
  for (const box of doc.boxes) {
    const name = box.modelName;
    if (!name || doc.models[name]) continue;
    const model = loadModel(name);
    if (model) doc.models[name] = model;
  }
  if (doc.backdropModelName && !doc.models[doc.backdropModelName]) {
    const model = loadModel(doc.backdropModelName);
    if (model) doc.models[doc.backdropModelName] = model;
  }

  /*
    Palette resolution.

    Every 8-bit texture in the track goes through one ordered chain rather than the old
    "same-stem .ACT, else the track palette" pair, because the older titles frequently have
    neither. See palette-resolver.js for the ranking and why it is that order.
  */
  const palettes = createPaletteResolver(podIndex, syncGetBytes, doc.origin, doc.palette);

  /*
    Community Patch 3 HD art.

    A texture may have a true-colour ART\<stem>.PNG or .TGA sibling, and an HD-only pod
    carries no .RAW for it at all. The .RAW name stays the texture's identity throughout, so
    this only ever attaches a decoded image to the slot that name already refers to.

    A source that the engine could not use (not square, not a power of two, outside 32..1024,
    or not the format its extension claims) is refused with a reason and the legacy 8-bit
    tile is used instead. Silently drawing something the game cannot would misrepresent the
    track.
  */
  const hdWarnings = [];
  // Most pods carry no HD art at all. Checking once keeps them from paying for a sibling
  // lookup per texture.
  const podHasHdArt = podIndex.entries.some(
    (e) => e.title.endsWith(".PNG") || e.title.endsWith(".TGA"));
  const hdDecode = async (name) => {
    if (!podHasHdArt) return null;
    const sibling = findHdSibling(podIndex, name);
    if (!sibling) return null;
    try {
      const image = await decodeTrueColorTexture(
        syncGetBytes(sibling.entry), sibling.entry.title, sibling.extension);
      const refusal = hdDimensionRefusal(sibling.entry.title, image.width, image.height);
      if (refusal) { hdWarnings.push(refusal); return null; }
      return { width: image.width, height: image.height, rgba: image.rgba };
    } catch (err) {
      hdWarnings.push(err.message);
      return null;
    }
  };

  for (const tex of doc.textures ?? []) {
    if (!tex?.name) continue;
    tex.hdImage = await hdDecode(tex.name);
  }
  if (doc.skyTexture?.name) doc.skyTexture.hdImage = await hdDecode(doc.skyTexture.name);
  for (const tex of doc.textures ?? []) {
    // An HD slot needs no palette; only the 8-bit path consults one.
    if (!tex?.data || tex.actData || tex.hdImage) continue;
    tex.actData = palettes.paletteFor(tex.name, null, "terrain") ?? undefined;
  }
  for (const tex of doc.raceTrackTextures ?? []) {
    if (!tex?.data || tex.actData) continue;
    tex.actData = palettes.paletteFor(tex.name, null, "terrain") ?? undefined;
  }
  if (doc.skyTexture?.data && !doc.skyTexture.actData) {
    doc.skyTexture.actData = palettes.paletteFor(doc.skyTexture.name, null, "terrain") ?? undefined;
  }

  // Model textures
  const modelTextures = [];
  const seen = new Set();
  const transparentTextureNames = new Set();
  for (const model of Object.values(doc.models)) {
    for (const mesh of model.meshes ?? []) {
      // `transparent` already accounts for both the legacy 0x11 / 0x33 face types and a
      // material's BLEND / ALPHATEST / TEXSOLID flags.
      if (mesh.transparent && mesh.textureName) transparentTextureNames.add(mesh.textureName);
    }
  }
  for (const model of Object.values(doc.models)) {
    for (const texName of model.textureNames ?? []) {
      if (seen.has(texName)) continue;
      seen.add(texName);
      // The HD sibling wins where there is one; an HD-only pod has no .RAW to fall back to.
      const hd = await hdDecode(texName);
      if (hd) {
        modelTextures.push({
          name: texName,
          rgba: hd.rgba.buffer,
          width: hd.width,
          height: hd.height,
        });
        continue;
      }
      const entry = resolveAsset(podIndex, texName) ?? resolveAsset(podIndex, replaceExtension(texName, ".RAW"));
      if (!entry) continue;
      try {
        const rawBytes = syncGetBytes(entry);
        const actBytes = palettes.paletteFor(texName, entry, "model") ?? doc.palette;
        // Cutout applies only to textures used by a 0x11 / 0x33 face; the key is
        // palette-black, decided inside decodeRawTexture.
        const options = transparentTextureNames.has(texName) ? { cutout: true } : undefined;
        const decoded = decodeRawTexture(rawBytes, actBytes, texName, options);
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

  const terrainHeightScale = effectiveTerrainHeightScale(doc.origin, heightScale);

  // Terrain mesh
  let terrainMesh = null;
  if (doc.terrain.rawData) {
    terrainMesh = buildTerrainMesh(doc.terrain, doc.palette, doc.textures, terrainHeightScale, doc.origin);
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

  // A model whose record walk stopped early is a valid model with fewer polygons, and nothing
  // about the picture says so. Surface it rather than letting it pass silently.
  const modelWarnings = [];
  for (const model of Object.values(doc.models)) {
    if (model.incomplete) modelWarnings.push(`${model.name}: ${model.loadWarning}`);
    for (const w of model.warnings ?? []) modelWarnings.push(`${model.name}: ${w}`);
  }
  if (modelWarnings.length) {
    console.warn(`[JSTrackViewer] ${modelWarnings.length} model warning(s):\n  ` + modelWarnings.join("\n  "));
  }
  stats.modelWarningCount = modelWarnings.length;
  stats.paletteSources = palettes.sourceSummary();
  stats.hdTextureCount = modelTextures.length
    ? modelTextures.filter((t) => t.width > 256 || t.height > 256).length
    : 0;
  if (hdWarnings.length) {
    console.warn(`[JSTrackViewer] ${hdWarnings.length} HD texture(s) refused:\n  `
      + hdWarnings.join("\n  "));
  }
  stats.hdWarnings = hdWarnings;

  /*
    DATA\<stem>.TXV, the Community Patch 3 track version record.

    Plain ASCII, CRLF, key=value, '#' comments. Six keys are the fork's own (formatVersion,
    tool, toolVersion, built, legacyFallback, hdTextures) and anything else is a newer tool's
    key that this build has never heard of. A viewer only reports it, so unknown keys are
    kept rather than dropped: tolerating them is the whole forward-compatibility mechanism.

    formatVersion 2 means the track uses the box types CP3 added (BOXTYPE_LIGHT /
    BOXTYPE_MOVING). It is a diagnostic and not a gate; the engine loads either.
  */
  const trackVersion = readTxvRecord(podIndex, syncGetBytes, choice);
  stats.modelTextureNames = modelTextures.map((t) => `${t.name} ${t.width}x${t.height}`);
  console.info("[JSTrackViewer] palette sources:", JSON.stringify(palettes.sourceSummary()));
  console.info(`[JSTrackViewer] model textures decoded (${modelTextures.length}):`,
    stats.modelTextureNames.join(", "));

  const models = {};
  for (const [k, model] of Object.entries(doc.models)) {
    models[k] = {
      name: model.name, format: model.format, baseZ: model.baseZ, magnifyPower: model.magnifyPower,
      anchor: model.anchor ?? { x: 0, y: 0, z: 0 },
      meshes: (model.meshes ?? []).map((m) => ({
        textureName: m.textureName, color: m.color, transparent: m.transparent === true,
        // Material state travels with the mesh: the renderer decides blending, alpha cutoff,
        // sidedness and emissive from these, not from the face type.
        solid: m.solid === true, material: m.material ?? null, material2: m.material2 ?? null,
        positions: m.positions.buffer, normals: m.normals.buffer, uvs: m.uvs.buffer,
      })),
    };
  }

  return {
    origin: doc.origin, podComment: doc.podComment, trackVersion,
    fileName: choice.fileName ?? choice.entry?.title ?? "",
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

/**
 * A keyframe control model (ANIMATED_BIN) carries frame NAMES, not polygons. The frame models
 * are ordinary .BIN entries elsewhere in the pod, so frame 0 is what actually gets drawn.
 *
 * This mirrors what the Traxx fork had to add for the same reason: GetAniName(0) is only
 * useful if the frame it names has itself been loaded, and nothing was loading it, so
 * keyframed objects drew as empty wireframes.
 *
 * The frame's geometry is adopted under the CONTROL model's name, because that is the name
 * the .SIT refers to and everything downstream keys off it.
 */
function resolveKeyframeModel(model, loadFrame) {
  if (!model || model.format !== "ANIMATED_BIN") return model;
  for (const frameName of model.frameNames ?? []) {
    const frame = loadFrame(frameName);
    if (!frame?.meshes?.length) continue;
    return {
      ...frame,
      name: model.name,
      format: model.format,
      frameNames: model.frameNames,
      resolvedFrame: frameName,
    };
  }
  return model;
}

// Hellbender's terrain scale is pinned rather than requested. Traxx's ALTITUDESCALE is 3 for
// everything else, which is now also the requested default, but the HB branch stays explicit
// because it is deliberately not user-controlled.
function readTxvRecord(podIndex, getBytes, choice) {
  const title = choice?.entry?.title ?? "";
  const stem = title.replace(/\.[^.]+$/, "");
  if (!stem) return null;
  const entry = podIndex.entries.find((e) => e.normalizedName === `DATA/${stem}.TXV`)
    ?? podIndex.entries.find((e) => e.title.toUpperCase() === `${stem}.TXV`);
  if (!entry) return null;
  try {
    const text = new TextDecoder("latin1").decode(getBytes(entry));
    const record = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      record[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return Object.keys(record).length ? record : null;
  } catch {
    return null;
  }
}

function effectiveTerrainHeightScale(origin, requestedHeightScale) {
  return origin === "HB" ? 3 : (requestedHeightScale ?? 3);
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
