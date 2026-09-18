/*
  The sim must not lose the truck.

  Run with: node --test tests/

  These are not about feel, they are about the guarantees the rest of drive mode leans on: the
  truck stays above the terrain, a crash settles instead of launching, and the state never goes
  non-finite. The renderer and the cameras both filter the truck's position, so a single bad
  value does not cause one bad frame, it strands the view until the page is reloaded.

  Reported from the first drive-mode recording: "crashes or turnovers became very violent and
  often clipping the base terrain, which never happens in MTM2".
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { createVehicleSim } from "../src/drive/vehicle-sim.js";

const DT = 1 / 120;
const GRID = 16;
const CELL = 64;

function frameFrom(fn) {
  const raw = new Uint8Array(GRID * GRID);
  for (let cz = 0; cz < GRID; cz++) {
    for (let cx = 0; cx < GRID; cx++) raw[cx + cz * GRID] = fn(cx, cz);
  }
  return createWorldFrame({
    terrain: { gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1, rawData: raw },
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
    // A real hull, because the body is what lands in a rollover.
    scrapePoints: [
      { x: 0, y: -2.5, z: 9.2 }, { x: 0, y: -2.5, z: -9.2 },
      { x: 3.6, y: -2.5, z: 0 }, { x: -3.6, y: -2.5, z: 0 },
      { x: 3.6, y: 4.6, z: 0 }, { x: -3.6, y: 4.6, z: 0 },
    ],
    restHeight: 6.8, textures: [],
    axles: [], axleBars: [], shocks: [], driveshaft: null, lights: [], warnings: [],
  };
}

/*
  How far past its travel any wheel has been pushed. Zero means the suspension is doing its
  job and nothing is through the ground.

  Measuring the body origin against a fixed 6.8 ft rest height, which is the obvious thing to
  try, does not work: 6.8 ft is the UNLOADED height, and a truck carrying its own weight sits
  about 0.77 ft lower, so that ruler reports three quarters of a foot of "penetration" for a
  perfectly parked truck and more during a landing. It measures suspension travel and calls it
  clipping. Chasing that number would mean stiffening the springs until the truck rode on
  nothing.

  Compression past maxcompr is the real thing: the spring is fully stacked, so anything
  further is the axle travelling through the terrain, and it is exactly what liftOutOfGround
  exists to prevent.
*/
function overTravel(sim) {
  const travel = MAX_TRAVEL;
  let worst = 0;
  for (const wheel of sim.readState().wheels) {
    const excess = wheel.compression - travel;
    if (excess > worst) worst = excess;
  }
  return worst;
}

function rotate(q, v) {
  const t = {
    x: 2 * (q.y * v.z - q.z * v.y),
    y: 2 * (q.z * v.x - q.x * v.z),
    z: 2 * (q.x * v.y - q.y * v.x),
  };
  return {
    x: v.x + q.w * t.x + q.y * t.z - q.z * t.y,
    y: v.y + q.w * t.y + q.z * t.x - q.x * t.z,
    z: v.z + q.w * t.z + q.x * t.y - q.y * t.x,
  };
}

/** Matches params.suspension.*.maxcompr, which both axles share. */
const MAX_TRAVEL = 1.6;

test("a truck dropped from a height does not end up under the terrain", () => {
  const frame = frameFrom(() => 50);
  const sim = createVehicleSim(assembly(), frame);
  const ground = frame.heightAtFeet(400, 400);
  sim.reset({ x: 400, y: ground + 60, z: 400 }, 0);

  let worst = 0;
  let lowest = Infinity;
  for (let i = 0; i < 6 / DT; i++) {
    sim.step(DT, { throttle: 0, brake: 0, steer: 0 });
    worst = Math.max(worst, overTravel(sim));
    lowest = Math.min(lowest, sim.readState().ipos.y);
  }
  assert.ok(worst < 0.05, `suspension was driven ${worst.toFixed(2)} ft past full travel`);
  assert.ok(lowest > ground, `the body passed through the terrain, down to ${(lowest - ground).toFixed(2)} ft`);

  const state = sim.readState();
  assert.ok(state.speed < 2, `never settled after landing: ${state.speed.toFixed(2)} ft/s`);
  // And it settles at its loaded ride height, not on the bump stops.
  assert.ok(state.ipos.y - ground > 5.5 && state.ipos.y - ground < 6.8,
    `settled at ${(state.ipos.y - ground).toFixed(2)} ft, outside the expected sag band`);
});

