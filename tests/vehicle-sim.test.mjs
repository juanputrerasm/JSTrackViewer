/*
  Tests for the truck simulation.

  Run with: node --test tests/

  Hermetic: a synthetic heightfield and a synthetic truck built from BIGFOOT's measured
  geometry (anchors at +-4.292, y -3.8, z +6.1 / -5.5, with 3.00 ft wheels). No POD and no
  renderer, which is the point of keeping the sim free of Three.js.

  These check behaviour that follows from physics rather than from the parameter values, so
  they stay valid when the feel-alike numbers are later replaced by measured ones: a parked
  truck must not drift, a spring must settle where its rate says it will, a truck on a slope
  must roll downhill, and throttle must accelerate it.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { createVehicleSim } from "../src/drive/vehicle-sim.js";
import { GRAVITY, MTM2_FEEL } from "../src/drive/params/mtm2-feel.js";

const GRID = 8;
const CELL = 64;
const FLAT_STEPS = 50; // 100 ft of ground, well clear of zero

/** A world frame over a heightfield built from a (cx, cz) -> steps function. */
function frameFrom(fn) {
  const raw = new Uint8Array(GRID * GRID);
  for (let cz = 0; cz < GRID; cz++) {
    for (let cx = 0; cx < GRID; cx++) raw[cx + cz * GRID] = fn(cx, cz);
  }
  return createWorldFrame({
    terrain: { gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1, rawData: raw },
  });
}

/** BIGFOOT's measured geometry, as the loader would hand it over. */
function bigfootAssembly() {
  const anchors = {
    "faxle.rtire.static_bpos": { x: 4.291666, y: -3.8, z: 6.1 },
    "faxle.ltire.static_bpos": { x: -4.291666, y: -3.8, z: 6.1 },
    "raxle.rtire.static_bpos": { x: 4.291666, y: -3.8, z: -5.5 },
    "raxle.ltire.static_bpos": { x: -4.291666, y: -3.8, z: -5.5 },
  };
  // A body box of BIGFOOT's measured spans, in the decoder's axes (x lateral, y long, z up).
  const vertices = [];
  for (const x of [-3.67, 3.67]) {
    for (const y of [-9.2, 9.2]) {
      for (const z of [-3.16, 5.23]) vertices.push({ x, y, z });
    }
  }
  return {
    truckName: "Bigfoot",
    body: { name: "BIGFOOT.BIN", vertices, meshes: [] },
    wheels: Object.entries(anchors).map(([key, position]) => ({ key, position, radius: 3.0, model: {} })),
    scrapePoints: [
      { x: 0, y: -2.5, z: 9.2 }, { x: 0, y: -2.5, z: -9.2 },
      { x: 3.6, y: -2.5, z: 0 }, { x: -3.6, y: -2.5, z: 0 },
    ],
    restHeight: 6.8,
    textures: [],
    axles: [], axleBars: [], shocks: [], driveshaft: null, lights: [], warnings: [],
  };
}

const NO_INPUT = { throttle: 0, brake: 0, steer: 0 };
const DT = 1 / 120;

/** Run the sim for `seconds`, with one input throughout. */
function run(sim, seconds, input = NO_INPUT) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) sim.step(DT, input);
  return sim.readState();
}

function settledSim(frame, extraHeight = 0) {
  const sim = createVehicleSim(bigfootAssembly(), frame);
  const ground = frame.heightAtFeet(200, 200);
  sim.reset({ x: 200, y: ground + 6.8 + extraHeight, z: 200 }, 0);
  return { sim, ground };
}

test("a parked truck settles and stays put", () => {
  const frame = frameFrom(() => FLAT_STEPS);
  const { sim, ground } = settledSim(frame);
  const state = run(sim, 4);

  assert.ok(state.speed < 0.15, `still moving at ${state.speed.toFixed(3)} ft/s`);
  // It sits below its geometric rest height, because the springs carry the weight.
  assert.ok(state.ipos.y < ground + 6.8, "should sag under its own weight");
  assert.ok(state.ipos.y > ground + 3.0, `sank too far: ${(state.ipos.y - ground).toFixed(2)} ft`);
  assert.ok(state.wheels.every((w) => w.on_gnd), "every wheel should be on the ground");
});

