/*
  POD2 integrity data: CRCs and the audit trail.

  Both layouts were described by JPod's specification without a sample to check them on, and are
  verified here against the 11 stock 4x4 Evolution 1 and 2 archives: every archive CRC and all
  16,461 entry CRCs match, and every audit trail fills exactly the bytes from the last payload to
  EOF. See docs/POD.md.
*/
import { PodFormatError } from "../errors.js";
const AUDIT_RECORD_SIZE = 312;
const decoder = new TextDecoder("latin1");
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i << 24;
        for (let k = 0; k < 8; k++)
            c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
        table[i] = c >>> 0;
    }
    return table;
})();
/**
 * CRC-32/MPEG-2: polynomial 0x04C11DB7, initial value 0xFFFFFFFF, not reflected, no final XOR.
 * The checksum POD2 uses for the archive and for each entry.
 */
export function crc32Mpeg2(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++)
        crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return crc >>> 0;
}
/**
 * Check a POD2's stored CRCs against the whole archive's bytes. Parsing never does this, so a
 * damaged archive still opens; call this when integrity matters.
 *
 * @throws TypeError for an archive that is not POD2 (only POD2 stores CRCs).
 * @throws RangeError when `bytes` is not the whole archive.
 */
export function verifyPodChecksums(bytes, archive) {
    requirePod2(archive);
    requireWhole(bytes, archive);
    const computed = crc32Mpeg2(bytes.subarray(8));
    const mismatches = [];
    for (const entry of archive.entries) {
        const crc = crc32Mpeg2(bytes.subarray(entry.offset, entry.offset + entry.length));
        if (crc !== entry.crc)
            mismatches.push({ index: entry.index, name: entry.name, stored: entry.crc, computed: crc });
    }
    return {
        archive: { stored: archive.checksum, computed, ok: computed === archive.checksum },
        mismatches,
        entriesChecked: archive.entries.length,
    };
}
const ACTIONS = ["add", "remove", "change"];
/*
  Record layout, 312 bytes:

    +0x000  32   user, NUL-terminated
    +0x020  4    timestamp
    +0x024  4    action: 0 add, 1 remove, 2 change
    +0x028  256  entry path, NUL-terminated
    +0x128  4    old timestamp
    +0x12c  4    old size
    +0x130  4    new timestamp
    +0x134  4    new size

  The records are the last `auditCount * 312` bytes of the file, directly after the payloads.
*/
/**
 * Decode a POD2's audit trail.
 *
 * @throws TypeError for an archive that is not POD2.
 * @throws RangeError when `bytes` is not the whole archive.
 * @throws PodFormatError (ENTRY_OUT_OF_BOUNDS) when the trail would overlap the payloads.
 */
export function readPod2AuditTrail(bytes, archive) {
    requirePod2(archive);
    requireWhole(bytes, archive);
    const count = archive.auditCount;
    const start = bytes.length - count * AUDIT_RECORD_SIZE;
    const payloadEnd = archive.entries.reduce((end, e) => Math.max(end, e.offset + e.length), archive.directoryEnd);
    if (start < payloadEnd) {
        throw new PodFormatError("ENTRY_OUT_OF_BOUNDS", `${count} audit records of ${AUDIT_RECORD_SIZE} bytes do not fit between the last payload (ends ${payloadEnd}) and EOF (${bytes.length}).`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const records = [];
    for (let i = 0; i < count; i++) {
        const at = start + i * AUDIT_RECORD_SIZE;
        const actionCode = view.getUint32(at + 0x24, true);
        records.push({
            index: i,
            offset: at,
            user: readString(bytes, at, 32),
            timestamp: view.getUint32(at + 0x20, true),
            actionCode,
            action: ACTIONS[actionCode] ?? null,
            path: readString(bytes, at + 0x28, 256),
            oldTimestamp: view.getUint32(at + 0x128, true),
            oldSize: view.getUint32(at + 0x12c, true),
            newTimestamp: view.getUint32(at + 0x130, true),
            newSize: view.getUint32(at + 0x134, true),
        });
    }
    return records;
}
function readString(bytes, offset, width) {
    let end = offset;
    while (end < offset + width && bytes[end] !== 0)
        end++;
    return decoder.decode(bytes.subarray(offset, end)).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
}
function requirePod2(archive) {
    if (archive.format !== "pod2")
        throw new TypeError(`Only POD2 archives carry CRCs and an audit trail; this is ${archive.format}.`);
}
function requireWhole(bytes, archive) {
    if (bytes.length !== archive.byteLength) {
        throw new RangeError(`The whole ${archive.byteLength}-byte archive is needed; ${bytes.length} bytes given.`);
    }
}
