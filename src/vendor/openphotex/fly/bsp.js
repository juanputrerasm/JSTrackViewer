import { parseBin } from "../model/bin.js";
const TAG = /^<[a-z ]{4}>$/;
const STRUCTURE = new Set(["bgno", "endo", "root", "frnt", "back"]);
const MRGL_MAGNIFY = 20;
const MRGL_VLIST = 2;
export function parseFlyBsp(bytes, sourceName = ".BSP") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (at) => String.fromCharCode(...bytes.subarray(at, at + 6));
    const isTag = (at) => at + 7 <= bytes.length && TAG.test(text(at)) && bytes[at + 6] === 0;
    let vertices = null;
    const records = [];
    let nodeCount = 0;
    let at = 0;
    while (at < bytes.length) {
        if (!isTag(at))
            throw new Error(`${sourceName}: expected a tag at 0x${at.toString(16)}`);
        const tag = text(at).slice(1, 5);
        at += 7;
        if (tag === "vbin" || tag === "ibin") {
            if (at + 4 > bytes.length)
                throw new Error(`${sourceName}: <${tag}> has no length`);
            const length = view.getUint32(at, true);
            if (at + 4 + length > bytes.length)
                throw new Error(`${sourceName}: <${tag}> runs past the end`);
            if (tag === "vbin") {
                if (length % 12)
                    throw new Error(`${sourceName}: <vbin> is ${length} bytes, not whole vertices`);
                vertices = bytes.subarray(at + 4, at + 4 + length);
            }
            at += 4 + length;
        }
        else if (tag === "abcd") {
            nodeCount++;
            at += 16;
        }
        else if (tag === "mrgl") {
            // The records run to the next structural tag; MRGL has no length of its own to go by.
            let end = at;
            while (end < bytes.length && !(bytes[end] === 0x3c && isTag(end) && STRUCTURE.has(text(end).slice(1, 5))))
                end++;
            if (end - at < 4 || view.getUint32(end - 4, true) !== 0) {
                throw new Error(`${sourceName}: the <mrgl> at 0x${(at - 7).toString(16)} does not end in MRGL_EOL`);
            }
            records.push(bytes.subarray(at, end - 4));
            at = end;
        }
        else if (!STRUCTURE.has(tag)) {
            throw new Error(`${sourceName}: unknown tag <${tag}> at 0x${(at - 7).toString(16)}`);
        }
    }
    if (!vertices)
        throw new Error(`${sourceName}: no <vbin> vertex list`);
    // MRGL_MAGNIFY 65536, MRGL_VLIST from 0, the vertices, every node's records, MRGL_EOL.
    const header = new Uint8Array(20);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, MRGL_MAGNIFY, true);
    headerView.setUint32(4, 65536, true);
    headerView.setUint32(8, MRGL_VLIST, true);
    headerView.setUint32(12, 0, true);
    headerView.setUint32(16, vertices.length / 12, true);
    const total = header.length + vertices.length + records.reduce((sum, r) => sum + r.length, 0) + 4;
    const bin = new Uint8Array(total);
    let cursor = 0;
    for (const part of [header, vertices, ...records]) {
        bin.set(part, cursor);
        cursor += part.length;
    }
    return { model: parseBin(bin), nodeCount };
}
