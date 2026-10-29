# Fury3: TF.EXE Analysis and Suggested Changes

What the Fury3 executable says about the levels JSTrackViewer reads from `FURY3.POD`,
`FURYSE.POD` (F!Zone) and, through the Terminal Fury mount, `TV.pod`. Fury3 is the Windows 95
port of the Terminal Velocity engine, so most findings are the ones in
[TV_GAME_EXE_ANALYSIS.md](TV_GAME_EXE_ANALYSIS.md); this document gives Fury3's own addresses,
confirms each rule in this build, and adds Fury3's cheat codes. Format background is in
[TV_F3_LEVEL_FORMAT_ANALYSIS.md](TV_F3_LEVEL_FORMAT_ANALYSIS.md).

## 1. The executable

`~/games/tf/TF.EXE` (614,912 bytes) is the Fury3 program from **Terminal Fury 1.0**, a 2010
fan release by Kmaster (Monster Truck Madness Guild). Its readme says the mash-up mounts
Terminal Velocity's and F!Zone's PODs through `pod.ini`, adds `TFURY.POD` on top, and only
changes logos, names, a title image and the music; the engine is untouched. The PE header
agrees: linked 14 August 1995 with Microsoft linker 2.55, the Fury3 retail era. The window
title reads "Terminal Fury", every message still says Fury3. The readme also gives the
engine's codename, **CyberUI**.

So everything below is Fury3's engine. The only caution is that the cheat table could in
principle have been edited by the mod; nothing in the readme or the binary suggests it was,
and the codes are in Fury3's style.

Analysed with Ghidra 12 (1,821 functions). Addresses are virtual addresses in TF.EXE (image
base `0x400000`). Many functions are reached through 5-byte jump thunks (`thunk_FUN_...`), so
caller counts in Ghidra are low; the thunk and its target are the same function.

---

## 2. Same engine as Terminal Velocity

Each TV rule was looked up in TF.EXE and found with the same logic:

| Rule (TV_GAME_EXE_ANALYSIS.md) | TV address | Fury3 address |
|---|---|---|
| DEF loader, placement X/Z sign-extended from 28 bits, Y replaced by terrain on surface levels, strength x1.5 / x2 by difficulty | `0x230a0` | `0x40c2b0` |
| Placement init: DEF X/Y/Z offsets added, half model radius added for logics 2, 4, 7, 8 | `0x22f20` | `0x40c140` |
| Hit radius overwritten by the simple model's AABB corner radius | `0x22df0` | `0x40bf80` |
| Checkerboard triangle height sampler | `0x3c940` | `0x43e940` |
| Chamber ceiling: `510 - h`, CLR texture from `(cx + 10, cz)`, base altitude `0x7F8000` | `0x3d0a0` | `0x43f3d0` |
| Model vertex scale `raw * 65536 / magnify`, "Unable to read verticies in model!" | `0x405b0` | `0x408320` |
| Tunnel build and texture save ("Tunnel is too big!", `TUNNEL%d.RAW`) | `0x34770` | `0x435020`, `0x434bd0` |

The DEF header scans the same way (`%d,%d,%d,%d,%d,%d,%s`) into the same 0x244-byte record,
and the body sections (`;`, `!`, `#`, `%`) are read in the same order, the two `%SFX` sound
names landing at `+0x21C` and `+0x230` in both games.

**Measured.** Over every surface placement, stored Y lies within 2 world units of the
triangle sampler for 65.1% of `FURY3.POD`'s 5,723 placements and 69.8% of `FURYSE.POD`'s
3,627, against 49.6% and 68.2% bilinear. As in TV, the rest are placements the engine lifts
onto the ground itself.

**Tunnels.** All 52 `.TNL` files in `FURY3.POD` and 31 in `FURYSE.POD` read under the TV
layout (TV_GAME_EXE_ANALYSIS.md section 4), at most 61 segments, ring sizes 4, 5, 6 and 8.

---

## 3. Cheat codes

Same mechanism as Terminal Velocity: typed during a single-player game, matched letter by
letter, seven letters fire the code. Table of 28 pointers at `0x53f480`, matcher `0x43bfb0`,
effects `0x43bc10`, pickups through `0x445c70` (same type mapping as TV).

