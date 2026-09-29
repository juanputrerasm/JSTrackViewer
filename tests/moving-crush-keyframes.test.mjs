/*
  Moving objects, top-crush cars, animated BIN keyframes and MTM1's own sky.

  Run with: node --test tests/

  The stock cases read MTM1's GAME.POD and MTM2's OUTBACK.POD from a local install and skip
  themselves without one.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createMovers, FLYING_SPEED } from "../src/drive/moving-objects.js";
import { createColliders } from "../src/drive/colliders.js";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { keyframeMorphs, resolveKeyframeModel } from "../src/worker/keyframes.js";
import { decodeBinModel } from "../src/worker/bin-decoder.js";
import { parseSitTrack } from "../src/worker/sit-parser.js";
import { indexStockPod, skipWithoutStockPod } from "./helpers/stock-pod.mjs";

const GRID = 64;
const CELL = 64;
const WORLD_FEET = GRID * CELL / 2;

/** Flat ground at `level`, or a ramp that climbs one height step per cell eastward. */
function frame({ level = 50, ramp = false } = {}) {
  const raw = new Uint8Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) raw[x + y * GRID] = ramp ? level + x : level;
  return createWorldFrame({
    terrain: { gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1, rawData: raw },
  });
}

function track(boxes, groundBoxes = []) {
  return { terrain: { gridSize: GRID, cellSize: CELL, heightScale: 3 }, boxes, groundBoxes };
}

const train = (extra = {}) => ({
  position: [1200, 1200, 50], theta: 0, phi: 0, psi: 0, type: 10, bvel: [0, 0, -70], mass: 0, modelName: "", ...extra,
});

test("a type 10 box travels along its bvel on world axes", () => {
  const movers = createMovers(track([train()]), frame());
  assert.equal(movers.count, 1);
  movers.step(1);
  const { offset } = movers.moverFor(0);
  assert.ok(Math.abs(offset.x) < 1e-9);
  // bvel z runs opposite to the scene's z.
  assert.ok(Math.abs(offset.z - 70) < 1e-9, `z offset ${offset.z}`);
});

test("a box without a velocity, or of another type, does not move", () => {
  const movers = createMovers(track([train({ bvel: [0, 0, 0] }), train({ type: 0 })]), frame());
  assert.equal(movers.count, 0);
});

test("Evo 1's type 10 and Evo 2's CTrain move too", () => {
  const evo1 = { ...train({ type: undefined, bvel: [70, 0, 0] }), boxType: 10 };
  const ctrain = { ...train({ type: undefined, bvel: [0, 0, 30] }), sourceClass: "CTrain" };
  assert.equal(createMovers(track([evo1, ctrain]), frame()).count, 2);
});

test("a moving object wraps at the edge of the world", () => {
  const movers = createMovers(track([train()]), frame());
  movers.step(WORLD_FEET / 70 + 1);
  const mover = movers.moverFor(0);
  const z = mover.start.z + mover.offset.z;
  assert.ok(z >= 0 && z < WORLD_FEET, `z ${z} is inside the world`);
  assert.ok(Math.abs(z - (mover.start.z + 70) % WORLD_FEET) < 1e-6);
});

test("a moving object keeps its clearance over rising ground", () => {
  // Eastward over a ramp that climbs 2 ft (one height step) per 32 ft cell.
  const movers = createMovers(track([train({ bvel: [32, 0, 0] })]), frame({ ramp: true }));
  movers.step(2);
  assert.ok(Math.abs(movers.moverFor(0).offset.y - 4) < 0.5, `rose ${movers.moverFor(0).offset.y} ft`);
});

test("a moving object rides up onto a ground box in its path", () => {
  // A column one cell east of the start, 20 steps above the terrain's 50.
  const gb = { x: 19, y: 18, upper: 70, lower: 0 };
  const movers = createMovers(track([train({ bvel: [32, 0, 0] })], [gb]), frame());
  movers.step(1);
  assert.ok(movers.moverFor(0).offset.y > 30, `on the box: ${movers.moverFor(0).offset.y} ft up`);
});

