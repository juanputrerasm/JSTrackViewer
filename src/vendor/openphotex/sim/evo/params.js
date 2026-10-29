/*
  A vehicle's parameters under the 4x4 Evolution model: MTM2's params shape (so collisions, the
  post-step, recovery and the autopilot work unchanged) with the Evo figures beside it.
*/
import { G } from "../mtm2/constants.js";
export function createEvoParams(spec, rules, geometry = {}, setup = {}) {
    const hubs = spec.wheelAnchors.map((a) => [a[0], a[1], a[2]]);
    const axleWeight = (spec.axleWeightLb[0] + spec.axleWeightLb[1]) / 2;
    const body = spec.dryWeightLb + spec.fuelWeightLb;
    const weightLb = body + 2 * axleWeight;
    const cg = spec.cgOffset
        ? [spec.cgOffset[0], spec.cgOffset[1], spec.cgOffset[2]]
        : [spec.cgModifier[0], 0.5 + spec.cgModifier[1], rules.defaultCgZ + spec.cgModifier[2]];
    const frontShare = hubs[0][2] !== hubs[2][2] ? (cg[2] - hubs[2][2]) / (hubs[0][2] - hubs[2][2]) : 0.5;
    return {
        bodyWeightLb: body,
        axleWeightLb: axleWeight,
        weightLb,
        massSlug: weightLb / G,
        inertia: [spec.inertia[0], spec.inertia[1], spec.inertia[2]],
        cgOffset: cg,
        tireRadiusFt: geometry.tireRadiusFt && geometry.tireRadiusFt > 0 ? geometry.tireRadiusFt : 1.5,
        tireWidthFt: geometry.tireWidthFt && geometry.tireWidthFt > 0 ? geometry.tireWidthFt : 1,
        hubs,
        drawHubs: hubs.map((h) => [h[0], h[1], h[2]]),
        frontAxleZ: hubs[0][2],
        rearAxleZ: hubs[2][2],
        scrapePoints: spec.scrapePoints.map((p) => [p[0], p[1], p[2]]),
        // The front axle's static sag under its share of the weight (informational).
        sagFt: spec.springRate[0] > 0 ? (weightLb * frontShare * 0.5) / spec.springRate[0] : 0,
        spring: [spec.springRate[0], spec.springRate[1]],
        damper: [spec.damping[0], spec.damping[1]],
        transferRatio: 1,
        tireCut: Math.min(2, setup.tread ?? 1),
        gripK: spec.tireCF[0],
        torqueGain: 1,
        cpu: setup.cpu ?? false,
        autoShift: setup.autoShift ?? true,
        difficulty: setup.difficulty ?? 1,
        bumpTravelFt: [spec.maxCompr[0], spec.maxCompr[1]],
        articulationLimit: [spec.maxAngle[0], spec.maxAngle[1]],
        springArmFt: spec.springArmFt,
        aeroArea: [spec.refArea[0], spec.refArea[1], spec.refArea[2]],
        evo: {
            spec,
            rules,
            tread: Math.max(0, Math.min(3, Math.trunc(setup.tread ?? 1))),
            torqueModifier: setup.torqueModifier ?? 1,
            tireCFModifier: setup.tireCFModifier ?? 1,
            brakeBalance: setup.brakeBalance ?? spec.brakeBalance,
        },
    };
}
