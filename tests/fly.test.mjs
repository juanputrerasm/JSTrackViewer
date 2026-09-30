import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { flySetsFromFolder } from "../src/fly-folder.js";
import { loadFlyScenery } from "../src/worker/fly/fly-loader.js";

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
