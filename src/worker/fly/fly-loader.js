import {
  parsePod, podDirectoryEnd, findPodEntry, readPodEntry, decodeActPalette, parseFlyQuadrant, parseFlyTextureName,
  parseFlyFolderName, flyTileBounds, flyTileAt, parseFlySceneryObjects, parseFlyBsp, FLY_TILE_CELLS, FLY_QUADRANT_CELLS, FLY_ALT_SIDE,
} from "../../vendor/openphotex/index.js";
import { decodeBinModel, decodeParsedBin } from "../bin-decoder.js";
import { decodeRawTexture } from "../texture-decoder.js";

/*
  Loads Fly! scenery (1999) into the viewer: the terrain of every globe tile found in the
  archives given, draped with its satellite imagery.

  The formats are OpenPhotex's (see its docs/FLY.md); this file only assembles them. What
  comes in is either a whole scenery set, the archives an .SCF lists, or a single numbered
  EPD, which carries one globe tile on its own.

  A globe tile is 64 x 64 cells of about 2 km. Every cell has its own 128 px satellite
  texture, 16,384 of them in a four-tile city, which is far too many for the viewer's usual
  one-slot-per-texture terrain atlas. So each tile gets one picture instead, an orthophoto
  stitched from its cells at PIXELS_PER_CELL, drawn over one continuous mesh.

  Scene space is the other games' (drive/world-frame.js): 2 units to the foot across the map
  and 1.5 up it, x east from the western edge of the tiles, z south from their northern edge,
  y up. Being in the same units as every other world is what lets Test Drive's truck, its
  cameras and its physics work here unchanged. A cell is about 6,400 ft, so a city is some
  1.6 million units across. Cells are treated as square: Fly's rows are cos(latitude) shorter
  than its columns are wide, which is exactly what keeps them near square on the ground
  (1.954 by 1.943 km at San Francisco), so the error is under 1%.
*/

/** Scene units per foot, across and up: world-frame.js's UNITS_PER_FOOT_H and _V. */
const UNITS_PER_FOOT_H = 2;
const UNITS_PER_FOOT_V = 1.5;
const PIXELS_PER_CELL = 32;
/*
  Near the camera the scene asks for chunks of 8 x 8 cells at the textures' own 128 px a cell
  (renderFlyDetail), four times the tile orthophoto's resolution. A whole city at that size
  would be about 1 GB of textures, so only the nearest chunks get one.
*/
const DETAIL_CHUNK_CELLS = 8;
/** Mesh points along a cell side: the finest any stock cell's .AL2 heights divide it. */
const MESH_SUBDIVISIONS = 4;
const DETAIL_PIXELS_PER_CELL = 128;
const TEXTURE_SIDE = 128;
const METRES_PER_DEGREE = 111_132;
const FEET_PER_METRE = 3.28084;
/*
  Cells outside a set's photographed area name generic textures, wt000s1.raw to wt888s1.raw,
  which ship with the game rather than the scenery, so such a cell is drawn in a flat colour.
  The three digits run 0 to 8 and look like terrain classes, one per corner or edge: 0 is
  water (San Francisco's wt000 cells are water where its coastline map says so in 4,961 of
  5,459 cases), and every other digit is some kind of land, 444 across the Mojave and 888
  around New York. What the land classes mean is unknown, so they share one colour, and a
  mixed name such as wt550 averages to a shoreline shade.
*/
const WATER_RGB = [38, 70, 84];
const LAND_RGB = [124, 122, 92];
const MINIMAP_SIDE = 512;
const TILE_SIDE = FLY_TILE_CELLS + 1;
const QUADRANT_ALT = new RegExp(`^DATA/(D\\d{6})/G([01])([01])\\.ALT$`);

/**
 * @param {{ blob: Blob, name: string }[]} archives
 * @param {{ name?: string, coverage?: object|null }} [options]
 */
