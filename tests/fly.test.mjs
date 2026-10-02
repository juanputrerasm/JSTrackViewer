import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { flySetsFromFolder, looseArchives } from "../src/folder-contents.js";
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

test("Open from Folder: every POD, and any EPD no scenery set lists, in path order", async () => {
  const files = [
    pickedFile("games/SANFRAN/SANFRAN.SCF", scf("San Francisco", ["sanfran1.epd"])),
    pickedFile("games/SANFRAN/SANFRAN1.EPD"),
    pickedFile("games/mtm2/ALASKA.POD"),
    pickedFile("games/mtm2/aztec.pod"),
    pickedFile("games/Maps/SC24.EPD"),
    pickedFile("games/mtm2/readme.txt"),
  ];
  const { sets } = await flySetsFromFolder(files);
  assert.deepEqual(looseArchives(files, sets).map((f) => f.webkitRelativePath),
    ["games/Maps/SC24.EPD", "games/mtm2/ALASKA.POD", "games/mtm2/aztec.pod"]);
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
  // North-west tile at the origin; x east, z south, in the other games' units: 2 to the foot
  // across, so a cell (1.93 km where it is measured, row 157) is some 12,650 units.
  assert.deepEqual([northWest.positions[0], northWest.positions[2]], [0, 0]);
  const cell = result.terrain.cellSize;
  assert.ok(Math.abs(cell / 2 / 3.28084 - 1928) < 5, `cell ${cell / 2 / 3.28084} m`);
  const last = southEast.positions.length - 3;
  assert.ok(Math.abs(southEast.positions[last] - 128 * cell) < 1e-6 * 128 * cell);
  assert.ok(Math.abs(southEast.positions[last + 2] - 128 * cell) < 1e-6 * 128 * cell);
  assert.equal(southEast.image.width, 2048);

  // The grid has 4 points a cell side, for the finer .AL2 heights.
  assert.equal(southEast.subdivisions, 4);
  const side = 64 * 4 + 1;
  // Heights are 1.5 units to the foot, the other games' vertical scale.
  const feetAt = (tile, col, row) => tile.positions[(row * side + col) * 3 + 1] / result.fly.unitsPerFootV;
  // Mount Diablo (3,849 ft), D169157 cell (19.5, 1.9) from its south-west corner. Its cell is
  // refined, and the refined grid comes nearer the summit than the corner heights alone
  // (2,624 ft at best).
  const diablo = result.flyTiles[1];
  let height = 0;
  for (let row = (64 - 3) * 4; row <= (64 - 1) * 4; row++) {
    for (let col = 18 * 4; col <= 21 * 4; col++) height = Math.max(height, feetAt(diablo, col, row));
  }
  assert.ok(height > 2700 && height < 3900, `Mount Diablo at ${height} ft`);
  // Every normal points up.
  for (const tile of result.flyTiles) {
    for (let i = 1; i < tile.normals.length; i += 3) assert.ok(tile.normals[i] > 0);
  }
  // The open Pacific at the far west of the south-west tile is water-coloured and flat.
  const southWest = result.flyTiles[2];
  assert.equal(feetAt(southWest, 2 * 4, 40 * 4), 0);
  const px = (40 * 32 * 2048 + 2 * 32) * 4;
  const [r, g, b] = southWest.image.rgba.slice(px, px + 3);
  assert.ok(b > r && g > r, `ocean pixel ${r},${g},${b}`);
  // City lights: SFNIGHT.EPD is not loaded here, so no tile has any.
  assert.ok(result.flyTiles.every((t) => t.night === null));
});

