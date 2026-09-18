/*
  Tests for the ported MTM truck manifest parser.

  Run with: node --test tests/

  Two layers. The synthetic cases are hermetic and cover the parsing rules, including the ones
  that only shipped files exercise (NUL padding, the DOS EOF marker). The stock-file case
  reads TRUCK2.POD from a local MTM2 install and skips itself when that is not present, so the
  suite still passes on a machine without the game.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { parseTruckManifestText, WHEEL_KEYS } from "../src/worker/truck/trk-parser.js";

const STOCK_POD = `${process.env.HOME}/games/mtm2/TRUCK2.POD`;

/** Minimal POD1 directory read, enough to pull one TRK out for the stock-file test. */
function readPodEntry(podPath, predicate) {
  const buf = readFileSync(podPath);
  const count = buf.readInt32LE(0);
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 40;
    const field = buf.toString("latin1", base, base + 32);
    const nul = field.indexOf("\0");
    const name = (nul >= 0 ? field.slice(0, nul) : field).trim();
    const entry = {
      name,
      normalizedName: name.replace(/\\/g, "/").toUpperCase(),
      length: buf.readInt32LE(base + 32),
      offset: buf.readInt32LE(base + 36),
    };
    if (predicate(entry)) {
      return buf.subarray(entry.offset, entry.offset + entry.length).toString("latin1");
    }
  }
  return null;
}

const MINIMAL = [
  "MTM2.1 truckName",
  "Example Truck",
  "truckModelBaseName",
  "EXAMPLE",
  "tireModelBaseName",
  "GRNT",
  "axleModelName",
  "GreyAxl.bin",
  "axlebarOffset",
  "1.551250,-2.670000,0.203281",
  "driveshaftPos",
  "0.000000,-2.050000,1.303281",
  "faxle.rtire.static_bpos.x",
  "4.700000",
  "faxle.rtire.static_bpos.y",
  "-3.200000",
  "faxle.rtire.static_bpos.z",
  "6.700000",
  "Number of Lights",
  "0",
  "superiorAxlebarOffset",
  "200,200,400",
].join("\r\n");

test("reads the header, name and model fields", () => {
  const m = parseTruckManifestText(MINIMAL);
  assert.equal(m.formatVersion, "MTM2.1");
  assert.equal(m.truckName, "Example Truck");
  assert.equal(m.truckModelBaseName, "EXAMPLE");
  assert.equal(m.tireModelBaseName, "GRNT");
  assert.equal(m.axleModelName, "GreyAxl.bin");
});

test("assembles split axis fields into one anchor", () => {
  const m = parseTruckManifestText(MINIMAL);
  assert.deepEqual(m.wheelAnchors["faxle.rtire.static_bpos"], { x: 4.7, y: -3.2, z: 6.7 });
});

test("reads the 2.1 upper axle bar offsets", () => {
  const m = parseTruckManifestText(MINIMAL);
  assert.deepEqual(m.superiorAxlebarOffset, { frontAxleY: 200, rearAxleY: 200, middleY: 400 });
});

test("strips NUL padding and the DOS end-of-file marker", () => {
  /*
    Shipped manifests are NUL padded and some end with 0x1A. If those survive, the label
    lines stop matching and the truck loads with no models at all, so this is the one
    parsing rule that fails silently and catastrophically.
  */
  const dirty = "MTM2 truckName\r\n\u0000Dirty\u0000 \r\ntruckModelBaseName\u001a \r\nBIGFOOT\r\n\u0000\u0000";
  const m = parseTruckManifestText(dirty);
  assert.equal(m.truckName, "Dirty");
  assert.equal(m.truckModelBaseName, "BIGFOOT");
});

test("keeps ordinary spaces in values", () => {
  // Guards the inverse mistake: a too-eager strip that removes spaces along with NULs.
  const m = parseTruckManifestText("MTM2 truckName\nCarolina Crusher\ntruckModelBaseName\ncrusher\n");
  assert.equal(m.truckName, "Carolina Crusher");
});

