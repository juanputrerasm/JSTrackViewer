/*
  POD archives, as the track viewer uses them.

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library): this file only moves bytes between OPFS and it, and keeps the viewer's own asset
  lookup rules. Do not add POD format knowledge here; change OpenPhotex and re-vendor it.
*/
import {
  parsePod,
  podDirectoryEnd,
  findPodEntry,
  findPodEntryByTitle,
  findPodEntriesByExtension,
  mtm2SituationExtension,
} from "../vendor/openphotex/index.js";
import { archiveTitle, normalizeArchiveName } from "../shared/path-utils.js";
import { readFile, writeBytesToFile } from "../shared/opfs.js";

/*
  Index a POD, reading only its directory.

  A pack's PODs are each indexed in turn to list their tracks, so the payloads are left on
  disk: OpenPhotex says how much of the file the directory needs and only that is read.

  `source` is a path in OPFS, where an opened file or a ZIP's PODs are staged, or a File the
  page picked, as Open from Folder hands them over: a folder can hold gigabytes of archives,
  which are read where they are rather than copied.
*/
export async function indexPodFile(source) {
  const file = await podFile(source);
  let prefix = new Uint8Array(0);
  for (;;) {
    const need = podDirectoryEnd(prefix, file.size);
    if (need <= prefix.length) break;
    prefix = new Uint8Array(await file.slice(0, need).arrayBuffer());
  }
  return parsePod(prefix, { byteLength: file.size });
}

export async function readPodEntryBytes(source, entry) {
  const file = await podFile(source);
  const buffer = await file.slice(entry.offset, entry.offset + entry.length).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function extractPodEntry(opfsPodPath, entry, outputPath) {
  const bytes = await readPodEntryBytes(opfsPodPath, entry);
  await writeBytesToFile(outputPath, bytes);
  return outputPath;
}

/** An archive as a Blob: an OPFS path is opened, a File or Blob is used as it is. */
export async function podFile(source) {
  return typeof source === "string" ? readFile(source) : source;
}

export function findEntry(podIndex, normalizedName) {
  return findPodEntry(podIndex, normalizedName);
}

export function findEntryByTitle(podIndex, title) {
  return findPodEntryByTitle(podIndex, title);
}

export function findEntryFlexible(podIndex, name) {
  return findEntry(podIndex, name) ?? findEntryByTitle(podIndex, name);
}

export function findEntriesByExtension(podIndex, ext) {
  return findPodEntriesByExtension(podIndex, ext);
}

/*
  Track scripts, including the Community Patch 3 .SI2 spelling and the track format version 6
  .SI3 (https://openmtm2.github.io/proposals/track-format-v6, section 5.1).

  The fork writes WORLD\<stem>.SI2 instead of .SIT when a pod omits its legacy 8-bit
  fallbacks: the extension IS the visibility switch, because a 1998 install scans only for
  .SIT and so never lists a track it could not draw. The content is identical, so nothing
  downstream needs to care which one it came from.

  A .SI3 is the same text, but its track follows version 6's rules (its .TXV's world size and
  height step; sit-parser.js). Every entry is its own track: a .SIT or .SI2 with the same stem
  is a different track, listed beside it, never a fallback for it.
*/
export function findSitEntries(podIndex) {
  return podIndex.entries.filter((e) => mtm2SituationExtension(e.title) !== null);
}

export function findLvlEntries(podIndex) {
  return findPodEntriesByExtension(podIndex, ".LVL");
}

export function resolveAsset(podIndex, title) {
  const upper = normalizeArchiveName(title);
  return (
    findEntry(podIndex, upper) ??
    findEntryByTitle(podIndex, upper) ??
    findEntry(podIndex, "DATA/" + archiveTitle(upper)) ??
    findEntry(podIndex, "ART/" + archiveTitle(upper)) ??
    findEntry(podIndex, "MODELS/" + archiveTitle(upper)) ??
    // Evo keeps its manifest in LEVELS\ and its scene script in WORLD\.
    findEntry(podIndex, "LEVELS/" + archiveTitle(upper)) ??
    findEntry(podIndex, "WORLD/" + archiveTitle(upper)) ??
    null
  );
}