test("switching moving objects off puts them back where they were authored", () => {
  const movers = createMovers(track([train()]), frame());
  movers.step(3);
  movers.setEnabled(false);
  movers.step(3);
  assert.deepEqual({ ...movers.moverFor(0).offset }, { x: 0, y: 0, z: 0 });
  assert.equal(movers.time, 0);
});

test("a banked flying object circles through its authored place, and its rider goes with it", () => {
  // Heading 0 faces scene -z; rolled right wing down, so it turns right, toward +x.
  const plane = { position: [2000, 2000, 200], psi: 0, theta: 0, phi: -0.6, sourceClass: "CFlyingObject", instanceId: 7 };
  const banner = { position: [2000, 1970, 200], psi: 0, theta: 0, phi: -0.6, sourceClass: "CFlyingObject", parent: 7 };
  const level = { position: [2500, 2000, 200], psi: 0, theta: 0, phi: 0, sourceClass: "CFlyingObject" };
  const movers = createMovers(track([plane, banner, level]), frame());
  assert.equal(movers.count, 1, "only the plane flies: the banner rides it, the level one has no turn");
  const mover = movers.moverFor(0);
  assert.equal(movers.moverFor(1), mover, "the banner rides with its plane");
  assert.equal(movers.moverFor(2), null);

  movers.step(0.1);
  assert.ok(mover.offset.z < 0, "sets off along its heading (scene -z)");
  assert.ok(mover.yaw < 0, "turning right");
  // A whole circle brings it back.
  const period = 2 * Math.PI * mover.radius / FLYING_SPEED;
  movers.reset();
  movers.step(period);
  assert.ok(Math.hypot(mover.offset.x, mover.offset.z) < 1e-6);
});

/* ── Top crush ──────────────────────────────────────────────────────────── */

/** A 2 x 2 ft roof at height 8 raw units that the second frame flattens to 0. */
function cabModel() {
  const quad = (z) => new Float32Array([-4, -4, z, 4, -4, z, 4, 4, z, -4, -4, z, 4, 4, z, -4, 4, z]);
  const normals = new Float32Array(18).fill(0);
  return {
    name: "CAB.BIN", format: "ANIMATED_BIN", anchor: { x: 0, y: 0, z: 0 }, baseZ: 0,
    meshes: [{ positions: quad(8), normals, uvs: new Float32Array(12) }],
    keyframes: [{ meshes: [{ positions: quad(8), normals }] }, { meshes: [{ positions: quad(0), normals }] }],
  };
}

test("a top-crush cab gives way under a wheel, and only under one", () => {
  const cab = { position: [1200, 1200, 50], theta: 0, phi: 0, psi: 0, type: 98, crushRole: "cab", mass: 0, modelName: "CAB.BIN" };
  const data = { ...track([cab]), models: { "CAB.BIN": cabModel() } };
  const colliders = createColliders(data, frame());
  assert.equal(colliders.crushables.length, 1);
  const solid = colliders.crushables[0];
  const x = 1200 / 2, z = (GRID * CELL - 1200) / 2;

  // Nothing on it: stepping leaves it standing.
  colliders.step(1);
  assert.equal(solid.crush.amount, 0);

  // A wheel on it for a while flattens it, gradually.
  const roof = colliders.supportAt(x, z, 200);
  colliders.step(0.1);
  assert.ok(solid.crush.amount > 0 && solid.crush.amount < 1);
  for (let i = 0; i < 20; i++) { colliders.supportAt(x, z, 200); colliders.step(0.1); }
  assert.equal(solid.crush.amount, 1);
  const flat = colliders.supportAt(x, z, 200);
  assert.ok(flat < roof - 2, `roof ${roof} ft, crushed ${flat} ft`);
});

