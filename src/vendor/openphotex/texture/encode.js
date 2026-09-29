/*
  Encoding true-colour art as an 8-bit .RAW and its own .ACT, the inverse of decodeRawTexture.

  Ported from JSMTM2Converter's src/convert/raw-act.js and palette.js, which produce the legacy
  texture pair for an MTM2 track: the software renderer has no HD path, and an unmodified 1998
  install reads nothing else.
*/
/*
  The cap keeps photographic art from growing a histogram without bound; terrain tiles never
  approach it.
*/
const MAX_HISTOGRAM = 1 << 18;
/*
  Adds up to `budget` texels of one RGBA image to a colour histogram, skipping transparent ones
  (alpha under 128), which are never drawn.

  Count exact colours, not RGB555 buckets. Bucketing looks harmless because MTM2's fog map is
  RGB555 anyway, but the histogram is the median cut's input: rounding every channel to five
  bits before choosing 219 colours collapsed Baja Beach's 1,792 distinct terrain colours into
  223 buckets and left an RMS error of 4.07 where exact counting reaches 1.95.
*/
export function sampleForPalette(histogram, rgba, budget = 4096) {
    const texels = rgba.length >> 2;
    const step = Math.max(1, Math.ceil(texels / budget));
    for (let i = 0; i < texels; i += step) {
        const at = i << 2;
        if (rgba[at + 3] < 128)
            continue;
        const key = rgba[at] << 16 | rgba[at + 1] << 8 | rgba[at + 2];
        const seen = histogram.get(key);
        if (seen === undefined && histogram.size >= MAX_HISTOGRAM)
            continue;
        histogram.set(key, (seen ?? 0) + 1);
    }
    return histogram;
}
/*
  Median cut. Split the box that costs the most (its population times its longest side cubed)
  along that side at the weighted median, until there are `count` boxes. Each box becomes its
  population-weighted mean, which makes the result follow the art's actual density rather than
  the corners of its bounding box. Over Baja Beach's 191 terrain tiles this reaches an RMS error
  of 1.95 where a fixed 6x6x6 cube gives 24.54.

  An empty histogram gives the cube (216 colours and a 4-step grey ramp). The result can have
  fewer than `count` colours when the art has fewer.
*/
export function medianCutPalette(histogram, count) {
    const entries = [...histogram].map(([key, weight]) => ({
        rgb: [key >> 16 & 255, key >> 8 & 255, key & 255], weight,
    }));
    if (!entries.length)
        return colourCube();
    let boxes = [entries];
    while (boxes.length < count) {
        boxes.sort((a, b) => cost(b) - cost(a));
        const box = boxes[0];
        if (box.length < 2)
            break;
        boxes.shift();
        const axis = widestAxis(box);
        box.sort((a, b) => a.rgb[axis] - b.rgb[axis]);
        const total = box.reduce((sum, entry) => sum + entry.weight, 0);
        let seen = 0, cut = 1;
        for (let i = 0; i < box.length - 1; i++) {
            seen += box[i].weight;
            if (seen * 2 >= total) {
                cut = i + 1;
                break;
            }
        }
        boxes.push(box.slice(0, cut), box.slice(cut));
    }
    return boxes.map(mean);
}
function cost(box) {
    const weight = box.reduce((sum, entry) => sum + entry.weight, 0);
    return weight * Math.pow(Math.max(1, spread(box, widestAxis(box))), 3);
}
function widestAxis(box) {
    let axis = 0, best = -1;
    for (let c = 0; c < 3; c++) {
        const s = spread(box, c);
        if (s > best) {
            best = s;
            axis = c;
        }
    }
    return axis;
}
function spread(box, axis) {
    let low = 255, high = 0;
    for (const entry of box) {
        low = Math.min(low, entry.rgb[axis]);
        high = Math.max(high, entry.rgb[axis]);
    }
    return high - low;
}
function mean(box) {
    const weight = box.reduce((sum, entry) => sum + entry.weight, 0) || 1;
    return [0, 1, 2].map((c) => Math.round(box.reduce((sum, e) => sum + e.rgb[c] * e.weight, 0) / weight));
}
/** The 6x6x6 colour cube and a 4-step grey ramp: the palette for art with no colours to fit. */
export function colourCube() {
    const out = [];
    for (let r = 0; r < 6; r++)
        for (let g = 0; g < 6; g++)
            for (let b = 0; b < 6; b++) {
                out.push([Math.round(r * 255 / 5), Math.round(g * 255 / 5), Math.round(b * 255 / 5)]);
            }
    for (let i = 0; i < 4; i++)
        out.push([Math.round(i * 255 / 3), Math.round(i * 255 / 3), Math.round(i * 255 / 3)]);
    return out;
}
/*
  One RGBA image as a .RAW index plane and its own 256-colour .ACT, each texture with its own
  palette as Evo's art and MTM2's stock art both have.

  Legacy art keys transparency on palette index 0 (see decodeRawTexture's colour key). So an
  image with real alpha (any texel under 128) gives up index 0 to it, left black, and quantises
  into the other 255; one without keeps all 256. .RAW textures are square; anything else throws.
*/
export function encodeRawTexture(rgba, width, height) {
    if (width !== height)
        throw new RangeError(`Legacy RAW art must be square, got ${width}x${height}`);
    const keyed = hasAlpha(rgba);
    const first = keyed ? 1 : 0;
    const palette = medianCutPalette(sampleForPalette(new Map(), rgba, width * height), 256 - first);
    const act = new Uint8Array(768);
    for (let i = 0; i < palette.length; i++)
        act.set(palette[i], (first + i) * 3);
    const raw = new Uint8Array(width * height);
    for (let i = 0; i < raw.length; i++) {
        const at = i << 2;
        if (keyed && rgba[at + 3] < 128) {
            raw[i] = 0;
            continue;
        }
        let best = first, distance = Infinity;
        for (let index = 0; index < palette.length; index++) {
            const [r, g, b] = palette[index];
            const dr = r - rgba[at], dg = g - rgba[at + 1], db = b - rgba[at + 2];
            const candidate = dr * dr + dg * dg + db * db;
            if (candidate < distance) {
                distance = candidate;
                best = first + index;
            }
        }
        raw[i] = best;
    }
    return { raw, act };
}
function hasAlpha(rgba) {
    for (let at = 3; at < rgba.length; at += 4)
        if (rgba[at] < 128)
            return true;
    return false;
}
