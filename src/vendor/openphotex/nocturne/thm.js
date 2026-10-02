export const NOCTURNE_THM_WIDTH = 320;
export const NOCTURNE_THM_HEIGHT = 240;
export const NOCTURNE_THM_SLOTS = 10;
const SLOT_PIXELS = NOCTURNE_THM_WIDTH * NOCTURNE_THM_HEIGHT;
const SLOT_BYTES = SLOT_PIXELS * 4;
/** Read Nocturne's ten-slot, half-resolution RGBX thumbnail bank. */
export function parseNocturneThm(bytes, name = "THM") {
    const expected = SLOT_BYTES * NOCTURNE_THM_SLOTS;
    if (bytes.length !== expected)
        throw new Error(`${name}: THM is ${bytes.length} bytes, expected ${expected}.`);
    const thumbnails = [];
    for (let slot = 0; slot < NOCTURNE_THM_SLOTS; slot++) {
        const rgba = new Uint8ClampedArray(SLOT_BYTES);
        let empty = true;
        const base = slot * SLOT_BYTES;
        for (let pixel = 0; pixel < SLOT_PIXELS; pixel++) {
            const source = base + pixel * 4, target = pixel * 4;
            const r = bytes[source], g = bytes[source + 1], b = bytes[source + 2], unused = bytes[source + 3];
            if (unused !== 0)
                throw new Error(`${name}: THM slot ${slot} has a nonzero RGBX padding byte.`);
            rgba[target] = r;
            rgba[target + 1] = g;
            rgba[target + 2] = b;
            rgba[target + 3] = 255;
            if (r !== 0 || g !== 0 || b !== 0)
                empty = false;
        }
        thumbnails.push({ rgba, empty });
    }
    return { width: NOCTURNE_THM_WIDTH, height: NOCTURNE_THM_HEIGHT, thumbnails };
}
