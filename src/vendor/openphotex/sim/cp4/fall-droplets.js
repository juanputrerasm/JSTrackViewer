/** The emitter's constants (16.5). */
export const FALL_DROPLETS = {
    /** Bursts banked per second, and at most. */
    budgetPerSec: 500,
    budgetMax: 80,
    /** Bursts a stream may throw in one frame. */
    perStreamFrame: 6,
    /** A stream throws only within this horizontal distance of the player, ft. */
    rangeFt: 150,
    /** Streams a fall has at most. */
    streams: 4,
    /** `[Graphics] waterfallDroplets` (percent): default, range; 0 is off. */
    defaultPct: 100,
    maxPct: 400,
    /** The interval: (0.4 + 1.2 u) * 0.02 / kS s. */
    intervalBase: 0.4,
    intervalSpread: 1.2,
    intervalScale: 0.02,
};
/** The DLL's spray model the bursts are drawn with (16.5), for the host's renderer. Units: ft, s. */
export const FALL_SPRAY = {
    /** Records kept, and how long one is drawn. */
    ring: 4096,
    retentionSec: 2.4,
    drops: 80,
    blobs: 3,
    /** Life of a drop (times 0.65 + 0.35 h6) and of a blob. */
    lifeSec: 2,
    /** Drag, 1/s, and gravity, ft/s^2 (8192 units of 1/256 ft). */
    drag: 0.5,
    gravity: 32,
    /** The slowest a burst's spread is figured from, ft/s (768 units / s). */
    minSpeed: 3,
    /** The speed that thins the drops: saturate((|v| - 1500 / 256) / (6200 / 256)). */
    thinFrom: 1500 / 256,
    thinOver: 6200 / 256,
};
/** The droplet hash (16.5). */
export function fallDropletHash(x) {
    x >>>= 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x85ebca6b) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
}
/** The DLL's sprite hash (16.5). */
export function fallSprayHash(x) {
    x >>>= 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
}
/** A hash as a uniform number in [0, 1): (h >> 8) * 2^-24. */
const unit = (h) => (h >>> 8) * 2 ** -24;
/** A fresh emitter for the built falls. */
export function createFallDroplets(falls) {
    const rng = new Uint32Array(64);
    for (const f of falls)
        rng[f.slot] = f.rngSeed >>> 0;
    return { budget: 0, timers: new Float64Array(64 * 4), intervals: new Float64Array(64 * 4), rng };
}
const SNOW = 5, FREEZE = 1, SPLASH = 2;
/**
 * One frame of the emitter (16.5): the bursts it throws, in order. With `enabled` false every timer is cleared and
 * nothing is thrown. The state is changed in place.
 */
