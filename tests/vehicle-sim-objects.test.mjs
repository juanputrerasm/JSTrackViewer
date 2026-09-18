/*
  Driving on and into the track's objects.

  Run with: node --test tests/

  The collider tests check the geometry in isolation; these check that the simulation actually
  uses it. That is a separate risk: the colliders were correct for a while before anything
  consumed them, and a truck that drives through a solid box looks exactly like a truck on a
  track with no boxes at all.

  Synthetic boxes again, placed in editor units, so the expected answers can be worked out by
  hand rather than read off a POD.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { createColliders } from "../src/drive/colliders.js";
import { createVehicleSim } from "../src/drive/vehicle-sim.js";

const DT = 1 / 120;
const GRID = 64;
const CELL = 64;
const HEIGHT_SCALE = 3;
const FLAT_STEPS = 50;

function flatTrack(boxes = []) {
  return {
    terrain: {
      gridSize: GRID, cellSize: CELL, heightScale: HEIGHT_SCALE, rawBytesPerCell: 1,
      rawData: new Uint8Array(GRID * GRID).fill(FLAT_STEPS),
    },
    boxes,
    groundBoxes: [],
  };
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
    scrapePoints: [
      { x: 0, y: -2.5, z: 9.2 }, { x: 0, y: -2.5, z: -9.2 },
      { x: 3.6, y: -2.5, z: 0 }, { x: -3.6, y: -2.5, z: 0 },
    ],
    restHeight: 6.8, textures: [],
    axles: [], axleBars: [], shocks: [], driveshaft: null, lights: [], warnings: [],
  };
}

/** A sim with the given track's objects wired in, spawned at `startFeet` facing `psi`. */
function simOn(track, startFeet, psi = 0) {
  const frame = createWorldFrame(track);
  const colliders = createColliders(track, frame);
  const sim = createVehicleSim(assembly(), frame, undefined, colliders);
  const ground = frame.heightAtFeet(startFeet.x, startFeet.z);
  sim.reset({ x: startFeet.x, y: ground + 6.8, z: startFeet.z }, psi);
  return { sim, frame, colliders, ground };
}

function run(sim, seconds, input = { throttle: 0, brake: 0, steer: 0 }) {
  for (let i = 0; i < Math.round(seconds / DT); i++) sim.step(DT, input);
  return sim.readState();
}

test("a truck with no objects on the track behaves exactly as before", () => {
  /*
    The regression guard for threading colliders through the sim: with none, every query has
    to fall through to the terrain untouched.
  */
  const track = flatTrack();
  const { sim, ground } = simOn(track, { x: 600, z: 600 });
  const state = run(sim, 3);
  assert.ok(state.speed < 0.2, `should have settled, at ${state.speed.toFixed(2)} ft/s`);
  assert.ok(Math.abs(state.ipos.y - ground - 6.03) < 0.2,
    `settled at ${(state.ipos.y - ground).toFixed(2)} ft above ground, expected about 6.03`);
});

test("a truck parked on a low box rests on top of it, not in it", () => {
  /*
    A box 8 ft tall standing on flat ground, with the truck spawned above it. The wheels must
    find the box's top rather than the terrain 8 ft below, or the truck sinks to its axles in
    solid scenery.
  */
  /*
    Sized and placed so the box RESTS on the terrain.

    Its half height in feet is `height / 1.5` (the scene draws the extent unscaled while the
    centre carries the height scale), and its centre in feet is `altitude * 3 / 1.5`. Ground is
    at 100 ft, so a 4-unit half height is 2.67 ft and the centre wants to be 102.67, which is
    altitude 51.33. Left floating, as an earlier version of this fixture was, the truck simply
    parks underneath it and the test says nothing.
  */
  const box = {
    position: [1200, 1200, 51.33], theta: 0, phi: 0, psi: 0,
    width: 60, length: 60, height: 4, type: 0, mass: 0, modelName: "",
  };
  const track = flatTrack([box]);
  const frame = createWorldFrame(track);
  const colliders = createColliders(track, frame);
  const solid = colliders.solids[0];
  const top = solid.centre.y + solid.extents[1];

  const sim = createVehicleSim(assembly(), frame, undefined, colliders);
  sim.reset({ x: solid.centre.x, y: top + 6.8, z: solid.centre.z }, 0);
  const state = run(sim, 3);

  const ride = state.ipos.y - top;
  assert.ok(ride > 5.5 && ride < 6.8, `rode at ${ride.toFixed(2)} ft above the box top`);
  assert.ok(state.wheels.every((w) => w.on_gnd), "all four wheels should be on the box");
  assert.ok(state.speed < 0.3, `should be at rest, at ${state.speed.toFixed(2)} ft/s`);
});

