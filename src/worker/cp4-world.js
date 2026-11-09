import {
  parseWtr, isMtm2Veg, parseMtm2Veg, vegTreeAt, vegClumpAt, parseSrf, BOX_FOG, VEG_KIND_GROUND, heightAtCell,
} from "../vendor/openphotex/index.js";
import { findEntry, findEntryByTitle } from "./pod-format.js";
import { archiveTitle, basenameWithoutExtension } from "../shared/path-utils.js";

/*
  Community Patch 4 (beta 0.52, Traxx 1.7) world layers of an MTM2 track, turned into what the
  scene draws: lakes (WORLD\<stem>.WTR), vegetation (WORLD\<stem>.VEG), fog volumes (SIT box
  type 14) and surface-mesh sidecars (MODELS\<model>.SRF).

  Parsing is OpenPhotex's; this file only lays the parsed records out in scene units. The
  engine rules quoted here are from OpenMTM2 docs/CP4_EXE_ANALYSIS.md, sections 2 to 5 (an
  analysis of the CP4 binary; its author published no source code).

  Scene units, as the rest of the viewer: a 32 ft cell is `cellSize` (64) across, x east, and the
  level's z rows run toward scene -z ((gridSize - row) * cellSize, as terrain-builder.js lays
  them). Heights are legacy 2 ft steps times `heightScale`.
*/

const FEET_PER_STEP = 2;
const TILE_FT = 32;
const TILES = 256;

/** The lake height range the engine accepts, in 0.5 ft units (HEIGHT_RANGE). */
const LAKE_HEIGHT_MIN = 1;
const LAKE_HEIGHT_MAX = 4096;

/** At most 64 fog volumes are kept (the engine's store cap). */
export const FOG_VOLUME_CAP = 64;
/** A fog volume is skipped when any of its sides is this many feet or less. */
const FOG_MIN_SIDE_FT = 0.5;

/** Vegetation distances at vegLodScale 100: one swap at floor((900 + 1000) / 2) ft, grass to 1000 ft. */
export const VEG_FAR_CARD_FT = 950;
export const VEG_GRASS_DISTANCE_FT = 1000;
/** Species flag the engine reads as "no far card" (CP4_EXE_ANALYSIS.md 3; OpenPhotex calls it VEG_FLAG_FACING). */
const VEG_FLAG_NO_FAR_CARD = 0x08;
/** Instances are batched in squares of this many 32 ft tiles, so a batch can be culled or swapped as one. */
export const VEG_CHUNK_TILES = 8;

/** A WORLD\ entry of the track, by file name: WORLD\<name> first, then the name anywhere. */
function worldEntry(podIndex, name) {
  return findEntry(podIndex, `WORLD/${name}`) ?? findEntryByTitle(podIndex, name) ?? null;
}

/**
 * Reads the track's .WTR and .VEG, loads the vegetation's models with `loadModel(name)` into
 * `doc.models`, and fills `doc.cp4` with what the scene needs. `stem` names the track files
 * (WORLD\<stem>.SIT). Problems become `doc.warnings`, never a failed load.
 */
export function loadCp4World(podIndex, getBytes, doc, stem, loadModel, options) {
  const out = { lakes: [], lakeTileMap: null, vegetation: null, fogVolumes: [] };
  const warn = (text) => doc.warnings?.push?.(text);
  const layout = { gridSize: doc.terrain?.gridSize ?? TILES, cellSize: options.cellSize, heightScale: options.heightScale };

  const wtrEntry = stem ? worldEntry(podIndex, `${stem}.WTR`) : null;
  if (wtrEntry) {
    try {
      const wtr = parseWtr(getBytes(wtrEntry));
      const sheets = buildLakeSheets(wtr, {
        ...layout,
        trackWaterFt: doc.waterHeightFt ?? (doc.waterLevel ?? 0) * FEET_PER_STEP,
        bedFt: options.bedFt ?? tileBedSampler(doc.terrain),
      });
      out.lakes = sheets.lakes;
      out.lakeTileMap = sheets.tileMap;
      for (const text of sheets.warnings) warn(`Lakes: ${text}`);
    } catch (err) {
      warn(`Lakes: ${err.message}`);
    }
  }

  const vegEntry = stem ? worldEntry(podIndex, `${stem}.VEG`) : null;
  const vegBytes = vegEntry ? getBytes(vegEntry) : null;
  if (vegBytes && isMtm2Veg(vegBytes)) {
    try {
      const veg = parseMtm2Veg(vegBytes);
      for (const species of veg.species) {
        for (const name of [species.model, species.farModel]) {
          if (!name || doc.models[name]) continue;
          const model = loadModel(name);
          if (model) doc.models[name] = model;
          else warn(`Vegetation: model ${name} is not in the pod`);
        }
      }
      out.vegetation = vegetationInstances(veg, layout, (name) => !!doc.models[name]);
    } catch (err) {
      warn(`Vegetation: ${err.message}`);
    }
  }

  const fog = collectFogVolumes(doc.boxes ?? [], layout);
  out.fogVolumes = fog.volumes;
  for (const text of fog.warnings) warn(`Fog volumes: ${text}`);

  for (const [name, model] of Object.entries(doc.models)) {
    const srfEntry = findEntry(podIndex, `MODELS/${basenameWithoutExtension(name)}.SRF`);
    if (!srfEntry) continue;
    try {
      model.surface = modelSurface(parseSrf(getBytes(srfEntry)), model);
    } catch (err) {
      warn(`${archiveTitle(srfEntry.name)}: ${err.message}`);
    }
  }
  return out;
}