export function stepFallDroplets(state, falls, step) {
    const D = FALL_DROPLETS;
    const out = [];
    const pct = Math.min(Math.max(step.dropletsPct ?? D.defaultPct, 0), D.maxPct);
    if (!step.enabled || pct <= 0) {
        state.timers.fill(0);
        state.intervals.fill(0);
        return out;
    }
    const k = pct / 100, dt = Math.max(0, step.dt);
    state.budget = Math.min(state.budget + dt * D.budgetPerSec, D.budgetMax);
    const snow = step.weather === SNOW;
    for (const f of falls) {
        const w = f.worldFt ?? 8192;
        for (let s = 0; s < D.streams; s++) {
            const slot = f.slot * 4 + s;
            const st = f.streams?.[s];
            if (!st || s >= f.streams.length || !(f.flags & SPLASH) || (snow && f.flags & FREEZE)) {
                state.timers[slot] = 0;
                state.intervals[slot] = 0;
                continue;
            }
            // The stream's x, z wrapped into [0, W), then to the copy nearest the player.
            let x = st.x - Math.floor(st.x / w) * w, z = st.z - Math.floor(st.z / w) * w;
            let dx = x - step.player[0], dz = z - step.player[1];
            dx -= Math.floor(dx / w + 0.5) * w;
            dz -= Math.floor(dz / w + 0.5) * w;
            x = step.player[0] + dx;
            z = step.player[1] + dz;
            if (dx * dx + dz * dz > D.rangeFt * D.rangeFt) {
                state.timers[slot] = 0;
                state.intervals[slot] = 0;
                continue;
            }
            const total = f.totalColumns ?? 0;
            const kS = total > 0 ? Math.max((k * st.columns) / total, 0.001) : k;
            const draw = () => {
                state.rng[f.slot] = (state.rng[f.slot] + 0x9e3779b1) >>> 0;
                return (D.intervalBase + D.intervalSpread * unit(fallDropletHash(state.rng[f.slot]))) * D.intervalScale / kS;
            };
            if (!(state.intervals[slot] > 0))
                state.intervals[slot] = draw();
            state.timers[slot] = state.timers[slot] + dt;
            const vLand = Math.sqrt(Math.max(0, f.crestSpeedFtPerSec ** 2 + 64 * st.drop));
            const sizeK = Math.min(Math.max(st.drop / 60, 0.3), 1);
            let n = 0;
            while (state.timers[slot] >= state.intervals[slot] && state.budget >= 1 && n < D.perStreamFrame) {
                state.timers[slot] = state.timers[slot] - state.intervals[slot];
                state.intervals[slot] = draw();
                state.budget -= 1;
                n++;
                out.push(fallDropletBurst(state, f, s, x, z, vLand, sizeK, k));
            }
            if (state.timers[slot] >= state.intervals[slot])
                state.timers[slot] = 0.999 * state.intervals[slot];
        }
    }
    return out;
}
/**
 * One burst (16.5) of stream `s` at (x, z). The per-draw offsets the engine adds to the state are its own; these
 * draws follow its rules (position, angle, speeds, size) with offsets of their own, so the bursts are alike but not
 * bit for bit the engine's.
 */
function fallDropletBurst(state, f, s, x, z, vLand, sizeK, k) {
    const st = f.streams[s];
    const hasDir = st.dirX !== 0 || st.dirZ !== 0;
    const base = state.rng[f.slot];
    let c = st.dirX, sn = st.dirZ;
    const u = (i) => unit(fallDropletHash((base + Math.imul(i + 1, 0x9e3779b9)) >>> 0));
    let ahead;
    if (hasDir)
        ahead = 8 * u(0);
    else {
        const ang = 2 * Math.PI * u(0);
        c = Math.cos(ang);
        sn = Math.sin(ang);
        ahead = (2 * u(8) - 1) * 4;
    }
    const j = (2 * u(1) - 1) * Math.min(st.width / 2, 60);
    const px = x + c * ahead - sn * j + 1.5 * (2 * u(2) - 1);
    const pz = z + sn * ahead + c * j + 1.5 * (2 * u(3) - 1);
    const theta = (2 * u(4) - 1) * 1.396;
    const hs = 0.2 * u(5) * vLand;
    const ca = Math.cos(theta), sa = Math.sin(theta);
    const vx = (c * ca - sn * sa) * hs, vz = (sn * ca + c * sa) * hs;
    const vy = (0.06 + 0.12 * u(6)) * vLand;
    const intensity = Math.min(1, (0.6 + 0.6 * u(7)) * sizeK * 0.3 * k);
    const sizeScale = (1.5 + 1.5 * u(9)) * Math.min(Math.max(k, 0.3), 4);
    const seed = fallDropletHash((base + 0x78dde6c4) >>> 0);
    state.rng[f.slot] = (base + (hasDir ? 0x2e2ac0ea : 0x6a99b44c)) >>> 0;
    return {
        fall: f.slot, stream: s, position: [px, st.y, pz], velocity: [vx, vy, vz], intensity, waterY: st.y,
        halfWidth: Math.min(12, st.width / 2), sizeScale, seed,
    };
}
