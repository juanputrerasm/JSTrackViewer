import { applyOpacityPlane, decodeActPalette, decodeRawTexture, rawTextureSide } from "../../vendor/openphotex/index.js";
import { decodeTiffTexture, isTiff } from "./tiff-decoder.js";

/*
  Evo texture decoding: indexed .RAW + .ACT, an optional .OPA opacity plane, or a .TIF.

  This does not go through the viewer's existing decodeRawTexture because that one is built
  around the MTM family's rules, and two of them are wrong for Evo:

    - MTM has no alpha anywhere, so transparency is a colour key: a texel whose palette entry
      is pure black is cut, everything else is opaque. Evo instead ships a real 8-bit opacity
      plane beside the texture. Every stock .OPA holds a full 0..255 gradient (AS3PINE1.OPA
      uses all 256 levels), so treating it as a binary key would harden every soft tree and
      grass edge into a stencil.

    - MTM resolves one palette per track. Evo resolves one per texture: all 3,757 terrain
      slots across the four stock tracks have their own same-stem .ACT, and there is no
      track-wide palette anywhere in the package to fall back on.

  Evo .RAW images are square and unheadered, so the side comes from the byte count, same as
  the existing reader. An .OPA is one byte per pixel and pairs with its texture by stem; it
  is only applied when it has exactly as many bytes as the image has pixels, since a mismatch
  means the pairing was wrong rather than that the plane needs resampling.

  The decoding itself is OpenPhotex's; the TIFF path stays here until TIFF is extracted too.
*/

/** Side length of a square 8-bit image with this many bytes, or 0 if there is none. */
export function evoRawSide(byteLength) {
  return rawTextureSide(byteLength, "evo");
}

/**
 * Decodes one Evo texture to RGBA.
 *
 * `rawBytes` is either an indexed .RAW or a .TIF; `actBytes` is the .RAW's palette and
 * `opaBytes` its optional opacity plane. Returns { name, width, height, rgba, hasAlpha }.
 */
export function decodeEvoTexture(rawBytes, actBytes, opaBytes, textureName) {
  if (isTiff(rawBytes)) {
    const decoded = decodeTiffTexture(rawBytes, textureName);
    return applyOpacityPlane(decoded, opaBytes);
  }

  const side = evoRawSide(rawBytes?.length ?? 0);
  if (!side) throw new Error(`${textureName}: unsupported RAW size ${rawBytes?.length ?? 0} bytes`);

  const palette = decodeActPalette(actBytes);
  if (!palette) throw new Error(`${textureName}: no usable .ACT palette`);

  const { width, height, rgba } = decodeRawTexture(rawBytes, palette, { family: "evo" });
  return applyOpacityPlane({ name: textureName, width, height, rgba, hasAlpha: false }, opaBytes);
}
