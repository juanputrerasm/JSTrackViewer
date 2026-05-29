import { archiveTitle, normalizeArchiveName, joinPath, replaceExtension } from "../shared/path-utils.js";
import { readFile, writeBytesToFile } from "../shared/opfs.js";

const ENTRY_NAME_SIZE = 32;
const COMMENT_SIZE = 80;
const ENTRY_SIZE = 40;
const MAX_REASONABLE_ITEMS = 8192;

export async function indexPodFile(opfsPodPath) {
  const file = await readFile(opfsPodPath);
  if (file.size < 84) throw new Error(`File too small to be a POD archive: ${opfsPodPath}`);
  const headerBuffer = await file.slice(0, 84).arrayBuffer();
  const headerView = new DataView(headerBuffer);
  const itemCount = headerView.getInt32(0, true);
  if (itemCount < 1 || itemCount > MAX_REASONABLE_ITEMS) throw new Error(`Suspicious POD item count: ${itemCount}`);
  const tableBytes = itemCount * ENTRY_SIZE;
  if (84 + tableBytes > file.size) throw new Error("POD item table exceeds file size");
  const decoder = new TextDecoder("latin1");
  const comment = decodeNullTerminated(decoder, new Uint8Array(headerBuffer, 4, COMMENT_SIZE));
  const tableBuffer = await file.slice(84, 84 + tableBytes).arrayBuffer();
  const tableView = new DataView(tableBuffer);
  const tableBytesView = new Uint8Array(tableBuffer);
  const entries = [];
  for (let i = 0; i < itemCount; i++) {
    const offset = i * ENTRY_SIZE;
    const name = decodeNullTerminated(decoder, tableBytesView.subarray(offset, offset + ENTRY_NAME_SIZE));
    const length = tableView.getUint32(offset + ENTRY_NAME_SIZE, true);
    const dataOffset = tableView.getUint32(offset + ENTRY_NAME_SIZE + 4, true);
    entries.push({
      name,
      normalizedName: normalizeArchiveName(name),
      title: archiveTitle(name),
      length,
      offset: dataOffset
    });
  }
  return { comment, entries };
}

export async function readPodEntryBytes(opfsPodPath, entry) {
  const file = await readFile(opfsPodPath);
  const buffer = await file.slice(entry.offset, entry.offset + entry.length).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function extractPodEntry(opfsPodPath, entry, outputPath) {
  const bytes = await readPodEntryBytes(opfsPodPath, entry);
  await writeBytesToFile(outputPath, bytes);
  return outputPath;
}

export function findEntry(podIndex, normalizedName) {
  const upper = normalizeArchiveName(normalizedName);
  return podIndex.entries.find((e) => e.normalizedName === upper) ?? null;
}

export function findEntryByTitle(podIndex, title) {
  const upper = archiveTitle(title);
  return podIndex.entries.find((e) => e.title === upper) ?? null;
}

export function findEntryFlexible(podIndex, name) {
  return findEntry(podIndex, name) ?? findEntryByTitle(podIndex, name);
}

export function findEntriesByExtension(podIndex, ext) {
  const upper = ext.toUpperCase();
  return podIndex.entries.filter((e) => e.title.endsWith(upper));
}

export function findSitEntries(podIndex) {
  return podIndex.entries.filter((e) => e.title.endsWith(".SIT"));
}

export function findLvlEntries(podIndex) {
  return podIndex.entries.filter((e) => e.title.endsWith(".LVL"));
}

export function resolveAsset(podIndex, title) {
  const upper = normalizeArchiveName(title);
  return (
    findEntry(podIndex, upper) ??
    findEntryByTitle(podIndex, upper) ??
    findEntry(podIndex, "DATA/" + archiveTitle(upper)) ??
    findEntry(podIndex, "ART/" + archiveTitle(upper)) ??
    findEntry(podIndex, "MODELS/" + archiveTitle(upper)) ??
    null
  );
}

function decodeNullTerminated(decoder, bytes) {
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(0, end)).trim();
}
