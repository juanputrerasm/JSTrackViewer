/*
  Checkpoints and lap timing.

  MTM2 builds a checkpoint out of two different things, which is the detail that matters here.
  Traxx's own notes say it outright: "funky checkpoints are type 7 (drive thru) but with boxes
  at their base to prevent driving thru. Regular ckbox object is there to do the checkpoint
  stuff." So the TRIGGER is a type 6 box, it is deliberately not solid, and any solid parts
  standing near it are separate objects that the collider already handles.

  Order comes from the file rather than from geometry: sit-parser.js numbers each type 6 box
  with a `checkpointSequence` as it reads them, which is the order the game counts them in. A
  lap is complete when the last one is passed and the first is reached again.

  Gates are generous on purpose. A checkpoint volume in these tracks is a banner or an arch a
  few truck-widths across, and a driver who clips the edge of one at 60 mph has passed it as
  far as any player is concerned. Being strict here would mean invalidating laps that looked
  perfectly good, which is the one failure nobody forgives in a racing game.
*/
import { UNITS_PER_FOOT_H, UNITS_PER_FOOT_V } from "./world-frame.js";

const TYPE_CHECKPOINT = 6;

/** How far outside a gate's own extents still counts as passing through it, in feet. */
const GATE_TOLERANCE = 8;

/**
 * @param {object} trackData as the worker returns it
 * @returns a tracker, or null when the track has no checkpoints (a drag strip, a stadium)
 */
export function createCheckpoints(trackData) {
  const worldSize = (trackData?.terrain?.gridSize ?? 256) * (trackData?.terrain?.cellSize ?? 64);
  const heightScale = trackData?.terrain?.heightScale ?? 3;
  const toFeetH = 1 / UNITS_PER_FOOT_H;
  const toFeetV = 1 / UNITS_PER_FOOT_V;

  const gates = (trackData?.boxes ?? [])
    .filter((box) => (box.type ?? 0) === TYPE_CHECKPOINT)
    .map((box) => {
      const [wx = 0, wy = 0, wz = 0] = box.position ?? [];
      return {
        sequence: box.checkpointSequence ?? 0,
        centre: {
          x: wx * toFeetH,
          y: wz * heightScale * toFeetV,
          z: (worldSize - wy) * toFeetH,
        },
        /*
          Radius rather than an oriented volume.

          A gate's authored psi is not a reliable facing: the notes for these tracks record
          that its sign is not written consistently, so a box's "forward" cannot be trusted to
          say which way a driver should pass through. A distance test needs no facing, and
          since the sequence already says which gate is next, there is nothing a facing would
          add except a way to reject a lap that really happened.
        */
        radius: Math.max(box.width ?? 32, box.length ?? 32) * toFeetH + GATE_TOLERANCE,
        height: (box.height ?? 32) * toFeetV + GATE_TOLERANCE,
      };
    })
    .sort((a, b) => a.sequence - b.sequence);

  if (!gates.length) return null;

  let next = 0;
  let lap = 0;
  let lapTime = 0;
  let bestLap = null;
  let lastLap = null;
  let running = false;

  return {
    gateCount: gates.length,
    gates,

    get state() {
      return {
        next,
        gateCount: gates.length,
        lap,
        lapTime,
        bestLap,
        lastLap,
      };
    },

    reset() {
      next = 0;
      lap = 0;
      lapTime = 0;
      bestLap = null;
      lastLap = null;
      running = false;
    },

    /**
     * Advance the timer and test the truck against the gate it is looking for.
     *
     * Only the NEXT gate is tested, which is what stops a course that doubles back on itself
     * from counting a gate the driver merely drove past on the way to another one.
     *
     * @returns {null|{gate:number, lap:number, lapTime:number}} an event when something happened
     */
    update(dt, positionFeet) {
      if (running) lapTime += dt;

      const gate = gates[next];
      const dx = positionFeet.x - gate.centre.x;
      const dz = positionFeet.z - gate.centre.z;
      const dy = positionFeet.y - gate.centre.y;
      const withinGround = (dx * dx + dz * dz) <= gate.radius * gate.radius;
      const withinHeight = Math.abs(dy) <= gate.height;
      if (!withinGround || !withinHeight) return null;

      const passed = next;
      next = (next + 1) % gates.length;

      /*
        The first gate starts the clock rather than completing a lap: a truck sitting on the
        start grid has not driven anything yet, and timing from the moment it rolls through
        the first gate is what every racing game means by a lap.
      */
      if (!running) {
        running = true;
        lapTime = 0;
        return { gate: passed, lap, lapTime: 0, started: true };
      }

      /*
        The lap is credited on crossing gate 0 again, not on passing the last gate.

        Those are one gate apart and it matters twice over. The obvious version tests the
        wrapped `next === 0`, which fires as the truck passes the FINAL checkpoint, so the lap
        is announced before the run back to the line and its time is short by that whole
        segment. Gate 0 is the start and finish in these tracks, and a lap ends where it began.

        Reaching gate 0 already implies every other gate was taken, since only the next one in
        sequence is ever tested.
      */
      if (passed === 0) {
        lap += 1;
        lastLap = lapTime;
        if (bestLap === null || lapTime < bestLap) bestLap = lapTime;
        const completed = lapTime;
        lapTime = 0;
        return { gate: passed, lap, lapTime: completed, lapComplete: true };
      }

      return { gate: passed, lap, lapTime };
    },
  };
}
