import { unzipSync } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

export async function extractFirstPodFromZipBytes(bytes, sourceLabel = "archive.zip") {
  const [first] = await extractPodsFromZipBytes(bytes, sourceLabel);
  return first;
}

/*
  Every .POD in a ZIP, in the order the archive lists them.

  A track pack often ships several PODs in one ZIP, each with its own tracks, so the viewer
  offers all of them rather than whichever came first. Only .POD entries are inflated; a
  pack's readme and screenshots are never decompressed.
*/
export async function extractPodsFromZipBytes(bytes, sourceLabel = "archive.zip") {
  const entries = unzipSync(bytes, { filter: (file) => isPodArchiveEntry(file.name) });
  const pods = Object.entries(entries).map(([entryName, entryBytes]) => ({
    podBytes: entryBytes instanceof Uint8Array ? entryBytes : new Uint8Array(entryBytes),
    podEntryName: entryName,
  }));
  if (!pods.length) throw new Error(`No .POD files were found in ${sourceLabel}.`);
  return pods;
}

function isPodArchiveEntry(name) {
  const normalized = String(name ?? "").replace(/\\/g, "/").trim();
  return normalized !== "" && !normalized.endsWith("/") && normalized.toUpperCase().endsWith(".POD");
}
