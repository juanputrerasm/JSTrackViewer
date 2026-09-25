/*
  Tests for terrain height decoding: CPR 10.6, Evo 11.5 and the MTM family's one byte.

  Run with: node --test tests/

  The decode tables and interpolation cases are hermetic. The stock cases read local CPR and
  MTM2 installs, and skip themselves when either is absent.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  CPR_ALTITUDE_DIVISOR, CPR_HEIGHT_DIVISOR, CPR_HEIGHT_UNIT_SCALE, LEGACY_ALTITUDE_DIVISOR,
  decodeHeightSample, heightAtCell, legacyWholeHeight16,
} from "../src/shared/terrain-height.js";
import { EVO_HEIGHT_DIVISOR, evoHeightAtCell, evoHeightAt } from "../src/worker/evo/evo-coords.js";
import { createWorldFrame, UNITS_PER_FOOT_H, UNITS_PER_FOOT_V } from "../src/drive/world-frame.js";
import { buildTerrainMesh } from "../src/worker/terrain-builder.js";
import { parseSitTrack } from "../src/worker/sit-parser.js";
import { decodeBinModel } from "../src/worker/bin-decoder.js";
import { hasStockPod, indexStockPod } from "./helpers/stock-pod.mjs";

const LAGUNA_POD = `${process.env.HOME}/games/cpr/LAGUNA.POD`;
const MTM2_POD = `${process.env.HOME}/games/mtm2/SUMMIT1.POD`;
const MTM2_OBJECTS_POD = `${process.env.HOME}/games/mtm2/ALASKA.POD`;

/** Little-endian uint16 cells from a list of raw values. */
function raw16(values) {
  const bytes = new Uint8Array(values.length * 2);
  values.forEach((v, i) => { bytes[i * 2] = v & 0xff; bytes[i * 2 + 1] = v >> 8; });
  return bytes;
}

const decode16 = (value, divisor) => decodeHeightSample(raw16([value]), 0, 2, divisor);

test("CPR decodes 10.6 fixed point exactly: raw16 / 64", () => {
  assert.equal(CPR_HEIGHT_DIVISOR, 64);
  const cases = [
    [0, 0], [1, 0.015625], [32, 0.5], [63, 0.984375], [64, 1.0], [65, 1.015625],
    [127, 1.984375], [128, 2.0], [65535, 1023.984375],
  ];
  for (const [value, expected] of cases) {
    assert.equal(decode16(value, CPR_HEIGHT_DIVISOR), expected, `raw ${value}`);
  }
});

test("Evo decodes 11.5 fixed point exactly: raw16 / 32, not CPR's /64", () => {
  assert.equal(EVO_HEIGHT_DIVISOR, 32);
  const cases = [[0, 0], [1, 0.03125], [31, 0.96875], [32, 1.0], [33, 1.03125], [65535, 2047.96875]];
  for (const [value, expected] of cases) {
    assert.equal(decode16(value, EVO_HEIGHT_DIVISOR), expected, `raw ${value}`);
    // Evo's own sampler and the shared decode must agree cell for cell.
    const grid = new Uint8Array(256 * 256 * 2);
    grid[0] = value & 0xff; grid[1] = value >> 8;
    assert.equal(evoHeightAtCell(grid, 0, 0), expected, `evoHeightAtCell raw ${value}`);
    assert.equal(heightAtCell({ gridSize: 256, rawBytesPerCell: 2, heightDivisor: 32 }, grid, 0, 0),
      expected);
  }
});

test("Evo bilinear sampling keeps the fraction", () => {
  const grid = new Uint8Array(256 * 256 * 2);
  const put = (x, z, v) => { const o = (x + z * 256) * 2; grid[o] = v & 0xff; grid[o + 1] = v >> 8; };
  put(0, 0, 3201); put(1, 0, 3201); put(0, 1, 3201); put(1, 1, 3201);
  assert.equal(evoHeightAt(grid, 16, 16), 3201 / 32);
});

