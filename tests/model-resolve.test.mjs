/*
  Tests for truck model resolution.

  Run with: node --test tests/

  A TRK names stems, not files, and the rules that turn one into the other are the part of
  truck loading most likely to silently pick the wrong model. The synthetic cases build a fake
  pod index, which is just a list of entries, so each rule can be exercised on its own; the
  stock case checks the real archive and skips when there is no local MTM2 install.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  resolveMtm1WheelEntries,
  resolveSingleModelEntry,
  resolveWheelEntries,
} from "../src/worker/truck/model-resolve.js";

const STOCK_POD = `${process.env.HOME}/games/mtm2/TRUCK2.POD`;

/** A pod index built from backslash paths, matching what indexPodFile produces. */
function fakePod(...names) {
  return {
    entries: names.map((name) => ({
      name,
      normalizedName: name.replace(/\\/g, "/").toUpperCase(),
      title: name.split("\\").pop().toUpperCase(),
    })),
  };
}

function indexStockPod(podPath) {
  const buf = readFileSync(podPath);
  const count = buf.readInt32LE(0);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 40;
    const field = buf.toString("latin1", base, base + 32);
    const nul = field.indexOf("\0");
    const name = (nul >= 0 ? field.slice(0, nul) : field).trim();
    entries.push({
      name,
      normalizedName: name.replace(/\\/g, "/").toUpperCase(),
      title: name.split("\\").pop().toUpperCase(),
      length: buf.readInt32LE(base + 32),
      offset: buf.readInt32LE(base + 36),
    });
  }
  return { entries };
}

test("an exact model name resolves straight through", () => {
  const pod = fakePod("MODELS\\GREYAXL.BIN");
  const warnings = [];
  const entry = resolveSingleModelEntry(pod, "GreyAxl.bin", "axle", warnings);
  assert.equal(entry.title, "GREYAXL.BIN");
  assert.deepEqual(warnings, []);
});

test("a stem resolves to the highest numbered detail model", () => {
  // In MTM a higher number is HIGHER detail, and the bare name often does not exist.
  const pod = fakePod("MODELS\\BIGFOOT0.BIN", "MODELS\\BIGFOOT1.BIN");
  const warnings = [];
  const entry = resolveSingleModelEntry(pod, "bigfoot", "body", warnings);
  assert.equal(entry.title, "BIGFOOT1.BIN");
  assert.equal(warnings.length, 1, "resolving by LOD should say so");
});

test("a long stem falls back to the engine's seven character name", () => {
  const pod = fakePod("MODELS\\LONGTRU1.BIN");
  const warnings = [];
  const entry = resolveSingleModelEntry(pod, "longtruckname", "body", warnings);
  assert.equal(entry.title, "LONGTRU1.BIN");
  assert.match(warnings.join(" "), /offset-7/);
});

test("an unresolvable model warns and returns null", () => {
  const warnings = [];
  assert.equal(resolveSingleModelEntry(fakePod("MODELS\\OTHER.BIN"), "missing", "body", warnings), null);
  assert.match(warnings.join(" "), /Could not resolve/);
});

test("a missing name warns rather than throwing", () => {
  const warnings = [];
  assert.equal(resolveSingleModelEntry(fakePod(), "", "body", warnings), null);
  assert.match(warnings.join(" "), /did not define/);
});

test("wheels take the highest tier and the correct side per corner", () => {
  const pod = fakePod(
    "MODELS\\BFC08L.BIN", "MODELS\\BFC08R.BIN",
    "MODELS\\BFC16L.BIN", "MODELS\\BFC16R.BIN"
  );
  const warnings = [];
  const { mapping, enhanced } = resolveWheelEntries(pod, "bfc", warnings);
  assert.ok(!enhanced);
  assert.equal(mapping["faxle.ltire.static_bpos"].title, "BFC16L.BIN");
  assert.equal(mapping["faxle.rtire.static_bpos"].title, "BFC16R.BIN");
  assert.equal(mapping["raxle.ltire.static_bpos"].title, "BFC16L.BIN");
  assert.equal(mapping["raxle.rtire.static_bpos"].title, "BFC16R.BIN");
});

