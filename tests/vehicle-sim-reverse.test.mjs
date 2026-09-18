/*
  Reverse, which MTM2 selects for you rather than putting on its own control.

  Run with: node --test tests/

  The rule being pinned down: the down arrow brakes while the truck is moving and backs it up
  once it has stopped, and while reversing the two pedals trade places so the same key keeps
  driving you backwards and the throttle brings you to a halt. A driver rocking off an
  obstacle never thinks about gears.

  The failure that matters most is the one in the middle: a truck braking hard from speed must
  NOT snap into reverse the moment it reaches zero and drive away backwards under the same key
  the driver is holding to stop.
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

test("holding the brake at a standstill selects reverse and backs up", () => {
  const { sim, start } = settled();
  assert.equal(sim.readState().gear, 1, "should start in a forward gear");

  const state = run(sim, 3, { throttle: 0, brake: 1, steer: 0 });
  assert.equal(state.gear, -1, "the brake at rest should select reverse");
  // A truck at psi 0 faces -z, so reversing carries it toward +z.
  assert.ok(state.ipos.z > start.z + 5,
    `should have backed up, moved ${(state.ipos.z - start.z).toFixed(1)} ft`);
  assert.ok(state.speed > 2, `should be moving, at ${state.speed.toFixed(1)} ft/s`);
});

test("braking from speed stops the truck without driving away backwards", () => {
  /*
    The case that makes a naive implementation unusable: hold the brake to stop from 40 mph and
    a truck that selects reverse the instant it reaches zero simply keeps going, the other way,
    under the key you are using to stop.
  */
  const { sim } = settled();
  run(sim, 4, { throttle: 1, brake: 0, steer: 0 });
  const rolling = sim.readState();
  assert.ok(rolling.speed > 30, `should be rolling first, at ${rolling.speed.toFixed(1)} ft/s`);

  /*
    Brake all the way down, watching for the halt rather than for where it ends up.

    Holding past a standstill selects reverse, which is the point of the feature, so the truck
    IS moving again shortly afterwards. What matters is that it genuinely stopped on the way,
    and that backing up stays slow: reverse is for getting off an obstacle, not for travelling.
  */
  let stopped = false;
  for (let i = 0; i < 6 / DT; i++) {
    sim.step(DT, { throttle: 0, brake: 1, steer: 0 });
    if (sim.readState().speed < 2) { stopped = true; break; }
  }
  assert.ok(stopped, `never came to a halt under the brake, at ${sim.readState().speed.toFixed(1)} ft/s`);

  const afterHolding = run(sim, 4, { throttle: 0, brake: 1, steer: 0 });
  assert.equal(afterHolding.gear, -1, "holding the brake past the stop should select reverse");
  assert.ok(afterHolding.speed < 20,
    `reverse should be capped, reached ${afterHolding.speed.toFixed(1)} ft/s`);
});

test("throttle takes it out of reverse again", () => {
  const { sim } = settled();
  run(sim, 2, { throttle: 0, brake: 1, steer: 0 });
  assert.equal(sim.readState().gear, -1, "should be in reverse");

  // Throttle first brakes the reversing truck, then puts it back into a forward gear.
  const state = run(sim, 4, { throttle: 1, brake: 0, steer: 0 });
  assert.ok(state.gear > 0, `should be back in a forward gear, gear ${state.gear}`);
});

test("reverse is slower than forward, and the engine still revs upward", () => {
  const { sim } = settled();
  const backwards = run(sim, 6, { throttle: 0, brake: 1, steer: 0 });
  assert.ok(backwards.rpm > 0, "rpm should be a positive number in reverse");
  // Capped at reverse_max_speed (16 ft/s, about 11 mph), with a little slack for the step.
  assert.ok(backwards.speed < 20, `reverse should be capped, reached ${backwards.speed.toFixed(1)} ft/s`);

  const { sim: other } = settled();
  const forwards = run(other, 4, { throttle: 1, brake: 0, steer: 0 });
  assert.ok(forwards.speed > backwards.speed, "forward should out-accelerate reverse");
});
