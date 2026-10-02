import { LineReader, csv, nocturneDataLines, unquote } from "./text.js";
export function parseSkl(bytes, name = "SKL") {
    const r = new LineReader(nocturneDataLines(bytes), name);
    const version = r.count("version");
    if (version < 2 || version > 3)
        throw new Error(`${name}: unsupported text SKL version ${version}.`);
    const [boneCount, frameCount] = r.nums("counts", 2);
    const bones = Array.from({ length: boneCount }, (_, i) => {
        const v = csv(r.next(`bone ${i}`));
        return { name: unquote(v[0]), parent: Number(v[1]) };
    });
    const rotations = new Float32Array(frameCount * boneCount * 4);
    for (let i = 0; i < rotations.length; i += 4)
        rotations.set(r.nums("bone rotation", 4), i);
    const rootOffsets = new Float32Array(frameCount * 3);
    for (let i = 0; i < rootOffsets.length; i += 3)
        rootOffsets.set(r.nums("root offset", 3), i);
    const cancelledMovement = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++)
        cancelledMovement[i] = Number(r.next("cancelled movement"));
    const motionListVersion = r.count("motion-list version");
    const states = Array.from({ length: r.count("state count") }, () => unquote(r.next("state")));
    const motions = [];
    for (let i = 0, count = r.count("motion count"); i < count; i++) {
        const h = csv(r.next(`motion ${i}`));
        const exitForward = r.nums("forward exit", 3);
        const exitForwardCommand = r.nums("forward exit command", 3);
        const exitBackward = r.nums("backward exit", 2);
        const transitions = Array.from({ length: r.count("transition count") }, () => r.nums("transition", 6));
        const signals = Array.from({ length: r.count("signal count") }, () => r.nums("signal", 2));
        let markers = [];
        if (motionListVersion >= 2) {
            const markerFields = r.next("marker count and list").trim().split(/\s+/).map(Number);
            const markerCount = markerFields.shift();
            if (!Number.isSafeInteger(markerCount) || markerCount < 0 || markerFields.length !== markerCount)
                throw new Error(`${name}: invalid marker list.`);
            markers = markerFields;
        }
        motions.push({ name: unquote(h[0]), fps: Number(h[1]), state: Number(h[2]), frameStart: Number(h[3]), frameCount: Number(h[4]), exitForward, exitForwardCommand, exitBackward, transitions, signals, markers });
    }
    const referenceOrigins = new Float32Array(version >= 3 ? boneCount * 3 : 0);
    for (let i = 0; i < referenceOrigins.length; i += 3)
        referenceOrigins.set(r.nums("reference bone origin", 3), i);
    r.done();
    return { version, boneCount, frameCount, bones, rotations, rootOffsets, cancelledMovement, motionListVersion, states, motions, referenceOrigins };
}
