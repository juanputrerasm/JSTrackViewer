import test from "node:test";
import assert from "node:assert/strict";
import { trackSpawnPoint } from "../src/drive/spawn-point.js";
import { parseSitTrack } from "../src/worker/sit-parser.js";
import { createColliders } from "../src/drive/colliders.js";
import { hasStockPod, indexStockPod } from "./helpers/stock-pod.mjs";

const frame = {
  worldSizeFeet: 2048,
  editorToFeet: ([x, z]) => ({ x: x / 2, y: 0, z: (4096 - z) / 2 }),
  heightAtFeet: () => 100,
};

test("TV/F3/HB use the first NAV start position and heading for Drive and reset", () => {
  for (const origin of ["TV", "F3", "HB"]) {
    const point = trackSpawnPoint({ origin, trucks: [], navPoints: [
      { type: 2, position: [100, 100, 0] },
      { type: 6, position: [600, 800, 15], heading: 16384 },
    ] }, frame, { restHeight: 7 });
    assert.deepEqual(point, { x: 300, y: 107, z: 1648, psi: Math.PI / 2 });
  }
  assert.equal(trackSpawnPoint({ navPoints: [] }, frame, {}).x, 1024, "map centre is the last fallback");
  const below = trackSpawnPoint({ origin: "HB", navPoints: [{ type: 6, position: [600, 800, -150], underground: true }] },
    { ...frame, editorToFeet: () => ({ x: 300, y: -200, z: 1648 }) }, { restHeight: 7 });
  assert.equal(below.y, -193, "an underground Hellbender start keeps its authored level");
});

test("CPR Laguna declares and loads four backdrop model names", {
  skip: !hasStockPod("/Users/juanpabloutreras/games/cpr/LAGUNA.POD"),
}, () => {
  const { podIndex, getBytes } = indexStockPod("/Users/juanpabloutreras/games/cpr/LAGUNA.POD");
  const sit = podIndex.entries.find((entry) => entry.title === "LAGUNA.SIT");
  const doc = parseSitTrack(podIndex, getBytes, sit, "");
  assert.deepEqual(doc.backdropModelNames, ["LG4DROP1.BIN", "LG4DROP2.BIN", "LG4DROP3.BIN", "LG4DROP4.BIN"]);
  for (const name of doc.backdropModelNames) assert.ok(podIndex.entries.some((entry) => entry.title === name));
});

const trunk = {
  positions: new Float32Array([0, 0, -0.4, 0, 4, -0.4, 0, 4, 0.4, 0, 0, 0.4]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const leaves = {
  positions: new Float32Array([0, 4, -10, 0, 10, -10, 0, 10, 10, 0, 4, 10]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

test("Evo 1 translucent foliage passes through while its opaque trunk remains solid", () => {
  const model = { meshes: [{ ...trunk, groupName: "OPAQUE" }, { ...leaves, groupName: "TRANSP" }] };
  const colliders = createColliders({
    origin: "EVO1", terrain: { gridSize: 128, cellSize: 32, heightScale: 1 },
    boxes: [{ modelName: "KM3TREE1.SMF", position: [1000, 1000, 100], sourceClass: "Box" }],
    models: { "KM3TREE1.SMF": model },
  }, {});
  const { x, y, z } = colliders.solids[0].centre;
  assert.ok(colliders.contactAt({ x: x - 1, y: y + 1, z }, { x: x + 8, y: y + 1, z }));
  assert.equal(colliders.contactAt({ x: x - 1, y: y + 5, z: z + 3 }, { x: x + 8, y: y + 5, z: z + 3 }), null);
});

test("Evo 2 single-mesh trees collide at the narrow trunk, never at broad leaf cards", () => {
  const positions = new Float32Array([...trunk.positions, ...leaves.positions]);
  const indices = new Uint32Array([...trunk.indices, ...leaves.indices.map((i) => i + 4)]);
  const model = { meshes: [{ positions, indices, groupName: "OPAQUE", textureHasAlpha: true }] };
  const colliders = createColliders({
    origin: "EVO2", terrain: { gridSize: 128, cellSize: 32, heightScale: 1 }, boxes: [],
    vegetation: { trees: [{ modelName: "PALMFAN.SMF", position: [1000, 1000, 100], yaw: 0, scale: [1, 1, 1] }] },
    models: { "PALMFAN.SMF": model },
  }, {});
  const { x, y, z } = colliders.solids[0].centre;
  assert.ok(colliders.contactAt({ x: x - 1, y: y + 1, z }, { x: x + 8, y: y + 1, z }));
  assert.equal(colliders.contactAt({ x: x - 1, y: y + 5, z: z + 3 }, { x: x + 8, y: y + 5, z: z + 3 }), null);
});
