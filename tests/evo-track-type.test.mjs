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

test("Evo race types: circuit, rally and mission by name, anything else by number", () => {
  assert.equal(evoTrackTypeName(2), "CIRCUIT");
  assert.equal(evoTrackTypeName(3), "RALLY");
  assert.equal(evoTrackTypeName(6), "MISSION");
  assert.equal(evoTrackTypeName(5), "TYPE 5");
  assert.equal(evoTrackTypeName(0), "UNKNOWN");
});

/** The .SIT of a POD2 archive, read directly: a 20 byte directory record per entry. */
function sitOf(path) {
  const b = readFileSync(path);
  if (b.toString("latin1", 0, 4) !== "POD2") return null;
  const count = b.readUInt32LE(0x58);
  const table = 0x60;
  const names = table + count * 20;
  for (let i = 0; i < count; i++) {
    const record = table + i * 20;
    const nameAt = names + b.readUInt32LE(record);
    let end = nameAt;
    while (b[end] !== 0) end++;
    const name = b.toString("latin1", nameAt, end);
    if (!/\.SIT$/i.test(name)) continue;
    const offset = b.readUInt32LE(record + 8);
    return { name, bytes: new Uint8Array(b.subarray(offset, offset + b.readUInt32LE(record + 4))) };
  }
  return null;
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
