import { unzipSync } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

export async function extractFirstPodFromZipBytes(bytes, sourceLabel = "archive.zip") {
  const entries = unzipSync(bytes);
  for (const [entryName, entryBytes] of Object.entries(entries)) {
    if (isPodArchiveEntry(entryName)) {
      return {
        podBytes: entryBytes instanceof Uint8Array ? entryBytes : new Uint8Array(entryBytes),
        podEntryName: entryName,
      };
    }
  }
  throw new Error(`No .POD files were found in ${sourceLabel}.`);
}

function isPodArchiveEntry(name) {
  const normalized = String(name ?? "").replace(/\\/g, "/").trim();
  return normalized !== "" && !normalized.endsWith("/") && normalized.toUpperCase().endsWith(".POD");
}