test("static sag matches the spring rate it was given", () => {
  /*
    Each corner carries a quarter of the weight, so x = mg / 4k. This is the check that the
    suspension is wired up the way the parameters claim, and it is what makes those numbers
    replaceable by measured ones later: change spring_rate and the truck must sit accordingly.
  */
  const frame = frameFrom(() => FLAT_STEPS);
  const { sim } = settledSim(frame);
  run(sim, 5);

  const mass = MTM2_FEEL.chassis.mass;
  const front = MTM2_FEEL.suspension.front.spring_rate;
  const rear = MTM2_FEEL.suspension.rear.spring_rate;
  const expectedFront = (mass * GRAVITY / 4) / front;
  const expectedRear = (mass * GRAVITY / 4) / rear;

  const state = sim.readState();
  const frontWheel = state.wheels.find((w) => w.key.startsWith("faxle"));
  const rearWheel = state.wheels.find((w) => w.key.startsWith("raxle"));

  // Loose: weight is not exactly quartered once the CG is off centre, and the tolerance is
  // what says "this is the same mechanism", not "this is the same number".
  assert.ok(Math.abs(frontWheel.compression - expectedFront) < 0.35,
    `front sag ${frontWheel.compression.toFixed(3)} vs expected ${expectedFront.toFixed(3)}`);
  assert.ok(Math.abs(rearWheel.compression - expectedRear) < 0.35,
    `rear sag ${rearWheel.compression.toFixed(3)} vs expected ${expectedRear.toFixed(3)}`);
});

test("a parked truck does not drift across flat ground", () => {
  const frame = frameFrom(() => FLAT_STEPS);
  const { sim } = settledSim(frame);
  run(sim, 6);
  const state = sim.readState();
  const drift = Math.hypot(state.ipos.x - 200, state.ipos.z - 200);
  assert.ok(drift < 1.0, `drifted ${drift.toFixed(2)} ft with no input`);
});

test("a dropped truck bounces once and settles rather than exploding", () => {
  const frame = frameFrom(() => FLAT_STEPS);
  const { sim, ground } = settledSim(frame, 4);

  let highestAfterLanding = -Infinity;
  let landed = false;
  const steps = Math.round(6 / DT);
  for (let i = 0; i < steps; i++) {
    sim.step(DT, NO_INPUT);
    const s = sim.readState();
    if (!landed && s.wheels.every((w) => w.on_gnd)) landed = true;
    if (landed) highestAfterLanding = Math.max(highestAfterLanding, s.ipos.y);
  }

  const state = sim.readState();
  assert.ok(landed, "should have landed");
  assert.ok(Number.isFinite(state.ipos.y), "position went non-finite");
  // A damped spring may overshoot, but a 4 ft drop must not throw it back higher than it began.
  assert.ok(highestAfterLanding < ground + 6.8 + 4, `bounced back to ${(highestAfterLanding - ground).toFixed(2)} ft`);
  assert.ok(state.speed < 0.5, `never settled, still ${state.speed.toFixed(2)} ft/s`);
});

test("a truck pointing down a slope rolls down it", () => {
  /*
    Three steps of rise per cell toward +x: 6 ft over 32 ft, a 10.6 degree grade, so the fall
    line runs toward -x.

    The truck has to POINT down it. Forward is (sin psi, 0, -cos psi), so psi = -pi/2 faces
    -x. That matters because the only thing free to move a truck under gravity is its wheels
    rolling: across the slope the tires simply grip, which the next test pins down.

    The grade has to beat engine braking, which is why it is not the gentler slope used
    below. A truck sits in gear with the engine connected through about 19.5:1, worth roughly
    510 lbf at the wheels, while a 3.58 degree grade only pulls with 624 lbf: enough to inch
    forward, not enough to roll away. At 10.6 degrees gravity pulls with about 1,840 lbf and
    the truck rolls, which is the behaviour being tested.
  */
  const frame = frameFrom((cx) => FLAT_STEPS + cx * 3);
  const sim = createVehicleSim(bigfootAssembly(), frame);
  const ground = frame.heightAtFeet(200, 200);
  sim.reset({ x: 200, y: ground + 6.8, z: 200 }, -Math.PI / 2);

  const state = run(sim, 4);
  assert.ok(state.ipos.x < 200 - 1, `did not roll downhill: x moved to ${state.ipos.x.toFixed(2)}`);
  assert.ok(state.ipos.y < ground + 6.8, "should have descended");
  // Downhill, not sideways off the fall line.
  assert.ok(Math.abs(state.ipos.z - 200) < Math.abs(state.ipos.x - 200), "should mostly travel down the fall line");
});

test("a truck parked across a shallow slope grips instead of sliding", () => {
  /*
    The converse, and the reason the test above has to aim the truck.

    Sideways on a 3.58 degree grade, gravity pulls with 0.063 of the truck's weight while the
    tires can hold 1.0 of it, so it stays put. A truck that slides here means the lateral tire
    model has lost its grip, which would show up in the game as a truck that cannot park on a
    hill.
  */
  const frame = frameFrom((cx) => FLAT_STEPS + cx);
  const sim = createVehicleSim(bigfootAssembly(), frame);
  const ground = frame.heightAtFeet(200, 200);
  sim.reset({ x: 200, y: ground + 6.8, z: 200 }, 0);

  const state = run(sim, 4);
  assert.ok(Math.abs(state.ipos.x - 200) < 1, `slid down the slope by ${(200 - state.ipos.x).toFixed(2)} ft`);
  /*
    And it must not creep along its own axis either. A closed throttle used to apply the
    engine's friction as negative DRIVE torque, which turned the wheels backwards and drove
    the truck at a steady 0.34 ft/s; this is the regression guard for that.
  */
  assert.ok(Math.abs(state.ipos.z - 200) < 0.5, `crept ${(state.ipos.z - 200).toFixed(2)} ft with no throttle`);
  assert.ok(state.speed < 0.2, `never came to rest: ${state.speed.toFixed(3)} ft/s`);
});

