class Reader {
    offset = 0;
    view;
    bytes;
    name;
    constructor(bytes, name) { this.bytes = bytes; this.name = name; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
    need(n) { if (this.offset + n > this.bytes.length)
        throw new Error(`${this.name}: truncated GEO at byte ${this.offset}.`); }
    i32() { this.need(4); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
    u32() { this.need(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    f32() { this.need(4); const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
    vec() { return [this.f32(), this.f32(), this.f32()]; }
    bytesCopy(n) { this.need(n); const v = this.bytes.slice(this.offset, this.offset + n); this.offset += n; return v; }
}
export function parseNocturneGeo(bytes, name = "GEO") {
    const r = new Reader(bytes, name);
    const version = r.i32();
    if (version !== 4)
        throw new Error(`${name}: unsupported GEO version ${version}.`);
    const grid = [r.i32(), r.i32(), r.i32()];
    const cellCount = grid[0] * grid[1] * grid[2];
    if (grid.some((v) => v <= 0) || !Number.isSafeInteger(cellCount) || cellCount > 10_000_000)
        throw new Error(`${name}: invalid GEO grid ${grid.join("x")}.`);
    const worldMin = r.vec(), worldMax = r.vec(), cellSize = r.vec();
    const cells = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
        const min = r.vec(), max = r.vec();
        const vertexCount = r.i32(), triangleCount = r.i32();
        if (vertexCount < 0 || triangleCount < 0 || vertexCount > 10_000_000 || triangleCount > 10_000_000)
            throw new Error(`${name}: invalid cell ${cellIndex} counts.`);
        const vertices = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertices.length; i++)
            vertices[i] = r.f32();
        const indices = new Uint32Array(triangleCount * 3), normals = new Float32Array(triangleCount * 3), planeDistances = new Float32Array(triangleCount), dominantAxes = new Uint32Array(triangleCount);
        for (let i = 0; i < triangleCount; i++) {
            indices.set([r.u32(), r.u32(), r.u32()], i * 3);
            normals.set(r.vec(), i * 3);
            planeDistances[i] = r.f32();
            dominantAxes[i] = r.u32();
        }
        const groundTypes = r.bytesCopy(triangleCount);
        const voxels = triangleCount > 0 ? r.bytesCopy(64) : new Uint8Array(0);
        cells.push({ min, max, vertices, triangles: { indices, normals, planeDistances, dominantAxes, groundTypes }, voxels });
    }
    if (r.offset !== bytes.length)
        throw new Error(`${name}: ${bytes.length - r.offset} trailing GEO bytes.`);
    return { version, grid, worldMin, worldMax, cellSize, cells };
}
