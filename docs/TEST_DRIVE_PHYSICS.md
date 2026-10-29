# Test Drive physics

Test Drive now runs OpenPhotex's `sim/mtm2` vehicle simulation, the same code used by
OpenMTM2's `src/worker/sim-worker.js`. The existing vendored dynamics, controls,
contacts, parameter tables and drivetrain match that checkout. No generated vendor
files are edited for this integration.

`src/drive/openmtm2-sim.js` connects the simulation to the viewer. Each 1/120-second
step applies controls, calls `stepTruck`, resolves viewer scenery contacts, then
calls `postStepTruck`. The core supplies the documented MTM2 mass, inertias, spring
rates, dampers, solid axles, tire friction/slip laws, engine curve, transmission,
and aerodynamic/water drag. The physics source of truth is OpenPhotex, specified
in OpenMTM2's `docs/MTM2_PHYSICS.md`.

## Viewer boundary

- Both systems use feet and seconds. World Z is reflected at the adapter boundary;
  TRK body anchors and SIT headings retain their original conventions. The viewer
  still handles its horizontal/vertical scene scaling when rendering.
- The viewer's height and normal samplers retain CPR road support, Evo fractional
  heights, Fly! terrain and absent Hellbender cells. Water height is converted from
  the same track height scale used to draw it.
- Terrain and ground-box TTY values feed the shared surface tables. The library's
  height query has no altitude argument, so object support is selected below the
  truck's body origin. Overhead bridge decks remain traversable from underneath.
- Ground boxes and fixed scenery are met through OpenPhotex, as OpenMTM2 meets
  them, between the truck step and the post-step:
  - ground boxes (`.RA0`/`.RA1`) through `groundBoxesAround` and
    `collideTruckImmovableBox`, which also carry the wheels on a box's top. A grid
    smaller than 256 (Hellbender's 128) is laid out to repeat, as OpenMTM2 lays it
    out; a step is the drawn one, so boxes stand where the terrain beside them is;
  - fixed scenery (a model that does not move, cannot be pushed or crushed, and is
    not an Evo tree trunk) through `collideTruckFace`: its triangles more than 50
    degrees from level are wall faces, OpenMTM2's line for 4x4 Evolution's rocks,
    and the rest of the model stays ground through the viewer's support query. A
    face's open side is the model's outside: BIN triangles are wound to face in
    (the scene draws them BackSide; 146 of 152 stock models measured), and an
    Evo `.SMF` states its facing in its vertex normals.
- `scenery-contacts.js` retains the viewer's contacts for everything else: moving
  props, movable and top-crush objects, Evo trunks, model-less boxes, ramps and the
  CPR road walls. It transfers contact impulses in simulation axes and pushes the
  viewer's movable objects. The truck's queries pass `{ truck: true }` so these
  colliders do not answer it a second time for ground boxes and walls.
- Wheels draw the core's axle travel and articulation, steering and spin. Physics
  rolls on the truck's own tires, as OpenMTM2 passes them (`tireRadiusFt`,
  `tireWidthFt`): the mean of the four measured from the tire models, falling
  back to MTM2's 3 by 4 ft when they cannot be measured. The wheelbase is clamped
  as in the core; artwork retains the original TRK anchors.
- Keyboard steering and pedals use the shared ramping laws. Active gamepad axes
  use its joystick law. The viewer keeps its manual first/reverse shortcut,
  releases manual throttle with the pedal, and treats Space as a brake without
  selecting reverse. Brake lamps follow the resolved brake pressure.
- The simulation is OpenPhotex 1.4.0's, the version OpenMTM2 uses. Since 1.1.2 it
  reports each step's hull contact force (0 without contact) and the speed the bump
  stops take off a landing (`bottoming`). `readState` gives the hardest of each over
  the last frame. Gamepad rumble is not played.
- OpenMTM2's guard against a blown-up state is applied after every step: a state
  with a number that is not finite, or a speed, height or turn rate no truck reaches,
  is put back to the copy kept every quarter second, at rest (`rescued` counts it).
- Cameras, checkpoints, minimap, reset and rollover recovery remain viewer features.
  Truck swaps preserve world velocity, selected gear and gearbox mode.

The previous `vehicle-sim.js` and `params/mtm2-feel.js` are retained for existing
experiments and regression tests, including pre-existing local edits. They are
not used by Test Drive. `MTM2_PHYSICS_NOTES.md` records the earlier investigation;
it is not the specification for the shared core.

## Validation

Run `node --test tests/`. `openmtm2-sim.test.mjs` compares an entire input trace
against the direct OpenMTM2 control/step/post-step sequence, and checks headings,
settling, acceleration, shifting, reverse, analog controls, surface depth, weather,
water, void terrain, bridges, scenery impacts, axle rendering data, rollover,
truck swaps, fixed-step reproducibility, the blown-up-state guard, bottoming, a
ground-box wall and a model wall met through OpenPhotex. A stock Bigfoot assembly test reads
local game data through OpenPhotex and skips when that install is absent.
