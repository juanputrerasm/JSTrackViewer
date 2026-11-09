/*
  Community Patch 4 world layers (src/worker/cp4-world.js): lakes from a .WTR tile map, fog volumes
  from type 14 boxes, vegetation instance batches from a .VEG, and .SRF material matching. The
  last test reads Fila's sandbox (~/games/cp4sandbox/fog_test.pod) and skips without it.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLakeSheets, collectFogVolumes, vegetationInstances, srfMaterialType, modelSurface, loadCp4World,
  tileBedSampler, FOG_VOLUME_CAP, VEG_CHUNK_TILES,
} from "../src/worker/cp4-world.js";
import { parseWtr, writeWtr, parseSitFog, parseSrf, parseMtm2Veg, writeMtm2Veg } from "../src/vendor/openphotex/index.js";
import { parseSitTrack } from "../src/worker/sit-parser.js";
import { hasStockPod, indexStockPod } from "./helpers/stock-pod.mjs";

const SANDBOX = `${process.env.HOME}/games/cp4sandbox/fog_test.pod`;
const LAYOUT = { gridSize: 256, cellSize: 64, heightScale: 3 };

function lake(height, tileCount) {
  return { flags: 1, height, seeds: [{ x: 0, z: 0 }], box: { minX: 0, minZ: 0, maxX: 0, maxZ: 0 }, tileCount };
}

test("a lake's tiles become one flat quad each, at its height in steps x heightScale", () => {
  const map = new Uint8Array(65536);
  map[3 + 4 * 256] = 1;
  map[4 + 4 * 256] = 1;
  const wtr = parseWtr(writeWtr([lake(517, 2)], map));
  const { lakes, tileMap, levelFt, warnings } = buildLakeSheets(wtr, LAYOUT);
  assert.deepEqual(warnings, []);
  assert.equal(lakes.length, 1);
  const sheet = lakes[0];
  assert.equal(sheet.heightFt, 258.5);
  assert.equal(sheet.y, (258.5 / 2) * 3, "0.5 ft units to 2 ft steps, times the scene's height scale");
  assert.equal(sheet.positions.length, 2 * 12);
  assert.equal(sheet.indices.length, 2 * 6);
  // Tile (3, 4): x 192..256, row 4 laid at (256 - 4) * 64 down to (256 - 5) * 64, as terrain-builder.js lays cells.
  assert.deepEqual([...sheet.positions.subarray(0, 12)],
    [192, sheet.y, 16128, 256, sheet.y, 16128, 256, sheet.y, 16064, 192, sheet.y, 16064]);
  // Facing up: the first triangle's normal (b - a) x (c - a) has a positive y.
  const p = sheet.positions;
  const [ax, , az] = [p[0], p[1], p[2]], [bx, , bz] = [p[3], p[4], p[5]], [cx, , cz] = [p[6], p[7], p[8]];
  assert.ok((bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0);
  assert.equal(tileMap[3 + 4 * 256], 1);
  assert.equal(levelFt[1], 258.5);
});

test("lakes the engine refuses are skipped with its reason", () => {
  const map = new Uint8Array(65536);
  map[10] = 1; map[11] = 2; map[12] = 4;
  const wtr = parseWtr(writeWtr([lake(0, 1), lake(100, 1), lake(200, 0), lake(300, 1)], map));
  const bed = (tx) => (tx === 12 ? 40 : 100);
  const { lakes, tileMap, warnings } = buildLakeSheets(wtr, { ...LAYOUT, trackWaterFt: 50, bedFt: bed });
  assert.deepEqual(lakes.map((l) => l.id), []);
  assert.deepEqual(warnings, [
    "lake 1 skipped (HEIGHT_RANGE)",
    "lake 2 skipped (BELOW_BODY0)",
    "lake 3 skipped (NO_TILES)",
    "lake 4 skipped (TOUCHES_BODY0)",
  ]);
  assert.equal(tileMap[10] + tileMap[11] + tileMap[12], 0, "a skipped lake's tiles stay dry");
});

test("a tile's bed is the lowest of its 5 x 5 fine samples", () => {
  const heights = new Uint16Array(1024 * 1024).fill(100 * 256);
  heights[(4 * 2 + 3) + (4 * 1 + 4) * 1024] = 20 * 256;
  const bed = tileBedSampler({ rawData: new Uint8Array(131072), gridSize: 256, fine: { heights, subdivisions: 4, divisor: 256 } });
  assert.equal(bed(2, 1), 40, "20 steps = 40 ft, on the tile's far edge");
  assert.equal(bed(2, 0), 200);
});

function fogBox(fogLine, extra = {}) {
  return {
    type: 14, position: [8179, 8495, 109], positionFt: [4089.5, 218, 4247.5], sizeFt: [160, 100, 40],
    psi: 4.712389, theta: 0, phi: 0, fog: parseSitFog(fogLine), ...extra,
  };
}

test("a fog volume sits base above its box, w x l x h on the box's axes", () => {
  const { volumes } = collectFogVolumes([
    { type: 8, position: [0, 0, 0] },
    fogBox("100,160,40,6,200,0.75,0.78,0.82,16,20,5,1,511,0.49,0.8,10,10,0"),
  ], LAYOUT);
  assert.equal(volumes.length, 1);
  const v = volumes[0];
  assert.equal(v.boxIndex, 1);
  assert.deepEqual([v.w, v.l, v.h, v.bottomFt], [100, 160, 40, 224]);
  // Centre: bottom 224 ft + h / 2 = 244 ft = 122 steps x 3; z flipped as the terrain is.
  assert.deepEqual(v.centre, [8179, 366, 256 * 64 - 8495]);
  assert.deepEqual(v.size, [200, 80, 320]);
  assert.equal(v.psi, 4.712389);
  assert.equal(v.fog.vis, 200);
  assert.equal(v.drawn, true);
});

test("a zero fog side falls back to the box's; a side of 0.5 ft or less is not drawn", () => {
  const { volumes } = collectFogVolumes([
    fogBox("0,0,0"),
    fogBox("10,10,0.5"),
  ], LAYOUT);
  assert.deepEqual([volumes[0].w, volumes[0].l, volumes[0].h], [100, 160, 40], "width, length, height of the box");
  assert.equal(volumes[1].drawn, false);
});

test("only the first 64 fog volumes are kept", () => {
  const boxes = Array.from({ length: FOG_VOLUME_CAP + 3 }, () => fogBox("10,10,10"));
  const { volumes, warnings } = collectFogVolumes(boxes, LAYOUT);
  assert.equal(volumes.length, FOG_VOLUME_CAP);
  assert.equal(warnings.length, 1);
});

function sampleVeg() {
  const trees = {
    count: 3,
    position: Int32Array.from([1000 * 256, 300 * 256, 2000 * 256, 1010 * 256, 310 * 256, 2010 * 256, 5000 * 256, 0, 10 * 256]),
    species: Uint16Array.from([0, 0, 1]),
    heading: Uint16Array.from([16384, 0, 32768]),
    scale: Uint16Array.from([4096, 8192, 4096]),
    tint: new Uint8Array(3), tier: new Uint8Array(3),
  };
  const clumps = {
    count: 2, tiles: [{ tx: 5, tz: 7, first: 0, count: 2 }],
    species: Uint16Array.from([2, 2]), offset: Uint8Array.from([16, 32, 0, 0]), y: Int32Array.from([40 * 256, 41 * 256]),
    heading: Uint8Array.from([64, 0]), scale: Uint8Array.from([48, 0]), tint: new Uint8Array(2),
  };
  return {
    species: [
      { model: "PINE.BIN", farModel: "PINECARD.BIN", kind: 0, collide: 1, flags: 5 },
      { model: "OAK.BIN", farModel: "OAKCARD.BIN", kind: 0, collide: 0, flags: 8 },
      { model: "GRASS.BIN", farModel: "", kind: 1, collide: 0, flags: 0 },
    ],
    trees, clumps,
  };
}

test("vegetation instances: scene position, heading in radians and scale, batched by area", () => {
  const out = vegetationInstances(sampleVeg(), LAYOUT);
  assert.equal(out.treeCount, 3);
  assert.equal(out.clumpCount, 2);
  const pine = out.batches.find((b) => b.modelName === "PINE.BIN");
  assert.equal(pine.count, 2, "two pines in one 256 ft square");
  assert.equal(pine.farModelName, "PINECARD.BIN");
  // x 1000 ft = 2000 units; origin 300 ft = 150 steps x 3; z 2000 ft = 16384 - 4000.
  assert.deepEqual([...pine.positions.subarray(0, 3)], [2000, 450, 16384 - 4000]);
  assert.ok(Math.abs(pine.yaw[0] - Math.PI / 2) < 1e-6, "a quarter turn");
  assert.deepEqual([...pine.scale], [1, 2]);
  const chunkUnits = VEG_CHUNK_TILES * 32 * 2;
  assert.deepEqual(pine.centre, [3.5 * chunkUnits, 16384 - 7.5 * chunkUnits]);
  const oak = out.batches.find((b) => b.modelName === "OAK.BIN");
  assert.equal(oak.farModelName, null, "flag 0x08: no far card");
  const grass = out.batches.find((b) => b.kind === "grass");
  assert.equal(grass.count, 2);
  // Tile (5, 7) at 160, 224 ft; offsets in 1/8 ft; scale 0.25 + 48 / 64; heading 64 / 256 of a turn.
  assert.deepEqual([...grass.positions.subarray(0, 3)], [(160 + 2) * 2, 60, 16384 - (224 + 4) * 2]);
  assert.equal(grass.scale[0], 1);
  assert.ok(Math.abs(grass.yaw[0] - Math.PI / 2) < 1e-6);
});

test("a species whose model did not load is dropped", () => {
  const out = vegetationInstances(sampleVeg(), LAYOUT, (name) => name !== "OAK.BIN" && name !== "PINECARD.BIN");
  assert.equal(out.batches.some((b) => b.modelName === "OAK.BIN"), false);
  assert.equal(out.batches.find((b) => b.modelName === "PINE.BIN").farModelName, null);
});

test("a written .VEG reads back into the same batches", () => {
  const veg = sampleVeg();
  const bytes = writeMtm2Veg({ ...veg, species: veg.species.map((s) => ({ ...s, trunkDiameter: 0, trunkHeight: 0 })), rule: null, info: null });
  const out = vegetationInstances(parseMtm2Veg(bytes), LAYOUT);
  assert.equal(out.treeCount, 3);
  assert.equal(out.clumpCount, 2);
});

test(".SRF materials match exact, then by stem, then by 15 characters, then the default", () => {
  const srf = parseSrf("ROAD.RAW=cement\r\ndirtpatch=sand\r\nLONGTEXTURENAME_A.RAW=wood\r\n*=grass\r\n");
  assert.equal(srfMaterialType(srf, "road.raw"), "cement");
  assert.equal(srfMaterialType(srf, "DIRTPATCH.RAW"), "sand");
  assert.equal(srfMaterialType(srf, "LONGTEXTURENAME_B.RAW"), "wood");
  assert.equal(srfMaterialType(srf, "OTHER.RAW"), "grass");
  const bare = parseSrf("ROAD.RAW=cement\n");
  assert.equal(srfMaterialType(bare, "OTHER.RAW"), null, "no default: not a surface");
  const surface = modelSurface(srf, { meshes: [{ textureName: "ROAD.RAW" }, { textureName: "ROAD.RAW" }, { textureName: "X.RAW" }] });
  assert.deepEqual(surface.materials, [{ texture: "ROAD.RAW", type: "cement" }, { texture: "X.RAW", type: "grass" }]);
});

test("the CP4 sandbox loads its lakes, fog volumes and vegetation", { skip: !hasStockPod(SANDBOX) }, () => {
  const pod = indexStockPod(SANDBOX);
  const sit = pod.podIndex.entries.find((e) => /FOGTEST\.SI2$/i.test(e.name));
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit, "");
  const loaded = [];
  const world = loadCp4World(pod.podIndex, pod.getBytes, doc, "FOGTEST",
    (name) => { loaded.push(name); return { name, meshes: [{ textureName: "X" }] }; }, { cellSize: 64, heightScale: 3 });
  assert.deepEqual(world.lakes.map((l) => [l.id, l.heightFt, l.tileCount]), [[1, 258.5, 37], [2, 323, 23]]);
  assert.equal(world.fogVolumes.length, 2);
  assert.deepEqual(world.fogVolumes.map((v) => [v.w, v.l, v.h]), [[100, 100, 40], [100, 160, 40]]);
  assert.equal(world.vegetation.treeCount, 12394);
  assert.equal(world.vegetation.clumpCount, 131072);
  assert.ok(loaded.includes("AK8PINEA.BIN") && loaded.includes("V208715A8.BIN"));
});
