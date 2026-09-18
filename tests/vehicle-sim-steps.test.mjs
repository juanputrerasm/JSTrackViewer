/*
  Driving onto a ground box should be a bump, not a launch.

  Run with: node --test tests/

  TPARK builds bridges out of ground boxes, and a driver reported the truck being thrown into
  the air by them. The cause is geometric rather than a matter of spring rates: a wheel is a
  single downward ray here, so the top of a box appears the instant the ray crosses its edge,
  and the wheel goes from resting on terrain to a foot inside solid scenery in one step.

  A real wheel climbs a step over its own contact patch: a 3 ft wheel needs about 2.2 ft of
  travel to climb 1 ft, which at 40 mph is around 40 ms rather than 8 ms.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { createColliders } from "../src/drive/colliders.js";
import { createVehicleSim } from "../src/drive/vehicle-sim.js";

const DT = 1 / 120;
const GRID = 64;
const CELL = 64;
const FLAT_STEPS = 50;          // terrain at 100 ft
const GROUND_FT = 100;

/** Terrain that is flat everywhere, with a raised deck of ground boxes beyond a given x. */
function trackWithDeck({ deckTopSteps = 51, fromCellX = 20 } = {}) {
  const groundBoxes = [];
  for (let x = fromCellX; x < fromCellX + 12; x++) {
    for (let y = 0; y < GRID; y++) {
      groundBoxes.push({
        x, y, lower: 0, upper: deckTopSteps,
        midX: x * CELL + CELL / 2, midY: y * CELL + CELL / 2,
      });
    }
  }
  return {
    terrain: {
      gridSize: GRID, cellSize: CELL, heightScale: 3, rawBytesPerCell: 1,
      rawData: new Uint8Array(GRID * GRID).fill(FLAT_STEPS),
    },
    boxes: [],
    groundBoxes,
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

/** Drive at the deck and report what the body did as it crossed the edge. */
function crossTheEdge(deckTopSteps) {
  const track = trackWithDeck({ deckTopSteps });
  const frame = createWorldFrame(track);
  const colliders = createColliders(track, frame);
  const sim = createVehicleSim(assembly(), frame, undefined, colliders);

  const deckX = 20 * CELL / 2;              // the deck starts here, in feet
  const deckTop = deckTopSteps * 2;         // heightScale 3 over 1.5 units per foot
  const start = { x: deckX - 150, z: 1000 };
  sim.reset({ x: start.x, y: GROUND_FT + 6.8, z: start.z }, Math.PI / 2);  // facing +x

  let peakClimbRate = 0;
  let peakHeightOverDeck = -Infinity;
  let airborneSteps = 0;
  let previousY = sim.readState().ipos.y;

  for (let i = 0; i < 10 / DT; i++) {
    sim.step(DT, { throttle: 1, brake: 0, steer: 0 });
    const state = sim.readState();
    // Only judge what happens once the truck is at or past the edge.
    if (state.ipos.x > deckX - 6) {
      const climb = (state.ipos.y - previousY) / DT;
      if (climb > peakClimbRate) peakClimbRate = climb;
      const rideHeight = state.ipos.y - deckTop;
      if (rideHeight > peakHeightOverDeck) peakHeightOverDeck = rideHeight;
      if (state.airborne) airborneSteps++;
    }
    previousY = state.ipos.y;
    if (state.ipos.x > deckX + 120) break;
  }
  return { peakClimbRate, peakHeightOverDeck, airborneSteps };
}

test("a two foot ground box deck is climbed, not launched off", () => {
  /*
    THE NUMBER THAT MATTERS IS THE CLIMB RATE, and the bound has to be tight enough to catch
    the bug it was written for. Before the support height was filtered, the body rose at
    exactly 42.0 ft/s, which is MAX_LIFT_PER_STEP / dt: the anti-clipping correction teleporting
    the truck upward once per step, at the same rate whether the truck was doing 20 mph or 80.
    A loose bound of 30 ft/s let that through in an earlier version of this test.

    With the wheel allowed to climb only as fast as it is travelling, the suspension governs
    the rise instead, and it comes out at about 8 ft/s.
  */
  const { peakClimbRate, peakHeightOverDeck, airborneSteps } = crossTheEdge(51);
  assert.ok(peakClimbRate < 15,
    `the body rose at ${peakClimbRate.toFixed(1)} ft/s crossing a 2 ft step; `
    + `anything near 42 means the lift is teleporting it again`);
  assert.ok(peakHeightOverDeck < 7.5,
    `the truck ended up ${peakHeightOverDeck.toFixed(1)} ft above the deck, so it took off`);
  assert.equal(airborneSteps, 0,
    `all four wheels left the ground for ${(airborneSteps / 120).toFixed(2)}s on a 2 ft step`);
});

test("a taller step is still climbed without a launch", () => {
  const { peakClimbRate, peakHeightOverDeck } = crossTheEdge(52);   // 4 ft
  assert.ok(peakClimbRate < 40, `thrown upward at ${peakClimbRate.toFixed(1)} ft/s by a 4 ft step`);
  assert.ok(peakHeightOverDeck < 10, `ended ${peakHeightOverDeck.toFixed(1)} ft above a 4 ft deck`);
});
