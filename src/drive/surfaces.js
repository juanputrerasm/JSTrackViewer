/*
  What the ground is made of, and what that does to a tire.

  MTM1 and MTM2 give every terrain texture a ground type and a depth, stored in the track's
  .TTY as 100 * type + depth (Traxx TrackPODFile.cpp ParseTTYFile). The thirteen types and
  their numbering are Traxx's own ("Texture Types.txt", the Textures dialog's GROUND TYPE
  list). Depth runs 0 to 99; the stock tracks keep it low on firm ground (Cement 0-1, Rocks
  1-4, Dirt 1-5) and high where a truck sinks in (Sand 8, Grass 8, MTM1's Water 16-20), so it
  is read as how far the tires dig in, which is what adds drag.

  Stock values, for reference: ALASKA Dirt 2, Rocks 1, Grass 3; AZTEC Dirt 5, Grass 5-8;
  BAJA Sand 4-8, Gravel 2; CRAZY98 Cement 0, Dirt 3; TPARK Dirt 4, Cement 0; SUMMIT1 Dirt 5.

  THE NUMBERS ARE NOT MEASURED. MTM2's own table is inside its executable and has not been
  traced, so each type below is a plausible reading of its name, tuned so the order is right:
  road and metal grip best, dirt and grass a little less, gravel and sand loose, mud and snow
  hard going, ice barely steerable, and water drags at the truck the faster it goes.

    grip    multiplies the tire's peak friction (CF_long and CF_lat)
    roll    multiplies the tire's rolling resistance
    sink    extra rolling resistance per point of depth, as a fraction of the wheel's load
    drag    speed-dependent drag per point of depth, lbf per ft/s per 1,000 lbf of load
*/

export const SURFACES = [
  { name: "Default", grip: 1.00, roll: 1.0, sink: 0,      drag: 0 },
  { name: "Cement",  grip: 1.05, roll: 0.7, sink: 0,      drag: 0 },
  { name: "Dirt",    grip: 0.88, roll: 1.3, sink: 0.004,  drag: 0 },
  { name: "Water",   grip: 0.60, roll: 2.0, sink: 0.006,  drag: 0.9 },
  { name: "Mud",     grip: 0.50, roll: 3.0, sink: 0.020,  drag: 0.3 },
  { name: "Sand",    grip: 0.72, roll: 2.5, sink: 0.012,  drag: 0 },
  { name: "Grass",   grip: 0.82, roll: 1.4, sink: 0.004,  drag: 0 },
  { name: "Gravel",  grip: 0.78, roll: 1.6, sink: 0.006,  drag: 0 },
  { name: "Ice",     grip: 0.22, roll: 0.6, sink: 0,      drag: 0 },
  { name: "Snow",    grip: 0.45, roll: 2.2, sink: 0.012,  drag: 0.1 },
  { name: "Metal",   grip: 0.92, roll: 0.7, sink: 0,      drag: 0 },
  { name: "Wood",    grip: 0.90, roll: 0.9, sink: 0,      drag: 0 },
  { name: "Rocks",   grip: 0.92, roll: 1.5, sink: 0.002,  drag: 0 },
];

/** A type number past the thirteen Traxx names (TPARK has one 14) behaves as Default. */
export function surfaceOf(ttyValue) {
  const value = ttyValue ?? 0;
  const type = Math.floor(value / 100);
  return { ...(SURFACES[type] ?? SURFACES[0]), type: SURFACES[type] ? type : 0, depth: value % 100 };
}
