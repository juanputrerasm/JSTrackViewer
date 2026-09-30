/*
  POD directory parsing.

  POD1 and POD2 are ported from JSTrackViewer's src/worker/pod-format.js and EPD from JSPod's,
  which are the behavioural baselines: every check and every quirk below is there because a
  real archive needed it. See docs/POD.md for the format as understood so far.
*/
import { PodFormatError } from "../errors.js";
import { normalizePodPath, podPathTitle } from "./paths.js";
const POD1_HEADER_SIZE = 84;
const POD1_NAME_SIZE = 32;
const POD1_ENTRY_SIZE = 40;
const POD1_MAX_ITEMS = 8192;
const COMMENT_OFFSET = 4;
const COMMENT_SIZE = 80;
/*
  POD2, the container 4x4 Evolution 1 and 2 ship their tracks in.

    0x00  4   "POD2"
    0x04  4   archive CRC-32/MPEG-2 over 0x08..EOF
    0x08  80  NUL-terminated comment, which is the track's display name
    0x58  4   directory entry count
    0x5c  4   audit record count
    0x60  n*20 directory records
    ...   variable-length NUL-terminated name table, then payloads

  Each 20-byte record is five little-endian uint32: name-table offset, payload length,
  absolute payload offset, Unix timestamp, payload CRC-32/MPEG-2.

  Unlike POD1 this is a real indexed format with a signature, so it is detected outright
  rather than by trying a layout and seeing whether the offsets come out plausible. The CRCs
  are read but not verified: a viewer that refuses a track because one byte of a .WAV it will
  never play went bad is worse than one that draws the track.
*/
const POD2_SIGNATURE = [0x50, 0x4f, 0x44, 0x32]; // "POD2"
const POD2_CHECKSUM_OFFSET = 0x04;
const POD2_COMMENT_OFFSET = 0x08;
const POD2_COUNT_OFFSET = 0x58;
const POD2_AUDIT_COUNT_OFFSET = 0x5c;
const POD2_TABLE_OFFSET = 0x60;
const POD2_ENTRY_SIZE = 20;
const POD2_MAX_ITEMS = 65536;
/*
  EPD, the container of Fly!. Checked against all 72 stock archives; see docs/POD.md.

    0x00  4      "dtxe"
    0x04  9      archive title: a DOS base name of up to 8 characters, NUL-terminated
    0x0d  247    uninitialised memory (stack and heap values), meaningless
    0x104 4      directory entry count
    0x108 4      zero in every stock archive
    0x10c 4      unidentified, distinct per archive
    0x110 n*80   directory records
    ...          payloads

  The count was once read at 0x90. That word is uninitialised memory: it happens to be 54 in
  most sectional-chart archives (SC24.EPD has 272 entries) and is garbage in the scenery ones.

  Each 80-byte record: a 4-byte path prefix, a 60-byte path remainder, then uint32 payload
  length, absolute payload offset, Unix timestamp, and one unidentified uint32 (distinct per
  entry, probably a checksum, not exposed). The space after each string's terminator is heap
  junk (BA AD F0 0D) and means nothing.
*/
const EPD_SIGNATURE = [0x64, 0x74, 0x78, 0x65]; // "dtxe"
const EPD_TITLE_OFFSET = 0x04;
const EPD_TITLE_SIZE = 9;
const EPD_COUNT_OFFSET = 0x104;
const EPD_TABLE_OFFSET = 0x110;
const EPD_ENTRY_SIZE = 80;
const EPD_PREFIX_SIZE = 4;
const EPD_REMAINDER_SIZE = 60;
const EPD_MAX_ITEMS = 65536;
/*
  Every string in these archives is 8-bit. The WHATWG "latin1" label is really windows-1252,
  so bytes 0x80..0x9F decode to the cp1252 characters (0x80 is the euro sign), matching
  what JSTrackViewer has always produced.
*/
const decoder = new TextDecoder("latin1");
/**
 * Parse a POD archive's header and directory.
 *
 * The format is identified from the bytes: a `"POD2"` signature means POD2, `"dtxe"` means
 * EPD, and anything else is validated as POD1. Payloads are not read or copied; use `readPodEntry` for those.
 *
 * @throws PodFormatError when the bytes are not a readable POD.
 * @throws RangeError when `options.byteLength` is given and `bytes` is too short a prefix to
 *   hold the directory (see `podDirectoryEnd`).
 */
