/*
  A truck's physical parameters (MTM2_PHYSICS.md §3; MONSTER_EXE_ANALYSIS.md §8.4, §8.5).

  Every MTM2 truck has the same mass, inertia, engine and gearing; the TRK supplies only the four
  wheel anchors and the scrape points. The Garage settings pick the springs, the transfer ratio
  and the tire cut; the difficulty, the driver and the track adjust grip and torque.
*/
import { DIFFICULTY, SUSPENSION_SAG_FT, TIRE_GRIP_K, TIRE_GRIP_K_SONIC_PRO, TRANSFER_DIFFICULTY, TRANSFER_TABLE, TRUCK, DAMPER_FACTOR, SPRING_SHARE, DEFAULT_TRANSFER_SETTING, INV_G, } from "../constants.js";
/** Tire order everywhere in the simulation: front right, front left, rear right, rear left. */
export const TIRE_FR = 0, TIRE_FL = 1, TIRE_RR = 2, TIRE_RL = 3;
const f32 = Math.fround;
/** Wheel anchors used when a TRK gives none. */
export function defaultWheelAnchors() {
    const { hubHalfTrackX: x, hubY: y, frontAxleZ: zf, rearAxleZ: zr } = TRUCK;
    return [[x, y, zf], [-x, y, zf], [x, y, zr], [-x, y, zr]];
}
/**
 * The game's wheelbase clamp, per side: when |front z| + |rear z| exceeds 11.6 ft, both move in
 * by half the excess, and neither may cross z = 0. Returns new anchors.
 */
export function clampWheelbase(anchors) {
    const hubs = anchors.map((a) => [a[0], a[1], a[2]]);
    for (const [front, rear] of [[TIRE_FR, TIRE_RR], [TIRE_FL, TIRE_RL]]) {
        let zf = hubs[front][2], zr = hubs[rear][2];
        const excess = f32(Math.abs(zf) + Math.abs(zr) - TRUCK.maxWheelbaseFt);
        if (excess > 0) {
            const half = f32(excess * 0.5);
            zf = f32(zf - half);
            zr = f32(zr + half);
            if (zf < 0)
                zf = 0;
            if (zr > 0)
                zr = 0;
            hubs[front][2] = zf;
            hubs[rear][2] = zr;
        }
    }
    return hubs;
}
/** Springs and dampers for a static sag (Garage suspension). */
export function suspensionRates(frontZ, rearZ, weightLb, suspension) {
    const sag = suspension === 1 ? SUSPENSION_SAG_FT[1] : suspension === 2 ? SUSPENSION_SAG_FT[2] : SUSPENSION_SAG_FT[0];
    const base = frontZ - rearZ;
    const spring = [
        (-(rearZ / base) * weightLb * SPRING_SHARE) / sag,
        ((frontZ / base) * weightLb * SPRING_SHARE) / sag,
    ];
    const damper = [Math.sqrt(spring[0]) * DAMPER_FACTOR, Math.sqrt(spring[1]) * DAMPER_FACTOR];
    return { sag, spring, damper };
}
/** The transfer ratio for a Garage setting and a difficulty. */
export function transferRatio(setting, difficulty) {
    const s = Math.max(0, Math.min(2000, Math.trunc(setting)));
    const ratio = TRANSFER_TABLE[Math.trunc(s / 100)];
    if (difficulty === DIFFICULTY.ROOKIE)
        return ratio * TRANSFER_DIFFICULTY[0];
    if (difficulty === DIFFICULTY.PROFESSIONAL)
        return ratio * TRANSFER_DIFFICULTY[2];
    return ratio;
}
export function createTruckParams(geometry = {}, setup = {}) {
    const difficulty = setup.difficulty ?? DIFFICULTY.INTERMEDIATE;
    const cpu = setup.cpu ?? false;
    const autoShift = setup.autoShift ?? true;
    const anchors = geometry.wheelAnchors?.length === 4
        ? geometry.wheelAnchors.map((a) => [a[0], a[1], a[2]])
        : defaultWheelAnchors();
    const hubs = clampWheelbase(anchors);
    const frontAxleZ = hubs[TIRE_FR][2], rearAxleZ = hubs[TIRE_RR][2];
    const weightLb = TRUCK.axleWeightLb + TRUCK.bodyWeightLb + TRUCK.axleWeightLb;
    const { sag, spring, damper } = suspensionRates(frontAxleZ, rearAxleZ, weightLb, setup.suspension ?? 0);
    const proSonicCpu = cpu && difficulty === DIFFICULTY.PROFESSIONAL && (setup.sonicTrack ?? false);
    return {
        bodyWeightLb: TRUCK.bodyWeightLb,
        axleWeightLb: TRUCK.axleWeightLb,
        weightLb,
        massSlug: weightLb * INV_G,
        inertia: [...TRUCK.inertia],
        cgOffset: [...TRUCK.cgOffset],
        tireRadiusFt: TRUCK.tireRadiusFt,
        tireWidthFt: TRUCK.tireWidthFt,
        hubs,
        drawHubs: anchors,
        frontAxleZ,
        rearAxleZ,
        scrapePoints: (geometry.scrapePoints ?? []).map((p) => [p[0], p[1], p[2]]),
        sagFt: sag,
        spring,
        damper,
        transferRatio: transferRatio(setup.transferSetting ?? DEFAULT_TRANSFER_SETTING, difficulty),
        tireCut: Math.max(0, Math.min(2, setup.tireCut ?? 0)),
        gripK: proSonicCpu ? TIRE_GRIP_K_SONIC_PRO : TIRE_GRIP_K,
        torqueGain: proSonicCpu ? 1.1 : !cpu && autoShift ? 0.9 : 1,
        cpu,
        autoShift,
        difficulty,
    };
}
