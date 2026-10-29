/*
  POD2 writing.

  The layout is the one parse.ts reads and docs/POD.md describes. Every stock 4x4 Evolution 1
  and 2 archive is laid out the same way, and this writer reproduces them byte for byte (see
  test/stock.test.ts):

    0x00  4      "POD2"
    0x04  4      archive CRC-32/MPEG-2 over 0x08..EOF
    0x08  80     comment
    0x58  4      entry count
    0x5c  4      audit record count
    0x60  n*20   records: name offset, length, payload offset, timestamp, payload CRC
    ...          name table: the paths, NUL-terminated, in directory order, none shared
    ...          payloads, contiguous, in directory order
    ...          audit trail: auditCount records of 312 bytes

  The archive CRC covers everything after itself, payloads and audit trail included, so a
  streaming writer emits the archive with 0 at 0x04, runs crc32Mpeg2Update (pod2.ts) over bytes
  0x08..EOF as it goes, and patches the result in at the end.
*/
import { encodeText, PodWriteError } from "./write.js";
import { crc32Mpeg2 } from "./pod2.js";
const SIGNATURE = [0x50, 0x4f, 0x44, 0x32]; // "POD2"
const CHECKSUM_OFFSET = 0x04;
const COMMENT_OFFSET = 0x08;
const COMMENT_SIZE = 80;
const COUNT_OFFSET = 0x58;
const AUDIT_COUNT_OFFSET = 0x5c;
const TABLE_OFFSET = 0x60;
const ENTRY_SIZE = 20;
const MAX_ENTRIES = 65536;
/** The audit record's path field is 256 bytes, so no stored path may be longer than 255. */
const MAX_NAME_BYTES = 255;
const MAX_ARCHIVE_SIZE = 0x7fffffff;
/** The size of one audit-trail record. */
export const POD2_AUDIT_RECORD_SIZE = 312;
const ACTION_CODES = { add: 0, remove: 1, change: 2 };
/**
 * Encode a POD2 header, directory and name table, with 0 in the archive CRC slot. The payloads,
 * concatenated in the same order, follow it directly, then `auditCount` audit records. Patch
 * the archive CRC with `setPod2Checksum` once the rest is known.
 *
 * `comment` is either text (windows-1252, at most 79 bytes) or the 80-byte field's raw bytes,
 * which are stored as given so a comment read from an archive, trailing spaces and all, writes
 * back unchanged.
 *
 * @throws PodWriteError when the entries cannot be stored as a valid POD2.
 */
export function buildPod2Directory(comment, entries, auditCount = 0) {
    if (entries.length < 1 || entries.length > MAX_ENTRIES) {
        throw new PodWriteError("BAD_ENTRY_COUNT", `A POD2 holds 1 to ${MAX_ENTRIES} entries, not ${entries.length}.`);
    }
    if (!Number.isInteger(auditCount) || auditCount < 0)
        throw new RangeError(`Invalid audit record count: ${auditCount}`);
    const commentBytes = encodeComment(comment);
    const names = entries.map((entry, i) => encodeName(entry.name, i));
    const tableEnd = TABLE_OFFSET + entries.length * ENTRY_SIZE;
    const directoryEnd = tableEnd + names.reduce((sum, n) => sum + n.length + 1, 0);
    const out = new Uint8Array(directoryEnd);
    const view = new DataView(out.buffer);
    out.set(SIGNATURE, 0);
    out.set(commentBytes, COMMENT_OFFSET);
    view.setUint32(COUNT_OFFSET, entries.length, true);
    view.setUint32(AUDIT_COUNT_OFFSET, auditCount, true);
    const seen = new Map();
    let nameOffset = 0;
    let payloadOffset = directoryEnd;
    entries.forEach((entry, i) => {
        const key = entry.name.replace(/\\/g, "/").toUpperCase();
        const first = seen.get(key);
        if (first !== undefined) {
            throw new PodWriteError("DUPLICATE_NAME", `Entry ${i} (${entry.name}) repeats the path of entry ${first}.`, i);
        }
        seen.set(key, i);
        uint32(entry.length, `Entry ${i} (${entry.name}) length`);
        uint32(entry.timestamp, `Entry ${i} (${entry.name}) timestamp`);
        uint32(entry.crc, `Entry ${i} (${entry.name}) CRC`);
        if (entry.length > MAX_ARCHIVE_SIZE - payloadOffset) {
            throw new PodWriteError("TOO_LARGE", `The archive would exceed ${MAX_ARCHIVE_SIZE} bytes at entry ${i} (${entry.name}).`, i);
        }
        const record = TABLE_OFFSET + i * ENTRY_SIZE;
        view.setUint32(record, nameOffset, true);
        view.setUint32(record + 4, entry.length, true);
        view.setUint32(record + 8, payloadOffset, true);
        view.setUint32(record + 12, entry.timestamp, true);
        view.setUint32(record + 16, entry.crc, true);
        out.set(names[i], tableEnd + nameOffset);
        nameOffset += names[i].length + 1;
        payloadOffset += entry.length;
    });
    if (auditCount * POD2_AUDIT_RECORD_SIZE > MAX_ARCHIVE_SIZE - payloadOffset) {
        throw new PodWriteError("TOO_LARGE", `The archive would exceed ${MAX_ARCHIVE_SIZE} bytes with its audit trail.`);
    }
    return out;
}
/**
 * Encode one 312-byte audit-trail record, the inverse of `readPod2AuditTrail`.
 *
 * @throws PodWriteError (BAD_TEXT) for a user over 31 bytes, a path over 255, or text
 * windows-1252 cannot store.
 */
