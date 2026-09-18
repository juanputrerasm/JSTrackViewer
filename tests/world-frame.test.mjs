/*
  Tests for the physics/scene bridge.

  Run with: node --test tests/

  These are deliberately hermetic: a hand-built 4x4 heightfield rather than a stock POD, so a
  failure points at the conversion rather than at track data. The one real-world case is
  SUMMIT1's start grid, whose numbers came out of scratchpad/calib.py.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createWorldFrame, UNITS_PER_FOOT_H, UNITS_PER_FOOT_V, FEET_PER_HEIGHT_STEP } from "../src/drive/world-frame.js";

const CELL = 64;
const GRID = 4;

/** A 4x4 grid, one byte per cell, from a (cx, cz) -> steps function. */
function frameFromHeights(fn, overrides = {}) {
  const raw = new Uint8Array(GRID * GRID);
  for (let cz = 0; cz < GRID; cz++) {
    for (let cx = 0; cx < GRID; cx++) raw[cx + cz * GRID] = fn(cx, cz);
  }
  return createWorldFrame({
    terrain: {
      gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1,
      rawData: raw, ...overrides,
    },
  });
}

/** Feet coordinates of grid corner (cx, cz), the inverse of the builder's layout. */
function cornerFeet(cx, cz) {
  return {
    x: cx * CELL / UNITS_PER_FOOT_H,
    z: (GRID - cz) * CELL / UNITS_PER_FOOT_H,
  };
}

test("a height step is 2 ft, so heights come back as feet", () => {
  const frame = frameFromHeights(() => 50);
  const { x, z } = cornerFeet(1, 1);
  assert.equal(frame.heightAtFeet(x, z), 50 * FEET_PER_HEIGHT_STEP);
  assert.equal(FEET_PER_HEIGHT_STEP, 3 / UNITS_PER_FOOT_V * 1); // heightScale 3 over 1.5 units/ft
});

test("cell corners return their own sample", () => {
  // Distinct heights so a mixed-up index cannot pass by coincidence.
  const frame = frameFromHeights((cx, cz) => 10 + cx + cz * 10);
  for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [2, 3], [3, 3]]) {
    const { x, z } = cornerFeet(cx, cz);
    assert.equal(
      frame.heightAtFeet(x, z),
      (10 + cx + cz * 10) * FEET_PER_HEIGHT_STEP,
      `corner ${cx},${cz}`
    );
  }
});

test("interpolation follows the mesh diagonal rather than being bilinear", () => {
  /*
    One corner raised. The mesh splits each cell from (cx,cz) to (cx+1,cz+1), so the two
    halves are not symmetric and a bilinear reading is wrong on both of them.

    Cell (0,0) has h00 = h10 = h01 = 0 and h11 = 10 steps.
  */
  const frame = frameFromHeights((cx, cz) => (cx === 1 && cz === 1 ? 10 : 0));
  const base = cornerFeet(0, 0);
  const cellFt = CELL / UNITS_PER_FOOT_H;

  // A point at u = 0.75, w = 0.25: u >= w, the first triangle (v0,v1,v2).
  // h = h00 + (h10-h00)*u + (h11-h10)*w = 0 + 0 + 10*0.25 = 2.5 steps.
  const pA = { x: base.x + 0.75 * cellFt, z: base.z - 0.25 * cellFt };
  assert.equal(frame.heightAtFeet(pA.x, pA.z), 2.5 * FEET_PER_HEIGHT_STEP);

  // Mirrored point at u = 0.25, w = 0.75: the second triangle (v0,v2,v3).
  // h = h00 + (h11-h01)*u + (h01-h00)*w = 10*0.25 = 2.5 steps. Same value, different triangle.
  const pB = { x: base.x + 0.25 * cellFt, z: base.z - 0.75 * cellFt };
  assert.equal(frame.heightAtFeet(pB.x, pB.z), 2.5 * FEET_PER_HEIGHT_STEP);

  // Bilinear would give u*w*10 = 1.875 and 1.875 steps at those points. Confirm we differ,
  // which is the whole point of matching the diagonal.
  const bilinear = 0.75 * 0.25 * 10 * FEET_PER_HEIGHT_STEP;
  assert.notEqual(frame.heightAtFeet(pA.x, pA.z), bilinear);
});

test("flat ground has a straight up normal", () => {
  const frame = frameFromHeights(() => 42);
  const n = frame.normalAtFeet(100, 100);
  // Tolerance rather than equality: a zero slope negates to -0, which is the right number
  // and not strictly equal to 0.
  assert.ok(Math.abs(n.x) < 1e-12, `nx ${n.x}`);
  assert.equal(n.y, 1);
  assert.ok(Math.abs(n.z) < 1e-12, `nz ${n.z}`);
});

