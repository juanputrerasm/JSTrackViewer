/*
  True-colour texture decoding, for Community Patch 3 HD art.

  CP3 packs ART\<stem>.PNG or .TGA beside (or instead of) the 8-bit .RAW + .ACT pair. The
  decoding here is JSPod's (src/worker/image-decoder.js); the acceptance policy is the Traxx
  fork's (Traxx/HDTexture.h), and the two are worth keeping together because the policy is
  what stops a bad file from being drawn as if it were fine.

  Two rules from the fork are load-bearing:

    - Format is decided by CONTENT SIGNATURE, never by extension. A JPEG renamed to .PNG is
      refused with a reason rather than silently handed to a decoder that might cope with it.
      The engine cannot read it, so the viewer showing it would be lying about the track.

    - Sources must be SQUARE and a POWER OF TWO, 32..1024. Nothing is silently resampled;
      an odd size is reported and the caller falls back to the legacy 8-bit tile.
*/

export const HDTEX_MIN_DIM = 32;
export const HDTEX_MAX_DIM = 1024;

const SIGNATURES = [
  { name: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { name: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: "BMP", bytes: [0x42, 0x4d] },
  { name: "DDS", bytes: [0x44, 0x44, 0x53, 0x20] },
  { name: "PSD", bytes: [0x38, 0x42, 0x50, 0x53] },
];

/** The format a file actually is, by signature. "TGA" has none, so it is never claimed here. */
export function detectImageFormat(bytes) {
  for (const sig of SIGNATURES) {
    if (bytes.length < sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => bytes[i] === b)) return sig.name;
  }
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 &&
      bytes[10] === 0x42 && bytes[11] === 0x50) return "WEBP";
  return null;
}

/**
 * Reject anything the engine could not use. Returns a reason string, or null if acceptable.
 */
export function hdDimensionRefusal(name, width, height) {
  if (width !== height) return `${name}: ${width}x${height} is not square`;
  if (width < HDTEX_MIN_DIM || width > HDTEX_MAX_DIM) {
    return `${name}: ${width}x${height} is outside ${HDTEX_MIN_DIM}..${HDTEX_MAX_DIM}`;
  }
  if ((width & (width - 1)) !== 0) return `${name}: ${width}x${height} is not a power of two`;
  return null;
}

/**
 * Decode an HD texture to RGBA.
 *
 * @param {Uint8Array} bytes  the file exactly as it sat in the pod
 * @param {string} name       for messages
 * @param {string} extension  the extension it was found under, ".PNG" or ".TGA"
 * @returns {Promise<{name, width, height, rgba, sourceFormat}>}
 */
export async function decodeTrueColorTexture(bytes, name, extension) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const declared = String(extension ?? "").toUpperCase().replace(/^\./, "");
  const actual = detectImageFormat(source);

  if (declared === "TGA") {
    // TGA has no signature to check, so a file claiming to be one only has to not be
    // something else recognisable.
    if (actual) throw new Error(`${name}: named .TGA but the content is ${actual}`);
    return decodeTga(source, name);
  }

  if (actual === null) throw new Error(`${name}: unrecognised image content`);
  if (actual !== "PNG") throw new Error(`${name}: named .${declared} but the content is ${actual}`);
  return decodeBrowserImage(source, name, "image/png", "PNG");
}

async function decodeBrowserImage(bytes, name, mimeType, sourceFormat) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    throw new Error(`${name}: ${sourceFormat} decoding is not available in this worker`);
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error(`${name}: could not create a decode canvas`);
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { name, width: bitmap.width, height: bitmap.height, rgba, sourceFormat };
  } finally {
    bitmap.close();
  }
}

/** Uncompressed (type 2) and RLE (type 10) true-colour TGA, 24 or 32 bit. */
export function decodeTga(bytes, name = "texture.tga") {
  if (bytes.length < 18) throw new Error(`${name}: TGA header is truncated`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0];
  const colorMapType = bytes[1];
  const imageType = bytes[2];
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bitsPerPixel = bytes[16];
  const descriptor = bytes[17];

  if (colorMapType !== 0 || (imageType !== 2 && imageType !== 10)) {
    throw new Error(`${name}: expected uncompressed or RLE true-colour TGA`);
  }
  if (!width || !height || (bitsPerPixel !== 24 && bitsPerPixel !== 32)) {
    throw new Error(`${name}: expected 24- or 32-bit TGA pixels`);
  }

  const bytesPerPixel = bitsPerPixel / 8;
  let offset = 18 + idLength;
  const pixelCount = width * height;
  const decoded = new Uint8ClampedArray(pixelCount * 4);
  let pixel = 0;

  const readPixel = () => {
    if (offset + bytesPerPixel > bytes.length) throw new Error(`${name}: TGA pixel data is truncated`);
    const b = bytes[offset++];
    const g = bytes[offset++];
    const r = bytes[offset++];
    const a = bytesPerPixel === 4 ? bytes[offset++] : 255;
    return [r, g, b, a];
  };
  const writePixel = (rgba) => {
    if (pixel >= pixelCount) throw new Error(`${name}: TGA has more pixels than its header says`);
    decoded.set(rgba, pixel * 4);
    pixel++;
  };

  if (imageType === 2) {
    while (pixel < pixelCount) writePixel(readPixel());
  } else {
    while (pixel < pixelCount) {
      if (offset >= bytes.length) throw new Error(`${name}: TGA RLE packet is truncated`);
      const packet = bytes[offset++];
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        const rgba = readPixel();
        for (let i = 0; i < count; i++) writePixel(rgba);
      } else {
        for (let i = 0; i < count; i++) writePixel(readPixel());
      }
    }
  }

  // Bit 5 of the descriptor puts the origin at the top, bit 4 at the right. The rest of this
  // viewer wants row 0 to be the top of the image, which is what a top-origin TGA already is.
  const topOrigin = !!(descriptor & 0x20);
  const rightOrigin = !!(descriptor & 0x10);
  const rgba = topOrigin && !rightOrigin
    ? decoded
    : reorient(decoded, width, height, topOrigin, rightOrigin);
  return { name, width, height, rgba, sourceFormat: "TGA" };
}

function reorient(source, width, height, topOrigin, rightOrigin) {
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const targetX = rightOrigin ? width - 1 - x : x;
      const targetY = topOrigin ? y : height - 1 - y;
      const sourceOffset = (y * width + x) * 4;
      output.set(source.subarray(sourceOffset, sourceOffset + 4), (targetY * width + targetX) * 4);
    }
  }
  return output;
}
