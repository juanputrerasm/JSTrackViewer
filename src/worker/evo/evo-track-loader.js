import { resolveAsset, findEntry } from "../pod-format.js";
import { archiveTitle, replaceExtension, basenameWithoutExtension } from "../../shared/path-utils.js";
import { buildTerrainMesh } from "../terrain-builder.js";
import { parseEvoSit } from "./evo-sit-parser.js";
import { parseEvoLvl, parseEvoWat } from "./evo-lvl-parser.js";
import { parseEvoTex } from "./evo-tex-parser.js";
import { parseEvoVeg } from "./veg-parser.js";
import { decodeSmfModel } from "./smf-parser.js";
import { decodeEvoTexture } from "./evo-image.js";
import {
  EVO_CELL_SIZE, EVO_GRID_SIZE, EVO_HEIGHT_DIVISOR, EVO_WATER_HEIGHT_DIVISOR,
  evoPositionToBox, evoOrientToAngles, evoHeightAt,
} from "./evo-coords.js";

/*
  Loads one 4x4 Evolution track out of a POD2 archive into the viewer's normalized result.

  The asset graph is:

    WORLD\<track>.SIT           scene: header, placements, course
      LEVELS\<track>.LVL        terrain manifest and environment
        DATA\<track>.RAW        16-bit height grid
        DATA\<track>.CLR        16-bit terrain tile-index grid
        DATA\<track>.TEX        terrain + shadow texture table -> ART\*.RAW + *.ACT
        <sky>.RAW, <detail>.RAW, water and light parameters
      MODELS\*.SMF              -> ART\*.RAW + *.ACT + optional *.OPA, or ART\*.TIF
      DATA\<track>.VEG          Evo 2 vegetation
      DATA\<track>.WAT          Evo 2 water material
      DATA\<track>.SDW          per-cell shadow overlay, parsed and carried, not yet drawn
      DATA\<track>.RTD          unresolved 16-bit grid, carried opaque

  The result is deliberately shaped like the MTM-family one so the renderer needs no Evo
  branch beyond the object matrix: same terrain mesh buffers, same box records, same model
  and texture tables. Everything Evo-specific - the 32-unit cell, the Y-up axes, the
  per-texture palettes - is resolved here.
*/

const EVO_HEIGHT_SCALE = 1;   // Evo heights are already world units once divided by 32.
const GRID_BYTES = EVO_GRID_SIZE * EVO_GRID_SIZE * 2;