export function parsePod(input, options = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const size = options.byteLength ?? bytes.length;
    if (!Number.isInteger(size) || size < bytes.length) {
        throw new RangeError(`byteLength ${size} must be an integer no smaller than the ${bytes.length} bytes given.`);
    }
    if (size < 4)
        throw new PodFormatError("TOO_SMALL", "File too small to be a POD archive.");
    requirePrefix(bytes, 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (hasSignature(bytes, EPD_SIGNATURE))
        return readEpd(bytes, view, size);
    return hasSignature(bytes, POD2_SIGNATURE) ? readPod2(bytes, view, size) : readPod1(bytes, view, size);
}
/**
 * How many leading bytes of an archive `parsePod` needs to read its directory, judged from the
 * `prefix` read so far. Read that many (capped at the file size) and call again until the
 * answer stops growing; the directory is then complete. POD1 and EPD settle after one extra
 * read, POD2 after two (records, then the name table).
 *
 * Never throws: for bytes that are not a POD it returns an answer that `parsePod` will then
 * reject with the proper error.
 */
export function podDirectoryEnd(prefix, byteLength) {
    if (prefix.length < 4)
        return Math.min(POD2_TABLE_OFFSET, byteLength);
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    if (hasSignature(prefix, EPD_SIGNATURE)) {
        const countEnd = EPD_COUNT_OFFSET + 4;
        if (prefix.length < countEnd)
            return Math.min(countEnd, byteLength);
        const itemCount = view.getUint32(EPD_COUNT_OFFSET, true);
        if (itemCount < 1 || itemCount > EPD_MAX_ITEMS)
            return countEnd;
        return Math.min(EPD_TABLE_OFFSET + itemCount * EPD_ENTRY_SIZE, byteLength);
    }
    if (hasSignature(prefix, POD2_SIGNATURE)) {
        if (prefix.length < POD2_TABLE_OFFSET)
            return Math.min(POD2_TABLE_OFFSET, byteLength);
        const itemCount = view.getUint32(POD2_COUNT_OFFSET, true);
        if (itemCount < 1 || itemCount > POD2_MAX_ITEMS)
            return POD2_TABLE_OFFSET;
        const nameTableOffset = POD2_TABLE_OFFSET + itemCount * POD2_ENTRY_SIZE;
        if (nameTableOffset > byteLength)
            return POD2_TABLE_OFFSET;
        if (prefix.length < nameTableOffset)
            return nameTableOffset;
        return pod2FirstPayload(view, itemCount, nameTableOffset, byteLength);
    }
    const itemCount = view.getInt32(0, true);
    if (itemCount < 1 || itemCount > POD1_MAX_ITEMS)
        return Math.min(POD1_HEADER_SIZE, byteLength);
    return Math.min(POD1_HEADER_SIZE + itemCount * POD1_ENTRY_SIZE, byteLength);
}
function hasSignature(bytes, signature) {
    return signature.every((value, i) => bytes[i] === value);
}
function requirePrefix(bytes, length) {
    if (bytes.length < length) {
        throw new RangeError(`Only ${bytes.length} leading bytes given; the POD directory needs ${length}. See podDirectoryEnd().`);
    }
}
function readPod1(bytes, view, size) {
    if (size < POD1_HEADER_SIZE)
        throw new PodFormatError("TOO_SMALL", "File too small to be a POD archive.");
    requirePrefix(bytes, POD1_HEADER_SIZE);
    const itemCount = view.getInt32(0, true);
    if (itemCount < 1 || itemCount > POD1_MAX_ITEMS) {
        throw new PodFormatError("BAD_ENTRY_COUNT", `Suspicious POD item count: ${itemCount}`);
    }
    const comment = decodeNullTerminated(bytes.subarray(COMMENT_OFFSET, COMMENT_OFFSET + COMMENT_SIZE));
    /*
      POD1 has no signature, so the only proof that this is one is that the directory makes
      sense: every name terminated, non-empty and path-like, every payload inside the file.
    */
    const directoryEnd = POD1_HEADER_SIZE + itemCount * POD1_ENTRY_SIZE;
    if (directoryEnd > size) {
        throw new PodFormatError("DIRECTORY_OUT_OF_BOUNDS", "POD1 directory exceeds the file.");
    }
    requirePrefix(bytes, directoryEnd);
    const entries = [];
    for (let i = 0; i < itemCount; i++) {
        const recordOffset = POD1_HEADER_SIZE + i * POD1_ENTRY_SIZE;
        const { name, paletteName, pathTerminated } = decodePod1NameField(bytes, recordOffset, POD1_NAME_SIZE);
        const length = view.getUint32(recordOffset + POD1_NAME_SIZE, true);
        const dataOffset = view.getUint32(recordOffset + POD1_NAME_SIZE + 4, true);
        if (!pathTerminated)
            throw new PodFormatError("BAD_ENTRY_NAME", `POD1 entry ${i} has an unterminated path.`, i);
        if (!name)
            throw new PodFormatError("BAD_ENTRY_NAME", `POD1 entry ${i} has an empty path.`, i);
        if (!isPlausibleArchivePath(name)) {
            throw new PodFormatError("BAD_ENTRY_NAME", `POD1 entry ${i} is not a plausible archive path.`, i);
        }
        if (dataOffset > size || length > size - dataOffset) {
            throw new PodFormatError("ENTRY_OUT_OF_BOUNDS", `POD1 entry ${i} payload lies outside the file.`, i);
        }
        entries.push({
            index: i,
            name,
            normalizedName: normalizePodPath(name),
            title: podPathTitle(name),
            length,
            offset: dataOffset,
            recordOffset,
            // The .ACT this texture was authored against, when the archive records one.
            paletteName,
            timestamp: null,
            crc: null,
        });
    }
    return {
        format: "pod1",
        comment,
        entries,
        byteLength: size,
        directoryOffset: POD1_HEADER_SIZE,
        directoryEnd,
        checksum: null,
        auditCount: null,
    };
}
function readPod2(bytes, view, size) {
    if (size < POD2_TABLE_OFFSET)
        throw new PodFormatError("TOO_SMALL", "File too small to be a POD2 archive.");
    requirePrefix(bytes, POD2_TABLE_OFFSET);
    const comment = decodeNullTerminated(bytes.subarray(POD2_COMMENT_OFFSET, POD2_COMMENT_OFFSET + COMMENT_SIZE));
    const itemCount = view.getUint32(POD2_COUNT_OFFSET, true);
    if (itemCount < 1 || itemCount > POD2_MAX_ITEMS) {
        throw new PodFormatError("BAD_ENTRY_COUNT", `Suspicious POD2 item count: ${itemCount}`);
    }
    const nameTableOffset = POD2_TABLE_OFFSET + itemCount * POD2_ENTRY_SIZE;
    if (nameTableOffset > size) {
        throw new PodFormatError("DIRECTORY_OUT_OF_BOUNDS", "POD2 directory exceeds the file.");
    }
    requirePrefix(bytes, nameTableOffset);
    /*
      The name table runs from the end of the directory to the first payload. Reading to the
      first payload rather than to EOF keeps a corrupt path offset from walking into megabytes
      of texture data looking for a NUL.
    */
    const firstPayload = pod2FirstPayload(view, itemCount, nameTableOffset, size);
    requirePrefix(bytes, firstPayload);
    const nameTable = bytes.subarray(nameTableOffset, firstPayload);
    const entries = [];
    for (let i = 0; i < itemCount; i++) {
        const recordOffset = POD2_TABLE_OFFSET + i * POD2_ENTRY_SIZE;
        const pathOffset = view.getUint32(recordOffset + 0, true);
        const length = view.getUint32(recordOffset + 4, true);
        const dataOffset = view.getUint32(recordOffset + 8, true);
        const timestamp = view.getUint32(recordOffset + 12, true);
        const crc = view.getUint32(recordOffset + 16, true);
        if (pathOffset >= nameTable.length) {
            throw new PodFormatError("BAD_ENTRY_NAME", `POD2 entry ${i} names a path outside the name table.`, i);
        }
        if (dataOffset > size || length > size - dataOffset) {
            throw new PodFormatError("ENTRY_OUT_OF_BOUNDS", `POD2 entry ${i} payload lies outside the file.`, i);
        }
        let end = pathOffset;
        while (end < nameTable.length && nameTable[end] !== 0)
            end++;
        if (end >= nameTable.length)
            throw new PodFormatError("BAD_ENTRY_NAME", `POD2 entry ${i} has an unterminated path.`, i);
        const name = trimPodString(decoder.decode(nameTable.subarray(pathOffset, end)));
        if (!name)
            throw new PodFormatError("BAD_ENTRY_NAME", `POD2 entry ${i} has an empty path.`, i);
        entries.push({
            index: i,
            name,
            normalizedName: normalizePodPath(name),
            title: podPathTitle(name),
            length,
            offset: dataOffset,
            recordOffset,
            // POD2 has no per-entry palette field; Evo pairs an .ACT with a .RAW by stem instead.
            paletteName: null,
            timestamp,
            crc,
        });
    }
    return {
        format: "pod2",
        comment,
        entries,
        byteLength: size,
        directoryOffset: POD2_TABLE_OFFSET,
        directoryEnd: firstPayload,
        checksum: view.getUint32(POD2_CHECKSUM_OFFSET, true),
        auditCount: view.getUint32(POD2_AUDIT_COUNT_OFFSET, true),
    };
}
function readEpd(bytes, view, size) {
    const countEnd = EPD_COUNT_OFFSET + 4;
    if (size < countEnd)
        throw new PodFormatError("TOO_SMALL", "File too small to be an EPD archive.");
    requirePrefix(bytes, countEnd);
    // The bytes after the title's terminator are uninitialised memory, so stop at the NUL.
    const comment = decodeField(bytes, EPD_TITLE_OFFSET, EPD_TITLE_SIZE);
    const itemCount = view.getUint32(EPD_COUNT_OFFSET, true);
    if (itemCount < 1 || itemCount > EPD_MAX_ITEMS) {
        throw new PodFormatError("BAD_ENTRY_COUNT", `Suspicious EPD item count: ${itemCount}`);
    }
    const directoryEnd = EPD_TABLE_OFFSET + itemCount * EPD_ENTRY_SIZE;
    if (directoryEnd > size)
        throw new PodFormatError("DIRECTORY_OUT_OF_BOUNDS", "EPD directory exceeds the file.");
    requirePrefix(bytes, directoryEnd);
    const entries = [];
    for (let i = 0; i < itemCount; i++) {
        const recordOffset = EPD_TABLE_OFFSET + i * EPD_ENTRY_SIZE;
        const name = decodeEpdPath(bytes, recordOffset);
        const length = view.getUint32(recordOffset + 64, true);
        const dataOffset = view.getUint32(recordOffset + 68, true);
        if (dataOffset > size || length > size - dataOffset) {
            throw new PodFormatError("ENTRY_OUT_OF_BOUNDS", `EPD entry ${i} payload lies outside the file.`, i);
        }
        entries.push({
            index: i,
            name,
            normalizedName: normalizePodPath(name),
            title: podPathTitle(name),
            length,
            offset: dataOffset,
            recordOffset,
            paletteName: null,
            timestamp: view.getUint32(recordOffset + 72, true),
            crc: null,
        });
    }
    return {
        format: "epd",
        comment,
        entries,
        byteLength: size,
        directoryOffset: EPD_TABLE_OFFSET,
        directoryEnd,
        checksum: null,
        auditCount: null,
    };
}
/*
  An EPD path is split across a 4-byte prefix and a 60-byte remainder, e.g. "MAPS" and
  "\SC24N.ACT". The prefix counts only when it looks like a directory name (upper-case
  letters, digits, underscore) and the remainder starts with a backslash; otherwise the
  remainder stands alone, and failing that the whole 64 bytes are read as one string.
*/
function decodeEpdPath(bytes, recordOffset) {
    const prefix = decodeField(bytes, recordOffset, EPD_PREFIX_SIZE);
    const remainder = decodeField(bytes, recordOffset + EPD_PREFIX_SIZE, EPD_REMAINDER_SIZE);
    if (/^[A-Z0-9_]+$/.test(prefix) && remainder.startsWith("\\"))
        return prefix + remainder;
    if (remainder)
        return remainder;
    return decodeField(bytes, recordOffset, EPD_PREFIX_SIZE + EPD_REMAINDER_SIZE);
}
/** A NUL-terminated string inside a fixed-width field, trimmed like every POD string. */
function decodeField(bytes, offset, width) {
    const limit = Math.min(offset + width, bytes.length);
    let end = offset;
    while (end < limit && bytes[end] !== 0)
        end++;
    return trimPodString(decoder.decode(bytes.subarray(offset, end)));
}
function pod2FirstPayload(view, itemCount, nameTableOffset, size) {
    let firstPayload = size;
    for (let i = 0; i < itemCount; i++) {
        const offset = view.getUint32(POD2_TABLE_OFFSET + i * POD2_ENTRY_SIZE + 8, true);
        if (offset >= nameTableOffset && offset < firstPayload)
            firstPayload = offset;
    }
    return firstPayload;
}
/*
  A POD1 name field is 32 bytes and can hold TWO NUL-terminated strings: the entry path, and
  then, for a .RAW texture, the name of the .ACT palette it was authored against.

  Reading only up to the first NUL throws that second string away, which is why so many
  textures had no palette to resolve to. It is the archive stating the answer outright, so it
  outranks every heuristic except a same-stem .ACT sitting next to the texture.
*/
function decodePod1NameField(bytes, offset, width) {
    const limit = Math.min(offset + width, bytes.length);
    let pathEnd = offset;
    while (pathEnd < limit && bytes[pathEnd] !== 0)
        pathEnd++;
    const pathTerminated = pathEnd < limit;
    const name = trimPodString(decoder.decode(bytes.subarray(offset, pathEnd)));
    let paletteName = null;
    if (name.toUpperCase().endsWith(".RAW") && pathEnd < limit - 1) {
        const paletteStart = pathEnd + 1;
        let paletteEnd = paletteStart;
        while (paletteEnd < limit && bytes[paletteEnd] !== 0)
            paletteEnd++;
        const candidate = trimPodString(decoder.decode(bytes.subarray(paletteStart, paletteEnd)));
        // Only accept a properly terminated string that actually names a palette; the tail of the
        // field is otherwise junk left over from whatever the packer had in the buffer.
        if (paletteEnd < limit && candidate.toUpperCase().endsWith(".ACT"))
            paletteName = candidate;
    }
    return { name, paletteName, pathTerminated };
}
function trimPodString(value) {
    return value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
}
function isPlausibleArchivePath(name) {
    return !/[\0-\x1f]/.test(name) && !name.includes(":");
}
function decodeNullTerminated(bytes) {
    let end = 0;
    while (end < bytes.length && bytes[end] !== 0)
        end++;
    return decoder.decode(bytes.subarray(0, end)).trim();
}
