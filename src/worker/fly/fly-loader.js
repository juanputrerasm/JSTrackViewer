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

  Scene space follows the other games: CELL_UNITS per cell, x east from the western edge of
  the tiles, z south from their northern edge, y up. Cells are treated as square. Fly's rows
  are cos(latitude) shorter than its columns are wide, which is exactly what keeps them near
  square on the ground (1.954 by 1.943 km at San Francisco), so the error is under 1%.
  Heights are feet, brought to the same scale as the ground so the relief is true.
*/

const CELL_UNITS = 64;
const PIXELS_PER_CELL = 32;
const TEXTURE_SIDE = 128;
const METRES_PER_DEGREE = 111_132;
const FEET_PER_METRE = 3.28084;
/** Relief is drawn this many times its real height. */
const VERTICAL_EXAGGERATION = 1;
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

  // Scene units per foot, from the ground size of a cell at the middle of the tiles.
  const middle = flyTileBounds(west, Math.round((south + north) / 2));
  const cellMetres = ((middle.north - middle.south) / FLY_TILE_CELLS) * METRES_PER_DEGREE;
  const unitsPerFoot = (CELL_UNITS / (cellMetres * FEET_PER_METRE)) * VERTICAL_EXAGGERATION;

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
        ...buildTileMesh(built.heights, (tile.column - west) * FLY_TILE_CELLS, (north - tile.row) * FLY_TILE_CELLS, unitsPerFoot),
        image: built.image,
      });
    }
  }
  if (missingTextures) {
    warnings.push(`${missingTextures} cells use Fly!'s generic terrain textures, which ship with the game rather than the scenery; drawn in flat colours.`);
  }
  flyTiles.sort((a, b) => b.row - a.row || a.column - b.column);

  const objects = await loadFlyObjects(indexed, tiles, { west, north, unitsPerFoot }, warnings);

  const tileNames = flyTiles.map((t) => t.folder).join(", ");
  return {
    origin: "FLY",
    format: "FLY",
    trackName: options.name || tileNames,
    fileName: archives.map((a) => a.name).join(", "),
    podComment: indexed.length === 1 ? indexed[0].pod.comment : "",
    terrain: {
      gridSize,
      cellSize: CELL_UNITS,
      heightScale: 1,
      minimap: buildMinimap(flyTiles, west, north, gridSize),
    },
    flyTiles,
    fly: {
      tiles: flyTiles.map((t) => t.folder),
      coverage: options.coverage ?? null,
      unitsPerFoot,
    },
    flyObjects: objects.placed,
    startView: startView(objects.placed, gridSize, unitsPerFoot),
    boxes: [],
    models: objects.models,
    modelTextures: objects.modelTextures,
    warnings,
  };
}

/*
  Buildings and landmarks: the objects the SCENERY.Sxx files of the loaded tiles place.

  An object is a model centred on its origin, placed by latitude, longitude and the altitude
  of that origin in feet. Its vertices are 256 to the foot, which is 2 of bin-decoder's units
  (it divides the words by 128), and the decoder moves each mesh's origin to the bottom
  centre, so the base stands at altitude + anchor.z / 2 feet. On San Francisco and Los Angeles
  that puts the median base exactly on the terrain (docs/FLY.md in OpenPhotex).

  .BIN models and the .BSP structures (the bridges, which OpenPhotex reads as the .BIN their
  nodes amount to) are drawn. .ARM beacons are not decoded yet, and a set's windsocks name
  models that ship with the game, not the scenery.
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
          placed.push({
            name: object.name,
            modelName: title,
            position: [cellX * CELL_UNITS, (object.altitude + model.anchor.z / 2) * frame.unitsPerFoot, cellZ * CELL_UNITS],
            heading: object.orientation[1],
            pitch: object.orientation[0],
            roll: object.orientation[2],
            scale: frame.unitsPerFoot / 2,
            // Feet, from the model's vertical extent in bin-decoder units (2 to the foot).
            height: model.rawVertexBounds ? (model.rawVertexBounds.maxZ - model.rawVertexBounds.minZ) / 128 : 0,
          });
        }
      }
    }
  }
  if (failed.size) warnings.push(`${failed.size} object model(s) are not in these archives: ${[...failed].sort().join(", ")}.`);
  for (const [ext, count] of skipped) warnings.push(`${count} object(s) use ${ext} models, which are not drawn yet.`);

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
  Where the camera opens: south of the tallest cluster of scenery, which is a city's downtown
  in every stock set, a few thousand feet up and looking north across it. Objects count by
  their height, so a district of towers outweighs an airport's rows of hangars. Without
  objects, the middle of the tiles from high up.
*/
function startView(placed, gridSize, unitsPerFoot) {
  const world = gridSize * CELL_UNITS;
  if (!placed.length) return { x: world / 2, y: world * 0.12, z: world * 0.75, yaw: 0, pitch: -30 };
  const cells = new Map();
  const cellOf = (object) => [Math.floor(object.position[0] / CELL_UNITS), Math.floor(object.position[2] / CELL_UNITS)];
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
  return { x, y: ground + 3000 * unitsPerFoot, z: z + 2 * CELL_UNITS, yaw: 0, pitch: -18 };
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
  const heights = new Float32Array(TILE_SIDE * TILE_SIDE);
  const side = FLY_TILE_CELLS * PIXELS_PER_CELL;
  const rgba = new Uint8ClampedArray(side * side * 4);
  let missingTextures = 0;

  for (let qx = 0; qx < 2; qx++) {
    for (let qy = 0; qy < 2; qy++) {
      const stem = `DATA/${tile.folder}/G${qx}${qy}`;
      const read = (ext) => {
        const entry = findPodEntry(pod, stem + ext);
        return entry ? readPodEntry(bytes, entry) : null;
      };
      let quadrant;
      try {
        quadrant = parseFlyQuadrant({ alt: read(".ALT"), typ: read(".TYP"), tex: read(".TEX"), ref: read(".REF"), al2: read(".AL2") }, stem);
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
        const name = quadrant.textures[quadrant.cellTextures[cell]];
        if (!await drawTexture(rgba, side, left, top, PIXELS_PER_CELL, name, tile, bytes, texturesByTitle)) {
          fill(rgba, side, left, top, PIXELS_PER_CELL, genericColour(name));
          missingTextures++;
        }
        // A kind 2 cell's 2 x 2 detail textures, where it has them, at twice the resolution.
        const subs = quadrant.cellSubTextures[cell];
        const half = PIXELS_PER_CELL / 2;
        for (let i = 0; subs && i < 4; i++) {
          if (subs[i] < 0) continue;
          const sx = i >> 1, sy = i & 1;
          await drawTexture(rgba, side, left + sx * half, top + (1 - sy) * half, half, quadrant.textures[subs[i]], tile, bytes, texturesByTitle);
        }
      }
    }
  }
  return { heights, image: { rgba, width: side, height: side }, missingTextures };
}