export function loadEvoTrack(podIndex, getBytes, sitEntry) {
  const warnings = [];
  const sit = parseEvoSit(getBytes(sitEntry), sitEntry.title);
  warnings.push(...sit.warnings);

  const origin = sit.game === 2 ? "EVO2" : "EVO1";
  const stem = basenameWithoutExtension(sitEntry.name);

  // ─── Terrain manifest ──────────────────────────────────────────────────────
  const lvlEntry = resolveAsset(podIndex, sit.lvlName) ?? resolveAsset(podIndex, `${stem}.LVL`);
  if (!lvlEntry) throw new Error(`${sitEntry.title}: cannot resolve its .LVL (${sit.lvlName})`);
  const lvl = parseEvoLvl(getBytes(lvlEntry), lvlEntry.title);

  const rawData = readGrid(podIndex, getBytes, lvl.heightName, stem, ".RAW", warnings, "height");
  const clrData = readGrid(podIndex, getBytes, lvl.clrName, stem, ".CLR", warnings, "tile index");
  const shadowData = readGrid(podIndex, getBytes, null, stem, ".SDW", warnings, "shadow overlay");
  const auxiliaryRtdData = readGrid(podIndex, getBytes, null, stem, ".RTD", warnings, "auxiliary");

  const texEntry = resolveAsset(podIndex, lvl.texName) ?? resolveAsset(podIndex, `${stem}.TEX`);
  if (!texEntry) throw new Error(`${sitEntry.title}: cannot resolve its .TEX (${lvl.texName})`);
  const tex = parseEvoTex(getBytes(texEntry), texEntry.title);
  warnings.push(...tex.warnings);

  /*
    Terrain slots.

    Only the ORDINARY group is handed to the atlas: .CLR indexes that group alone, and
    appending the shadow group would push every index off by the ordinary count. The shadow
    table is carried on the result for a later overlay pass.

    Each slot resolves its own .ACT. Evo has no track-wide palette - all 3,757 stock terrain
    slots have a same-stem one - so a slot that cannot find its palette is left undecoded and
    reported rather than being drawn with somebody else's colours.
  */
  const textures = tex.ordinary.map((record) => {
    const entry = resolveAsset(podIndex, record.name);
    const actEntry = resolveAsset(podIndex, replaceExtension(record.name, ".ACT"));
    if (!entry) warnings.push(`terrain texture missing: ${record.name}`);
    else if (!actEntry) warnings.push(`terrain texture has no .ACT: ${record.name}`);
    return {
      name: archiveTitle(record.name),
      param0: record.param0,
      param1: record.param1,
      data: entry ? getBytes(entry) : null,
      actData: actEntry ? getBytes(actEntry) : undefined,
    };
  });

  const terrain = {
    gridSize: EVO_GRID_SIZE,
    cellSize: EVO_CELL_SIZE,
    heightDivisor: EVO_HEIGHT_DIVISOR,
    rawData,
    rawBytesPerCell: 2,
    clrData,
    clrBytesPerCell: 2,
  };

  const terrainMesh = rawData
    ? buildTerrainMesh(terrain, null, textures, EVO_HEIGHT_SCALE, origin, null)
    : null;

  // ─── Models and their art ──────────────────────────────────────────────────
  const models = {};
  const modelWarnings = [];
  const wanted = new Set(sit.boxes.map((box) => box.modelName).filter(Boolean).map((n) => n.toUpperCase()));

  const veg = loadVegetation(podIndex, getBytes, stem, warnings);
  for (const name of veg?.treeModels ?? []) wanted.add(name);

  for (const name of wanted) {
    const entry = resolveAsset(podIndex, name);
    if (!entry) { modelWarnings.push(`model missing: ${name}`); continue; }
    try {
      const model = decodeSmfModel(getBytes(entry), name);
      for (const warning of model.warnings) modelWarnings.push(`${name}: ${warning}`);
      models[name] = model;
    } catch (err) {
      modelWarnings.push(`${name}: ${err?.message ?? err}`);
    }
  }

  const { modelTextures, textureWarnings } = decodeModelTextures(podIndex, getBytes, models);
  warnings.push(...textureWarnings);
  const texturesWithAlpha = new Set(modelTextures.filter((t) => t.hasAlpha).map((t) => t.name));

  // ─── Environment ───────────────────────────────────────────────────────────
  const skyTexture = decodeNamedTexture(podIndex, getBytes, lvl.skyName, warnings);
  const detailTexture = decodeNamedTexture(podIndex, getBytes, lvl.detailTexture, warnings);

  const watEntry = findEntry(podIndex, `DATA/${stem}.WAT`) ?? resolveAsset(podIndex, `${stem}.WAT`);
  const water = {
    // World units. The .LVL records water on a half-unit scale; see EVO_WATER_HEIGHT_DIVISOR.
    height: lvl.water.height / EVO_WATER_HEIGHT_DIVISOR,
    tideHeight: lvl.water.tideHeight / EVO_WATER_HEIGHT_DIVISOR,
    tidePeriod: lvl.water.tidePeriod,
    color: lvl.water.color,
    sourceHeight: lvl.water.height,
    material: watEntry ? parseEvoWat(getBytes(watEntry), watEntry.title) : null,
  };

  // ─── Placements ────────────────────────────────────────────────────────────
  const boxes = sit.boxes.map((box, index) => {
    const { psi, theta, phi } = evoOrientToAngles(box.orient);
    return {
      index,
      modelName: box.modelName ? box.modelName.toUpperCase() : null,
      position: evoPositionToBox(box.position),
      psi, theta, phi,
      sourceClass: box.sourceClass,
      schemaVersion: box.schemaVersion,
      name: box.name,
      size: box.size,
      boxType: box.boxType,
      castShadowOnMe: box.castShadowOnMe,
      timePerFrame: box.timePerFrame,
      parent: box.parent,
      /*
        Evo 2's CNonCollideFacing is the class the engine yaws toward the camera. The viewer
        already has a billboard policy for MTM type-8 props, so the class maps onto it rather
        than growing a second one.
      */
      billboard: box.sourceClass === "CNonCollideFacing",
    };
  });

  const trees = buildTreeInstances(veg, rawData, models);

  const courses = sit.courses.map((course) => ({
    segments: course.segments.map((segment) => ({
      start: evoPositionToBox(segment.start),
      end: evoPositionToBox(segment.end),
      speedLimit: segment.speedLimit,
      trackWidth: segment.trackWidth,
    })),
  }));

  return {
    origin,
    source: { family: "EVO", game: sit.game, container: "POD2", sitVersion: sit.version },
    podComment: podIndex.comment ?? "",
    fileName: sitEntry.title,
    trackName: sit.trackName || stem,
    trackType: sit.raceType,
    weatherMask: sit.weatherMask,
    ambientSound: sit.ambientSound,
    author: sit.author,

    // A zero-opacity water colour means the level declares a height but draws no plane.
    waterLevel: lvl.water.color[3] > 0 ? water.height : 0,
    water,
    sunVector: lvl.lightVector,

    terrain: terrainMesh ? {
      ...terrainMesh,
      rawData: rawData ? rawData.slice().buffer : null,
      rawBytesPerCell: 2,
      heightDivisor: EVO_HEIGHT_DIVISOR,
    } : null,
    // Carried for later passes: SDW selects a second terrain layer from the shadow table and
    // RTD's role is not established. Neither is drawn yet, and neither is guessed at.
    shadowGrid: shadowData ? { data: shadowData.slice().buffer, indexBase: tex.ordinaryCount } : null,
    shadowTextures: tex.shadow,
    auxiliaryRtdData: auxiliaryRtdData ? auxiliaryRtdData.slice().buffer : null,

    skyTexture: skyTexture ? serializeTexture(skyTexture) : null,
    detailTexture: detailTexture ? serializeTexture(detailTexture) : null,

    primaryCourse: courses[0] ?? { segments: [] },
    extendedCourses: courses.slice(1),

    boxes,
    groundBoxes: [],
    trucks: [],
    vegetation: veg ? {
      version: veg.version,
      maxTrees: veg.maxTrees,
      treeModels: veg.treeModels,
      treeTexture: veg.treeTexture,
      grassTexture: veg.grassTexture,
      treeLine: veg.treeLine,
      color: veg.color,
      trees,
    } : null,

    models: serializeModels(models, texturesWithAlpha),
    modelTextures,

    stats: {
      gridSize: EVO_GRID_SIZE,
      cellSize: EVO_CELL_SIZE,
      textureCount: textures.length,
      shadowTextureCount: tex.shadow.length,
      objectCount: boxes.length,
      // The stats panel reads this for every track; Evo has no ground-box layer.
      groundBoxCount: 0,
      modelCount: Object.keys(models).length,
      modelTextureCount: modelTextures.length,
      treeCount: trees.length,
      primarySegmentCount: courses[0]?.segments.length ?? 0,
      extendedCourseCount: Math.max(0, courses.length - 1),
      sitVersion: sit.version,
      modelWarningCount: modelWarnings.length,
      warnings,
      modelWarnings,
    },
  };
}