export async function loadFlyScenery(archives, options = {}) {
  const warnings = [];
  const indexed = [];
  for (const archive of archives) {
    try {
      indexed.push({ ...archive, pod: await indexBlob(archive.blob) });
    } catch (err) {
      warnings.push(`${archive.name}: ${err?.message ?? err}`);
    }
  }

  // Every globe tile any archive carries terrain for, and which archive that is.
  const tiles = new Map();
  for (const archive of indexed) {
    for (const entry of archive.pod.entries) {
      const match = QUADRANT_ALT.exec(entry.normalizedName);
      if (!match || tiles.has(match[1])) continue;
      const place = parseFlyFolderName(match[1]);
      tiles.set(match[1], { folder: match[1], column: place.first, row: place.second, archive });
    }
  }
  if (!tiles.size) throw new Error("No Fly! terrain in these archives: no DATA\\Dxxxyyy\\G00.ALT.");

  // Texture titles across every archive, for the rare cell that borrows one from elsewhere.
  const texturesByTitle = new Map();
  for (const archive of indexed) {
    for (const entry of archive.pod.entries) {
      if (entry.title.endsWith(".RAW") || entry.title.endsWith(".ACT")) {
        texturesByTitle.set(`${entry.normalizedName.split("/").slice(0, -1).join("/")}|${entry.title}`, { archive, entry });
        if (!texturesByTitle.has(entry.title)) texturesByTitle.set(entry.title, { archive, entry });
      }
    }
  }

  const all = [...tiles.values()];
  const west = Math.min(...all.map((t) => t.column));
  const east = Math.max(...all.map((t) => t.column));
  const south = Math.min(...all.map((t) => t.row));
  const north = Math.max(...all.map((t) => t.row));
  const gridSize = Math.max(east - west + 1, north - south + 1) * FLY_TILE_CELLS;

  // A cell's side in scene units, from its ground size at the middle of the tiles.
  const middle = flyTileBounds(west, Math.round((south + north) / 2));
  const cellMetres = ((middle.north - middle.south) / FLY_TILE_CELLS) * METRES_PER_DEGREE;
  const cellUnits = cellMetres * FEET_PER_METRE * UNITS_PER_FOOT_H;

  // One archive's bytes at a time: a tile's files and textures sit in the archive it came from.
  const flyTiles = [];
  let missingTextures = 0;
  for (const archive of indexed) {
    const own = all.filter((t) => t.archive === archive);
    if (!own.length) continue;
    const bytes = new Uint8Array(await archive.blob.arrayBuffer());
    for (const tile of own) {
      const built = await buildTile(tile, bytes, texturesByTitle, warnings);
      missingTextures += built.missingTextures;
      flyTiles.push({
        folder: tile.folder,
        column: tile.column,
        row: tile.row,
        bounds: flyTileBounds(tile.column, tile.row),
        ...buildTileMesh(refineHeights(built.heights, tile.quadrants), (tile.column - west) * FLY_TILE_CELLS, (north - tile.row) * FLY_TILE_CELLS, cellUnits),
        image: built.image,
        night: built.night,
      });
    }
  }
  if (missingTextures) {
    warnings.push(`${missingTextures} cells use Fly!'s generic terrain textures, which ship with the game rather than the scenery; drawn in flat colours.`);
  }
  flyTiles.sort((a, b) => b.row - a.row || a.column - b.column);

  const heightsFeet = stitchHeights(flyTiles, west, north, gridSize);
  const objects = await loadFlyObjects(indexed, tiles, { west, north, cellUnits, heightsFeet }, warnings);

  // Kept for renderFlyDetail: the tiles with their parsed quadrants, and where every texture is.
  session = { tiles, texturesByTitle };

  const tileNames = flyTiles.map((t) => t.folder).join(", ");
  return {
    origin: "FLY",
    format: "FLY",
    trackName: options.name || tileNames,
    fileName: archives.map((a) => a.name).join(", "),
    podComment: indexed.length === 1 ? indexed[0].pod.comment : "",
    terrain: {
      gridSize,
      cellSize: cellUnits,
      // The ground in feet for Test Drive, the whole map on one grid (world-frame.js).
      heightsFeet,
      heightScale: 1,
      minimap: buildMinimap(flyTiles, west, north, gridSize),
    },
    flyTiles,
    fly: {
      tiles: flyTiles.map((t) => t.folder),
      coverage: options.coverage ?? null,
      unitsPerFoot: UNITS_PER_FOOT_H,
      unitsPerFootV: UNITS_PER_FOOT_V,
      detailChunkCells: DETAIL_CHUNK_CELLS,
      detailPixelsPerCell: DETAIL_PIXELS_PER_CELL,
    },
    flyObjects: objects.placed,
    startView: startView(objects.placed, gridSize, cellUnits),
    boxes: [],
    models: objects.models,
    modelTextures: objects.modelTextures,
    warnings,
  };
}

