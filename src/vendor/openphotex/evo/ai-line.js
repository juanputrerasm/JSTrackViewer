/*
  4x4 Evolution's AI lines, and what they say about the course.

  A track can carry recorded laps for the computer drivers, AI\CLASSc\AI_cnTRACK.TXT: one
  per driver line n (1 to 3) for each truck class c, often the same three laps copied into
  all three classes. Each is a text header followed by the lap as a list of samples:

    File Version:     12
    Driver Name:      Antigoon
    Lap Time:         01m48s07ms
    Class:            Class_3
    ...
    Checkpoint Count: 9
    Point Count:      1411
    3197.96, 167.77, 4351.55     position, x / height / z like the .SIT
    139.59                       speed
    8                            the checkpoint the driver is heading for

  These are the lines the trucks drive, so they are the track's other courses, and they
  settle something the .SIT course cannot say on its own: which of its runs make up a lap.
  TERRAMAR's course lists its 23 lap runs and then two more on the parallel road beside the
  start, which no driver goes near; joined in file order they drew a detour back and forth
  across the start. See lapRuns.

  Ported from JSTrackViewer's src/worker/evo/evo-ai-lines.js, the only implementation.
*/
const POSITION = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/;
/** One AI line file: its header fields and the recorded positions, in .SIT axes. */
export function parseEvoAiLine(bytes) {
    const lines = new TextDecoder("latin1").decode(bytes).split(/\r?\n/).map((line) => line.trim());
    const header = {};
    const points = [];
    for (const line of lines) {
        const field = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
        if (field && points.length === 0) {
            header[field[1].trim()] = field[2].trim();
            continue;
        }
        const m = POSITION.exec(line);
        if (m)
            points.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    }
    return {
        driver: header["Driver Name"] ?? "",
        lapTime: header["Lap Time"] ?? "",
        points,
    };
}
/** AI\CLASSc\AI_cnTRACK.TXT, with its class and line number. */
export function matchEvoAiLineName(name, trackStem) {
    const m = /(?:^|[\\/])AI[\\/]CLASS(\d)[\\/]AI_(\d)(\d)(.+)\.TXT$/i.exec(name);
    if (!m || m[4].toUpperCase() !== trackStem.toUpperCase())
        return null;
    return { truckClass: Number(m[1]), line: Number(m[3]) };
}
/** A run's distance from the recorded lines is its median over this many samples. */
const RUN_SAMPLES = 5;
/**
 * Median distance, in world units, beyond which a run is not being driven. Lap runs on TERRAMAR sit
 * a median of 40 or less from a recorded line (corners are cut, roads are wide); the two
 * stray runs at the end of its list are 96 and 193 away.
 */
const OFF_LINE_DISTANCE = 80;
/**
 * The course runs that make up a lap, judged against the recorded lines.
 *
 * Only runs at the end of the list are dropped, and only while each is off every line: the
 * lap is what the file lists first, and a run in the middle of it that happens to be
 * driven wide is still part of the order the course gives. With no recorded lines nothing
 * is dropped; the course is shown as stored.
 *
 * `runs` are .SIT course runs (x, height, z); `lines` are parsed AI lines.
 */
export function lapRuns(runs, lines) {
    const samples = lines.flatMap((line) => line.points);
    if (!samples.length || runs.length < 3)
        return runs;
    const nearest = (x, z) => {
        let best = Infinity;
        for (const [px, , pz] of samples) {
            const d = (px - x) * (px - x) + (pz - z) * (pz - z);
            if (d < best)
                best = d;
        }
        return Math.sqrt(best);
    };
    const offLine = (run) => {
        const d = [];
        for (let k = 0; k < RUN_SAMPLES; k++) {
            const t = k / (RUN_SAMPLES - 1);
            d.push(nearest(run.start[0] + (run.end[0] - run.start[0]) * t, run.start[2] + (run.end[2] - run.start[2]) * t));
        }
        d.sort((a, b) => a - b);
        return d[(RUN_SAMPLES - 1) / 2] > OFF_LINE_DISTANCE;
    };
    let keep = runs.length;
    while (keep > 2 && offLine(runs[keep - 1]))
        keep--;
    return runs.slice(0, keep);
}