test("MTM one-byte heights are whole steps, unchanged", () => {
  const bytes = Uint8Array.of(0, 1, 2, 127, 128, 255);
  for (let i = 0; i < bytes.length; i++) {
    // A divisor on an 8-bit grid is ignored: the byte is the height.
    assert.equal(decodeHeightSample(bytes, i, 1, null), bytes[i]);
    assert.equal(decodeHeightSample(bytes, i, 1, 64), bytes[i]);
  }
});

test("an undeclared 16-bit grid keeps the legacy JTraxx whole-step reading", () => {
  assert.equal(legacyWholeHeight16(0), 0);
  assert.equal(legacyWholeHeight16(200), 200);          // high byte zero: 8 bits stored wide
  assert.equal(legacyWholeHeight16(12160), 190);
  assert.equal(legacyWholeHeight16(12200), 190);        // 190.625 floored
  assert.equal(decode16(12200, null), 190);
  assert.equal(decode16(12200, CPR_HEIGHT_DIVISOR), 190.625);
});

/*
  Four CPR corners at 100.00, 100.25, 100.50 and 100.75 steps. Every reading between them is
  fractional; the old `>>> 6` made all four 100 and the terrain flat.
*/
const QUARTERS = [6400, 6416, 6432, 6448];

function cprFrame() {
  // 2x2 grid laid out (cx, cz): (0,0) (1,0) (0,1) (1,1).
  const [a, b, c, d] = QUARTERS;
  return createWorldFrame({
    terrain: {
      gridSize: 2, cellSize: 64, heightScale: 3, rawBytesPerCell: 2,
      heightDivisor: CPR_HEIGHT_DIVISOR, rawData: raw16([a, b, c, d]),
    },
  });
}

test("CPR fractional heights survive the drive frame's interpolation", () => {
  const frame = cprFrame();
  const stepsAt = (gx, gz) => frame.heightAtFeet(
    gx * 64 / UNITS_PER_FOOT_H, (2 - gz) * 64 / UNITS_PER_FOOT_H) * UNITS_PER_FOOT_V / 3;

  assert.ok(Math.abs(stepsAt(0, 0) - 100.00) < 1e-9);
  assert.ok(Math.abs(stepsAt(1, 0) - 100.25) < 1e-9);
  assert.ok(Math.abs(stepsAt(0, 1) - 100.50) < 1e-9);
  // Half way along the (0,0)-(1,0) edge.
  assert.ok(Math.abs(stepsAt(0.5, 0) - 100.125) < 1e-9);
  // Cell centre, on the v0-v2 diagonal: the mean of 100.00 and 100.75.
  const centre = stepsAt(0.5, 0.5);
  assert.ok(Math.abs(centre - 100.375) < 1e-9, `centre ${centre}`);
  assert.notEqual(Math.floor(centre), centre);
});

test("CPR fractional heights reach the terrain mesh vertices and normals", () => {
  const [a, b, c, d] = QUARTERS;
  const mesh = buildTerrainMesh({
    gridSize: 2, rawData: raw16([a, b, c, d]), rawBytesPerCell: 2,
    heightDivisor: CPR_HEIGHT_DIVISOR, clrData: new Uint8Array(8), clrBytesPerCell: 2,
  }, null, [], 1, "CPR", null);
  assert.equal(mesh.heightDivisor, CPR_HEIGHT_DIVISOR);

  const positions = new Float32Array(mesh.positions);
  // Cell (0,0), vertices v0..v3 = corners (0,0) (1,0) (1,1) (0,1).
  assert.deepEqual([positions[1], positions[4], positions[7], positions[10]],
    [100.00, 100.25, 100.75, 100.50]);

  // A sloped cell must not light as flat, which is what integer heights produced here.
  const normals = new Float32Array(mesh.normals);
  assert.ok(Math.abs(normals[0]) > 1e-4, "x slope reaches the normal");
});