/*
  Lakes as flat sheets, one quad per tile of the .WTR's 256 x 256 map (index x + z * 256).

  The engine uses the map as written and checks each lake in order (CP4_EXE_ANALYSIS.md 2):
  HEIGHT_RANGE (height not 1..4096), NO_TILES, BELOW_BODY0 (its surface at or below the track's
  own water), TOUCHES_BODY0 (one of its tiles' bed at or below that water, the bed being the
  lowest terrain sample of the tile). A lake that fails one is skipped, and so is it here, with
  the engine's reason; its tiles are dry in the returned map. `bedFt(tx, tz)` gives a tile's bed
  in feet; without it the last rule is not checked.

  Returns { lakes: [{ id, heightFt, reflective, y, tileCount, positions, indices }], tileMap,
  levelFt, warnings }: positions in scene units (y the sheet's), `levelFt[id]` the surface of
  each drawn lake in feet for drive mode.
*/
export function buildLakeSheets(wtr, { gridSize = TILES, cellSize = 64, heightScale = 3, trackWaterFt = 0, bedFt = null } = {}) {
  const warnings = [];
  const levelFt = new Float32Array(256);
  if (!wtr?.tileMap) return { lakes: [], tileMap: null, levelFt, warnings: ["no TMAP chunk"] };
  if (gridSize !== TILES) return { lakes: [], tileMap: null, levelFt, warnings: [`a ${gridSize}-cell grid cannot carry a 256 x 256 lake map`] };

  const tilesOf = new Map();
  for (let i = 0; i < wtr.tileMap.length; i++) {
    const id = wtr.tileMap[i];
    if (!id) continue;
    if (!tilesOf.has(id)) tilesOf.set(id, []);
    tilesOf.get(id).push(i);
  }

  const tileMap = new Uint8Array(TILES * TILES);
  const lakes = [];
  for (const lake of wtr.lakes) {
    const tiles = tilesOf.get(lake.id) ?? [];
    const reason = lake.height < LAKE_HEIGHT_MIN || lake.height > LAKE_HEIGHT_MAX ? "HEIGHT_RANGE"
      : !tiles.length ? "NO_TILES"
      : lake.heightFt <= trackWaterFt ? "BELOW_BODY0"
      : bedFt && tiles.some((t) => bedFt(t & 255, t >> 8) <= trackWaterFt) ? "TOUCHES_BODY0"
      : null;
    if (reason) {
      warnings.push(`lake ${lake.id} skipped (${reason})`);
      continue;
    }
    if (lake.tileCount !== tiles.length) warnings.push(`lake ${lake.id} states ${lake.tileCount} tiles, its map has ${tiles.length}`);

    const y = (lake.heightFt / FEET_PER_STEP) * heightScale;
    const positions = new Float32Array(tiles.length * 12);
    const indices = new Uint32Array(tiles.length * 6);
    tiles.forEach((t, k) => {
      tileMap[t] = lake.id;
      const tx = t & 255, tz = t >> 8;
      const x0 = tx * cellSize, x1 = x0 + cellSize;
      const z0 = (gridSize - tz) * cellSize, z1 = z0 - cellSize;
      positions.set([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], k * 12);
      // Counter-clockwise seen from above, so the sheet faces up.
      const v = k * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], k * 6);
    });
    levelFt[lake.id] = lake.heightFt;
    lakes.push({ id: lake.id, heightFt: lake.heightFt, reflective: lake.reflective, y, tileCount: tiles.length, positions, indices });
  }
  return { lakes, tileMap, levelFt, warnings };
}

