/*
  MTM2 track format version 6 (https://openmtm2.github.io/proposals/track-format-v6): .SI3 tracks,
  their world size, height step and base, 16-bit ground boxes, version 2 lakes and version 2
  waterfalls.

  The whole-track tests read ~/games/mtm2-v6-test/CRAZY4X.POD (a 512-cell, step 32 test track built
  with OpenPhotex) and skip themselves when it is absent; the rest are self-contained.
*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parsePod, readPodEntry, writePod1, writeWtr, writeWfl } from "../src/vendor/openphotex/index.js";
import { findSitEntries } from "../src/worker/pod-format.js";
import { listTrackChoices } from "../src/worker/track-loader.js";
import { parseSitTrack } from "../src/worker/sit-parser.js";
import { buildLakeSheets, loadCp4World, fallHeightsOf } from "../src/worker/cp4-world.js";
import { levelStemOf, sitLevelStem, levelFileStems } from "../src/worker/level-stem.js";
import { heightAtCell } from "../src/shared/terrain-height.js";
import { createFineSampler } from "../src/shared/fine-terrain.js";
import { simGroundBoxes } from "../src/drive/openmtm2-sim.js";
import { createWorldFrame } from "../src/drive/world-frame.js";

const V6_POD = `${process.env.HOME}/games/mtm2-v6-test/CRAZY4X.POD`;
const skipV6 = existsSync(V6_POD) ? false : `no version 6 test track at ${V6_POD}`;

function openPod(bytes) {
  const podIndex = parsePod(bytes);
  return { podIndex, getBytes: (e) => readPodEntry(bytes, e) };
}

/** CRAZY4X.POD with some entries replaced, added (name -> bytes) or removed (name -> null). */
function rebuiltPod(changes) {
  const bytes = new Uint8Array(readFileSync(V6_POD));
  const { podIndex, getBytes } = openPod(bytes);
  const entries = [];
  const seen = new Set();
  for (const e of podIndex.entries) {
    const key = e.name.toUpperCase();
    seen.add(key);
    if (key in changes) {
      if (changes[key] !== null) entries.push({ name: e.name, data: changes[key] });
    } else entries.push({ name: e.name, data: getBytes(e) });
  }
  for (const [name, data] of Object.entries(changes)) if (!seen.has(name) && data) entries.push({ name, data });
  return openPod(writePod1("v6 test", entries));
}

const text = (s) => new TextEncoder().encode(s);
const entryOf = (pod, title) => pod.podIndex.entries.find((e) => e.title === title);

test("a .SI3 is listed as a track of its own beside a .SIT of the same stem", () => {
  const entries = [
    { title: "CRAZY.SIT", name: "WORLD\\CRAZY.SIT" },
    { title: "CRAZY.SI3", name: "WORLD\\CRAZY.SI3" },
    { title: "OTHER.SI3", name: "WORLD\\OTHER.SI3" },
    { title: "CRAZY.LVL", name: "LEVELS\\CRAZY.LVL" },
  ];
  const podIndex = { entries };
  assert.deepEqual(findSitEntries(podIndex).map((e) => e.title), ["CRAZY.SIT", "CRAZY.SI3", "OTHER.SI3"]);
  const choices = listTrackChoices(podIndex);
  assert.deepEqual(choices.map((c) => [c.index, c.name]), [[0, "CRAZY"], [1, "CRAZY (.SI3)"], [2, "OTHER"]]);
});

test("heightAtCell and the fine sampler add a version 6 terrain's offset, and nothing without one", () => {
  const raw = new Uint8Array([0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04]); // 256, 512, 768, 1024
  const plain = { gridSize: 2, rawBytesPerCell: 2, heightDivisor: 64 };
  assert.equal(heightAtCell(plain, raw, 1, 0), 8);
  assert.equal(heightAtCell({ ...plain, heightOffset: -10 }, raw, 1, 0), -2);
  const fine = { heights: new Uint16Array(64).fill(640), subdivisions: 4, divisor: 64 };
  assert.equal(createFineSampler(fine, 2).at(3, 3), 10);
  assert.equal(createFineSampler({ ...fine, offset: 44 }, 2).at(3, 3), 54);
});

