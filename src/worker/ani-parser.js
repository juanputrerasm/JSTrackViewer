import { toDataLines } from "./tv-coords.js";

/*
  .ANI animated texture definitions (Terminal Velocity / Fury3 / F!Zone).

  Referenced from LVL header line 8. Plain ASCII, CRLF, count-prefixed. Each animation names
  the texture slot it replaces, then its frame count and rate, then the frames:

    <animationCount>
      <base texture name>
      <frameCount>,<rate>
      <frame 1 name>
      ...
      <frame N name>

  From FURY3.POD's AMINE-T1.ANI:

    4
    FAN1.RAW
    4,16384
    FAN1.RAW  FAN2.RAW  FAN3.RAW  FAN4.RAW
    FS1.RAW
    4,16384
    ...

  Measured across the three archives: 169 files, 123 animations. The rate is the usual 16.16
  fixed point, so 16384 is a quarter unit per frame. Read as frames per second that gives 0.25,
  which is far too slow for a spinning fan, and as seconds per frame it gives four seconds.
  The engine's own tick rate is not recorded in the level data, so the viewer treats the value
  as a relative rate against a fixed base (see ANIMATION_BASE_FPS) rather than claiming a unit
  it cannot verify.

  The base frame is always the first frame in shipped content, so a viewer that ignores .ANI
  entirely still shows a valid still image. This is polish, not missing content.
*/

/*
  Frames per second at rate 16384.

  Chosen to read correctly rather than derived from the file: fans and light strobes at this
  speed look like the game. Scaled linearly by the animation's own rate so the relative speeds
  the author set are preserved.
*/
export const ANIMATION_BASE_FPS = 8;
const ANIMATION_BASE_RATE = 16384;

/**
 * Parses a .ANI file into animation records.
 *
 * Returns [] rather than throwing on malformed input.
 */
export function parseAnimations(bytes) {
  if (!bytes || !bytes.length) return [];
  const lines = toDataLines(bytes);
  let i = 0;
  while (i < lines.length && lines[i] === "") i++;
  const count = parseInt(lines[i], 10);
  if (!Number.isFinite(count) || count < 0 || count > 1024) return [];
  i++;

  const animations = [];
  for (let n = 0; n < count && i < lines.length; n++) {
    const baseName = (lines[i] ?? "").toUpperCase();
    if (!baseName) break;
    i++;
    const parts = (lines[i] ?? "").split(",");
    const frameCount = parseInt(parts[0], 10);
    const rate = parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(frameCount) || frameCount < 1 || frameCount > 256) break;
    i++;
    const frames = [];
    for (let k = 0; k < frameCount && i < lines.length; k++, i++) {
      frames.push((lines[i] ?? "").toUpperCase());
    }
    if (frames.length < 2) continue;   // a single frame is a still, nothing to animate
    animations.push({
      baseName,
      frames,
      rate: Number.isFinite(rate) ? rate : ANIMATION_BASE_RATE,
      fps: ANIMATION_BASE_FPS * ((Number.isFinite(rate) ? rate : ANIMATION_BASE_RATE) / ANIMATION_BASE_RATE),
    });
  }
  return animations;
}
