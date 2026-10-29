/*
  Hellbender palette selection.

  GAME.POD's RAW directory records name the palette used by the converted in-game texture.
  A few assets also retain a same-stem source palette. The IOWAH developer-photo mosaics are
  the visible regression: using those source palettes produces the false-colour picture that
  prompted this test; their directory records correctly name IOWA.ACT.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { parseLvlTrack } from "../src/worker/lvl-parser.js";
import { createPaletteResolver } from "../src/worker/palette-resolver.js";
import { hasStockPod, indexStockPod } from "./helpers/stock-pod.mjs";

const HB_GAME_POD = `${process.env.HOME}/games/hb/GAME.POD`;

test("HB POD metadata outranks a leftover same-stem palette", () => {
  const raw = {
    name: "ART\\MSTEAM00.RAW",
    normalizedName: "ART/MSTEAM00.RAW",
    title: "MSTEAM00.RAW",
    paletteName: "IOWA.ACT",
  };
  const sibling = {
    name: "ART\\MSTEAM00.ACT",
    normalizedName: "ART/MSTEAM00.ACT",
    title: "MSTEAM00.ACT",
  };
  const assigned = {
    name: "ART\\IOWA.ACT",
    normalizedName: "ART/IOWA.ACT",
    title: "IOWA.ACT",
  };
  const siblingBytes = new Uint8Array(768).fill(17);
  const assignedBytes = new Uint8Array(768).fill(91);
  const bytes = new Map([[sibling, siblingBytes], [assigned, assignedBytes]]);
  const podIndex = { entries: [raw, sibling, assigned] };

  const palettes = createPaletteResolver(podIndex, (entry) => bytes.get(entry), "HB", assignedBytes);

  assert.equal(palettes.paletteFor("MSTEAM00.RAW", raw, "terrain"), assignedBytes);
  assert.deepEqual(palettes.sourceSummary(), { "pod-metadata:IOWA.ACT": 1 });
});

test("IOWAH's two developer mosaics use IOWA.ACT, not their same-stem ACTs", {
  skip: hasStockPod(HB_GAME_POD) ? false : `no local Hellbender install at ${HB_GAME_POD}`,
}, () => {
  const pod = indexStockPod(HB_GAME_POD);
  const find = (title) => pod.podIndex.entries.find((entry) => entry.title === title);
  const doc = parseLvlTrack(pod.podIndex, pod.getBytes, find("IOWAH.LVL"), pod.podIndex.comment);
  const iowa = pod.getBytes(find("IOWA.ACT"));
  const palettes = createPaletteResolver(pod.podIndex, pod.getBytes, doc.origin, doc.palette);

  for (const name of ["MSTEAM00.RAW", "MSTEAM23.RAW", "TRTEAM00.RAW", "TRTEAM23.RAW"]) {
    const texture = doc.textures.find((candidate) => candidate.name === name);
    assert.ok(texture, `${name} is listed by IOWAH.TEX`);
    assert.equal(texture.rawEntry?.paletteName, "IOWA.ACT");
    assert.equal(texture.actData, undefined, `${name} must reach the HB metadata resolver`);
    assert.deepEqual(palettes.paletteFor(name, texture.rawEntry, "terrain"), iowa);
  }
});
