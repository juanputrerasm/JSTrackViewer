# Monster Truck Madness Beta 2 (Build #41): MONSTER.EXE Against the Retail 1.00

What the June 1996 beta of Monster Truck Madness shows about the game seven weeks before it
shipped: what was missing, what changed, what was taken out, and what the beta's own data files
say. It is a companion to OpenMTM2's `docs/MTM1_MONSTER_EXE_ANALYSIS.md`, the survey of the
retail executable (1.00.63, 9 August 1996), and does not repeat it: where the beta does what
retail does, this document says so and points there. Retail addresses below are the ones that
document uses.

## Summary

| Topic | Beta 2, Build #41 | Retail 1.00 |
|---|---|---|
| Built | 21 June 1996 | 9 August 1996 |
| Name in the version resource | "Monster Truck Simulator", internal name **MetalCrush**, original file name **HMETAL.EXE** | "Microsoft(R) Monster Truck Madness(TM)", `monster.exe` |
| Time limit | **Refuses to start after 31 August 1996** ("Beta has expired. Please go out and buy the game.") | None |
| Cheat words | **None.** No GOLD, FRAME, DANCE or TREX | Four typed words |
| Debug keys | Ctrl+Y slew and Ctrl+T autopilot work **without any cheat**; Ctrl+B shows hidden checkpoints; Ctrl+Q toggles music | Ctrl+Y and Ctrl+T need GOLD; Ctrl+B and Ctrl+Q gone |
| T-Rex | Model named `TSAURUS.BIN`, used only as a statue in A Crazy Eight | Renamed `REX.BIN`; the TREX cheat drives it |
| Pterodactyl | Not in the data | `TERYL.BIN` added |
| Drag racing AI | One time for every strip, by skill level: 5.75, 5.25 or 4.75 s plus up to 1 s | Per-strip par time from the SIT, +-0.5 s |
| "Sonic" tracks | Do not exist | `CIRC1.SIT` boosts Professional computer trucks |
| Computer truck torque | **x0.9** (computer trucks always auto shift, and auto shift costs 10%) | Full; only a human on auto shift pays the 10% |
| End of a circuit | First finisher starts a **60 s countdown** ("Final lap - race ends in 60 seconds") | Everyone finishes; online, "All trucks on final lap!" |
| Attract mode | A **random** circuit, rally and drag track | Always `CIRC5`, `DEMO`, `DRAG5` |
| Driving assistance | Three boxes: Auto Brake, Auto Shift, Auto Throttle | "Brake & Throttle" list plus Auto Shift |
| Wheel calibration, Direct3D capability check, MMX, filtering | Absent | Added |
| Driver and Hall of Fame files | `driver.reg`, `highscor.reg` | `driver.mtr`, `highscor.mtr` |
| Registry | Only Hellbender's DirectPlay key | Adds `SOFTWARE\Microsoft\Monster Truck Madness\1.0` (Product ID, organization) |
| Licensing | "Blimp" | "Goodyear Blimp" |
| Code | 7,861 functions; 1,301 of them identical or nearly identical in retail | 8,201 functions |

---

## 1. The two builds

