export const NOCTURNE_FOG_GRID_SIDE = 16;
export const NOCTURNE_FOG_GRID_BYTES = 4096;
export function parseNocturneFog(bytes, name = "FOG") {
    if (bytes.length < NOCTURNE_FOG_GRID_BYTES)
        throw new Error(`${name}: FOG is smaller than its 16x16x16 density grid.`);
    const density = bytes.slice(0, NOCTURNE_FOG_GRID_BYTES);
    const tag = bytes.length >= 4099 ? String.fromCharCode(bytes[4096], bytes[4097], bytes[4098]) : "";
    const encoding = tag === "EFD" || tag === "LZW" ? tag : bytes.length > 4096 ? "raw" : null;
    const payloadOffset = encoding === "EFD" || encoding === "LZW" ? 4099 : 4096;
    return { density, encoding, payload: bytes.slice(payloadOffset), imageWidth: 320, imageHeight: 240 };
}
