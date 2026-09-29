/*
  .BIN models: the MRGL command stream of Monster Truck Madness 1 and 2, CART Precision Racing,
  Terminal Velocity, Fury3 and Hellbender.

  A model is a sequence of 32-bit little-endian records, each an opcode word followed by its
  payload. It opens with MRGL_MAGNIFY (the model's scale power) and the model's vertex list,
  then state records (texture, colour, material) and facets, and ends at MRGL_EOL. An
  ANIMATED_BIN is not geometry at all but a keyframe control file naming the frame models; an
  LWO signature marks a LightWave object the engine never draws.

  Consolidated from the three decoders that had drifted apart: JSTrackViewer's
  src/worker/bin-decoder.js (the baseline: its record walk follows the engine's own stride
  table), JSTruckViewer's and JSPod's. On all 2,277 stock and community geometry models the
  three walks agree face for face, and none stops early; the records they disagreed on (a second
  vertex list, MRGL_OUTLINE, opcodes with no bespoke handling) do not occur in any of them. This
  returns the model as the file states it: raw vertex words, faces in file order with the state
  in force when each was read. Scaling, axes, triangulation and shading are the consumer's; see
  docs/BIN.md and BIN_GEOMETRY_DIVISOR.
*/
const SIGNATURE_LWO = 0x4d524f46;
const SIGNATURE_ANIMATED_BIN = 0x00000020;
const MAX_CORNERS_PER_FACE = 256;
const MAX_VERTICES = 200000;
/*
  MRGL record opcodes, transcribed from the engine's 3D.H by way of Traxx_OnGoing_Updates
  TrackPOD/TrackPODModel.cpp:27-78. They are DECIMAL in the engine; writing them as hex is what
  once let MRGL_XTFACET (33) sit one keystroke from MRGL_UZFACETTTMAP (51 = 0x33).
*/
export const MRGL = {
    EOL: 0, ORGIN: 1, VLIST: 2, ILIST: 3, TLIST: 4, FACET: 5, GFACET: 6, TFACET: 7, GTFACET: 8,
    ICALL: 9, COLOR: 10, SCALL: 11, ORDER: 12, TEXTURE: 13, FACETTMAP: 14, TTFACET: 15, TCALL: 16,
    FACETTTMAP: 17, JUMP: 18, MAGNIFY: 20, PTFACET: 21, OUTLINE: 22, ZBUFFERPOLY: 23, ZFACETTMAP: 24,
    ZFACET: 25, ZTFACET: 26, ZGFACET: 27, TEXTURECYCLE: 29, FFACETTMAP: 30, CLIST: 31, KEYFRAME: 32,
    XTFACET: 33, ZPFACETTMAP: 34, ZGFACETTMAP: 41, UZFACETTTMAP: 51, UZFACETTMAP: 52, ZXFACETTMAP: 56,
    OPACITY: 61, TEXTURE64: 62, MATERIAL: 63, MATFACET: 64,
    // Not in the Traxx fork's table; found by JSPod against real models.
    KEYFRAME64: 65,
    MATERIAL2: 66, NORMALMAP: 67,
};
/** Facets with per-corner texture coordinates. MATFACET also takes the current material. */
const MAPPED_FACETS = new Set([
    MRGL.FACETTTMAP, MRGL.ZFACETTMAP, MRGL.ZPFACETTMAP, MRGL.ZGFACETTMAP, MRGL.UZFACETTTMAP,
    MRGL.UZFACETTMAP, MRGL.FACETTMAP, MRGL.MATFACET,
]);
/** Facets with vertex indices only. */
const UNMAPPED_FACETS = new Set([MRGL.FACET, MRGL.ZFACET, MRGL.GFACET, MRGL.TTFACET]);
/** Legacy transparent (colour-keyed) face types, for faces with no material. */
export const BIN_TRANSPARENT_FACE_TYPES = new Set([0x11, 0x33]);
/** The untextured face type that takes its colour from the preceding MRGL_COLOR. */
export const BIN_SOLID_FACE_TYPE = 0x19;
/*
  MRGL_MATERIAL flag bits: what decides whether a face is glass, a foliage cutout, additive,
  two-sided or emissive. Traxx strides over material records without reading them, since its
  editor preview renders no materials; a viewer of the game has to read them. Values established
  by JSPod's BIN viewer against real models.
*/
export const MRGLMAT = {
    LIT: 0x0001,
    BLEND: 0x0004,
    ALPHATEST: 0x0008,
    ADDITIVE: 0x0010,
    TWOSIDED: 0x0080,
    NOZWRITE: 0x0100,
    EMISSIVE: 0x0200,
    TINT: 0x0400,
    ALPHAREF: 0x0800,
    TEXSOLID: 0x2000,
};
/** MRGL_MATERIAL2 flag bits. */
export const MRGLMAT2 = { NORMALMAP: 0x0001 };
/*
  Geometry divisors: editor units per vertex = (raw >> 1) * 65536 / (magnify * divisor).

  The TV-family engines size a model as world = raw * 65536 / magnify, on the full int32.
  FuryEdit.exe computes a model's extents exactly that way (0x4053b0: scale =
  (0x7FFFFFFF / magnify) * 2, then fixmul against each raw vertex), and every .DEF header's hit
  radius agrees: it equals the model's vertex radius at that scale times 1.00..1.4 (median 1.15,
  exactly 1.000 for CUBE, STATION and FACBILD) across 193 TV and Fury3 definitions. Those world
  units are the placement units, so the divisor follows from each game's world units per
  64-unit editor cell:

    TV/F3  2^20 per cell -> raw * 4 / magnify -> divisor 8192
    HB     2^19 per cell -> raw * 8 / magnify -> divisor 4096

  TV/F3 once took 10922.667 (= 2^15 / 3, the vertical height-step scale), which drew every model
  at 75% of its width. The HB value was already right, and the same derivation reproduces it,
  which is the check that the rule holds across the family. MTM and CPR use 64.
*/
export const BIN_GEOMETRY_DIVISOR = { legacy: 64, hellbender: 4096, terminalVelocity: 8192 };
/*
  Record lengths for records the walk steps over, mirroring the engine's MRGLSizeRaw() via the
  fork's mrglSkipInts (TrackPODModel.cpp:104-192). A decoder that stops at the first record it
  does not draw loses every polygon after it, which is how MRGL_MATERIAL2 and MRGL_NORMALMAP
  once silently truncated models.
*/
const FIXED_INTS = new Map([
    [MRGL.ORGIN, 4], [MRGL.ICALL, 8], [MRGL.SCALL, 2], [MRGL.ORDER, 7], [MRGL.TCALL, 5],
    [MRGL.MAGNIFY, 2], [MRGL.ZBUFFERPOLY, 3], [MRGL.OPACITY, 2], [MRGL.MATERIAL, 12],
    [MRGL.MATERIAL2, 8], [MRGL.NORMALMAP, 18],
    // keyFrameStruct is 344 bytes, a size the engine asserts because it is the on-disk stride.
    [MRGL.KEYFRAME, 86],
    // keyFrame64Struct, the wide-name keyframe record: 4376 bytes.
    [MRGL.KEYFRAME64, 1094],
    // jumpStruct: followed at render time, but the engine's load-time validate walk strides it by 8.
    [MRGL.JUMP, 2],
]);
const COUNTED3 = new Map([[MRGL.VLIST, 3], [MRGL.TLIST, 2], [MRGL.CLIST, 1]]);
const FACET_1PV = new Set([
    MRGL.FACET, MRGL.GFACET, MRGL.TFACET, MRGL.GTFACET, MRGL.TTFACET, MRGL.PTFACET, MRGL.ZTFACET,
    MRGL.ZGFACET, MRGL.XTFACET,
]);
const FACET_3PV = new Set([MRGL.FFACETTMAP, MRGL.ZPFACETTMAP, MRGL.ZXFACETTMAP]);
// The fork caps stored model texture names at MODELTEXNAMELEN, the POD1 name budget. A name that
// fills all 64 bytes of a TEXTURE64 record is not NUL-terminated in the file.
export const BIN_TEXTURE_NAME_MAX = 31;
/** Parse a .BIN. Never throws: an unreadable model is returned with `kind` or `stopReason` saying so. */
export function parseBin(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const model = {
        kind: "unknown", signature: null, magnify: null, magnifyRecords: [], vertexListValid: false,
        vertices: new Int32Array(0), faces: [], materials: [], materials2: [], frameNames: [],
        incomplete: false, stopReason: null, warnings: [],
    };
    if (bytes.length < 4)
        return model;
    const r = new Reader(bytes);
    const signature = r.int();
    model.signature = signature;
    if (signature === SIGNATURE_LWO) {
        model.kind = "lwo";
        return model;
    }
    if (signature === SIGNATURE_ANIMATED_BIN) {
        readAnimated(bytes, model);
        return model;
    }
    if (signature !== MRGL.MAGNIFY)
        return model;
    model.kind = "mrgl";
    if (r.remaining() < 4)
        return model;
    model.magnify = r.int();
    walk(r, model);
    return model;
}
/*
  An ANIMATED_BIN is a keyframe CONTROL file: it names the frame models, each a separate .BIN
  in the archive, and the game cycles them in place. Its layout is fixed by the engine and read
  the same way by CTrackPODModel::GetAniName (TrackPOD/TrackPODModel.cpp:408-452):

    int[0]  0x00000020
    int[2]  frame count
    int[3]  magnify (6,553 to 131,072 in the stock files)
    int[4]  0, a vertex count; int[5] 0, MRGL_EOL
    byte 24 onwards: the frame names, 16 bytes each, NUL-padded

  All 53 stock and community ANIMATED_BINs carry no geometry.
*/
function readAnimated(bytes, model) {
    model.kind = "animated";
    if (bytes.length < 12)
        return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length >= 16)
        model.magnify = view.getInt32(12, true);
    const frameCount = view.getInt32(8, true);
    if (frameCount < 1 || frameCount > 4096)
        return;
    for (let i = 0, at = 24; i < frameCount && at + 16 <= bytes.length; i++, at += 16) {
        const name = fixedString(bytes, at, 16).trim();
        if (name)
            model.frameNames.push(name);
    }
}
function walk(r, model) {
    // The MRGL_VLIST that follows the magnify record: opcode, slot, then the vertex count.
    r.skip(8);
    const vertexCount = r.remaining() >= 4 ? r.int() : -1;
    if (vertexCount < 0 || vertexCount > MAX_VERTICES || r.remaining() < vertexCount * 12) {
        model.stopReason = `vertex count ${vertexCount} is out of range`;
        model.incomplete = true;
        return;
    }
    model.vertexListValid = true;
    model.vertices = new Int32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount * 3; i++)
        model.vertices[i] = r.int();
    let texture = "";
    let textureOpcode = null;
    let solidColor = 0;
    let material = null;
    let material2 = null;
    const stop = (reason, warning) => {
        if (warning)
            model.warnings.push(warning);
        model.incomplete = true;
        model.stopReason = reason;
    };
    while (r.remaining() >= 4) {
        const offset = r.position;
        const token = r.int();
        switch (token) {
            // The real terminator. It used to share an arm with the unknown-opcode default, which is
            // how new engine opcodes once truncated models in silence.
            case MRGL.EOL:
                return;
            // A second vertex list; the first is part of the header.
            case MRGL.VLIST:
            case MRGL.OUTLINE: {
                const ints = recordInts(token, r);
                if (ints <= 0)
                    return stop(`record type ${token} runs past the end of the file`);
                r.skip((ints - 1) * 4);
                break;
            }
            case MRGL.ILIST:
                if (r.remaining() < 8)
                    return stop("truncated MRGL_ILIST");
                r.skip(8);
                if (vertexCount < 1 || r.remaining() < vertexCount * 12)
                    return stop("truncated MRGL_ILIST");
                r.skip(vertexCount * 12);
                break;
            case MRGL.TLIST: {
                if (r.remaining() < 8)
                    return stop("truncated MRGL_TLIST");
                r.skip(4);
                const n = r.int();
                if (n < 0 || n > 4096 || r.remaining() < n * 8)
                    return stop("truncated MRGL_TLIST");
                r.skip(n * 8);
                break;
            }
            case MRGL.TEXTURE:
                if (r.remaining() < 20)
                    return stop("truncated MRGL_TEXTURE");
                r.skip(4); // slot
                texture = r.string(16);
                textureOpcode = token;
                break;
            /*
              MRGL_TEXTURE64: MRGL_TEXTURE with a 64-byte name, added because a texture name can now be
              longer than the old record held. It carries the name, so it is parsed, not strided.
            */
            case MRGL.TEXTURE64:
                if (r.remaining() < 68)
                    return stop("truncated MRGL_TEXTURE64", "Truncated MRGL_TEXTURE64 record");
                r.skip(4); // slot
                texture = r.string(64);
                textureOpcode = token;
                break;
            // A state change selecting the current material; its flags decide how every MATFACET after
            // it is shaded, so it is read, not strided.
            case MRGL.MATERIAL:
                if (r.remaining() < 44)
                    return stop("truncated MRGL_MATERIAL", "Truncated MRGL_MATERIAL record");
                model.materials.push(readMaterial(r, model.materials.length + 1));
                material = model.materials.length - 1;
                break;
            case MRGL.MATERIAL2:
                if (r.remaining() < 28)
                    return stop("truncated MRGL_MATERIAL2", "Truncated MRGL_MATERIAL2 record");
                model.materials2.push(readMaterial2(r));
                material2 = model.materials2.length - 1;
                break;
            case MRGL.TEXTURECYCLE: {
                if (r.remaining() < 24)
                    return stop("truncated MRGL_TEXTURECYCLE");
                r.skip(4);
                const num = r.int();
                r.skip(16);
                if (num < 0 || num > 1024)
                    return stop("implausible MRGL_TEXTURECYCLE count");
                // The frames' names, 32 bytes each; the first is the texture in effect.
                if (r.remaining() >= num * 32) {
                    for (let i = 0; i < num; i++) {
                        const name = r.string(32);
                        if (i === 0) {
                            texture = name;
                            textureOpcode = token;
                        }
                    }
                }
                else if (r.remaining() >= num * 8)
                    r.skip(num * 8);
                else
                    return stop("truncated MRGL_TEXTURECYCLE");
                break;
            }
            /*
              Face colour (a COLORREF) for the flat 0x19 faces that follow. It must NOT clear the active
              texture, which stays in effect for later mapped faces; clearing it silently ended texture
              mapping partway through a model. This deliberately diverges from Traxx, whose MRGL_COLOR
              arm clears currtexturename (TrackPODModel.cpp:716-724); JSPod established the behaviour
              against real models.
            */
            case MRGL.COLOR:
                if (r.remaining() < 4)
                    return stop("truncated MRGL_COLOR");
                solidColor = r.int() & 0x00ffffff;
                break;
            case MRGL.ORDER:
                if (r.remaining() < 24)
                    return stop("truncated MRGL_ORDER");
                r.skip(24);
                break;
            case MRGL.JUMP:
                if (r.remaining() < 4)
                    return stop("truncated MRGL_JUMP");
                r.skip(4);
                break;
            case MRGL.MAGNIFY:
                if (r.remaining() < 4)
                    return stop("truncated MRGL_MAGNIFY");
                model.magnifyRecords.push(r.int());
                break;
            case MRGL.ZBUFFERPOLY:
                if (r.remaining() < 8)
                    return stop("truncated MRGL_ZBUFFERPOLY");
                r.skip(8);
                break;
            case MRGL.CLIST: {
                if (r.remaining() < 8)
                    return stop("truncated MRGL_CLIST");
                r.skip(4);
                const n = r.int();
                if (n < 0 || n > MAX_VERTICES || r.remaining() < n * 4)
                    return stop("truncated MRGL_CLIST");
                r.skip(n * 4);
                break;
            }
            default: {
                if (MAPPED_FACETS.has(token) || UNMAPPED_FACETS.has(token)) {
                    const isMat = token === MRGL.MATFACET;
                    const face = readFace(r, token, offset, MAPPED_FACETS.has(token), texture, textureOpcode, solidColor, isMat ? material : null, isMat ? material2 : null, vertexCount);
                    if (face)
                        model.faces.push(face);
                    break;
                }
                /*
                  Anything else is still, mostly, a record whose length the engine knows: step over it.
                  Only an opcode with no stride anywhere is unwalkable, and that alone stops the walk. A
                  model that stops early is a valid model with fewer polygons, so the reason is kept.
                */
                const ints = recordInts(token, r);
                if (ints > 0) {
                    r.skip((ints - 1) * 4);
                    break;
                }
                return stop(ints === 0 ? `record type ${token} runs past the end of the file` : `unknown record type ${token}`);
            }
        }
    }
}
/*
  A facet: the corner count, a 16-byte header (stored normal x, y, z and a fourth word), then per
  corner an index, or an index and u and v. A face whose count is implausible or runs past the
  file consumes only its count word, exactly as every decoder has always read it; one whose
  indices fit neither zero- nor one-based numbering is consumed and dropped.
*/
function readFace(r, opcode, offset, mapped, textureName, textureOpcode, solidColor, material, material2, vertexCount) {
    if (vertexCount < 1)
        return null;
    const n = r.int();
    if (n < 3 || n > MAX_CORNERS_PER_FACE || r.remaining() < 16 + n * (mapped ? 12 : 4))
        return null;
    const storedNormal = [r.int(), r.int(), r.int()];
    const magic = r.int();
    const vertexIndices = [];
    const u = [];
    const v = [];
    for (let i = 0; i < n; i++) {
        vertexIndices.push(r.int());
        u.push(mapped ? r.int() : 0);
        v.push(mapped ? r.int() : 0);
    }
    let oneBased = false;
    if (!vertexIndices.every((i) => i >= 0 && i < vertexCount)) {
        if (!vertexIndices.every((i) => i - 1 >= 0 && i - 1 < vertexCount))
            return null;
        for (let i = 0; i < n; i++)
            vertexIndices[i]--;
        oneBased = true;
    }
    return { opcode, offset, mapped, textureName, textureOpcode, solidColor, material, material2, storedNormal, magic, vertexIndices, u, v, oneBased };
}
function readMaterial(r, id) {
    const flags = r.int() >>> 0;
    const reflectivity = fixed16(r.int());
    const fresnelBias = fixed16(r.int());
    const fresnelStrength = fixed16(r.int());
    const baseAlpha = fixed16(r.int());
    const specPower = fixed16(r.int());
    const emissive = fixed16(r.int());
    const tint = [fixed16(r.int()), fixed16(r.int()), fixed16(r.int())];
    const foliage = r.int() >>> 0;
    return { id, flags, reflectivity, fresnelBias, fresnelStrength, baseAlpha, specPower, emissive, tint, alphaRef: foliage & 0xffff, translucency: foliage >>> 16 };
}
function readMaterial2(r) {
    const flags2 = r.int() >>> 0;
    const normalStrength = fixed16(r.int());
    const reserved = [];
    for (let i = 0; i < 5; i++)
        reserved.push(r.int());
    return { flags2, normalStrength, reserved };
}
function fixed16(value) {
    return value / 65536;
}
/** A record's total length in ints (opcode included), 0 when it runs past the end, -1 when unknown. */
function recordInts(token, r) {
    const avail = 1 + Math.floor(r.remaining() / 4);
    const word = (i) => r.peekInt(r.position + (i - 1) * 4);
    const fixed = FIXED_INTS.get(token);
    if (fixed !== undefined)
        return avail < fixed ? 0 : fixed;
    const per3 = COUNTED3.get(token);
    if (per3 !== undefined) {
        if (avail < 3)
            return 0;
        const n = word(2);
        // Bounded via `avail` so a hostile count cannot overflow the test meant to catch it.
        if (n === null || n < 0 || n > Math.floor((avail - 3) / per3))
            return 0;
        return 3 + n * per3;
    }
    if (token === MRGL.OUTLINE) {
        if (avail < 2)
            return 0;
        const n = word(1);
        if (n === null || n < 0 || n > avail - 2)
            return 0;
        return 2 + n;
    }
    if (FACET_1PV.has(token) || FACET_3PV.has(token)) {
        if (avail < 6)
            return 0;
        const per = FACET_3PV.has(token) ? 3 : 1;
        const n = word(1);
        if (n === null || n < 0 || n > Math.floor((avail - 6) / per))
            return 0;
        return 6 + n * per;
    }
    return -1;
}
const latin1 = new TextDecoder("latin1");
function fixedString(bytes, offset, width) {
    let end = offset;
    while (end < offset + width && end < bytes.length && bytes[end] !== 0)
        end++;
    return latin1.decode(bytes.subarray(offset, end));
}
class Reader {
    position = 0;
    bytes;
    view;
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    remaining() {
        return this.bytes.length - this.position;
    }
    int() {
        const value = this.view.getInt32(this.position, true);
        this.position += 4;
        return value;
    }
    peekInt(at) {
        return at >= 0 && at + 4 <= this.bytes.length ? this.view.getInt32(at, true) : null;
    }
    skip(n) {
        this.position += n;
    }
    string(width) {
        const value = fixedString(this.bytes, this.position, width);
        this.position += width;
        return value;
    }
}