| | Beta | Retail |
|---|---|---|
| Folder | `~/Downloads/mtm_beta` (`MONSTER.EXE`, `MONSTER.HLP`, `SMACKW32.DLL`, `SYSTEM\`) | `~/games/mtm1` |
| File | `MONSTER.EXE`, 1,738,752 bytes, MD5 `4152f83c10254ebd5fa05005f0e10d0e` | 3,109,888 bytes, MD5 `aad423d05b1890c8e0b1854125df3323` |
| PE timestamp | 835380612 = **21 June 1996, 18:10 UTC** | 839608620 = 9 August 1996, 16:37 UTC |
| About box | "Monster Truck Madness Beta 2, Build #41", "This product is registered to: <Name>", an "About TRI" button | "Version 1.00.63", Product ID, credits |
| Version resource | FileVersion "1, 0, 0, 1"; CompanyName "Microsoft"; FileDescription "Monster Truck Simulator"; InternalName "MetalCrush"; OriginalFilename "HMETAL.EXE"; copyright "Microsoft, Inc. Portions Copyright 1995-1996, Terminal Reality, Inc." | FileVersion "1.00"; "Microsoft Corporation" |
| Toolchain | MSVC 4.x, linker 3.10, MFC 4 statically linked, not incrementally linked | the same |
| Debug path | `D:\METAL\CRUSH\test\monster.pdb` | the same |
| Imports | the same eleven DLLs; USER32 177 functions, GDI32 111 | USER32 178, GDI32 110 |

| Section | Beta VA, size | Retail VA, size |
|---|---|---|
| `.text` | 0x401000, 0x115ff9 | 0x401000, 0x11e58f |
| `.rdata` | 0x517000, 0x1c440 | 0x520000, 0x1dc68 |
| `.data` | 0x534000, 0x40d76c | 0x53e000, 0x44fa5c |
| `.rsrc` | 0x946000, 0x30764 | 0x992000, 0x172c0c |

The executables differ in size mostly through the resources: retail's are 1.5 MB against 195 KB,
for its bitmaps (`credits.bmp`, the larger About box and the new buttons). The code grew by 34 KB.

**Which "beta" is this.** The retail executable still carries an old About box (its dialog 100)
reading "Monster Truck Madness **Beta 3, Build #46**". This one is **Beta 2, Build #41**, an
earlier drop. The archive comment of its `GAME.POD` agrees: **"The Game #41 B2"**, where retail's
reads "The Game (this time for sure)".

**Its name.** The version resource gives three names at once: the product, "Monster Truck
Madness"; the description, "Monster Truck Simulator"; and Terminal Reality's own, the internal
name "MetalCrush" and the file name **`HMETAL.EXE`**, "Heavy Metal", the name that survives in
both builds' dialog titles "Heavy Metal Truck Editor" and "Heavy Metal Truck Event Setup".

### Method

The beta was analysed with OpenMTM2's reverse-engineering tools (`tools/re/`), to which a
`mtm1beta` target was added: `MTM1BETA_DIR=~/Downloads/mtm_beta tools/re/decompile.sh mtm1beta`
builds the git-ignored workspace `re/mtm1beta/`. Ghidra 12 with `FindFuncs.java` finds 7,861
functions. `MATCH=mtm1beta:mtm1 tools/re/match.py 401000 4d4f20 401000 4dd2a0` pairs the game
code of the two builds (game code ends at `0x4d4f20` in the beta, `0x4dd2a0` in retail), and
`FDIFF=mtm1beta:mtm1 tools/re/fdiff.py` diffs a pair. Resources come from `rsrc.py`, the PODs from
OpenPhotex. As with every analysis in this series, the decompiled code is never published;
only facts, addresses and constants are recorded.

| Pairing result | Functions |
|---|---|
| Identical (similarity 1.00) | 827 |
| Nearly identical (0.90 to 0.99) | 474 |
| Changed (below 0.90) | 688 |
| Only in the beta | 88 |
| Only in retail | 233 |

Most of the "changed" and "only in" functions are the same functions with a shifted constant
table or a different inlining choice; the ones that differ in what they do are below. Where the
matcher failed to pair two functions that are plainly the same (the attract-mode timer, for
one), the pair was found by hand.

---

## 2. The time bomb (`0x40bc60`)

The start-up routine `0x40bc60` (called from the application's start `0x48b260`), after setting up
every subsystem and before loading the palette `metalcr2.act` and light table `metalcr2.lte`,
reads the clock:

- it takes `localtime()` of the current time;
- it tries to open a file with `fopen(name, "rb")`, and if that file exists it **sets the year to
  99**, which counts as expired;
- it then requires **`tm_year == 96` and `tm_mon <= 7`**. `tm_mon` counts from 0, so 7 is
  August.

Otherwise it shows **"Beta has expired.  Please go out and buy the game."**, shuts the sound,
video and input down and calls `ExitProcess(1)`.

So the beta runs from 1 January to **31 August 1996** and on no other date. The test is the two
jumps at `0x40bc1a` and `0x40bc23`. The file name passed to `fopen` is an uninitialised stack
buffer: whatever "kill file" the check once looked for, the code that named it is gone, and in
practice the open fails. A second copy of the whole test, `0x40bbc0`, has no caller.

Retail has neither the check nor the message.

---

## 3. Cheats and debug keys

### 3.1 No cheat words

Retail's `0x42f900` keeps the last eight keys typed and recognises GOLD, FRAME, DANCE and TREX.
**The beta has no such routine**: no key buffer, no cheat word, no `chkclick.wav` feedback (the one
`chkclick.wav` in the beta, `0x43e6d0`, is the menu's check-box click). With it, three features are
missing altogether:

- **FRAME**, the frame-rate counter in the corner, and **DANCE**, the mixer oscilloscope: the
  on-screen overlay routine (beta `0x417650`, retail `0x418d40`) has neither the `sprintf` of the
  rate nor the call to the oscilloscope;
- **TREX**: there is no `REX.BIN` and no code that swaps the player's body.

### 3.2 The debug keys are open

The in-race key handler (beta `0x42d4a0`, retail `0x42fb40`) reads the same key-state table
(beta `0x7a06a0`, retail `0x7ea4a0`, indexed by scan code). In the beta:

| Key | Beta | Retail |
|---|---|---|
| Ctrl+Y | slew mode, **always available** | needs GOLD (`0x548300`) |
| Ctrl+T | cycles `controlflag` (`0x7f0638`) 0 to 3, up to the full autopilot (in `0x42c720`), **always available** | needs GOLD |
| Z | Z mode: the technical overlay and the physics line | the same |
| Ctrl+L, Ctrl+S in Z mode | load and save a situation | the same |
| **Ctrl+Q** | toggles music (`musicFlag`) | removed |
| **Ctrl+B** | toggles the drawing of **hidden checkpoints**, the type 6 boxes whose model's fourth letter is `O` (`CKBOX`, `CKBOXN`) | removed; the flag (`0x5482c0`) is still tested when drawing but nothing sets it |

So in the beta anyone can fly the camera and let the autopilot drive; retail locked those
behind GOLD, and the checkpoint switch that MTM2 still tests (`MONSTER_EXE_ANALYSIS.md`, "Which
boxes are drawn") was last reachable here.

---

## 4. Racing rules that changed

### 4.1 Drag racing: no par times yet

Retail draws a computer entrant's drag time as `PAR + rand()/32768 - 0.5`, where `PAR` is the
strip's par time held in the SIT's "Track Fly-By .AVI file" line (retail section 2.5 and 5.7).
In the beta's SITs that line reads "Track" on every strip, and the qualifying routine
(`0x4b5ed0`) and the Skip routine (`0x4b7db0`) use instead:

    time = BASE + rand() / 32767,   BASE = 5.75 (skill 0), 5.25 (skill 1), 4.75 (skill 2)

with the skill level `0x53e0cc` (saved as "Player Skill Level"). The draw spans a full second
above the base, not half a second either side. Everything else in the event (the 33.33 s
maximum, the qualifying points 100, 90, 80, 70, 60, the bracket) is as in retail.

One base for every strip did not survive the data: retail's par times run from 3.67 s
(`DRAG3`) to 12.43 s (`DRAG5`). In the beta, a computer truck on `DRAG4` or `DRAG5` would post a
time of about 5 s on a strip a human needs 11 or 12 s for. Moving the par time into each SIT,
by reusing the unused fly-by line, was the fix.

The beta also has a drag results "pyramid": dialog 219, "Drag Race Results (All Rounds)", draws
the whole bracket (eight names, semi-finals, finals, "Champion"), and dialog 220, "Drag Race
Results", has a **View Pyramid** button. Retail dropped both for its bracket screen.

### 4.2 No "Sonic" tracks

The string "Sonic" is not in the beta, and `CIRC1.SIT` has "Track" where retail has "Sonic". The
three places where retail uses the Sonic flag `0x54830c` do not exist:

- **the computer's cornering speed** (beta `0x45c2d0`, retail `0x45fee0`): the beta multiplies by
  one constant, **23.326**, which is `0.725 x 32.174`; retail splits it into a factor `0x547898`
  (0.725, or **0.75** on a Sonic track) times gravity 32.174. The result off a Sonic track is
  the same;
- **the course follower** (beta `0x457a50`, retail `0x45b5d0`): retail's extra 1.25 for
  Professional on a Sonic track is absent;
- **engine torque** (section 4.3).

### 4.3 Computer trucks are 10% weaker

In the engine routine (beta `0x45408b`, retail `0x457afb`), after the torque curve:

| | Beta | Retail |
|---|---|---|
| Truck on auto shift (`+0xfb0`) | torque **x0.9** | torque x0.9 only if it is also a human's truck (`+0x113c`) |
| Computer truck, Professional, Sonic track | | torque **x1.1** |

The beta's race set-ups (`0x42350f`, `0x423a00`, `0x423a1f`) give every computer truck auto
shift (`+0xfb0 = 1`, `+0x113c = 0`), so every computer truck in the beta runs on 90% of its
engine. A human on auto shift pays the same 10% in both builds. Retail exempts them, which makes its
computer trucks about 11% stronger than the beta's on every track.

### 4.4 The end of a circuit race

When the leader completes the last lap:

- **Beta** (`0x417400`): a countdown starts, `0x3c0000` in 16.16 fixed point, **60 seconds**
  (10 seconds when `0x7e9f0c` is below 2, not traced further), announced as **"Final lap - race
  ends in 60 seconds"**, and the race ends when it runs out, whoever has not finished.
- **Retail** (`0x4189b0`): no countdown. Every truck's lap target is set. In single player each
  truck must cover the full distance; in a network race each one only finishes the lap it is on,
  and string 20014 announces **"All trucks on final lap!"**.

### 4.5 Attract mode

The idle timer is the same in both (beta `0x497390`, retail `0x49b810`): it plays `opening.smk`,
then runs state 5000 with a counter cycling 0, 1, 2. What the counter picks differs:

- **Beta** (`0x4229d0`): it scans the track catalogue (race type at `0x5aabe0`, entries 0x114
  bytes) and picks **a random circuit (2), then a random rally (3), then a random drag strip (1)**.
- **Retail** (`0x424640`): always `circ5.sit`, `demo.sit` and `drag5.sit`.

### 4.6 Smaller rule changes

- **Tournament saves.** The retail saved game adds a "-- Tournament Name --" line (retail
  `0x44604f`, beta `0x442f60`), with "Unknown Tournament" (string 20301) as a fallback. The beta
  tournament editor has a "Save Changes" prompt (dialog 7301) retail dropped.
- **Disqualification.** Retail adds the "Drag Results (Disqualified)" dialog 7302, "Both trucks
  have disqualified. Prepare to rerun the race."
- **Cancel Race** (dialog 253, "There is a game in progress. Cancelling now will end the
  game.") is beta only.

---

## 5. Options, hardware and start-up

### 5.1 Driving assistance

The Game Options dialog differs most:

| Beta | Retail |
|---|---|
| Check boxes **Auto Brake**, **Auto Shift**, **Auto Throttle** | a list "Brake & Throttle" (strings "Auto Brake", "Auto Brake & Throttle") and the Auto Shift box |

So in the beta auto throttle could be had without auto brake; retail offers only brake, or brake
and throttle together.

### 5.2 Graphics

Retail adds a **Smoothing** box (id 4115, the INI's `filterFlag`), `useMMXFlag`,
`maxD3DTextures` and `dontWarnDesktopSize`. The beta's INI still writes `antialiasFlag` and
`blendFlag`, which retail no longer has.

Direct3D handling grew into a set of checks:

- the beta has one message, "Unable to detect 3D hardware accelerator." (`0x404d30`);
- retail checks the device's capabilities and lists what is missing ("Your 3D adapter does not
  support these required Direct3D features: Disable triangle culling, Vertex fog, Flat shading
  model, Gouraud shading model, Flat shaded fog, Gouraud shaded fog, Perspective correction",
  retail `0x428ad0`), refuses high-resolution textures with a hardware accelerator (string 40017),
  checks the desktop is at least 640 x 480 (40007) and adds a "3D Adapter Error" box (40012);
- the beta's renderer has its own texture-surface errors ("Cannot create texture surface",
  "Cannot create enough texture buffers", "Cannot get a texture handle", "Could not clear
  screen") that retail removed.

### 5.3 Controls

- **Wheel calibration** is retail only: "Monster Calibration", "Center your driving controls.",
  "Turn your wheel all the way to the left and right.", "Press the gas.", "Press the brake.",
  and `joyGetPosEx` through `winmm.dll` (retail `0x4cb4c1`). The beta has only the older
  "Cannot detect throttle. Turning throttle off." message.
- **Key list** (string 20400): the beta's "Camera" became **"Next Truck"**, "Look Forward"
  became **"Mirror/Look Forward"**, and retail adds **"Next CD Track"** and **"Previous CD
  Track"** (`keyNextCDTrack`, `keyPrevCDTrack`).
- **Sound**: retail adds "Mono (faster)" and "Stereo (slower)" and the message "Too many
  continuous sound effects".

### 5.4 Files, registry, fonts, messages

| | Beta | Retail |
|---|---|---|
| Driver list | `driver.reg` | `driver.mtr` |
| Hall of Fame | `highscor.reg` | `highscor.mtr` |
| Registry | none of its own | `SOFTWARE\Microsoft\Monster Truck Madness\1.0`, values `ProductID`, `Organization` (About box, `0x408510`) |
| Web page (string 900) | `www.microsoft.com/games/` | `www.microsoft.com/games/monster/` |
| Fonts | "Zurich BT", "Comic Sans MS", "Comic Sans MS Bold" named in code | the font names moved to the string table (20500 to 20504: Comic Sans MS, its bold, Arial, its bold and bold italic) |
| Error messages | a few, in code, such as "Unable to write .INF" and a Windows for Workgroups swap-file hint | eleven new string-table messages (40007 to 40017): Adobe Type Manager, CD-ROM, save failures, invalid replay file. 40009 still ends "*** This error is hard-coded into Winmod.c ***", a source file name |

Both builds still open Hellbender's `Software\Microsoft\Hellbender\Services` for DirectPlay and
still print "Metal Crush (C) 1995 Terminal Reality Inc." on exit (beta `0x40bdf0`, retail
`0x40d3d0`).

### 5.5 Menus

The two menus are the same commands. Retail adds keyboard accelerators to every View and Help
item ("&Cockpit", "Chase &1"), and in the in-race menu renames "Chase 1" and "Chase 2" to
**"Chase (near)"** and **"Chase (far)"** and "Blimp" to **"Goodyear Blimp"** (the replay camera's
"Blimp of %s" likewise became "Goodyear Blimp of %s"). Nearly every control id was renumbered
into blocks per dialog (3800s for the replay, 4000s for options, 5000s for multiplayer).

---

## 6. What is the same

Every pre-release leftover the retail survey lists is already in the beta, in the same state:

| Leftover | Beta | Retail | Reachable |
|---|---|---|---|
| Quick'n'Ugly menu, dialog 196, launcher | `0x422950` | `0x4245c0` | no caller in either |
| Heavy Metal Truck Editor, launcher | `0x423150` | `0x424c50` | no caller in either |
| Heavy Metal Truck Event Setup, dialog 192 | `0x419a70` | `0x41b460` | never constructed |
| "Metal Crush 0.50" credits | `0x424bc0` | `0x426860` | no caller |
| Terminal Video Interface (`fury.avi`) | `0x4223c0` | `0x424030` | no caller |
| Internal mission list (`mission1.vox`, `dome.sit`) | `0x4181b0` | `0x419cc0` | state 9999, never requested |
| Free roam, `HILLCLIM.SIT` | present, same file | present | load by name only |
| Smacker intro (`mslogo.smk`, `tri.smk`, `opening.smk`) | `0x49b0c0` | `0x49f770` | yes |
| Winner videos (`drag`, `circuit`, `rally`, `tourney.smk`) | in the state switch `0x4981d0` | `0x49c770` | yes |

The simulation itself is the same program: of the 207 functions in retail's simulation range
(`0x446cd0`-`0x489000`), only the three of section 4 change what a truck does. The surface table
(beta `0x445010`, retail `0x448380`) is byte for byte the same, so water is as thick in the beta
as in retail.

---

## 7. The beta's data

The beta ships its own four PODs. Compared entry by entry (content hash, through OpenPhotex):

| POD | Beta comment | Retail comment | Same | Changed | Beta only | Retail only |
|---|---|---|---|---|---|---|
| `GAME.POD` | "The Game #41 B2" | "The Game (this time for sure)" | 2,727 | 46 | 15 | 16 |
| `STARTUP.POD` | "Startup new data" | "Startup beta" | 280 | 11 | 1 | 19 |
| `TRUCK.POD` | "Truck final Bear & Ramp" | "Trucks" | 274 | 12 | 3 | 3 |
| `UI.POD` | "UI with fixes" | "The UI" | 124 | 26 | 0 | 2 |

(Retail's `STARTUP.POD` comment, "Startup beta", was never updated.)

### 7.1 Models

| Beta | Retail | What |
|---|---|---|
| `TSAURUS.BIN`, `TSAURUS1`-`4.BIN` (49,920 bytes each) | `REX.BIN`, `REX1`-`4.BIN` (55,968 bytes) | the dinosaur, renamed and rebuilt; the beta has its 17 `SAUR*.RAW` textures in older versions |
| | `TERYL.BIN`, `TERYL1`-`4.BIN` and nine `JPTER*.RAW` | the pterodactyl, added |
| `RCADOME.BIN` | `NEWRCA.BIN`, plus `NEWSIGN`, `RCASIGN`, `REDSIGN.RAW` | the RCA Dome (`DRAG2`), remodelled with signage |
| `BACKTREE.BIN`, `TREES1`-`4.RAW` | `INDYDROP.BIN`, `INDY1`-`5.RAW` | the Indianapolis strip's (`DRAG`) backdrop: a tree line in the beta, a skyline in retail |
| `NET.BIN`, `NETBAK.RAW`, `NETSDE.RAW` | `GOALTEST.BIN` | two goal nets on Highlands Rally (`CASTLE`) became four goal models |
| `ISLEDROP.BIN` 4,128 bytes, `ISLAND0.RAW` | `ISLEDROP.BIN` 2,424 bytes | Yucatan's backdrop, simplified |
| `CRUSHER.BIN` 8,988 bytes, `CRUSIDED`, `CRUSIDEP`, `CRUWIND.RAW` | 9,084 bytes, `CRUBACK`, `CRUDRVR`, `CRUPASS.RAW` | Crusher's body retextured (driver and passenger sides, back) |

The start lights `STRTGRN.RAW` and `STRTRED.RAW` are 32 x 32 in the beta and 64 x 64 in retail.
The truck list (`TRUCK\*.TRK`) is the same twelve trucks.

### 7.2 Tracks

The same fourteen SITs, with the same names and locales. What differs:

| Track | Change from beta to retail |
|---|---|
| `DRAG`-`DRAG5` | fly-by line "Track" became the par time 4.83, 4.84, 3.67, 11.21, 12.43 (section 4.1) |
| `CIRC1` A Crazy Eight | fly-by line "Track" became "Sonic"; the `TSAURUS.BIN` statue became `REX.BIN`; a second alternate course (6 segments) added |
| `CIRC3`, `CIRC5` | a second alternate course added (12 and 9 segments) |
| `CASTLE`, `DEMO`, `ISLAND` | **no alternate course in the beta**; retail adds one (40, 64 and 53 segments) |
| `CIRC2`, `CIRC4` | first alternate course's first point moved |
| `CASTLE` | `NET.BIN` x2 replaced by `GOALTEST.BIN` x4 |
| `CIRC4` Winding Way | eight fewer boxes (fewer spectators, vehicles, tables and trash cans), an `INDYSTND.BIN` stand added |
| `DEMO` Arizona | three more turn markers and a fire truck; two grid slots changed from Boogey Van and Grave Digger to Rampage and Crusher |
| CD music (`redbookTrack`) | `CASTLE` 7 to 11, `CIRC5` 6 to 2, `DRAG4` 10 to 13, `DRAG5` 2 to 6 |

The alternate courses are the extra racing lines computer trucks are spread over (the SIT's
"extended" courses). With none on three of the rally tracks, every beta computer truck there
follows the single primary line.

Terrain changed on three tracks: `CIRC1`, `CIRC4` and `ISLAND` have different `.RAW` heightfields
and `.LTE` light tables, and `ISLAND.TTY` lost a byte. The UI's track pictures were all re-saved
(`*M.BMP` 4 bytes longer), and `UI\CREDITS.BMP` and `UI\RQUALBTN.BMP` (the "Requalify" button)
are retail only.

### 7.3 Announcer and tournaments

- `DATA\PHRASES.TXT` has **123** phrases in the beta, **128** in retail. The five added: "has won
  the race." (`hasone.wav`), "has finished the race." (`hasfin.wav`), and three by Army Armstrong
  "on Drag racing", "on Circuit racing" and "on Rally racing" (`demo2`, `demo3`, `demo4.wav`, the
  attract-mode commentary). None of the five WAVs is in the beta.
- The three stock tournaments are the same (`DOUG`, `TRI`, `WHIRL`), but their descriptions are
  placeholders. `WHIRL.TXT`: "Two fast laps on each circuit!". `TRI.TXT`: "The swim, bike and run
  of Monster Truck Madness. You have to be strong in all disciplines of racing to win this one!".
  And `DOUG.TXT`: **"Even the mighty God of Lampshades has condemned this tournament as a force of
  evil."** Retail replaced all three with plain event lists ("Arizona -- rally", "Trans World
  Dome (J) -- drag" ...).
- `UI.POD`'s `WORLD\CIRC3.TXT` fixes a typo: "canyell yeehaw" became "can yell yeehaw".

---

## 8. What this means for the viewers and OpenMTM2

- **JSTrackViewer** reads the beta's SITs, LVLs and models unchanged: the formats are the same,
  and OpenPhotex reads every entry of the four beta PODs. The beta's `TSAURUS`, `RCADOME`,
  `BACKTREE` and `NET` models and its course-less rally tracks are the only things a viewer can
  show that retail cannot.
- **OpenMTM2** gains nothing it must change: every retail rule it implements is the later one.
  Two beta behaviours could be offered as curiosities: the fixed drag-time table of 4.1 and the
  60-second end-of-race countdown of 4.4.
- **The par-time reuse of the fly-by line** (retail section 2.5) is explained: the line was
  "Track" in every beta SIT, and was repurposed between Build #41 and release when the single
  drag time proved wrong for the long strips.

---

## Appendix: address index (beta, with retail counterpart)

| Beta | Retail | What |
|---|---|---|
| `0x40bc60`, `0x40bbc0` | | start-up with the expiry test; an uncalled copy of the test |
| `0x40bdf0` | `0x40d3d0` | exit: Metal Crush copyright line |
| `0x416620`, `0x416970` | `0x417ba0`, `0x417f80` | Z mode overlay; load and save situation |
| `0x417400` | `0x4189b0` | finish handling (60 s countdown in the beta) |
| `0x417650` | `0x418d40` | overlay drawing (no frame rate, no oscilloscope in the beta) |
| `0x417790` | `0x418e80` | race loop |
| `0x4181b0` | `0x419cc0` | internal mission list |
| `0x4217f0` | `0x423400` | transfer gear by skill (x1.25, x0.75), the same |
| `0x422950`, `0x423150` | `0x4245c0`, `0x424c50` | Quick'n'Ugly and truck editor launchers (no callers) |
| `0x4229d0` | `0x424640` | attract demo track choice |
| `0x424bc0` | `0x426860` | Metal Crush 0.50 credits |
| `0x42d4a0` | `0x42fb40` | in-race keys |
| | `0x42f900` | typed cheat words (retail only) |
| `0x434310`, `0x434c10` | `0x436d90`, `0x437750` | SIT reader and writer |
| `0x442f60` | `0x44604f` | saved game writer |
| `0x445010` | `0x448380` | surface table, the same |
| `0x45408b` | `0x457afb` | engine torque |
| `0x457a50` | `0x45b5d0` | course follower |
| `0x45c2d0` | `0x45fee0` | computer cornering speed |
| `0x497390` | `0x49b810` | attract-mode timer |
| `0x4981d0` | `0x49c770` | application state switch |
| `0x49b0c0` | `0x49f770` | intro videos |
| `0x4b5ed0`, `0x4b7db0` | `0x4bbd60`, `0x4bdc40` | drag qualifying times; Skip |
| `0x53e0cc` | `0x5482fc` | skill level |
| `0x53dd48`, `0x53dd64` | `0x547f70`, `0x547f8c` | slew mode; Z mode |
| `0x53e098` | `0x5482c0` | show hidden checkpoints |
| `0x7a06a0` | `0x7ea4a0` | key states by scan code |
