/** The order a CAR lists its four wheel models in. */
export const CPR_WHEEL_KEYS_IN_FILE_ORDER = [
    "faxle.ltire.static_bpos",
    "faxle.rtire.static_bpos",
    "raxle.ltire.static_bpos",
    "raxle.rtire.static_bpos",
];
/** True when these manifest lines are a CPR car rather than an MTM1 truck. */
export function isCprCarLines(lines) {
    return (lines[0] === "truckName" || lines[0] === "gtruckName")
        && lines.some((line) => line === "Helmet name" || line === "paceCarFlag");
}
/**
 * Parse a CPR CAR already split by `truckManifestLines`.
 *
 * @throws Error when the first line is not "truckName" or "gtruckName".
 */
export function parseCprCarLines(lines) {
    let index = 0;
    const headerLabel = lines[index++] ?? "";
    if (headerLabel !== "truckName" && headerLabel !== "gtruckName") {
        throw new Error(`Unsupported CPR CAR header: ${headerLabel || "<empty>"}`);
    }
    const car = {
        headerLabel,
        truckName: lines[index++] ?? "",
        truckModelName: null,
        tireModelNames: [],
        wheelModelNames: {},
        helmetModelName: null,
        helmetPosition: null,
        paceCarFlag: null,
        paceCarTireRadius: null,
        wheelAnchors: {},
        scrapePoints: [],
        instrumentCluster: null,
        waveFiles: [],
        unknownFields: {},
    };
    const partialAnchors = new Map();
    while (index < lines.length) {
        const label = lines[index++];
        if (label === "truckModelName") {
            car.truckModelName = lines[index++] ?? "";
            continue;
        }
        if (label === "tireModelName") {
            car.tireModelNames = lines.slice(index, index + 4);
            index += car.tireModelNames.length;
            car.tireModelNames.forEach((name, i) => (car.wheelModelNames[CPR_WHEEL_KEYS_IN_FILE_ORDER[i]] = name));
            continue;
        }
        if (label.startsWith("Scrape point ")) {
            car.scrapePoints.push(vec3(lines[index++]));
            continue;
        }
        if (label === "Instrument Cluster") {
            car.instrumentCluster = lines[index++] ?? "";
            continue;
        }
        if (label === "Wave File") {
            while (index < lines.length && !isCarLabel(lines[index]))
                car.waveFiles.push(lines[index++]);
            continue;
        }
        if (label === "Helmet name") {
            car.helmetModelName = lines[index++] ?? "";
            continue;
        }
        if (label === "Helmet pos") {
            car.helmetPosition = vec3(lines[index++]);
            continue;
        }
        if (label === "paceCarFlag") {
            car.paceCarFlag = Number.parseInt(lines[index++] ?? "0", 10) || 0;
            continue;
        }
        if (label === "paceCarTireRadius") {
            car.paceCarTireRadius = Number.parseFloat(lines[index++] ?? "0") || 0;
            continue;
        }
        const axisMatch = label.match(/^(.*)\.(x|y|z)$/i);
        if (axisMatch) {
            const key = axisMatch[1];
            const axis = axisMatch[2].toLowerCase();
            const current = partialAnchors.get(key) ?? { x: 0, y: 0, z: 0 };
            current[axis] = Number.parseFloat(lines[index++] ?? "0") || 0;
            partialAnchors.set(key, current);
            continue;
        }
        car.unknownFields[label] = lines[index++] ?? "";
    }
    for (const [key, value] of partialAnchors)
        car.wheelAnchors[key] = value;
    return car;
}
function isCarLabel(line) {
    return line === "truckModelName" || line === "tireModelName" || line === "Instrument Cluster"
        || line === "Wave File" || line === "Helmet name" || line === "Helmet pos" || line === "paceCarFlag"
        || line === "paceCarTireRadius" || line.startsWith("Scrape point ") || /^(.*)\.(x|y|z)$/i.test(line);
}
function vec3(value = "") {
    const [x = "0", y = "0", z = "0"] = value.split(",");
    return { x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0, z: Number.parseFloat(z) || 0 };
}
