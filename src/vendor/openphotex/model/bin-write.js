/*
  Writing an MRGL .BIN.

  The writer takes what parseBin reads back: raw vertex words, and faces grouped under the
  texture, material and facet opcode they are drawn with. It lays out the records and derives
  the two per-face values the format stores but a caller should not have to compute, the stored
  normal and the plane term, from the vertex words themselves, so a face can never disagree
  with the geometry the file holds. Which facet type and material flags a face should get, and
  how a source model's axes become vertex words, are the caller's.

  Ported from JSMTM2Converter's src/convert/bin-writer.js, the only BIN writer, whose policy
  (face types for the engine's fast paths, Evo transparency, axis changes) stays there.

  The records written:

    MRGL_MAGNIFY    power                          once, first
    MRGL_VLIST      0, count, then count x 3 words
    MRGL_TEXTURE    slot 0, 16-byte name           when the texture changes and its name fits 15 bytes
    MRGL_TEXTURE64  slot 0, 64-byte name           when it changes and the name is longer
    MRGL_MATERIAL   flags, nine 16.16 values, foliage word    per group that has one
    MRGL_MATERIAL2  flags2, 16.16 strength, five words        per group that has one
    a facet         corner count, stored normal, plane term, then per corner the index and,
                    for a mapped facet, u and v
    MRGL_EOL
*/
import { BIN_MAPPED_FACETS, BIN_UNMAPPED_FACETS, MRGL } from "./bin.js";
const FIXED = 65536;
/** Texture names up to this many bytes fit an MRGL_TEXTURE record; longer ones get TEXTURE64. */
const SHORT_TEXTURE_BYTES = 15;
/**
 * Write an MRGL .BIN.
 *
 * @throws RangeError for a facet opcode parseBin does not read, a face with fewer than three
 *   corners, or a vertex index outside the model.
 */
