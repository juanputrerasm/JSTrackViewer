/*
  Tests for the CPR road layer: closing the circuit, and the road and walls as drive colliders.

  Run with: node --test tests/

  The synthetic cases are hermetic. The stock cases read a local CPR install and skip
  themselves when it is absent.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { cprSegmentPairs, cprTrackIsClosed, cprVisibleSlots, isDegenerateSlot } from "../src/shared/cpr-track-schema.js";
import { createColliders } from "../src/drive/colliders.js";
import { buildRaceTrackShapes, createRaceTrackSupport } from "../src/drive/racetrack-collider.js";
import { createWorldFrame } from "../src/drive/world-frame.js";
import { parseSitTrack } from "../src/worker/sit-parser.js";
import { hasStockPod, indexStockPod } from "./helpers/stock-pod.mjs";

const CPR_DIR = `${process.env.HOME}/games/cpr`;

/** A 20 point cross section, 4 ft between points, centred on (x, along), at an altitude. */
function section(x, along, altitude, wallTypes = []) {
  const points = Array.from({ length: 20 }, (_, k) => [x - 38 + k * 4, altitude, along]);
  return { points, wallTypes: Array.from({ length: 20 }, (_, k) => wallTypes[k] ?? 0) };
}

/** Sections around a circle, the way a circuit's records run. */
function ring(count, radius, drop = 0) {
  return Array.from({ length: count - drop }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return section(4000 + radius * Math.cos(a), 4000 + radius * Math.sin(a), 200);
  });
}

test("a circuit closes: its last record runs on into its first", () => {
  const surfaces = ring(40, 300);
  assert.equal(cprTrackIsClosed(surfaces), true);
  const pairs = cprSegmentPairs(surfaces);
  assert.equal(pairs.length, surfaces.length);
  assert.deepEqual(pairs.at(-1), [surfaces.length - 1, 0]);
});

test("a point-to-point layout is left open", () => {
  // A straight run: the ends are far apart.
  const straight = Array.from({ length: 10 }, (_, i) => section(2000, 1000 + i * 36, 200));
  assert.equal(cprTrackIsClosed(straight), false);
  assert.equal(cprSegmentPairs(straight).length, straight.length - 1);

  // Most of a circle with a big bite out of it: the ends are near, but not one segment near.
  assert.equal(cprTrackIsClosed(ring(40, 300, 6)), false);
});

test("a last record sitting on the first needs no closing segment", () => {
  const surfaces = ring(40, 300);
  surfaces.push(structuredClone(surfaces[0]));
  assert.equal(cprTrackIsClosed(surfaces), false);
});

test("every stock CPR track closes its circuit", {
  skip: hasStockPod(`${CPR_DIR}/LAGUNA.POD`) ? false : `no local CPR install at ${CPR_DIR}`,
}, () => {
  let checked = 0;
  for (const file of readdirSync(CPR_DIR).filter((name) => name.endsWith(".POD"))) {
    let pod;
    try { pod = indexStockPod(`${CPR_DIR}/${file}`); } catch { continue; }
    const sit = pod.podIndex.entries.find((e) => e.title.endsWith(".SIT"));
    if (!sit) continue;
    const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit, "");
    if (!doc.raceTrackSurfaces.length) continue;
    assert.equal(cprTrackIsClosed(doc.raceTrackSurfaces), true, file);
    checked++;
  }
  assert.ok(checked >= 10, `${checked} tracks`);
});

/*
  A straight three-record road at 200 ft altitude over flat terrain at 180 ft, with a wall on
  its last cross section point.
*/
function straightTrack() {
  const surfaces = Array.from({ length: 3 }, (_, i) => section(2000, 1000 + i * 36, 200, { 19: 1 }));
  const raw = new Uint8Array(256 * 256).fill(90);          // 90 steps, 180 ft
  return {
    origin: "CPR",
    terrain: { gridSize: 256, cellSize: 64, heightScale: 3, rawBytesPerCell: 1, rawData: raw },
    raceTrackSurfaces: surfaces,
    boxes: [],
  };
}

