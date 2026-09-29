/*
  POD1 writing.

  The rules come from the POD1 writer contract that JPod, JSPod and JSMTM2Converter follow
  (see docs/POD.md, "Writing POD1"). The directory record is a direct on-disk overlay the
  engine reads straight into its entry struct, so it is exactly 40 bytes and never widened,
  whatever the names need: a name that does not fit is refused, never truncated.
*/
import { encodeWindows1252 } from "../text.js";
const HEADER_SIZE = 84;
const COMMENT_SIZE = 80;
const NAME_SIZE = 32;
const ENTRY_SIZE = 40;
const MAX_ENTRIES = 8192;
/** The engine reads sizes and offsets as signed 32-bit, so nothing may end past 2^31 - 1. */
const MAX_ARCHIVE_SIZE = 0x7fffffff;
export class PodWriteError extends Error {
    code;
    /** The index of the offending entry, when the error concerns one. */
    entryIndex;
    constructor(code, message, entryIndex = null) {
        super(message);
        this.name = "PodWriteError";
        this.code = code;
        this.entryIndex = entryIndex;
    }
}
/**
 * Encode a POD1 header and directory. The payloads, concatenated in the same order, follow it
 * directly: entry `i` is stored at `directory.length + sum(lengths before i)`.
 *
 * Returning only the directory lets a caller stream or `Blob` the payloads without copying
 * them. Given an archive's own entries, comment and palette records, in directory order, this
 * reproduces that archive's directory byte for byte.
 *
 * @throws PodWriteError when the entries cannot be stored as a valid POD1.
 */
export function buildPod1Directory(comment, entries) {
    if (entries.length < 1 || entries.length > MAX_ENTRIES) {
        throw new PodWriteError("BAD_ENTRY_COUNT", `A POD1 holds 1 to ${MAX_ENTRIES} entries, not ${entries.length}.`);
    }
    const commentBytes = encodeText(comment, "The comment");
    if (commentBytes.length > COMMENT_SIZE - 1) {
        throw new PodWriteError("BAD_TEXT", `The comment is ${commentBytes.length} bytes; the field holds ${COMMENT_SIZE - 1}.`);
    }
    const directoryEnd = HEADER_SIZE + entries.length * ENTRY_SIZE;
    const out = new Uint8Array(directoryEnd);
    const view = new DataView(out.buffer);
    view.setInt32(0, entries.length, true);
    out.set(commentBytes, 4);
    const seen = new Map();
    let payloadOffset = directoryEnd;
    entries.forEach((entry, i) => {
        const field = encodeNameField(entry, i);
        const key = entry.name.replace(/\\/g, "/").toUpperCase();
        const first = seen.get(key);
        if (first !== undefined) {
            throw new PodWriteError("DUPLICATE_NAME", `Entry ${i} (${entry.name}) repeats the path of entry ${first}.`, i);
        }
        seen.set(key, i);
        if (!Number.isInteger(entry.length) || entry.length < 0) {
            throw new RangeError(`Entry ${i} (${entry.name}) has an invalid length: ${entry.length}`);
        }
        if (entry.length > MAX_ARCHIVE_SIZE - payloadOffset) {
            throw new PodWriteError("TOO_LARGE", `The archive would exceed ${MAX_ARCHIVE_SIZE} bytes at entry ${i} (${entry.name}).`, i);
        }
        const record = HEADER_SIZE + i * ENTRY_SIZE;
        out.set(field, record);
        view.setUint32(record + NAME_SIZE, entry.length, true);
        view.setUint32(record + NAME_SIZE + 4, payloadOffset, true);
        payloadOffset += entry.length;
    });
    return out;
}
/**
 * A complete POD1: `buildPod1Directory` followed by every payload, in order.
 *
 * @throws PodWriteError when the entries cannot be stored as a valid POD1.
 */
export function writePod1(comment, entries) {
    const directory = buildPod1Directory(comment, entries.map((e) => ({ name: e.name, length: e.data.length, paletteName: e.paletteName })));
    const out = new Uint8Array(directory.length + entries.reduce((sum, e) => sum + e.data.length, 0));
    out.set(directory, 0);
    let at = directory.length;
    for (const entry of entries) {
        out.set(entry.data, at);
        at += entry.data.length;
    }
    return out;
}
/** The directory entries of a parsed archive, in the form `buildPod1Directory` takes. */
export function pod1DirectoryEntries(entries) {
    return entries.map((e) => ({ name: e.name, length: e.length, paletteName: e.paletteName }));
}
/** path NUL [palette NUL] zeros: 32 bytes. */
function encodeNameField(entry, index) {
    const { name, paletteName } = entry;
    if (!name || /[\x00-\x1f]/.test(name) || name.includes(":") || name !== name.trim()) {
        throw new PodWriteError("BAD_NAME", `Entry ${index} has an unusable name: ${JSON.stringify(name)}`, index);
    }
    const path = encodeText(name, `Entry ${index} name`, index);
    const field = new Uint8Array(NAME_SIZE);
    field.set(path.subarray(0, NAME_SIZE), 0);
    if (path.length + 1 > NAME_SIZE) {
        throw new PodWriteError("NAME_TOO_LONG", `Entry ${index} (${name}) is ${path.length} bytes; a POD1 name holds ${NAME_SIZE - 1}.`, index);
    }
    if (paletteName) {
        if (!name.toUpperCase().endsWith(".RAW") || !paletteName.toUpperCase().endsWith(".ACT") || /[\x00-\x1f\\/:]/.test(paletteName)) {
            throw new PodWriteError("BAD_PALETTE", `Entry ${index} (${name}): a palette record is a bare .ACT name on a .RAW entry, not ${JSON.stringify(paletteName)}.`, index);
        }
        const palette = encodeText(paletteName, `Entry ${index} palette`, index);
        if (path.length + 1 + palette.length + 1 > NAME_SIZE) {
            throw new PodWriteError("NAME_TOO_LONG", `Entry ${index} (${name}) and its palette ${paletteName} do not fit the ${NAME_SIZE}-byte name field.`, index);
        }
        field.set(palette, path.length + 1);
    }
    return field;
}
function encodeText(text, what, index = null) {
    const encoded = encodeWindows1252(text);
    if (typeof encoded === "number") {
        throw new PodWriteError("BAD_TEXT", `${what} contains ${JSON.stringify(text[encoded])}, which the archive's 8-bit text cannot store.`, index);
    }
    return encoded;
}
