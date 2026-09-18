/*
  Tests for checkpoint order and lap timing.

  Run with: node --test tests/

  The rules being pinned down here are the ones that decide whether a lap counts, which is the
  part of a racing game players notice instantly when it is wrong:

    - only the NEXT gate counts, so a course that passes near an earlier gate does not skip
    - the first gate starts the clock rather than completing a lap
    - a lap completes when the sequence wraps back to the first gate
    - a type 6 box is the trigger, and it is never solid (the colliders handle the separate
      solid boxes that stand at its base)
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpoints } from "../src/drive/checkpoints.js";

const GRID = 64;
const CELL = 64;
const WORLD = GRID * CELL;

function track(boxes) {
  return { terrain: { gridSize: GRID, cellSize: CELL, heightScale: 3 }, boxes };
}

/** A checkpoint box at editor (x, y) on the ground, in sequence order of appearance. */
function gate(x, y, sequence, altitude = 50) {
  return {
    position: [x, y, altitude], theta: 0, phi: 0, psi: 0,
    width: 32, length: 32, height: 32, type: 6, mass: 0, modelName: "",
    checkpointSequence: sequence,
  };
}

/** Where that gate sits in the sim's feet. */
function gateFeet(x, y, altitude = 50) {
  return { x: x / 2, y: altitude * 3 / 1.5, z: (WORLD - y) / 2 };
}

test("a track with no checkpoints has no tracker", () => {
  assert.equal(createCheckpoints(track([])), null);
  // A solid box is not a checkpoint.
  assert.equal(createCheckpoints(track([{ position: [100, 100, 50], type: 0, width: 32, length: 32, height: 32 }])), null);
});

test("gates are ordered by the sequence the file gives them", () => {
  // Deliberately out of order in the array; the sequence numbers are what count.
  const checkpoints = createCheckpoints(track([
    gate(3000, 1000, 2), gate(1000, 1000, 0), gate(2000, 1000, 1),
  ]));
  assert.equal(checkpoints.gateCount, 3);
  assert.deepEqual(checkpoints.gates.map((g) => g.sequence), [0, 1, 2]);
  assert.ok(Math.abs(checkpoints.gates[0].centre.x - 500) < 0.01, "first gate should be the x=1000 one");
});

test("the first gate starts the clock, and a lap completes on the wrap", () => {
  const checkpoints = createCheckpoints(track([
    gate(1000, 1000, 0), gate(2000, 1000, 1), gate(3000, 1000, 2),
  ]));
  const away = { x: 0, y: 100, z: 0 };
  const at = (n) => gateFeet([1000, 2000, 3000][n], 1000);

  // Sitting on the grid, nothing happens and the clock does not run.
  for (let i = 0; i < 10; i++) assert.equal(checkpoints.update(0.1, away), null);
  assert.equal(checkpoints.state.lapTime, 0, "the clock should not run before the first gate");

  const started = checkpoints.update(0.1, at(0));
  assert.ok(started?.started, "passing the first gate starts the lap");
  assert.equal(checkpoints.state.lap, 0);

  // Drive to the second gate, one second later.
  for (let i = 0; i < 10; i++) checkpoints.update(0.1, away);
  assert.ok(checkpoints.update(0.1, at(1)), "second gate should register");
  assert.equal(checkpoints.state.next, 2);

  for (let i = 0; i < 10; i++) checkpoints.update(0.1, away);
  assert.ok(checkpoints.update(0.1, at(2)), "third gate should register");

  // Back to the first: that completes the lap.
  for (let i = 0; i < 10; i++) checkpoints.update(0.1, away);
  const completed = checkpoints.update(0.1, at(0));
  assert.ok(completed?.lapComplete, "returning to the first gate completes the lap");
  assert.equal(checkpoints.state.lap, 1);
  assert.ok(checkpoints.state.lastLap > 3, `lap time ${checkpoints.state.lastLap} should span the driving`);
  assert.equal(checkpoints.state.bestLap, checkpoints.state.lastLap, "the first lap is the best so far");
});

test("only the next gate counts, so a course passing an old one does not skip", () => {
  /*
    The failure this prevents: a circuit that runs back past gate 0 on the way to gate 2 would,
    with an any-gate test, count it and wrap the lap early. Every MTM2 circuit doubles back
    somewhere.
  */
  const checkpoints = createCheckpoints(track([
    gate(1000, 1000, 0), gate(2000, 1000, 1), gate(3000, 1000, 2),
  ]));
  checkpoints.update(0.1, gateFeet(1000, 1000));   // start
  assert.equal(checkpoints.state.next, 1);

  // Drive back over gate 0 and over gate 2, neither of which is the one being looked for.
  assert.equal(checkpoints.update(0.1, gateFeet(1000, 1000)), null, "gate 0 again should not count");
  assert.equal(checkpoints.update(0.1, gateFeet(3000, 1000)), null, "gate 2 out of order should not count");
  assert.equal(checkpoints.state.next, 1, "still waiting for gate 1");
  assert.equal(checkpoints.state.lap, 0);
});

test("a gate is missed when the truck passes well clear of it", () => {
  const checkpoints = createCheckpoints(track([gate(1000, 1000, 0), gate(2000, 1000, 1)]));
  const centre = gateFeet(1000, 1000);
  // Far to the side: outside the radius plus tolerance.
  assert.equal(checkpoints.update(0.1, { ...centre, x: centre.x + 60 }), null);
  // Far above: a truck on a bridge over the gate has not driven through it.
  assert.equal(checkpoints.update(0.1, { ...centre, y: centre.y + 60 }), null);
  // Close enough counts, including a driver who clipped the edge.
  assert.ok(checkpoints.update(0.1, { ...centre, x: centre.x + 18 }), "clipping the edge should still pass");
});

test("the best lap keeps the quickest, and reset clears everything", () => {
  const checkpoints = createCheckpoints(track([gate(1000, 1000, 0), gate(2000, 1000, 1)]));
  const a = gateFeet(1000, 1000);
  const b = gateFeet(2000, 1000);
  const away = { x: 0, y: 100, z: 0 };

  checkpoints.update(0.1, a);                       // start
  checkpoints.update(0.1, b);
  for (let i = 0; i < 50; i++) checkpoints.update(0.1, away);  // a slow 5 s lap
  checkpoints.update(0.1, a);
  const slow = checkpoints.state.lastLap;

  checkpoints.update(0.1, b);
  for (let i = 0; i < 10; i++) checkpoints.update(0.1, away);  // a quick 1 s lap
  checkpoints.update(0.1, a);

  assert.equal(checkpoints.state.lap, 2);
  assert.ok(checkpoints.state.lastLap < slow, "the second lap was quicker");
  assert.ok(checkpoints.state.bestLap < slow, "the best lap should be the quicker one");

  checkpoints.reset();
  assert.deepEqual(
    { lap: checkpoints.state.lap, best: checkpoints.state.bestLap, next: checkpoints.state.next },
    { lap: 0, best: null, next: 0 }
  );
});
