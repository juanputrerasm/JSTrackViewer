/*
  The meshes a truck is DRAWN from must sit in the same space as the vertices it is MEASURED
  from.

  Run with: node --test tests/

  This is the regression guard for a bug that looked like four separate ones. The BIN decoder
  normalises mesh positions so a model's base sits at z = 0 and reports the offset separately
  as baseZ, which is what the track renderer wants when it drops an object onto terrain. The
  truck loader measures everything from `vertices` instead, so before those two were reconciled
  the renderer drew the body 2.81 ft above where the loader thought it was, the axle 0.85 ft
  high, and every tire a full radius above its own hub, so the wheels visibly orbited their
  mounts rather than turning. The axle bars and driveshaft, placed from TRK coordinates, then
  appeared to hang far below a truck that had floated up around them.

  Needs a local MTM2 install and skips without one.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { indexStockPod, skipWithoutStockPod, entryText } from "./helpers/stock-pod.mjs";
import { parseTruckManifestText } from "../src/worker/truck/trk-parser.js";
import { assembleTruck } from "../src/worker/truck/truck-assembly.js";

const skip = skipWithoutStockPod();

async function assembleStock(name) {
  const pod = indexStockPod();
  const text = entryText(
    pod,
    (e) => e.normalizedName.startsWith("TRUCK/") && e.title === `${name}.TRK`
  );
  assert.ok(text, `${name}.TRK should be in TRUCK2.POD`);
  return assembleTruck(pod.podIndex, pod.getBytes, parseTruckManifestText(text));
}

/** Bounds of a model's drawn triangles. */
function meshBounds(model) {
  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };
  let count = 0;
  for (const mesh of model?.meshes ?? []) {
    const p = mesh.positions;
    if (!p?.length) continue;
    for (let i = 0; i < p.length; i += 3) {
      count++;
      if (p[i] < min.x) min.x = p[i];
      if (p[i + 1] < min.y) min.y = p[i + 1];
      if (p[i + 2] < min.z) min.z = p[i + 2];
      if (p[i] > max.x) max.x = p[i];
      if (p[i + 1] > max.y) max.y = p[i + 1];
      if (p[i + 2] > max.z) max.z = p[i + 2];
    }
  }
  return count ? { min, max, count } : null;
}

/** Bounds of the vertices every measurement is taken from. */
function vertexBounds(model) {
  if (!model?.vertices?.length) return null;
  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of model.vertices) {
    for (const axis of ["x", "y", "z"]) {
      if (v[axis] < min[axis]) min[axis] = v[axis];
      if (v[axis] > max[axis]) max[axis] = v[axis];
    }
  }
  return { min, max };
}

function assertSameSpace(model, label) {
  const mesh = meshBounds(model);
  const vertex = vertexBounds(model);
  assert.ok(mesh, `${label} draws no triangles`);
  assert.ok(vertex, `${label} has no vertices`);
  /*
    A tenth of a foot of slack. The two are built from the same numbers, so they should agree
    exactly, but a model can carry a vertex no triangle references and that would legitimately
    widen the vertex box a little.
  */
  for (const axis of ["x", "y", "z"]) {
    assert.ok(
      Math.abs(mesh.min[axis] - vertex.min[axis]) < 0.1,
      `${label}: drawn ${axis} starts at ${mesh.min[axis].toFixed(3)} but is measured from ${vertex.min[axis].toFixed(3)}`
    );
    assert.ok(
      Math.abs(mesh.max[axis] - vertex.max[axis]) < 0.1,
      `${label}: drawn ${axis} ends at ${mesh.max[axis].toFixed(3)} but is measured from ${vertex.max[axis].toFixed(3)}`
    );
  }
}

for (const name of ["BEARFOOT", "BIGFOOT"]) {
  test(`${name}: body, tires and axle are drawn where they are measured`, { skip }, async () => {
    const truck = await assembleStock(name);
    assertSameSpace(truck.body, `${name} body`);
    for (const wheel of truck.wheels) assertSameSpace(wheel.model, `${name} ${wheel.key}`);
    for (const axle of truck.axles) assertSameSpace(axle.model, `${name} ${axle.key}`);
  });
}

test("a tire is centred on its hub, so it spins in place", { skip }, async () => {
  /*
    The wheel group is placed at the TRK anchor and then rotated about its own origin, so the
    tire's drawn geometry has to be centred there. Off by a radius and the wheel swings around
    the mount instead of turning, which is what the recording showed.
  */
  const truck = await assembleStock("BEARFOOT");
  for (const wheel of truck.wheels) {
    const b = meshBounds(wheel.model);
    assert.ok(b, `${wheel.key} draws no triangles`);
    for (const axis of ["x", "y", "z"]) {
      const centre = (b.min[axis] + b.max[axis]) / 2;
      assert.ok(
        Math.abs(centre) < 0.12,
        `${wheel.key} drawn centre on ${axis} is ${centre.toFixed(3)} ft from the hub`
      );
    }
    // And it really is the size the sim was told about.
    assert.ok(
      Math.abs((b.max.z - b.min.z) / 2 - wheel.radius) < 0.05,
      `${wheel.key} drawn radius ${((b.max.z - b.min.z) / 2).toFixed(3)} against ${wheel.radius.toFixed(3)} in the sim`
    );
  }
});