/*
  A tile's lake bed in feet, as the engine's TOUCHES_BODY0 test takes it: the lowest of the tile's
  four 32 ft corners, or of its 5 x 5 samples on an 8 ft grid (terrain.fine, sit-parser.js).
*/
export function tileBedSampler(terrain) {
  if (!terrain?.rawData) return null;
  const fine = terrain.fine;
  if (fine?.heights) {
    const s = fine.subdivisions, side = (terrain.gridSize ?? TILES) * s, divisor = fine.divisor ?? 256;
    const clamp = (v) => (v < 0 ? 0 : v > side - 1 ? side - 1 : v);
    return (tx, tz) => {
      let low = Infinity;
      for (let j = 0; j <= s; j++) {
        for (let i = 0; i <= s; i++) low = Math.min(low, fine.heights[clamp(tx * s + i) + clamp(tz * s + j) * side]);
      }
      return (low / divisor) * FEET_PER_STEP;
    };
  }
  return (tx, tz) => FEET_PER_STEP * Math.min(
    heightAtCell(terrain, terrain.rawData, tx, tz), heightAtCell(terrain, terrain.rawData, tx + 1, tz),
    heightAtCell(terrain, terrain.rawData, tx, tz + 1), heightAtCell(terrain, terrain.rawData, tx + 1, tz + 1));
}

/*
  Type 14 boxes' fog volumes, in scene units (CP4_EXE_ANALYSIS.md 4).

  A zero w, l or h takes the box's own width, length or height; `base` lifts the bottom face off
  the box's y, so the centre is y + base + h / 2. Width runs along the box's local x and length
  along its local y, as a collision prism's do. A volume with a side of 0.5 ft or less is kept
  (`drawn: false`) but the engine never draws it. Only the first 64 are kept.
*/
export function collectFogVolumes(boxes, { gridSize = TILES, cellSize = 64, heightScale = 3 } = {}) {
  const warnings = [];
  const volumes = [];
  const unitsPerFt = cellSize / TILE_FT;
  const worldSize = gridSize * cellSize;
  let total = 0;
  boxes.forEach((box, boxIndex) => {
    if (box.type !== BOX_FOG || !box.fog) return;
    total++;
    if (volumes.length >= FOG_VOLUME_CAP) return;
    const fog = box.fog;
    const [lengthFt, widthFt, heightFt] = box.sizeFt ?? [box.length ?? 0, box.width ?? 0, box.height ?? 0];
    const w = fog.w > 0 ? fog.w : widthFt;
    const l = fog.l > 0 ? fog.l : lengthFt;
    const h = fog.h > 0 ? fog.h : heightFt;
    const [wx = 0, wy = 0, wz = 0] = box.position ?? [];
    const altitudeFt = box.positionFt?.[1] ?? wz * FEET_PER_STEP;
    const bottomFt = altitudeFt + (fog.base ?? 0);
    volumes.push({
      boxIndex,
      w, l, h, bottomFt,
      centre: [wx, ((bottomFt + h / 2) / FEET_PER_STEP) * heightScale, worldSize - wy],
      // Scene sizes before the box matrix (which carries the 0.75 vertical stretch, as for prisms).
      size: [w * unitsPerFt, h * unitsPerFt, l * unitsPerFt],
      psi: box.psi ?? 0, theta: box.theta ?? 0, phi: box.phi ?? 0,
      fog: { ...fog, color: [...fog.color] },
      drawn: w > FOG_MIN_SIDE_FT && l > FOG_MIN_SIDE_FT && h > FOG_MIN_SIDE_FT,
    });
  });
  if (total > FOG_VOLUME_CAP) warnings.push(`the track places ${total}; the engine keeps ${FOG_VOLUME_CAP}`);
  return { volumes, warnings };
}

