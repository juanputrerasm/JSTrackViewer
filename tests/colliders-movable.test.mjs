/*
  Movable objects: what moves, how far, and what falls over.

  Run with: node --test tests/

  MASS IS IN SLUGS, exactly as the .SIT stores it. Every mass in every stock track is a round
  number of pounds once multiplied by g, which is what pins the unit (see TRUCK_MASS_SLUGS in
  params/mtm2-feel.js). Their real values, in the file's own units:

    traffic cone (CRAZY98)        0.093243     3 lb
    Chevy shell (BAJA, CRAZY98)  15.5405     500 lb
    hay bale (CRAZY98)           31.081    1,000 lb
    fence section (TPARK)        77.7025   2,500 lb
    lamp post (TPARK)           124.324    4,000 lb
    stone head (AZTEC)          559.4579  18,000 lb

  against a truck of 310.81 slugs, 10,000 lb. The ordering is what these tests pin down: a cone
  leaves at speed, a car shifts, a stone head barely notices, mass zero never moves, and
  anything tall goes over when it is hit high up.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createColliders } from "../src/drive/colliders.js";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { TRUCK_MASS_SLUGS } from "../src/drive/params/mtm2-feel.js";

const GRID = 64;
const CELL = 64;
const GROUND_FT = 100;

function flatFrame() {
  return createWorldFrame({
    terrain: {
      gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1,
      rawData: new Uint8Array(GRID * GRID).fill(50),
    },
  });
}

/*
  One box of a given mass, resting on the ground.

  Half height in feet is `height / 1.5` and the centre is `altitude * 2`, so a 16 unit half
  height (10.67 ft) wants its centre at 110.67 ft, which is altitude 55.33.
*/
function trackWith(mass, { width = 16, length = 16, height = 16, altitude = 55.33 } = {}) {
  return {
    terrain: { gridSize: GRID, cellSize: CELL, heightScale: 3 },
    boxes: [{
      position: [1200, 1200, altitude], theta: 0, phi: 0, psi: 0,
      width, length, height, type: 0, mass, modelName: "",
    }],
    groundBoxes: [],
  };
}

/*
  Shove it with a real impulse and report how far it travels in two seconds.

  The default is what a truck delivers when it stops dead against something: 310.8 slugs at
  30 ft/s is about 9,300 lb-s. Passing a velocity here instead of an impulse is what hid a
  units bug in `push` for a while, so the name says what it is.
*/
function shove(mass, impulseLbSeconds = TRUCK_MASS_SLUGS * 30, at = null) {
  const colliders = createColliders(trackWith(mass), flatFrame());
  const solid = colliders.solids[0];
  colliders.push(solid, { x: impulseLbSeconds, y: 0, z: 0 }, at);
  for (let i = 0; i < 2 * 120; i++) colliders.step(1 / 120);
  return { solid, colliders, travelled: Math.abs(solid.offset.x) };
}

/** How far from upright an object has ended up, in degrees. */
function tiltDegrees(solid) {
  const q = solid.tilt;
  // The object's own up axis, turned by its tilt.
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  return Math.acos(Math.max(-1, Math.min(1, upY))) * 180 / Math.PI;
}

test("a mass of zero never moves, however hard it is hit", () => {
  const { solid, travelled } = shove(0, 100000);
  assert.equal(solid.movable, false, "mass 0 is not movable");
  assert.equal(travelled, 0, `a static object moved ${travelled.toFixed(2)} ft`);
  assert.equal(tiltDegrees(solid), 0, "and it does not fall over either");
});

test("a traffic cone leaves at speed, but not at rifle speed", () => {
  const { solid, travelled } = shove(0.093243);
  assert.ok(solid.movable, "a cone is movable");
  assert.ok(travelled > 20, `a cone only travelled ${travelled.toFixed(1)} ft`);
  /*
    Capped. Unclamped the arithmetic is correct and unusable: a truck stopping dead gives its
    whole momentum to 0.09 slugs of cone, which leaves at thousands of feet a second, off the
    map and out of the collision grid entirely.
  */
  assert.ok(travelled < 250, `a cone was launched ${travelled.toFixed(0)} ft`);
});

test("the mass ordering of the shipped tracks comes out in the right order", () => {
  /*
    The whole point of honouring the mass rather than classifying objects: everything on a
    track sorts by its own weight without anybody deciding what it is.

    3 lb cone, 500 lb car, 1,000 lb bale, 2,500 lb fence, 4,000 lb lamp post, 18,000 lb head.
  */
  const masses = [0.093243, 15.5405, 31.081, 77.7025, 124.324, 559.4579];
  const travelled = masses.map((m) => shove(m).travelled);
  for (let i = 1; i < travelled.length; i++) {
    assert.ok(travelled[i] <= travelled[i - 1],
      `mass ${masses[i]} travelled ${travelled[i].toFixed(2)} ft, further than the lighter ${masses[i - 1]} at ${travelled[i - 1].toFixed(2)} ft`);
  }
  // A 500 lb car shifts usefully; an 18,000 lb stone head takes a fraction of the same hit.
  assert.ok(travelled[1] > 10, `a car moved only ${travelled[1].toFixed(1)} ft`);
  assert.ok(travelled[5] < travelled[1] / 3,
    `a stone head moved ${travelled[5].toFixed(1)} ft against a car's ${travelled[1].toFixed(1)} ft`);
});

test("something heavier than the truck barely notices", () => {
  const head = shove(559.4579).travelled;
  const car = shove(15.5405).travelled;
  assert.ok(head < car / 5, `a stone head moved ${head.toFixed(2)} ft, too close to a car's ${car.toFixed(1)} ft`);
});

