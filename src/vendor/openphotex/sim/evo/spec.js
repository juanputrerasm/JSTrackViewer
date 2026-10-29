import { DAMPER_FACTOR, ENGINE, GEAR_RATIOS, TIRE_GRIP_K, TRUCK } from "../mtm2/constants.js";
import { clampWheelbase, defaultWheelAnchors, suspensionRates, transferRatio } from "../mtm2/truck/params.js";
import { DEFAULT_TRANSFER_SETTING } from "../mtm2/constants.js";
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const list = (v) => (Array.isArray(v) ? v.filter((x) => Number.isFinite(x)) : []);
const triplet = (v, d) => {
    const a = list(v);
    return a.length >= 3 ? [a[0], a[1], a[2]] : [d[0], d[1], d[2]];
};
const WHEEL_KEYS = ["faxle.rtire", "faxle.ltire", "raxle.rtire", "raxle.ltire"];
/** The figures of an Evo 1 or Evo 2 .TRK (`parseEvoTrk`). */
export function evoSpecFromTrk(trk) {
    const s = trk.specs;
    const anchors = WHEEL_KEYS.map((k) => {
        const a = trk.wheelAnchors[`${k}.static_bpos`];
        return a ? [a.x, a.y, a.z] : null;
    });
    const springRate = [num(s["faxle.spring_rate"], 1000), num(s["raxle.spring_rate"], 1000)];
    return {
        game: trk.game,
        dryWeightLb: num(s.dry_weight, 3000),
        fuelWeightLb: num(s["fuel.weight"], 0),
        axleWeightLb: [500, 500],
        inertia: triplet(s["ixx,iyy,izz"], [2500, 2500, 3750]),
        refArea: triplet(s.refArea, [125, 150, 75]),
        cy: num(s.CY, 5), cl: num(s.CL, 0.1), cd: num(s.CD, 0.4),
        ...(() => { const [clp, cmq, cnr] = triplet(s["clp,cmq,cnr"], [-0.2, -0.2, -0.4]); return { clp, cmq, cnr }; })(),
        cgModifier: triplet(s.cgModifier, [0, 0, 0]),
        cgOffset: null,
        maxBrakePct: num(s.max_brake_force_pct, 1),
        brakeBalance: 0.5,
        driveType: num(s.drive_type, 1),
        torquePct: [num(s["faxle.torque_pct"], 0.5), num(s["raxle.torque_pct"], 0.5)],
        axleBias: [num(s["faxle.axleBias"], 1), num(s["raxle.axleBias"], 1)],
        slipDiffType: [num(s["faxle.slipDiffType"], 0), num(s["raxle.slipDiffType"], 0)],
        springRate,
        damping: [Math.sqrt(springRate[0]) * DAMPER_FACTOR, Math.sqrt(springRate[1]) * DAMPER_FACTOR],
        maxCompr: [num(s["faxle.maxcompr"], 2), num(s["raxle.maxcompr"], 2)],
        maxAngle: [num(s["faxle.maxangle"], 0.5), num(s["raxle.maxangle"], 0.5)],
        springArmFt: Math.abs(num(s["faxle.rtire.spring_arm"], 5)) || 5,
        tireCF: WHEEL_KEYS.map((k) => num(s[`${k}.CF`], 1.75)),
        gearRatios: list(s["xm.gear_ratio[]"]),
        gearInertia: list(s["xm.gearInertia[]"]),
        maxGear: num(s["xm.maxGear"], list(s["xm.gear_ratio[]"]).length),
        finalDrive: num(s["xm.final_drive"], 3.73),
        axleRatio: num(s["xm.axle_ratio"], 1) || 1,
        xfrLowRatio: num(s["xm.xfrLowRatio"], 1) || 1,
        redline: num(s["eng.redline"], 5600),
        upshiftRpm: num(s["eng.upshift_rpm"], 4500),
        dnshiftRpm: num(s["eng.dnshift_rpm"], 2000),
        torqueTable: list(s["eng.torqueTable[]"]),
        rearSteer: false,
        wheelAnchors: anchors.every(Boolean) ? anchors : defaultWheelAnchors(),
        scrapePoints: trk.scrapePoints.map((p) => [p.x, p.y, p.z]),
    };
}
const unit = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
/** The springs `CVehicle::setSprings` (`0x5ecba0`) gives for setting `s`: per axle rate and damping (EVO2_PHYSICS.md 2). */
export function evoSprings(spec, s, defaultCgZ) {
    const sag = Math.min(spec.maxCompr[0], spec.maxCompr[1]) * (0.5 - 0.4 * (0.5 - s));
    const sprung = spec.dryWeightLb + spec.axleWeightLb[0] + spec.axleWeightLb[1];
    const zFront = spec.wheelAnchors[0][2], zRear = spec.wheelAnchors[2][2];
    const zCg = spec.cgOffset ? spec.cgOffset[2] : defaultCgZ + spec.cgModifier[2];
    const base = zFront - zRear;
    if (!(sag > 0) || !(Math.abs(base) > 1e-6))
        return { springRate: [...spec.springRate], damping: [...spec.damping] };
    const front = (sprung * (zCg - zRear)) / base * 0.5 / sag;
    const rear = (sprung * (zFront - zCg)) / base * 0.5 / sag;
    const springRate = [Math.max(1, front), Math.max(1, rear)];
    return { springRate, damping: [DAMPER_FACTOR * Math.sqrt(springRate[0]), DAMPER_FACTOR * Math.sqrt(springRate[1])] };
}
/** A vehicle's figures with the garage's settings applied, as the game's setters change them (EVO2_PHYSICS.md 2.2). */
export function applyEvoGarage(spec, garage, defaultCgZ) {
    if (!garage)
        return spec;
    const out = { ...spec, tireCF: [...spec.tireCF], torquePct: [...spec.torquePct] };
    const springs = unit(garage.springs);
    if (springs !== null)
        Object.assign(out, evoSprings(spec, springs, defaultCgZ));
    const axle = unit(garage.axleRatio);
    if (axle !== null)
        out.finalDrive = spec.finalDrive * ((1 - axle) * 1.5 + 0.25);
    const brakes = unit(garage.brakeBalance);
    if (brakes !== null)
        out.brakeBalance = brakes;
    const split = unit(garage.torqueSplit);
    if (split !== null)
        out.torquePct = [1 - split, split];
    const handling = unit(garage.handling);
    if (handling !== null) {
        out.tireCF[0] *= 1 + 0.75 * handling;
        out.tireCF[1] *= 1 + 0.75 * handling;
    }
    return out;
}
/** Lift kits by code, inches (§2.1). */
const LIFT_IN = {
    DropKit: -4, "2LiftKit": 2, "4LiftKit": 4, "6LiftKit": 6, "8LiftKit": 8, "10LiftKit": 10, "12LiftKit": 12, "14LiftKit": 14,
};
/** Race springs by code: the suspension travel, inches. */
const SPRINGS_IN = { "12RaceSprings": 12, "18RaceSprings": 18, "24RaceSprings": 24, "30RaceSprings": 30, "36RaceSprings": 36 };
/** Tires by code: the tire models' base name (`<base>16l.smf`...). */
const TIRE_MODELS = {
    "31Tire": "31x10_", "33Tire": "33x12_", "35Tire": "35x12_", "37Tire": "37x12_", "38Tire": "38x15_", "44Tire": "44x15_",
    "31RaceTire": "31x10_", "33RaceTire": "33x12_", "35RaceTire": "35x12_", "37RaceTire": "37x12_",
    "SS31Tire": "31x10_", "SS33Tire": "33x12_", "SS35Tire": "35x12_", "SS37Tire": "37x12_", "SS38Tire": "38x15_",
};
/**
 * A vehicle's figures with parts fitted, as `0x5eaa40` fits them (§2.1): `codes` are the part codes (a
 * .TRK's `stockParts`), `parts` the parts list (`parseEvoParts`). Codes not in the list are left out.
 */
