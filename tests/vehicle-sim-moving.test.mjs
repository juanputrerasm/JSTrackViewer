/*
  A moving object shoves a parked truck out of its way.

  Run with: node --test tests/

  TPARK's train is kinematic: mass 0, a fixed velocity, and nothing can stop it. What the sim
  has to get right is that a contact is judged by RELATIVE velocity. Against static scenery the
  truck's own velocity is enough; against a train it is not, because a parked truck is not
  approaching anything and the train still has to push it.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { createColliders } from "../src/drive/colliders.js";
import { createVehicleSim } from "../src/drive/vehicle-sim.js";

const DT = 1 / 120;
const GRID = 64;
const CELL = 64;

function assembly() {
  const anchors = {
    "faxle.rtire.static_bpos": { x: 4.2917, y: -3.8, z: 6.1 },
    "faxle.ltire.static_bpos": { x: -4.2917, y: -3.8, z: 6.1 },
    "raxle.rtire.static_bpos": { x: 4.2917, y: -3.8, z: -5.5 },
    "raxle.ltire.static_bpos": { x: -4.2917, y: -3.8, z: -5.5 },
  };
  const vertices = [];
  for (const x of [-3.67, 3.67]) for (const y of [-9.2, 9.2]) for (const z of [-2.81, 4.61]) vertices.push({ x, y, z });
  return {
    body: { name: "B", vertices, meshes: [] },
    wheels: Object.entries(anchors).map(([key, position]) => ({ key, position, radius: 3, model: {} })),
    scrapePoints: [
      { x: 0, y: -2.5, z: 9.2 }, { x: 0, y: -2.5, z: -9.2 },
      { x: 3.6, y: -2.5, z: 0 }, { x: -3.6, y: -2.5, z: 0 },
    ],
    restHeight: 6.8, textures: [],
    axles: [], axleBars: [], shocks: [], driveshaft: null, lights: [], warnings: [],
  };
}

test("a moving block pushes a parked truck ahead of it instead of passing through", () => {
  /*
    A wide, model-less type 10 block 10.7 ft tall standing on the 100 ft ground (half height
    8 / 1.5 = 5.33 ft, centre at altitude 52.67 * 2 = 105.33 ft), moving at 30 ft/s along the
    scene's +z. The truck is parked 40 ft ahead of it, square on.
  */
  const block = {
    position: [1200, 1600, 52.67], theta: 0, phi: 0, psi: 0,
    width: 40, length: 16, height: 8, type: 10, mass: 0, modelName: "", bvel: [0, 0, -30],
  };
  const track = {
    terrain: {
      gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1,
      rawData: new Uint8Array(GRID * GRID).fill(50),
    },
    boxes: [block],
    groundBoxes: [],
  };
  const frame = createWorldFrame(track);
  const colliders = createColliders(track, frame);
  const solid = colliders.solids[0];
  const sim = createVehicleSim(assembly(), frame, undefined, colliders);
  const startZ = solid.centre.z + 40;
  sim.reset({ x: solid.centre.x, y: frame.heightAtFeet(solid.centre.x, startZ) + 6.8, z: startZ }, 0);

  let minGap = Infinity;
  for (let i = 0; i < 3 / DT; i++) {
    colliders.step(DT);
    sim.step(DT, { throttle: 0, brake: 0, steer: 0 });
    const state = sim.readState();
    const gap = state.ipos.z - (solid.centre.z + solid.offset.z);
    if (gap < minGap) minGap = gap;
  }

  const state = sim.readState();
  const blockZ = solid.centre.z + solid.offset.z;
  assert.ok(Math.abs(solid.offset.z - 90) < 1e-6, "the block kept its speed");
  // The block's face is 8 ft ahead of its centre and the truck's tail hull point 9.2 ft behind.
  assert.ok(minGap > 8, `the block drove into the truck, centres ${minGap.toFixed(2)} ft apart`);
  assert.ok(state.ipos.z > startZ + 30, `the truck was not pushed along, moved ${(state.ipos.z - startZ).toFixed(1)} ft`);
  assert.ok(state.ipos.z > blockZ, "the truck ended up ahead of the block, not behind it");
});
