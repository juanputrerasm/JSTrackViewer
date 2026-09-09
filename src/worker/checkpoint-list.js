/*
  The ordered checkpoint list.

  Terminal Velocity and Fury3 name their route in a .NAV, which is why those games get a
  Navigation Points layer. The four racing families have no such file: a checkpoint is an
  ordinary placement in the .SIT, tagged by type, and the order it is passed in is the order
  it appears in the box list.

  That ordering is the game's, not this viewer's. Traxx assigns it on load - "Make sure
  checkpoint sequence is set", TrackPOD/TrackPODClone.cpp:612-616, which walks the boxes and
  numbers every type-6 it meets - and the editor's own integrity check refuses a track with
  none (TrackPOD/TrackPODIntegrity.cpp:132-137). The editor caps the list at 20
  (TraxxViewEdit.cpp:2475).

  Which records are checkpoints:

    MTM 1, MTM 2, CPR   box type 6, BOXTYPE_CHECKPOINT. The visible gate is the box's own
                        model, CKBOX.BIN or CKBOXN.BIN in stock content.
    Evo 1               box type 6 again, but with no model: the .SIT places the gate posts
                        separately as ordinary type-7 props, so the checkpoint record is an
                        invisible trigger volume.
    Evo 2               no type field at all. Its .SIT is a class registry and the class is
                        named outright, CCheckpoint, which is a better signal than a number.

  Counts, from the stock tracks: 5-13 per MTM track, 6-7 per CPR track, 9-10 per Evo 1 track
  and 11-18 per Evo 2 track.
*/

/** BOXTYPE_CHECKPOINT (Include/TrackPODBox.h). */
const BOXTYPE_CHECKPOINT = 6;

/** Evo 2 names the class rather than numbering the type. */
const EVO_CHECKPOINT_CLASS = "CCheckpoint";

/** Traxx refuses to save a track with more than this many (TraxxViewEdit.cpp:2475). */
export const MAX_CHECKPOINTS = 20;

/*
  A note on the gate angle, which this deliberately does not carry.

  A checkpoint box has a psi, and it is the axis the gate lies on: measured against the
  nearest course segment over the 24 stock tracks whose course has real two-dimensional
  extent, the mean |cos| is 0.81 with a median of 0.996 against 0.36 for the perpendicular
  reading. But the SIGN is not authored consistently - Evo opposes the driving direction in
  all 64 confident cases while MTM and CPR split 104 to 186 - so it is an axis and not a
  heading. The marker is a numbered head with no direction on it, so nothing needs the angle;
  it is recorded here rather than carried as a field no consumer reads.
*/

/**
 * The ordered checkpoints of an MTM-family track, from its parsed .SIT boxes.
 *
 * `checkpointSequence` is assigned by the .SIT reader as it walks the box list, so it is the
 * pass order rather than the box index; boxes are re-read here in that order so the list is
 * right even if a later pass reorders them.
 */
export function collectMtmCheckpoints(boxes) {
  return (boxes ?? [])
    .filter((box) => box.type === BOXTYPE_CHECKPOINT)
    .sort((a, b) => (a.checkpointSequence ?? 0) - (b.checkpointSequence ?? 0))
    .map((box, index) => ({
      index,
      sequence: box.checkpointSequence ?? index,
      position: [...box.position],
    }));
}

/**
 * The ordered checkpoints of an Evo track, from its parsed .SIT boxes.
 *
 * Evo has no sequence field, so the file order is the order. That is the same rule the MTM
 * family follows, where the sequence Traxx writes is exactly a walk of the box list.
 */
export function collectEvoCheckpoints(boxes) {
  const out = [];
  for (const box of boxes ?? []) {
    const isCheckpoint = box.sourceClass === EVO_CHECKPOINT_CLASS || box.boxType === BOXTYPE_CHECKPOINT;
    if (!isCheckpoint) continue;
    out.push({
      index: out.length,
      sequence: out.length,
      position: [...box.position],
    });
  }
  return out;
}
