import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenMtm2Sim, simGroundBoxes } from '../src/drive/openmtm2-sim.js';
import * as S from '../src/vendor/openphotex/sim/mtm2/index.js';
import { createWorldFrame } from '../src/drive/world-frame.js';
import { createColliders } from '../src/drive/colliders.js';

const dt = 1 / 120;
const assembly = {
  wheels: ['faxle.rtire', 'faxle.ltire', 'raxle.rtire', 'raxle.ltire'].map((key, i) => ({
    key: `${key}.static_bpos`, position: { x: i % 2 ? -4.29 : 4.29, y: -3.8, z: i < 2 ? 6.1 : -5.5 }, radius: 3,
  })),
  scrapePoints: [{ x: -3, y: -2.5, z: 9 }, { x: 3, y: -2.5, z: 9 },
    { x: -3, y: 3, z: 9 }, { x: 3, y: 3, z: 9 },
    { x: -3, y: 3, z: -9 }, { x: 3, y: 3, z: -9 },
    { x: -3, y: -2.5, z: -9 }, { x: 3, y: -2.5, z: -9 }],
};
const flat = { heightAtFeet: () => 100, normalAtFeet: () => ({ x: 0, y: 1, z: 0 }), surfaceAtFeet: () => 200 };
function make(frame = flat, options, truck = assembly) {
  const sim = createOpenMtm2Sim(truck, frame, options);
  sim.reset({ x: 200, y: 106.8, z: 200 });
  return sim;
}
function run(sim, seconds, input = {}) {
  for (let i = 0; i < Math.round(seconds / dt); i++) sim.step(dt, input);
  const s = sim.readState();
  assert.ok([...Object.values(s.ipos), s.speed, s.rpm].every(Number.isFinite));
  return s;
}
function close(a, b, epsilon = 1e-8) { assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`); }

test('adapter matches OpenMTM2 step/control/post-step sequence on flat terrain', () => {
  const sim = make();
  const p = S.createTruckParams({ wheelAnchors: assembly.wheels.map((w) => Object.values(w.position)), scrapePoints: assembly.scrapePoints.map(Object.values) });
  const s = S.createTruckState([200, 106.8, -200], 0, S.GEAR.FIRST, p);
  const ground = { height: () => 100, normal: (_x, _z, out) => { out[0] = 0; out[1] = 1; out[2] = 0; return out; }, surface: () => 200, weather: 0, waterLevelFt: null };
  for (let i = 0; i < 1200; i++) {
    const accelerate = i >= 240, right = i >= 900;
    S.applyKeyboard(s.controls, { accelerate, right }, { dt, autoShift: true, forwardSpeed: s.bvel[2], dragMode: false, segments: 0 });
    S.stepTruck(s, p, { ground, human: true, difficulty: p.difficulty, sonicTrack: false }, dt);
    S.postStepTruck(s, p, ground, dt);
    sim.step(dt, { throttle: +accelerate, steer: +right });
  }
  const actual = sim.readState();
  close(actual.ipos.x, s.pos[0]); close(actual.ipos.y, s.pos[1]); close(actual.ipos.z, -s.pos[2]);
  close(actual.rpm, s.rpm); close(actual.psi, s.euler[2]);
});

test('settles, accelerates along all four viewer headings, and shifts automatically', () => {
  for (const psi of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const sim = make(); sim.reset({ x: 200, y: 106.8, z: 200 }, psi);
    const rest = run(sim, 4);
    assert.ok(rest.speed < 0.1); assert.ok(rest.wheels.every((w) => w.on_gnd));
    const go = run(sim, 7, { throttle: 1 });
    assert.ok(go.gear > 1);
    assert.ok((go.ipos.x - 200) * Math.sin(psi) - (go.ipos.z - 200) * Math.cos(psi) > 100);
  }
});

test('automatic reverse, handbrake and manual gears retain viewer controls', () => {
  const sim = make(); run(sim, 3);
  const parked = run(sim, 1, { brake: 1, handbrake: true });
  assert.equal(parked.gear, 1); assert.ok(parked.speed < 0.1);
  const reverse = run(sim, 2, { brake: 1 });
  assert.equal(reverse.gear, -1); assert.ok(reverse.ipos.z > 205);
  sim.reset({ x: 200, y: 106.8, z: 200 }); sim.setManual(true);
  assert.ok(sim.shiftDown()); assert.equal(sim.readState().gear, -1);
  assert.ok(sim.shiftUp()); assert.equal(sim.readState().gear, 1);
  assert.ok(sim.shiftUp()); assert.equal(sim.readState().gear, 2);
  run(sim, 2, { throttle: 1 }); run(sim, 0.1);
  assert.equal(sim.physicsState.controls.throttle, 0);
});

test('analog pedals remain proportional and rear steering opposes front steering', () => {
  const low = make(), high = make(); run(low, 3); run(high, 3);
  const a = run(low, 1, { throttle: 0.2, steer: 0.4, analog: true });
  const b = run(high, 1, { throttle: 1, steer: 0.4, analog: true });
  assert.ok(b.speed > a.speed);
  close(low.physicsState.controls.throttle, 0.2);
  assert.ok(a.wheels[0].steering_angle > 0);
  close(a.wheels[2].steering_angle, -0.33 * a.wheels[0].steering_angle);
});

test('masked terrain remains empty space and airborne RPM responds to throttle', () => {
  const sim = make({ ...flat, terrainAtFeet: () => null });
  const s = run(sim, 0.5, { throttle: 1 });
  assert.ok(s.ipos.y < 104); assert.ok(s.airborne); assert.ok(s.rpm > 800);
});

test('bridge support carries the truck but does not pull it through an overhead deck', () => {
  const colliders = { supportAt: (_x, _z, y) => y >= 125 ? 125 : null, surfaceAt: () => 100, contactAt: () => null };
  const under = make(flat, { colliders });
  assert.ok(run(under, 3).ipos.y < 110);
  under.reset({ x: 200, y: 131.8, z: 200 });
  const above = run(under, 3);
  assert.ok(above.ipos.y > 130 && above.ipos.y < 132);
  assert.ok(above.wheels.every((w) => w.surface === 'Cement'));
});

test('surface depth, rain and water are fed to the shared tire and fluid laws', () => {
  const dry = make(), wet = make(flat, { weather: 'rain' });
  run(dry, 3); run(wet, 3);
  assert.ok(wet.physicsState.tires[0].mu < dry.physicsState.tires[0].mu);
  wet.setWeather('clear'); run(wet, 1);
  close(wet.physicsState.tires[0].mu, dry.physicsState.tires[0].mu);
  const deep = make({ ...flat, surfaceAtFeet: () => 212 });
  assert.ok(run(deep, 3).ipos.y < dry.readState().ipos.y - 0.8);
  const water = make(flat, { waterLevelFt: 105 });
  const s = run(water, 3);
  assert.ok(s.wheels.every((w) => w.surface === 'Water'));
  assert.ok(water.physicsState.tires.some((t) => t.waterDepth > 0));
});

test('wheel render order and axle articulation match the assembly and shared state', () => {
  const truck = { ...assembly, wheels: [...assembly.wheels].reverse() };
  const sim = make(flat, {}, truck); run(sim, 3);
  const s = sim.physicsState;
  s.axles[0].articulation = 0.2; s.axles[0].travel = -3;
  const poses = sim.wheelPoses();
  close(poses[3].position.x, 4.29 * Math.cos(0.2));
  close(poses[3].position.y, 4.29 * Math.sin(0.2) - 3);
  close(poses[3].position.z, -6.1);
  close(sim.wheelCompression()[3], poses[3].position.y + 3.8);
  assert.equal(sim.mountPoints()[0].isFront, true);
});

test('velocity and gear survive the truck swap boundary; reset clears motion', () => {
  const sim = make(); sim.reset({ x: 200, y: 110, z: 200 }, Math.PI / 2);
  sim.setVelocity({ x: 40, y: 3, z: -2 }); sim.setGear(3);
  close(sim.velocity.x, 40); close(sim.velocity.y, 3); close(sim.velocity.z, -2);
  assert.equal(sim.readState().gear, 3);
  sim.reset({ x: 200, y: 110, z: 200 });
  assert.equal(sim.readState().speed, 0); assert.equal(sim.readState().gear, 1);
});

test('frame partitions give the same fixed-step trajectory', () => {
  const a = make(), b = make();
  for (let i = 0; i < 240; i++) a.step(1 / 60, { throttle: 1 });
  for (let i = 0; i < 480; i++) b.step(1 / 120, { throttle: 1 });
  close(a.readState().ipos.z, b.readState().ipos.z);
});

test('scenery wall stops the truck and movable objects receive impacts', () => {
  for (const movable of [false, true]) {
    const solid = { movable, mass: 2, velocity: { x: 0, y: 0, z: 0 } };
    let pushed = 0;
    const colliders = {
      supportAt: () => null,
      contactAt: (point) => point.z < 175 && point.z > 150 ? { depth: 175 - point.z, normal: { x: 0, y: 0, z: 1 }, solid } : null,
      push: (_solid, impulse) => { pushed += Math.abs(impulse.z); },
    };
    const sim = make(flat, { colliders }); run(sim, 3);
    sim.setVelocity({ x: 0, y: 0, z: -25 });
    const hit = run(sim, 1);
    if (movable) assert.ok(pushed > 0);
    else { assert.ok(hit.ipos.z > 175); assert.ok(hit.speed < 15); }
  }
});

test('actual viewer ground boxes support driving across a raised deck', () => {
  const track = { terrain: { gridSize: 64, cellSize: 64, heightScale: 3,
    rawBytesPerCell: 1, rawData: new Uint8Array(64 * 64).fill(50) }, boxes: [], groundBoxes: [] };
  for (let x = 20; x < 40; x++) for (let y = 0; y < 64; y++) {
    track.groundBoxes.push({ x, y, lower: 0, upper: 51, midX: x * 64 + 32, midY: y * 64 + 32 });
  }
  const frame = createWorldFrame(track), colliders = createColliders(track, frame);
  const groundBoxes = simGroundBoxes(track);
  assert.equal(groundBoxes.stepFt, 2);
  const sim = make(frame, { colliders, groundBoxes });
  sim.reset({ x: 490, y: 106.8, z: 1000 }, Math.PI / 2);
  let maxHeight = 0;
  for (let i = 0; i < 600; i++) {
    sim.step(dt, { throttle: 1 });
    const s = sim.readState();
    maxHeight = Math.max(maxHeight, s.ipos.y);
    assert.ok(Number.isFinite(s.speed));
  }
  assert.ok(sim.readState().ipos.x > 700);
  assert.ok(maxHeight < 115, `launched to ${maxHeight}`);
});

test('rollover remains finite and accumulates the viewer recovery timer', () => {
  const sim = make(); sim.reset({ x: 200, y: 112, z: 200 }, 0, Math.PI);
  const s = run(sim, 3);
  assert.ok(s.invertedFor > 2.5);
  assert.ok(s.ipos.y > 100);
});

import { indexStockPod, skipWithoutStockPod, entryText } from './helpers/stock-pod.mjs';
import { parseTruckManifestText } from '../src/worker/truck/trk-parser.js';
import { assembleTruck } from '../src/worker/truck/truck-assembly.js';

test('stock Bigfoot assembles, lands, steers and brakes with the shared simulation', { skip: skipWithoutStockPod() }, async () => {
  const pod = indexStockPod();
  const text = entryText(pod, (e) => e.normalizedName.startsWith('TRUCK/') && e.title === 'BIGFOOT.TRK');
  const truck = await assembleTruck(pod.podIndex, pod.getBytes, parseTruckManifestText(text));
  const sim = make(flat, {}, truck);
  assert.ok(run(sim, 4).wheels.every((w) => w.on_gnd));
  run(sim, 2, { throttle: 1 });
  const turning = run(sim, 0.5, { throttle: 1, steer: 1 });
  assert.ok(turning.ipos.x > 200);
  const braking = run(sim, 0.5, { brake: 1 });
  assert.ok(braking.speed < turning.speed);
});

test('a broken state is put back as the truck last stood, at rest (OpenMTM2 stateIsSane)', () => {
  const sim = make();
  run(sim, 1);
  const before = sim.readState().ipos;
  sim.physicsState.bvel[0] = NaN;
  sim.step(dt, {});
  const s = sim.readState();
  assert.ok(Number.isFinite(s.speed) && s.rescued === 1);
  assert.ok(Math.abs(s.ipos.x - before.x) < 1 && Math.abs(s.ipos.z - before.z) < 1);
});

test('a drop onto the bump stops reports bottoming; resting on flat ground does not', () => {
  const sim = make();
  run(sim, 2);
  sim.step(dt, {});
  assert.ok(sim.readState().bottoming < 0.01, 'at rest');
  sim.reset({ x: 200, y: 140, z: 200 });
  let most = 0;
  for (let i = 0; i < 240; i++) { sim.step(dt, {}); most = Math.max(most, sim.readState().bottoming); }
  assert.ok(most > 0.3, `landing ${most} ft/s`);
});

test('a ground box taller than a wheel is a wall, met through OpenPhotex (groundBoxesAround)', () => {
  const track = { terrain: { gridSize: 64, cellSize: 64, heightScale: 3,
    rawBytesPerCell: 1, rawData: new Uint8Array(64 * 64).fill(50) }, boxes: [], groundBoxes: [] };
  // A wall of boxes 20 ft tall across x = 640..672 ft.
  for (let y = 0; y < 64; y++) track.groundBoxes.push({ x: 20, y, lower: 0, upper: 60, midX: 20 * 64 + 32, midY: y * 64 + 32 });
  const frame = createWorldFrame(track), colliders = createColliders(track, frame);
  const sim = make(frame, { colliders, groundBoxes: simGroundBoxes(track) });
  sim.reset({ x: 560, y: 106.8, z: 1000 }, Math.PI / 2);
  run(sim, 4, { throttle: 1 });
  const s = sim.readState();
  assert.ok(s.ipos.x < 640 && s.ipos.x > 610, `stopped at ${s.ipos.x}`);
  // The viewer's own collider no longer answers the truck for ground boxes.
  assert.equal(colliders.contactAt({ x: 650, y: 105, z: 1000 }, null, { truck: true }), null);
  assert.ok(colliders.contactAt({ x: 650, y: 105, z: 1000 }));
});

test("fixed scenery's steep faces are OpenPhotex wall faces, facing out of the model", () => {
  const track = { terrain: { gridSize: 64, cellSize: 64, heightScale: 3,
    rawBytesPerCell: 1, rawData: new Uint8Array(64 * 64).fill(50) }, groundBoxes: [],
    origin: 'MTM2', models: {}, boxes: [] };
  // A 40 by 40 by 20 ft block in Traxx units (2 per foot horizontally), wound to face in as a BIN is.
  const c = [];
  for (const z of [0, 60]) for (const y of [-40, 40]) for (const x of [-40, 40]) c.push([x, y, z]);
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const out = [];
  for (const [a, b, d, e] of quads) out.push(...c[a], ...c[d], ...c[b], ...c[a], ...c[e], ...c[d]);
  track.models.BLOCK = { meshes: [{ positions: new Float32Array(out) }], anchor: { x: 0, y: 0, z: 0 } };
  track.boxes.push({ modelName: 'BLOCK', position: [1600, 2000, 50], psi: 0, theta: 0, phi: 0, type: 0, mass: 0 });
  const frame = createWorldFrame(track), colliders = createColliders(track, frame);
  const faces = colliders.wallFaces();
  assert.equal(faces.length, 8, 'four sides of two triangles; top and bottom are not walls');
  const centre = { x: 800, z: (64 * 64 - 2000) / 2 };
  for (const f of faces) {
    const mid = { x: (f.a.x + f.b.x + f.c.x) / 3, z: (f.a.z + f.b.z + f.c.z) / 3 };
    assert.ok(f.outward.x * (mid.x - centre.x) + f.outward.z * (mid.z - centre.z) > 0, 'faces out of the block');
  }
  const sim = make(frame, { colliders });
  sim.reset({ x: 720, y: 106.8, z: centre.z }, Math.PI / 2);
  run(sim, 4, { throttle: 1 });
  assert.ok(sim.readState().ipos.x < 780 && sim.readState().ipos.x > 755, `stopped at ${sim.readState().ipos.x}`);
});