/*
  Draw one 128 px texture into the orthophoto, shrunk to `size` by averaging, which keeps the
  fine detail of the imagery from turning into noise. Looked up in its own folder first (a
  detail texture lives in a Dxxxyyy inside the tile folder, which its name encodes), then
  anywhere. Returns false when the texture or its palette is missing.
*/
async function drawTexture(rgba, side, left, top, size, name, tile, bytes, texturesByTitle) {
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
  const indices = await entryBytes(raw, tile, bytes);
  const palette = decodeActPalette(await entryBytes(act, tile, bytes));
  if (!palette || indices.length !== TEXTURE_SIDE * TEXTURE_SIDE) return false;

  const step = TEXTURE_SIDE / size;
  const area = step * step;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < step; sy++) {
        let at = (py * step + sy) * TEXTURE_SIDE + px * step;
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

async function entryBytes({ archive, entry }, tile, bytes) {
  if (archive === tile.archive) return readPodEntry(bytes, entry);
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
  A tile's mesh: one vertex per corner, shared by its cells, with UVs running once across the
  tile's orthophoto. `heights` is row by row from the north. v = 0 is the north edge, which is
  where a DataTexture's first row lands.
*/
function buildTileMesh(heights, cellX0, cellZ0, unitsPerFoot) {
  const count = TILE_SIDE * TILE_SIDE;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const at = (col, row) => heights[Math.min(TILE_SIDE - 1, Math.max(0, row)) * TILE_SIDE + Math.min(TILE_SIDE - 1, Math.max(0, col))] * unitsPerFoot;
  for (let row = 0; row < TILE_SIDE; row++) {
    for (let col = 0; col < TILE_SIDE; col++) {
      const i = row * TILE_SIDE + col;
      positions[i * 3] = (cellX0 + col) * CELL_UNITS;
      positions[i * 3 + 1] = at(col, row);
      positions[i * 3 + 2] = (cellZ0 + row) * CELL_UNITS;
      // (-dh/dx, 1, -dh/dz) by central differences, scaled by 2 cells; row, like z, grows southward.
      const nx = at(col - 1, row) - at(col + 1, row);
      const nz = at(col, row - 1) - at(col, row + 1);
      const ny = 2 * CELL_UNITS;
      const length = Math.hypot(nx, ny, nz);
      normals[i * 3] = nx / length;
      normals[i * 3 + 1] = ny / length;
      normals[i * 3 + 2] = nz / length;
      uvs[i * 2] = col / FLY_TILE_CELLS;
      uvs[i * 2 + 1] = row / FLY_TILE_CELLS;
    }
  }
  const indices = new Uint32Array(FLY_TILE_CELLS * FLY_TILE_CELLS * 6);
  let k = 0;
  for (let row = 0; row < FLY_TILE_CELLS; row++) {
    for (let col = 0; col < FLY_TILE_CELLS; col++) {
      const a = row * TILE_SIDE + col, b = a + 1, c = a + TILE_SIDE, d = c + 1;
      // Counter-clockwise seen from above (+y), with z pointing south.
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }
  return { positions, normals, uvs, indices };
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
