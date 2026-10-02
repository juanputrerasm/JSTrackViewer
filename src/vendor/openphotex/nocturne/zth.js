export const NOCTURNE_ZTH_WIDTH = 64;
export const NOCTURNE_ZTH_HEIGHT = 48;
export const NOCTURNE_ZTH_MAP_BYTES = NOCTURNE_ZTH_WIDTH * NOCTURNE_ZTH_HEIGHT * 4;
/** Read the 24-bit depth thumbnails stored in SET camera order. Zero means no sampled surface. */
export function parseNocturneZth(bytes, name = "ZTH") {
    if (bytes.length === 0 || bytes.length % NOCTURNE_ZTH_MAP_BYTES !== 0) {
        throw new Error(`${name}: ZTH length ${bytes.length} is not a whole 64x48 depth map.`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const depthMaps = [];
    for (let base = 0; base < bytes.length; base += NOCTURNE_ZTH_MAP_BYTES) {
        const depth = new Uint32Array(NOCTURNE_ZTH_WIDTH * NOCTURNE_ZTH_HEIGHT);
        for (let pixel = 0; pixel < depth.length; pixel++) {
            const value = view.getUint32(base + pixel * 4, true);
            if (value > 0x00ff_ffff)
                throw new Error(`${name}: ZTH map ${depthMaps.length} has a value wider than 24 bits.`);
            depth[pixel] = value;
        }
        depthMaps.push(depth);
    }
    return { width: NOCTURNE_ZTH_WIDTH, height: NOCTURNE_ZTH_HEIGHT, depthMaps };
}
