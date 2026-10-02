import { LineReader, nocturneDataLines } from "./text.js";
function parseText(bytes, name) {
    const r = new LineReader(nocturneDataLines(bytes), name);
    const version = r.count("version");
    if (version < 5 || version > 8)
        throw new Error(`${name}: unsupported text KFM version ${version}.`);
    const [vertexCount, polygonCount, textureCount, partCount, frameCount] = r.nums("counts", 5);
    const useCollisionList = r.count("collision flag") !== 0;
    const transparentPixel = version >= 6 ? r.count("transparent-pixel flag") !== 0 : false;
    const disableBackfaceCulling = version >= 8 ? r.count("backface-culling flag") !== 0 : false;
    const envMapList = version >= 7 ? r.count("environment-map flag") !== 0 : false;
    const vertices = new Int32Array(vertexCount * frameCount * 3);
    for (let i = 0; i < vertices.length; i += 3)
        vertices.set(r.nums("vertex", 3), i);
    const polygons = [];
    for (let i = 0; i < polygonCount; i++) {
        const v = r.nums("polygon");
        const n = v[1];
        if (!Number.isInteger(n) || n < 3 || n > 4 || v.length !== 2 + n * 3)
            throw new Error(`${name}: invalid polygon ${i}.`);
        const corners = [];
        for (let j = 0; j < n; j++)
            corners.push({ vertex: v[2 + j * 3], u: v[3 + j * 3], v: v[4 + j * 3] });
        polygons.push({ type: 0, texture: v[0], plane: null, corners });
    }
    const envMapOpacity = new Uint8Array(envMapList ? polygonCount : 0);
    for (let i = 0; i < envMapOpacity.length; i++)
        envMapOpacity[i] = r.count("environment-map opacity");
    const textures = Array.from({ length: textureCount }, () => r.next("texture"));
    const parts = Array.from({ length: partCount }, () => {
        const [vertexCount, polygonCount] = r.nums("part", 2);
        return { vertexCount, polygonCount };
    });
    r.done();
    return { version, binary: false, vertexCount, polygonCount, textureCount, partCount, frameCount, useCollisionList, transparentPixel, disableBackfaceCulling, envMapList, vertices, polygons, envMapOpacity, textures, parts };
}
class BinaryReader {
    offset = 0;
    view;
    bytes;
    name;
    constructor(bytes, name) { this.bytes = bytes; this.name = name; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
    i32() { if (this.offset + 4 > this.bytes.length)
        throw new Error(`${this.name}: truncated binary KFM.`); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
    text(length) { if (this.offset + length > this.bytes.length)
        throw new Error(`${this.name}: truncated binary KFM.`); const v = new TextDecoder("latin1").decode(this.bytes.subarray(this.offset, this.offset + length)).replace(/\0.*$/, ""); this.offset += length; return v; }
}
function parseBinary(bytes, name) {
    const r = new BinaryReader(bytes, name);
    const version = r.i32();
    if (version !== 3 && version !== 4)
        throw new Error(`${name}: unsupported binary KFM version ${version}.`);
    const vertexCount = r.i32(), polygonCount = r.i32(), textureCount = r.i32(), partCount = r.i32(), frameCount = r.i32();
    for (const [label, count] of [["vertices", vertexCount], ["polygons", polygonCount], ["textures", textureCount], ["parts", partCount], ["frames", frameCount]])
        if (count < 0 || count > 10_000_000)
            throw new Error(`${name}: invalid ${label} count ${count}.`);
    const useCollisionList = version >= 4 ? r.i32() !== 0 : false;
    const vertices = new Int32Array(vertexCount * frameCount * 3);
    for (let i = 0; i < vertices.length; i++)
        vertices[i] = r.i32();
    const polygons = [];
    for (let i = 0; i < polygonCount; i++) {
        const type = r.i32(), n = r.i32();
        const plane = [r.i32(), r.i32(), r.i32(), r.i32()];
        const corners = [];
        for (let j = 0; j < 4; j++) {
            const corner = { vertex: r.i32(), u: r.i32(), v: r.i32() };
            if (j < n)
                corners.push(corner);
        }
        polygons.push({ type, texture: -1, plane, corners });
    }
    for (const polygon of polygons)
        polygon.texture = r.i32();
    const textures = Array.from({ length: textureCount }, () => r.text(24));
    const parts = Array.from({ length: partCount }, () => ({ vertexCount: r.i32(), polygonCount: r.i32() }));
    if (r.offset !== bytes.length)
        throw new Error(`${name}: ${bytes.length - r.offset} trailing binary KFM bytes.`);
    return { version, binary: true, vertexCount, polygonCount, textureCount, partCount, frameCount, useCollisionList, transparentPixel: false, disableBackfaceCulling: false, envMapList: false, vertices, polygons, envMapOpacity: new Uint8Array(0), textures, parts };
}
export function parseKfm(bytes, name = "KFM") {
    return bytes[0] === 0x2f && bytes[1] === 0x2f ? parseText(bytes, name) : parseBinary(bytes, name);
}
