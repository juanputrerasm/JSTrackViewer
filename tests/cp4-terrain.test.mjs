/*
  Community Patch 4's 16-bit MTM2 terrain (src/worker/sit-parser.js applyCp4Heights): a 131,072-byte grid behind an MTM2
  SIT is 1/128 ft a step, not CPR's 10.6. The track is Fila's vegetation and fog sandbox (~/games/cp4sandbox/fog_test.pod),
  its height file swapped; the test skips without it.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { parseSitTrack } from "../src/worker/sit-parser.js";
import { decodeHeightSample } from "../src/shared/terrain-height.js";
import { hasStockPod, indexStockPod } from "./helpers/stock-pod.mjs";
import { buildTerrainMesh } from "../src/worker/terrain-builder.js";
import { createWorldFrame } from "../src/drive/world-frame.js";

const SANDBOX = `${process.env.HOME}/games/cp4sandbox/fog_test.pod`;

function sandbox(raw) {
  const pod = indexStockPod(SANDBOX);
  const rawEntry = pod.podIndex.entries.find((e) => /DATA[\\/]FOGTEST\.RAW$/i.test(e.name));
  return { ...pod, getBytes: (entry) => (raw && entry === rawEntry ? raw : pod.getBytes(entry)) };
}

const sit = (pod) => pod.podIndex.entries.find((e) => /FOGTEST\.SI2$/i.test(e.name));

test("the classic sandbox keeps its 8-bit grid", { skip: !hasStockPod(SANDBOX) }, () => {
  const pod = sandbox(null);
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit(pod), "");
  assert.equal(doc.terrain.rawBytesPerCell, 1);
  assert.equal(doc.terrain.cp4, undefined);
});

test("a 16-bit MTM2 grid is read at 1/128 ft (legacy steps of 2 ft: v / 256)", { skip: !hasStockPod(SANDBOX) }, () => {
  const raw = new Uint8Array(131072);
  new DataView(raw.buffer).setUint16(0, 1291, true);
  const pod = sandbox(raw);
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit(pod), "");
  assert.equal(doc.terrain.cp4.mode, "classic16");
  assert.equal(doc.terrain.heightDivisor, 256);
  assert.equal(doc.terrain.cellSplit, "fixed");
  const steps = decodeHeightSample(doc.terrain.rawData, 0, 2, doc.terrain.heightDivisor, doc.terrain.heightUnitScale);
  assert.ok(Math.abs(steps * 2 - 1291 / 128) < 1e-9, "feet = steps x 2 = v / 128");
});

test("a Full Map is drawn at its 32 ft corners", { skip: !hasStockPod(SANDBOX) }, () => {
  const raw = new Uint8Array(2097152);
  new DataView(raw.buffer).setUint16((4 * 1 * 1024 + 4 * 2) * 2, 2560, true);
  const pod = sandbox(raw);
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit(pod), "");
  assert.equal(doc.terrain.cp4.mode, "fine");
  assert.equal(doc.terrain.gridSize, 256);
  assert.equal(decodeHeightSample(doc.terrain.rawData, (1 * 256 + 2) * 2, 2, 256, 1) * 2, 20);
});

test("a Full Map keeps its 8 ft grid for the mesh and drive mode", { skip: !hasStockPod(SANDBOX) }, () => {
  const raw = new Uint8Array(2097152);
  new DataView(raw.buffer).setUint16((4 * 1 * 1024 + 4 * 2 + 1) * 2, 2560, true);
  const pod = sandbox(raw);
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit(pod), "");
  assert.equal(doc.terrain.fine.subdivisions, 4);
  assert.equal(doc.terrain.fine.divisor, 256);
  assert.equal(doc.terrain.fine.heights[4 * 1 * 1024 + 4 * 2 + 1], 2560, "a point between the 32 ft corners");
});

/*
  The 8 ft mesh (terrain-builder.js buildFineCells) on a 2 x 2 grid: 25 vertices a cell, its
  heights straight from the fine grid, the cell's tile stretched over the whole block, and the
  fine checkerboard split. Drive mode (world-frame.js) must stand on the same triangles.
*/
function fineTerrain() {
  const side = 8;
  const heights = new Uint16Array(side * side);
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) heights[x + z * side] = (x * 3 + z * 5 + (x * z) % 7) * 256;
  return {
    gridSize: 2, cellSize: 64, rawData: new Uint8Array(8), rawBytesPerCell: 2, heightDivisor: 256, heightUnitScale: 1,
    clrData: null, clrBytesPerCell: 2, fine: { heights, subdivisions: 4, divisor: 256 },
  };
}

test("the 8 ft mesh has a 5 x 5 block of vertices per 32 ft cell, on the fine heights", () => {
  const terrain = fineTerrain();
  const mesh = buildTerrainMesh(terrain, null, [], 3, "MTM2");
  assert.equal(mesh.subdivisions, 4);
  const positions = new Float32Array(mesh.positions);
  assert.equal(positions.length, 4 * 25 * 3);
  assert.equal(new Uint32Array(mesh.indices).length, 4 * 32 * 3);
  // Cell (1, 0), vertex (i 2, j 3): fine point (6, 3) at x 6 * 16, z (8 - 3) * 16, its height in steps x 3.
  const v = 1 * 25 + 3 * 5 + 2;
  assert.deepEqual([...positions.subarray(v * 3, v * 3 + 3)], [96, (terrain.fine.heights[6 + 3 * 8] / 256) * 3, 80]);
  // The tile spans the whole cell: the block's corners carry the coarse quad's corner UVs, the middle their average.
  const uvs = new Float32Array(mesh.uvs);
  const uv = (k) => [uvs[k * 2], uvs[k * 2 + 1]];
  const c0 = uv(0), c1 = uv(4), c2 = uv(24), c3 = uv(20);
  assert.notDeepEqual(c0, c1);
  const mid = uv(12);
  assert.ok(Math.abs(mid[0] - (c0[0] + c1[0] + c2[0] + c3[0]) / 4) < 1e-6);
  // Fine cell (1, 0) is odd: split from (2, 0) to (1, 1), so its first triangle is (q0, q1, q3).
  const indices = new Uint32Array(mesh.indices);
  assert.deepEqual([...indices.subarray(6, 9)], [1, 2, 6]);
  assert.deepEqual([...indices.subarray(0, 3)], [0, 1, 6], "even fine cell (0, 0): (q0, q1, q2)");
});

test("drive mode stands on the 8 ft triangles the mesh draws", () => {
  const terrain = fineTerrain();
  const frame = createWorldFrame({ terrain: { ...terrain, heightScale: 3, fine: { ...terrain.fine, heights: terrain.fine.heights.buffer } } });
  const h = (x, z) => terrain.fine.heights[x + z * 8] / 256;
  // Fine cell (1, 0) at u 0.25, w 0.25: on the plane of (1,0), (2,0), (1,1), the odd split.
  const gx = 1.25, gz = 0.25;
  const xFt = gx * 8, zFt = (8 - gz) * 8;
  const steps = h(1, 0) + (h(2, 0) - h(1, 0)) * 0.25 + (h(1, 1) - h(1, 0)) * 0.25;
  assert.ok(Math.abs(frame.heightAtFeet(xFt, zFt) - steps * 2) < 1e-9, "2 ft a step at the default height scale");
  // An 8 ft cell's slope, not a 32 ft one.
  const n = frame.normalAtFeet(xFt, zFt);
  const dhdx = (h(2, 0) - h(1, 0)) * 2 / 8;
  assert.ok(Math.abs(-n.x / n.y - dhdx) < 1e-9);
});