/*
  Buildings and landmarks: the objects the SCENERY.Sxx files of the loaded tiles place.

  An object is a model centred on its origin, placed by latitude and longitude. Its vertices
  are 256 to the foot, which is 2 of bin-decoder's units (it divides the words by 128):
  exactly the scene's horizontal scale, so a Fly! model is drawn as an MTM one is. The
  decoder moves each mesh's origin to the bottom centre. When <flag> bit 0 is set (all stock
  objects), Fly! relocates that base onto the terrain; otherwise it stands at the stored
  origin altitude plus the model's lower extent. See docs/FLY.md in OpenPhotex.

  .BIN models and the .BSP structures (the bridges, which OpenPhotex reads as the .BIN their
  nodes amount to) are drawn. The beacons (.ARM) and windsocks name models that ship with the
  game rather than the scenery, so they cannot be.
*/
async function loadFlyObjects(indexed, tiles, frame, warnings) {
  const byTitle = new Map();
  for (const archive of indexed) {
    for (const entry of archive.pod.entries) if (!byTitle.has(entry.title)) byTitle.set(entry.title, { archive, entry });
  }
  const read = async ({ archive, entry }) =>
    new Uint8Array(await archive.blob.slice(entry.offset, entry.offset + entry.length).arrayBuffer());

  const models = {};
  const failed = new Set();
  const skipped = new Map();
  const placed = [];
  for (const archive of indexed) {
    for (const entry of archive.pod.entries) {
      const match = /^DATA\/(D\d{6})\/SCENERY\.S[01][01]$/.exec(entry.normalizedName);
      if (!match || !tiles.has(match[1])) continue;
      const { objects, warnings: parseWarnings } = parseFlySceneryObjects(await read({ archive, entry }), entry.name);
      warnings.push(...parseWarnings);
      for (const object of objects) {
        for (const file of chooseModels(object.models)) {
          const title = file.toUpperCase();
          if (!title.endsWith(".BIN") && !title.endsWith(".BSP")) {
            const ext = title.slice(title.lastIndexOf("."));
            skipped.set(ext, (skipped.get(ext) ?? 0) + 1);
            continue;
          }
          if (!models[title] && !failed.has(title)) {
            const source = byTitle.get(title);
            const model = source ? await decodeFlyModel(await read(source), title, warnings) : null;
            if (model?.meshes?.length) models[title] = model;
            else failed.add(title);
          }
          const model = models[title];
          if (!model) continue;
          const at = flyTileAt(object.latitude, object.longitude);
          const cellX = (at.column - frame.west) * FLY_TILE_CELLS + at.x;
          const cellZ = (frame.north - at.row) * FLY_TILE_CELLS + (FLY_TILE_CELLS - at.y);
          const x = cellX * frame.cellUnits, z = cellZ * frame.cellUnits;
          const baseFeet = object.snapToGround
            ? flyTerrainHeight(x, z, frame.heightsFeet, frame.cellUnits)
            : object.altitude + model.anchor.z / 2;
          placed.push({
            name: object.name,
            modelName: title,
            position: [x, baseFeet * UNITS_PER_FOOT_V, z],
            snapToGround: object.snapToGround,
            heading: object.orientation[1],
            pitch: object.orientation[0],
            roll: object.orientation[2],
            // Feet, from the model's vertical extent in bin-decoder units (2 to the foot).
            height: model.rawVertexBounds ? (model.rawVertexBounds.maxZ - model.rawVertexBounds.minZ) / 128 : 0,
          });
        }
      }
    }
  }
  if (failed.size) warnings.push(`${failed.size} object model(s) are not in these archives: ${[...failed].sort().join(", ")}.`);
  // .ARM (beacons) is the only other kind a stock set names, and no set carries one.
  for (const [ext, count] of skipped) warnings.push(`${count} object(s) use ${ext} models, which are not in the scenery (they ship with the game).`);

  // The models' textures: 256 px .RAW files with a same-stem .ACT, at the archive root.
  const modelTextures = [];
  const cutouts = new Set(Object.values(models).flatMap((m) => m.meshes.filter((mesh) => mesh.transparent).map((mesh) => mesh.textureName)));
  for (const name of new Set(Object.values(models).flatMap((m) => m.textureNames))) {
    const raw = byTitle.get(name);
    const act = byTitle.get(name.replace(/\.RAW$/, ".ACT"));
    if (!raw || !act) continue;
    try {
      const decoded = decodeRawTexture(await read(raw), await read(act), name, cutouts.has(name) ? { cutout: true } : undefined);
      modelTextures.push({ name, rgba: decoded.rgba.buffer, width: decoded.width, height: decoded.height });
    } catch (err) {
      warnings.push(`${name}: ${err?.message ?? err}`);
    }
  }
  return { placed, models, modelTextures };
}

