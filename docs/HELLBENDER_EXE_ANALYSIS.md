# Hellbender: HELLBEND.EXE Analysis, Lineage and Suggested Changes

What the Hellbender executable says about its levels: the units, the underground world and
how it joins the surface, where objects stand, moving terrain, navigation, powerups, tunnels,
cheat codes, and how this program relates to Monster Truck Madness. It builds on
[HELLBENDER_LEVEL_FORMAT_ANALYSIS.md](HELLBENDER_LEVEL_FORMAT_ANALYSIS.md), which decoded the
files from the data alone, and on [TV_GAME_EXE_ANALYSIS.md](TV_GAME_EXE_ANALYSIS.md) for the
Terminal Velocity rules Hellbender inherits or changes.

## Summary

| Topic | Finding | Status in the viewer and its docs |
|---|---|---|
| Engine's own name | "Hellbender: Fury6" (string 1000); new models are `f6*.bin` | n/a |
| Cavern layers | RA2 "chamber ground", RA3 "chamber ceiling", CL1 "chamber texture"; **bias `value - 255`** | Documented and coded as `- 256` |
| CL1 order | Word 0 floor, word 1 ceiling, proven by the two renderers | "Strong reading rather than proven" |
| Openings | A cell with surface height 0 and cavern ceiling at altitude 0 is a hole between the worlds; 79,946 such cells | Floating levels found by a "more than half the map" rule |
| Object height | Stored Y kept, but clamped up to the ground (or cavern floor) and snapped onto a ground box it is inside | Stored Y as is |
| DEF offsets | X and Z offsets applied, **Y offset not**; no flyer lift | Not applied (correct) |
| Vertical proportion | Isotropic: a step is 1/16 of a cell, **4 editor units** | Terrain at 3 units per step, models squashed to 0.75 |
| Moving terrain | `.QKE` ground and box quakes move surface, cavern floor or ceiling cells at run time | Not read |
| Powerups | 31 named types with models | Bare index |
| Tunnels | TV tunnel code still present; no `.TNL` ships; JURASIC's tunnel names a TV level that is not in the archive | Marked as a normal tunnel |
| Cheats | 31 codes, deliberately scrambled spellings; six are dead | n/a |
| Lineage | MTM1 shares about 600 engine functions with Hellbender and carries Hellbender's own registry key | n/a |

---

## 1. The executable

`HELLBEND.EXE`, 1,685,504 bytes, About box "Microsoft Hellbender(TM) 1.01", linked
4 September 1996 by Microsoft linker 3.10 (Visual C++ 4.x) with MFC 4. Analysed with Ghidra 12
(6,590 functions, about 2,000 of them game code below `0x4b0000`; the rest is MFC and the C
runtime). Addresses are virtual addresses (image base `0x400000`). The program is not
incrementally linked, so Ghidra's caller counts are reliable, except for MFC message-map
handlers that have no direct callers.