test("a shoved object comes to rest rather than sliding for ever", () => {
  const colliders = createColliders(trackWith(15.5405), flatFrame());
  const solid = colliders.solids[0];
  colliders.push(solid, { x: 400, y: 0, z: 0 });
  for (let i = 0; i < 10 * 120; i++) colliders.step(1 / 120);
  const speed = Math.hypot(solid.velocity.x, solid.velocity.y, solid.velocity.z);
  assert.equal(speed, 0, `still drifting at ${speed.toFixed(3)} ft/s after 10 s`);
});

test("a struck object cannot go to sleep above the terrain", () => {
  const colliders = createColliders(trackWith(15.5405), flatFrame());
  const solid = colliders.solids[0];
  colliders.push(solid, { x: 0, y: 500, z: 0 });
  // At the top of its arc the speed can be tiny for one physics step.
  solid.offset.y = 12;
  solid.velocity = { x: 0, y: 0, z: 0 };
  colliders.step(1 / 120);
  assert.ok(solid.velocity.y < 0, "gravity must still act at the top of the arc");
  for (let i = 0; i < 240; i++) colliders.step(1 / 120);
  const base = solid.centre.y + solid.offset.y + solid.bottom;
  assert.ok(base <= GROUND_FT + 0.05, `object froze ${base - GROUND_FT} ft above ground`);
});

test("a moved object collides where it now is, not where it started", () => {
  /*
    The failure this prevents is subtle and very confusing to drive into: an object that has
    been pushed aside leaves an invisible copy of itself behind, because the collision test
    still uses the authored centre.
  */
  const colliders = createColliders(trackWith(0.093243), flatFrame());
  const solid = colliders.solids[0];
  const start = { ...solid.centre };

  colliders.push(solid, { x: TRUCK_MASS_SLUGS * 5, y: 0, z: 0 });
  for (let i = 0; i < 30; i++) colliders.step(1 / 120);
  assert.ok(Math.abs(solid.offset.x) > 5, "the fixture should have moved it");

  assert.equal(colliders.contactAt(start), null, "nothing should remain where it started");
  const moved = { x: start.x + solid.offset.x, y: start.y + solid.offset.y, z: start.z + solid.offset.z };
  assert.ok(colliders.contactAt(moved), "it should collide where it now stands");
});

/*
  Which way the top of an object leans, along the axis the hit came from.

  Positive means it went over in the direction the truck was travelling; negative means it came
  down back over the truck. This is the x component of the object's own up axis once tilted.
*/
function leanX(solid) {
  const q = solid.tilt;
  return 2 * (q.x * q.y - q.z * q.w);
}

/** A lamp post: 4,000 lb, 21 ft tall, standing on a 2.7 ft footprint. */
function knockPost(hitHeight, strength = 8) {
  const colliders = createColliders(
    trackWith(124.324, { width: 4, length: 4, height: 16, altitude: 55.33 }), flatFrame());
  const solid = colliders.solids[0];
  const hit = { x: solid.centre.x, y: GROUND_FT + hitHeight, z: solid.centre.z };
  colliders.push(solid, { x: TRUCK_MASS_SLUGS * strength, y: 0, z: 0 }, hit);
  for (let i = 0; i < 4 * 120; i++) colliders.step(1 / 120);
  return solid;
}

test("a lamp post hit near its top goes over the way the truck was going", () => {
  /*
    TPARK's lamp posts and wooden guard rails are 4,000 lb, far too heavy to throw, and they
    still come down: a tall thing's weight leaves its own narrow footprint after a few degrees
    and gravity does the rest.
  */
  const post = knockPost(18);
  assert.equal(post.fallen, true, `the post only reached ${tiltDegrees(post).toFixed(0)} degrees`);
  assert.ok(leanX(post) > 0.3, `it should fall away from the truck, lean ${leanX(post).toFixed(2)}`);
});

test("a lamp post hit at bumper height comes down over the truck", () => {
  /*
    The other way round, and the reason the contact POINT is passed to push() at all: a blow
    below an object's centre of mass rotates the top towards whatever hit it. Anyone who has
    seen a car take out a signpost has seen this.
  */
  const post = knockPost(0.5);
  assert.equal(post.fallen, true, "a post hit at the bumper still goes over");
  assert.ok(leanX(post) < -0.3, `it should fall towards the truck, lean ${leanX(post).toFixed(2)}`);
});

test("a gentle nudge leaves a lamp post standing", () => {
  // Below the tipping point the ground holds it up, so not every touch flattens the scenery.
  const post = knockPost(12, 2);
  assert.equal(post.fallen, false, `a light touch tipped it ${tiltDegrees(post).toFixed(0)} degrees`);
  assert.ok(tiltDegrees(post) < 10, "and it settles back upright");
});

test("a wide low object rocks and settles back upright", () => {
  /*
    The other half of the rule: a boulder is as heavy as a post and does not fall over, because
    its weight stays over its own footprint. Same code, different shape.
  */
  const rock = trackWith(124.324, { width: 24, length: 24, height: 8, altitude: 52.67 });
  const colliders = createColliders(rock, flatFrame());
  const solid = colliders.solids[0];
  const hit = { x: solid.centre.x, y: GROUND_FT + 4, z: solid.centre.z };

  colliders.push(solid, { x: TRUCK_MASS_SLUGS * 8, y: 0, z: 0 }, hit);
  for (let i = 0; i < 6 * 120; i++) colliders.step(1 / 120);

  assert.equal(solid.fallen, false, "a boulder does not topple");
  assert.ok(tiltDegrees(solid) < 10, `it should settle back upright, ended at ${tiltDegrees(solid).toFixed(0)} degrees`);
});
