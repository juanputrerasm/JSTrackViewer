/*
  MTM2 instant replays and demos (`.rpl`, `core/Demo.c`, reader 0x565050, writer 0x5659f0): the
  engine's record of a race, as plain text with CRLF line endings. A header, the original place
  of every object in the track's SIT, then records at 4 Hz (0.25 s), each a `type,time` line
  and label and value line pairs. Time is in 1/65536 s, distances in feet, angles in radians.

    demoLevel / <track>.sit / weather / <n> / vehicleCount / <n>
    <truck>.TRK / <driver>            one pair per vehicle
    detailLevel / <n> / demoRecordPtr / <n> / demoRecordCount / <n>
    Original object locations / <count> / x,y,z,theta,phi,psi ...
    type,time / <type>,<time>         type 0 a vehicle (9 fields), 1 an object (5 fields), 2 a top-crush
                                      object (an object's fields)
      ipos, bvel (body axes), theta,phi,psi, p,q,r, number,
      then for vehicles: fsteering_angle,rsteering_angle / four tire angles (FR, FL, RR, RL) /
      eng_throttle,faxle_brake_pct,raxle_brake_pct,ap_cnumber / damageCode,gear

  The game keeps 2240 records in a ring and writes the ring from the oldest record; `demoRecordPtr` is
  where the ring's next write would go. The writer here keeps the records in order and writes the
  count for both. Format notes: JSTrackViewer docs/MTM2_REPLAY_FORMAT.md.

  Both MTM2 2.00.42 (0x565050) and Community Patch 3 read exactly `demoRecordCount` records and close
  the file, so lines after them are never seen. OpenMTM2 puts its in-between samples there, in an
  extension block that the games skip:

    OpenMTM2 samples / 1 / <count>
    time,number,x,y,z,theta,phi,psi,fsteering,rsteering,frtire,fltire,rrtire,rltire,throttle,speed   one line each

  A sample is a vehicle's pose between two records (the recorder takes them at 16 Hz where the game
  takes 4 Hz); the records stay as the games write them.

  A second block holds how far each top-crush car is crushed, which no record carries (the game's
  kind 2 record has the car's place and angles only, so the games replay every car as crushed as it
  is when the replay plays):

    OpenMTM2 crush / 1 / <count>
    time,car,share                    one line each time a car's share changes: the SIT's top-crush car
                                      number (0 the first) and the share of its crush, 0 intact to 1 flat
*/
const decoder = new TextDecoder("latin1");
/** The most records the game's ring holds. */
export const REPLAY_RING_RECORDS = 2240;
/** The record interval, in the file's time unit (1/65536 s): 0.25 s. */
export const REPLAY_FRAME_TICKS = 0x4000;
export const REPLAY_TICKS_PER_SECOND = 65536;
/** The heading of the extension block after the counted records (see the top of this file), and its version. */
export const REPLAY_SAMPLES_HEADING = "OpenMTM2 samples";
export const REPLAY_SAMPLES_VERSION = 1;
/** The heading of the crush block after the counted records, and its version. */
export const REPLAY_CRUSH_HEADING = "OpenMTM2 crush";
export const REPLAY_CRUSH_VERSION = 1;
const numbers = (line) => (line ?? "").split(",").map((v) => v.trim()).filter((v) => v !== "").map(Number);
const triple = (line) => {
    const n = numbers(line);
    return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
};
/** Read a replay; null when it is not one (no `demoLevel` header). */
export function parseMtmReplay(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    const lines = text.split(/\r?\n|\r/).map((l) => l.trim());
    if (lines[0] !== "demoLevel")
        return null;
    let i = 1;
    const level = lines[i++] ?? "";
    i++; // "weather"
    const weather = parseInt(lines[i++] ?? "0", 10) || 0;
    i++; // "vehicleCount"
    const vehicleCount = parseInt(lines[i++] ?? "0", 10) || 0;
    const vehicles = [];
    for (let v = 0; v < vehicleCount; v++)
        vehicles.push({ truck: lines[i++] ?? "", driver: lines[i++] ?? "" });
    i++; // "detailLevel"
    const detailLevel = parseInt(lines[i++] ?? "0", 10) || 0;
    i += 2; // "demoRecordPtr", its value
    i++; // "demoRecordCount"
    // As the games do, exactly this many records are read; a file without a usable count is read to its end.
    const counted = parseInt(lines[i++] ?? "", 10);
    const recordLimit = Number.isFinite(counted) && counted >= 0 ? counted : Infinity;
    i++; // "Original object locations"
    const objectCount = parseInt(lines[i++] ?? "0", 10) || 0;
    const objects = [];
    for (let o = 0; o < objectCount; o++) {
        const n = numbers(lines[i++]);
        objects.push([n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0]);
    }
    const records = [];
    while (i < lines.length && records.length < recordLimit) {
        if (lines[i] === REPLAY_SAMPLES_HEADING || lines[i] === REPLAY_CRUSH_HEADING)
            break;
        if (lines[i] !== "type,time") {
            i++;
            continue;
        }
        const [type, time] = numbers(lines[i + 1]);
        i += 2;
        // A top-crush object (2) is kept as one: read as a vehicle it would add a truck that was never in the race.
        const record = { type: type === 1 || type === 2 ? type : 0, time: time ?? 0 };
        // Fields run until the next record, so a record's length is never assumed.
        while (i < lines.length && lines[i] !== "type,time" && lines[i] !== REPLAY_SAMPLES_HEADING && lines[i] !== REPLAY_CRUSH_HEADING) {
            const label = lines[i], value = lines[i + 1];
            i += 2;
            switch (label) {
                case "ipos":
                    record.ipos = triple(value);
                    break;
                case "bvel":
                    record.bvel = triple(value);
                    break;
                case "theta,phi,psi":
                    record.angles = triple(value);
                    break;
                case "p,q,r":
                    record.rates = triple(value);
                    break;
                case "number":
                    record.number = numbers(value)[0] ?? 0;
                    break;
                case "fsteering_angle,rsteering_angle": {
                    const n = numbers(value);
                    record.steering = [n[0] ?? 0, n[1] ?? 0];
                    break;
                }
                case "frtire_theta,fltire_theta,rrtire_theta,rltire_theta": {
                    const n = numbers(value);
                    record.tires = [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0];
                    break;
                }
                case "eng_throttle,faxle_brake_pct,raxle_brake_pct,ap_cnumber": {
                    const n = numbers(value);
                    record.throttle = n[0] ?? 0;
                    record.brakeFront = n[1] ?? 0;
                    record.brakeRear = n[2] ?? 0;
                    record.course = n[3] ?? 0;
                    break;
                }
                case "damageCode,gear": {
                    const n = numbers(value);
                    record.damageCode = n[0] ?? 0;
                    record.gear = n[1] ?? 0;
                    break;
                }
                default: break;
            }
        }
        record.ipos ??= [0, 0, 0];
        record.bvel ??= [0, 0, 0];
        record.angles ??= [0, 0, 0];
        record.rates ??= [0, 0, 0];
        record.number ??= 0;
        records.push(record);
    }
    // The extension blocks, wherever they start after the records, in any order.
    const samples = [];
    const crush = [];
    while (i < lines.length) {
        const heading = lines[i];
        if (heading !== REPLAY_SAMPLES_HEADING && heading !== REPLAY_CRUSH_HEADING) {
            i++;
            continue;
        }
        const version = parseInt(lines[i + 1] ?? "", 10);
        const count = parseInt(lines[i + 2] ?? "", 10) || 0;
        i += 3;
        if (heading === REPLAY_SAMPLES_HEADING && version === REPLAY_SAMPLES_VERSION) {
            for (let n = 0; n < count && i < lines.length; n++, i++) {
                const v = numbers(lines[i]);
                if (v.length < 16)
                    continue;
                samples.push({
                    time: v[0], number: v[1], ipos: [v[2], v[3], v[4]], angles: [v[5], v[6], v[7]], steering: [v[8], v[9]],
                    tires: [v[10], v[11], v[12], v[13]], throttle: v[14], speed: v[15],
                });
            }
        }
        else if (heading === REPLAY_CRUSH_HEADING && version === REPLAY_CRUSH_VERSION) {
            for (let n = 0; n < count && i < lines.length; n++, i++) {
                const v = numbers(lines[i]);
                if (v.length < 3 || !v.every(Number.isFinite))
                    continue;
                crush.push({ time: v[0], car: v[1], share: Math.max(0, Math.min(1, v[2])) });
            }
        }
    }
    return { level, weather, detailLevel, vehicles, objects, records, ...(samples.length ? { samples } : {}), ...(crush.length ? { crush } : {}) };
}
const f = (n) => (Number.isFinite(n) ? n : 0).toFixed(6);
const row = (...n) => n.map(f).join(",");
/** The file's text for a replay, CRLF lines as the game writes. */
export function writeMtmReplay(replay) {
    const out = [
        "demoLevel", replay.level, "weather", String(replay.weather), "vehicleCount", String(replay.vehicles.length),
    ];
    for (const v of replay.vehicles)
        out.push(v.truck, v.driver);
    out.push("detailLevel", String(replay.detailLevel), "demoRecordPtr", String(replay.records.length), "demoRecordCount", String(replay.records.length));
    out.push("Original object locations", String(replay.objects.length));
    for (const o of replay.objects)
        out.push(row(...o));
    for (const r of replay.records) {
        out.push("type,time", `${r.type},${Math.round(r.time)}`, "ipos", row(...r.ipos), "bvel", row(...r.bvel), "theta,phi,psi", row(...r.angles), "p,q,r", row(...r.rates), "number", String(r.number));
        if (r.type === 0) {
            out.push("fsteering_angle,rsteering_angle", row(...(r.steering ?? [0, 0])), "frtire_theta,fltire_theta,rrtire_theta,rltire_theta", row(...(r.tires ?? [0, 0, 0, 0])), "eng_throttle,faxle_brake_pct,raxle_brake_pct,ap_cnumber", `${f(r.throttle ?? 0)},${f(r.brakeFront ?? 0)},${f(r.brakeRear ?? 0)},${Math.round(r.course ?? 0)}`, "damageCode,gear", `${Math.round(r.damageCode ?? 0)},${Math.round(r.gear ?? 0)}`);
        }
    }
    const samples = replay.samples ?? [];
    if (samples.length) {
        out.push(REPLAY_SAMPLES_HEADING, String(REPLAY_SAMPLES_VERSION), String(samples.length));
        const g = (n, d) => (Number.isFinite(n) ? n : 0).toFixed(d);
        for (const p of samples) {
            out.push([
                Math.round(p.time), Math.round(p.number), g(p.ipos[0], 3), g(p.ipos[1], 3), g(p.ipos[2], 3),
                g(p.angles[0], 4), g(p.angles[1], 4), g(p.angles[2], 4), g(p.steering[0], 3), g(p.steering[1], 3),
                g(p.tires[0], 3), g(p.tires[1], 3), g(p.tires[2], 3), g(p.tires[3], 3), g(p.throttle, 2), g(p.speed, 2),
            ].join(","));
        }
    }
    const crush = replay.crush ?? [];
    if (crush.length) {
        out.push(REPLAY_CRUSH_HEADING, String(REPLAY_CRUSH_VERSION), String(crush.length));
        for (const c of crush)
            out.push(`${Math.round(c.time)},${Math.round(c.car)},${(Number.isFinite(c.share) ? c.share : 0).toFixed(4)}`);
    }
    return `${out.join("\r\n")}\r\n`;
}
