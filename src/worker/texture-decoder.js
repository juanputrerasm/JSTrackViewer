const LEGACY_PALETTE_SIZE = 256 * 3;
const DEFAULT_TEXTURE_PALETTE = Uint8Array.from(
  atob("AAAACAgIEBAQGRkZISEhKSkpMTExOjo6QkJCSkpKUlJSWlpaY2Nja2trc3Nze3t7hISEjIyMlJSUnJycpaWlra2ttbW1vb29xcXFzs7O1tbW3t7e5ubm7+/v9/f3////BQUFCgkJDg0NExISGBgXHRwaIyEeKCgjLS0mMjMqNzkuOj4xPUQ1QEs4QVA7Q1g/SWBFUGpLVXJRWntWYINcZo1ibJZncZ1ueaN2gqp/ibCHkbaPmLyXocKhqciprcytBgYGCwoKEA8PFBMTGRgYHxwcJSEgKiUlLykoNS0sOzIwQTY0Rzs4TT46U0M+WkhBYU1Ga1VMdFtRf2NWimtblHJfn3lkp4NsrYt0tJV9u52GwaWOyK6Xzrih1L+p2sezDgAAKQUBRAkDXw4EehMFlRgGsBwIyyEJ0j0M2FkQ33QT5ZAW7KwZ8sgd+eMg//8jABQUBh4UDCgUEjIUGDwUHkYVI1AVKVoVL2QVNW4VUIYnap85hbdLn89cuudu1P+APz8IT08KXl4Mbm4OfX0Qjo4Snp4Ur68Wv78Yz88a398c7+8e//8g//9N//95//+mPwgITwoKXgwMbg4OfRAQjhISnhQUrxYWvxgYzxoa3xwc7x4e/yEh/01N/3p6/6amQgsLUREOYRkQcCERgS0WkTUYoDwZsUIbv0we1lMZ71wS+WgY/3cj/5hP/7l6/9qmCAg/CgpPDAxeDg5uEBB9EhKOFBSeFhavGBi/GhrPHBzfHh7vICD/TU3/eXn/pqb/Mwg/QwpPUgxeYg5ucRB9ghKOkhSeoxavsxi/wRrPzhzf3B7v6SD/8E3/+Hn+/6b+CD8ICk8KDF4MDm4OEH0QEo4SFJ4UFq8WGL8YGs8aHN8cHu8eI/8jT/9Pev96pv+mGFpzIXOEKYyMMZycOaWlQq2tSr21Usa9Ws7GY9bGY9bOc97Oe+fehO/ehPfnnP/3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    .split("").map((c) => c.charCodeAt(0))
);

export function decodeRawTexture(rawBytes, actBytes, textureName) {
  const palette = normalizePalette(actBytes);
  const width = rawBytes.length === 4096 ? 64 : rawBytes.length === 65536 ? 256 : 0;
  const height = width;
  if (!width) throw new Error(`Unsupported RAW size for ${textureName}: ${rawBytes.length} bytes`);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rawBytes.length; i++) {
    const ci = rawBytes[i] * 3;
    const o = i * 4;
    rgba[o]     = palette[ci];
    rgba[o + 1] = palette[ci + 1];
    rgba[o + 2] = palette[ci + 2];
    rgba[o + 3] = rawBytes[i] === 0 ? 0 : 255;
  }
  return { name: textureName, width, height, rgba };
}

function normalizePalette(bytes) {
  if (bytes && bytes.length >= LEGACY_PALETTE_SIZE) return bytes.slice(0, LEGACY_PALETTE_SIZE);
  return DEFAULT_TEXTURE_PALETTE.slice();
}