/*
  Reads one 256x256 uint16 grid.

  The .LVL names the height and tile grids but not .SDW or .RTD, which are found by stem, so
  both a name and a stem fallback are accepted.

  DATA\ is searched before anything else, and that ordering is load-bearing rather than a
  preference. Evo 1 tracks name their heightfield `<track>.raw` and ALSO ship the track's
  logo as ART\<track>.RAW - ASPEN and THEHILL both do - so a title-only lookup finds the
  65,536-byte logo instead of the 131,072-byte grid and the track loses its terrain entirely.
  The .LVL's names are relative to DATA\, so resolving them there first is also what the
  file means.

  A grid that is not exactly 131,072 bytes is then refused rather than read partially: every
  stock grid is that size, and a different one means the lookup found something else.
*/
function readGrid(podIndex, getBytes, name, stem, extension, warnings, role) {
  const entry = (name ? findEntry(podIndex, `DATA/${archiveTitle(name)}`) : null)
    ?? findEntry(podIndex, `DATA/${stem}${extension}`)
    ?? (name ? resolveAsset(podIndex, name) : null)
    ?? resolveAsset(podIndex, `${stem}${extension}`);
  if (!entry) {
    if (role === "height" || role === "tile index") warnings.push(`${role} grid missing (${name ?? stem + extension})`);
    return null;
  }
  const bytes = getBytes(entry);
  if (bytes.length !== GRID_BYTES) {
    warnings.push(`${entry.title}: ${role} grid is ${bytes.length} bytes, expected ${GRID_BYTES}`);
    return null;
  }
  return bytes;
}