test("an MTM2.1 four wheel set is used per corner", () => {
  const pod = fakePod(
    "MODELS\\GRNT16L.BIN", "MODELS\\GRNT16R.BIN",
    "MODELS\\GRNT16FL.BIN", "MODELS\\GRNT16FR.BIN",
    "MODELS\\GRNT16RL.BIN", "MODELS\\GRNT16RR.BIN"
  );
  const warnings = [];
  const { mapping, enhanced } = resolveWheelEntries(pod, "GRNT", warnings);
  assert.ok(enhanced);
  assert.equal(mapping["faxle.ltire.static_bpos"].title, "GRNT16FL.BIN");
  assert.equal(mapping["faxle.rtire.static_bpos"].title, "GRNT16FR.BIN");
  assert.equal(mapping["raxle.ltire.static_bpos"].title, "GRNT16RL.BIN");
  assert.equal(mapping["raxle.rtire.static_bpos"].title, "GRNT16RR.BIN");
  assert.deepEqual(warnings, []);
});

test("an incomplete 2.1 set falls back per corner and warns", () => {
  const pod = fakePod(
    "MODELS\\GRNT16L.BIN", "MODELS\\GRNT16R.BIN", "MODELS\\GRNT16FL.BIN"
  );
  const warnings = [];
  const { mapping } = resolveWheelEntries(pod, "GRNT", warnings);
  assert.equal(mapping["faxle.ltire.static_bpos"].title, "GRNT16FL.BIN");
  assert.equal(mapping["faxle.rtire.static_bpos"].title, "GRNT16R.BIN");
  assert.match(warnings.join(" "), /incomplete/);
});

test("a longer unrelated family does not win the prefix search", () => {
  /*
    CLASS3TIRE matches CLASS3TIREB16L as readily as CLASS3TIRE16L, and both score 16 on the
    tier sort, so without the strict shape rule the winner came down to directory order.
  */
  const pod = fakePod(
    "MODELS\\CLASS3TIRE16L.BIN", "MODELS\\CLASS3TIRE16R.BIN",
    "MODELS\\CLASS3TIREB16L.BIN", "MODELS\\CLASS3TIREB16R.BIN"
  );
  const warnings = [];
  const { mapping } = resolveWheelEntries(pod, "CLASS3TIRE", warnings);
  assert.equal(mapping["faxle.ltire.static_bpos"].title, "CLASS3TIRE16L.BIN");
  assert.equal(mapping["faxle.rtire.static_bpos"].title, "CLASS3TIRE16R.BIN");
});

test("MTM1 reuses one tire model on all four corners", () => {
  const pod = fakePod("MODELS\\WHEEL13.BIN");
  const warnings = [];
  const { mapping } = resolveMtm1WheelEntries(pod, "wheel13.bin", warnings);
  const titles = new Set(Object.values(mapping).map((e) => e.title));
  assert.equal(titles.size, 1);
  assert.ok(titles.has("WHEEL13.BIN"));
});

test("BIGFOOT resolves against a stock TRUCK2.POD", { skip: !existsSync(STOCK_POD) && "no local MTM2 install" }, () => {
  const pod = indexStockPod(STOCK_POD);
  const warnings = [];

  /*
    The exact name wins, and it is also the best model. Measured out of this POD:
    BIGFOOT.BIN 236 verts / 248 polys, BIGFOOT1.BIN 201 / 218, BIGFOOT0.BIN 155 / 183.
    So the numbered files are reduced variants of the unnumbered one, and the LOD search
    below them only matters for a truck whose exact name is absent.
  */
  const body = resolveSingleModelEntry(pod, "bigfoot", "body", warnings);
  assert.equal(body.title, "BIGFOOT.BIN", "the exact name is the full detail body");

  const axle = resolveSingleModelEntry(pod, "axle3.bin", "axle", warnings);
  assert.equal(axle.title, "AXLE3.BIN");

  const { mapping } = resolveWheelEntries(pod, "bfc", warnings);
  assert.equal(mapping["faxle.ltire.static_bpos"].title, "BFC16L.BIN");
  assert.equal(mapping["faxle.rtire.static_bpos"].title, "BFC16R.BIN");
  for (const entry of Object.values(mapping)) {
    assert.ok(entry.normalizedName.startsWith("MODELS/"), "wheels come out of MODELS");
  }
});
