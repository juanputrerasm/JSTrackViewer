/*
  Tests for 4x4 Evolution race type names.

  Run with: node --test tests/

  The stock case reads local Evo 1 and Evo 2 installs straight from their POD2 archives and
  skips itself when neither is present.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { evoTrackTypeName, parseEvoSit } from "../src/worker/evo/evo-sit-parser.js";
import { parsePod, readPodEntry } from "../src/vendor/openphotex/index.js";

test("Evo race types: circuit, rally and mission by name, anything else by number", () => {
  assert.equal(evoTrackTypeName(2), "CIRCUIT");
  assert.equal(evoTrackTypeName(3), "RALLY");
  assert.equal(evoTrackTypeName(6), "MISSION");
  assert.equal(evoTrackTypeName(5), "TYPE 5");
  assert.equal(evoTrackTypeName(0), "UNKNOWN");
});

/** The .SIT of a stock Evo POD, found with OpenPhotex like every other POD read. */
function sitOf(path) {
  const bytes = new Uint8Array(readFileSync(path));
  const pod = parsePod(bytes);
  const entry = pod.entries.find((e) => /\.SIT$/i.test(e.name));
  return entry ? { name: entry.name, bytes: readPodEntry(bytes, entry) } : null;
}

const STOCK = [
  ["evo1/ASPEN.POD", "CIRCUIT"],
  ["evo1/THEHILL.POD", "CIRCUIT"],
  ["evo2/TRIBAJA.pod", "CIRCUIT"],
  ["evo2/PEAK.pod", "RALLY"],
  ["evo2/ELNORTE.pod", "MISSION"],
  ["evo2/OBSPARK.pod", "MISSION"],
].map(([file, type]) => [`${process.env.HOME}/games/${file}`, type]);

test("stock Evo tracks read as their race type", {
  skip: STOCK.some(([path]) => existsSync(path)) ? false : "no local 4x4 Evolution install",
}, () => {
  for (const [path, type] of STOCK) {
    if (!existsSync(path)) continue;
    const sit = sitOf(path);
    assert.ok(sit, path);
    assert.equal(evoTrackTypeName(parseEvoSit(sit.bytes, sit.name).raceType), type, path);
  }
});