test("a truck driven at a wall is stopped by it", () => {
  /*
    The case that fails silently when colliders are built but never consumed: the truck simply
    drives through. A tall box across the path, approached at full throttle.
  */
  /*
    A wall standing ON the ground, not hovering over it.

    At altitude 70 an earlier version of this fixture put the wall's underside 13 ft up and the
    truck drove neatly beneath it, which looks identical to a collider that does not work. Half
    height 30/1.5 = 20 ft, so a centre at 120 ft puts the base exactly on the 100 ft terrain,
    and 120 ft of centre is altitude 60.
  */
  const wall = {
    position: [1400, 1200, 60], theta: 0, phi: 0, psi: 0,
    width: 200, length: 16, height: 30, type: 0, mass: 0, modelName: "",
  };
  const track = flatTrack([wall]);
  const frame = createWorldFrame(track);
  const colliders = createColliders(track, frame);
  const wallSolid = colliders.solids[0];

  // Start well short of the wall, facing it along +x (psi = pi/2 faces +x).
  const start = { x: wallSolid.centre.x - 120, z: wallSolid.centre.z };
  const sim = createVehicleSim(assembly(), frame, undefined, colliders);
  sim.reset({ x: start.x, y: frame.heightAtFeet(start.x, start.z) + 6.8, z: start.z }, Math.PI / 2);

  let closest = Infinity;
  for (let i = 0; i < 8 / DT; i++) {
    sim.step(DT, { throttle: 1, brake: 0, steer: 0 });
    const state = sim.readState();
    const gap = wallSolid.centre.x - wallSolid.extents[0] - state.ipos.x;
    if (gap < closest) closest = gap;
    if (!Number.isFinite(state.ipos.x)) break;
  }

  const state = sim.readState();
  // The nose reaches the wall (scrape points extend 9.2 ft ahead), but the body's centre must
  // not end up past its face.
  assert.ok(state.ipos.x < wallSolid.centre.x,
    `drove through the wall, ending at x ${state.ipos.x.toFixed(1)} past ${wallSolid.centre.x.toFixed(1)}`);
  assert.ok(closest < 12, `never actually reached the wall, closest ${closest.toFixed(1)} ft`);
});

test("drive-through boxes do not stop a truck", () => {
  /*
    Type 7 is "drive thru" in Traxx's own notes, and checkpoints are built from these with
    separate solid boxes at their base. A truck that stops at one cannot finish a lap.
  */
  const gate = {
    position: [1400, 1200, 70], theta: 0, phi: 0, psi: 0,
    width: 200, length: 16, height: 40, type: 7, mass: 0, modelName: "",
  };
  const track = flatTrack([gate]);
  const frame = createWorldFrame(track);
  const colliders = createColliders(track, frame);
  assert.equal(colliders.solids.length, 0, "a drive-through box is not solid");

  const gateX = 1400 / 2;
  const start = { x: gateX - 120, z: (GRID * CELL - 1200) / 2 };
  const sim = createVehicleSim(assembly(), frame, undefined, colliders);
  sim.reset({ x: start.x, y: frame.heightAtFeet(start.x, start.z) + 6.8, z: start.z }, Math.PI / 2);

  const state = run(sim, 8, { throttle: 1, brake: 0, steer: 0 });
  assert.ok(state.ipos.x > gateX + 20, `should have driven straight through, reached x ${state.ipos.x.toFixed(1)}`);
});