export function writeBin(model) {
    const vertices = model.vertices;
    const vertexCount = Math.floor(vertices.length / 3);
    const out = new Words();
    out.u32(MRGL.MAGNIFY).u32(model.magnify ?? FIXED).u32(MRGL.VLIST).u32(0).u32(vertexCount);
    for (let i = 0; i < vertexCount * 3; i++)
        out.i32(vertices[i]);
    let degenerateFaces = 0;
    let texture = null;
    for (const group of model.groups) {
        const mapped = BIN_MAPPED_FACETS.has(group.opcode);
        if (!mapped && !BIN_UNMAPPED_FACETS.has(group.opcode))
            throw new RangeError(`MRGL record ${group.opcode} is not a facet this writer emits.`);
        if (group.texture !== texture) {
            const name = new TextEncoder().encode(group.texture);
            const long = name.length > SHORT_TEXTURE_BYTES;
            out.u32(long ? MRGL.TEXTURE64 : MRGL.TEXTURE).u32(0).fixedString(name, long ? 64 : 16);
            texture = group.texture;
        }
        if (group.material)
            writeMaterial(out, group.material);
        if (group.material2)
            writeMaterial2(out, group.material2);
        for (const face of group.faces) {
            const indices = face.vertexIndices;
            if (indices.length < 3)
                throw new RangeError(`A BIN face needs at least three corners, got ${indices.length}.`);
            for (const index of indices) {
                if (!Number.isInteger(index) || index < 0 || index >= vertexCount)
                    throw new RangeError(`Vertex index ${index} is outside the model's ${vertexCount} vertices.`);
            }
            const normal = binFaceNormal(vertices, indices);
            if (!normal) {
                degenerateFaces++;
                continue;
            }
            out.u32(group.opcode).u32(indices.length)
                .i32(normal[0]).i32(normal[1]).i32(normal[2]).i32(binPlaneTerm(normal, vertices, indices[0]));
            for (let k = 0; k < indices.length; k++) {
                out.u32(indices[k]);
                if (mapped)
                    out.i32(face.u?.[k] ?? 0).i32(face.v?.[k] ?? 0);
            }
        }
    }
    out.u32(MRGL.EOL);
    return { bytes: out.finish(), degenerateFaces };
}
/*
  The stored normal, 16.16 fixed point, from the face's first three corners.

  The stored normal opposes the cross product of the corners taken in (x, depth, height) order.
  The vertex words are stored (x, height, depth), an odd permutation of that frame, so the
  plain cross of the words as stored points the way the stored normal does. Across every stock
  model of all six games (214,914 faces with area) it points the same way on 99.9 to 100% per
  game, and matches to within 1/1000 on 74% (MTM1, MTM2) to 96% (Hellbender); the rest were
  written by tools that rounded differently or took other corners of a larger face.

  Computed in doubles from the integer words: the cross of two edges can pass 2^31, never 2^53.
  Null when the corners have no area.
*/
export function binFaceNormal(vertices, indices) {
    const a = indices[0] * 3, b = indices[1] * 3, c = indices[2] * 3;
    const u = [vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]];
    const v = [vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(n[0], n[1], n[2]);
    if (!length)
        return null;
    return [Math.round(n[0] / length * FIXED), Math.round(n[1] / length * FIXED), Math.round(n[2] / length * FIXED)];
}
/*
  The fourth word of a facet header: the stored normal dotted with the face's first corner, in
  the file's units (16.16 normal by raw vertex word), wrapped to 32 bits. Stock files hold
  exactly that on 99.96% of 21,053 faces across eight tracks, to within the rounding of the
  tool that computed it. Zero puts the face's plane through the model's origin for any engine
  path that culls or clips with it.
*/
export function binPlaneTerm(normal, vertices, firstIndex) {
    const at = firstIndex * 3;
    return Math.round(normal[0] * vertices[at] + normal[1] * vertices[at + 1] + normal[2] * vertices[at + 2]) | 0;
}
function writeMaterial(out, m) {
    const tint = m.tint ?? [1, 1, 1];
    out.u32(MRGL.MATERIAL).u32(m.flags)
        .i32(fixed(m.reflectivity ?? 0)).i32(fixed(m.fresnelBias ?? 0)).i32(fixed(m.fresnelStrength ?? 0))
        .i32(fixed(m.baseAlpha ?? 1)).i32(fixed(m.specPower ?? 32)).i32(fixed(m.emissive ?? 0))
        .i32(fixed(tint[0])).i32(fixed(tint[1])).i32(fixed(tint[2]))
        .u32(((m.translucency ?? 0) & 0xffff) << 16 | ((m.alphaRef ?? 0) & 0xffff));
}
function writeMaterial2(out, m) {
    out.u32(MRGL.MATERIAL2).u32(m.flags2).i32(fixed(m.normalStrength ?? 1));
    for (let i = 0; i < 5; i++)
        out.i32(m.reserved?.[i] ?? 0);
}
function fixed(value) {
    return Math.round(value * FIXED);
}
/** Little-endian 32-bit words, grown as needed. */
class Words {
    buffer = new Uint8Array(4096);
    view = new DataView(this.buffer.buffer);
    length = 0;
    u32(value) {
        this.reserve(4);
        this.view.setUint32(this.length, value >>> 0, true);
        this.length += 4;
        return this;
    }
    /** Rounded, then wrapped to 32 bits. */
    i32(value) {
        this.reserve(4);
        this.view.setInt32(this.length, Math.round(value), true);
        this.length += 4;
        return this;
    }
    /** `bytes` cut to width - 1 and NUL-padded to `width`. */
    fixedString(bytes, width) {
        this.reserve(width);
        this.buffer.fill(0, this.length, this.length + width);
        this.buffer.set(bytes.subarray(0, width - 1), this.length);
        this.length += width;
        return this;
    }
    finish() {
        return this.buffer.slice(0, this.length);
    }
    reserve(bytes) {
        if (this.length + bytes <= this.buffer.length)
            return;
        let size = this.buffer.length * 2;
        while (size < this.length + bytes)
            size *= 2;
        const grown = new Uint8Array(size);
        grown.set(this.buffer.subarray(0, this.length));
        this.buffer = grown;
        this.view = new DataView(grown.buffer);
    }
}
