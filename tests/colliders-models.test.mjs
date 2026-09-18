/*
  Objects with models collide with the model, and type 10 objects move.

  Run with: node --test tests/

  The complaint these answer: a box with a model used to collide as its authored box, so a tree
  stopped the truck metres from its trunk. The authored width, length and height are an editing
  volume. A box WITHOUT a model is still a box, because for those the box is the object.

  Models here are built by hand in raw Traxx local space (x, y, z up, 2 units per foot, base at
  z = 0), which is what the BIN decoder hands the scene, so the placement under test is the one
  scene.js draws with.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createColliders } from "../src/drive/colliders.js";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { traxxRotationRows } from "../src/drive/mesh-collider.js";

const GRID = 64;
const CELL = 64;
const WORLD_UNITS = GRID * CELL;
const GROUND_FT = 100; // 50 steps at 2 ft each

function flatFrame() {
  return createWorldFrame({
    terrain: {
      gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1,
      rawData: new Uint8Array(GRID * GRID).fill(50),
    },
  });
}

/** Triangles of an axis aligned block in Traxx local units, standing on z = 0. */
function blockTriangles(hx, hy, height) {
  const c = [];
  for (const z of [0, height]) for (const y of [-hy, hy]) for (const x of [-hx, hx]) c.push([x, y, z]);
  // Corner index = x + 2y + 4z over {0,1}.
  const faces = [
    [0, 1, 3, 2], [4, 6, 7, 5], // bottom, top
    [0, 4, 5, 1], [2, 3, 7, 6], // -y, +y
    [0, 2, 6, 4], [1, 5, 7, 3], // -x, +x
  ];
  const out = [];
  for (const [a, b, d, e] of faces) out.push(...c[a], ...c[b], ...c[d], ...c[a], ...c[d], ...c[e]);
  return new Float32Array(out);
}

/** A single vertical quad in the local x/z plane: a fence with no thickness at all. */
function planeTriangles(hx, height) {
  return new Float32Array([
    -hx, 0, 0, hx, 0, 0, hx, 0, height,
    -hx, 0, 0, hx, 0, height, -hx, 0, height,
  ]);
}

function trackWith(boxes, models) {
  return {
    terrain: { gridSize: GRID, cellSize: CELL, heightScale: 3 },
    boxes,
    groundBoxes: [],
    models,
  };
}

/** A box resting on the flat ground: altitude 50 puts a base-anchored model's foot at 100 ft. */
function placed(modelName, { x = 1200, y = 1200, psi = 0, type = 0, size = 64, bvel } = {}) {
  return {
    position: [x, y, 50], theta: 0, phi: 0, psi,
    width: size, length: size, height: size, type, mass: 0, modelName, bvel,
  };
}

test("a model collides with its own geometry, not with the box authored around it", () => {
  // A block 8 ft across and 8 ft tall, inside an authored box 64 ft across.
  const models = { "SMALL.BIN": { baseZ: 0, meshes: [{ positions: blockTriangles(8, 8, 16) }] } };
  const colliders = createColliders(trackWith([placed("SMALL.BIN")], models), flatFrame());
  assert.equal(colliders.solids.length, 1);
  const solid = colliders.solids[0];
  assert.equal(solid.kind, "mesh");
  const { x: cx, z: cz } = solid.centre;
  const midHeight = GROUND_FT + 4;

  // Inside the authored box but 10 ft from the model: nothing there.
  assert.equal(
    colliders.contactAt({ x: cx + 10, y: midHeight, z: cz }, { x: cx + 30, y: midHeight, z: cz }),
    null, "the authored box is not solid where the model is not");

  // Through the model's +x face, 3 ft deep.
  const hit = colliders.contactAt({ x: cx + 1, y: midHeight, z: cz }, { x: cx + 20, y: midHeight, z: cz });
  assert.ok(hit, "the model itself is solid");
  assert.ok(hit.normal.x > 0.99, `should push back out towards +x, got ${JSON.stringify(hit.normal)}`);
  assert.ok(Math.abs(hit.depth - 3) < 1e-6, `depth ${hit.depth}, expected 3`);
  assert.equal(hit.solid, solid);
});