export function applyEvoParts(spec, codes, parts) {
    const byCode = new Map(parts.map((p) => [p.code.toLowerCase(), p]));
    const fitted = codes.map((c) => byCode.get(c.trim().toLowerCase())).filter((p) => !!p);
    if (!fitted.length)
        return { spec, liftFt: 0, tireModelBase: null };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let aero = 0, brake = 0, torque = 0, share = 0, pounds = 0;
    for (const p of fitted) {
        aero += p.aeroMod;
        brake += p.brakeMod;
        torque += p.torqueMod;
        if (p.weightMod < -1 || p.weightMod > 1)
            pounds += p.weightMod;
        else
            share += p.weightMod;
    }
    aero = clamp(aero, -1, 1);
    brake = clamp(brake, -1, 1);
    torque = clamp(torque, -1, 2);
    share = clamp(share, -1, 1);
    let liftIn = 0, springsIn = 0, tireModelBase = null;
    // Later parts of a kind replace earlier ones, as the game's chain of tests does.
    for (const p of fitted) {
        if (LIFT_IN[p.code] !== undefined)
            liftIn = LIFT_IN[p.code];
        if (SPRINGS_IN[p.code] !== undefined)
            springsIn = SPRINGS_IN[p.code];
        if (TIRE_MODELS[p.code] !== undefined)
            tireModelBase = TIRE_MODELS[p.code];
    }
    const liftFt = liftIn / 12;
    const out = {
        ...spec,
        cd: spec.cd * (1 + aero),
        maxBrakePct: spec.maxBrakePct * (1 + brake),
        torqueTable: spec.torqueTable.map((t) => t * (1 + torque)),
        dryWeightLb: spec.dryWeightLb + (spec.dryWeightLb + spec.axleWeightLb[0] + spec.axleWeightLb[1]) * share + pounds,
        maxCompr: springsIn > 0 ? [springsIn / 12, springsIn / 12] : spec.maxCompr,
        wheelAnchors: liftFt ? spec.wheelAnchors.map(([x, y, z]) => [x, y - liftFt, z]) : spec.wheelAnchors,
    };
    return { spec: out, liftFt, tireModelBase };
}
/** MTM2's monster truck, as the Evo model's figures (the port's rule for a non-Evo vehicle). */
export function evoSpecFromMtm2(input = {}) {
    const anchors = clampWheelbase(input.wheelAnchors?.length === 4 ? input.wheelAnchors : defaultWheelAnchors());
    const weight = TRUCK.bodyWeightLb + 2 * TRUCK.axleWeightLb;
    const { spring, damper } = suspensionRates(anchors[0][2], anchors[2][2], weight, input.suspension ?? 0);
    // MTM2's curve, sampled every 500 rpm to its limit (MONSTER_EXE_ANALYSIS.md 8.4).
    const torqueTable = [];
    for (let rpm = 0; rpm <= ENGINE.maxRpm; rpm += 500) {
        torqueTable.push(ENGINE.torqueScale * ((ENGINE.a * rpm + ENGINE.b) * rpm + ENGINE.c));
    }
    const k = input.gripK ?? TIRE_GRIP_K;
    return {
        game: 0,
        dryWeightLb: TRUCK.bodyWeightLb,
        fuelWeightLb: 0,
        axleWeightLb: [TRUCK.axleWeightLb, TRUCK.axleWeightLb],
        inertia: [TRUCK.inertia[0], TRUCK.inertia[1], TRUCK.inertia[2]],
        refArea: [TRUCK.aeroArea[0], TRUCK.aeroArea[1], TRUCK.aeroArea[2]],
        cy: TRUCK.aeroCd[0], cl: TRUCK.aeroCd[1], cd: TRUCK.aeroCd[2],
        // MTM2's aero damping (§14.7) is Evo's with these derivatives.
        clp: -0.2, cmq: -0.2, cnr: -0.4,
        cgModifier: [0, 0, 0],
        cgOffset: [TRUCK.cgOffset[0], TRUCK.cgOffset[1], TRUCK.cgOffset[2]],
        maxBrakePct: 1,
        brakeBalance: 0.5,
        driveType: 1,
        torquePct: [TRUCK.torqueSplit.front, TRUCK.torqueSplit.rear],
        axleBias: [1, 1],
        // MTM2 halves each axle's share between its tires: an open differential.
        slipDiffType: [0, 0],
        springRate: spring,
        damping: damper,
        maxCompr: [TRUCK.bumpTravelFt, TRUCK.bumpTravelFt],
        maxAngle: [TRUCK.articulationLimit, TRUCK.articulationLimit],
        springArmFt: 5,
        tireCF: [k, k, k, k],
        gearRatios: GEAR_RATIOS.slice(1),
        gearInertia: GEAR_RATIOS.slice(1).map(() => 0),
        maxGear: GEAR_RATIOS.length - 1,
        finalDrive: transferRatio(input.transferSetting ?? DEFAULT_TRANSFER_SETTING, input.difficulty ?? 1),
        axleRatio: 1,
        xfrLowRatio: 1,
        redline: ENGINE.maxRpm,
        upshiftRpm: ENGINE.upshiftRpm,
        dnshiftRpm: ENGINE.downshiftRpm,
        torqueTable,
        rearSteer: true,
        wheelAnchors: anchors,
        scrapePoints: (input.scrapePoints ?? []).map((p) => [p[0], p[1], p[2]]),
    };
}