/*
  Every distinct texture the loaded models name.

  A model material names either an .ART .RAW - which needs its own .ACT and may have an .OPA
  opacity plane beside it - or, on Evo 2, a .TIF that carries its palette and any opacity
  itself. Both go through decodeEvoTexture, which is the only thing that has to know which.
*/
function decodeModelTextures(podIndex, getBytes, models) {
  const modelTextures = [];
  const textureWarnings = [];
  const seen = new Set();

  for (const model of Object.values(models)) {
    for (const name of model.textureNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      const decoded = decodeNamedTexture(podIndex, getBytes, name, textureWarnings);
      if (decoded) modelTextures.push(serializeTexture(decoded));
    }
  }
  return { modelTextures, textureWarnings };
}

function decodeNamedTexture(podIndex, getBytes, name, warnings) {
  if (!name) return null;
  const entry = resolveAsset(podIndex, name)
    ?? resolveAsset(podIndex, replaceExtension(name, ".RAW"))
    ?? resolveAsset(podIndex, replaceExtension(name, ".TIF"));
  if (!entry) { warnings.push(`texture missing: ${name}`); return null; }

  const actEntry = resolveAsset(podIndex, replaceExtension(entry.title, ".ACT"));
  const opaEntry = resolveAsset(podIndex, replaceExtension(entry.title, ".OPA"));
  try {
    return decodeEvoTexture(
      getBytes(entry),
      actEntry ? getBytes(actEntry) : null,
      opaEntry ? getBytes(opaEntry) : null,
      archiveTitle(name));
  } catch (err) {
    warnings.push(`${archiveTitle(name)}: ${err?.message ?? err}`);
    return null;
  }
}

function loadVegetation(podIndex, getBytes, stem, warnings) {
  const entry = findEntry(podIndex, `DATA/${stem}.VEG`) ?? resolveAsset(podIndex, `${stem}.VEG`);
  if (!entry) return null;
  try {
    const veg = parseEvoVeg(getBytes(entry), entry.title);
    warnings.push(...veg.warnings);
    return veg;
  } catch (err) {
    warnings.push(`${entry.title}: ${err?.message ?? err}`);
    return null;
  }
}

/*
  Tree instances, ready for the renderer to draw with instancing.

  A .VEG record is (x, height, z, value). The height it stores is the terrain's, so it is
  used directly and only falls back to sampling the grid when a record sits outside it.

  `value` spans the whole 0..255 range in both stock tracks and its meaning is unknown. It is
  kept verbatim on the instance; the model choice below is a deterministic function of it so
  that a track places its trees identically on every load, but that mapping is this viewer's
  convention rather than a decoded fact, and it is the first thing to revisit when a visual
  comparison against the game is possible.
*/
function buildTreeInstances(veg, rawData, models) {
  if (!veg?.trees.length || !veg.treeModels.length) return [];

  /*
    Authored extent of each vegetation model, which is what a slot's treeSizeX/treeSizeY are
    measured against.

    The vertical half-extent matters as much as the size does, because these models are
    CENTRED on their origin rather than standing on it: PINE100 spans Y -50..+50, PALMFAN
    -20..+20, JUNGLE115 -57.5..+57.5. Placing the origin at ground level therefore buries
    half of every tree, which is exactly what it looked like.
  */
  const extent = new Map();
  for (const [name, model] of Object.entries(models)) {
    let lowY = Infinity, highY = -Infinity, lowX = Infinity, highX = -Infinity;
    for (const mesh of model.meshes) {
      for (let i = 0; i < mesh.positions.length; i += 3) {
        if (mesh.positions[i] < lowX) lowX = mesh.positions[i];
        if (mesh.positions[i] > highX) highX = mesh.positions[i];
        if (mesh.positions[i + 1] < lowY) lowY = mesh.positions[i + 1];
        if (mesh.positions[i + 1] > highY) highY = mesh.positions[i + 1];
      }
    }
    if (highY > lowY) extent.set(name, { lowY, height: highY - lowY, width: Math.max(1e-3, highX - lowX) });
  }

  return veg.trees.map((tree) => {
    const slot = (tree.value & 3) % veg.treeModels.length;
    const modelName = veg.treeModels[slot];
    const size = veg.treeSizes[slot] ?? null;
    const box = extent.get(modelName) ?? null;

    /*
      A slot is scaled to the size it declares, on each axis independently.

      treeSizeX and treeSizeY are the footprint and height the level asks for, and they do
      not match the art in any stock slot: BAJBEACH asks 65 from a 40-unit PALMFAN and 60
      from a 115-unit JUNGLE115. Both axes differ by different ratios in all eight stock
      slots, so the scale is non-uniform rather than one factor taken from the height.
    */
    const scaleY = size && box ? size.sizeY / box.height : 1;
    const scaleXZ = size && box ? size.sizeX / box.width : scaleY;

    /*
      The model's BASE is placed on the terrain surface this viewer draws.

      The record's own y is deliberately not used for that, and the reason is measured rather
      than assumed. Compared against the bilinear terrain under every tree in both stock
      tracks, `tree.y` is effectively never ABOVE the surface - the 95th percentile of the
      difference is 0.1 on BAJBEACH and 0.5 on PEAK - and it sits a median 5 units under it.
      So it carries no elevation the heightfield does not already give, while using it
      directly leaves 86% of trees with their trunk base buried in the drawn ground.

      Sampling bilinearly is what makes them stand on it: the terrain mesh interpolates
      across each cell, so the surface under a tree is the interpolated height, not the
      corner value the record appears to have been taken from.

      treeBiasY is not applied either. It is preserved on the parsed .VEG for later study,
      but sinking a further 5 to 20 units on top of this drove the trunks underground, which
      is the other half of the same reported fault.
    */
    const ground = evoHeightAt(rawData, tree.x, tree.z);
    const centre = ground - (box ? box.lowY * scaleY : 0);

    return {
      modelName,
      position: evoPositionToBox([tree.x, centre, tree.z]),
      // The record's own elevation, kept for diagnostics and for any future comparison.
      sourceY: tree.y,
      // Yaw is this viewer's convention: a .VEG record carries no orientation, and leaving a
      // forest of 11,000 identical models all facing one way reads worse than varying them.
      yaw: ((tree.value >> 4) & 15) * (Math.PI / 8),
      scale: [scaleXZ, scaleY, scaleXZ],
      value: tree.value,
    };
  });
}

