/*
  Community Patch 4 world layers (src/worker/cp4-world.js): lakes from a .WTR tile map, fog volumes
  from type 14 boxes, vegetation instance batches from a .VEG, .SRF material matching and beta
  0.53's waterfalls from a .WFL. The sandbox tests read Fila's sandboxes (~/games/cp4sandbox/fog_test.pod
  for 0.52; CP4_SANDBOX_053, default ~/games/cp4sandbox053/fog_test.pod, for 0.53) and skip without them.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLakeSheets, collectFogVolumes, vegetationInstances, srfMaterialType, modelSurface, loadCp4World,
  tileBedSampler, fallHeightsOf, FOG_VOLUME_CAP, VEG_CHUNK_TILES,
} from "../src/worker/cp4-world.js";
import {
  parseWtr, writeWtr, parseSitFog, parseSrf, parseMtm2Veg, writeMtm2Veg, writeWfl, writePod1, parsePod, readPodEntry,
  FALL_VERTEX_FLOATS,
} from "../src/vendor/openphotex/index.js";
import { parseSitTrack } from "../src/worker/sit-parser.js";
import { hasStockPod, indexStockPod } from "./helpers/stock-pod.mjs";

const SANDBOX = `${process.env.HOME}/games/cp4sandbox/fog_test.pod`;
const SANDBOX_053 = process.env.CP4_SANDBOX_053 ?? `${process.env.HOME}/games/cp4sandbox053/fog_test.pod`;
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
  const wtr = parseWtr(writeWtr([lake(1, 1), lake(100, 1), lake(200, 0), lake(300, 1)], map));
  // A height of 0 cannot be written to a version 1 file any more (OpenPhotex writeWtr refuses it); the reader still checks it.
  wtr.lakes[0].height = 0;
  wtr.lakes[0].heightFt = 0;
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

/*
  A classic track (8-bit heights) with a 200 ft plateau on rows 100 and up and 20 ft ground below
  it, .LVL water at 60 ft, and lake 1 at 210 ft over the plateau's tiles x 95..106, z 100..105.
  Fall 1 pours from the lake over the plateau's edge (crest x 3200..3264 ft at z 3200 ft, flowing
  toward -z) into the track's water; fall 2 names the same lake at another height.
*/
function waterfallTrack(falls) {
  const raw = new Uint8Array(65536);
  for (let z = 0; z < 256; z++) raw.fill(z >= 100 ? 100 : 10, z * 256, z * 256 + 256);
  const map = new Uint8Array(65536);
  for (let z = 100; z <= 105; z++) for (let x = 95; x <= 106; x++) map[x + z * 256] = 1;
  const wtr = writeWtr([{ flags: 1, height: 420, seeds: [{ x: 100, z: 102 }], box: { minX: 95, minZ: 100, maxX: 106, maxZ: 105 }, tileCount: 72 }], map);
  const podBytes = writePod1("", [
    { name: "WORLD\\TEST.WTR", data: wtr },
    { name: "WORLD\\TEST.WFL", data: writeWfl(falls) },
  ]);
  const podIndex = parsePod(podBytes);
  const doc = {
    terrain: { rawData: raw, gridSize: 256, rawBytesPerCell: 1 },
    waterHeightFt: 60, waterLevel: 15, models: {}, boxes: [], warnings: [],
  };
  return { podIndex, getBytes: (e) => readPodEntry(podBytes, e), doc };
}

const crest = [{ x: 3200 * 16, z: 3200 * 16 }, { x: 3264 * 16, z: 3200 * 16 }];
const fallRecord = (extra = {}) => ({
  source: 1, flags: 2, speed: 8 * 16, height: 420, points: crest, opacity: 80, mist: 100, volume: 100, ...extra,
});

test("a classic track's heights go to the waterfalls' walk as v << 8", () => {
  const raw = new Uint8Array(65536);
  raw[5] = 100;
  const h = fallHeightsOf({ rawData: raw, gridSize: 256 });
  assert.equal(h.mode, "classic8");
  assert.equal(h.coarse[5], 100 << 8);
  assert.equal(fallHeightsOf({ rawData: raw, gridSize: 128 }), null, "only a 256 x 256 grid");
});

test("a .WFL's falls are built over the terrain into the water, with their mist, in scene units", () => {
  const { podIndex, getBytes, doc } = waterfallTrack([fallRecord(), fallRecord({ height: 400 })]);
  const world = loadCp4World(podIndex, getBytes, doc, "TEST", () => null, { cellSize: 64, heightScale: 3 });
  assert.equal(world.lakes.length, 1);
  assert.deepEqual(doc.warnings, ["Waterfalls: fall 2 refused (FALL_HEIGHT)"]);
  const wf = world.waterfalls;
  assert.equal(wf.falls.length, 1);
  const fall = wf.falls[0];
  assert.equal(fall.id, 1);
  assert.equal(fall.source, 1);
  assert.equal(fall.splash, true);
  assert.equal(fall.opacity, 0.8);
  assert.equal(fall.crestSpeedFtPerSec, 8);
  assert.equal(fall.textureName, null, "no stem: the default ripple");
  assert.ok(fall.ends.water > 0, "the water columns reach the track's water");
  assert.equal(fall.landing.y, 60);
  assert.ok(fall.foamVertexCount > 0);
  assert.equal(wf.vertices.length / FALL_VERTEX_FLOATS, fall.vertexCount);
  assert.equal(wf.positions.length, fall.vertexCount * 3);
  assert.equal(wf.indices.length, fall.indexCount);
  for (const i of wf.indices) assert.ok(i < fall.vertexCount);
  // Vertex 0 is the crest's point 0 at the crest height: x 3200 ft x 2, 210 ft = 105 steps x 3, z flipped.
  assert.deepEqual([...wf.positions.subarray(0, 3)], [6400, 315, 16384 - 6400]);
  // Every vertex: the anchor plus its 1/256 ft offset.
  const v = wf.vertices, p = wf.positions, last = fall.vertexCount - 1;
  assert.ok(Math.abs(p[3 * last] - (3200 + v[last * 16] / 256) * 2) < 1e-3);
  assert.ok(Math.abs(p[3 * last + 1] - (210 + v[last * 16 + 1] / 256) * 1.5) < 1e-3);
  assert.ok(Math.abs(p[3 * last + 2] - (16384 - (3200 + v[last * 16 + 2] / 256) * 2)) < 1e-3);
  assert.ok(p[3 * last + 2] > 16384 - 6400, "flowing toward -z in the level is +z in the scene");
  // One mist box, its floor 2 ft below the landing, in the fog volumes' units.
  assert.equal(wf.mists.length, 1);
  const mist = wf.mists[0];
  assert.equal(mist.slot, 0);
  assert.equal(mist.floorFt, 58);
  assert.ok(Math.abs(mist.centre[1] - (58 + mist.heightFt / 2) * 1.5) < 1e-9);
  assert.deepEqual(mist.size, [mist.widthFt * 2, mist.heightFt * 1.5, mist.lengthFt * 2]);
  assert.equal(mist.fog.wmask, 0x1ff);
  assert.equal(fall.mist, true);
});