test("lakes are laid out on a 512-tile map and checked against a version 2 height range", () => {
  const side = 512;
  const tileMap = new Uint8Array(side * side);
  tileMap[300 * side + 400] = 1;
  tileMap[300 * side + 401] = 1;
  tileMap[10] = 2;
  const wtr = {
    tileMap,
    lakes: [
      { id: 1, height: 5000, heightFt: 2500, reflective: false, tileCount: 2 },
      { id: 2, height: 9000, heightFt: 4500, reflective: false, tileCount: 1 },
    ],
  };
  const out = buildLakeSheets(wtr, { gridSize: side, cellSize: 64, heightScale: 3, heightRange: [177, 8000] });
  assert.deepEqual(out.lakes.map((l) => l.id), [1]);
  assert.deepEqual(out.warnings, ["lake 2 skipped (HEIGHT_RANGE)"]);
  assert.equal(out.tileMap[300 * side + 401], 1);
  // Tile (400, 300) lies at x 400 cells, z (512 - 300) cells.
  assert.deepEqual([...out.lakes[0].positions.subarray(0, 3)], [400 * 64, (2500 / 2) * 3, (side - 300) * 64]);
  // A 512 map on a 256 grid is not drawn.
  assert.equal(buildLakeSheets(wtr, { gridSize: 256 }).lakes.length, 0);
});

test("16-bit version 6 ground boxes reach the simulation in feet on their own grid", () => {
  const trackData = {
    terrain: { gridSize: 512, cellSize: 64, heightScale: 3 },
    groundBoxes: [{ x: 300, y: 400, lower: -5, upper: 700.25, v6: true }],
  };
  const sim = simGroundBoxes(trackData);
  assert.equal(sim.cells, 512);
  assert.equal(sim.stepFt, 1);
  assert.equal(sim.ra0[400 * 512 + 300], -10);
  assert.equal(sim.ra1[400 * 512 + 300], 1400.5);
});

test("a 512-cell world's lakes are found by drive mode", () => {
  const side = 512;
  const tileMap = new Uint8Array(side * side);
  tileMap[(side - 1) * side + 500] = 3;
  const frame = createWorldFrame({ terrain: { gridSize: side, cellSize: 64 }, lakes: { tileMap: tileMap.buffer, levelFt: Object.assign(new Array(256).fill(0), { 3: 900 }) } });
  // Row 511 is drawn at z (512 - 511) cells, so its middle is z 16 ft; column 500 is x 16,016 ft.
  assert.equal(frame.lakeLevelAtFeet(500 * 32 + 16, 16), 900);
  assert.equal(frame.lakeLevelAtFeet(16, 16), null);
});

/*
  A 512-cell, step 32, base 88 Spline world (as sit-parser.js leaves a terrainHeightMap track): a
  shelf at 1,500 ft from z 12,000 ft on, 1,300 ft below it, and lake 1 at 1,350 ft over tiles
  x 460..479, z 300..374. The fall's crest runs x 15,000..15,040 ft at z 12,000 ft at the shelf's
  height and pours toward -z into the lake: beyond 8,192 ft and above 2,048 ft, so .WFL version 2.
*/
function v6WaterfallTrack(falls, { wflCells = 512 } = {}) {
  const N = 512, F = 4 * N, step = 32, base = 88;
  const sample = (ft) => (ft - base) * step;
  const raw = new Uint8Array(N * N * 2);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const v = sample(z * 32 >= 12000 ? 1500 : 1300);
    raw[2 * (z * N + x)] = v & 0xff;
    raw[2 * (z * N + x) + 1] = v >> 8;
  }
  const fine = new Uint16Array(F * F);
  for (let z = 0; z < F; z++) fine.fill(sample(z * 8 >= 12000 ? 1500 : 1300), z * F, z * F + F);
  const map = new Uint8Array(N * N);
  for (let z = 300; z < 375; z++) for (let x = 460; x < 480; x++) map[z * N + x] = 1;
  const wtr = writeWtr([{ flags: 1, height: 2700, seeds: [{ x: 470, z: 320 }], box: { minX: 460, minZ: 300, maxX: 479, maxZ: 374 }, tileCount: 1500 }], map);
  const podBytes = writePod1("", [
    { name: "WORLD\\V6.WTR", data: wtr },
    { name: "WORLD\\V6.WFL", data: writeWfl(falls, { cells: wflCells }) },
  ]);
  const doc = {
    v6: { worldCells: N, worldFt: 32 * N, terrainHeightMap: "V6.RAW", heightStep: step, heightBase: base },
    terrain: {
      rawData: raw, gridSize: N, rawBytesPerCell: 2, heightDivisor: 2 * step, heightOffset: base / 2,
      cp4: { mode: "spline", fine }, fine: { heights: fine, subdivisions: 4, divisor: 2 * step, offset: base / 2 },
    },
    waterHeightFt: 0, waterLevel: 0, models: {}, boxes: [], warnings: [],
  };
  const podIndex = parsePod(podBytes);
  return { podIndex, getBytes: (e) => readPodEntry(podBytes, e), doc };
}
const v6Fall = (extra = {}) => ({
  source: 0, flags: 2, speed: 96, height: 3000, points: [{ x: 15000 * 16, z: 12000 * 16 }, { x: 15040 * 16, z: 12000 * 16 }],
  opacity: 100, mist: 100, volume: 100, ...extra,
});

