/*
  A track's own ambience (track format version 6, section 9.6): the .TXV keys for its sky, haze and light,
  read for the viewer by src/worker/track-ambience.js. The whole-track test reads the Motorhead conversion's
  Red Rock (~/dev/motorheadconversion/out/REDROCK.POD) and skips itself when it is absent.
*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parsePod, readPodEntry } from "../src/vendor/openphotex/index.js";
import { readTrackAmbience } from "../src/worker/track-ambience.js";

const RED_ROCK = `${process.env.HOME}/dev/motorheadconversion/out/REDROCK.POD`;
const skipRedRock = existsSync(RED_ROCK) ? false : `no Red Rock conversion at ${RED_ROCK}`;

const fakePod = (txv) => {
  const entry = { normalizedName: "DATA/T.TXV", title: "T.TXV" };
  return { podIndex: { entries: [entry] }, getBytes: () => new TextEncoder().encode(txv), entry };
};

test("the keys come through, the tint scaled to a mean of 1", async () => {
  const { podIndex, getBytes, entry } = fakePod("formatVersion=2\r\nskyTopColor=71,13,14\r\nskyBottomColor=129,38,15\r\nfogColor=130,39,16\r\nfogStartFt=100\r\nfogEndFt=500\r\nlightTint=1,2,3\r\n");
  const a = await readTrackAmbience(podIndex, getBytes, entry);
  assert.deepEqual(a.skyTop, [71, 13, 14]);
  assert.deepEqual(a.skyBottom, [129, 38, 15]);
  assert.equal(a.skyHorizon, 0.25);
  assert.deepEqual(a.fogColor, [130, 39, 16]);
  assert.equal(a.fogStartFt, 100);
  assert.equal(a.fogEndFt, 500);
  assert.deepEqual(a.lightTint, [0.5, 1, 1.5]);
  assert.equal(a.image, null);
});

test("a .TXV without the keys, or no .TXV, has no ambience", async () => {
  const { podIndex, getBytes, entry } = fakePod("formatVersion=1\r\ntool=Traxx\r\n");
  assert.equal(await readTrackAmbience(podIndex, getBytes, entry), null);
  assert.equal(await readTrackAmbience(podIndex, getBytes, null), null);
});

test("Red Rock: its sky, picture name, haze and tint", { skip: skipRedRock }, async () => {
  const bytes = new Uint8Array(readFileSync(RED_ROCK));
  const podIndex = parsePod(bytes);
  const entry = podIndex.entries.find((e) => e.normalizedName.toUpperCase() === "DATA/MHRR.TXV");
  const a = await readTrackAmbience(podIndex, (e) => readPodEntry(bytes, e), entry);
  assert.ok(a.skyTop && a.skyBottom && a.fogColor && a.lightTint);
  assert.equal(a.skyImage.toUpperCase(), "ART\\MHRRSKY.PNG");
  assert.ok(podIndex.entries.some((e) => e.normalizedName.toUpperCase() === "ART/MHRRSKY.PNG"), "the picture is in the POD");
});