function serializeTexture(decoded) {
  return {
    name: decoded.name,
    rgba: decoded.rgba.buffer,
    width: decoded.width,
    height: decoded.height,
    hasAlpha: decoded.hasAlpha === true,
  };
}

/*
  Models, flattened to the mesh records the renderer consumes.

  A .SMF group is one mesh with one material, which is already the viewer's mesh shape.
  Reduced-detail groups are dropped rather than drawn: the file-level LOD pair is a screen
  height switch, and drawing both halves puts the low-detail copy inside the high-detail one.

  Dropping them can never empty a model, though. A model that carries only reduced-detail or
  only hidden groups falls back to drawing whatever it has, because showing the low-detail
  mesh is a far better answer than showing nothing and reporting no error.
*/
function serializeModels(models, texturesWithAlpha) {
  const out = {};
  for (const [name, model] of Object.entries(models)) {
    const withGeometry = model.meshes.filter((mesh) => mesh.indices.length > 0);
    const preferred = withGeometry.filter((mesh) => mesh.visible && !mesh.lod);
    const drawable = preferred.length ? preferred : withGeometry;
    out[name] = {
      name: model.name,
      format: "SMF",
      fileVersion: model.fileVersion,
      lodEnabled: model.lodEnabled,
      lodSwitchHeight: model.lodSwitchHeight,
      anchor: { x: 0, y: 0, z: 0 },
      baseZ: 0,
      meshes: drawable.map((mesh) => ({
        groupName: mesh.groupName,
        textureName: mesh.textureName,
        transparent: mesh.transparent,
        /*
          Whether the art this mesh names actually carries an alpha channel.

          The .SMF material's own transparency flag cannot be the whole answer. Every stock
          vegetation model - PALMFAN, PALMCURVED, JUNGLE115, JUNGLE80, PINE100, PINE80 -
          writes that flag as 0, and yet each names a two-sample .TIF whose second sample is
          an opacity plane. Trusting the flag alone drew every tree as an opaque rectangle.

          An .OPA plane or a second TIFF sample exists for exactly one purpose, so its
          presence is treated as the material intent it plainly is.
        */
        textureHasAlpha: mesh.textureName ? texturesWithAlpha.has(mesh.textureName) : false,
        // .SMF sheets are meant to be seen from both faces; see scene.js _createModelMaterial.
        doubleSided: true,
        material: null,
        reflective: mesh.reflective,
        bumpTextureName: mesh.bumpTextureName,
        materialScalars: mesh.materialScalars,
        positions: mesh.positions.buffer,
        normals: mesh.normals.buffer,
        uvs: mesh.uvs.buffer,
        indices: mesh.indices.buffer,
      })),
    };
  }
  return out;
}
