/*
  The 4x4 Evolution driveline (OpenMTM2 docs/EVO2_PHYSICS.md §5.3, §6): torque curve, drivetrain
  inertia, gearbox, wheelspin, centre split and axle differentials. Gear numbers are MTM2's.
*/
import { GEAR } from "../mtm2/constants.js";
const TWO_PI = Math.PI * 2;
const MPH_PER_FT_S = 0.681818;
/** Ratio of a gear number (0 in Park and Neutral and past the table). */
export function evoGearRatio(spec, gear) {
    return spec.gearRatios[gear - 1] ?? 0;
}
/**
 * Torque at an rpm at full throttle: the table every 500 rpm, linear between entries (0x559cb0,
 * at most 23 entries). Past the table's last entry the game reads on into the next fields; the
 * port holds the last entry (stock tables reach past the redline, so this only matters for a
 * short table).
 */
export function evoTorqueAt(table, rpm) {
    if (table.length === 0)
        return 0;
    if (table.length === 1 || rpm >= (table.length - 1) * 500)
        return table[table.length - 1];
    let i = Math.floor(rpm / 500);
    if (i > 22)
        i = 22;
    if (i < 0)
        i = 0;
    return (rpm - i * 500) / 500 * (table[i + 1] - table[i]) + table[i];
}
/** The drivetrain's inertia in a gear (0x55a6b0). */
export function evoDriveInertia(spec, gear, finalRatio) {
    const ratio = Math.abs(evoGearRatio(spec, gear) * 0.8) * finalRatio;
    return ((spec.gearInertia[gear - 1] ?? 0) + 0.8) * ratio * ratio + finalRatio * 1.2 * finalRatio + 11;
}
/**
 * The gearbox step (0x553fb0). Automatic: up one gear from first upwards when the rpm reaches the
 * upshift rpm and the speed is past the upshift speed of the gear; down one from second upwards
 * when the rpm falls under the downshift rpm and the speed under the downshift speed. Manual: one
 * gear per request, down to Park. Park holds both brakes.
 */
export function stepEvoGearbox(box, spec, rpm, forwardSpeed, finalRatio, tireRadius, autoShift) {
    const circumference = tireRadius * TWO_PI;
    const shiftSpeed = (gear, at) => {
        const ratio = evoGearRatio(spec, gear) * 60 * finalRatio;
        return ratio !== 0 ? ((circumference * at) / ratio) * MPH_PER_FT_S : Infinity;
    };
    const mph = forwardSpeed * MPH_PER_FT_S;
    const up = autoShift
        ? rpm >= spec.upshiftRpm && box.gear >= GEAR.FIRST && box.gear < spec.maxGear && shiftSpeed(box.gear, spec.upshiftRpm) < mph
        : box.shiftRequest > 0 && box.gear < spec.maxGear;
    if (up)
        box.gear++;
    const down = autoShift
        ? rpm < spec.dnshiftRpm && box.gear > GEAR.FIRST && mph < shiftSpeed(box.gear, spec.dnshiftRpm)
        : box.shiftRequest < 0 && box.gear > GEAR.PARK;
    if (down)
        box.gear--;
    box.shiftRequest = 0;
    if (box.gear === GEAR.PARK) {
        box.brakeFront = 1;
        box.brakeRear = 1;
    }
}
/**
 * Wheelspin (0x559af0): a tire's slip value against its drive force. `gripCoef` is the tire's
 * CF * mu * weather * tread and `fmax` its friction capacity (0 in the air).
 */
export function evoStepSlip(slip, drive, speed, gripCoef, fmax, onGround, inertia, dt) {
    let threshold = 200 * 0.01 * (0.84 - speed * 0.002) * gripCoef * fmax;
    if (!onGround)
        threshold *= 0.1;
    const f = drive < 0 ? drive * 0.5 : drive;
    if (Math.abs(f) <= threshold) {
        slip *= 0.99;
    }
    else {
        const rate = slip <= 50 ? 330 : 230;
        slip += dt * (((Math.abs(f) - threshold) + slip * 0.001) * rate / inertia);
    }
    if (slip > 100)
        return 100;
    if (slip < 0.9)
        return 0;
    slip *= 0.7;
    return slip < 1 ? 0 : slip;
}
/**
 * The centre split (0x5589a0): each axle's torque_pct, or with drive type 2 an offset moving 0.1 a
 * step from the axle whose tires slip more to the other, while that one still has some.
 */
export function evoCentreSplit(spec, offsets, split, slip) {
    if (spec.driveType === 2) {
        const front = (slip[0] + slip[1]) * 0.5, rear = (slip[2] + slip[3]) * 0.5;
        if (Math.abs(front - rear) <= 0) {
            offsets[0] = 0;
            offsets[1] = 0;
        }
        else if (front <= rear) {
            if (split[0] < 1 && split[1] > 0) {
                offsets[0] += 0.1;
                offsets[1] -= 0.1;
            }
        }
        else if (split[0] > 0 && split[1] < 1) {
            offsets[0] -= 0.1;
            offsets[1] += 0.1;
        }
    }
    else {
        offsets[0] = 0;
        offsets[1] = 0;
    }
    split[0] = spec.torquePct[0] + offsets[0];
    split[1] = spec.torquePct[1] + offsets[1];
}
/**
 * One axle's differential (0x5587c0), shares as [left, right]. Type 1 compares the two tires'
 * longitudinal forces this step and takes share from the one pulling more than 1% harder (either
 * not pulling resets to 50/50); type 2 takes share from the tire whose slip exceeds the other's by
 * more than 5 (otherwise 50/50); type 0 is open, 50/50.
 */
export function evoDifferential(type, shares, forceLeft, forceRight, slipLeft, slipRight) {
    if (type === 1) {
        if (forceLeft <= 0 || forceRight <= 0) {
            shares[0] = 0.5;
            shares[1] = 0.5;
            return;
        }
        if (forceRight * 1.01 < forceLeft) {
            shares[0] = Math.max(0, shares[0] - (forceLeft - forceRight) / (forceRight + forceLeft));
            shares[1] = 1 - shares[0];
        }
        else if (forceLeft * 1.01 < forceRight) {
            shares[1] = Math.max(0, shares[1] - (forceRight - forceLeft) / (forceLeft + forceRight));
            shares[0] = 1 - shares[1];
        }
        return;
    }
    if (type === 2) {
        const d = slipLeft - slipRight;
        if (d > 5) {
            shares[0] = Math.max(0, shares[0] - d / (slipRight + slipLeft));
            shares[1] = 1 - shares[0];
            return;
        }
        if (-d > 5) {
            shares[1] = Math.max(0, shares[1] + d / (slipRight + slipLeft));
            shares[0] = 1 - shares[1];
            return;
        }
    }
    shares[0] = 0.5;
    shares[1] = 0.5;
}
