import {
  parseWtr, wtrHeightRange, isMtm2Veg, parseMtm2Veg, checkMtm2VegBounds, vegTreeAt, vegClumpAt, parseSrf, BOX_FOG, VEG_KIND_GROUND,
  isWfl, parseWfl, buildFallMeshes, fallGround, fallHeightRange, fallWater, fallMists, fallTextureName, mtm2V6HeightsH128,
  FALL_VERTEX_FLOATS, FALL_VERTEX_UNITS_PER_FT, FALL_FLAG_SPLASH, FALL_FLAG_FREEZE,
} from "../vendor/openphotex/index.js";
import { heightAtCell } from "../shared/terrain-height.js";
import { findEntry, findEntryByTitle } from "./pod-format.js";
import { archiveTitle, basenameWithoutExtension } from "../shared/path-utils.js";
import { levelFileStems } from "./level-stem.js";

/*
  Community Patch 4 (beta 0.52, Traxx 1.7) world layers of an MTM2 track, turned into what the
  scene draws: lakes (WORLD\<stem>.WTR), vegetation (WORLD\<stem>.VEG), fog volumes (SIT box
  type 14), surface-mesh sidecars (MODELS\<model>.SRF) and beta 0.53's waterfalls
  (WORLD\<stem>.WFL).

  Parsing is OpenPhotex's, and so is the waterfalls' mesh build; this file only lays the parsed
  records out in scene units. The engine rules quoted here are from OpenMTM2
  docs/CP4_EXE_ANALYSIS.md, sections 2 to 5 and 12 (an analysis of the CP4 binary; its author
  published no source code).

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
 * A level file of the track (.WTR, .VEG, .WFL): WORLD\<level>.<ext> first, then WORLD\<stem>.<ext>
 * (level-stem.js; CP4 names its lakes and falls after the level, and tracks may share one level).
 */
function levelWorldEntry(podIndex, levelStem, stem, ext) {
  for (const s of levelFileStems(levelStem, stem)) {
    const entry = worldEntry(podIndex, `${s}.${ext}`);
    if (entry) return entry;
  }
  return null;
}

/**
 * Reads the track's .WTR and .VEG, loads the vegetation's models with `loadModel(name)` into
 * `doc.models`, and fills `doc.cp4` with what the scene needs. `stem` names the track files
 * (WORLD\<stem>.SIT); each is looked up by `doc.levelStem` first (levelWorldEntry). Problems become `doc.warnings`, never a failed load.
 */
