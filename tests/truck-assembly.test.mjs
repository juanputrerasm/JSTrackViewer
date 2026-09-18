/*
  Tests for assembling a drivable truck out of a real POD.

  Run with: node --test tests/

  These need a local MTM2 install and skip without one. They are worth having despite that,
  because the numbers asserted here were measured independently (scratchpad/truck-dims.mjs
  decodes the same BINs through a different decoder and reads the TRK directly), so a drift in
  the loader shows up as a disagreement with geometry rather than as a changed snapshot.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { indexStockPod, skipWithoutStockPod, entryText } from "./helpers/stock-pod.mjs";
import { parseTruckManifestText } from "../src/worker/truck/trk-parser.js";
import { assembleTruck } from "../src/worker/truck/truck-assembly.js";

const skip = skipWithoutStockPod();

/** Assemble one stock truck by name. */
async function assembleStock(name) {
  const pod = indexStockPod();
  const text = entryText(
    pod,
    (e) => e.normalizedName.startsWith("TRUCK/") && e.title === `${name}.TRK`
  );
  assert.ok(text, `${name}.TRK should be in TRUCK2.POD`);
  return assembleTruck(pod.podIndex, pod.getBytes, parseTruckManifestText(text));
}

test("BIGFOOT assembles with the geometry measured off its own models", { skip }, async () => {
  const truck = await assembleStock("BIGFOOT");

  assert.equal(truck.truckName, "Bigfoot");
  assert.equal(truck.formatVersion, "MTM2");
  assert.equal(truck.warnings.length, 0, `unexpected warnings: ${truck.warnings.join("; ")}`);

  // The full detail body, not one of the reduced variants.
  assert.equal(truck.body.name, "BIGFOOT.BIN");
  assert.equal(truck.body.vertices.length, 236);

  // 18.40 ft long and 8.39 ft wide, in feet, which is the whole point of the unit conversion.
  const span = (axis) => {
    const vs = truck.body.vertices;
    return Math.max(...vs.map((v) => v[axis])) - Math.min(...vs.map((v) => v[axis]));
  };
  assert.ok(Math.abs(span("y") - 18.4) < 0.01, `body length ${span("y")}`);
  assert.ok(Math.abs(span("z") - 8.39) < 0.01, `body width ${span("z")}`);
});

test("every wheel gets a model, an anchor and a measured radius", { skip }, async () => {
  const truck = await assembleStock("BIGFOOT");
  assert.equal(truck.wheels.length, 4);

  for (const wheel of truck.wheels) {
    assert.ok(wheel.model, `${wheel.key} has no model`);
    // A 72 inch tire. No TRK field states this, so it has to come from the model's bounds.
    assert.ok(Math.abs(wheel.radius - 3.0) < 0.001, `${wheel.key} radius ${wheel.radius}`);
  }

  const anchor = (key) => truck.wheels.find((w) => w.key === key).position;
  assert.ok(Math.abs(anchor("faxle.rtire.static_bpos").x - 4.291666) < 1e-6);
  assert.equal(anchor("faxle.rtire.static_bpos").y, -3.8);
  assert.equal(anchor("faxle.rtire.static_bpos").z, 6.1);
  assert.equal(anchor("raxle.rtire.static_bpos").z, -5.5);

  // Left and right models differ: the sidewall art is not symmetric.
  const left = truck.wheels.find((w) => w.key === "faxle.ltire.static_bpos").model.name;
  const right = truck.wheels.find((w) => w.key === "faxle.rtire.static_bpos").model.name;
  assert.equal(left, "BFC16L.BIN");
  assert.equal(right, "BFC16R.BIN");
});

test("rest height follows from the anchor and the radius", { skip }, async () => {
  const truck = await assembleStock("BIGFOOT");
  /*
    3.8 ft anchor plus a 3.0 ft radius. Phase 0 measured SUMMIT1's start grid at 6.00 ft, and
    that 0.8 ft disagreement is still open: it may be static suspension sag, but ALASKA and
    CRAZY98 park their trucks at 9 and 10 ft, so the authored spawn altitude is not a settled
    pose. The spawn snaps to terrain instead of using this, and this only has to stay
    consistent with the truck's own geometry.
  */
  assert.ok(Math.abs(truck.restHeight - 6.8) < 0.001, `rest height ${truck.restHeight}`);
});

test("chassis hardware and contact points are present", { skip }, async () => {
  const truck = await assembleStock("BIGFOOT");
  assert.equal(truck.axles.length, 2);
  assert.equal(truck.shocks.length, 8, "an inner and outer shock at each corner");
  assert.equal(truck.axleBars.length, 4, "one lower set; no superiorAxlebarOffset on a stock truck");
  assert.ok(truck.driveshaft);
  // The sim's chassis contacts. A stock truck carries the full hull.
  assert.equal(truck.scrapePoints.length, 12);
  assert.equal(truck.lights.length, 11);
});

test("textures decode against the resolved palettes", { skip }, async () => {
  const truck = await assembleStock("BIGFOOT");
  assert.ok(truck.textures.length >= 8, `only ${truck.textures.length} textures`);
  for (const texture of truck.textures) {
    assert.ok(texture.width > 0 && texture.height > 0, `${texture.name} has no size`);
    assert.equal(texture.rgba.length, texture.width * texture.height * 4, `${texture.name} rgba size`);
  }
  // Truck art is authored against METALCR2, which is not in TRUCK2.POD, so this also proves
  // the bundled palette fallback is reached rather than the textures coming out black.
  const body = truck.textures.find((t) => t.name.toUpperCase().includes("BIGFOOT"));
  assert.ok(body, "the body texture should be loaded");
  assert.ok(body.rgba.some((v) => v !== 0), "the body texture should not be entirely black");
});

test("a second truck assembles from the same archive", { skip }, async () => {
  // Guards against anything cached per module rather than per truck.
  const truck = await assembleStock("CRUSHER");
  assert.equal(truck.truckName, "Carolina Crusher");
  assert.equal(truck.body.name, "CRUSHER.BIN");
  assert.equal(truck.warnings.length, 0, `unexpected warnings: ${truck.warnings.join("; ")}`);
  for (const wheel of truck.wheels) {
    assert.ok(Math.abs(wheel.radius - 3.0) < 0.001, `${wheel.key} radius ${wheel.radius}`);
  }
});
