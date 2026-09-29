/*
  Name tables for the enumerations a Terminal Velocity / Fury3 level stores only as indices.

  None of these names appear in any level file. They come from the two period editors:

    - TVCAD 1.0 (Matt Tagliaferri, 1995) reads its Logic, Weapons and PowerUps lists from
      TVCAD.INI and indexes them with the same numbers the .DEF and .PUP files carry.
    - FuryEdit.exe holds a 12-entry pointer table of pickup models at 0x5c8a28, followed
      directly by a 12-entry table of Fury3's in-game pickup names at 0x5c8a58.

  The two sources were produced independently and agree slot for slot on the powerups
  (TVCAD's "Shield Restore" is FuryEdit's POWERSHE.BIN / "Shields Restored", and so on), and
  the observed .PUP type values run 0..11, which is exactly the table's length.

  Ported from JSTrackViewer's src/worker/tv-tables.js, the only implementation.
*/
export const TV_POWERUPS = [
    { model: "POWERLAS.BIN", name: "Laser", furyName: "Rapid-Fire Lasers" },
    { model: "POWERPLA.BIN", name: "Plasma", furyName: "ServoKinetic Lasers" },
    { model: "POWERANT.BIN", name: "Ion Burst", furyName: "Dispersion Cannons" },
    { model: "POWERMIS.BIN", name: "Missile", furyName: "Dead-On Missiles" },
    { model: "POWERGMI.BIN", name: "Guided Missile", furyName: "Vipers" },
    { model: "POWERSUP.BIN", name: "Super Missile", furyName: "Bion Fury Missiles" },
    { model: "POWERSHE.BIN", name: "Shield Restore", furyName: "Shields Restored" },
    { model: "POWERVIS.BIN", name: "Invisibility", furyName: "Invisibility" },
    { model: "POWERINV.BIN", name: "Invincibility", furyName: "Invincibility" },
    { model: "POWERFIR.BIN", name: "Smart Bomb", furyName: "FFF" },
    { model: "POWERZAP.BIN", name: "AfterBurner", furyName: "Turbo Thrust" },
    { model: "POWERCAN.BIN", name: "Energy Can", furyName: "Shield Boost" },
];
/** The powerup entry for a type index, or null. -1 is TVCAD's "Random". */
export function tvPowerup(type) {
    return Number.isInteger(type) && type >= 0 && type < TV_POWERUPS.length ? TV_POWERUPS[type] : null;
}
/** Enemy logic names by .DEF header slot 0 (TVCAD.INI [Logic]). */
export const TV_LOGIC_NAMES = [
    "Ground/Static", "Ground/Targeting (Smart)", "Flying (Dumb)", "Ground/Targeting (Dumb)",
    "Flying (Smart)", "Spin Bank for Drill", "Sphere Boss (Smart)", "Flying Attack/Retreat (Smart)",
    "CISHIP Split (Smart)", "Ground/Static/Ruin", "Target Heading (Smart)", "Target Pitch (Smart)",
    "Core Boss (Smart)", "City Boss (Smart)", "Static Firing (Smart)", "Sitting Duck",
    "Tunnel Attack", "Takeoff and Escape", "Falling Asteroid", "C-Nome",
    "C-Nome Legs", "C-Nome Factory", "Geiger Boss", "Volcano Boss",
    "Volcano", "Missile", "Bob", "Alien Boss",
    "Canyon Boss 1", "Canyon Boss 2", "Lava Man", "Arctic Boss",
    "Helicopter", "Tree", "Ceiling/Static", "Bob and Attack",
    "Forward Drive", "Falling Stalag", "Attack/Retreat Below Sky", "Attack/Retreat Above Sky",
    "Bob Above Sky", "Factory",
];
/** Primary weapon names by .DEF body line 1 slot 4 (TVCAD.INI [Weapons]). */
export const TV_WEAPON_NAMES = [
    "Purple Laser", "Plasma", "Antimatter", "Laser Beam", "Fire Ball", "Green Laser",
    "Red Laser", "Blue Laser", "Bullet", "Purple Ball for Mine", "Blue FireBall", "Gold Ball",
    "Atom Weapon", "Purple Ring", "Boss W6", "Boss W7", "Boss W8", "Enemy Missile", "Missile",
];
function nameAt(table, index) {
    return Number.isInteger(index) && index >= 0 && index < table.length ? table[index] : "";
}
export function tvLogicName(index) { return nameAt(TV_LOGIC_NAMES, index); }
export function tvWeaponName(index) { return nameAt(TV_WEAPON_NAMES, index); }