/*
  Trees and grass clumps as instance batches: per species, per square of VEG_CHUNK_TILES tiles,
  a position (scene units), a heading (radians, the SIT psi convention: a turn of 1/65536 or, for
  a clump, 1/256) and a uniform scale per instance. The scene turns each into
  traxxModelMatrix(psi) x the model's anchor x scale, as it places a SIT object.

  A tree's y is its model origin (OpenPhotex mtm/veg.ts). Every tier is kept: the engine draws a
  tree only up to the scenery detail setting, and the viewer shows the most detailed.

  `hasModel(name)` says whether a model loaded; a species without one is dropped and so is a
  missing far card. The far card is used unless the species sets flag 0x08 (no far card).
*/
export function vegetationInstances(veg, { gridSize = TILES, cellSize = 64, heightScale = 3 } = {}, hasModel = () => true) {
  const unitsPerFt = cellSize / TILE_FT;
  const worldSize = gridSize * cellSize;
  const chunkFt = VEG_CHUNK_TILES * TILE_FT;
  const species = veg.species.map((s, index) => ({
    index, model: hasModel(s.model) ? s.model : null,
    farModel: s.farModel && !(s.flags & VEG_FLAG_NO_FAR_CARD) && hasModel(s.farModel) ? s.farModel : null,
    kind: s.kind === VEG_KIND_GROUND ? "grass" : "tree", collide: s.collide, flags: s.flags,
  }));

  const batches = new Map();
  const add = (speciesIndex, p, turns) => {
    const s = species[speciesIndex];
    if (!s?.model) return;
    const cx = Math.floor(p.x / chunkFt), cz = Math.floor(p.z / chunkFt);
    const key = `${speciesIndex}:${cx}:${cz}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = {
        species: speciesIndex, kind: s.kind, modelName: s.model, farModelName: s.farModel,
        // The batch's middle, in scene units, and its half-diagonal: what the scene measures distance from.
        centre: [(cx + 0.5) * chunkFt * unitsPerFt, worldSize - (cz + 0.5) * chunkFt * unitsPerFt],
        radius: chunkFt * unitsPerFt * Math.SQRT1_2,
        positions: [], yaw: [], scale: [],
      };
      batches.set(key, batch);
    }
    batch.positions.push(p.x * unitsPerFt, (p.y / FEET_PER_STEP) * heightScale, worldSize - p.z * unitsPerFt);
    batch.yaw.push(turns * 2 * Math.PI);
    batch.scale.push(p.scale);
  };

  for (let i = 0; i < veg.trees.count; i++) {
    const t = vegTreeAt(veg.trees, i);
    add(veg.trees.species[i], t, t.headingTurns);
  }
  for (const tile of veg.clumps.tiles) {
    for (let i = tile.first; i < tile.first + tile.count && i < veg.clumps.count; i++) {
      const c = vegClumpAt(veg.clumps, tile, i);
      add(veg.clumps.species[i], c, c.headingTurns);
    }
  }

  let treeCount = 0, clumpCount = 0;
  const out = [...batches.values()].map((b) => {
    const count = b.yaw.length;
    if (b.kind === "grass") clumpCount += count; else treeCount += count;
    return { ...b, count, positions: new Float32Array(b.positions), yaw: new Float32Array(b.yaw), scale: new Float32Array(b.scale) };
  });
  return {
    species, batches: out, treeCount, clumpCount,
    farCardFt: VEG_FAR_CARD_FT, grassDistanceFt: VEG_GRASS_DISTANCE_FT,
  };
}

/*
  A model's .SRF as the engine applies it (CP4_EXE_ANALYSIS.md 5): each material is one of the
  model's texture names, matched exact (case-insensitive), then by the stem without extension,
  then by the first 15 characters, then the `*` default; no match means "not a surface".
*/
export function srfMaterialType(srf, textureName) {
  const name = archiveTitle(textureName ?? "").toLowerCase();
  if (!name) return srf.fallback ?? null;
  const stem = (value) => value.replace(/\.[^.]*$/, "");
  const entries = Object.entries(srf.materials).map(([k, v]) => [k.toLowerCase(), v]);
  const hit = entries.find(([k]) => k === name)
    ?? entries.find(([k]) => stem(k) === stem(name))
    ?? entries.find(([k]) => k.slice(0, 15) === name.slice(0, 15));
  return hit ? hit[1] : srf.fallback ?? null;
}

/** The surface types of a model's textures under its .SRF: { materials: [{ texture, type }], fallback, rejected }. */
export function modelSurface(srf, model) {
  const textures = [...new Set((model?.meshes ?? []).map((m) => m.textureName).filter(Boolean))];
  return {
    materials: textures.map((texture) => ({ texture, type: srfMaterialType(srf, texture) })),
    fallback: srf.fallback,
    rejected: srf.rejected.map((r) => `line ${r.line}: ${r.reason}`),
  };
}