export function encodePod2AuditRecord(record) {
    const out = new Uint8Array(POD2_AUDIT_RECORD_SIZE);
    const view = new DataView(out.buffer);
    const user = encodeText(record.user, "The audit user");
    if (user.length > 31)
        throw new PodWriteError("BAD_TEXT", `The audit user is ${user.length} bytes; the field holds 31.`);
    const path = encodeText(record.path, "The audit path");
    if (path.length > 255)
        throw new PodWriteError("BAD_TEXT", `The audit path is ${path.length} bytes; the field holds 255.`);
    const action = typeof record.action === "number" ? record.action : ACTION_CODES[record.action];
    if (action === undefined)
        throw new RangeError(`Unknown audit action: ${record.action}`);
    out.set(user, 0);
    view.setUint32(0x20, uint32(record.timestamp, "The audit timestamp"), true);
    view.setUint32(0x24, uint32(action, "The audit action"), true);
    out.set(path, 0x28);
    view.setUint32(0x128, uint32(record.oldTimestamp ?? 0, "The audit old timestamp"), true);
    view.setUint32(0x12c, uint32(record.oldSize ?? 0, "The audit old size"), true);
    view.setUint32(0x130, uint32(record.newTimestamp ?? 0, "The audit new timestamp"), true);
    view.setUint32(0x134, uint32(record.newSize ?? 0, "The audit new size"), true);
    return out;
}
/**
 * Write the archive CRC into a complete POD2 held in memory: CRC-32/MPEG-2 of bytes 0x08..EOF,
 * stored at 0x04. A streaming writer computes the same value with `crc32Mpeg2Update` instead.
 */
export function setPod2Checksum(archive) {
    const crc = crc32Mpeg2(archive.subarray(COMMENT_OFFSET));
    new DataView(archive.buffer, archive.byteOffset, archive.byteLength).setUint32(CHECKSUM_OFFSET, crc, true);
    return crc;
}
/** The byte offset of the archive CRC, for a streaming writer that patches it last. */
export const POD2_CHECKSUM_OFFSET = CHECKSUM_OFFSET;
/** Where the archive CRC's coverage starts: everything from here to EOF. */
export const POD2_CHECKSUM_START = COMMENT_OFFSET;
/**
 * A complete POD2: directory, payloads, audit trail, with every CRC computed.
 *
 * `audit` is either records to encode or an existing trail's raw bytes (a multiple of 312),
 * which are copied as they are. Entry timestamps default to 0.
 *
 * @throws PodWriteError when the entries cannot be stored as a valid POD2.
 */
export function writePod2(comment, entries, audit = []) {
    const trail = audit instanceof Uint8Array ? audit : concat(audit.map(encodePod2AuditRecord));
    if (trail.length % POD2_AUDIT_RECORD_SIZE !== 0) {
        throw new RangeError(`An audit trail is a multiple of ${POD2_AUDIT_RECORD_SIZE} bytes, not ${trail.length}.`);
    }
    const directory = buildPod2Directory(comment, entries.map((e) => ({ name: e.name, length: e.data.length, timestamp: e.timestamp ?? 0, crc: crc32Mpeg2(e.data) })), trail.length / POD2_AUDIT_RECORD_SIZE);
    const out = concat([directory, ...entries.map((e) => e.data), trail]);
    setPod2Checksum(out);
    return out;
}
/** The directory entries of a parsed POD2, in the form `buildPod2Directory` takes. */
export function pod2DirectoryEntries(entries) {
    return entries.map((e) => ({ name: e.name, length: e.length, timestamp: e.timestamp ?? 0, crc: e.crc ?? 0 }));
}
function encodeComment(comment) {
    if (comment instanceof Uint8Array) {
        if (comment.length > COMMENT_SIZE) {
            throw new PodWriteError("BAD_TEXT", `The raw comment field is ${comment.length} bytes; it holds ${COMMENT_SIZE}.`);
        }
        return comment;
    }
    const bytes = encodeText(comment, "The comment");
    if (bytes.length > COMMENT_SIZE - 1) {
        throw new PodWriteError("BAD_TEXT", `The comment is ${bytes.length} bytes; the field holds ${COMMENT_SIZE - 1}.`);
    }
    return bytes;
}
function encodeName(name, index) {
    if (!name || /[\x00-\x1f]/.test(name) || name.includes(":") || name !== name.trim()) {
        throw new PodWriteError("BAD_NAME", `Entry ${index} has an unusable name: ${JSON.stringify(name)}`, index);
    }
    const bytes = encodeText(name, `Entry ${index} name`, index);
    if (bytes.length > MAX_NAME_BYTES) {
        throw new PodWriteError("NAME_TOO_LONG", `Entry ${index} (${name}) is ${bytes.length} bytes; a POD2 path holds ${MAX_NAME_BYTES}.`, index);
    }
    return bytes;
}
function uint32(value, what) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw new RangeError(`${what} is not a 32-bit unsigned value: ${value}`);
    return value;
}
function concat(parts) {
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