/*
  Height in feet under a scene-space point, over the same north-east to south-west triangle
  split used by the Fly! meshes and Test Drive's world frame. The stitched grid is already
  row-major from the north, with `subdivisions` samples per terrain cell.
*/
function flyTerrainHeight(x, z, { data, side, subdivisions }, cellUnits) {
  const step = cellUnits / subdivisions;
  const gx = Math.min(side - 1.000001, Math.max(0, x / step));
  const gz = Math.min(side - 1.000001, Math.max(0, z / step));
  const col = Math.floor(gx), row = Math.floor(gz);
  const u = gx - col, w = gz - row;
  const at = (dx, dz) => data[(row + dz) * side + col + dx];
  const a = at(0, 0), b = at(1, 0), c = at(0, 1), d = at(1, 1);
  return u + w <= 1
    ? a + (b - a) * u + (c - a) * w
    : d + (c - d) * (1 - u) + (b - d) * (1 - w);
}

/*
  Where the camera opens: south of the tallest cluster of scenery, which is a city's downtown
  in every stock set, a few thousand feet up and looking north across it. Objects count by
  their height, so a district of towers outweighs an airport's rows of hangars. Without
  objects, the middle of the tiles from high up.
*/
function startView(placed, gridSize, cellUnits) {
  const world = gridSize * cellUnits;
  if (!placed.length) return { x: world / 2, y: world * 0.12, z: world * 0.75, yaw: 0, pitch: -30 };
  const cells = new Map();
  const cellOf = (object) => [Math.floor(object.position[0] / cellUnits), Math.floor(object.position[2] / cellUnits)];
  for (const object of placed) {
    const key = cellOf(object).join(",");
    cells.set(key, (cells.get(key) ?? 0) + object.height);
  }
  let best = null, bestWeight = -1;
  for (const object of placed) {
    const [cx, cz] = cellOf(object);
    let weight = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) weight += cells.get(`${cx + dx},${cz + dz}`) ?? 0;
    if (weight > bestWeight) { bestWeight = weight; best = object; }
  }
  const [x, ground, z] = best.position;
  return { x, y: ground + 3000 * UNITS_PER_FOOT_V, z: z + 2 * cellUnits, yaw: 0, pitch: -18 };
}

/** A .BIN, or a .BSP read as the .BIN it amounts to, as bin-decoder's model. */
async function decodeFlyModel(bytes, title, warnings) {
  if (!title.endsWith(".BSP")) return decodeBinModel(bytes, title, "FLY");
  try {
    return decodeParsedBin(parseFlyBsp(bytes, title).model, title, "FLY");
  } catch (err) {
    warnings.push(`${title}: ${err?.message ?? err}`);
    return null;
  }
}

/*
  The model files an object shows. Each part (usually just `comp`) shows once: a part listed
  with distance ranges (<mdst>) takes the one for the nearest view.
*/
function chooseModels(models) {
  const byPart = new Map();
  for (const model of models) {
    const best = byPart.get(model.part);
    if (!best || (model.near ?? 0) < (best.near ?? 0)) byPart.set(model.part, model);
  }
  return [...byPart.values()].map((model) => model.file);
}

