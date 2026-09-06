import { archiveTitle, normalizeArchiveName, joinPath, replaceExtension } from "../shared/path-utils.js";
import { readFile, writeBytesToFile } from "../shared/opfs.js";

const POD1_HEADER_SIZE = 84;
const ENTRY_NAME_SIZE = 32;
const COMMENT_SIZE = 80;
const ENTRY_SIZE = 40;
const LONG_ENTRY_NAME_SIZE = 64;
const LONG_ENTRY_SIZE = 72;
const MAX_REASONABLE_ITEMS = 8192;

export async function indexPodFile(opfsPodPath) {
  const file = await readFile(opfsPodPath);
  if (file.size < POD1_HEADER_SIZE) throw new Error(`File too small to be a POD archive: ${opfsPodPath}`);
  const headerBuffer = await file.slice(0, POD1_HEADER_SIZE).arrayBuffer();
  const headerView = new DataView(headerBuffer);
  const itemCount = headerView.getInt32(0, true);
  if (itemCount < 1 || itemCount > MAX_REASONABLE_ITEMS) throw new Error(`Suspicious POD item count: ${itemCount}`);
  const decoder = new TextDecoder("latin1");
  const comment = decodeNullTerminated(decoder, new Uint8Array(headerBuffer, 4, COMMENT_SIZE));

  // POD1 has no signature that distinguishes its directory variants. Validate the classic
  // layout first, then retry with Community Patch 3's widened 64-byte name field.
  const legacy = await tryReadDirectory(file, itemCount, ENTRY_NAME_SIZE, ENTRY_SIZE, decoder);
  if (legacy) return { format: "POD1", comment, entries: legacy };
  const extended = await tryReadDirectory(file, itemCount, LONG_ENTRY_NAME_SIZE, LONG_ENTRY_SIZE, decoder);
  if (extended) return { format: "Extended POD1", comment, entries: extended };
  throw new Error("POD1 directory is neither a valid 32-byte nor 64-byte layout.");
}

async function tryReadDirectory(file, itemCount, nameSize, entrySize, decoder) {
  const tableBytes = itemCount * entrySize;
  if (POD1_HEADER_SIZE + tableBytes > file.size) return null;
  const tableBuffer = await file.slice(POD1_HEADER_SIZE, POD1_HEADER_SIZE + tableBytes).arrayBuffer();
  const tableView = new DataView(tableBuffer);
  const tableBytesView = new Uint8Array(tableBuffer);
  const entries = [];
  for (let i = 0; i < itemCount; i++) {
    const offset = i * entrySize;
    const { name, paletteName, pathTerminated } = decodePod1NameField(decoder, tableBytesView, offset, nameSize);
    const length = tableView.getUint32(offset + nameSize, true);
    const dataOffset = tableView.getUint32(offset + nameSize + 4, true);
    if (
      !pathTerminated ||
      !name ||
      !isPlausibleArchivePath(name) ||
      dataOffset > file.size ||
      length > file.size - dataOffset
    ) {
      return null;
    }
    entries.push({
      name,
      normalizedName: normalizeArchiveName(name),
      title: archiveTitle(name),
      length,
      offset: dataOffset,
      // The .ACT this texture was authored against, when the archive records one.
      paletteName
    });
  }
  return entries;
}

/*
  A POD1 name field is 32 bytes and can hold TWO NUL-terminated strings: the entry path, and
  then, for a .RAW texture, the name of the .ACT palette it was authored against.

  Reading only up to the first NUL throws that second string away, which is why so many
  textures had no palette to resolve to. It is the archive stating the answer outright, so it
  outranks every heuristic except a same-stem .ACT sitting next to the texture.
*/
function decodePod1NameField(decoder, bytes, offset, width) {
  const limit = Math.min(offset + width, bytes.length);
  let pathEnd = offset;
  while (pathEnd < limit && bytes[pathEnd] !== 0) pathEnd++;
  const pathTerminated = pathEnd < limit;
  const name = trimPodString(decoder.decode(bytes.subarray(offset, pathEnd)));

  let paletteName = null;
  if (name.toUpperCase().endsWith(".RAW") && pathEnd < limit - 1) {
    const paletteStart = pathEnd + 1;
    let paletteEnd = paletteStart;
    while (paletteEnd < limit && bytes[paletteEnd] !== 0) paletteEnd++;
    const candidate = trimPodString(decoder.decode(bytes.subarray(paletteStart, paletteEnd)));
    // Only accept a properly terminated string that actually names a palette; the tail of the
    // field is otherwise junk left over from whatever the packer had in the buffer.
    if (paletteEnd < limit && candidate.toUpperCase().endsWith(".ACT")) paletteName = candidate;
  }
  return { name, paletteName, pathTerminated };
}

function trimPodString(value) {
  return value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
}

function isPlausibleArchivePath(name) {
  return !/[\0-\x1f]/.test(name) && !name.includes(":") && name.length <= LONG_ENTRY_NAME_SIZE - 1;
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

/*
  Track scripts, including the Community Patch 3 .SI2 spelling.

  The fork writes WORLD\<stem>.SI2 instead of .SIT when a pod omits its legacy 8-bit
  fallbacks: the extension IS the visibility switch, because a 1998 install scans only for
  .SIT and so never lists a track it could not draw. The content is identical, so nothing
  downstream needs to care which one it came from.
*/
export function findSitEntries(podIndex) {
  return podIndex.entries.filter((e) => e.title.endsWith(".SIT") || e.title.endsWith(".SI2"));
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