export function loadCp4World(podIndex, getBytes, doc, stem, loadModel, options) {
  const out = { lakes: [], lakeTileMap: null, vegetation: null, fogVolumes: [], waterfalls: null };
  const warn = (text) => doc.warnings?.push?.(text);
  const layout = { gridSize: doc.terrain?.gridSize ?? TILES, cellSize: options.cellSize, heightScale: options.heightScale };

  // The lakes the WTR loader kept, with the file's own tile map: what the waterfalls' walk and checks read.
  let keptLakes = null;
  /*
    The world's size picks the .WTR version (spec section 9.1): a 256-cell track (.SIT, .SI2, or
    a .SI3 of 256 cells) reads version 1 only, a 512-cell .SI3 version 2 only, and any other
    pairing is refused with a warning (OpenPhotex parseWtr, which also refuses a version 2 header
    that is not 512 x 512). A version 2 lake's height is checked against the terrain's range
    rather than 1..4096, and a version 6 track's .VEG must lie inside the world (9.2).
  */
  const v6 = doc.v6 ?? null;
  const wtrEntry = levelWorldEntry(podIndex, doc.levelStem, stem, "WTR");
  if (wtrEntry) {
    try {
      const wtr = v6 ? parseWtr(getBytes(wtrEntry), { cells: v6.worldCells }) : parseWtr(getBytes(wtrEntry));
      // parseWtr without `cells` keeps version 1's "256 x 256 whatever the header says"; a version 2 file is a 512 world's.
      if (!v6 && wtr.major !== 1) throw new RangeError(`WTR: version ${wtr.major} is a 512-cell world's, not this 256-cell track's`);
      const sheets = buildLakeSheets(wtr, {
        ...layout,
        heightRange: v6 ? wtrHeightRange(wtr.major, v6.heightStep, v6.heightBase) : undefined,
        trackWaterFt: doc.waterHeightFt ?? (doc.waterLevel ?? 0) * FEET_PER_STEP,
        bedFt: options.bedFt ?? tileBedSampler(doc.terrain),
      });
      out.lakes = sheets.lakes;
      out.lakeTileMap = sheets.tileMap;
      const kept = new Set(sheets.lakes.map((l) => l.id));
      keptLakes = { lakes: wtr.lakes.filter((l) => kept.has(l.id)), tileMap: wtr.tileMap ?? null };
      for (const text of sheets.warnings) warn(`Lakes: ${text}`);
    } catch (err) {
      warn(`Lakes: ${err.message}`);
    }
  }

  const vegEntry = levelWorldEntry(podIndex, doc.levelStem, stem, "VEG");
  const vegBytes = vegEntry ? getBytes(vegEntry) : null;
  if (vegBytes && isMtm2Veg(vegBytes)) {
    try {
      const veg = parseMtm2Veg(vegBytes);
      if (v6) checkMtm2VegBounds(veg, v6.worldCells);
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

  const wflEntry = levelWorldEntry(podIndex, doc.levelStem, stem, "WFL");
  const wflBytes = wflEntry ? getBytes(wflEntry) : null;
  /*
    The world's size picks the .WFL version too (spec section 9.3): version 1 on a 256-cell track
    (.SIT, .SI2, or a .SI3 of 256 cells), version 2 on a 512-cell one, and OpenPhotex parseWfl
    refuses any other pairing ("authored for another terrain size"), which is a warning and no
    falls. The falls are built in the N world: crest points below 16 W, heights in fallHeightRange
    of the file's major and the track's step and base, the N x N lake map, and on a
    terrainHeightMap track the walk on its h128 heights (fallHeightsOf).
  */
  if (wflBytes) {
    try {
      if (!isWfl(wflBytes)) throw new RangeError("not an MWFL file");
      const wfl = parseWfl(wflBytes, { cells: v6 ? v6.worldCells : TILES });
      out.waterfalls = buildWaterfalls(wfl, {
        ...layout,
        heights: fallHeightsOf(doc.terrain, v6),
        lakes: keptLakes,
        lvlWaterFt: doc.waterHeightFt ?? null,
        sitFogVolumes: out.fogVolumes.length,
        cells: v6 ? v6.worldCells : TILES,
        heightRange: v6 ? fallHeightRange(wfl.major, { step: v6.heightStep, base: v6.heightBase }) : undefined,
      });
      for (const text of out.waterfalls.warnings) warn(`Waterfalls: ${text}`);
      if (!out.waterfalls.falls.length) out.waterfalls = null;
    } catch (err) {
      warn(`Waterfalls: ${err.message}`);
      out.waterfalls = null;
    }
  }

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
  Lakes as flat sheets, one quad per tile of the .WTR's N x N map (index x + z * N): 256 x 256 for
  a version 1 file (a 256-cell track), 512 x 512 for a version 2 one (a 512-cell .SI3).

  The engine uses the map as written and checks each lake in order (CP4_EXE_ANALYSIS.md 2):
  HEIGHT_RANGE (height not 1..4096, or for version 2 `heightRange`, OpenPhotex wtrHeightRange of
  the track's step and base, both in 0.5 ft units), NO_TILES, BELOW_BODY0 (its surface at or below the track's
  own water), TOUCHES_BODY0 (one of its tiles' bed at or below that water, the bed being the
  lowest terrain sample of the tile). A lake that fails one is skipped, and so is it here, with
  the engine's reason; its tiles are dry in the returned map. `bedFt(tx, tz)` gives a tile's bed
  in feet; without it the last rule is not checked.

  Returns { lakes: [{ id, heightFt, reflective, y, tileCount, positions, indices }], tileMap,
  levelFt, warnings }: positions in scene units (y the sheet's), `levelFt[id]` the surface of
  each drawn lake in feet for drive mode.
*/
export function buildLakeSheets(wtr, {
  gridSize = TILES, cellSize = 64, heightScale = 3, trackWaterFt = 0, bedFt = null, heightRange = [LAKE_HEIGHT_MIN, LAKE_HEIGHT_MAX],
} = {}) {
  const warnings = [];
  // Per lake id (1..255), not per tile.
  const levelFt = new Float32Array(256);
  if (!wtr?.tileMap) return { lakes: [], tileMap: null, levelFt, warnings: ["no TMAP chunk"] };
  const side = Math.round(Math.sqrt(wtr.tileMap.length));
  if (gridSize !== side) return { lakes: [], tileMap: null, levelFt, warnings: [`a ${gridSize}-cell grid cannot carry a ${side} x ${side} lake map`] };
  const [heightMin, heightMax] = heightRange;

  const tilesOf = new Map();
  for (let i = 0; i < wtr.tileMap.length; i++) {
    const id = wtr.tileMap[i];
    if (!id) continue;
    if (!tilesOf.has(id)) tilesOf.set(id, []);
    tilesOf.get(id).push(i);
  }

  const tileMap = new Uint8Array(side * side);
  const lakes = [];
  for (const lake of wtr.lakes) {
    const tiles = tilesOf.get(lake.id) ?? [];
    const reason = lake.height < heightMin || lake.height > heightMax ? "HEIGHT_RANGE"
      : !tiles.length ? "NO_TILES"
      : lake.heightFt <= trackWaterFt ? "BELOW_BODY0"
      : bedFt && tiles.some((t) => bedFt(t % side, Math.floor(t / side)) <= trackWaterFt) ? "TOUCHES_BODY0"
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
      const tx = t % side, tz = Math.floor(t / side);
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
    const s = fine.subdivisions, side = (terrain.gridSize ?? TILES) * s, divisor = fine.divisor ?? 256, offset = fine.offset ?? 0;
    const clamp = (v) => (v < 0 ? 0 : v > side - 1 ? side - 1 : v);
    return (tx, tz) => {
      let low = Infinity;
      for (let j = 0; j <= s; j++) {
        for (let i = 0; i <= s; i++) low = Math.min(low, fine.heights[clamp(tx * s + i) + clamp(tz * s + j) * side]);
      }
      return (low / divisor + offset) * FEET_PER_STEP;
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
  The heights the waterfalls' walk reads (OpenPhotex fallGround, CP4_EXE_ANALYSIS.md 12.2.3), in the
  mode the viewer draws the track in: a Community Patch 4 track's 16-bit corners (terrain.rawData as
  sit-parser.js leaves it) and its 8 ft grid for Spline and Full Map (terrain.cp4.fine), or a classic
  track's bytes as v << 8. Null when the track has no 256 x 256 grid.

  A track format version 6 track with a terrainHeightMap (`v6`, doc.v6): its N x N samples (and
  4N x 4N fine grid) as the 32-bit h128 store of spec section 7.3 (OpenPhotex mtm2V6HeightsH128 of
  the track's step and base), with `cells` N and `h128` set for fallGround. Null when the grid is
  not N x N. A version 6 track without one is a 256-cell CP4 track and takes the path above.
*/
export function fallHeightsOf(terrain, v6 = null) {
  const raw = terrain?.rawData;
  if (v6?.terrainHeightMap) {
    const n = v6.worldCells;
    if (!raw || terrain.gridSize !== n || raw.length !== n * n * 2) return null;
    const samples = new Uint16Array(n * n);
    for (let i = 0; i < samples.length; i++) samples[i] = raw[2 * i] | (raw[2 * i + 1] << 8);
    const fine = terrain.cp4?.fine ?? null;
    if (fine && fine.length !== 16 * n * n) return null;
    return {
      mode: terrain.cp4?.mode ?? "classic16", cells: n, h128: true,
      coarse: mtm2V6HeightsH128(samples, v6.heightStep, v6.heightBase),
      fine: fine ? mtm2V6HeightsH128(fine, v6.heightStep, v6.heightBase) : null,
    };
  }
  if (!raw || (terrain.gridSize ?? TILES) !== TILES) return null;
  const coarse = new Uint16Array(TILES * TILES);
  if (terrain.cp4 && raw.length === TILES * TILES * 2) {
    for (let i = 0; i < coarse.length; i++) coarse[i] = raw[2 * i] | (raw[2 * i + 1] << 8);
    return { mode: terrain.cp4.mode, coarse, fine: terrain.cp4.fine ?? null };
  }
  if (!terrain.cp4 && raw.length === TILES * TILES) {
    for (let i = 0; i < coarse.length; i++) coarse[i] = raw[i] << 8;
    return { mode: "classic8", coarse, fine: null };
  }
  return null;
}

/*
  Beta 0.53 waterfalls (WORLD\<stem>.WFL), built as the engine builds them at load (OpenPhotex
  buildFallMeshes, CP4_EXE_ANALYSIS.md 12): the record checks, the REFUSED reasons, the walk from the
  crest over `heights` into the water (the kept lakes `lakes` = { lakes, tileMap } and the .LVL water
  `lvlWaterFt`), the budget; then each fall's mist (12.4), sharing the 64 fog volume slots with the
  track's `sitFogVolumes`. `cells` is the world's N (256 but on a track format version 6 track of
  another size), `heightRange` the crest heights the records may hold (OpenPhotex fallHeightRange;
  version 1's 1..4096 when absent), and `heights.h128` says the samples are spec 7.3's h128 store.
  Mists are placed in [0, W) by OpenPhotex and laid out on the gridSize = N scene.

  Returns { vertices, indices, positions, falls, mists, warnings }:
  - `vertices` the engine's 16 floats a vertex (FALL_VERTEX: positions in 1/256 ft from the fall's
    anchor), `indices` global over them, both as built;
  - `positions` each vertex in scene units (3 floats), placed as buildLakeSheets places a lake;
  - `falls` per built fall: its slot, index range, opacity (0..1), crest speed, flags, texture name;
  - `mists` per mist: a box in scene units (centre, w x h x l, turned `yaw` about y) and its SIT fog.
*/
export function buildWaterfalls(wfl, {
  gridSize = TILES, cellSize = 64, heightScale = 3, heights = null, lakes = null, lvlWaterFt = null, sitFogVolumes = 0,
  cells = TILES, heightRange = undefined,
} = {}) {
  const warnings = [];
  if (!heights) {
    return { vertices: new Float32Array(0), indices: new Uint32Array(0), positions: new Float32Array(0), falls: [], mists: [],
      warnings: [`the track has no ${cells} x ${cells} terrain to pour them over`] };
  }
  const m = buildFallMeshes(wfl.falls, {
    lakes: lakes?.lakes ?? [], tileMap: lakes?.tileMap ?? null, cells, heightRange,
    ground: heights.h128 ? fallGround(heights, { cells, h128: true }) : fallGround(heights),
    water: fallWater(lakes ? { ...lakes, cells } : null, lvlWaterFt),
  });
  for (const r of m.rejected) warnings.push(`record ${r.index + 1} (id ${r.id}) skipped (${r.reason})`);
  for (const r of m.refused) warnings.push(`fall ${r.id} refused (${r.reason})`);
  for (const r of m.dropped) warnings.push(`fall ${r.id} dropped: too big (${r.left} vertices of room left)`);

  const unitsPerFt = cellSize / TILE_FT;
  const yUnitsPerFt = heightScale / FEET_PER_STEP;
  const worldSize = gridSize * cellSize;
  const positions = fallScenePositions(m, { gridSize, cellSize, heightScale });

  const { mists, noSlot } = fallMists(m.falls, { sitFogVolumes });
  for (const slot of noSlot) warnings.push(`fall ${m.falls[slot].id}'s mist skipped (no fog volume slot left)`);
  const misty = new Set(mists.map((x) => x.slot));

  const falls = m.falls.map((f) => ({
    slot: f.slot, index: f.index, id: f.id, source: f.source, flags: f.flags,
    splash: (f.flags & FALL_FLAG_SPLASH) !== 0, freeze: (f.flags & FALL_FLAG_FREEZE) !== 0,
    opacity: Math.min(Math.max(f.opacity / 100, 0), 1),
    crestSpeedFtPerSec: f.crestSpeedFtPerSec, crestLengthFt: f.crestLengthFt,
    anchorFt: [...f.anchorFt],
    firstVertex: f.firstVertex, vertexCount: f.vertexCount, foamVertexCount: f.foamVertexCount,
    firstIndex: f.firstIndex, indexCount: f.indexCount,
    spacing: f.spacing, columns: f.columns, shortened: f.shortened, rowLimit: f.rowLimit,
    ends: { ...f.ends }, landing: { ...f.landing },
    textureName: f.textureName ? fallTextureName(f.textureName) : null,
    mist: misty.has(f.slot),
  }));

  const sceneMists = mists.map(({ slot, mist }) => ({
    slot, id: m.falls[slot].id,
    widthFt: mist.widthFt, lengthFt: mist.lengthFt, heightFt: mist.heightFt, floorFt: mist.floorFt, density: mist.density,
    centre: [mist.centre[0] * unitsPerFt, (mist.floorFt + mist.heightFt / 2) * yUnitsPerFt, worldSize - mist.centre[1] * unitsPerFt],
    size: [mist.widthFt * unitsPerFt, mist.heightFt * yUnitsPerFt, mist.lengthFt * unitsPerFt],
    // Box local x along the mist's width axis: scene (wx, -wz), a turn about y of atan2(wz, wx).
    yaw: Math.atan2(mist.axisW[1], mist.axisW[0]),
    fog: { ...mist.fog, color: [...mist.fog.color] },
  }));

  return { vertices: m.vertices, indices: m.indices, positions, falls, mists: sceneMists, warnings };
}

/*
  The built falls' vertices in scene units: the anchor (crest point 0 at the crest height, ft) plus
  the vertex's 1/256 ft offset, x east at cellSize / 32 a foot, heights at heightScale a 2 ft step,
  z flipped to worldSize - z as the terrain is. 3 floats a vertex, in buffer order.
*/
export function fallScenePositions(meshes, { gridSize = TILES, cellSize = 64, heightScale = 3 } = {}) {
  const v = meshes.vertices;
  const count = v.length / FALL_VERTEX_FLOATS;
  const out = new Float32Array(count * 3);
  const unitsPerFt = cellSize / TILE_FT;
  const yUnitsPerFt = heightScale / FEET_PER_STEP;
  const worldSize = gridSize * cellSize;
  const k = 1 / FALL_VERTEX_UNITS_PER_FT;
  for (const f of meshes.falls) {
    const [ax, ay, az] = f.anchorFt;
    for (let i = f.firstVertex; i < f.firstVertex + f.vertexCount; i++) {
      const o = i * FALL_VERTEX_FLOATS;
      out[3 * i] = (ax + v[o] * k) * unitsPerFt;
      out[3 * i + 1] = (ay + v[o + 1] * k) * yUnitsPerFt;
      out[3 * i + 2] = worldSize - (az + v[o + 2] * k) * unitsPerFt;
    }
  }
  return out;
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
