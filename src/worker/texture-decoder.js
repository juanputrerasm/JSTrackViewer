/*
  Indexed .RAW textures and .ACT palettes.

  Decoding is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library): the size rules, the 6-bit palette test and the colour-key cutout all live there.
  What stays here is the viewer's fallback palette for a texture with no .ACT, which is retail
  palette data and so is not part of OpenPhotex.
*/
import {
  decodeActPalette,
  decodeRawTexture as decodeRaw,
  rawTextureSide,
} from "../vendor/openphotex/index.js";

export { decodeActPalette };

// Used when a texture has no palette at all. It is MTM1's METALCR2 (see bundled-palettes.js)
// but for one byte, and is kept as it always was.
const DEFAULT_TEXTURE_PALETTE = Uint8Array.from(
  atob("AAAACAgIEBAQGRkZISEhKSkpMTExOjo6QkJCSkpKUlJSWlpaY2Nja2trc3Nze3t7hISEjIyMlJSUnJycpaWlra2ttbW1vb29xcXFzs7O1tbW3t7e5ubm7+/v9/f3////BQUFCgkJDg0NExISGBgXHRwaIyEeKCgjLS0mMjMqNzkuOj4xPUQ1QEs4QVA7Q1g/SWBFUGpLVXJRWntWYINcZo1ibJZncZ1ueaN2gqp/ibCHkbaPmLyXocKhqciprcytBgYGCwoKEA8PFBMTGRgYHxwcJSEgKiUlLykoNS0sOzIwQTY0Rzs4TT46U0M+WkhBYU1Ga1VMdFtRf2NWimtblHJfn3lkp4NsrYt0tJV9u52GwaWOyK6Xzrih1L+p2sezDgAAKQUBRAkDXw4EehMFlRgGsBwIyyEJ0j0M2FkQ33QT5ZAW7KwZ8sgd+eMg//8jABQUBh4UDCgUEjIUGDwUHkYVI1AVKVoVL2QVNW4VUIYnap85hbdLn89cuudu1P+APz8IT08KXl4Mbm4OfX0Qjo4Snp4Ur68Wv78Yz88a398c7+8e//8g//9N//95//+mPwgITwoKXgwMbg4OfRAQjhISnhQUrxYWvxgYzxoa3xwc7x4e/yEh/01N/3p6/6amQgsLUREOYRkQcCERgS0WkTUYoDwZsUIbv0we1lMZ71wS+WgY/3cj/5hP/7l6/9qmCAg/CgpPDAxeDg5uEBB9EhKOFBSeFhavGBi/GhrPHBzfHh7vICD/TU3/eXn/pqb/Mwg/QwpPUgxeYg5ucRB9ghKOkhSeoxavsxi/wRrPzhzf3B7v6SD/8E3/+Hn+/6b+CD8ICk8KDF4MDm4OEH0QEo4SFJ4UFq8WGL8YGs8aHN8cHu8eI/8jT/9Pev96pv+mGFpzIXOEKYyMMZycOaWlQq2tSr21Usa9Ws7GY9bGY9bOc97Oe+fehO/ehPfnnP/3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    .split("").map((c) => c.charCodeAt(0))
);

/** Side length of a square 8-bit RAW tile, or 0 if the byte count is not one the games use. */
export function podRawSide(byteLength) {
  return rawTextureSide(byteLength);
}

/**
 * RGBA for a classic .RAW texture, drawn through `actBytes` (or the fallback palette).
 * `options.cutout` applies the colour key: palette-black texels become transparent.
 */
export function decodeRawTexture(rawBytes, actBytes, textureName, options = {}) {
  if (!podRawSide(rawBytes.length)) throw new Error(`Unsupported RAW size for ${textureName}: ${rawBytes.length} bytes`);
  const palette = decodeActPalette(actBytes) ?? DEFAULT_TEXTURE_PALETTE;
  const { width, height, rgba } = decodeRaw(rawBytes, palette, { cutout: options.cutout === true });
  return { name: textureName, width, height, rgba };
}