test("throttle accelerates the truck and the brake stops it", () => {
  const frame = frameFrom(() => FLAT_STEPS);
  const { sim } = settledSim(frame);
  run(sim, 1);

  const accelerated = run(sim, 4, { throttle: 1, brake: 0, steer: 0 });
  assert.ok(accelerated.speed > 8, `only reached ${accelerated.speed.toFixed(2)} ft/s at full throttle`);
  // A truck facing psi 0 drives toward -z.
  assert.ok(accelerated.ipos.z < 200, `moved the wrong way: z ${accelerated.ipos.z.toFixed(2)}`);

  /*
    Braking is measured by whether the truck STOPS, not by where it ends up.

    Holding the brake past a standstill now selects reverse, as MTM2 does, so a truck that
    braked perfectly well is moving again a second later. Asserting on the final speed made
    this test fail for the one behaviour it was not about.
  */
  let stopped = false;
  for (let i = 0; i < 5 / DT; i++) {
    sim.step(DT, { throttle: 0, brake: 1, steer: 0 });
    if (sim.readState().speed < 2) { stopped = true; break; }
  }
  assert.ok(stopped, `brakes did little: still ${sim.readState().speed.toFixed(2)} ft/s from ${accelerated.speed.toFixed(2)}`);
});

test("steering yaws the truck, and the two directions are mirrored", () => {
  const frame = frameFrom(() => FLAT_STEPS);

  const yawAfterSteer = (steer) => {
    const { sim } = settledSim(frame);
    run(sim, 1);
    run(sim, 2, { throttle: 0.6, brake: 0, steer: 0 });
    const before = sim.readState().psi;
    const after = run(sim, 3, { throttle: 0.6, brake: 0, steer }).psi;
    return Math.atan2(Math.sin(after - before), Math.cos(after - before));
  };

  const left = yawAfterSteer(-1);
  const right = yawAfterSteer(1);
  assert.ok(Math.abs(left) > 0.05, `steering did nothing: ${left.toFixed(3)} rad`);
  assert.ok(Math.sign(left) !== Math.sign(right), "the two lock directions should yaw opposite ways");
  assert.ok(Math.abs(Math.abs(left) - Math.abs(right)) < Math.abs(left) * 0.5, "left and right should be near mirrors");
});

test("the airborne flag follows ground contact", () => {
  const frame = frameFrom(() => FLAT_STEPS);
  const { sim } = settledSim(frame, 15);
  const early = sim.readState();
  assert.equal(early.airborne, false, "not stepped yet, so nothing is known");

  sim.step(DT, NO_INPUT);
  assert.equal(sim.readState().airborne, true, "15 ft up should be airborne");

  run(sim, 5);
  assert.equal(sim.readState().airborne, false, "should be back on the ground");
});

test("a truck on its roof is counted, not righted", () => {
  /*
    MTM2 leaves a rolled truck lying there and returns it to the course after a couple of
    seconds. Nothing flips it upright where it lies, so the simulation only counts the time and
    drive mode does the putting back at 2.5 s.
  */
  const frame = frameFrom(() => 50);
  const sim = createVehicleSim(bigfootAssembly(), frame, undefined, null);
  const ground = frame.heightAtFeet(600, 600);

  sim.reset({ x: 600, y: ground + 6.8, z: 600 }, 0);
  for (let i = 0; i < 60; i++) sim.step(1 / 120, { throttle: 0, brake: 0, steer: 0 });
  assert.equal(sim.readState().invertedFor, 0, "upright, so nothing to count");

  // Put it down on its roof and leave it alone.
  sim.reset({ x: 600, y: ground + 6.8, z: 600 }, 0, Math.PI);
  for (let i = 0; i < 120; i++) sim.step(1 / 120, { throttle: 0, brake: 0, steer: 0 });
  const rolled = sim.readState();
  assert.ok(rolled.invertedFor > 0.9,
    `should have counted about a second on its roof, counted ${rolled.invertedFor.toFixed(2)}s`);

  // And it must NOT have righted itself.
  const up = { x: 0, y: 1, z: 0 };
  const q = sim.orientation;
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  assert.ok(upY < 0, `the truck turned itself back over, up.y is ${upY.toFixed(2)}`);
});
