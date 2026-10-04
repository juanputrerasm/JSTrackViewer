/*
  The game's time base: 16.16 fixed-point seconds, 0x10000 = 1 s (A§5). Race timers, replay
  stamps and network times use it.
*/
export const FIXED_ONE = 0x10000;
export function secondsToFixed(seconds) {
    return Math.trunc(seconds * FIXED_ONE);
}
export function fixedToSeconds(fixed) {
    return fixed / FIXED_ONE;
}