test("a version 6 terrain goes to the waterfalls' walk as h128 on its N or 4N grid", () => {
  const { doc } = v6WaterfallTrack([v6Fall()]);
  const h = fallHeightsOf(doc.terrain, doc.v6);
  assert.equal(h.cells, 512);
  assert.equal(h.h128, true);
  assert.equal(h.mode, "spline");
  assert.equal(h.coarse.length, 512 * 512);
  assert.equal(h.fine.length, 2048 * 2048);
  assert.equal(h.coarse[0], 1300 * 128);
  assert.equal(h.fine[2047 * 2048], 1500 * 128);
  // A grid that is not N x N is no ground.
  assert.equal(fallHeightsOf({ ...doc.terrain, gridSize: 256 }, doc.v6), null);
  // A track without terrainHeightMap keeps CP4's 256 path.
  assert.equal(fallHeightsOf(doc.terrain, { ...doc.v6, terrainHeightMap: null }), null);
});

test("a 512-cell world builds its version 2 waterfalls in the N world, with mist in [0, W)", () => {
  const { podIndex, getBytes, doc } = v6WaterfallTrack([v6Fall(), v6Fall({ height: 4273, points: [{ x: 1000 * 16, z: 1000 * 16 }, { x: 1040 * 16, z: 1000 * 16 }] })]);
  const world = loadCp4World(podIndex, getBytes, doc, "V6", () => null, { cellSize: 64, heightScale: 3 });
  assert.deepEqual(world.lakes.map((l) => l.id), [1]);
  // 4,273 half-feet is above step 32, base 88's 2 * (88 + 2048).
  assert.deepEqual(doc.warnings, ["Waterfalls: record 2 (id 2) skipped (badHeight)"]);
  const wf = world.waterfalls;
  assert.equal(wf.falls.length, 1);
  const fall = wf.falls[0];
  assert.equal(fall.landing.y, 1350, "lands in lake 1, read from the 512 x 512 map");
  assert.ok(fall.ends.water > 0);
  // Vertex 0 is crest point 0 at 1,500 ft: x 15,000 ft x 2, 750 steps x 3, z flipped on the 512-cell scene.
  assert.deepEqual([...wf.positions.subarray(0, 3)], [30000, 2250, 512 * 64 - 24000]);
  assert.equal(wf.mists.length, 1);
  const mist = wf.mists[0];
  assert.equal(mist.floorFt, 1348);
  assert.ok(mist.centre[0] > 8192 * 2 && mist.centre[0] < 16384 * 2, "beyond a 256 world, inside this one");
});

test("a version 1 .WFL on a 512-cell world is refused as authored for another terrain size", () => {
  const { podIndex, getBytes, doc } = v6WaterfallTrack([v6Fall({ height: 400, points: [{ x: 100 * 16, z: 100 * 16 }, { x: 140 * 16, z: 100 * 16 }] })], { wflCells: 256 });
  const world = loadCp4World(podIndex, getBytes, doc, "V6", () => null, { cellSize: 64, heightScale: 3 });
  assert.equal(world.waterfalls, null);
  assert.ok(doc.warnings.includes("Waterfalls: WFL: authored for another terrain size"));
});

test("level files are looked up by the level's stem first, then the track's", () => {
  assert.equal(levelStemOf("LEVELS\\CHGO.LVL"), "CHGO");
  assert.equal(levelStemOf("chgo.lvl"), "CHGO");
  assert.equal(levelStemOf(""), "");
  assert.equal(sitLevelStem(text("CHGO.LVL\r\n!Race Track Name\r\n")), "CHGO");
  assert.deepEqual(levelFileStems("CHGO", "CHGOR01"), ["CHGO", "CHGOR01"]);
  // A track named after its level: one stem.
  assert.deepEqual(levelFileStems("CRAZY4X", "crazy4x"), ["CRAZY4X"]);
  assert.deepEqual(levelFileStems("", "CHGOR01"), ["CHGOR01"]);
});

test("CRAZY4X: a second track on the same level reads the level's .TXV and lakes", { skip: skipV6 }, () => {
  const original = openPod(new Uint8Array(readFileSync(V6_POD)));
  // Its first line names CRAZY4X.LVL; it has no DATA\SECOND.TXV or WORLD\SECOND.WTR of its own.
  const si3 = original.getBytes(entryOf(original, "CRAZY4X.SI3"));
  const pod = rebuiltPod({ "WORLD\\SECOND.SI3": si3 });
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, entryOf(pod, "SECOND.SI3"), "");
  assert.equal(doc.levelStem, "CRAZY4X");
  assert.equal(doc.v6.worldCells, 512);
  const world = loadCp4World(pod.podIndex, pod.getBytes, doc, "SECOND", () => null, { cellSize: 64, heightScale: 3 });
  assert.ok(world.lakes.length >= 1);
  assert.equal(world.lakeTileMap.length, 512 * 512);
});

