const LEGACY_PALETTE_SIZE = 256 * 3;
// Square power-of-two 8-bit tiles, 32..1024 (fork: POD1_RAW_MIN_SIDE / POD1_RAW_MAX_SIDE).
const POD1_RAW_MIN_SIDE = 32;
const POD1_RAW_MAX_SIDE = 1024;
const DEFAULT_TEXTURE_PALETTE = Uint8Array.from(
  atob("AAAACAgIEBAQGRkZISEhKSkpMTExOjo6QkJCSkpKUlJSWlpaY2Nja2trc3Nze3t7hISEjIyMlJSUnJycpaWlra2ttbW1vb29xcXFzs7O1tbW3t7e5ubm7+/v9/f3////BQUFCgkJDg0NExISGBgXHRwaIyEeKCgjLS0mMjMqNzkuOj4xPUQ1QEs4QVA7Q1g/SWBFUGpLVXJRWntWYINcZo1ibJZncZ1ueaN2gqp/ibCHkbaPmLyXocKhqciprcytBgYGCwoKEA8PFBMTGRgYHxwcJSEgKiUlLykoNS0sOzIwQTY0Rzs4TT46U0M+WkhBYU1Ga1VMdFtRf2NWimtblHJfn3lkp4NsrYt0tJV9u52GwaWOyK6Xzrih1L+p2sezDgAAKQUBRAkDXw4EehMFlRgGsBwIyyEJ0j0M2FkQ33QT5ZAW7KwZ8sgd+eMg//8jABQUBh4UDCgUEjIUGDwUHkYVI1AVKVoVL2QVNW4VUIYnap85hbdLn89cuudu1P+APz8IT08KXl4Mbm4OfX0Qjo4Snp4Ur68Wv78Yz88a398c7+8e//8g//9N//95//+mPwgITwoKXgwMbg4OfRAQjhISnhQUrxYWvxgYzxoa3xwc7x4e/yEh/01N/3p6/6amQgsLUREOYRkQcCERgS0WkTUYoDwZsUIbv0we1lMZ71wS+WgY/3cj/5hP/7l6/9qmCAg/CgpPDAxeDg5uEBB9EhKOFBSeFhavGBi/GhrPHBzfHh7vICD/TU3/eXn/pqb/Mwg/QwpPUgxeYg5ucRB9ghKOkhSeoxavsxi/wRrPzhzf3B7v6SD/8E3/+Hn+/6b+CD8ICk8KDF4MDm4OEH0QEo4SFJ4UFq8WGL8YGs8aHN8cHu8eI/8jT/9Pev96pv+mGFpzIXOEKYyMMZycOaWlQq2tSr21Usa9Ws7GY9bGY9bOc97Oe+fehO/ehPfnnP/3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    .split("").map((c) => c.charCodeAt(0))
);

/*
  Side length of a square 8-bit RAW tile, or 0 if the byte count is not one.

  Mirrors the fork's Pod1RawSide (TrackPOD/TrackPODFile.cpp:635-645), which replaced eleven
  copies of a hardcoded `switch (size) { case 4096: 64; case 65536: 256; }`. Stock art really
  does use other sizes: ART\CYLWH.RAW in game.pod is 1024 bytes, i.e. 32x32, and was reported
  as a bad texture while the renderer drew it perfectly well.
*/
export function podRawSide(byteLength) {
  for (let side = POD1_RAW_MIN_SIDE; side <= POD1_RAW_MAX_SIDE; side <<= 1) {
    if (byteLength === side * side) return side;
  }
  return 0;
}

export function decodeRawTexture(rawBytes, actBytes, textureName, options = {}) {
  const palette = normalizePalette(actBytes);
  const width = podRawSide(rawBytes.length);
  const height = width;
  if (!width) throw new Error(`Unsupported RAW size for ${textureName}: ${rawBytes.length} bytes`);
  /*
    Cutout transparency.

    MTM2 has no alpha channel anywhere. The engine cuts a texel STRICTLY by face type, and
    the key is the texel resolving to pure black in the palette, not a particular index:

      Traxx_OnGoing_Updates OpenGLTerrainRenderer.cpp:9048
        BYTE a = (r == 0 && g == 0 && b == 0) ? 0 : 255;

    Two things follow, and both used to be wrong here:

      - `cutout` is opt-in per texture. It applies only to faces of type 0x11 / 0x33 (glass,
        trees, fences, grilles). Punching holes in every texture that happens to contain
        index 0 is not what the engine does. The previous code also guessed the key from
        `rawBytes[0]`, i.e. it assumed the top-left pixel was the chroma key.

      - A cut texel keeps BLACK RGB rather than whatever colour sat underneath it. Linear
        filtering bleeds the colour of transparent texels into their opaque neighbours, and
        black is what the legacy colour-key look bleeds. The engine says so outright for its
        own glass sampler: "index-0 texels contribute alpha 0 AND black RGB".
  */
  const cutout = options.cutout === true;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rawBytes.length; i++) {
    const paletteIndex = rawBytes[i];
    const ci = paletteIndex * 3;
    const o = i * 4;
    const r = palette[ci], g = palette[ci + 1], b = palette[ci + 2];
    const cut = cutout && r === 0 && g === 0 && b === 0;
    rgba[o]     = cut ? 0 : r;
    rgba[o + 1] = cut ? 0 : g;
    rgba[o + 2] = cut ? 0 : b;
    rgba[o + 3] = cut ? 0 : 255;
  }
  return { name: textureName, width, height, rgba };
}

/*
  Resolve an .ACT into 8-bit RGB.

  ACT files in this family come in two bit depths and the file itself does not say which:

    - Adobe ACT, full 8-bit channels, 0..255.
    - VGA palettes, 6-bit channels, 0..63, which is what the era's hardware DACs took.

  A 6-bit palette used as if it were 8-bit renders at roughly a quarter brightness, which is
  the "everything is nearly black" look. Detection is by content, the same way JSPod does it:
  if any channel byte exceeds 63 the palette must be 8-bit, because a 6-bit one cannot
  produce that value. Otherwise scale, with (v*255 + 31)/63 so 0 maps to 0 and 63 maps to
  exactly 255 rather than 252.

  A palette that is genuinely 8-bit but happens to use only dark colours is indistinguishable
  from a 6-bit one, and gets brightened. That is the same trade JSPod makes: the false
  positive is a dim palette rendered bright, the false negative is every 6-bit palette in the
  game rendered black.
*/
export function decodeActPalette(actBytes) {
  if (!actBytes || actBytes.length < LEGACY_PALETTE_SIZE) return null;
  const raw = actBytes.subarray
    ? actBytes.subarray(0, LEGACY_PALETTE_SIZE)
    : actBytes.slice(0, LEGACY_PALETTE_SIZE);

  for (let i = 0; i < LEGACY_PALETTE_SIZE; i++) {
    if (raw[i] > 63) return raw.slice();          // 8-bit, use as-is
  }
  const out = new Uint8Array(LEGACY_PALETTE_SIZE);
  for (let i = 0; i < LEGACY_PALETTE_SIZE; i++) {
    out[i] = Math.round((raw[i] * 255 + 31) / 63);
  }
  return out;
}

function normalizePalette(bytes) {
  return decodeActPalette(bytes) ?? DEFAULT_TEXTURE_PALETTE.slice();
}
