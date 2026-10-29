/*
  Hellbender's openings between its two worlds, by the engine's rule (HELLBEND.EXE 0x41a8c0): a
  sample is open when its surface height is 0 and its cavern ceiling byte is 255, and a quad is
  open when all four corners are. The floating levels are mostly open; ordinary levels keep a
  few shafts and pits. Texture identity is irrelevant: any non-flat cell must remain intact.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { buildHbFlatLayerMask, buildHbSurfaceMask } from "../src/worker/hb-underground.js";
import { parseLvlTrack } from "../src/worker/lvl-parser.js";
import { buildTerrainMesh } from "../src/worker/terrain-builder.js";
import { hasStockPod, indexStockPod } from "./helpers/stock-pod.mjs";

const HB_GAME_POD = [`${process.env.HOME}/games/hb/GAME.POD`, `${process.env.HOME}/games/hb/system/GAME.POD`]
  .find((path) => existsSync(path)) ?? `${process.env.HOME}/games/hb/GAME.POD`;

test("HB surface mask removes only quads whose four corners are openings", () => {
  const side = 4;
  const raw = new Uint8Array(side * side);
  raw[1 + side] = 7;
  const ceiling = new Uint8Array(side * side).fill(255);
  const mask = buildHbSurfaceMask(raw, side, ceiling);

  assert.ok(mask instanceof Uint8Array);
  // The raised sample keeps every quad that touches it.
  for (const [x, z] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    assert.equal(mask[x + z * side], 1, `${x},${z} touches the raised corner`);
  }
  assert.equal(mask[2 + 2 * side], 0, "an all-zero quad is empty");
  assert.equal(mask[3 + 3 * side], 0, "the clamped outer-edge quad is empty too");

  // A zero-height sample over a cavern ceiling below 0 is ground, not a hole.
  const lowered = ceiling.slice();
  lowered[3 + 3 * side] = 200;
  assert.equal(buildHbSurfaceMask(raw, side, lowered)[3 + 3 * side], 1, "ground over a closed cavern stays");
  assert.equal(buildHbSurfaceMask(raw, side, null), null, "no cavern, no openings");
});

test("a cavern mask removes only the dominant perfectly flat plane", () => {
  const side = 4;
  const heights = new Uint8Array(side * side).fill(255);
  heights[1 + side] = 200;
  const mask = buildHbFlatLayerMask(heights, new Uint8Array(side * side).fill(1), side);

  assert.equal(mask[3 + 3 * side], 0, "a quad wholly inside the flat ceiling is absent");
  for (const [x, z] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    assert.equal(mask[x + z * side], 1, `${x},${z} touches carved cavern geometry`);
  }
});

test("stock HB floating levels expose a broad zero plane while grounded sequels have almost none", {
  skip: hasStockPod(HB_GAME_POD) ? false : `no local Hellbender install at ${HB_GAME_POD}`,
}, () => {
  const pod = indexStockPod(HB_GAME_POD);
  const find = (title) => pod.podIndex.entries.find((entry) => entry.title === title);
  const load = (title) => {
    const entry = find(title);
    assert.ok(entry, `${title} exists`);
    return parseLvlTrack(pod.podIndex, pod.getBytes, entry, pod.podIndex.comment);
  };

  const floatingLevels = [
    "FLOAT.LVL", "FLOAT2.LVL", "ROID.LVL", "ROID2.LVL", "ROID3.LVL", "SHIP.LVL",
  ];
  const expectedLayerHoles = new Map([
    ["FLOAT.LVL", { floor: 0, ceiling: 13_866 }],
    ["FLOAT2.LVL", { floor: 0, ceiling: 13_401 }],
    ["ROID.LVL", { floor: 16_384, ceiling: 12_686 }],
    ["ROID2.LVL", { floor: 16_303, ceiling: 12_832 }],
    ["ROID3.LVL", { floor: 0, ceiling: 10_700 }],
    ["SHIP.LVL", { floor: 16_384, ceiling: 10_678 }],
  ]);
  const holes = (mask) => mask?.reduce((count, value) => count + (value === 0), 0) ?? 0;

  for (const title of floatingLevels) {
    const doc = load(title);
    const mask = doc.terrain.cellMask;
    assert.ok(doc.underground, `${title} keeps its cavern geometry`);
    assert.equal(doc.underground.sunlit, true, `${title} exposes its lower world to sunlight`);
    assert.ok(doc.undergroundBoxes.length > 0, `${title} keeps its underground structures`);
    const expected = expectedLayerHoles.get(title);
    assert.equal(holes(doc.underground.floorMask), expected.floor,
      `${title} removes only its dominant flat floor, if it has one`);
    assert.equal(holes(doc.underground.ceilingMask), expected.ceiling,
      `${title} removes only its dominant flat ceiling`);
    assert.ok(holes(mask) > 10_000,
      `${title} has a mostly empty plane`);
    const raw = doc.terrain.rawData;
    const side = doc.terrain.gridSize;
    const at = (x, z) => raw[Math.min(side - 1, x) + Math.min(side - 1, z) * side];
    for (let cell = 0; cell < mask.length; cell++) {
      if (mask[cell] !== 0) continue;
      const x = cell % side, z = Math.floor(cell / side);
      assert.deepEqual([at(x, z), at(x + 1, z), at(x + 1, z + 1), at(x, z + 1)],
        [0, 0, 0, 0], `${title} removed non-flat surface cell ${cell}`);
    }
    if (title === "FLOAT.LVL") {
      const mesh = buildTerrainMesh(doc.terrain, doc.palette, doc.textures, 3, doc.origin);
      const indices = new Uint32Array(mesh.indices);
      for (let cell = 0; cell < mask.length; cell++) {
        if (mask[cell] !== 0) continue;
        const six = indices.subarray(cell * 6, cell * 6 + 6);
        assert.ok(six.every((index) => index === six[0]),
          `FLOAT void cell ${cell} emitted a renderable triangle`);
      }
    }
  }
  // Grounded levels keep only their shafts and pits open, and stay enclosed.
  for (const title of ["ROID4.LVL", "SHIP2.LVL", "JURASIC.LVL", "KREASH3.LVL"]) {
    const doc = load(title);
    const open = holes(doc.terrain.cellMask);
    assert.ok(open > 0 && open < 1000, `${title} has a few openings (${open})`);
    assert.notEqual(doc.underground.sunlit, true, `${title} keeps an enclosed cavern`);
    assert.equal(doc.underground.floorMask, undefined, `${title}'s cavern floor is not cut`);
  }
  const iowah = load("IOWAH.LVL");
  assert.ok(iowah.underground, "IOWAH keeps its genuine playable cavern");
  assert.notEqual(iowah.underground.sunlit, true, "IOWAH's enclosed cavern remains unlit");
  assert.equal(iowah.underground.floorMask, undefined, "IOWAH's cavern floor is not cut");
  // The ceiling is cut only where the surface is open.
  const { mask: hollow, ceilingMask } = iowah.underground;
  const surface = iowah.terrain.cellMask;
  for (let cell = 0; cell < ceilingMask.length; cell++) {
    if (ceilingMask[cell] === 0 && hollow[cell] === 1) assert.equal(surface[cell], 0, `IOWAH ceiling cut at closed cell ${cell}`);
  }
});