/** The scenery loadFlyScenery last loaded, for renderFlyDetail. One set is open at a time. */
let session = null;

/**
 * One chunk of a loaded tile's imagery at full resolution: DETAIL_CHUNK_CELLS square, chunk
 * (0, 0) at the tile's north-west corner, row 0 at the north edge like the tile orthophoto.
 * Textures are read from the archives' Blobs as needed.
 */
export async function renderFlyDetail(folder, chunkX, chunkZ) {
  const tile = session?.tiles.get(folder);
  if (!tile?.quadrants) throw new Error(`No Fly! tile ${folder} is loaded.`);
  const size = DETAIL_CHUNK_CELLS * DETAIL_PIXELS_PER_CELL;
  const rgba = new Uint8ClampedArray(size * size * 4);
  const read = ({ archive, entry }) => readBlobEntry(archive, entry);
  for (let dx = 0; dx < DETAIL_CHUNK_CELLS; dx++) {
    for (let dz = 0; dz < DETAIL_CHUNK_CELLS; dz++) {
      const x = chunkX * DETAIL_CHUNK_CELLS + dx;
      const y = FLY_TILE_CELLS - 1 - (chunkZ * DETAIL_CHUNK_CELLS + dz);
      const quadrant = tile.quadrants[`${x >> 5}${y >> 5}`];
      if (!quadrant) continue;
      const cell = (x % FLY_QUADRANT_CELLS) * FLY_QUADRANT_CELLS + (y % FLY_QUADRANT_CELLS);
      await drawCell(rgba, size, dx * DETAIL_PIXELS_PER_CELL, dz * DETAIL_PIXELS_PER_CELL, DETAIL_PIXELS_PER_CELL,
        quadrant, cell, tile, read, session.texturesByTitle);
    }
  }
  return { rgba, width: size, height: size };
}

/** The directory of an archive held as a Blob, reading only as much of it as that needs. */
async function indexBlob(blob) {
  let prefix = new Uint8Array(0);
  for (;;) {
    const need = podDirectoryEnd(prefix, blob.size);
    if (need <= prefix.length) break;
    prefix = new Uint8Array(await blob.slice(0, need).arrayBuffer());
  }
  return parsePod(prefix, { byteLength: blob.size });
}

/*
  One globe tile: its 65 x 65 corner heights (feet, row by row from the NORTH, west to east,
  ready for the mesh) and its orthophoto (row 0 at the north edge).
*/
async function buildTile(tile, bytes, texturesByTitle, warnings) {
  const { pod } = tile.archive;
  tile.quadrants = {};
  // The tile's archive is in memory; a texture borrowed from another is sliced out of its Blob.
  const read = ({ archive, entry }) => archive === tile.archive ? readPodEntry(bytes, entry) : readBlobEntry(archive, entry);
  const heights = new Float32Array(TILE_SIDE * TILE_SIDE);
  const side = FLY_TILE_CELLS * PIXELS_PER_CELL;
  const rgba = new Uint8ClampedArray(side * side * 4);
  let missingTextures = 0;
  // The emissive city lights of a *NIGHT.EPD, only for a tile that has some.
  let night = null;

  for (let qx = 0; qx < 2; qx++) {
    for (let qy = 0; qy < 2; qy++) {
      const stem = `DATA/${tile.folder}/G${qx}${qy}`;
      const file = (ext) => {
        const entry = findPodEntry(pod, stem + ext);
        return entry ? readPodEntry(bytes, entry) : null;
      };
      let quadrant;
      try {
        quadrant = parseFlyQuadrant({ alt: file(".ALT"), typ: file(".TYP"), tex: file(".TEX"), ref: file(".REF"), al2: file(".AL2") }, stem);
      } catch (err) {
        warnings.push(`${stem}: ${err?.message ?? err}`);
        continue;
      }
      const x0 = qx * FLY_QUADRANT_CELLS, y0 = qy * FLY_QUADRANT_CELLS;
      for (let x = 0; x < FLY_ALT_SIDE; x++) {
        for (let y = 0; y < FLY_ALT_SIDE; y++) {
          heights[(FLY_TILE_CELLS - (y0 + y)) * TILE_SIDE + x0 + x] = quadrant.heights[x * FLY_ALT_SIDE + y];
        }
      }
      for (let cell = 0; cell < FLY_QUADRANT_CELLS * FLY_QUADRANT_CELLS; cell++) {
        const x = x0 + Math.floor(cell / FLY_QUADRANT_CELLS);
        const y = y0 + (cell % FLY_QUADRANT_CELLS);
        const left = x * PIXELS_PER_CELL;
        const top = (FLY_TILE_CELLS - 1 - y) * PIXELS_PER_CELL;
        if (!await drawCell(rgba, side, left, top, PIXELS_PER_CELL, quadrant, cell, tile, read, texturesByTitle)) missingTextures++;
        // A cell with city lights has a night texture beside its own, the same name plus N.
        const lights = quadrant.textures[quadrant.cellTextures[cell]]?.toUpperCase().replace(/\.RAW$/, "N.RAW");
        if (lights && texturesByTitle.has(`DATA/${tile.folder}|${lights}`)) {
          night ??= new Uint8ClampedArray(side * side * 4);
          await drawTexture(night, side, left, top, PIXELS_PER_CELL, lights, tile, read, texturesByTitle);
        }
      }
      tile.quadrants[`${qx}${qy}`] = quadrant;
    }
  }
  return { heights, image: { rgba, width: side, height: side }, night: night && { rgba: night, width: side, height: side }, missingTextures };
}