test("Fly! night lights come from the set's *NIGHT.EPD", { skip: skipSf }, async () => {
  const result = await loadFlyScenery(
    ["SANFRAN1.EPD", "SANFRAN2.EPD", "SANFRAN3.EPD", "SANFRAN4.EPD", "SFNIGHT.EPD"].map(archive));
  // Downtown San Francisco and the peninsula (D168156) and the East Bay (D169156) are lit.
  assert.deepEqual(result.flyTiles.filter((t) => t.night).map((t) => t.folder), ["D168156", "D169156"]);
  // 643AA07CN.RAW lights cell (60, 58) of D168156; the rest of the tile stays black.
  const night = result.flyTiles.find((t) => t.folder === "D168156").night;
  const brightest = (left, top) => {
    let max = 0;
    for (let y = top; y < top + 32; y++) for (let x = left; x < left + 32; x++) max = Math.max(max, night.rgba[(y * 2048 + x) * 4]);
    return max;
  };
  assert.ok(brightest(60 * 32, (63 - 58) * 32) > 30);
  assert.equal(brightest(0, 0), 0);
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
  const { createWorldFrame } = await import("../src/drive/world-frame.js");
  const frame = createWorldFrame(result);
  const feet = (units) => units / result.fly.unitsPerFootV;
  const byName = (name) => result.flyObjects.find((o) => o.name === name);
  const groundError = (object) => Math.abs(feet(object.position[1])
    - frame.heightAtFeet(object.position[0] / result.fly.unitsPerFoot, object.position[2] / result.fly.unitsPerFoot));
  for (const object of result.flyObjects) {
    assert.equal(object.snapToGround, true, `${object.name} is not flagged to snap`);
    assert.ok(groundError(object) < 0.01, `${object.name} base ${groundError(object)} ft from ground`);
  }

  const bridge = byName("Golden Gate Bridge");
  assert.equal(bridge.modelName, "GOLD1.BSP"); // the near model of the two it lists
  // Its base on the water, heading about 175 degrees, a little west of north-south like the bridge.
  assert.equal(bridge.snapToGround, true);
  assert.ok(groundError(bridge) < 0.01, `bridge base ${groundError(bridge)} ft from ground`);
  assert.ok(Math.abs(bridge.heading * 180 / Math.PI - 175.3) < 0.5);
  const gold = result.models["GOLD1.BSP"];
  assert.ok(gold.meshes.length > 0);
  assert.ok(Math.abs((gold.rawVertexBounds.maxZ - gold.rawVertexBounds.minZ) / 128 - 750) < 10);

  const pyramid = byName("Transamerica Building");
  const model = result.models[pyramid.modelName];
  assert.ok(Math.abs((model.rawVertexBounds.maxZ - model.rawVertexBounds.minZ) / 128 - 853) < 5);
  // Flag bit 0 puts its base on the refined terrain rather than trusting the stored altitude.
  assert.equal(pyramid.snapToGround, true);
  assert.ok(groundError(pyramid) < 0.01, `pyramid base ${groundError(pyramid)} ft from ground`);

  // Scene x east and z south: the bridge is west and north of the pyramid.
  assert.ok(bridge.position[0] < pyramid.position[0] && bridge.position[2] < pyramid.position[2]);
  // The camera opens a few cells south of downtown, looking north.
  const view = result.startView;
  assert.ok(Math.hypot(view.x - pyramid.position[0], view.z - pyramid.position[2]) < 4 * result.terrain.cellSize);
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

/*
  Test Drive on Fly!: the world frame reads the ground from the stitched heights, in the
  triangles the meshes are cut into, and the buildings are solid.
*/
test("Fly! ground and buildings for Test Drive", { skip: skipSf }, async () => {
  const { createWorldFrame } = await import("../src/drive/world-frame.js");
  const { createColliders } = await import("../src/drive/colliders.js");
  const result = await loadFlyScenery(
    ["SANFRAN1.EPD", "SANFRAN2.EPD", "SANFRAN3.EPD", "SANFRAN4.EPD", "SFMODELS.EPD"].map(archive));
  const frame = createWorldFrame(result);
  assert.equal(frame.hasTerrain, true);
  // Every mesh vertex is on the ground the frame reports, in feet (2 units to the foot across),
  // to within what a float32 position a million units out resolves (0.125 units) on a slope.
  for (const tile of result.flyTiles) {
    for (let i = 0; i < tile.positions.length; i += 3 * 97) {
      const [x, y, z] = [tile.positions[i], tile.positions[i + 1], tile.positions[i + 2]];
      assert.ok(Math.abs(frame.heightAtFeet(x / 2, z / 2) - y / 1.5) < 0.5, `${tile.folder} vertex ${i / 3}`);
    }
  }
  // Mid-triangle too: the centre of a square lies on its north-east to south-west diagonal.
  const t = result.flyTiles[1];
  const side = 257;
  const v = (col, row) => [t.positions[(row * side + col) * 3], t.positions[(row * side + col) * 3 + 1], t.positions[(row * side + col) * 3 + 2]];
  const [bx, by, bz] = v(81, 245), [cx, cy, cz] = v(80, 246);
  assert.ok(Math.abs(frame.heightAtFeet((bx + cx) / 4, (bz + cz) / 4) - (by + cy) / 3) < 0.5);
  const up = frame.normalAtFeet(bx / 2, bz / 2);
  assert.ok(up.y > 0.5);

  // The Transamerica Pyramid is a solid, standing on its base.
  const colliders = createColliders(result, frame);
  const pyramid = result.flyObjects.find((o) => o.name === "Transamerica Building");
  const solid = colliders.solids.find((s) => s.modelName === pyramid.modelName);
  assert.ok(solid, "no collider for the pyramid");
  assert.ok(Math.abs(solid.centre.x - pyramid.position[0] / 2) < 1);
  assert.ok(colliders.solids.length >= result.flyObjects.length * 0.9);
});
