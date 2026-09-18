/*
  Reading a stock POD from a local MTM2 install, for tests.

  The repo's own pod-format.js goes through OPFS and so cannot run under node. This is the
  same POD1 directory walk, kept deliberately small: 84 byte header, then 40 byte records of
  a 32 byte name field, a length and an absolute offset.

  Tests that use this must skip themselves when the install is absent, via hasStockPod(), so
  the suite still passes on a machine without the game.
*/
import { existsSync, readFileSync } from "node:fs";

export const STOCK_DIR = `${process.env.HOME}/games/mtm2`;
export const STOCK_TRUCK_POD = `${STOCK_DIR}/TRUCK2.POD`;

export function hasStockPod(path = STOCK_TRUCK_POD) {
  return existsSync(path);
}

/** Reason string for node:test's `skip` option, or false when the file is present. */
export function skipWithoutStockPod(path = STOCK_TRUCK_POD) {
  return hasStockPod(path) ? false : `no local MTM2 install at ${path}`;
}

/**
 * Index a POD1 archive.
 *
 * Entries carry `paletteName` when the archive stores one: some Terminal Reality packers put
 * a second NUL terminated string after the path on .RAW entries, naming the .ACT the texture
 * was authored against, and the palette resolver reads it.
 */
export function indexStockPod(path = STOCK_TRUCK_POD) {
  const buf = readFileSync(path);
  const count = buf.readInt32LE(0);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 40;
    const field = buf.subarray(base, base + 32);
    let end = 0;
    while (end < field.length && field[end] !== 0) end++;
    const name = field.toString("latin1", 0, end).trim();

    let paletteName = null;
    if (end + 1 < field.length) {
      let stop = end + 1;
      while (stop < field.length && field[stop] !== 0) stop++;
      const candidate = field.toString("latin1", end + 1, stop).trim();
      if (candidate.toUpperCase().endsWith(".ACT")) paletteName = candidate;
    }

    entries.push({
      name,
      normalizedName: name.replace(/\\/g, "/").toUpperCase(),
      title: name.split("\\").pop().toUpperCase(),
      paletteName,
      length: buf.readInt32LE(base + 32),
      offset: buf.readInt32LE(base + 36),
    });
  }
  return {
    podIndex: { entries, comment: "" },
    /** The synchronous accessor the truck loader expects. */
    getBytes: (entry) => new Uint8Array(buf.subarray(entry.offset, entry.offset + entry.length)),
  };
}

/** The text of one entry, found by predicate. */
export function entryText(pod, predicate) {
  const entry = pod.podIndex.entries.find(predicate);
  if (!entry) return null;
  return Buffer.from(pod.getBytes(entry)).toString("latin1");
}
