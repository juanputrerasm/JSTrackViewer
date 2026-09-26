/*
  The manual gearbox: M in drive mode, A and Z to shift.

  Run with: node --test tests/

  Automatic stays exactly as it was; these pin down what changes in manual. The gearbox holds
  whatever gear the driver picked, however the revs go. Reverse is below first and only
  engages near a standstill. The pedals never swap: the throttle drives in whatever gear is
  selected, reverse included.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { createVehicleSim } from "../src/drive/vehicle-sim.js";

const DT = 1 / 120;
const GRID = 64;
const CELL = 64;

function flatFrame() {
  return createWorldFrame({
    terrain: {
      gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1,
      rawData: new Uint8Array(GRID * GRID).fill(50),
    },
  });
}

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
    scrapePoints: [], restHeight: 6.8, textures: [],
    axles: [], axleBars: [], shocks: [], driveshaft: null, lights: [], warnings: [],
  };
}

function settled() {
  const frame = flatFrame();
  const sim = createVehicleSim(assembly(), frame);
  const ground = frame.heightAtFeet(600, 600);
  sim.reset({ x: 600, y: ground + 6.8, z: 600 }, 0);
  for (let i = 0; i < 1 / DT; i++) sim.step(DT, { throttle: 0, brake: 0, steer: 0 });
  return { sim, ground, start: sim.readState().ipos };
}

function run(sim, seconds, input) {
  for (let i = 0; i < Math.round(seconds / DT); i++) sim.step(DT, input);
  return sim.readState();
}


test("manual holds its gear where the automatic would shift up", () => {
  const auto = settled().sim;
  const autoState = run(auto, 6, { throttle: 1, brake: 0, steer: 0 });
  assert.ok(autoState.gear > 1, `the automatic should have shifted, gear ${autoState.gear}`);

  const { sim } = settled();
  sim.setManual(true);
  const state = run(sim, 6, { throttle: 1, brake: 0, steer: 0 });
  assert.equal(state.gear, 1, "manual must stay in the gear it was left in");
  assert.ok(state.speed < autoState.speed, "first gear alone should top out slower");
});

test("A and Z step one gear at a time, within the gearbox", () => {
  const { sim } = settled();
  sim.setManual(true);
  run(sim, 2, { throttle: 1, brake: 0, steer: 0 });
  assert.equal(sim.shiftUp(), true);
  assert.equal(sim.readState().gear, 2);
  for (let i = 0; i < 20; i++) sim.shiftUp();
  const top = sim.readState().gear;
  assert.ok(top >= 3, `top gear ${top}`);
  assert.equal(sim.shiftUp(), false, "no gear above top");
  sim.shiftDown();
  assert.equal(sim.readState().gear, top - 1);
});

test("reverse is below first, only near a standstill, and driven on the throttle", () => {
  const { sim } = settled();
  sim.setManual(true);

  // Rolling forward, shifting down from first does nothing.
  run(sim, 2, { throttle: 1, brake: 0, steer: 0 });
  assert.equal(sim.shiftDown(), false, "no reverse at speed");
  assert.equal(sim.readState().gear, 1);

  // Stopped, it selects reverse, and the brake held at rest does NOT swap into it on its own.
  for (let i = 0; i < 6 / DT && sim.readState().speed > 0.5; i++) sim.step(DT, { throttle: 0, brake: 1, steer: 0 });
  run(sim, 1, { throttle: 0, brake: 1, steer: 0 });
  assert.equal(sim.readState().gear, 1, "manual must not engage reverse by itself");
  const here = sim.readState().ipos;
  assert.equal(sim.shiftDown(), true);
  assert.equal(sim.readState().gear, -1);

  // The throttle backs it up: psi 0 faces -z, so backwards is +z.
  const state = run(sim, 3, { throttle: 1, brake: 0, steer: 0 });
  assert.ok(state.ipos.z > here.z + 3, `should back up on the throttle, moved ${(state.ipos.z - here.z).toFixed(1)} ft`);

  // Up out of reverse goes to first.
  sim.shiftUp();
  assert.equal(sim.readState().gear, 1);
});

test("switching back to automatic lets the gearbox choose again", () => {
  const { sim } = settled();
  sim.setManual(true);
  run(sim, 4, { throttle: 1, brake: 0, steer: 0 });
  assert.equal(sim.readState().gear, 1);
  sim.setManual(false);
  const state = run(sim, 3, { throttle: 1, brake: 0, steer: 0 });
  assert.ok(state.gear > 1, `automatic should shift up again, gear ${state.gear}`);
});
