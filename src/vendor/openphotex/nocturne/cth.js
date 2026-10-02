import { LineReader, csv, nocturneDataLines, unquote } from "./text.js";
export function parseCth(bytes, name = "CTH") {
    const r = new LineReader(nocturneDataLines(bytes), name);
    // CTH labels are bare words rather than // comments.
    const expect = (label) => { const got = r.next(label); if (got.toLowerCase() !== label.toLowerCase())
        throw new Error(`${name}: expected '${label}', got '${got}'.`); };
    expect("version");
    const version = r.count("version");
    if (version < 1 || version > 3)
        throw new Error(`${name}: unsupported CTH version ${version}.`);
    expect("model");
    const model = r.next("model");
    r.next("physical-property labels");
    const physical = r.nums("physical properties");
    if (physical.length !== 6 && physical.length !== 8)
        throw new Error(`${name}: expected six or eight physical properties.`);
    const [weight, gravity, dampen, spring, bodyFriction, floorFriction] = physical;
    const windArea = physical[6] ?? 0, momentOfInertia = physical[7] ?? 0;
    expect("transparency");
    const transparency = Number(r.next("transparency"));
    let doubleSided = false;
    if (version >= 2) {
        expect("doubleSided");
        doubleSided = r.count("double-sided flag") !== 0;
    }
    expect("lockedVertexCount");
    const lockedVertices = new Int32Array(r.count("locked vertex count"));
    expect("lockedVertexList");
    for (let i = 0; i < lockedVertices.length; i++)
        lockedVertices[i] = r.count("locked vertex");
    expect("collideBoneCount");
    const collisionBones = Array.from({ length: r.count("collision bone count") }, () => { const v = csv(r.next("collision bone")); return { name: unquote(v[0]), values: v.slice(1).map(Number) }; });
    r.done();
    return { version, model, weight, gravity, dampen, spring, bodyFriction, floorFriction, windArea, momentOfInertia, transparency, doubleSided, lockedVertices, collisionBones };
}
