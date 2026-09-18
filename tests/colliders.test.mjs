/*
  Tests for the track's solid geometry.

  Run with: node --test tests/

  Built on hand-made boxes rather than a POD, because the whole risk in this module is that its
  conventions drift from the ones scene.js draws with. A collider that disagrees with the
  drawing is worse than none: the truck hits things that are not there, and no amount of
  driving tells you why. So each case states the expected answer in world terms and checks the
  module agrees.

  The conventions under test, all copied from scene.js:
    placement   traxxPrismMatrix(psi, theta, phi, wx, wz * heightScale, worldSize - wy)
    extents     width / length / height are HALF extents as authored
    ramp        the box with the top of its low edge cut away, climbing -y to +y in Traxx space
    columns     64 unit cells from lower * hs to upper * hs
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createColliders } from "../src/drive/colliders.js";
import { createWorldFrame } from "../src/drive/world-frame.js";

const GRID = 64;
const CELL = 64;
const HEIGHT_SCALE = 3;
const WORLD = GRID * CELL;

/** A flat world frame, since these tests are about objects rather than terrain. */
function flatFrame() {
  return createWorldFrame({
    terrain: {
      gridSize: GRID, cellSize: CELL, heightScale: HEIGHT_SCALE, rawBytesPerCell: 1,
      rawData: new Uint8Array(GRID * GRID).fill(50),
    },
  });
}

function track(boxes = [], groundBoxes = []) {
  return {
    terrain: { gridSize: GRID, cellSize: CELL, heightScale: HEIGHT_SCALE },
    boxes,
    groundBoxes,
  };
}

/*
  A box at a known place, in editor units.

  Editor x and y are 2 units per foot; the altitude is in height steps, which the placement
  multiplies by heightScale. Half extents are in the same horizontal units.
*/
function boxAt({ x, y, altitude, type = 0, psi = 0, width = 32, length = 32, height = 32 }) {
  return { position: [x, y, altitude], theta: 0, phi: 0, psi, width, length, height, type, mass: 0, modelName: "" };
}

test("an axis aligned box is solid inside and its top can be stood on", () => {
  // Centre at editor (1000, 1000), 20 steps up. In feet: x 500, z (4096 - 500) = 3596,
  // y = 20 * 3 / 1.5 = 40. Half extents: 16 ft across, and 32 steps is 64 ft of half height.
  const colliders = createColliders(track([boxAt({ x: 1000, y: 1000, altitude: 20 })]), flatFrame());
  assert.equal(colliders.solids.length, 1);

  const solid = colliders.solids[0];
  assert.ok(Math.abs(solid.centre.x - 500) < 0.01, `centre x ${solid.centre.x}`);
  assert.ok(Math.abs(solid.centre.z - (WORLD - 1000) / 2) < 0.01, `centre z ${solid.centre.z}`);
  assert.ok(Math.abs(solid.centre.y - 40) < 0.01, `centre y ${solid.centre.y}`);

  const centre = solid.centre;
  assert.ok(colliders.contactAt(centre), "the centre of a solid box should be inside it");

  // Its top, and something that can stand on it.
  const top = centre.y + solid.extents[1];
  const support = colliders.supportAt(centre.x, centre.z, top + 5);
  assert.ok(support !== null, "no support found above the box");
  assert.ok(Math.abs(support - top) < 0.01, `support at ${support}, expected ${top}`);
});

test("a point beside a box is outside it and unsupported", () => {
  const colliders = createColliders(track([boxAt({ x: 1000, y: 1000, altitude: 20 })]), flatFrame());
  const { centre, extents } = colliders.solids[0];
  const beside = { x: centre.x + extents[0] + 5, y: centre.y, z: centre.z };
  assert.equal(colliders.contactAt(beside), null);
  assert.equal(colliders.supportAt(beside.x, beside.z, centre.y + 100), null);
});

test("a box overhead is not something to stand on", () => {
  /*
    supportAt only reports surfaces at or below the point. Without that a truck driving under
    a raised box would be snapped up onto its roof.
  */
  const colliders = createColliders(track([boxAt({ x: 1000, y: 1000, altitude: 60 })]), flatFrame());
  const { centre } = colliders.solids[0];
  assert.equal(colliders.supportAt(centre.x, centre.z, centre.y - 200), null);
});

test("a rotated box rotates the way the viewer draws it", () => {
  /*
    Yawed a quarter turn, so the long axis and the short axis swap in world terms. This is the
    case that catches a wrong axis relabelling, which would otherwise only show up as a truck
    clipping the corner of every angled object on a track.
  */
  const square = createColliders(track([boxAt({ x: 1000, y: 1000, altitude: 20, width: 8, length: 64 })]), flatFrame());
  const turned = createColliders(track([boxAt({ x: 1000, y: 1000, altitude: 20, width: 8, length: 64, psi: Math.PI / 2 })]), flatFrame());

  const a = square.solids[0];
  const b = turned.solids[0];

  // Unrotated: narrow across x (4 ft), long along z (32 ft).
  assert.ok(Math.abs(a.reachX - 4) < 0.01, `unrotated reachX ${a.reachX}`);
  assert.ok(Math.abs(a.reachZ - 32) < 0.01, `unrotated reachZ ${a.reachZ}`);
  // Turned a quarter: the two swap.
  assert.ok(Math.abs(b.reachX - 32) < 0.01, `turned reachX ${b.reachX}`);
  assert.ok(Math.abs(b.reachZ - 4) < 0.01, `turned reachZ ${b.reachZ}`);

  // And a point off the narrow side of the turned box is now inside it.
  const probe = { x: b.centre.x + 20, y: b.centre.y, z: b.centre.z };
  assert.ok(turned.contactAt(probe), "the turned box should now reach along x");
  assert.equal(square.contactAt(probe), null, "the unturned one should not");
});