test("the road carries a wheel at its own altitude, above the terrain", () => {
  const trackData = straightTrack();
  const frame = createWorldFrame(trackData);
  const colliders = createColliders(trackData, frame);
  const worldFeet = 256 * 64 / 2;
  // Middle of the road, halfway along the first segment. Scene z = ws - 2 * along.
  const x = 2000, z = worldFeet - 1018;
  assert.ok(Math.abs(frame.heightAtFeet(x, z) - 180) < 1e-9);
  const support = colliders.supportAt(x, z, 210);
  assert.ok(support !== null && Math.abs(support - 200) < 1e-6, `support ${support}`);
  // Nothing to stand on beside the road.
  assert.equal(colliders.supportAt(x + 200, z, 210), null);
  // The pre-drive placement sees the same surface.
  assert.ok(Math.abs(createRaceTrackSupport(trackData).supportAt(x, z, 210) - 200) < 1e-6);
});

test("ground poking up through the road is held under it, as the road is drawn over it", () => {
  const trackData = straightTrack();
  trackData.terrain.rawData = new Uint8Array(256 * 256).fill(105);   // 210 ft, above the road
  const frame = createWorldFrame(trackData);
  const worldFeet = 256 * 64 / 2;
  const x = 2000, z = worldFeet - 1018;
  // Under the road the ground sits just below the tarmac, flat, so the road carries the truck.
  const under = frame.heightAtFeet(x, z);
  assert.ok(under < 200 && under > 199, `ground under road ${under}`);
  assert.deepEqual(frame.normalAtFeet(x, z), { x: 0, y: 1, z: 0 });
  // Beside the road the ground is untouched.
  assert.ok(Math.abs(frame.heightAtFeet(x + 200, z) - 210) < 1e-9);
  // Ground already below the road is left where it is.
  trackData.terrain.rawData = new Uint8Array(256 * 256).fill(90);
  assert.ok(Math.abs(createWorldFrame(trackData).heightAtFeet(x, z) - 180) < 1e-9);
});

test("a wall stops a hull point going through it, and faces the truck", () => {
  const trackData = straightTrack();
  const colliders = createColliders(trackData, createWorldFrame(trackData));
  const worldFeet = 256 * 64 / 2;
  const wallX = 2000 - 38 + 19 * 4;                          // point 19, 2038 ft
  const z = worldFeet - 1018;
  const hit = colliders.contactAt({ x: wallX + 1, y: 202, z }, { x: wallX - 4, y: 204, z });
  assert.ok(hit, "wall contact");
  assert.ok(hit.normal.x < -0.99, `normal ${JSON.stringify(hit.normal)}`);
  assert.ok(Math.abs(hit.depth - 1) < 1e-6);
  // Over the top of a 4.5 ft wall is clear.
  assert.equal(colliders.contactAt({ x: wallX + 1, y: 206, z }, { x: wallX - 4, y: 206, z }), null);
});

test("Laguna: one road collider per drawn segment, the closing one included", {
  skip: hasStockPod(`${CPR_DIR}/LAGUNA.POD`) ? false : `no local CPR install at ${CPR_DIR}`,
}, () => {
  const pod = indexStockPod(`${CPR_DIR}/LAGUNA.POD`);
  const sit = pod.podIndex.entries.find((e) => e.title.endsWith(".SIT"));
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit, "");
  const trackData = { ...doc, terrain: { ...doc.terrain, heightScale: 3 } };
  const shapes = buildRaceTrackShapes(trackData);
  assert.equal(shapes.length, doc.raceTrackSurfaces.length);

  // The start/finish gap is solid road: halfway between the last and first records.
  const road = createRaceTrackSupport(trackData);
  const last = doc.raceTrackSurfaces.at(-1).points[9];
  const first = doc.raceTrackSurfaces[0].points[9];
  const worldFeet = 256 * 64 / 2;
  const x = (Math.trunc(last[0]) + Math.trunc(first[0])) / 2;
  const z = worldFeet - (Math.trunc(last[2]) + Math.trunc(first[2])) / 2;
  const altitude = (last[1] + first[1]) / 2;
  const support = road.supportAt(x, z, altitude + 5);
  assert.ok(support !== null && Math.abs(support - altitude) < 1, `support ${support} vs ${altitude}`);
});

