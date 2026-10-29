/*
  The Monster Truck Madness 2 simulation, as specified in OpenMTM2's docs/MTM2_PHYSICS.md.
  Exported from the package root as the `mtm2Sim` namespace; see docs/SIM_MTM2.md.
*/
export * from "./constants.js";
export * from "./math.js";
export * from "./time.js";
export * from "./world/terrain.js";
export * from "./world/surface.js";
export * from "./world/water.js";
export * from "./world/course.js";
export * from "./world/ground.js";
export * from "./world/road.js";
export * from "./world/wrap.js";
export { CHECKPOINT_TYPE, DETECTOR_WIDTH_SCALE, DETECTOR_HEIGHT_SCALE, SPHERE_PRETEST_FACTOR, buildCheckpoints, withinCheckpointReach, speedThroughCheckpoint, checkpointCrossingTime, pointInCheckpointBox, } from "./world/checkpoints.js";
export * from "./truck/params.js";
export * from "./truck/state.js";
export * from "./truck/controls.js";
export * from "./truck/drivetrain.js";
export { stepTruck, postStepTruck, tireGeometry, probeGround, lateralCoefficient, truckWeight } from "./truck/dynamics.js";
export { solveHullContacts } from "./truck/contacts.js";
export { fluidAreas, hullFaceWaterArea, wheelWaterAreas, SPLASH_SPEED } from "./truck/water-drag.js";
export * from "./truck/recovery.js";
export * from "./truck/damage.js";
export * from "./truck/autopilot.js";
export * from "./truck/traffic.js";
export * from "./collide/box.js";
export { collideTruckBox, collideTruckImmovableBox, truckBoxSeparated } from "./collide/truck-box.js";
export { FACE_DEPTH_FT, collideTruckFace, createFace } from "./collide/truck-face.js";
export { stepBox, postStepBox, boxInertia } from "./collide/box-step.js";
export { stepMovingObject, groundBoxHeightAt } from "./collide/moving-object.js";
export { collideTruckRamp, createRamp, insideRamp, rampEdges, rampHeightAt, rampSlopeNormal } from "./collide/ramp.js";
export { createEdgeState, edgeAgainstTruck, lineDistance } from "./collide/edges.js";
export { collideTruckTopCrush, createTopCrush, crushCorners } from "./collide/top-crush.js";
export { collideTrucks, impactVelocity } from "./collide/truck-truck.js";
export { collideBoxes } from "./collide/box-box.js";
export * from "./race/race.js";
export * from "./race/summit.js";