test("a constant slope gives the analytic normal", () => {
  // Rising one step per cell toward +x: 2 ft over a 32 ft cell.
  const frame = frameFromHeights((cx) => 10 + cx);
  const { x, z } = cornerFeet(1, 1);
  const n = frame.normalAtFeet(x + 1, z - 1);
  const slope = FEET_PER_HEIGHT_STEP / (CELL / UNITS_PER_FOOT_H); // 2 ft per 32 ft
  const expected = { x: -slope, y: 1, z: 0 };
  const len = Math.hypot(expected.x, expected.y, expected.z);
  assert.ok(Math.abs(n.x - expected.x / len) < 1e-12, `nx ${n.x}`);
  assert.ok(Math.abs(n.y - expected.y / len) < 1e-12, `ny ${n.y}`);
  assert.ok(Math.abs(n.z) < 1e-12, `nz ${n.z}`);
  // Uphill is +x, so the normal leans the other way.
  assert.ok(n.x < 0);
});

test("scene conversion is anisotropic and round-trips", () => {
  const frame = frameFromHeights(() => 0);
  const scene = frame.toScene(10, 10, 10);
  assert.equal(scene.x, 20);
  assert.equal(scene.y, 15);
  assert.equal(scene.z, 20);
  assert.equal(UNITS_PER_FOOT_V / UNITS_PER_FOOT_H, 0.75); // TRAXX_Z_STRETCH

  const back = frame.toFeet(scene.x, scene.y, scene.z);
  assert.equal(back.x, 10);
  assert.equal(back.y, 10);
  assert.equal(back.z, 10);
});

test("editor records convert to feet, checked against SUMMIT1's start grid", () => {
  /*
    From scratchpad/calib.py on SUMMIT1.POD: BIGFOOT's slot parses to editor (8085, 6767)
    with altitude 53 steps, and the raw SIT line is "4042.7,106.0,3383.3".

    Editor x is 2 * the SIT foot value, so it converts straight back. The altitude is the
    check that matters: 53 steps must come back as the 106 ft the file states.
  */
  const frame = createWorldFrame({
    terrain: { gridSize: 256, cellSize: 64, heightScale: 3, rawBytesPerCell: 1, rawData: new Uint8Array(256 * 256) },
  });
  const p = frame.editorToFeet([8085, 6767, 53]);
  assert.ok(Math.abs(p.x - 4042.5) < 0.5, `x ${p.x}`);
  assert.equal(p.y, 106);
  // Z is flipped about the world, which is 16384 units, i.e. 8192 ft.
  assert.equal(p.z, (16384 - 6767) / UNITS_PER_FOOT_H);
  assert.equal(frame.worldSizeFeet, 8192);
  assert.equal(frame.cellSizeFeet, 32);
});

test("heading matches the start grid convention", () => {
  const frame = frameFromHeights(() => 0);
  // psi 0 faces scene -Z, the same forward _buildTrucks uses for its grid arrows.
  const f0 = frame.headingToForward(0);
  assert.ok(Math.abs(f0.x) < 1e-12);
  assert.equal(f0.z, -1);

  const f90 = frame.headingToForward(Math.PI / 2);
  assert.ok(Math.abs(f90.x - 1) < 1e-12);
  assert.ok(Math.abs(f90.z) < 1e-12);
});

test("a track with no heightfield stays flat instead of throwing", () => {
  const frame = createWorldFrame({ terrain: null });
  assert.equal(frame.hasTerrain, false);
  assert.equal(frame.heightAtFeet(123, 456), 0);
  assert.deepEqual(frame.normalAtFeet(123, 456), { x: 0, y: 1, z: 0 });
});

test("a truck is drawn on what it stands on, not on the terrain below it", () => {
  /*
    The bug this pins down, seen on TPARK's ground box bridge: a truck standing on a deck 190 ft
    up, over a gully whose terrain is at 165, was drawn eight feet above the deck and appeared to
    leap upward as the ground fell away beneath the bridge.

    The scene is anisotropic (2 units per foot across, 1.5 up) and the truck is drawn true, so
    its height is measured from its contact point. Give it the terrain when it is standing on a
    box and it floats by the difference times the gap between the two scales.
  */
  const frame = createWorldFrame({ terrain: null });
  const DECK = 190;
  const TERRAIN = 165;
  const truck = { x: 100, y: DECK + 6, z: 100 };     // a truck rides about 6 ft up

  const onDeck = frame.toSceneTruckPosition(truck, DECK);
  const wheelsOnDeck = onDeck.y - 6 * 2;             // the truck is drawn at 2 units per foot
  assert.ok(Math.abs(wheelsOnDeck - DECK * 1.5) < 1e-9,
    `wheels at ${wheelsOnDeck}, deck drawn at ${DECK * 1.5}`);

  const onTerrain = frame.toSceneTruckPosition(truck, TERRAIN);
  const float = (onTerrain.y - 6 * 2 - DECK * 1.5) / 2;   // in feet
  assert.ok(float > 4,
    `measuring from the terrain should float the truck well above the deck, got ${float.toFixed(1)} ft`);
});