/*
  One cell of imagery, `size` pixels square with its top left at (left, top): its texture,
  or the flat colour of a generic one, then a kind 2 cell's 2 x 2 detail textures over it,
  each a quarter of the cell. Returns false when the cell's own texture is missing.
*/
async function drawCell(rgba, side, left, top, size, quadrant, cell, tile, read, texturesByTitle) {
  const name = quadrant.textures[quadrant.cellTextures[cell]];
  const drawn = await drawTexture(rgba, side, left, top, size, name, tile, read, texturesByTitle);
  if (!drawn) fill(rgba, side, left, top, size, genericColour(name));
  const subs = quadrant.cellSubTextures[cell];
  const half = size / 2;
  for (let i = 0; subs && i < 4; i++) {
    if (subs[i] < 0) continue;
    const sx = i >> 1, sy = i & 1;
    await drawTexture(rgba, side, left + sx * half, top + (1 - sy) * half, half, quadrant.textures[subs[i]], tile, read, texturesByTitle);
  }
  return drawn;
}

/*
  Draw one 128 px texture into the orthophoto, shrunk to `size` by averaging, which keeps the
  fine detail of the imagery from turning into noise. Looked up in its own folder first (a
  detail texture lives in a Dxxxyyy inside the tile folder, which its name encodes), then
  anywhere. Returns false when the texture or its palette is missing.
*/
async function drawTexture(rgba, side, left, top, size, name, tile, read, texturesByTitle) {
  if (!name) return false;
  const title = name.toUpperCase();
  const parsed = parseFlyTextureName(title);
  let folder = `DATA/${tile.folder}`;
  if (parsed && `D${String(parsed.folderFirst).padStart(3, "0")}${String(parsed.folderSecond).padStart(3, "0")}` !== tile.folder) {
    folder += `/D${String(parsed.folderFirst).padStart(3, "0")}${String(parsed.folderSecond).padStart(3, "0")}`;
  }
  const raw = texturesByTitle.get(`${folder}|${title}`) ?? texturesByTitle.get(title);
  const act = texturesByTitle.get(`${folder}|${title.replace(/\.RAW$/, ".ACT")}`) ?? texturesByTitle.get(title.replace(/\.RAW$/, ".ACT"));
  if (!raw || !act) return false;
  const indices = await read(raw);
  const palette = decodeActPalette(await read(act));
  // 128 px for the imagery, 64 px for the night lights; drawn at `size` or, if larger, repeated.
  const textureSide = Math.sqrt(indices.length);
  if (!palette || !Number.isInteger(textureSide) || textureSide > TEXTURE_SIDE) return false;

  const step = Math.max(1, textureSide / size);
  const area = step * step;
  const scale = textureSide / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < step; sy++) {
        let at = Math.floor(py * scale + sy) * textureSide + Math.floor(px * scale);
        for (let sx = 0; sx < step; sx++, at++) {
          const c = indices[at] * 3;
          r += palette[c]; g += palette[c + 1]; b += palette[c + 2];
        }
      }
      const o = ((top + py) * side + left + px) * 4;
      rgba[o] = r / area; rgba[o + 1] = g / area; rgba[o + 2] = b / area; rgba[o + 3] = 255;
    }
  }
  return true;
}

