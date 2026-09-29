/*
  Reading a stock POD from a local MTM2 install, for tests.

  The repo's own pod-format.js goes through OPFS and so cannot run under node, so this reads
  the file with node:fs and hands the bytes to OpenPhotex directly.

  Tests that use this must skip themselves when the install is absent, via hasStockPod(), so
  the suite still passes on a machine without the game.
*/
import { existsSync, readFileSync } from "node:fs";
import { parsePod, readPodEntry } from "../../src/vendor/openphotex/index.js";

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
 * Index a stock POD with OpenPhotex, the same parser the viewer's worker uses, and read its
 * entries straight out of the loaded file.
 */
export function indexStockPod(path = STOCK_TRUCK_POD) {
  const bytes = new Uint8Array(readFileSync(path));
  return {
    podIndex: parsePod(bytes),
    /** The synchronous accessor the truck loader expects. */
    getBytes: (entry) => readPodEntry(bytes, entry),
  };
}

/** The text of one entry, found by predicate. */
export function entryText(pod, predicate) {
  const entry = pod.podIndex.entries.find(predicate);
  if (!entry) return null;
  return Buffer.from(pod.getBytes(entry)).toString("latin1");
}
