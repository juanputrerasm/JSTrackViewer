/*
  Tests for .ACT bit-depth detection.

  Run with: node --test tests/

  A palette is 6-bit (VGA DAC) only when its brightest channel is exactly 63. A dark 8-bit
  palette that never goes above 63 must be used as stored, or it renders about four times too
  bright. The stock case reads a local CPR install and skips itself when it is absent.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { decodeActPalette, decodeRawTexture } from "../src/worker/texture-decoder.js";
import { hasStockPod, indexStockPod } from "./helpers/stock-pod.mjs";

const LAGUNA_POD = `${process.env.HOME}/games/cpr/LAGUNA.POD`;

function palette(fill) {
  return Uint8Array.from({ length: 768 }, (_, i) => fill(i));
}

test("an 8-bit palette is used as stored", () => {
  const act = palette((i) => i % 256);
  assert.deepEqual([...decodeActPalette(act)], [...act]);
});

test("a VGA palette that reaches 63 is scaled to 8 bits", () => {
  const act = palette((i) => Math.floor((i % 256) / 4));        // 0..63
  const out = decodeActPalette(act);
  assert.equal(out[0], 0);
  assert.equal(out[252], 255);                                   // 63 -> 255
  assert.equal(out[128], Math.round((32 * 255 + 31) / 63));
});

test("a dark 8-bit palette that stays under 63 is not brightened", () => {
  const act = palette((i) => (i * 7) % 50);                      // max 49, like LAGQ28CC
  assert.deepEqual([...decodeActPalette(act)], [...act]);
  // All zeros (RA4BLACK) stays black.
  assert.ok(decodeActPalette(new Uint8Array(768)).every((v) => v === 0));
});

test("Laguna: the walkway's shadowed road quads decode as dark road, not tan dirt", {
  skip: hasStockPod(LAGUNA_POD) ? false : `no local CPR install at ${LAGUNA_POD}`,
}, () => {
  const pod = indexStockPod(LAGUNA_POD);
  const get = (title) => pod.getBytes(pod.podIndex.entries.find((e) => e.title === title));
  const meanLuma = (name) => {
    const { rgba } = decodeRawTexture(get(`${name}.RAW`), get(`${name}.ACT`), `${name}.RAW`);
    let sum = 0;
    for (let i = 0; i < rgba.length; i += 4) sum += 0.3 * rgba[i] + 0.59 * rgba[i + 1] + 0.11 * rgba[i + 2];
    return sum / (rgba.length / 4);
  };
  // The ordinary road tile, and the shadowed quad beside the three that went wrong.
  const road = meanLuma("RD4C");
  const shadowed = meanLuma("LAGQ60E3");
  for (const name of ["LAGQ28CC", "LAGQ28D9", "LAGQ799"]) {
    const luma = meanLuma(name);
    assert.ok(luma <= road, `${name} ${luma.toFixed(0)} brighter than plain road ${road.toFixed(0)}`);
    assert.ok(Math.abs(luma - shadowed) < 10, `${name} ${luma.toFixed(0)} vs neighbour ${shadowed.toFixed(0)}`);
  }
});