test("a truck driven into a hill at speed stays above it", () => {
  /*
    A wall of terrain rising four steps a cell, driven into at full throttle. This is the case
    that used to punch through: at speed a single step carries the truck more than a foot, so
    the penalty spring is answering a penetration that already happened.
  */
  const frame = frameFrom((cx) => (cx < 8 ? 50 : 50 + (cx - 8) * 4));
  const sim = createVehicleSim(assembly(), frame);
  const ground = frame.heightAtFeet(200, 400);
  sim.reset({ x: 200, y: ground + 6.8, z: 400 }, Math.PI / 2); // facing +x, into the hill

  let worst = 0;
  let deepest = 0;
  for (let i = 0; i < 12 / DT; i++) {
    sim.step(DT, { throttle: 1, brake: 0, steer: 0 });
    worst = Math.max(worst, overTravel(sim));
    const state = sim.readState();
    const under = frame.heightAtFeet(state.ipos.x, state.ipos.z) - state.ipos.y;
    if (under > deepest) deepest = under;
  }
  assert.ok(worst < 0.05, `suspension was driven ${worst.toFixed(2)} ft past full travel`);
  assert.ok(deepest <= 0, `the body origin went ${deepest.toFixed(2)} ft below the hillside`);
});

test("wheels meet a steep hillside before their hubs enter it", () => {
  const frame = frameFrom((cx) => 50 + Math.max(0, cx - 7) * 12);
  const truck = assembly();
  const sim = createVehicleSim(truck, frame);
  sim.reset({ x: 180, y: frame.heightAtFeet(180, 400) + 6.8, z: 400 }, Math.PI / 2);
  let worst = 0;
  for (let i = 0; i < 8 / DT; i++) {
    sim.step(DT, { throttle: 1, brake: 0, steer: 0 });
    const body = sim.readState().ipos;
    for (const wheel of truck.wheels) {
      const anchor = rotate(sim.orientation, {
        x: wheel.position.x, y: wheel.position.y, z: -wheel.position.z,
      });
      const x = body.x + anchor.x, z = body.z + anchor.z, y = body.y + anchor.y;
      const normal = frame.normalAtFeet(x, z);
      if (normal.y >= 0.8) continue;
      const distance = (y - frame.heightAtFeet(x, z)) * normal.y;
      worst = Math.max(worst, wheel.radius - MAX_TRAVEL - distance);
    }
  }
  assert.ok(worst < 0.4, `wheel hub sank ${worst.toFixed(2)} ft past full travel into the slope`);
});

test("a violent landing settles instead of launching", () => {
  const frame = frameFrom(() => 50);
  const sim = createVehicleSim(assembly(), frame);
  const ground = frame.heightAtFeet(400, 400);
  sim.reset({ x: 400, y: ground + 40, z: 400 }, 0);

  // Let it land.
  let landed = -1;
  for (let i = 0; i < 4 / DT; i++) {
    sim.step(DT, { throttle: 0, brake: 0, steer: 0 });
    if (landed < 0 && sim.readState().wheels.every((w) => w.on_gnd)) landed = i;
  }
  assert.ok(landed >= 0, "never landed");

  let highest = -Infinity;
  for (let i = 0; i < 4 / DT; i++) {
    sim.step(DT, { throttle: 0, brake: 0, steer: 0 });
    highest = Math.max(highest, sim.readState().ipos.y - ground);
  }
  // A 40 ft drop must not bounce back into the air like a ball.
  assert.ok(highest < 12, `rebounded to ${highest.toFixed(1)} ft after landing`);
});

