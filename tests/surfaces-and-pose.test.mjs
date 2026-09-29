/*
  Ground types under the tires, the tire footprint on steep ground, and where the truck is drawn.

  Run with: node --test tests/
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createWorldFrame, UNITS_PER_FOOT_H, UNITS_PER_FOOT_V } from "../src/drive/world-frame.js";
import { createVehicleSim } from "../src/drive/vehicle-sim.js";
import { SURFACES, surfaceOf } from "../src/drive/surfaces.js";

const DT = 1 / 120;
const GRID = 32;
const CELL = 64;

function frameFrom(heightFn, surfaceFn = null) {
  const raw = new Uint8Array(GRID * GRID);
  const surface = surfaceFn ? new Uint16Array(GRID * GRID) : null;
  for (let cz = 0; cz < GRID; cz++) {
    for (let cx = 0; cx < GRID; cx++) {
      raw[cx + cz * GRID] = heightFn(cx, cz);
      if (surface) surface[cx + cz * GRID] = surfaceFn(cx, cz);
    }
  }
  return createWorldFrame({
    terrain: { gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1, rawData: raw, surface },
  });
}

function assembly() {
  const anchors = {
    "faxle.rtire.static_bpos": { x: 4.3, y: -3.8, z: 6.1 },
    "faxle.ltire.static_bpos": { x: -4.3, y: -3.8, z: 6.1 },
    "raxle.rtire.static_bpos": { x: 4.3, y: -3.8, z: -5.5 },
    "raxle.ltire.static_bpos": { x: -4.3, y: -3.8, z: -5.5 },
  };
  return {
    body: { name: "B", vertices: [{ x: -3.7, y: -2.8, z: -9 }, { x: 3.7, y: 4.6, z: 9 }], meshes: [] },
    wheels: Object.entries(anchors).map(([key, position]) => ({ key, position, radius: 3, model: {} })),
    scrapePoints: [{ x: 0, y: -2.5, z: 9.2 }, { x: 0, y: -2.5, z: -9.2 }],
    restHeight: 6.8, textures: [], axles: [], axleBars: [], shocks: [], driveshaft: null, lights: [], warnings: [],
  };
}

const MID = GRID * CELL / 2 / UNITS_PER_FOOT_H;

/*
  Park a truck facing east at x (feet) and let it settle, on the handbrake: in the automatic
  gearbox the brake at a standstill is reverse, as in MTM2.
*/
function parked(frame, x = MID) {
  const sim = createVehicleSim(assembly(), frame);
  sim.reset({ x, y: frame.heightAtFeet(x, MID) + 7, z: MID }, Math.PI / 2);
  for (let i = 0; i < 240; i++) sim.step(DT, { throttle: 0, brake: 0, steer: 0, handbrake: true });
  return sim;
}

/* ── Surfaces ───────────────────────────────────────────────────────────── */

test("a .TTY value names its ground type and depth, and anything unknown is Default", () => {
  assert.deepEqual([surfaceOf(404).name, surfaceOf(404).depth], ["Mud", 4]);
  // Type 2 is Dirt: the stock "muddy grass" tiles are 204, dirt at depth 4.
  assert.equal(surfaceOf(204).name, "Dirt");
  assert.equal(surfaceOf(318).name, "Water");
  assert.equal(surfaceOf(0).name, "Default");
  assert.equal(surfaceOf(1400).name, "Default", "TPARK carries a type 14");
  assert.equal(SURFACES.length, 13);
});

test("the ground type under a point is read from the terrain cell", () => {
  const frame = frameFrom(() => 50, (cx) => (cx < GRID / 2 ? 101 : 318));
  assert.equal(frame.surfaceAtFeet(10, MID), 101);
  assert.equal(frame.surfaceAtFeet(MID + 40, MID), 318);
  assert.equal(frameFrom(() => 50).surfaceAtFeet(10, 10), 0, "an untyped track is all Default");
});

/** How far a truck rolls from 40 ft/s with the throttle off, in two seconds. */
function coastDistance(tty) {
  const frame = frameFrom(() => 50, () => tty);
  const sim = parked(frame, MID - 200);
  sim.state.vel = { x: 40, y: 0, z: 0 };
  for (const wheel of sim.wheels) wheel.spinRate = 40 / wheel.radius;
  const start = sim.readState().ipos.x;
  for (let i = 0; i < 240; i++) sim.step(DT, { throttle: 0, brake: 0, steer: 0 });
  assert.equal(sim.readState().wheels[0].surface, surfaceOf(tty).name);
  return sim.readState().ipos.x - start;
}

test("mud and water hold a truck back far more than road does", () => {
  const road = coastDistance(100);
  const mud = coastDistance(408);
  const water = coastDistance(318);
  assert.ok(mud < road * 0.8, `mud ${mud.toFixed(0)} ft against road ${road.toFixed(0)}`);
  assert.ok(water < road * 0.8, `water ${water.toFixed(0)} ft against road ${road.toFixed(0)}`);
});

/*
  How far the direction of travel turns in 1.5 s at full lock from 30 ft/s, in radians. Measured
  on the velocity rather than on the body: on ice the body can spin round while the truck
  carries on in a straight line, which is not turning.
*/
function cornering(tty) {
  const frame = frameFrom(() => 50, () => tty);
  const sim = parked(frame, MID - 150);
  sim.state.vel = { x: 30, y: 0, z: 0 };
  for (const wheel of sim.wheels) wheel.spinRate = 30 / wheel.radius;
  for (let i = 0; i < 180; i++) sim.step(DT, { throttle: 0.3, brake: 0, steer: 1 });
  const { x, z } = sim.state.vel;
  return Math.abs(Math.atan2(z, x));
}