/*
  Every vertex of the mesh must be the shared decode of its own grid corner, times heightScale.
  All four corners of a cell go through the same call, so a corner that misses an argument
  shows up as a cell whose two rows disagree by the unit scale: on Laguna that was every cell,
  a field of 1x/2x spikes.
*/
test("every CPR mesh vertex equals the shared decode of its corner, unit scale included", () => {
  const grid = 4;
  const values = Array.from({ length: grid * grid }, (_, i) => 6400 + i * 17);
  const terrain = {
    gridSize: grid, rawData: raw16(values), rawBytesPerCell: 2,
    heightDivisor: CPR_HEIGHT_DIVISOR, heightUnitScale: CPR_HEIGHT_UNIT_SCALE,
    clrData: new Uint8Array(grid * grid * 2), clrBytesPerCell: 2,
  };
  const hs = 3;
  const mesh = buildTerrainMesh(terrain, null, [], hs, "CPR", null);
  assert.equal(mesh.heightUnitScale, CPR_HEIGHT_UNIT_SCALE);
  const positions = new Float32Array(mesh.positions);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let cz = 0; cz < grid; cz++) {
    for (let cx = 0; cx < grid; cx++) {
      const base = (cx + cz * grid) * 12;
      corners.forEach(([ox, oz], v) => {
        const want = heightAtCell(terrain, terrain.rawData, cx + ox, cz + oz) * hs;
        assert.ok(Math.abs(positions[base + v * 3 + 1] - want) < 1e-3,
          `cell (${cx},${cz}) vertex ${v}: ${positions[base + v * 3 + 1]} != ${want}`);
      });
    }
  }
  // And the unit scale really is applied: corner (0,0) is 100 CPR steps, 200 legacy steps.
  assert.equal(positions[1], 200 * hs);
});

/*
  CPR splits its cells on alternating diagonals, like Traxx: (cx,cz)-(cx+1,cz+1) where cx + cz
  is even, (cx+1,cz)-(cx,cz+1) where it is odd. A single raised corner shows which: at the
  centre of a cell the surface is the mean of whichever two corners the diagonal joins.
*/
test("CPR terrain uses the checkerboard split, in the mesh and under the wheels", () => {
  const grid = 4;
  // Only corner (1,1) is raised. It is shared by cells (0,0), even, and (1,0), odd.
  const heights = new Array(grid * grid).fill(0);
  heights[1 + 1 * grid] = 10;                                // corner (1,1): 10 steps
  const rawData = new Uint8Array(heights);
  const base = { gridSize: grid, cellSize: 64, heightScale: 3, rawBytesPerCell: 1, rawData,
    clrData: new Uint8Array(grid * grid * 2), clrBytesPerCell: 2 };

  const centreSteps = (cellSplit, cx, cz) => {
    const frame = createWorldFrame({ terrain: { ...base, cellSplit } });
    const x = (cx + 0.5) * 64 / UNITS_PER_FOOT_H;
    const z = (grid - cz - 0.5) * 64 / UNITS_PER_FOOT_H;
    return frame.heightAtFeet(x, z) * UNITS_PER_FOOT_V / 3;
  };
  // Cell (0,0), even: both splits join (0,0) and (1,1), so the centre is 5.
  assert.equal(centreSteps("fixed", 0, 0), 5);
  assert.equal(centreSteps("checkerboard", 0, 0), 5);
  // Cell (1,0), odd: the fixed split joins (1,0)-(2,1), both 0; the checkerboard joins
  // (2,0)-(1,1), which carries the raised corner.
  assert.equal(centreSteps("fixed", 1, 0), 0);
  assert.equal(centreSteps("checkerboard", 1, 0), 5);

  const mesh = buildTerrainMesh({ ...base, cellSplit: "checkerboard" }, null, [], 3, "CPR", null);
  assert.equal(mesh.cellSplit, "checkerboard");
  const indices = new Uint32Array(mesh.indices);
  // Even cell 0 keeps (v0,v1,v2)(v0,v2,v3); odd cell 1 is (v0,v1,v3)(v1,v2,v3).
  assert.deepEqual([...indices.slice(0, 6)], [0, 1, 2, 0, 2, 3]);
  assert.deepEqual([...indices.slice(6, 12)], [4, 5, 7, 5, 6, 7]);
  // MTM keeps the fixed split everywhere.
  const fixed = new Uint32Array(buildTerrainMesh(base, null, [], 3, "MTM2", null).indices);
  assert.deepEqual([...fixed.slice(6, 12)], [4, 5, 6, 4, 6, 7]);
});