test("the layer is drawn between its outermost walls and nowhere beyond", () => {
  // Walls at the shoulders, points 3 and 16: slots 3..15 are drawn.
  assert.deepEqual(cprVisibleSlots(section(2000, 1000, 200, { 3: 1, 16: 1 })), { first: 3, last: 15 });
  // A pit wall nearer the median does not move the clip while a shoulder wall is outside it.
  assert.deepEqual(cprVisibleSlots(section(2000, 1000, 200, { 3: 1, 7: 1, 16: 1 })), { first: 3, last: 15 });
  // No walls: the whole section, as before.
  assert.deepEqual(cprVisibleSlots(section(2000, 1000, 200)), { first: 0, last: 18 });
});

test("nothing beyond a wall is solid either", () => {
  const surfaces = Array.from({ length: 3 }, (_, i) => section(2000, 1000 + i * 36, 200, { 3: 1, 16: 1 }));
  const raw = new Uint8Array(256 * 256).fill(90);
  const trackData = {
    origin: "CPR",
    terrain: { gridSize: 256, cellSize: 64, heightScale: 3, rawBytesPerCell: 1, rawData: raw },
    raceTrackSurfaces: surfaces, boxes: [],
  };
  const road = createRaceTrackSupport(trackData);
  const z = 256 * 64 / 2 - 1018;
  // Point k is at x = 1962 + 4k: inside the walls (between points 3 and 16) there is road...
  assert.ok(Math.abs(road.supportAt(1962 + 4 * 9.5, z, 210) - 200) < 1e-6);
  // ...and outside them, between points 1 and 2 or 17 and 18, there is none.
  assert.equal(road.supportAt(1962 + 4 * 1.5, z, 210), null);
  assert.equal(road.supportAt(1962 + 4 * 17.5, z, 210), null);
});

test("the wall clip never hides a curb or road slot on any stock CPR track", {
  skip: hasStockPod(`${CPR_DIR}/LAGUNA.POD`) ? false : `no local CPR install at ${CPR_DIR}`,
}, () => {
  let segments = 0;
  for (const file of readdirSync(CPR_DIR).filter((name) => name.endsWith(".POD"))) {
    let pod;
    try { pod = indexStockPod(`${CPR_DIR}/${file}`); } catch { continue; }
    const sit = pod.podIndex.entries.find((e) => e.title.endsWith(".SIT"));
    if (!sit) continue;
    const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit, "");
    doc.raceTrackSurfaces.forEach((surface, index) => {
      segments++;
      const { first, last } = cprVisibleSlots(surface);
      for (let lane = 0; lane < 19; lane++) {
        if ((lane >= first && lane <= last) || isDegenerateSlot(surface, lane)) continue;
        assert.equal(surface.segmentTypes[lane] ?? 0, 0, `${file} segment ${index} slot ${lane}`);
      }
    });
  }
  assert.ok(segments > 1000);
});

