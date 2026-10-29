/*
  The TV-family engine rules the viewer applies on top of the data: where a placement settles
  (engine-placement.js), the chamber ceilings (tv-chambers.js) and the tunnel tube
  (tunnel-builder.js). See docs/TV_GAME_EXE_ANALYSIS.md and docs/HELLBENDER_EXE_ANALYSIS.md.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { settlePlacements } from "../src/worker/engine-placement.js";
import { buildTvChambers } from "../src/worker/tv-chambers.js";
import { buildTunnelMesh } from "../src/worker/tunnel-builder.js";
import { parseTvTunnel } from "../src/vendor/openphotex/index.js";

const box = (position, engine) => ({ position, engine });

test("TV placement: terrain replaces Y, the DEF offset is added, flyers rise by half the radius", () => {
  const gridSize = 4;
  const raw = new Uint8Array(gridSize * gridSize).fill(10);
  const doc = {
    origin: "TV/F3",
    terrain: { gridSize, rawData: raw },
    boxes: [
      box([64, 64, 3], { offset: [0, 0, 0], logic: 0, modelRadius: 65536 }),
      box([64, 64, 3], { offset: [0, 32768, 0], logic: 0, modelRadius: 65536 }),
      box([64, 64, 3], { offset: [0, 0, 0], logic: 2, modelRadius: 65536 }),
      box([64, 64, 3], { offset: [16384, 0, 0], logic: 0, modelRadius: null }),
    ],
  };
  settlePlacements(doc);
  assert.deepEqual(doc.boxes.map((b) => b.position[2]), [10, 11, 11, 10]);
  assert.equal(doc.boxes[0].storedAltitude, 3);
  assert.equal(doc.boxes[3].position[0], 65, "an X offset of 2^14 world units is one editor unit");

  // A tunnel level has no heightfield and keeps the stored height.
  const tunnel = { origin: "TV/F3", terrain: { gridSize: 256, rawData: null }, boxes: [box([0, 0, 7], { offset: [0, 0, 0], logic: 2, modelRadius: 65536 })] };
  settlePlacements(tunnel);
  assert.equal(tunnel.boxes[0].position[2], 7);
});

test("Hellbender placement: Y is kept, raised to the floor or onto a box, and never offset in Y", () => {
  const gridSize = 4;
  const raw = new Uint8Array(gridSize * gridSize).fill(20);
  const doc = {
    origin: "HB",
    terrain: { gridSize, rawData: raw },
    groundBoxes: [{ x: 2, y: 2, lower: 20, upper: 30 }],
    underground: { floorHeights: new Uint8Array(gridSize * gridSize).fill(205), ceilingHeights: new Uint8Array(gridSize * gridSize).fill(240) },
    undergroundBoxes: [],
    boxes: [
      box([32, 32, 5], { offset: [0, 99999, 0], logic: 2, modelRadius: 65536 }),
      box([32, 32, 40], { offset: [0, 0, 0], logic: 0, modelRadius: null }),
      box([160, 160, 25], { offset: [0, 0, 0], logic: 0, modelRadius: null }),
      box([32, 32, -60], { offset: [0, 0, 0], logic: 0, modelRadius: null }),
    ],
  };
  settlePlacements(doc);
  // Below the surface (20): raised to it, no Y offset, no lift. Above: kept. Inside a box: its
  // top. Underground below the cavern floor (205 - 255 = -50): raised to it.
  assert.deepEqual(doc.boxes.map((b) => b.position[2]), [20, 40, 30, -50]);
});

test("TV chambers: a hollow walled by rock gets a ceiling at 510 - h, textured ten cells along", () => {
  const gridSize = 32;
  const raw = new Uint8Array(gridSize * gridSize).fill(255);
  const clr = new Uint8Array(gridSize * gridSize * 2);
  for (let z = 10; z < 14; z++) for (let x = 10; x < 14; x++) raw[x + z * gridSize] = 200;
  clr[(21 + 11 * gridSize) * 2] = 9;
  const chambers = buildTvChambers({ gridSize, rawData: raw, clrData: clr, clrBytesPerCell: 2 });
  assert.ok(chambers?.mask);
  const cell = 11 + 11 * gridSize;
  assert.equal(chambers.mask[cell], 1);
  assert.equal(chambers.ceilingHeights[cell * 2] | (chambers.ceilingHeights[cell * 2 + 1] << 8), 310);
  assert.equal(chambers.ceilingClr[cell * 2], 9, "texture from (cx + 10, cz)");
  assert.equal(chambers.mask[0], 0, "rock is not a chamber");
  assert.ok(chambers.rockCells.length > 0);
  // A level with no rock has no chambers.
  assert.equal(buildTvChambers({ gridSize, rawData: new Uint8Array(gridSize * gridSize).fill(9) }), null);
});

test("TV tunnel: one face per side per segment, one cell long, in the level's object frame", () => {
  const segment = ["0,1024,0,1024,4", "0,65536,0", "1024,1024", "0,65536", "1024,1024", "65535", "1", "0", "0", "1", "0", "0", "0", "0", "0", "65535", "32768"];
  const tnl = parseTvTunnel(new TextEncoder().encode(["2", ...segment, ...segment].join("\r\n")));
  const mesh = buildTunnelMesh(tnl, [], null, 2, 16384);
  assert.ok(mesh);
  assert.equal(new Uint32Array(mesh.indices).length, 2 * 4 * 6);
  const positions = new Float32Array(mesh.positions);
  // Ring A of segment 0, vertex 0: (1024, 1024) tunnel units = 16 editor units across and 8
  // height steps up (16 scene units at scale 2), at editor Y 0 (scene Z = worldSize).
  assert.deepEqual([...positions.subarray(0, 3)], [16, 16, 16384]);
  // Segment 1 starts one cell (64 editor units) along.
  assert.equal(positions[4 * 4 * 3 + 2], 16384 - 64);
  // The camera opens on the centre line just inside the mouth, looking along the tube.
  assert.deepEqual(mesh.startView, { x: 0, y: 16, z: 16384 - 16, yaw: 0, pitch: 0 });
});