async function readBlobEntry(archive, entry) {
  return new Uint8Array(await archive.blob.slice(entry.offset, entry.offset + entry.length).arrayBuffer());
}

/** The flat colour for a generic wt<abc> texture: water for each 0 digit, land for the rest. */
function genericColour(name) {
  const digits = /^wt([0-9]{3})/i.exec(name ?? "")?.[1];
  if (!digits) return WATER_RGB;
  const water = [...digits].filter((d) => d === "0").length / digits.length;
  return [0, 1, 2].map((c) => WATER_RGB[c] * water + LAND_RGB[c] * (1 - water));
}

function fill(rgba, side, left, top, size, [r, g, b]) {
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const o = ((top + py) * side + left + px) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
}

/*
  A tile's heights at MESH_SUBDIVISIONS points a cell side, row by row from the north.

  Most cells are flat planes between their four .ALT corners, and are filled in bilinearly.
  A cell whose .TYP kind is not 0 carries its own finer heights in .AL2, 3 x 3 or 5 x 5
  points including its corners, and those take over its points, edges included. Neighbours
  share the edge points, so a plain cell next to a refined one bends to meet it rather than
  leaving a crack. 4 points a side is the finest any stock cell is divided (type:1: 4,4).
*/
function refineHeights(coarse, quadrants) {
  const side = FLY_TILE_CELLS * MESH_SUBDIVISIONS + 1;
  const fine = new Float32Array(side * side);
  const corner = (col, row) => coarse[Math.min(TILE_SIDE - 1, row) * TILE_SIDE + Math.min(TILE_SIDE - 1, col)];
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const r = row / MESH_SUBDIVISIONS, c = col / MESH_SUBDIVISIONS;
      const r0 = Math.min(FLY_TILE_CELLS - 1, Math.floor(r)), c0 = Math.min(FLY_TILE_CELLS - 1, Math.floor(c));
      const tr = r - r0, tc = c - c0;
      fine[row * side + col] =
        (corner(c0, r0) * (1 - tc) + corner(c0 + 1, r0) * tc) * (1 - tr) +
        (corner(c0, r0 + 1) * (1 - tc) + corner(c0 + 1, r0 + 1) * tc) * tr;
    }
  }
  for (const [key, quadrant] of Object.entries(quadrants)) {
    const qx = Number(key[0]) * FLY_QUADRANT_CELLS, qy = Number(key[1]) * FLY_QUADRANT_CELLS;
    quadrant.cellHeights.forEach((block, cell) => {
      if (!block) return;
      const n = quadrant.cellTypes[cell].divisions;
      const x = qx + Math.floor(cell / FLY_QUADRANT_CELLS), y = qy + (cell % FLY_QUADRANT_CELLS);
      // The block is column-major too: index a * (n + 1) + b, a east and b north.
      const at = (a, b) => block[a * (n + 1) + b];
      for (let i = 0; i <= MESH_SUBDIVISIONS; i++) {
        for (let j = 0; j <= MESH_SUBDIVISIONS; j++) {
          const a = (i * n) / MESH_SUBDIVISIONS, b = (j * n) / MESH_SUBDIVISIONS;
          const a0 = Math.min(n - 1, Math.floor(a)), b0 = Math.min(n - 1, Math.floor(b));
          const ta = a - a0, tb = b - b0;
          const h = (at(a0, b0) * (1 - ta) + at(a0 + 1, b0) * ta) * (1 - tb) + (at(a0, b0 + 1) * (1 - ta) + at(a0 + 1, b0 + 1) * ta) * tb;
          fine[((FLY_TILE_CELLS - y) * MESH_SUBDIVISIONS - j) * side + x * MESH_SUBDIVISIONS + i] = h;
        }
      }
    });
  }
  return fine;
}

