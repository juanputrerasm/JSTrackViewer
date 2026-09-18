/*
  Drive mode: the piece that ties the simulation to the scene.

  Everything it coordinates is testable on its own (the sim runs under node, the truck object
  is geometry, the cameras are maths), so this file deliberately holds no physics and no
  geometry of its own. What it does own is the clock.

  THE CLOCK IS THE POINT. The sim steps at a fixed 1/120 s and the browser paints whenever it
  likes, so real time is accumulated and spent in whole steps. Stepping by the frame time
  instead would make the truck behave differently on a 60 Hz screen than on a 144 Hz one, and
  would make a captured input trace unreproducible, which is the whole basis of the parameter
  fitting this plan ends in.
*/
import * as THREE from "three";
import { createVehicleSim } from "./vehicle-sim.js";
import { createColliders } from "./colliders.js";
import { createCheckpoints } from "./checkpoints.js";
import { createDriveInput } from "./drive-input.js";
import { createDriveCameras } from "./drive-cameras.js";
import { UNITS_PER_FOOT_H, UNITS_PER_FOOT_V } from "./world-frame.js";

const STEP = 1 / 120;
/*
  A frame that took longer than this is not simulated in full.

  Otherwise a stall (a tab in the background, a texture upload) hands over a second of
  accumulated time, the sim runs a hundred steps to catch up, that takes longer than a frame,
  and the backlog grows instead of clearing. Dropping the surplus makes the truck lose a
  moment of travel, which is what every game does and what nobody notices.
*/
const MAX_FRAME = 0.25;

