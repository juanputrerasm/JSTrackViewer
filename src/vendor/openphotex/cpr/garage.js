/*
  CART Precision Racing car setups (`.gar`, CART.EXE `Garage.cpp`, writer 0x4ab7f0; OpenMTM2
  docs/CPR_PHYSICS.md 14.1): plain text, each label on its own line and its values comma-separated
  on the next. Four-value rows are one value per corner, FL, FR, RL, RR; two-value rows front, rear.

  Units as the game keeps them: tire pressure psi, stagger and ride height feet, spring and anti-roll
  rates lb/ft, damper settings in clicks, camber, toe and steering lock radians, wing angles
  degrees, Gurney flaps inches, fuel gallons, gear ratios overall (the final drive multiplies them).
*/
const decoder = new TextDecoder("latin1");
/**
 * The stock setup. From the car's constructor (CART.EXE 0x4b2b00, which `CGarage::defaultSettings` 0x4abf20 copies):
 * the gears 19.0, 12.4, 9.3, 7.6, 6.4, 5.5 and a final drive of 1, springs of 14,723 lb/ft front and 20,870 rear, wing
 * type 3 at 12 and 15 degrees, three clicks on every damper, the limited slip differential, 35 gallons. The rest is not
 * traced and is the port's: a road course setup of the shape the game's own sample files have.
 */
const STOCK = {
    tireCompound: [0, 0, 0, 0],
    tirePressure: [26, 26, 22, 22],
    tireStagger: [0, 0],
    brakeProportioning: 0.6,
    springRate: [14723.37, 14723.37, 20870.38, 20870.38],
    dampingFastBump: [3, 3, 3, 3],
    dampingSlowBump: [3, 3, 3, 3],
    dampingFastRebound: [3, 3, 3, 3],
    dampingSlowRebound: [3, 3, 3, 3],
    camber: [-0.0524, -0.0524, -0.0349, -0.0349],
    installationRatio: [0.75, 0.75, 0.75, 0.75],
    thirdSpringRate: [0, 0, 0, 0],
    thirdSpringFreePlay: [0, 0, 0, 0],
    antiRollBar: [4800, 0],
    steeringLock: 0.31416,
    toeIn: [0, 0],
    wingType: [3, 3],
    wingAngle: [12, 15],
    gurneyFlapSize: [0.25, 1],
    staticRideHeight: [0.125, 0.208],
    fuelAmount: 35,
    ballastPosition: 0.5,
    gearRatio: [19, 12.4, 9.3, 7.6, 6.4, 5.5],
    finalDriveRatio: 1,
    differentialType: 1,
    pitStops: [],
    mirrorAngles: [20, -20],
};
export const CPR_DEFAULT_SETUP = Object.freeze(STOCK);
/** A setup to change, copied from `setup` (the stock one by default). */
export function cloneCprSetup(setup = CPR_DEFAULT_SETUP) {
    return JSON.parse(JSON.stringify(setup));
}
/** The file's order of labels (0x4ab7f0). */
const ORDER = [
    "tireCompound", "tirePressure", "tireStagger", "brakeProportioning", "springRate", "dampingFastBump", "dampingSlowBump",
    "dampingFastRebound", "dampingSlowRebound", "camber", "installationRatio", "thirdSpringRate", "thirdSpringFreePlay",
    "antiRollBar", "steeringLock", "toeIn", "wingType", "wingAngle", "gurneyFlapSize", "staticRideHeight", "fuelAmount",
    "ballastPosition", "gearRatio", "finalDriveRatio", "differentialType",
];
/** Rows the game writes as integers. */
const INTEGERS = new Set(["tireCompound", "dampingFastBump", "dampingSlowBump", "dampingFastRebound", "dampingSlowRebound", "wingType", "differentialType"]);
const numbers = (line) => (line ?? "").split(",").map((v) => v.trim()).filter((v) => v !== "").map(Number).filter((v) => Number.isFinite(v));
/** Read a setup; whatever the file lacks keeps the stock value. Null when nothing in it is a setup label. */
export function parseCprGarage(input) {
    const text = typeof input === "string" ? input : decoder.decode(input);
    const lines = text.split(/\r?\n|\r/).map((l) => l.trim());
    const setup = cloneCprSetup();
    let found = 0;
    for (let i = 0; i < lines.length; i++) {
        const label = lines[i];
        if (ORDER.includes(label)) {
            const key = label;
            const values = numbers(lines[++i]);
            const current = setup[key];
            if (Array.isArray(current)) {
                const row = current;
                for (let k = 0; k < row.length && k < values.length; k++)
                    row[k] = values[k];
            }
            else if (values.length) {
                setup[key] = values[0];
            }
            found++;
        }
        else if (label === "pitLapMin,pitLapMax,pitFuelAmount,pitStopType") {
            const [lapMin = 0, lapMax = 0, fuel = 0, type = 0] = numbers(lines[++i]);
            setup.pitStops.push({ lapMin, lapMax, fuel, type });
        }
        else if (label === "leftMirrorAngle,rightMirrorAngle") {
            const [left = 20, right = -20] = numbers(lines[++i]);
            setup.mirrorAngles = [left, right];
        }
    }
    return found ? setup : null;
}
/** The file's text for a setup, CRLF lines as the game writes them. */
export function writeCprGarage(setup) {
    const out = [];
    const f = (key, v) => (INTEGERS.has(key) ? String(Math.round(v)) : v.toFixed(6));
    for (const key of ORDER) {
        const value = setup[key];
        out.push(key, Array.isArray(value) ? value.map((v) => f(key, v)).join(",") : f(key, value));
    }
    out.push("pitStopCount", String(setup.pitStops.length));
    for (const stop of setup.pitStops) {
        out.push("pitLapMin,pitLapMax,pitFuelAmount,pitStopType", `${Math.round(stop.lapMin)},${Math.round(stop.lapMax)},${stop.fuel.toFixed(6)},${Math.round(stop.type)}`);
    }
    out.push("leftMirrorAngle,rightMirrorAngle", setup.mirrorAngles.map((v) => v.toFixed(6)).join(","));
    return `${out.join("\r\n")}\r\n`;
}