The shipped executable still contains developer tools: a text-mode model editor ("D. Change
magnification level", "Enter in new magnification"), a keyframe tool reading `keyframe.txt`,
and a `.QKE` writer (section 5). About thirty one-line WM_COMMAND handlers (`0x43be40` to
`0x43c1a0`, command ids from 32788 up), each firing one cheat, are wired in a message map, but
no shipped menu has those ids: a removed debug menu.

---

## 2. Units

| Quantity | Value | Where |
|---|---|---|
| Grid | 128 x 128, wraps (`& 0x7F`) | every sampler |
| Cell | `2^19` world units (`0x80000`) | `0x41ba30`: cell = `(coord & 0x3F80000) >> 19` |
| Height step | `2^15` world units: bytes are stored `<< 7` and sampled `* 256` | loader `0x412c3e`, sampler `0x41adf0` |
| Placement X, Z | sign-extended from 26 bits (`<< 6 >> 6`), so they wrap at 128 cells | DEF loader `0x404f60` |
| Model vertices | `raw * 65536 / magnify` world units, as in TV | `0x473ee0` |

These agree with the existing "16.16, 8 units per cell, half a unit per step" reading. In
editor units (64 per cell), a Hellbender step is **4 units**, twice Terminal Velocity's 2.

The model loader also accepts a record type `0x26` that Terminal Velocity does not have,
handled by `0x46d760` (keyframed models; the keyframe tool writes them).

---

## 3. The level layers (`0x412c3e`)

The loader reads the `.TEX` list (uppercasing every name), the RAW and CLR, then the box and
cavern layers by stem, exactly the eleven files the level-format document found. Its own error
messages name them:

| File | Engine's name | Read as | Notes |
|---|---|---|---|
| `.RAW` | ground altitude | byte `<< 7` | |
| `.CLR` | ground clr | 1 or 2 bytes per cell | **by file size**: 0x4000 bytes means one byte per cell |
| `.RA0` / `.RA1` | ground box layer 0 / 1 | byte `<< 7` | |
| `.CL0` | ground box texture | 6 faces x 1 or 2 bytes | 0x18000 bytes means one byte per face |
| `.RA2` | **chamber ground layer** | `(byte - 255) << 7` | cavern floor |
| `.RA3` | **chamber ceiling layer** | `(byte - 255) << 7` | cavern ceiling |
| `.CL1` | **chamber texture** | 2 x 1 or 2 bytes | 0x8000 bytes means one byte each |
| `.RA4` / `.RA5` | ground box layer 0 / 1 (cavern) | `(byte - 255) << 7` | |
| `.CL2` | ground box texture (cavern) | as `.CL0` | |
| `.LTE` | "Light source shading the world" | | computed at load when absent ("Phew") |

**The bias is 255, not 256.** Every cavern byte becomes `byte - 255` steps, so byte 255 is
altitude 0, the surface datum, and byte 0 is -255. The level-format document measured 256 to
within its +-3 step tolerance; the code settles the exact value. The difference is one step
(4 editor units) on every cavern vertex, cavern box and underground marker.

Variable-width CLR, CL0 and CL1 are worth noting for OpenPhotex: the engine decides by size,
so a one-byte-per-cell file is legal even though no shipped level uses it.

---

## 4. Drawing the two worlds

### 4.1 Samplers

`0x41adf0` (surface, from RAW) and `0x41bda0` (cavern floor, from RA2) use the same
checkerboard triangle split as Terminal Velocity (TV_GAME_EXE_ANALYSIS.md 2.1): the diagonal
changes with the parity of `cx` and `cz`. Every system that needs a height uses these.

### 4.2 Cavern renderers

- **Floor**, `0x418d70`: draws a cell from the four RA2 corners with **CL1 word 0**. It skips
  the cell when RA3 equals RA2 at all four corners (solid rock), which is the viewer's
  hollow-cell mask, and when a cavern ground box fills it.
- **Ceiling**, `0x419230`: the same cell from the four RA3 corners with **CL1 word 1**, wound
  to face down.
- **Dispatcher**, `0x4197e0`: with the camera below altitude 0 it draws the surface (boxes and
  ground) only when an opening flag is set, then the cavern floor and ceiling; above 0, it
  draws the cavern only when an opening flag is set, then the surface.

This turns section 6.4 of the level-format document ("which half of CL1 is which") from a
strong reading into a fact.

### 4.3 Openings between the worlds (`0x41a8c0`)

Each frame the engine scans the 21 x 21 cells around the camera for a cell whose **surface
height is 0 and whose cavern ceiling is also 0** (RA3 byte 255). If it finds one within reach
and on screen, it sets four flags that make the dispatcher draw both worlds and let objects on
the other side stay visible (`0x42f710` hides an object across the 0 plane otherwise).

That is the engine's definition of a hole in the ground. In the shipped levels:

| Levels | Opening cells |
|---|---|
| FLOAT, FLOAT2, ROID, ROID2, ROID3, SHIP | 11,205 to 14,329 each: floating islands, almost all hole |
| JURASIC, JURASIC3, ROID4, KREASH3 | 135 to 639: shafts and pits |
| Every other level | 0 to 63 |
| Total | 79,946 |

Nearly every surface cell at height 0 is an opening (79,946 of 80,002); the other 56 have a
cavern ceiling below 0 under them. Whether the engine still draws a flat surface quad at an opening was not
settled: its triangle routine (`0x4144b0`) has a separate path for an all-zero triangle that
compares against a level altitude rather than skipping it.

---

## 5. Moving terrain: `.QKE` (`0x410260`, `0x411530`, `0x411b80`, `0x410ec0`)

Hellbender's `.QKE` is not Terminal Velocity's screen-shake table. It is a script of
**ground quakes** and **box quakes**. The editor's writer (`0x410260`) gives the layout:

```
-------- Ground Quake Count -------
<n>
------- Ground Quake Entry <i>-------
x, z                      the cell
5 ints, 4 ints, 5 ints, 4 ints    limits, speeds, timers, mode bytes (see below)
5 sound names or NULL     start, stop, at-top, at-bottom, loop
!--Additional quake info--
-------- Box Quake Count --------
... same, for a ground box cell ...
@--Box quake switch info--
...                       the box (watchBox) whose state triggers it
```

At run time a ground quake is a small state machine on one cell (`0x411530`): it moves the
cell's height between an upper and a lower limit at a set speed, waits, reverses, plays its
sounds, and either loops, stops, or stops after a count. The **layer** field picks what moves:
1 the surface (RAW), 2 the cavern floor (RA2), 3 the cavern ceiling (RA3). Box quakes do the
same to ground boxes and can be chained to a switch box (`processBoxQuake: no match for
watchBox found`). These are Hellbender's doors, lifts, crushers ("You have been crushed") and
collapsing floors.

The individual integer fields were not all named; the cell, layer, limits and loop behaviour
are certain.

---

## 6. Objects

### 6.1 The DEF header

Same scan as Terminal Velocity into a 0x298-byte record: slot 0 logic (`+0x0C`), slot 1
`+0x1C`, slot 2 hit radius (`+0x08`), slots 3 to 5 X, Y, Z offsets (`+0x10` to `+0x18`).
The hit radius is again overwritten at load by the simple model's AABB corner radius
(`0x404d40`).

### 6.2 Where a placement ends up (`0x404f60`, `0x404e90`, `0x41c300`)

Unlike Terminal Velocity, Hellbender keeps the stored Y and corrects it:

1. X and Z are sign-extended from 26 bits.
2. If Y is negative (the underground), the floor is the cavern floor (`0x41bda0`); otherwise
   it is the surface (`0x41adf0`).
3. If Y is below that floor, Y becomes the floor.
4. Otherwise, if Y lies inside a ground box of that world (between RA0 and RA1, or RA4 and
   RA5, for the cell), Y becomes the box top (`0x41c300`, which on a cell edge picks the
   neighbour with the taller box).
5. The DEF **X and Z** offsets are added. The **Y offset is not**, and there is no half-radius
   lift for flyers.
6. Strength x1.5 at difficulty 2, x2 at difficulty 3.

### 6.3 Powerups: 31 types (`0x502288` models, `0x502308` names)

Two parallel tables, which settle the "bare index" left in TV_F3_LEVEL_FORMAT_ANALYSIS.md
10.4 for Hellbender `.PUP` files and DEF drop types:

| Type | Name | Model |
|---|---|---|
| 0 | Rapid-Fire Lasers | `f6rfl.bin` |
| 1 | ServoKinetic Lasers (Not used) | `powerpla.bin` |
| 2 | Dispersion Cannon 14 | `f6dc.bin` |
| 3 | Dead-On Missiles | `f6dom.bin` |
| 4 | Vipers | `f6vip.bin` |
| 5 | Bion Fury Missiles (Not used) | `powersup.bin` |
| 6 | Shield Restore (not used) | `powershe.bin` |
| 7 | Cloak (Multi only) | `powervis.bin` |
| 8 | Invincibility | `powerinv.bin` |
| 9 | Guided MIRV | `f6gmv.bin` |
| 10 | Turbo Thrust (Not used) | `powerzap.bin` |
| 11 | Energy Can (Not used) | `powercan.bin` |
| 12 | Cruise | `f6cru.bin` |
| 13 | Cluster | `f6cls.bin` |
| 14 | MIRV | `f6mirv.bin` |
| 15 | MINE | `f6mine.bin` |
| 16, 17, 18 | Damage 25%, 50%, 100% | `f6dam1..3.bin` |
| 19, 20, 21 | Energy 25%, 50%, 100% | `f6eng1..3.bin` |
| 22 | Message Pod | `powercan.bin` |
| 23 to 30 | Super Weapon Piece 1 to 8 | `f6swep.bin` |

Types 0 to 11 keep Fury3's order and pickup models (the "(Not used)" notes are the
developers'); 12 and above are Hellbender's. Collecting all eight Super Weapon Pieces (each
sets one bit) unlocks the super weapon. The Message Pod is tied to a type 13 navigation point
("processPowerup: no nav point for message pod").

The in-game weapon names differ from these table names (string 2000: Valkyrie Cannon,
Sledgehammer Rockets, Scorcher, Legion, Independence and Hellion Missiles); the table is the
editor's vocabulary.

### 6.4 Navigation (`0x470bd0`)

The loader confirms the type list in the level-format document from code, with three
additions:

- Valid types are 0 to 14; anything else is "Bad nav type!". Types 10 (a pitch, bank, heading
  triple plus one value) and 11 (a random value) exist in the engine but in no shipped level.
- If no type 9 entry is present, one is appended: type 9 is the route terminator.
- **The engine inserts the type 7 sync points itself** ("Sync point: auto added"): after every
  type 4 (tunnel exit) and before every type 1, 3 or 4, unless one is already there. At most
  49 entries.

---

## 7. Tunnels

The Terminal Velocity tunnel engine is still in the program (`TUNNEL%d.RAW`, "Unable to open
tunnel list", `0x45cce0` to `0x4624c0`), but Hellbender ships no `.TNL` file at all, and
JURASIC's `.TDF` names `artic-t1.lvl`, a Terminal Velocity tunnel level that is not in
Hellbender's `GAME.POD`. Its two tunnels are leftovers copied with Terminal Velocity data:
the underground is Hellbender's replacement for tunnels, not an addition to them.

---

## 8. Cheat codes

Typed during a single-player game. Input is uppercased, matched letter by letter against a
31-entry table at `0x500d68`; seven letters fire the code (`0x40e600`, effects `0x40e3e0`,
pickups `0x427090`). The spellings are scrambled on purpose: the warp and weapon codes are
the same pattern shifted one letter per code.

| Code | Effect |
|---|---|
| `SUGUSND` | Invincibility on/off |
| `NCAQJAP` | Shields restored |
| `KPWYAJK` | Complete the mission |
| `VXUTZPP`, `WXSVSRN`, `XIVXNST`, `AYLDCED` | Nothing: the TV/Fury3 hover, ammo, oscilloscope and turbo slots, emptied |
| `MZJWPUT` | Frame counter on/off |
| `QVZFYCD` | Every weapon ("Watusi!") |
| `JEYFRA1`, `KFZGSB2`, `LGAHTC3`, `MHBIUD4`, `NICJVE5`, `OJDKWF6`, `PKELXG7`, `QLFMYH8` | Warp to mission 1 to 8 (looked up in the mission list) |
| `NGKGDP9` | Nothing (the slot that was Fury3's "Gotcha!") |
| `MKXZWA1` | Dispersion Cannon |
| `NLYAXB2` | Nothing (item 2 has no case) |
| `OMZBYC3` | Rapid-Fire Lasers |
| `PNACZD4` | Dead-On Missiles |
| `QOBDAE5` | Cruise missiles |
| `RPCEBF6` | Vipers |
| `SQDFCG7` | Cluster missiles |
| `TREGDH8` | MIRV |
| `USFHEI9` | Guided MIRV |
| `VTGIFJ0` | Mines |
| `HUIIPS5` | Nothing |
| `XVFMVVR` | All eight Super Weapon Pieces: the super weapon at once |
| `XTZSXFR` | Energy 100% |

The table keeps Fury3's slot order (invincible, shields, skip, hover, ammo, scope, turbo,
frame counter, all weapons, warps, decoy, ten pickups), which is itself evidence of the
lineage in section 9.

---

## 9. Lineage: Hellbender, Fury3 and Monster Truck Madness

**Question:** does Hellbender come from Monster Truck Madness 1's code, or the reverse?

**Answer:** neither game's *game* code comes from the other. Both are built on one shared
1996 Terminal Reality Windows engine, and that engine belongs to the Terminal Velocity /
Fury3 / Hellbender line. MTM1 took it from Hellbender's tree, not the other way round.

### 9.1 What is shared

Normalising every decompiled function (addresses, names and variable names blanked) and
comparing:

| Pair | Identical game functions |
|---|---|
| Hellbender / MTM1 | **603** of Hellbender's 2,021 |
| Hellbender / Fury3 | 14 (Fury3 was built with a 1995 compiler, so identical source compiles differently) |
| Hellbender / MTM2 | fewer than with MTM1 |

Of the 457 pairs that match uniquely, **430 keep the same order** in both executables: the
same source files, linked in the same order. They sit in MTM1's `0x400000-0x42ffff` and
`0x480000-0x4dffff`; MTM1's truck simulation (`0x446cd0-0x489000`, documented in OpenMTM2's
`MTM1_MONSTER_EXE_ANALYSIS.md`) is not among them.

What the shared functions do, from the strings they use: the Direct3D execute-buffer
renderer and DirectDraw page flipping, 3D windows and matrix stack ("Matrix unbalance", "Too
many 3D windows"), the object manager ("FATAL! Too many objects!"), the POD file system ("Too
many .POD files at once!"), the MRGL `.BIN` model loader ("Bad MRGL type", "Out of partial
model mem"), VGA palette, fog and light tables, texture cache, wave sound, title, help and
epilogue screens ("Level Complete", "Winner!"), the "Terminal Video Interface" AVI and SMK
player, and the DirectPlay layer.

### 9.2 Which way it went

| Evidence | Points to |
|---|---|
| MTM1 opens `Software\Microsoft\Hellbender\Services` for its DirectPlay service providers (`0x4de780`, `0x4de950`, `0x4df360` in MTM1) | MTM1's network setup was copied from Hellbender and the key never renamed |
| The DirectPlay send routine is `WriteTVPacket` in both | The network layer was written for the TV/Fury line |
| MTM1 plays `fury.avi`, draws over `vel2.raw` and keeps the flight keys (`leftKey` ... `rollRightKey`) | MTM1 carries Fury3 and TV leftovers |
| MTM1 has "Level Complete" and the mission title, help and epilogue screens | A racing game carrying a mission shooter's screens |
| Hellbender has no truck, race, lap or Monster string at all | Nothing flowed from MTM1 into Hellbender |
| Ground boxes (`.RA0/.RA1/.CL0`) appear in both; Hellbender alone adds the chamber layers | The box layer is part of the shared 1996 engine; the cavern is Hellbender's own |
| Link dates: MTM1 9 August 1996, Hellbender 4 September 1996 | Hellbender shipped later, but its code was in development since Fury3 (1995) as "Fury6" |

So the chain is Terminal Velocity (DOS, June 1995) -> Fury3, "CyberUI" (Windows, August 1995)
-> the 1996 Direct3D engine developed for Hellbender ("Fury6") -> branched for MTM1 (and later
CART Precision Racing and MTM2, whose OpenMTM2 analyses already show MTM1's simulation carried
into MTM2). The ship games and the truck games share the engine layer; each keeps its own
game layer: Fury3's flight, enemy logic and `.NAV`/`.DEF` for Hellbender, a new truck
simulation and `.SIT` tracks for MTM1.

### 9.3 Codenames left in the programs

| Game | Internal name | Evidence |
|---|---|---|
| Terminal Velocity | (none found; "Velocity Brawl" appears nowhere) | Demo file `cyberdem.vox` |
| Fury3 | CyberUI | Version resource `InternalName CYBERUI`, MFC document class "CyberUI Document" |
| Hellbender | Fury6, Maximum Velocity | Default network session name "Hellbender: Fury6" (UTF-16 resource); `F6*` pickup models and textures; debug path `C:\max\MAX\test\hellbend.pdb`; the unused `ART\TITLE.RAW` in `STARTUP.POD` reads "Maximum Velocity (c) 1995-96" |
| MTM1 | Metal Crush | Its own `TITLE.RAW` reads "METAL CRUSH: The Game"; strings "Metal Crush 0.50" and "Metal Crush (C) 1995"; debug path `D:\METAL\CRUSH\test\monster.pdb` |
| MTM2 | Metal Crush 2 | Source paths `D:\METAL\CRUSH2\...`; the shared palette name `METALCR2.ACT` |
| CPR | Indy | Source paths `D:\INDY\INDY\...` |

`HELLBEND.EXE` never loads `title.raw`: the string is not in the program, and its full-screen
image loader (`0x499fb0`) is fed only `vel2.raw` and `planet.raw` (`0x45bc30`, `0x45bc70`). The
"Maximum Velocity" title is a leftover of the stage between Fury3 and Hellbender.

**Photex and Terrain** (the "Photex2 / Terrain5" of MTM2's marketing) name no module in any of
these programs. The source paths that CPR and MTM2 leave behind show one tree, `cockpit`,
`core`, `engine`, `mfc`, `mfccore`, `support`, `wincore`, whose `engine` folder holds generic
modules (`2d.c`, `3d.c`, `clipper.c`, `model.c`, `texture.cpp`, and a leftover `boss.c`), with
terrain in `core\Ground.c`. The names are brand names for the continuous engine line above;
the binaries cannot confirm where each version number starts.

---

## 10. Suggested changes

**Status.** Applied:

- **JSTrackViewer:** items 1 to 9, and item 10's pointers. Item 6 names the pickups and the DEF
  drop types; the `F6*.BIN` models still only load when the open archive carries them (they
  ship in `STARTUP.POD`). Item 7 marks the quakes rather than animating them.
- **OpenPhotex:** all of 10.3 (`HB_UNDERGROUND_BIAS` -255, narrow `.CLR`/`.CL0`/`.CL1`,
  `HB_POWERUPS`, `parseHbQuakes`), plus `autoAdded` and the type 10/11 names on Hellbender
  `.NAV` points.
- **OpenMTM2:** the height step and checkerboard ground sampling from 10.2, and the lineage note.
  Openings, ground boxes, objectives and moving terrain there are not built yet, since
  OpenMTM2 does not load Hellbender's cavern or objects today.

### 10.1 JSTrackViewer

1. **Cavern bias 255.** Change the cavern altitude from `byte - 256` to `byte - 255` for RA2,
   RA3, RA4 and RA5 (the constant comes from OpenPhotex, 10.3). Everything underground moves
   up one step.
2. **True vertical scale for Hellbender.** Today the terrain is forced to 3 units per step
   (`effectiveTerrainHeightScale` in [track-loader.js](../src/worker/track-loader.js)) and
   models are squashed to 0.75 (`modelZStretch` in [scene.js](../src/scene.js)). The engine is
   isotropic at 4 units per step: use 4 and no stretch. Terrain, cavern, boxes and models then
   keep their real proportions, the same principle the TV path already follows for models.
3. **Openings by the engine's rule.** Replace the "more than half the map is at zero" test in
   `buildHbSurfaceMask` ([hb-underground.js](../src/worker/hb-underground.js)) with the
   per-cell rule: a cell is an opening when its surface is 0 and its cavern ceiling byte is
   255. That keeps FLOAT, ROID and SHIP as they are and also opens the shafts in JURASIC,
   JURASIC3, ROID4 and KREASH3, which the current rule leaves covered. Cut the cavern
   ceiling at the same cells, since there the ceiling is the hole's bottom edge.
4. **Object heights.** Apply 6.2: clamp each placement up to its world's floor and onto a
   ground box it sits inside. Do not add the DEF Y offset (already the case).
5. **Checkerboard split** for the surface and the cavern meshes, and the same triangle rule
   in the marker sampler.
6. **Powerup names and models** from 6.3 for `.PUP` markers and DEF drop types; load the
   `f6*.bin` pickups from `STARTUP.POD` when present.
7. **`.QKE` moving terrain (optional).** Show quake cells as markers ("door", "lift") with
   their range, or animate them under the existing Animate toggle by moving the affected
   vertices between the two limits.
8. **Tunnels.** Label JURASIC's and JURASIC3's `.TDF` tunnels as leading to a missing level
   (`artic-t1.lvl`, not in the archive) rather than drawing them as live tunnels.
9. **Navigation.** Mark type 7 entries as engine-inserted where they follow the insertion
   rule, and accept types 10 and 11.
10. **Docs.** HELLBENDER_LEVEL_FORMAT_ANALYSIS.md 6.2 (bias), 6.4 (CL1 now proven), 2.2
    (types 10, 11 and the auto sync points) and 7 (`.QKE` is now read) can point here.

### 10.2 OpenMTM2

- **Height step.** `docs/CHANGELOG.md` uses 1.5 ft per step for Hellbender at 32 ft per cell.
  The engine's step is 1/16 of a cell: **2 ft**. Hellbender hills are drawn at 75% of their
  height today.
- **Cavern bias** 255 (through OpenPhotex).
- **Openings**: the per-cell rule above, for both drawing and ground contact (a truck can
  fall through an opening into the cavern, as the player's ship flies through).
- **Ground contact** with the checkerboard samplers `0x41adf0` / `0x41bda0`, and on ground
  boxes as in `0x41c300`.
- **Objectives as checkpoints**, listed as needing the executable: the `.NAV` route with the
  engine's sync points and terminator (6.4) is the order; types 2 (checkpoint), 3 (jump
  zone) and 9 (end) are the useful ones for a race.
- **Moving terrain** from `.QKE`, later, as obstacles.
- **Lineage note** for `MTM1_MONSTER_EXE_ANALYSIS.md`: the non-simulation half of MTM1 is
  Hellbender's engine (section 9), which explains its flight keys, `vel2.raw` and `fury.avi`.

### 10.3 OpenPhotex

- `HB_UNDERGROUND_BIAS` in `src/terrain/hb-underground.ts` is `-256`; the engine uses
  **`-255`**. Its comment ("biased down by a full byte") should say "byte 255 is altitude 0".
- Size-dependent CLR, CL0 and CL1 widths (section 3), so a one-byte-per-cell file reads.
- A Hellbender powerup table (`HB_POWERUPS`, section 6.3) next to `TV_POWERUPS`.
- A `.QKE` reader for Hellbender's ground and box quakes (it is in the "not covered" list).
- The opening rule is engine behaviour on top of the data; per the project rule that
  OpenPhotex stays neutral, it belongs in the consumers, not in OpenPhotex.

---

## 11. Method

Ghidra 12 headless with OpenMTM2's `FindFuncs.java` and `ExportAll.java`, in a temporary
workspace outside every repository. The decompiled output is not published; only facts,
layouts and constants are recorded. The HB / MTM1 comparison normalised each decompiled
function and compared hashes against OpenMTM2's existing MTM1, MTM2 and the new Fury3 exports.
Shipped-data counts (openings, tunnels) were taken from `GAME.POD` through OpenPhotex.