test("CPR terrain and TRK altitude meet without either being floored", () => {
  // raw16 == 16 * trkAltitude, so raw16 / 64 == trkAltitude / 4 exactly.
  for (const trkAltitude of [789.4375, 751.5, 929.9375, 762.375, 0.0625]) {
    const raw = trkAltitude * 16;
    assert.equal(decode16(raw, CPR_HEIGHT_DIVISOR), trkAltitude / 4);
  }
});

function sitDoc(podPath) {
  const pod = indexStockPod(podPath);
  const sit = pod.podIndex.entries.find((e) => /\.SI[T2]$/.test(e.title));
  return { pod, doc: parseSitTrack(pod.podIndex, pod.getBytes, sit, "") };
}
const lagunaDoc = () => sitDoc(LAGUNA_POD).doc;
const skipLaguna = hasStockPod(LAGUNA_POD) ? false : `no local CPR install at ${LAGUNA_POD}`;

/** Bilinear terrain height, in canonical legacy steps, under an editor-space (x, y). */
function groundAt(terrain, ex, ey) {
  const gx = ex / 64, gz = ey / 64;
  const cx = Math.floor(gx), cz = Math.floor(gz);
  const u = gx - cx, w = gz - cz;
  const h = (x, z) => heightAtCell(terrain, terrain.rawData, x, z);
  return h(cx, cz) * (1 - u) * (1 - w) + h(cx + 1, cz) * u * (1 - w)
    + h(cx, cz + 1) * (1 - u) * w + h(cx + 1, cz + 1) * u * w;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

test("CPR converts to the viewer's 2 ft step exactly once, SIT/TRK and terrain alike", () => {
  assert.equal(CPR_ALTITUDE_DIVISOR / CPR_HEIGHT_UNIT_SCALE, LEGACY_ALTITUDE_DIVISOR);
  assert.equal(LEGACY_ALTITUDE_DIVISOR, 2);
  // 789.4375 ft of TRK altitude: native 197.359375 CPR steps, canonical 394.71875.
  const raw = 789.4375 * 16;
  assert.equal(decodeHeightSample(raw16([raw]), 0, 2, CPR_HEIGHT_DIVISOR, CPR_HEIGHT_UNIT_SCALE),
    789.4375 / LEGACY_ALTITUDE_DIVISOR);
  // Evo and MTM are untouched by the unit scale default.
  assert.equal(decodeHeightSample(raw16([33]), 0, 2, EVO_HEIGHT_DIVISOR), 1.03125);
});

test("Laguna: the SIT loader declares CPR's 10.6 encoding and its unit", { skip: skipLaguna }, () => {
  const doc = lagunaDoc();
  assert.equal(doc.origin, "CPR");
  assert.equal(doc.terrain.rawBytesPerCell, 2);
  assert.equal(doc.terrain.heightDivisor, CPR_HEIGHT_DIVISOR);
  assert.equal(doc.terrain.heightUnitScale, CPR_HEIGHT_UNIT_SCALE);
  assert.equal(doc.terrain.cellSplit, "checkerboard");
});

test("MTM2: the SIT loader leaves one-byte terrain undeclared", {
  skip: hasStockPod(MTM2_POD) ? false : `no local MTM2 install at ${MTM2_POD}`,
}, () => {
  const { doc } = sitDoc(MTM2_POD);
  assert.equal(doc.terrain.rawBytesPerCell, 1);
  assert.equal(doc.terrain.heightDivisor, null);
  assert.equal(doc.terrain.heightUnitScale, 1);
  assert.equal(doc.terrain.cellSplit, "fixed");
});

/*
  The regression behind the buried Laguna objects.

  CPREDIT and Traxx drop an object onto the ground by lifting its pivot by the model's depth
  below it (Traxx TraxxViewEdit.cpp: height_above_gnd = -basez >> 8), so in any stock SIT the
  altitude minus the ground under it is the model's depth. The scene draws a model at 0.75
  scene units per model unit and a legacy step at heightScale (3) units, so an object rests
  on the ground exactly when lift_in_steps == -minZ / 4. MTM2 always did; CPR read at /4 and
  /64 came out at -minZ / 8, half, which is what put every CPR object halfway underground.
*/
function liftRatios(podPath) {
  const { pod, doc } = sitDoc(podPath);
  const ratios = [];
  for (const box of doc.boxes) {
    const entry = pod.podIndex.entries.find((e) => e.title === box.modelName);
    if (!entry) continue;
    const model = decodeBinModel(pod.getBytes(entry), box.modelName, doc.origin);
    const bounds = model.rawVertexBounds;
    if (!bounds) continue;
    const minZ = bounds.minZ * 65536 / (model.magnifyPower * 64);
    if (minZ > -2) continue;
    const lift = box.position[2] - groundAt(doc.terrain, box.position[0], box.position[1]);
    ratios.push(lift / -minZ);
  }
  return ratios;
}

for (const [label, podPath] of [["MTM2 Alaska", MTM2_OBJECTS_POD], ["CPR Laguna", LAGUNA_POD],
                                ["CPR Detroit", `${process.env.HOME}/games/cpr/DETROIT.POD`]]) {
  test(`${label}: objects rest on the terrain at the scale their models are drawn`, {
    skip: hasStockPod(podPath) ? false : `no local install at ${podPath}`,
  }, () => {
    const ratios = liftRatios(podPath);
    assert.ok(ratios.length > 100, `${ratios.length} objects`);
    const m = median(ratios);
    assert.ok(Math.abs(m - 0.25) < 0.005, `median lift/depth ${m}, want 0.25`);
  });
}

/*
  The road sits a little above the terrain because CPREDIT's "Match ground alt" levels the
  ground to the minimum altitude under the track and banking drops one side below that.
  Against the precise terrain that gap is a median of 2.0 ft (5th-95th +0.5 to +5.4 ft);
  the 4.3 ft once measured was against floored terrain.
*/
test("Laguna: the TRK centreline sits on the precise terrain as documented", { skip: skipLaguna }, () => {
  const doc = lagunaDoc();
  const floored = { ...doc.terrain, heightDivisor: null, heightUnitScale: 1 };
  // One surface per segment, 20 cross-section points each.
  const points = doc.raceTrackSurfaces.flatMap((surface) => surface.points);
  assert.ok(points.length > 1000);

  const preciseFt = [], flooredFt = [];
  let fractional = 0;
  for (const point of points) {
    // The same transform the scene's pointToWorld applies.
    const ex = 2 * Math.trunc(point[0]);
    const ey = 2 * Math.trunc(point[2]);
    const ground = groundAt(doc.terrain, ex, ey);
    if (ground !== Math.floor(ground)) fractional++;
    preciseFt.push(point[1] - ground * LEGACY_ALTITUDE_DIVISOR);
    flooredFt.push(point[1] - groundAt(floored, ex, ey) * CPR_ALTITUDE_DIVISOR);
  }

  assert.ok(fractional > points.length * 0.9, "terrain under the road is fractional");
  const m = median(preciseFt);
  assert.ok(m > 1.2 && m < 2.8, `median gap ${m} ft`);
  assert.ok(median(flooredFt) - m > 1.6, "floored terrain opens the gap");
});