test("collects scrape points in file order", () => {
  const text = [
    "MTM2 truckName", "T",
    "Scrape point 1 body axis x,y,z", "1,2,3",
    "Scrape point 2 body axis x,y,z", "-1,-2,-3",
  ].join("\n");
  const m = parseTruckManifestText(text);
  assert.equal(m.scrapePoints.length, 2);
  assert.deepEqual(m.scrapePoints[0], { x: 1, y: 2, z: 3 });
  assert.deepEqual(m.scrapePoints[1], { x: -1, y: -2, z: -3 });
});

test("reads light records including the type the viewer drops", () => {
  const text = [
    "MTM2 truckName", "T",
    "Number of Lights", "1",
    "Light 0 type", "1",
    "Light 0 body axis pos x,y,z (ft), bitmap radius (ft)", "1.0,2.0,3.0,0.5",
    "Light 0 ms on, ms off", "500,250",
  ].join("\n");
  const m = parseTruckManifestText(text);
  assert.equal(m.numberOfLights, 1);
  assert.equal(m.lights.length, 1);
  assert.equal(m.lights[0].type, 1, "brake light type is needed to drive the brake lamps");
  assert.deepEqual(m.lights[0].pos, { x: 1, y: 2, z: 3 });
  assert.equal(m.lights[0].bitmapRadius, 0.5);
  assert.equal(m.lights[0].msOn, 500);
});

test("takes every line of a multi-line Wave File block", () => {
  const text = [
    "MTM2 truckName", "T",
    "Wave File", "engine.wav", "horn.wav",
    "Number of Lights", "0",
  ].join("\n");
  const m = parseTruckManifestText(text);
  assert.deepEqual(m.waveFiles, ["engine.wav", "horn.wav"]);
  assert.equal(m.numberOfLights, 0);
});

test("refuses an Evo manifest by name instead of misparsing it", () => {
  assert.throws(
    () => parseTruckManifestText("version\n7\ntruckName\nEvo Truck\n"),
    /4x4 Evolution/
  );
});

test("unrecognised labels are kept rather than dropped", () => {
  const m = parseTruckManifestText("MTM2 truckName\nT\nsomeFutureField\n42\n");
  assert.equal(m.unknownFields.someFutureField, "42");
});

test("BIGFOOT.TRK out of a stock TRUCK2.POD", { skip: !existsSync(STOCK_POD) && "no local MTM2 install" }, () => {
  const text = readPodEntry(STOCK_POD, (e) => e.normalizedName === "TRUCK/BIGFOOT.TRK");
  assert.ok(text, "BIGFOOT.TRK should be in TRUCK2.POD");
  const m = parseTruckManifestText(text);

  assert.equal(m.formatVersion, "MTM2");
  assert.equal(m.truckName, "Bigfoot");
  assert.equal(m.truckModelBaseName, "bigfoot");
  assert.equal(m.tireModelBaseName, "bfc");
  assert.equal(m.axleModelName, "axle3.bin");

  // Measured with scratchpad/truck-dims.mjs. The sim mounts its wheels at these points.
  for (const key of WHEEL_KEYS) {
    assert.ok(m.wheelAnchors[key], `missing anchor ${key}`);
  }
  assert.equal(m.wheelAnchors["faxle.rtire.static_bpos"].x, 4.291666);
  assert.equal(m.wheelAnchors["faxle.rtire.static_bpos"].y, -3.8);
  assert.equal(m.wheelAnchors["faxle.rtire.static_bpos"].z, 6.1);
  assert.equal(m.wheelAnchors["raxle.ltire.static_bpos"].z, -5.5);
  // Left and right anchors mirror, which the chassis inertia assumes.
  assert.equal(
    m.wheelAnchors["faxle.ltire.static_bpos"].x,
    -m.wheelAnchors["faxle.rtire.static_bpos"].x
  );

  // Stock trucks carry the full 12 point scrape hull.
  assert.equal(m.scrapePoints.length, 12);
  assert.ok(m.instrumentCluster, "stock trucks name an instrument cluster");
});