test("a truck turns far less on ice than on road", () => {
  const road = cornering(100);
  const ice = cornering(800);
  assert.ok(ice < road * 0.7, `ice turned ${ice.toFixed(2)} rad against road ${road.toFixed(2)}`);
});

test("heavy drag in deep mud does not rock a truck back and forth", () => {
  const frame = frameFrom(() => 50, () => 440);
  const sim = parked(frame);
  let flips = 0;
  let last = Math.sign(sim.state.vel.x);
  for (let i = 0; i < 240; i++) {
    sim.step(DT, { throttle: 0, brake: 0, steer: 0 });
    const sign = Math.sign(Math.round(sim.state.vel.x * 1000));
    if (sign && last && sign !== last) flips++;
    if (sign) last = sign;
  }
  assert.ok(flips <= 1, `${flips} reversals in two seconds`);
});

/* ── Tire footprint ─────────────────────────────────────────────────────── */

test("a tire meets a steep rise at its rim, before the axle is over it", () => {
  // Terrain climbing 20 steps (40 ft) over one 32 ft cell. Heights sit on cell corners, so the
  // rise starts at corner edge - 1.
  const edge = GRID / 2 + 1;
  const foot = (edge - 1) * CELL / UNITS_PER_FOOT_H;
  // Front axle half a foot short of the foot of the rise: a ray under it sees only flat ground.
  const x = foot - 6.1 - 0.5;
  const frontAfterDrop = (frame) => {
    const sim = createVehicleSim(assembly(), frame);
    sim.reset({ x, y: frame.heightAtFeet(x, MID) + 7, z: MID }, Math.PI / 2);
    for (let i = 0; i < 40; i++) sim.step(DT, { throttle: 0, brake: 0, steer: 0 });
    const [front] = sim.mountPoints();
    assert.ok(front.world.x < foot, "the axle is still on the flat");
    return front.world.y;
  };
  // Carried up by its rim on the rise, the front axle stands higher than on the flat.
  const flat = frontAfterDrop(frameFrom(() => 50));
  const rise = frontAfterDrop(frameFrom((cx) => (cx < edge ? 50 : 70)));
  assert.ok(rise > flat + 0.5, `front axle ${rise.toFixed(2)} ft at the rise against ${flat.toFixed(2)} on the flat`);
});

/* ── Where the truck is drawn ───────────────────────────────────────────── */

function mounts(frame, sim, ground = null) {
  return sim.mountPoints().map((m) => ({
    ...m, reach: m.radius, ground: ground ?? frame.heightAtFeet(m.world.x, m.world.z),
  }));
}

test("on flat ground the fitted pose is the old placement exactly", () => {
  const frame = frameFrom(() => 50);
  const sim = parked(frame);
  const state = sim.readState();
  const pose = frame.toSceneTruckPose(mounts(frame, sim));
  const old = frame.toSceneTruckPosition(state.ipos, frame.heightAtFeet(state.ipos.x, state.ipos.z));
  assert.ok(Math.abs(pose.position.y - old.y) < 1e-6);
  assert.ok(Math.abs(pose.position.x - old.x) < 1e-6);
  assert.ok(pose.up.y > 0.9999);
});

test("on a slope every wheel is drawn on the drawn ground", () => {
  // A steady climb eastward: one step (2 ft) per 32 ft cell, about 3.6 degrees... times four.
  const frame = frameFrom((cx) => 40 + cx * 4);
  const sim = parked(frame);
  const pose = frame.toSceneTruckPose(mounts(frame, sim));
  // Each mount, carried through the drawn pose, against the drawn terrain under it.
  let worst = 0;
  for (const m of sim.mountPoints()) {
    const b = { x: m.body.x * 2, y: m.body.y * 2, z: m.body.z * 2 };
    const x = pose.position.x + pose.right.x * b.x + pose.up.x * b.y + pose.back.x * b.z;
    const y = pose.position.y + pose.right.y * b.x + pose.up.y * b.y + pose.back.y * b.z;
    const z = pose.position.z + pose.right.z * b.x + pose.up.z * b.y + pose.back.z * b.z;
    const groundDrawn = frame.heightAtFeet(x / 2, z / 2) * UNITS_PER_FOOT_V;
    const clearanceDrawn = (y - groundDrawn) / UNITS_PER_FOOT_H;
    const clearanceTrue = m.world.y - frame.heightAtFeet(m.world.x, m.world.z);
    worst = Math.max(worst, Math.abs(clearanceDrawn - clearanceTrue));
  }
  assert.ok(worst < 0.3, `a wheel is drawn ${worst.toFixed(2)} ft off its ground`);
});

test("a truck in the air does not rise on screen when the ground falls away beneath it", () => {
  const frame = frameFrom(() => 50);
  const sim = parked(frame);
  const air = sim.mountPoints().map((m) => ({ ...m, world: { ...m.world, y: m.world.y + 40 } }));
  const high = frame.toSceneTruckPose(air.map((m) => ({ ...m, reach: m.radius, ground: 100 })));
  const deep = frame.toSceneTruckPose(air.map((m) => ({ ...m, reach: m.radius, ground: 60 })));
  assert.ok(Math.abs(high.position.y - deep.position.y) < 1e-6);
});
