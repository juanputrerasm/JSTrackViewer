/*
  The sky gradient: how Terminal Velocity, Fury3, Hellbender and MTM1 colour their sky.

  Every sky texture in those games is drawn only in palette slots 240-254, which are black in
  every .ACT. The engine fills them at load (GAME.EXE 0x17be0) by opening the level's sky .ACT,
  seeking to colour 192 and copying 16 colours into slots 240-255. So one shared SKY.RAW is
  recoloured per level (BLUESKY, DSRTSKY, LAVASKY ...), and the 16th colour, slot 255, is the
  horizon: the engine clears the screen to it before drawing the sky, and the last row of the
  .FOG table maps every colour onto it. MTM1's ALIENSKY.RAW and NEWSKY.RAW work the same way.

  Ported from JSTrackViewer's src/worker/lvl-parser.js and sit-parser.js.
*/
/** The palette slot the gradient is copied into. */
export const SKY_PALETTE_FIRST_SLOT = 240;
/** The .ACT colour it is read from. */
export const SKY_ACT_FIRST_COLOUR = 192;
/** How many colours; the last is the horizon. */
export const SKY_GRADIENT_COLOURS = 16;
/** The 16 gradient colours (48 bytes) of a sky .ACT, or null when it is too short. */
export function skyGradient(act) {
    if (!act)
        return null;
    const start = SKY_ACT_FIRST_COLOUR * 3;
    const end = start + SKY_GRADIENT_COLOURS * 3;
    return act.length >= end ? new Uint8Array(act.subarray(start, end)) : null;
}
/** The horizon colour: the gradient's last entry. */
export function skyHorizon(gradient) {
    return [gradient[45], gradient[46], gradient[47]];
}
