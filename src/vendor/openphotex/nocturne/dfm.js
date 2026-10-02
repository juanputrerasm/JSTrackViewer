import { LineReader, csv, nocturneDataLines, unquote } from "./text.js";
const triple = (v) => [v[0], v[1], v[2]];
export function parseDfm(bytes, name = "DFM") {
    const r = new LineReader(nocturneDataLines(bytes), name);
    const version = r.count("version");
    if (version !== 7)
        throw new Error(`${name}: unsupported DFM version ${version}.`);
    const [lodCount, textureSetCount, textureCount, boneCount, partCount] = r.nums("counts", 5);
    const lodHeaders = Array.from({ length: lodCount }, () => {
        const [vertexCount, triangleCount, capTriangleCount, pixelHeight, shadowOnly] = r.nums("LOD", 5);
        return { vertexCount, triangleCount, capTriangleCount, pixelHeight, shadowOnly: shadowOnly !== 0 };
    });
    const skeleton = r.next("skeleton file");
    const parts = [];
    for (let i = 0; i < partCount; i++) {
        const header = csv(r.next(`part ${i}`));
        if (header.length < 2)
            throw new Error(`${name}: invalid part ${i}.`);
        const adjacentCount = header.length >= 3 ? Number(header[2]) : 0;
        const adjacent = new Int32Array(adjacentCount);
        for (let j = 0; j < adjacentCount; j++)
            adjacent[j] = r.count(`part ${i} adjacent part`);
        const lods = Array.from({ length: lodCount }, () => {
            const [triangleCount, capTriangleCount] = r.nums(`part ${i} LOD`, 2);
            return { triangleCount, capTriangleCount };
        });
        parts.push({ name: unquote(header[0]), dominantBone: Number(header[1]), adjacentParts: adjacent, lods });
    }
    const lods = lodHeaders.map((header) => ({ ...header, vertices: [], triangles: [], capTriangleParts: new Int32Array(header.capTriangleCount) }));
    for (let lodIndex = 0; lodIndex < lods.length; lodIndex++) {
        const header = lodHeaders[lodIndex], vertices = lods[lodIndex].vertices;
        for (let i = 0; i < header.vertexCount; i++) {
            const influenceCount = r.count("vertex influence count");
            const influences = [];
            for (let j = 0; j < influenceCount; j++) {
                const [bone, weight, x, y, z] = r.nums("vertex influence", 5);
                influences.push({ bone, weight, position: [x, y, z] });
            }
            vertices.push(influences);
        }
    }
    for (let lodIndex = 0; lodIndex < lods.length; lodIndex++) {
        const header = lodHeaders[lodIndex], triangles = lods[lodIndex].triangles;
        // Cap triangles live in the same triangle stream; the following list only assigns
        // each cap to the part whose cut surface it closes.
        for (let i = 0; i < header.triangleCount + header.capTriangleCount; i++) {
            const v = r.nums("triangle", 10);
            triangles.push({ texture: v[0], vertices: [v[1], v[4], v[7]], uv: [[v[2], v[3]], [v[5], v[6]], [v[8], v[9]]] });
        }
    }
    for (const lod of lods) {
        for (let i = 0; i < lod.capTriangleParts.length; i++)
            lod.capTriangleParts[i] = r.count("cap triangle part");
    }
    const textures = Array.from({ length: textureSetCount * textureCount }, () => r.next("texture"));
    const boneOrigins = Array.from({ length: boneCount }, () => triple(r.nums("bone origin", 3)));
    const rootOffsetScale = triple(r.nums("root offset scale", 3));
    const bias = triple(r.nums("bias", 3));
    const partForBone = new Int32Array(boneCount);
    for (let i = 0; i < boneCount; i++)
        partForBone[i] = r.count("part for bone");
    r.done();
    return { version, textureSetCount, textureCount, boneCount, skeleton, lods, parts, textures, boneOrigins, rootOffsetScale, bias, partForBone };
}