/*
  A tile's mesh: one vertex per point of the refined grid, shared by its cells, with UVs
  running once across the tile's orthophoto. `heights` is row by row from the north. v = 0 is
  the north edge, which is where a DataTexture's first row lands.
*/
function buildTileMesh(heights, cellX0, cellZ0, cellUnits) {
  const sub = MESH_SUBDIVISIONS;
  const side = FLY_TILE_CELLS * sub + 1;
  const step = cellUnits / sub;
  const count = side * side;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const at = (col, row) => heights[Math.min(side - 1, Math.max(0, row)) * side + Math.min(side - 1, Math.max(0, col))] * UNITS_PER_FOOT_V;
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const i = row * side + col;
      positions[i * 3] = cellX0 * cellUnits + col * step;
      positions[i * 3 + 1] = at(col, row);
      positions[i * 3 + 2] = cellZ0 * cellUnits + row * step;
      // (-dh/dx, 1, -dh/dz) by central differences, scaled by 2 steps; row, like z, grows southward.
      const nx = at(col - 1, row) - at(col + 1, row);
      const nz = at(col, row - 1) - at(col, row + 1);
      const ny = 2 * step;
      const length = Math.hypot(nx, ny, nz);
      normals[i * 3] = nx / length;
      normals[i * 3 + 1] = ny / length;
      normals[i * 3 + 2] = nz / length;
      uvs[i * 2] = col / (side - 1);
      uvs[i * 2 + 1] = row / (side - 1);
    }
  }
  const cells = side - 1;
  const indices = new Uint32Array(cells * cells * 6);
  let k = 0;
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      const a = row * side + col, b = a + 1, c = a + side, d = c + 1;
      // Counter-clockwise seen from above (+y), with z pointing south.
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }
  return { positions, normals, uvs, indices, subdivisions: sub, heightsFeet: heights };
}

/*
  Every tile's refined heights on one grid over the whole square map, in feet, row by row from
  the north, MESH_SUBDIVISIONS points a cell side; 0 (sea level) where no tile is loaded.
  Test Drive samples it in the same triangles the meshes are cut into (world-frame.js).
*/
function stitchHeights(flyTiles, west, north, gridSize) {
  const sub = MESH_SUBDIVISIONS;
  const side = gridSize * sub + 1;
  const tileSide = FLY_TILE_CELLS * sub + 1;
  const data = new Float32Array(side * side);
  for (const tile of flyTiles) {
    const left = (tile.column - west) * FLY_TILE_CELLS * sub;
    const top = (north - tile.row) * FLY_TILE_CELLS * sub;
    for (let row = 0; row < tileSide; row++) {
      data.set(tile.heightsFeet.subarray(row * tileSide, (row + 1) * tileSide), (top + row) * side + left);
    }
  }
  return { data, side, subdivisions: sub };
}

/** The minimap: every tile's orthophoto shrunk onto the square world the map shows. */
function buildMinimap(flyTiles, west, north, gridSize) {
  const rgba = new Uint8ClampedArray(MINIMAP_SIDE * MINIMAP_SIDE * 4);
  const perCell = MINIMAP_SIDE / gridSize;
  for (const tile of flyTiles) {
    const { rgba: src, width } = tile.image;
    const left = (tile.column - west) * FLY_TILE_CELLS * perCell;
    const top = (north - tile.row) * FLY_TILE_CELLS * perCell;
    const size = FLY_TILE_CELLS * perCell;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = (Math.floor((y / size) * width) * width + Math.floor((x / size) * width)) * 4;
        const d = ((Math.floor(top) + y) * MINIMAP_SIDE + Math.floor(left) + x) * 4;
        rgba[d] = src[s]; rgba[d + 1] = src[s + 1]; rgba[d + 2] = src[s + 2]; rgba[d + 3] = 255;
      }
    }
  }
  return { rgba, width: MINIMAP_SIDE, height: MINIMAP_SIDE };
}