test("waterfalls without terrain, or with a broken .WFL, are a warning and nothing drawn", () => {
  const { podIndex, getBytes, doc } = waterfallTrack([fallRecord()]);
  doc.terrain = { rawData: null, gridSize: 256 };
  const world = loadCp4World(podIndex, getBytes, doc, "TEST", () => null, { cellSize: 64, heightScale: 3 });
  assert.equal(world.waterfalls, null);
  assert.ok(doc.warnings.includes("Waterfalls: the track has no 256 x 256 terrain to pour them over"));

  const broken = waterfallTrack([fallRecord()]);
  const entry = broken.podIndex.entries.find((e) => /\.WFL$/i.test(e.name));
  const bytes = broken.getBytes(entry).slice();
  // Version 2 with a 256 x 256 header: version 2 is a 512-cell world's only.
  bytes[4] = 2;
  const world2 = loadCp4World(broken.podIndex, (e) => (e === entry ? bytes : broken.getBytes(e)), broken.doc, "TEST", () => null, { cellSize: 64, heightScale: 3 });
  assert.equal(world2.waterfalls, null);
  assert.ok(broken.doc.warnings.includes("Waterfalls: WFL: authored for another terrain size"));
});

/*
  The world's size picks the .WTR and .WFL version (track format version 6, sections 9.1 and
  9.3): a 256-cell track, whether .SIT, .SI2 or a 256-cell .SI3, reads version 1 only, so the
  512 x 512 version 2 files are a warning each and nothing of them is drawn.
*/
for (const [label, v6] of [
  ["a classic track", null],
  ["a 256-cell .SI3 track", { worldCells: 256, worldFt: 8192, terrainHeightMap: null, heightStep: 128, heightBase: 0 }],
]) {
  test(`${label} refuses a version 2 .WTR and .WFL`, () => {
    const { doc } = waterfallTrack([fallRecord()]);
    doc.v6 = v6;
    const map = new Uint8Array(512 * 512);
    map[0] = 1;
    const podBytes = writePod1("", [
      { name: "WORLD\\TEST.WTR", data: writeWtr([{ flags: 1, height: 420, seeds: [{ x: 0, z: 0 }], box: { minX: 0, minZ: 0, maxX: 0, maxZ: 0 }, tileCount: 1 }], map) },
      { name: "WORLD\\TEST.WFL", data: writeWfl([fallRecord()], { cells: 512 }) },
    ]);
    const podIndex = parsePod(podBytes);
    const world = loadCp4World(podIndex, (e) => readPodEntry(podBytes, e), doc, "TEST", () => null, { cellSize: 64, heightScale: 3 });
    assert.deepEqual(world.lakes, []);
    assert.equal(world.waterfalls, null);
    assert.equal(doc.warnings.length, 2);
    assert.ok(doc.warnings[0].startsWith("Lakes: WTR:"), doc.warnings[0]);
    assert.equal(doc.warnings[1], "Waterfalls: WFL: authored for another terrain size");
  });
}

test("the CP4 0.53 sandbox builds its two waterfalls", { skip: !hasStockPod(SANDBOX_053) }, () => {
  const pod = indexStockPod(SANDBOX_053);
  const sit = pod.podIndex.entries.find((e) => /FOGTEST\.SI2$/i.test(e.name));
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit, "");
  const world = loadCp4World(pod.podIndex, pod.getBytes, doc, "FOGTEST",
    (name) => ({ name, meshes: [{ textureName: "X" }] }), { cellSize: 64, heightScale: 3 });
  assert.deepEqual(doc.warnings.filter((w) => w.startsWith("Waterfalls")), []);
  const wf = world.waterfalls;
  assert.deepEqual(wf.falls.map((f) => [f.id, f.vertexCount, f.mist]), [[1, 2195, true], [2, 3840, true]]);
  assert.equal(wf.positions.length / 3, 2195 + 3840);
  assert.deepEqual(wf.mists.map((m) => m.slot), [0, 1]); // hotfix 3: a dry fall has mist too
  assert.equal(wf.falls[0].crestLengthFt > 0, true);
  // Fall 1 pours from lake 2 into lake 1, whose sheet the viewer draws at 258.5 ft.
  assert.equal(wf.falls[0].landing.y, 258.5);
});
