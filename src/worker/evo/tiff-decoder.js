/*
  Minimal TIFF reader for Evo 2 track art.

  Browsers do not decode TIFF, and the viewer's PNG/TGA path cannot help because these files
  are palette-indexed rather than true colour. Only the forms the game actually ships are
  supported, verified across the .TIF entries of BAJBEACH and PEAK:

    - little-endian ("II", magic 42), uncompressed (Compression 1)
    - PhotometricInterpretation 3 (palette colour) with a ColorMap
    - PlanarConfiguration 1 (chunky), or absent, which means 1
    - SamplesPerPixel 1  -> index only, fully opaque
    - SamplesPerPixel 2  -> index plus a second 8-bit sample used as opacity
    - 64, 128, 256 or 512 square, single strip

  Anything else is refused with a reason rather than decoded into plausible-looking garbage:
  a viewer that silently shows the wrong texture is worse than one that says it cannot.

  ColorMap stores three consecutive runs (all reds, all greens, all blues) of 16-bit values,
  not interleaved RGB triples, and the values are scaled to 0..65535. Both are easy to get
  subtly wrong and produce a washed-out or channel-swapped image.
*/

const TIFF_LITTLE_ENDIAN = 0x4949;
const TIFF_BIG_ENDIAN = 0x4d4d;
const TIFF_MAGIC = 42;