export function createDriveMode({ camera, element, frame, assembly, truckObject, spawn, onStatus, trackData, onObjectsMoved }) {
  /*
    The track's solid objects, if there are any.

    Built once here rather than per step: a stock track is a few hundred boxes and several
    thousand ground columns, sorted into a bucket grid so the sim's sixteen query points only
    ever see the handful nearby.
  */
  const colliders = trackData ? createColliders(trackData, frame) : null;
  // null on a track with no checkpoints, which is every drag strip and stadium.
  const checkpoints = trackData ? createCheckpoints(trackData) : null;
  const sim = createVehicleSim(assembly, frame, undefined, colliders);
  const input = createDriveInput(element);
  const cameras = createDriveCameras(camera);

  const quaternion = new THREE.Quaternion();
  const scenePosition = new THREE.Vector3();
  let accumulator = 0;
  let active = false;
  let lastStatus = 0;

  /** Scene y for a point, so the camera can stay above the ground it flies over. */
  const groundAtScene = (sceneX, sceneZ) => {
    const ground = frame.heightAtFeet(sceneX / UNITS_PER_FOOT_H, sceneZ / UNITS_PER_FOOT_H);
    return ground * UNITS_PER_FOOT_V;
  };

  /*
    Mouse control of the free orbit view.

    Drive mode binds these itself rather than borrowing the fly camera's, because the fly
    camera's handlers are disabled while driving (they wrote to the camera directly and fought
    for it). Without this the orbit view had no way to be orbited at all: it sat at a fixed
    angle, which reads as a camera stuck in space rather than as a control nobody connected.

    Drag turns the camera around the truck, the wheel moves it closer or further. The other
    views ignore both, so a stray drag while chasing does nothing.
  */
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onMouseDown = (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const onMouseMove = (event) => {
    if (!dragging) return;
    cameras.orbit(event.clientX - lastX, event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
  };
  const onMouseUp = () => { dragging = false; };
  const onWheel = (event) => {
    if (cameras.view.id !== "orbit") return;
    event.preventDefault();
    cameras.zoom(event.deltaY);
  };

  function bindPointer() {
    element.addEventListener("mousedown", onMouseDown);
    element.addEventListener("mousemove", onMouseMove);
    element.addEventListener("mouseup", onMouseUp);
    element.addEventListener("mouseleave", onMouseUp);
    element.addEventListener("wheel", onWheel, { passive: false });
  }

  function unbindPointer() {
    dragging = false;
    element.removeEventListener("mousedown", onMouseDown);
    element.removeEventListener("mousemove", onMouseMove);
    element.removeEventListener("mouseup", onMouseUp);
    element.removeEventListener("mouseleave", onMouseUp);
    element.removeEventListener("wheel", onWheel);
  }

  /*
    A rolled truck is put back on the course, not flipped upright where it lies.

    MTM2 leaves you upside down for a couple of seconds and then returns you to the track, and a
    driver reported the same: "they can stay upside down a few seconds, but their position gets
    reset after around 2.5 seconds". Nothing rights the truck in place, which is why this waits
    rather than applying a torque.

    The truck goes back to the nearest point on the primary course, facing the way that course
    runs, rather than to the start grid, which would undo a lap.
  */
  const INVERTED_RESET_SECONDS = 2.5;

  function backOnCourse(positionFeet) {
    const segments = trackData?.primaryCourse?.segments ?? [];
    let best = null;
    for (const segment of segments) {
      const a = frame.editorToFeet(segment.start ?? segment);
      const b = frame.editorToFeet(segment.end ?? segment);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSquared = dx * dx + dz * dz;
      // How far along this segment the truck is, clamped to its ends.
      const t = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((positionFeet.x - a.x) * dx + (positionFeet.z - a.z) * dz) / lengthSquared))
        : 0;
      const point = { x: a.x + dx * t, z: a.z + dz * t };
      const distance = Math.hypot(point.x - positionFeet.x, point.z - positionFeet.z);
      if (!best || distance < best.distance) {
        // A .SIT heading has forward as (sin psi, 0, -cos psi).
        best = { distance, point, psi: Math.atan2(dx, -dz) };
      }
    }
    if (!best) return null;
    return {
      x: best.point.x,
      y: frame.heightAtFeet(best.point.x, best.point.z) + (assembly?.restHeight ?? 6.8),
      z: best.point.z,
      psi: best.psi,
    };
  }

  function placeAtSpawn() {
    const point = spawn();
    if (!point) return;
    sim.reset({ x: point.x, y: point.y, z: point.z }, point.psi ?? 0);
    // A lap in progress does not survive being put back on the grid.
    checkpoints?.reset();
    accumulator = 0;
    cameras.snap();
    render();
  }

  /** Push the current simulation state onto the scene graph. */
  function render() {
    const state = sim.readState();
    /*
      The truck is drawn relative to WHAT IT IS STANDING ON, not to the terrain.

      The scene is anisotropic (2 units per foot across, 1.5 up) while the truck is drawn true,
      so its height has to be measured from its contact point; see toSceneTruckPosition. Passing
      the terrain height works until the truck stands on something else. On TPARK's ground box
      bridge the terrain is in a gully 25 ft below the deck, and the truck was drawn
      165 * 1.5 + 31 * 2 = 309.5 units up while the deck was painted at 190 * 1.5 = 285: eight
      feet of float, and an apparent leap upward as the ground fell away beneath the bridge.

      The simulation was never wrong about any of this. It was standing on the deck the whole
      time; only the drawing was in the wrong place.
    */
    const terrain = frame.heightAtFeet(state.ipos.x, state.ipos.z);
    const support = colliders?.supportAt(state.ipos.x, state.ipos.z, state.ipos.y) ?? null;
    const ground = support !== null && support > terrain && support <= state.ipos.y ? support : terrain;
    const placed = frame.toSceneTruckPosition(state.ipos, ground);
    scenePosition.set(placed.x, placed.y, placed.z);

    const q = sim.orientation;
    quaternion.set(q.x, q.y, q.z, q.w);

    truckObject.setPose(scenePosition, quaternion);
    truckObject.setWheelState(sim.wheelCompression(), sim.wheelSteer(), sim.wheelSpin());
    return state;
  }

  return {
    sim,
    cameras,
    // The scene draws markers from these, so it needs the same objects the sim is using.
    colliders,
    checkpoints,
    get isActive() { return active; },

    start() {
      active = true;
      input.setEnabled(true);
      bindPointer();
      placeAtSpawn();
      element.focus?.();
      onStatus?.({ view: cameras.viewLabel, speed: 0, gear: 1 });
    },

    stop() {
      active = false;
      input.setEnabled(false);
      unbindPointer();
    },

    /** Called once per rendered frame with the real elapsed time. */
    update(dt) {
      if (!active) return;
      const controls = input.read();

      for (const action of controls.actions) {
        if (action === "nextView") {
          cameras.next();
          onStatus?.({ view: cameras.viewLabel });
        } else if (action === "cockpitView") {
          cameras.select("cockpit");
          onStatus?.({ view: cameras.viewLabel });
        } else if (action === "reset") {
          placeAtSpawn();
        }
      }

      accumulator += Math.min(dt, MAX_FRAME);
      let steps = 0;
      while (accumulator >= STEP) {
        /*
          Objects move on the simulation clock, ahead of the truck.

          They used to move once per frame, which was fine for a cone skidding to a halt and
          wrong for TPARK's train: at 70 ft/s a frame's worth of travel is over a foot, handed
          to the truck's contacts in one lump. Stepping them here keeps every contact within a
          step's worth of overlap, and keeps a recorded input trace reproducible.
        */
        colliders?.step(STEP);
        sim.step(STEP, controls);
        accumulator -= STEP;
        // A hard ceiling as well as the frame clamp: if a step ever costs more than a step of
        // simulated time, this is what stops the loop chasing its own tail.
        if (++steps > 16) {
          accumulator = 0;
          break;
        }
      }

      // Drawn once per frame, from wherever the steps above left them.
      if (colliders) onObjectsMoved?.(colliders);

      // Upside down for long enough: back onto the course, as the game does.
      if (sim.readState().invertedFor > INVERTED_RESET_SECONDS) {
        const place = backOnCourse(sim.readState().ipos);
        if (place) {
          sim.reset({ x: place.x, y: place.y, z: place.z }, place.psi);
          cameras.snap();
          onStatus?.({ event: { kind: "reset", reason: "rolled over" } });
        }
      }

      const state = render();

      /*
        Gates are tested once per frame rather than once per simulation step.

        A gate is metres across and a truck covers about a foot per step, so stepping it 120
        times a second would only find the same crossing over and over. What matters is that
        the position tested is the one just rendered, so a lap is credited for the truck the
        driver can see.
      */
      const event = checkpoints?.update(dt, state.ipos) ?? null;
      if (event) {
        onStatus?.({
          speed: state.speed * 0.681818,
          gear: state.gear,
          rpm: state.rpm,
          view: cameras.viewLabel,
          race: checkpoints.state,
          event,
        });
      }

      cameras.update(dt, {
        position: scenePosition,
        heading: state.psi,
        quaternion,
        driverHeight: 3.2,
      }, groundAtScene);

      // The readout is for a person, so it updates at a readable rate rather than every frame.
      lastStatus += dt;
      if (lastStatus > 0.1) {
        lastStatus = 0;
        onStatus?.({
          speed: state.speed * 0.681818,  // ft/s to mph
          gear: state.gear,
          rpm: state.rpm,
          airborne: state.airborne,
          view: cameras.viewLabel,
          race: checkpoints?.state ?? null,
        });
      }
    },

    /** Mouse drag and wheel, which only the free orbit view uses. */
    orbit(dx, dy) { cameras.orbit(dx, dy); },
    zoom(delta) { cameras.zoom(delta); },

    respawn: placeAtSpawn,

    dispose() {
      active = false;
      input.dispose();
    },
  };
}
