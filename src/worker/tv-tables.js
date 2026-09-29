/*
  Name tables for Terminal Velocity / Fury3 enumerations (powerups, logic, weapons).

  Parsing is OpenPhotex's (src/vendor/openphotex, the canonical Terminal Reality format
  library), which carries this module's former implementation and its evidence. Do not add
  format knowledge here; change OpenPhotex and re-vendor it.
*/
export {
  TV_POWERUPS, tvPowerup, TV_LOGIC_NAMES, TV_WEAPON_NAMES, tvLogicName, tvWeaponName,
} from "../vendor/openphotex/index.js";
