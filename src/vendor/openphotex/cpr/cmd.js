/** Positions and part centres are in 1/256 ft. */
export const CMD_POSITION_SCALE = 1 / 256;
/** Normals are in 1/65536; normalize after scaling. */
export const CMD_NORMAL_SCALE = 1 / 65536;
/** Texture coordinates are divided by this; V runs top-down. */
export const CMD_UV_SCALE = 0xff0000;
/** The face type every stock car uses. */
export const CMD_FACE_TYPE = 0x29;
/**
 * Parse a .CMD.
 *
 * @throws Error naming the line when a label, count, number, corner count or vertex index is
 *   missing or invalid.
 */
export function parseCprCmd(input, sourceName) {
    const text = typeof input === "string" ? input : new TextDecoder("latin1").decode(input);
    const lines = text
        .replace(/[\u0000\u001a]/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const cursor = new LineCursor(lines, sourceName);
    cursor.expect("name");
    const displayName = cursor.read("model name");
    cursor.expect("lowDetailName");
    const lowDetailName = cursor.read("low-detail model name");
    cursor.expect("lowDetailCenterZ");
    const lowDetailCenterZ = cursor.readNumber("low-detail center Z");
    cursor.expect("material");
    const textureName = cursor.read("material name");
    const model = { displayName, lowDetailName, lowDetailCenterZ, textureName, parts: [], warnings: [] };
    while (!cursor.done()) {
        cursor.expect("partName");
        const name = cursor.read("part name");
        cursor.expect("vertexCount");
        const vertexCount = cursor.readCount("vertex count");
        cursor.expect("faceCount");
        const faceCount = cursor.readCount("face count");
        cursor.expect("center");
        const center = cursor.readVec3("part center");
        cursor.expect("angle");
        const angle = cursor.readVec3("part angle");
        cursor.expect("vertexList");
        const vertices = cursor.readVec3Array(vertexCount, "vertex");
        cursor.expect("normalList");
        const normals = cursor.readVec3Array(vertexCount, "normal");
        cursor.expect("faceList");
        const faces = [];
        for (let face = 0; face < faceCount; face++) {
            const [type, cornerCount] = cursor.readTuple(2, `face ${face + 1} header`);
            const plane = cursor.readTuple(4, `face ${face + 1} plane`);
            if (!Number.isInteger(cornerCount) || cornerCount < 3 || cornerCount > 256) {
                throw cursor.error(`Invalid corner count ${cornerCount} in part ${name}`);
            }
            const corners = [];
            for (let corner = 0; corner < cornerCount; corner++) {
                const [vertexIndex, u, v] = cursor.readTuple(3, `face ${face + 1} corner`);
                if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= vertexCount) {
                    throw cursor.error(`Invalid vertex index ${vertexIndex} in part ${name}`);
                }
                corners.push({ vertexIndex, u, v });
            }
            faces.push({ type, plane, corners });
            const warning = `Unsupported CMD face type ${type}.`;
            if (type !== CMD_FACE_TYPE && !model.warnings.includes(warning))
                model.warnings.push(warning);
        }
        if (angle.x || angle.y || angle.z) {
            model.warnings.push(`Part ${name} has a non-zero angle; its rotation convention is not yet known.`);
        }
        model.parts.push({ name, vertexCount, faceCount, center, angle, vertices, normals, faces });
    }
    return model;
}
/*
  CPR stores its road/street-course wings and its lower speedway/oval wings in the same CMD, and
  the game picks one package from the race setup; drawing both gives coincident spoilers. The
  unsuffixed LFWING, RFWING and RWING form the road package, and LFWING1, RFWING1, RWING1 and
  SPDFIN the speedway one. An alternate counts only when its unsuffixed partner exists, so a
  custom CMD holding only a numbered name is left alone.
*/
/** The parts of each wing package, or null when the model carries no alternate package. */
export function cmdWingPackages(partNames) {
    const names = new Set(partNames);
    const pairs = [["LFWING", "LFWING1"], ["RFWING", "RFWING1"], ["RWING", "RWING1"]]
        .filter(([primary, alternate]) => names.has(primary) && names.has(alternate));
    if (!pairs.length)
        return null;
    const speedway = pairs.map(([, alternate]) => alternate);
    if (names.has("SPDFIN"))
        speedway.push("SPDFIN");
    return { roadCourse: pairs.map(([primary]) => primary), speedway };
}
/*
  How a face's corners become triangles, as both viewers draw them. A triangle is used as is and
  a polygon with more than four corners is fanned from corner 0. A quad is split along whichever
  diagonal gives two triangles that face the same way, and on a tie the larger total area: CPR's
  quads are not always planar, and the wrong diagonal folds them. Pass the corner positions in
  the coordinates you draw with; the choice depends on them.
*/
/** Corner-index triples for a face whose corner positions are `points`. */
export function cmdFaceTriangles(points) {
    if (points.length === 3)
        return [[0, 1, 2]];
    if (points.length !== 4)
        return Array.from({ length: points.length - 2 }, (_, i) => [0, i + 1, i + 2]);
    const optionA = [[0, 1, 2], [0, 2, 3]];
    const optionB = [[0, 1, 3], [1, 2, 3]];
    return scoreSplit(points, optionA) >= scoreSplit(points, optionB) ? optionA : optionB;
}
function scoreSplit(points, triangles) {
    const faceNormals = [];
    let area = 0;
    for (const [i0, i1, i2] of triangles) {
        const a = points[i0], b = points[i1], c = points[i2];
        const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
        const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
        const cross = { x: aby * acz - abz * acy, y: abz * acx - abx * acz, z: abx * acy - aby * acx };
        const length = Math.hypot(cross.x, cross.y, cross.z);
        if (!Number.isFinite(length) || length < 1e-8)
            return -Infinity;
        faceNormals.push({ x: cross.x / length, y: cross.y / length, z: cross.z / length });
        area += length;
    }
    const dot = faceNormals[0].x * faceNormals[1].x + faceNormals[0].y * faceNormals[1].y + faceNormals[0].z * faceNormals[1].z;
    return dot * 100000 + area;
}
class LineCursor {
    index = 0;
    lines;
    sourceName;
    constructor(lines, sourceName) {
        this.lines = lines;
        this.sourceName = sourceName;
    }
    done() {
        return this.index >= this.lines.length;
    }
    read(label) {
        if (this.done())
            throw this.error(`Missing ${label}`);
        return this.lines[this.index++];
    }
    expect(label) {
        const actual = this.read(label);
        if (actual !== label)
            throw this.error(`Expected ${label}, found ${actual}`);
    }
    readNumber(label) {
        const value = Number(this.read(label));
        if (!Number.isFinite(value))
            throw this.error(`Invalid ${label}`);
        return value;
    }
    readCount(label) {
        const value = this.readNumber(label);
        if (!Number.isInteger(value) || value < 0 || value > 200000)
            throw this.error(`Invalid ${label}: ${value}`);
        return value;
    }
    readTuple(length, label) {
        const values = this.read(label).split(",").map(Number);
        if (values.length !== length || values.some((value) => !Number.isFinite(value)))
            throw this.error(`Invalid ${label}`);
        return values;
    }
    readVec3(label) {
        const [x, y, z] = this.readTuple(3, label);
        return { x, y, z };
    }
    readVec3Array(count, label) {
        const out = new Float64Array(count * 3);
        for (let i = 0; i < count; i++) {
            const [x, y, z] = this.readTuple(3, `${label} ${i + 1}`);
            out[i * 3] = x;
            out[i * 3 + 1] = y;
            out[i * 3 + 2] = z;
        }
        return out;
    }
    error(message) {
        return new Error(`${this.sourceName}: ${message} near line ${this.index + 1}`);
    }
}