test("CRAZY4X: a 512-cell, step 32 track loads with its own world", { skip: skipV6 }, () => {
  const pod = openPod(new Uint8Array(readFileSync(V6_POD)));
  const choices = listTrackChoices(pod.podIndex);
  assert.deepEqual(choices.map((c) => c.entry.title), ["CRAZY4X.SI3"]);
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, choices[0].entry, "");
  assert.equal(doc.v6.worldCells, 512);
  assert.equal(doc.v6.worldFt, 16384);
  assert.equal(doc.terrain.gridSize, 512);
  assert.equal(doc.terrain.rawBytesPerCell, 2);
  // Samples over 2 * step plus base / 2, in legacy 2 ft steps (the file's step and base may change as it is rebuilt).
  assert.equal(doc.terrain.heightDivisor, 2 * doc.v6.heightStep);
  assert.equal(doc.terrain.heightOffset, doc.v6.heightBase / 2);
  assert.equal(doc.terrain.cp4.mode, "spline");
  assert.equal(doc.terrain.fine.heights.length, 2048 * 2048);
  // Above 512 ft: the mountain range.
  assert.ok(doc.v6.heightRangeFt[1] > 1000);
  assert.ok(doc.v6.heightRangeFt[0] >= doc.v6.heightBase);
  assert.ok(doc.groundBoxes.length > 0 && doc.groundBoxes.every((b) => b.v6 && b.depth === 16));
  const world = loadCp4World(pod.podIndex, pod.getBytes, doc, "CRAZY4X", () => null, { cellSize: 64, heightScale: 3 });
  // Its version 2 lakes, above the track's base (how many and how high is the file's choice).
  assert.ok(world.lakes.length >= 1);
  assert.ok(world.lakes.every((l) => l.heightFt > doc.v6.heightBase));
  assert.equal(world.lakeTileMap.length, 512 * 512);
  // Its waterfalls, when the file carries a .WFL, are built in the 512 world without a complaint.
  if (pod.podIndex.entries.some((e) => /CRAZY4X\.WFL$/i.test(e.name))) {
    assert.deepEqual(doc.warnings.filter((w) => w.startsWith("Waterfalls")), []);
    assert.ok(world.waterfalls?.falls.length > 0);
  }
});

test("CRAZY4X: a bad .TXV key, a missing .TXV or a short grid file refuses the track", { skip: skipV6 }, () => {
  const load = (changes) => {
    const pod = rebuiltPod(changes);
    return parseSitTrack(pod.podIndex, pod.getBytes, entryOf(pod, "CRAZY4X.SI3"), "");
  };
  const txv = new TextDecoder().decode(readPodEntry(new Uint8Array(readFileSync(V6_POD)),
    parsePod(new Uint8Array(readFileSync(V6_POD))).entries.find((e) => e.title === "CRAZY4X.TXV")));
  assert.throws(() => load({ "DATA\\CRAZY4X.TXV": text(txv.replace(/worldCells=512/i, "worldCells=384")) }), /worldCells=384/);
  assert.throws(() => load({ "DATA\\CRAZY4X.TXV": null }), /formatVersion=6/);
  assert.throws(() => load({ "DATA\\CRAZY4X.CL1": new Uint8Array(4 * 256 * 256) }), /CL1 is 262144 bytes/);
  assert.throws(() => load({ "DATA\\CRAZY4X.RA1": new Uint8Array(512 * 512) }), /same depth/);
  // A later version still loads, with a warning.
  const doc = load({ "DATA\\CRAZY4X.TXV": text(txv.replace(/formatVersion=6/i, "formatVersion=7")) });
  assert.ok(doc.warnings.some((w) => /may need a newer build/.test(w)));
});

test("CRAZY4X: a .SIT of the same stem is a separate track read by today's rules", { skip: skipV6 }, () => {
  const original = openPod(new Uint8Array(readFileSync(V6_POD)));
  const si3 = original.getBytes(entryOf(original, "CRAZY4X.SI3"));
  const pod = rebuiltPod({ "WORLD\\CRAZY4X.SIT": si3 });
  const choices = listTrackChoices(pod.podIndex);
  assert.deepEqual(choices.map((c) => c.entry.title).sort(), ["CRAZY4X.SI3", "CRAZY4X.SIT"]);
  const sit = parseSitTrack(pod.podIndex, pod.getBytes, entryOf(pod, "CRAZY4X.SIT"), "");
  assert.equal(sit.v6, null);
  assert.equal(sit.terrain.heightOffset, undefined);
});