| Code | Effect |
|---|---|
| `TRYMEON` | Invincibility on/off |
| `TUFENUF` | Shields restored |
| `JUMPNIT` | End the level and go to the next |
| `STPNSHP` | Hover (stop the ship while the key is held) |
| `SSMOKIN` | Eight Turbo Thrust pickups |
| `SCOPEIT` | Oscilloscope display on/off |
| `URDUSTD` | "Turbo-Fury!": afterburner x9 instead of x3 |
| `FRAMEIT` | Frame counter on/off |
| `GIVITUP` | Every weapon plus eight Turbo Thrusts ("Watusi!") |
| `WORMIT1` to `WORMIT8` | Warp to world n: the level index is set to `3n - 4`, so the next level is the first of world n (three levels per world) |
| `WORMIT9` | Prints "Gotcha!" and does nothing: a decoy |
| `PACKIN1` to `PACKIN7` | One pickup each: ServoKinetic Lasers, Dispersion Cannons, Rapid-Fire Lasers, Dead-On Missiles, Vipers, Bion Fury Missiles, FFF |
| `LIVITUP` | One Turbo Thrust |
| `ICUNOMO` | Invisibility |
| `IMTUFFF` | Invincibility pickup |

Names follow Fury3's own powerup table (TV_F3_LEVEL_FORMAT_ANALYSIS.md 10.4). The
"level complete" flag the skip code sets is `0x53e768` (Terminal Velocity's is `0x64d34`).

---

## 4. Suggested changes

**Status.** Applied in JSTrackViewer (4.1 items 1 to 5), OpenMTM2 (the height step and triangle
sampler from 4.2) and OpenPhotex (4.3). Item 6, resolving names across Terminal Fury's mount
order, is not done: the viewer opens one archive at a time.

Fury3 levels are drawn by the same code paths as Terminal Velocity's in both projects, so the
suggestions are those of TV_GAME_EXE_ANALYSIS.md section 6, which apply unchanged:

### 4.1 JSTrackViewer

1. Place TV-family objects the engine's way: terrain height (triangle sampler) + DEF Y offset
   + half the model's AABB corner radius for logics 2, 4, 7, 8; stored Y only on tunnel
   levels.
2. Checkerboard terrain split and sampler for `origin === "TV/F3"`.
3. Default height scale 2 units per step (true proportion) for TV/F3.
4. Chamber ceilings (`510 - h`, texture from 10 cells right) as an optional layer, and an
   option to hide all-255 triangles.
5. Tunnel interiors from `.TNL`.
6. **F!Zone and Terminal Fury mounts.** Terminal Fury layers `TFURY.POD` over `FURY3.POD`,
   `FURYSE.POD` and `TV.pod`, first match wins (the readme's "same behaviour has all TRI's
   terrain engine games"). If several of those archives are opened together, resolving a name
   in that priority order reproduces the mod's levels. The viewer's existing `DATA/`-first
   resolver is the place for it.

### 4.2 OpenMTM2

- Correct the TV/F3 height step from 2 ft to **1 ft** per step at 32 ft per cell (a step is
  1/32 of a cell in engine units).
- Use the triangle sampler for ground contact on TV/F3 levels.
- Fury3 objectives as checkpoints: the `.NAV` order is the mission route (TV_F3 doc section 2),
  and `JUMPNIT`/`TRINEXT` show the engine's "level complete" is a single flag, so a port can
  treat the last navigation point as the finish.

### 4.3 OpenPhotex

- The `.TNL` reader proposed in TV_GAME_EXE_ANALYSIS.md 6.3 covers Fury3 and F!Zone as well
  (83 more test files).

---

## 5. Display and resolution

Fury3 keeps none of Terminal Velocity's SVGA mode. Its frame is fixed at 320x200:

- **Frame size.** The renderer is set to 320x200 once at startup (`0x4433a0`) and nothing else
  changes it. The `gamePIXX`/`gamePIXY` keys in `fury3.ini` (TV's SVGA setting) only size the
  depth buffer and the view rectangle, which is then clamped to 320x200 (`0x4444e0`), so
  setting them to 640x480 changes nothing visible.
- **Windowed.** The 320x200 frame is a DIB section stretched to the window's client area with
  `StretchBlt` (`0x409fc0`). A 640x480 window is the same image pixel-doubled.
- **Full screen.** Chosen by Windows version (`GetVersion`, `0x40b530`): on Windows 95 the frame
  is copied straight to VGA memory at `0xA0000`, or shown through the 16-bit `DISPDIB.DLL`, both
  low-resolution only; on Windows NT full screen is skipped on purpose (`0x409d40`) and the game
  stays windowed. That is why it never goes full screen on NT-family Windows.
- **Patching.** The renderer still has 640-wide code paths from TV (`0x430cb0`, `0x44ab10`),
  so a true 640x480 is plausible, but besides the size at `0x4433a0` the 64,000-byte frame
  copies (`0x40a460`, the full-screen path), the 320x200 title, cockpit and HUD art and the menu
  layout all assume 320x200. Running windowed and maximized, which the game already scales, is
  the practical route on NT.

The executable is the unmodified 1995 build: its sections are the linker's own, and the
processor-affinity calls in it are the C runtime's Pentium FDIV check, not a later patch.