test("Evo checkpoints pass through while indexed SMF props collide at their drawn placement", () => {
  const model = { meshes: [{
    positions: new Float32Array([0, 0, -2, 0, 8, -2, 0, 8, 2, 0, 0, 2]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  }] };
  const base = { position: [1200, 1200, 100], psi: 0, theta: 0, phi: 0 };
  for (const origin of ["EVO1", "EVO2"]) {
    const track = { ...trackWith([
      { ...base, boxType: 6, sourceClass: origin === "EVO2" ? "CCheckpoint" : "Box" },
      { ...base, modelName: "FENCE.SMF", sourceClass: "CCollide", size: [100, 100, 100] },
      { ...base, position: [1400, 1200, 100], sourceClass: "CCheckpoint" },
    ], { "FENCE.SMF": model }), origin };
    const colliders = createColliders(track, flatFrame());
    assert.equal(colliders.solids.length, 1, `${origin} has only the visible solid model`);
    const { x, y, z } = colliders.solids[0].centre;
    assert.ok(colliders.contactAt({ x: x - 1, y: y + 2, z }, { x: x + 8, y: y + 2, z }),
      `${origin} collides at its SMF plane`);
    assert.equal(colliders.contactAt({ x: x + 12, y: y + 2, z }, { x: x + 20, y: y + 2, z }), null,
      `${origin} has no invisible authored box wall`);
  }
});

test("Evo vegetation collides with each scaled, yawed model instance", () => {
  const model = { meshes: [{
    positions: new Float32Array([0, 0, -2, 0, 8, -2, 0, 8, 2, 0, 0, 2]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  }] };
  const track = {
    ...trackWith([], { "TREE.SMF": model }), origin: "EVO2",
    vegetation: { trees: [{ modelName: "TREE.SMF", position: [1200, 1200, 100], yaw: Math.PI / 2, scale: [2, 1, 2] }] },
  };
  const colliders = createColliders(track, flatFrame());
  assert.equal(colliders.solids.length, 1);
  const { x, y, z } = colliders.solids[0].centre;
  assert.ok(colliders.contactAt({ x, y: y + 2, z: z - 1 }, { x, y: y + 2, z: z + 8 }),
    "the yawed tree plane is solid at its model");
  assert.equal(colliders.contactAt({ x: x + 12, y: y + 2, z }, { x: x + 20, y: y + 2, z }), null,
    "the tree's broad footprint has no invisible wall");
});

test("a wheel stands on a model's top, and nowhere else inside its box", () => {
  const models = { "SMALL.BIN": { baseZ: 0, meshes: [{ positions: blockTriangles(8, 8, 16) }] } };
  const colliders = createColliders(trackWith([placed("SMALL.BIN")], models), flatFrame());
  const { x: cx, z: cz } = colliders.solids[0].centre;
  assert.ok(Math.abs(colliders.supportAt(cx, cz, 200) - (GROUND_FT + 8)) < 1e-6, "top of an 8 ft block");
  assert.equal(colliders.supportAt(cx + 10, cz, 200), null, "beside the model, inside the authored box");
});

test("a model is turned the way the viewer draws it", () => {
  /*
    A long thin model yawed a quarter turn. The expected direction of its long axis comes from
    scene.js's traxxModelMatrix rows, sceneX = r0.v and sceneZ = -r1.v, rather than from a
    hand-worked answer, because agreeing with the drawing is the whole requirement.
  */
  const psi = Math.PI / 2;
  const models = { "LONG.BIN": { baseZ: 0, meshes: [{ positions: blockTriangles(40, 4, 8) }] } };
  const colliders = createColliders(trackWith([placed("LONG.BIN", { psi })], models), flatFrame());
  const { x: cx, z: cz } = colliders.solids[0].centre;

  const [r0, r1] = traxxRotationRows(psi, 0, 0);
  const tip = [36, 0, 4]; // 18 ft along the long axis
  const along = { x: (r0[0] * tip[0]) / 2, z: -(r1[0] * tip[0]) / 2 };
  const across = { x: -along.z, z: along.x };
  const y = GROUND_FT + 2;

  const at = (d, side) => colliders.contactAt(
    { x: cx + d.x, y, z: cz + d.z },
    { x: cx + d.x + side.x * 10 / 18, y, z: cz + d.z + side.z * 10 / 18 });
  assert.ok(at(along, across), "solid 18 ft along the drawn long axis");
  assert.equal(at(across, along), null, "open 18 ft along the short axis");
});

test("a fence with no thickness still stops a hull point that crosses it", () => {
  const models = { "FENCE.BIN": { baseZ: 0, meshes: [{ positions: planeTriangles(40, 20) }] } };
  const colliders = createColliders(trackWith([placed("FENCE.BIN")], models), flatFrame());
  const { x: cx, z: cz } = colliders.solids[0].centre;
  const y = GROUND_FT + 4;

  const crossed = colliders.contactAt({ x: cx, y, z: cz - 1 }, { x: cx, y, z: cz + 10 });
  assert.ok(crossed, "a point on the far side of the plane from the truck is through it");
  assert.ok(crossed.normal.z > 0.99, "pushed back towards the side the truck is on");
  assert.ok(Math.abs(crossed.depth - 1) < 1e-6, `depth ${crossed.depth}`);

  assert.equal(colliders.contactAt({ x: cx, y, z: cz + 1 }, { x: cx, y, z: cz + 10 }), null,
    "a point on the truck's own side is clear");
});

test("models of pass-through types are not solid, and boxes without models are", () => {
  const models = { "SMALL.BIN": { baseZ: 0, meshes: [{ positions: blockTriangles(8, 8, 16) }] } };
  const boxes = [
    ...[6, 7, 8].map((type, i) => placed("SMALL.BIN", { x: 600 + i * 200, type })),
    placed("", { x: 1400, type: 11 }),
    placed("", { x: 1600, type: 0 }),
    placed("MISSING.BIN", { x: 1800, type: 0 }),
  ];
  const colliders = createColliders(trackWith(boxes, models), flatFrame());
  assert.deepEqual(colliders.solids.map((s) => s.kind), ["box", "box", "box"],
    "only the three model-less boxes (an absent model draws as a box) are solid");
});

test("a type 10 object travels along its bvel and cannot be shoved", () => {
  /*
    TPARK's train: mass 0, bvel (0, 0, -70) on every car. The .SIT's z runs opposite to the
    scene's, so -70 in the file is +70 ft/s in the simulation's z.
  */
  const models = { "CAR.BIN": { baseZ: 0, meshes: [{ positions: blockTriangles(8, 40, 16) }] } };
  const colliders = createColliders(
    trackWith([placed("CAR.BIN", { type: 10, bvel: [0, 0, -70] })], models), flatFrame());
  const car = colliders.solids[0];
  assert.equal(car.moving, true);
  assert.equal(car.movable, false, "mass 0 is never pushable, moving or not");
  assert.deepEqual(colliders.movables, [car], "it is redrawn with the objects that move");

  const start = { ...car.centre };
  colliders.push(car, { x: 1e6, y: 0, z: 0 });
  for (let i = 0; i < 120; i++) colliders.step(1 / 120);
  assert.ok(Math.abs(car.offset.z - 70) < 1e-6, `moved ${car.offset.z} ft in one second`);
  assert.equal(car.offset.x, 0, "a shove does not deflect it");

  const y = GROUND_FT + 4;
  assert.equal(colliders.contactAt({ x: start.x + 1, y, z: start.z }, { x: start.x + 30, y, z: start.z }), null,
    "nothing is left where it started");
  assert.ok(colliders.contactAt({ x: start.x + 1, y, z: start.z + 70 }, { x: start.x + 30, y, z: start.z + 70 }),
    "it collides where it now is");
});

test("a moving object that leaves the world comes back on the other side", () => {
  // 16 units from the file's y = 0 edge is 8 ft from the scene's far z edge.
  const colliders = createColliders(
    trackWith([placed("", { y: 16, type: 10, bvel: [0, 0, -70] })], {}), flatFrame());
  const box = colliders.solids[0];
  for (let i = 0; i < 120; i++) colliders.step(1 / 120);
  const z = box.centre.z + box.offset.z;
  assert.ok(z >= 0 && z < colliders.worldFeet, `ended outside the world at z ${z}`);
  assert.ok(Math.abs(z - (box.centre.z + 70 - colliders.worldFeet)) < 1e-6, `wrapped to ${z}`);
  assert.equal(WORLD_UNITS / 2, colliders.worldFeet);
});
