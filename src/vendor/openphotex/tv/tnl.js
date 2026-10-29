import { toDataLines } from "./coords.js";
/** The longest tunnel the engine accepts. */
export const TUNNEL_MAX_SEGMENTS = 90;
/** Segment length along the tube, in the file's 256-world-unit units: one terrain cell. */
export const TUNNEL_SEGMENT_LENGTH = 0x1000;
/** World units per .TNL coordinate unit. */
export const TUNNEL_UNIT = 256;
const ints = (line) => {
    if (line === undefined || line === "")
        return null;
    const values = line.split(",").map((v) => Number.parseInt(v.trim(), 10));
    return values.every(Number.isFinite) ? values : null;
};
/**
 * Parses a .TNL file. Returns null when the segment count is missing or out of range; a file
 * that ends early keeps the segments read so far, with `complete` false.
 */
export function parseTvTunnel(bytes) {
    if (!bytes || !bytes.length)
        return null;
    const lines = toDataLines(bytes).filter((line) => line !== "");
    const count = ints(lines[0])?.[0];
    if (count === undefined || count < 0 || count > TUNNEL_MAX_SEGMENTS)
        return null;
    const segments = [];
    let i = 1;
    for (let n = 0; n < count; n++) {
        const head = ints(lines[i]);
        const angA = ints(lines[i + 1]);
        const radA = ints(lines[i + 2]);
        const angB = ints(lines[i + 3]);
        const radB = ints(lines[i + 4]);
        const singles = [5, 6, 7, 8, 9].map((k) => ints(lines[i + k])?.[0]);
        if (!head || head.length < 5 || !angA || angA.length < 2 || !radA || radA.length < 2 ||
            !angB || angB.length < 2 || !radB || radB.length < 2 || singles.some((v) => v === undefined))
            break;
        const sides = head[4];
        if (sides < 1 || sides > 64)
            break;
        const textures = [];
        for (let k = 0; k < sides; k++) {
            const t = ints(lines[i + 10 + k])?.[0];
            if (t === undefined)
                break;
            textures.push(t);
        }
        const tail = [0, 1, 2].map((k) => ints(lines[i + 10 + sides + k])?.[0]);
        if (textures.length < sides || tail.some((v) => v === undefined))
            break;
        const [timer, unk48, open, type, textureList] = singles;
        segments.push({
            index: n,
            centreA: [head[0], head[1]],
            centreB: [head[2], head[3]],
            sides,
            ringA: { startAngle: angA[0], endAngle: angA[1], radiusX: radA[0], radiusY: radA[1] },
            ringB: { startAngle: angB[0], endAngle: angB[1], radiusX: radB[0], radiusY: radB[1] },
            open,
            type,
            timer,
            textureList,
            sideTextures: textures,
            unknown: [angA[2] ?? 0, unk48, tail[0], tail[1], tail[2]],
        });
        i += 13 + sides;
    }
    return { segments, complete: segments.length === count && i === lines.length };
}
/**
 * The geometry TV's tunnel builder (0x33f00) makes from a segment.
 *
 * Each ring has `sides - open` vertices on its ellipse, vertex k at angle
 * `start + k * (end - start) / (sides - open)`, x = cos * radiusX, y = sin * radiusY, relative
 * to ring A's centre; ring B adds its own centre's offset. When the ring is open, the vertices
 * from `sides - open` onwards sit on the tube's centre line, so the faces that reach them close
 * the cut side towards the axis; on both rings that point is ring A's centre, as the builder
 * writes it. Coordinates are absolute (centre added) and z advances one segment length per index.
 */
export function tunnelSegmentGeometry(segment) {
    const ringCount = Math.max(1, segment.sides - Math.max(0, segment.open));
    const z0 = segment.index * TUNNEL_SEGMENT_LENGTH;
    const turn = (angle) => (angle / 65536) * 2 * Math.PI;
    const ring = (r, centre, z) => {
        // The builder steps by the truncated quotient, accumulated.
        const step = Math.trunc((r.endAngle - r.startAngle) / ringCount);
        const out = [];
        for (let k = 0; k < segment.sides; k++) {
            if (k < ringCount) {
                const t = turn(r.startAngle + k * step);
                out.push([centre[0] + Math.cos(t) * r.radiusX, centre[1] + Math.sin(t) * r.radiusY, z]);
            }
            else {
                out.push([segment.centreA[0], segment.centreA[1], z]);
            }
        }
        return out;
    };
    const ringA = ring(segment.ringA, segment.centreA, z0);
    const ringB = ring(segment.ringB, segment.centreB, z0 + TUNNEL_SEGMENT_LENGTH);
    const faces = Array.from({ length: segment.sides }, (_, k) => ({
        a: k, b: (k + 1) % segment.sides, texture: segment.sideTextures[k] ?? 0,
    }));
    return { ringA, ringB, faces };
}