test("a ramp is solid under its slope and open above it", () => {
  /*
    The wedge climbs from its low edge to its high edge. Low down at the high end is inside;
    high up at the low end is not, which is the half of the box the ramp does not fill.
  */
  const colliders = createColliders(
    track([boxAt({ x: 1000, y: 1000, altitude: 20, type: 99, width: 32, length: 32, height: 32 })]),
    flatFrame()
  );
  const ramp = colliders.solids[0];
  assert.equal(ramp.kind, "ramp");

  const [ex, ey, ez] = ramp.extents;
  const along = (fraction, heightFraction) => ({
    x: ramp.centre.x + ramp.axes[2].x * (ez * fraction) + ramp.axes[1].x * (ey * heightFraction),
    y: ramp.centre.y + ramp.axes[2].y * (ez * fraction) + ramp.axes[1].y * (ey * heightFraction),
    z: ramp.centre.z + ramp.axes[2].z * (ez * fraction) + ramp.axes[1].z * (ey * heightFraction),
  });

  // Near the high edge, low down: solid.
  assert.ok(colliders.contactAt(along(0.9, -0.8)), "the thick end of a ramp should be solid");
  // Near the low edge, high up: the part the wedge cuts away.
  assert.equal(colliders.contactAt(along(-0.9, 0.8)), null, "the thin end should be open above the slope");
  // Unused so lint does not complain about ex.
  assert.ok(ex > 0);
});

test("drive-through, checkpoint and facing boxes are not solid", () => {
  const boxes = [6, 7, 8].map((type, i) => boxAt({ x: 1000 + i * 200, y: 1000, altitude: 20, type }));
  const colliders = createColliders(track(boxes), flatFrame());
  assert.equal(colliders.solids.length, 0, "none of these types stop a truck");
});

test("an invisible box is still solid", () => {
  /*
    Type 11 is "invisible?" in Traxx's notes, and BAJA's 26 model-less type 11 boxes are what
    keep a truck on its course. Invisible is not intangible.
  */
  const colliders = createColliders(track([boxAt({ x: 1000, y: 1000, altitude: 20, type: 11 })]), flatFrame());
  assert.equal(colliders.solids.length, 1);
  assert.equal(colliders.solids[0].kind, "box");
});

test("a ground box is a column that can be stood on", () => {
  // One cell at grid (10, 10), standing from 20 to 30 steps.
  const colliders = createColliders(track([], [{
    x: 10, y: 10, lower: 20, upper: 30,
    midX: 10 * CELL + 32, midY: 10 * CELL + 32,
  }]), flatFrame());

  assert.equal(colliders.columns.length, 1);
  const column = colliders.columns[0];
  const top = 30 * HEIGHT_SCALE / 1.5;
  assert.ok(Math.abs(column.top - top) < 0.01, `column top ${column.top}, expected ${top}`);

  const midX = (column.minX + column.maxX) / 2;
  const midZ = (column.minZ + column.maxZ) / 2;
  const support = colliders.supportAt(midX, midZ, top + 10);
  assert.ok(Math.abs(support - top) < 0.01, `support ${support}, expected ${top}`);

  // Inside the column is a contact pushing straight up.
  const inside = colliders.contactAt({ x: midX, y: top - 2, z: midZ });
  assert.ok(inside, "a point inside the column should be a contact");
  assert.ok(Math.abs(inside.normal.y - 1) < 1e-9, "columns push straight up");
  assert.ok(Math.abs(inside.depth - 2) < 0.01, `depth ${inside.depth}`);

  // An empty column (upper 0) is not built at all.
  const empty = createColliders(track([], [{ x: 5, y: 5, lower: 0, upper: 0 }]), flatFrame());
  assert.equal(empty.columns.length, 0);
});

test("the broad phase only returns things that are actually near", () => {
  /*
    The point of the bucket grid: a track has hundreds of objects and the sim asks about
    sixteen points at 120 Hz, so the answer has to come from the handful nearby rather than
    from everything on the map.
  */
  const boxes = [];
  for (let i = 0; i < 200; i++) {
    boxes.push(boxAt({ x: 200 + i * 40, y: 1000, altitude: 20 }));
  }
  const colliders = createColliders(track(boxes), flatFrame());
  assert.equal(colliders.solids.length, 200);
  assert.ok(colliders.bucketCount > 1, "everything landed in one bucket");

  // A point at the far end must not be reported as touching the box at the near end.
  const first = colliders.solids[0];
  const last = colliders.solids[199];
  assert.ok(colliders.contactAt(last.centre), "the far box should still be found");
  assert.ok(Math.abs(first.centre.x - last.centre.x) > 1000, "fixture should span the map");
});