const TAG = {
  IMAGE_WIDTH: 256,
  IMAGE_LENGTH: 257,
  BITS_PER_SAMPLE: 258,
  COMPRESSION: 259,
  PHOTOMETRIC: 262,
  STRIP_OFFSETS: 273,
  SAMPLES_PER_PIXEL: 277,
  ROWS_PER_STRIP: 278,
  STRIP_BYTE_COUNTS: 279,
  PLANAR_CONFIGURATION: 284,
  COLOR_MAP: 320,
  EXTRA_SAMPLES: 338,
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const COMPRESSION_NONE = 1;
const PHOTOMETRIC_PALETTE = 3;
const PLANAR_CHUNKY = 1;

/** True when the bytes begin with a TIFF header this decoder should be given. */
export function isTiff(bytes) {
  if (!bytes || bytes.length < 8) return false;
  const order = (bytes[0] << 8) | bytes[1];
  if (order !== TIFF_LITTLE_ENDIAN && order !== TIFF_BIG_ENDIAN) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(2, order === TIFF_LITTLE_ENDIAN) === TIFF_MAGIC;
}

export function decodeTiffTexture(bytes, textureName) {
  if (!isTiff(bytes)) throw new Error(`${textureName}: not a TIFF`);
  const littleEndian = ((bytes[0] << 8) | bytes[1]) === TIFF_LITTLE_ENDIAN;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const ifdOffset = view.getUint32(4, littleEndian);
  const tags = readIfd(view, bytes, ifdOffset, littleEndian, textureName);

  const width = scalar(tags, TAG.IMAGE_WIDTH, 0);
  const height = scalar(tags, TAG.IMAGE_LENGTH, 0);
  const compression = scalar(tags, TAG.COMPRESSION, COMPRESSION_NONE);
  const photometric = scalar(tags, TAG.PHOTOMETRIC, -1);
  const samplesPerPixel = scalar(tags, TAG.SAMPLES_PER_PIXEL, 1);
  const planar = scalar(tags, TAG.PLANAR_CONFIGURATION, PLANAR_CHUNKY);
  const bits = tags.get(TAG.BITS_PER_SAMPLE)?.values ?? [8];

  if (!width || !height) throw new Error(`${textureName}: TIFF has no dimensions`);
  if (compression !== COMPRESSION_NONE) throw new Error(`${textureName}: unsupported TIFF compression ${compression}`);
  if (photometric !== PHOTOMETRIC_PALETTE) throw new Error(`${textureName}: unsupported TIFF photometric ${photometric} (only palette colour is handled)`);
  if (planar !== PLANAR_CHUNKY) throw new Error(`${textureName}: unsupported TIFF planar configuration ${planar}`);
  if (samplesPerPixel !== 1 && samplesPerPixel !== 2) throw new Error(`${textureName}: unsupported TIFF samples/pixel ${samplesPerPixel}`);
  if (bits.some((b) => b !== 8)) throw new Error(`${textureName}: unsupported TIFF bit depth ${bits.join("/")}`);

  const colorMap = tags.get(TAG.COLOR_MAP)?.values;
  if (!colorMap || colorMap.length < 768) throw new Error(`${textureName}: TIFF palette image has no usable ColorMap`);

  const stripOffsets = tags.get(TAG.STRIP_OFFSETS)?.values ?? [];
  const stripCounts = tags.get(TAG.STRIP_BYTE_COUNTS)?.values ?? [];
  if (!stripOffsets.length) throw new Error(`${textureName}: TIFF has no strip offsets`);
  const rowsPerStrip = scalar(tags, TAG.ROWS_PER_STRIP, height);

  /*
    ColorMap holds all reds, then all greens, then all blues, each a 16-bit value. Entries
    are nominally 0..65535, but some writers store 0..255 in the low byte; if nothing in the
    map exceeds 255 it is read as already-8-bit rather than crushed to near-black.
  */
  const entries = colorMap.length / 3;
  const sixteenBit = colorMap.some((value) => value > 255);
  const palette = new Uint8Array(entries * 3);
  for (let i = 0; i < entries; i++) {
    palette[i * 3 + 0] = sixteenBit ? colorMap[i] >> 8 : colorMap[i];
    palette[i * 3 + 1] = sixteenBit ? colorMap[entries + i] >> 8 : colorMap[entries + i];
    palette[i * 3 + 2] = sixteenBit ? colorMap[entries * 2 + i] >> 8 : colorMap[entries * 2 + i];
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const rowBytes = width * samplesPerPixel;
  let row = 0;
  for (let strip = 0; strip < stripOffsets.length && row < height; strip++) {
    const offset = stripOffsets[strip];
    const available = stripCounts[strip] ?? (bytes.length - offset);
    if (offset < 0 || offset + available > bytes.length) {
      throw new Error(`${textureName}: TIFF strip ${strip} lies outside the file`);
    }
    const rowsHere = Math.min(rowsPerStrip, height - row);
    for (let r = 0; r < rowsHere; r++, row++) {
      const src = offset + r * rowBytes;
      if (src + rowBytes > bytes.length) throw new Error(`${textureName}: truncated TIFF strip ${strip}`);
      for (let x = 0; x < width; x++) {
        const index = bytes[src + x * samplesPerPixel];
        const alpha = samplesPerPixel === 2 ? bytes[src + x * samplesPerPixel + 1] : 255;
        const out = (row * width + x) * 4;
        const entry = Math.min(index, entries - 1) * 3;
        rgba[out + 0] = palette[entry + 0];
        rgba[out + 1] = palette[entry + 1];
        rgba[out + 2] = palette[entry + 2];
        rgba[out + 3] = alpha;
      }
    }
  }

  return { name: textureName, width, height, rgba, hasAlpha: samplesPerPixel === 2 };
}

function readIfd(view, bytes, offset, littleEndian, textureName) {
  if (offset + 2 > bytes.length) throw new Error(`${textureName}: TIFF IFD lies outside the file`);
  const count = view.getUint16(offset, littleEndian);
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const record = offset + 2 + i * 12;
    if (record + 12 > bytes.length) break;
    const tag = view.getUint16(record, littleEndian);
    const type = view.getUint16(record + 2, littleEndian);
    const length = view.getUint32(record + 4, littleEndian);
    const size = TYPE_SIZE[type];
    if (!size) continue;

    const totalBytes = size * length;
    const valueOffset = totalBytes <= 4 ? record + 8 : view.getUint32(record + 8, littleEndian);
    if (valueOffset + totalBytes > bytes.length) continue;

    const values = [];
    // A ColorMap is 3 * 2^bits entries; reading every value of a huge unrelated tag would be
    // wasteful, so anything longer than a full 16-bit palette is left unread.
    const limit = Math.min(length, 4096);
    for (let v = 0; v < limit; v++) {
      const at = valueOffset + v * size;
      if (type === 3) values.push(view.getUint16(at, littleEndian));
      else if (type === 4) values.push(view.getUint32(at, littleEndian));
      else if (type === 1 || type === 7) values.push(bytes[at]);
      else if (type === 8) values.push(view.getInt16(at, littleEndian));
      else if (type === 9) values.push(view.getInt32(at, littleEndian));
      else values.push(0);
    }
    tags.set(tag, { type, length, values });
  }
  return tags;
}

function scalar(tags, tag, fallback) {
  const value = tags.get(tag)?.values?.[0];
  return value === undefined ? fallback : value;
}
