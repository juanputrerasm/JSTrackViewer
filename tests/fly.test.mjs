import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { flySetsFromFolder } from "../src/fly-folder.js";
import { loadFlyScenery, renderFlyDetail } from "../src/worker/fly/fly-loader.js";
import { parsePod, findPodEntry, readPodEntry, decodeActPalette } from "../src/vendor/openphotex/index.js";

/** What a browser's folder picker hands over: Files carrying their path under the folder. */
function pickedFile(path, text = "") {
  const file = new File([text], path.split("/").pop());
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

const scf = (name, files) => [
  "<bgno> ==== BEGIN SCENERY FILE ====",
  "<name> ---- scenery set name ----", name,
  "<call>", "36 43 17.33 N", "123 45 00.00 W",
  "<caur>", "38 57 32.71 N", "120 56 15.00 W",
  ...files.flatMap((f) => ["<file> ---- pod file ----", f]),
  "<endo>",
].join("\r\n");

test("Open from Folder: a set's archives are found beside its .SCF, ignoring case", async () => {
  const { folder, sets } = await flySetsFromFolder([
    pickedFile("SANFRAN/SANFRAN.SCF", scf("San Francisco", ["sanfran1.epd", "sfmodels.epd", "gone.epd"])),
    pickedFile("SANFRAN/SANFRAN1.EPD"),
    pickedFile("SANFRAN/SFMODELS.EPD"),
    pickedFile("SANFRAN/.DS_Store"),
  ]);
  assert.equal(folder, "SANFRAN");
  assert.equal(sets.length, 1);
  assert.equal(sets[0].name, "San Francisco");
  assert.equal(sets[0].directory, "SANFRAN");
  assert.deepEqual(sets[0].archives.map((f) => f.name), ["SANFRAN1.EPD", "SFMODELS.EPD"]);
  assert.deepEqual(sets[0].missing, ["gone.epd"]);
  assert.equal(sets[0].coverage.west, -123.75);
});

test("Open from Folder: a folder above the sets offers each, and only its own archives", async () => {
  const { folder, sets } = await flySetsFromFolder([
    pickedFile("Scenery/LA/LA.SCF", scf("Los Angeles", ["la1.epd"])),
    pickedFile("Scenery/LA/LA1.EPD"),
    pickedFile("Scenery/DALLAS/DALLAS.SCF", scf("Dallas", ["dallas1.epd", "la1.epd"])),
    pickedFile("Scenery/DALLAS/DALLAS1.EPD"),
  ]);
  assert.equal(folder, "Scenery");
  assert.deepEqual(sets.map((s) => s.name), ["Dallas", "Los Angeles"]);
  // Dallas names la1.epd, which is in another set's folder: that is not beside its .SCF.
  assert.deepEqual(sets[0].missing, ["la1.epd"]);
  assert.equal((await flySetsFromFolder([pickedFile("Tracks/A.POD")])).sets.length, 0);
});

const SF = `${process.env.HOME}/games/Fly/Scenery/SANFRAN`;
const skipSf = existsSync(`${SF}/SANFRAN1.EPD`) ? false : `no Fly! install at ${SF}`;
const archive = (name) => ({ name, blob: new Blob([readFileSync(`${SF}/${name}`)]) });

/*
  San Francisco end to end: four globe tiles laid out north-west first, heights in place, and
  imagery where the set photographed it.
*/
test("Fly! San Francisco loads as four textured globe tiles", { skip: skipSf }, async () => {
  const result = await loadFlyScenery(
    ["SANFRAN1.EPD", "SANFRAN2.EPD", "SANFRAN3.EPD", "SANFRAN4.EPD", "SFMODELS.EPD"].map(archive),
    { name: "San Francisco" },
  );
  assert.equal(result.origin, "FLY");
  assert.equal(result.trackName, "San Francisco");
  assert.equal(result.terrain.gridSize, 128);
  assert.deepEqual(result.flyTiles.map((t) => t.folder), ["D168157", "D169157", "D168156", "D169156"]);

  const [northWest, , , southEast] = result.flyTiles;
  // North-west tile at the origin; x east, z south, 64 units a cell.
  assert.deepEqual([northWest.positions[0], northWest.positions[2]], [0, 0]);
  const last = southEast.positions.length - 3;
  assert.deepEqual([southEast.positions[last], southEast.positions[last + 2]], [128 * 64, 128 * 64]);
  assert.equal(southEast.image.width, 2048);

  // Mount Diablo, D169157 cell (19.5, 1.9) from its south-west corner: high ground, and a
  // real photograph there rather than a flat generic colour.
  const diablo = result.flyTiles[1];
  const row = 64 - 2, col = 20;
  const height = diablo.positions[(row * 65 + col) * 3 + 1] / result.fly.unitsPerFoot;
  assert.ok(height > 2000 && height < 4000, `Mount Diablo at ${height} ft`);
  // Every normal points up.
  for (const tile of result.flyTiles) {
    for (let i = 1; i < tile.normals.length; i += 3) assert.ok(tile.normals[i] > 0);
  }
  // The open Pacific at the far west of the south-west tile is water-coloured and flat.
  const southWest = result.flyTiles[2];
  assert.equal(southWest.positions[(40 * 65 + 2) * 3 + 1], 0);
  const px = (40 * 32 * 2048 + 2 * 32) * 4;
  const [r, g, b] = southWest.image.rgba.slice(px, px + 3);
  assert.ok(b > r && g > r, `ocean pixel ${r},${g},${b}`);
});

test("Fly! one numbered EPD on its own is one globe tile", { skip: skipSf }, async () => {
  const result = await loadFlyScenery([archive("SANFRAN2.EPD")]);
  assert.equal(result.terrain.gridSize, 64);
  assert.deepEqual(result.fly.tiles, ["D169156"]);
  assert.equal(result.trackName, "D169156");
});

test("Fly! archives without terrain are refused", { skip: skipSf }, async () => {
  await assert.rejects(loadFlyScenery([archive("SFMODELS.EPD")]), /No Fly! terrain/);
});

/*
  Buildings and landmarks, San Francisco: the Golden Gate Bridge (a .BSP) and the Transamerica
  Pyramid (a .BIN) stand where they are, at their real size, and the camera opens downtown.
*/
test("Fly! San Francisco places its buildings and bridges to scale", { skip: skipSf }, async () => {
  const result = await loadFlyScenery(
    ["SANFRAN1.EPD", "SANFRAN2.EPD", "SANFRAN3.EPD", "SANFRAN4.EPD", "SFMODELS.EPD"].map(archive));
  const feet = (units) => units / result.fly.unitsPerFoot;
  const byName = (name) => result.flyObjects.find((o) => o.name === name);

  const bridge = byName("Golden Gate Bridge");
  assert.equal(bridge.modelName, "GOLD1.BSP"); // the near model of the two it lists
  // Its base on the water, heading about 175 degrees, a little west of north-south like the bridge.
  assert.ok(Math.abs(feet(bridge.position[1])) < 5, `bridge base at ${feet(bridge.position[1])} ft`);
  assert.ok(Math.abs(bridge.heading * 180 / Math.PI - 175.3) < 0.5);
  const gold = result.models["GOLD1.BSP"];
  assert.ok(gold.meshes.length > 0);
  assert.ok(Math.abs((gold.rawVertexBounds.maxZ - gold.rawVertexBounds.minZ) / 128 - 750) < 10);

  const pyramid = byName("Transamerica Building");
  const model = result.models[pyramid.modelName];
  assert.ok(Math.abs((model.rawVertexBounds.maxZ - model.rawVertexBounds.minZ) / 128 - 853) < 5);
  // Its base 133 ft up, on the terrain under it: altitude 559.6 less half its height.
  assert.ok(Math.abs(feet(pyramid.position[1]) - 133.3) < 1, `pyramid base at ${feet(pyramid.position[1])} ft`);

  // Scene x east and z south: the bridge is west and north of the pyramid.
  assert.ok(bridge.position[0] < pyramid.position[0] && bridge.position[2] < pyramid.position[2]);
  // The camera opens a few cells south of downtown, looking north.
  const view = result.startView;
  assert.ok(Math.hypot(view.x - pyramid.position[0], view.z - pyramid.position[2]) < 4 * 64);
  assert.equal(view.yaw, 0);
  assert.ok(result.modelTextures.some((t) => t.name === "SANFRAN1.RAW" && t.width === 256));
});

/*
  Full-resolution chunks: 8 x 8 cells at 128 px, each cell its own texture pixel for pixel,
  and at SFO the airport's 2 x 2 detail textures over the cell they refine.
*/
test("Fly! detail chunks draw every texture at its own resolution", { skip: skipSf }, async () => {
  await loadFlyScenery(["SANFRAN1.EPD", "SANFRAN2.EPD", "SANFRAN3.EPD", "SANFRAN4.EPD"].map(archive));
  const bytes = new Uint8Array(readFileSync(`${SF}/SANFRAN1.EPD`));
  const pod = parsePod(bytes);
  const texel = (path, x, y) => {
    const indices = readPodEntry(bytes, findPodEntry(pod, `${path}.RAW`));
    const palette = decodeActPalette(readPodEntry(bytes, findPodEntry(pod, `${path}.ACT`)));
    const c = indices[y * 128 + x] * 3;
    return [palette[c], palette[c + 1], palette[c + 2]];
  };
  // Chunk (7, 1) of D168156 holds cells x 56..63 and y 55..48 from the top, SFO among them.
  const chunk = await renderFlyDetail("D168156", 7, 1);
  assert.equal(chunk.width, 1024);
  const pixel = (x, y) => [...chunk.rgba.slice((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 3)];

  // A texture's name is its folder and row * 64 + column in decimal, written in hex.
  const name = (digits) => Number(digits).toString(16).toUpperCase().padStart(8, "0");
  // Cell (56, 55), a plain one, sits at the chunk's top left.
  assert.deepEqual(pixel(10, 20), texel(`DATA/D168156/${name(1681560000 + 55 * 64 + 56)}`, 10, 20));
  // Cell (61, 50) is refined by detail folder D061050: its north-west quarter is sub-texture
  // 0064 (x 0, y 1), 24637DE0, drawn at half size, so chunk pixel (5*128 + 3, 5*128 + 3)
  // averages its texels (6..7, 6..7).
  const left = (61 - 56) * 128, top = (55 - 50) * 128;
  const sub = [0, 1, 2].map((k) => Math.floor(
    [[6, 6], [7, 6], [6, 7], [7, 7]].reduce((sum, [x, y]) => sum + texel(`DATA/D168156/D061050/${name(610500064)}`, x, y)[k], 0) / 4));
  const got = pixel(left + 3, top + 3);
  assert.ok(got.every((v, k) => Math.abs(v - sub[k]) <= 1), `${got} vs ${sub}`);
  await assert.rejects(renderFlyDetail("D000000", 0, 0), /No Fly! tile/);
});