test("an upside down truck scrubs to a stop rather than sliding for ever", () => {
  const frame = frameFrom(() => 50);
  const sim = createVehicleSim(assembly(), frame);
  const ground = frame.heightAtFeet(400, 400);
  sim.reset({ x: 400, y: ground + 6.8, z: 400 }, 0);

  // Roll it over and give it a shove. Access the state directly: there is no input that puts
  // a truck on its roof, and the point is what happens once it is there.
  sim.state.orientation = { w: 0, x: 0, y: 0, z: 1 }; // 180 degrees about z, on its roof
  sim.state.vel = { x: 0, y: 0, z: -60 };

  const startZ = sim.readState().ipos.z;
  for (let i = 0; i < 4 / DT; i++) sim.step(DT, { throttle: 0, brake: 0, steer: 0 });

  const state = sim.readState();
  assert.ok(Number.isFinite(state.ipos.x), "position went non-finite");
  /*
    Thresholds set from what a rolling crash actually does, not from what I first hoped.

    Rolling a truck in at 41 mph does not produce a body sliding flat on its roof: it tumbles,
    and a tumbling body is off the ground between faces, where nothing can scrub it. Measured,
    it comes down from 41 mph to about 6 and travels under 30 m, with the contact count
    flicking between 0 and 2 the whole way. Demanding a near stop within 4 s would mean
    inventing friction for a truck that is in mid air, which is how the last two "fixes" to
    this contact model went wrong.

    What this guards is the failure that was real: 90 m of frictionless curling, and launches
    to 70 ft. Both are far outside these bounds.
  */
  assert.ok(state.speed < 15, `still sliding at ${state.speed.toFixed(1)} ft/s after 4 s`);
  const slid = Math.abs(state.ipos.z - startZ);
  assert.ok(slid < 140, `slid ${slid.toFixed(0)} ft (${(slid * 0.3048).toFixed(0)} m) on its roof`);
});

test("a truck landed on its roof stays inverted while the driver throttles", () => {
  const frame = frameFrom(() => 50);
  const sim = createVehicleSim(assembly(), frame);
  const ground = frame.heightAtFeet(400, 400);
  sim.reset({ x: 400, y: ground + 5, z: 400 }, 0, Math.PI);
  for (let i = 0; i < 2 / DT; i++) {
    sim.step(DT, { throttle: 1, brake: 0, steer: 0.5 });
  }
  const upY = 1 - 2 * (sim.orientation.x ** 2 + sim.orientation.z ** 2);
  assert.ok(upY < 0, `truck righted itself under throttle: up.y=${upY.toFixed(2)}`);
  assert.ok(sim.readState().invertedFor > 1.9, "inverted timer should continue until course reset");
});

test("state stays finite through a deliberately absurd step", () => {
  const frame = frameFrom(() => 50);
  const sim = createVehicleSim(assembly(), frame);
  const ground = frame.heightAtFeet(400, 400);
  sim.reset({ x: 400, y: ground + 6.8, z: 400 }, 0);
  for (let i = 0; i < 60; i++) sim.step(DT, { throttle: 0, brake: 0, steer: 0 });

  // Something upstream hands the sim a broken velocity: a bad contact, a huge dt, anything.
  sim.state.vel = { x: NaN, y: NaN, z: NaN };
  sim.step(DT, { throttle: 0, brake: 0, steer: 0 });

  const state = sim.readState();
  for (const value of [state.ipos.x, state.ipos.y, state.ipos.z, state.speed, state.psi]) {
    assert.ok(Number.isFinite(value), "the sim should recover rather than propagate NaN");
  }
  // And it must keep running afterwards.
  for (let i = 0; i < 120; i++) sim.step(DT, { throttle: 1, brake: 0, steer: 0.5 });
  assert.ok(Number.isFinite(sim.readState().ipos.y), "did not recover");
});

test("speed and spin are capped", () => {
  const frame = frameFrom(() => 50);
  const sim = createVehicleSim(assembly(), frame);
  const ground = frame.heightAtFeet(400, 400);
  sim.reset({ x: 400, y: ground + 30, z: 400 }, 0);

  sim.state.vel = { x: 5000, y: 0, z: 0 };
  sim.state.omega = { x: 0, y: 400, z: 0 };
  sim.step(DT, { throttle: 0, brake: 0, steer: 0 });

  const state = sim.readState();
  assert.ok(state.speed <= 251, `speed ${state.speed.toFixed(0)} ft/s was not capped`);
  assert.ok(Math.abs(state.yawRate) <= 12.1, `yaw rate ${state.yawRate.toFixed(1)} was not capped`);
});