test("MTM1's DEMO.SIT top-crush cars parse into a body and a two-frame cab", { skip: skipWithoutStockPod(`${process.env.HOME}/games/mtm1/GAME.POD`) }, () => {
  const pod = indexStockPod(`${process.env.HOME}/games/mtm1/GAME.POD`);
  const sit = pod.podIndex.entries.find((e) => e.title === "DEMO.SIT");
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit, "");
  const crush = doc.boxes.filter((b) => b.type === 98);
  assert.equal(crush.length, 4);
  assert.deepEqual(crush.map((b) => [b.crushRole, b.modelName]), [
    ["body", "WREC2.BIN"], ["cab", "WREC1.BIN"], ["body", "WREC2.BIN"], ["cab", "WREC1.BIN"],
  ]);
  // ipos2 is 1 ft above ipos: 61.996 against 60.998 feet, over the 2 ft height step.
  assert.ok(Math.abs(crush[1].position[2] - crush[0].position[2] - 0.499) < 0.01);
  assert.equal(crush[0].psi, 1.570796);
});

/* ── Keyframes ──────────────────────────────────────────────────────────── */

test("keyframes that do not line up are refused", () => {
  const a = { anchor: { x: 0, y: 0, z: 0 }, meshes: [{ positions: new Float32Array(9), normals: new Float32Array(9) }] };
  const b = { anchor: { x: 0, y: 0, z: 0 }, meshes: [{ positions: new Float32Array(18), normals: new Float32Array(18) }] };
  assert.equal(keyframeMorphs(a, [a, b]), null);
  assert.equal(keyframeMorphs(a, [a]), null, "one frame is not an animation");
});

test("OUTBACK's PUMPJACK resolves to eight keyframes in its first frame's space", { skip: skipWithoutStockPod(`${process.env.HOME}/games/mtm2/OUTBACK.POD`) }, () => {
  const pod = indexStockPod(`${process.env.HOME}/games/mtm2/OUTBACK.POD`);
  const load = (name) => {
    const entry = pod.podIndex.entries.find((e) => e.title === name.toUpperCase());
    return entry ? decodeBinModel(pod.getBytes(entry), name, "MTM2") : null;
  };
  const model = resolveKeyframeModel(load("PUMPJACK.BIN"), load);
  assert.equal(model.keyframes.length, 8);
  // Frame 0 is the geometry itself.
  assert.deepEqual([...model.keyframes[0].meshes[0].positions], [...model.meshes[0].positions]);
  // Every frame un-anchored the same way lands in the same place: PJ3 in PJ0's space.
  const pj0 = load("PJ0.BIN"), pj3 = load("PJ3.BIN");
  const shift = pj3.anchor.x - pj0.anchor.x;
  assert.ok(Math.abs(model.keyframes[3].meshes[0].positions[0] - (pj3.meshes[0].positions[0] + shift)) < 1e-5);
});

/* ── MTM1 sky ───────────────────────────────────────────────────────────── */

test("MTM1's sky is recoloured through its level's gradient, as TV's is", { skip: skipWithoutStockPod(`${process.env.HOME}/games/mtm1/GAME.POD`) }, () => {
  const pod = indexStockPod(`${process.env.HOME}/games/mtm1/GAME.POD`);
  const sit = pod.podIndex.entries.find((e) => e.title === "CASTLE.SIT");
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit, "");
  assert.match(doc.skyTexture.name, /ALIENSKY\.RAW$/);
  // EARTHSKY.ACT colour 207 is the horizon.
  assert.deepEqual(doc.classicSky.horizon, [136, 136, 140]);
  // The slots the sky is drawn in now hold the gradient, not the black the ACT has there.
  const slot = doc.skyTexture.data[0];
  assert.ok(slot >= 240);
  const rgb = [...doc.skyTexture.actData.subarray(slot * 3, slot * 3 + 3)];
  assert.notDeepEqual(rgb, [0, 0, 0]);
});