test("CPR track types use CPREDIT's names, not MTM2's", {
  skip: hasStockPod(`${CPR_DIR}/LAGUNA.POD`) ? false : `no local CPR install at ${CPR_DIR}`,
}, () => {
  const expected = {
    "LAGUNA.POD": "ROAD", "ELKHART.POD": "ROAD", "CALI.POD": "SPEEDWAY", "MICHIGAN.POD": "SPEEDWAY",
    "MILWAUKE.POD": "SHORT OVAL", "NAZ.POD": "SHORT OVAL", "TORONTO.POD": "STREET", "VANCVR.POD": "STREET",
  };
  for (const [file, type] of Object.entries(expected)) {
    if (!hasStockPod(`${CPR_DIR}/${file}`)) continue;
    const pod = indexStockPod(`${CPR_DIR}/${file}`);
    const sit = pod.podIndex.entries.find((e) => e.title.endsWith(".SIT"));
    assert.equal(parseSitTrack(pod.podIndex, pod.getBytes, sit, "").trackType, type, file);
  }
});

test("CPR cones and marker boards get MTM2's weights, so a truck can knock them about", {
  skip: hasStockPod(`${CPR_DIR}/LAGUNA.POD`) ? false : `no local CPR install at ${CPR_DIR}`,
}, () => {
  const pod = indexStockPod(`${CPR_DIR}/LAGUNA.POD`);
  const sit = pod.podIndex.entries.find((e) => e.title.endsWith(".SIT"));
  const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit, "");
  const cones = doc.boxes.filter((b) => b.modelName === "LG4CONE.BIN");
  const markers = doc.boxes.filter((b) => /^LG3MIL[1-4]\.BIN$/.test(b.modelName));
  assert.ok(cones.length && cones.every((b) => b.mass === 0.093243));
  assert.ok(markers.length && markers.every((b) => b.mass === 7.770249));
  // Everything else keeps the file's mass 0, so a tent or a walkway stays put.
  assert.ok(doc.boxes.filter((b) => /TENT|WLK/.test(b.modelName)).every((b) => b.mass === 0));
});

test("CPR checkpoints: three pit gates, then start/finish, then the lap's gates", {
  skip: hasStockPod(`${CPR_DIR}/LAGUNA.POD`) ? false : `no local CPR install at ${CPR_DIR}`,
}, async () => {
  const { createCheckpoints } = await import("../src/drive/checkpoints.js");
  let tracks = 0;
  for (const file of readdirSync(CPR_DIR).filter((name) => name.endsWith(".POD"))) {
    let pod;
    try { pod = indexStockPod(`${CPR_DIR}/${file}`); } catch { continue; }
    const sit = pod.podIndex.entries.find((e) => e.title.endsWith(".SIT"));
    if (!sit) continue;
    const doc = parseSitTrack(pod.podIndex, pod.getBytes, sit, "");
    const checkpoints = doc.boxes.filter((b) => b.type === 6).sort((a, b) => a.checkpointSequence - b.checkpointSequence);
    assert.deepEqual(checkpoints.slice(0, 4).map((b) => b.checkpointRole),
      ["pitEntry", "pitSpeedLimit", "pitSpeedLimitEnd", "startFinish"], file);
    assert.ok(checkpoints.slice(4).every((b) => b.checkpointRole === "gate"), file);

    // The lap counts start/finish and the ordinary gates only, starting at start/finish.
    const lap = createCheckpoints({ ...doc, terrain: { ...doc.terrain, heightScale: 3 } });
    assert.equal(lap.gateCount, checkpoints.length - 3, file);
    assert.equal(lap.gates[0].sequence, 3, file);
    tracks++;
  }
  assert.ok(tracks >= 10);
});

test("a CPR track with fewer than four checkpoints has no pit roles", () => {
  // cprCheckpointRole is the rule the SIT reader applies to each checkpoint.
  return import("../src/shared/cpr-track-schema.js").then(({ cprCheckpointRole }) => {
    assert.equal(cprCheckpointRole(0, 3), "gate");
    assert.equal(cprCheckpointRole(0, 6), "pitEntry");
    assert.equal(cprCheckpointRole(3, 6), "startFinish");
    assert.equal(cprCheckpointRole(5, 6), "gate");
  });
});
