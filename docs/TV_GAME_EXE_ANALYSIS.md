# Terminal Velocity: GAME.EXE Analysis and Suggested Changes

What the Terminal Velocity executable itself says about the data JSTrackViewer and OpenMTM2
read: how terrain heights are sampled, how chambers and tunnels are built, where objects really
stand, and the cheat codes. It complements
[TV_F3_LEVEL_FORMAT_ANALYSIS.md](TV_F3_LEVEL_FORMAT_ANALYSIS.md), which was written from the
F!Zone manual, TVCAD, FuryEdit and the level files; that document's section 11 (the sky) is
the only part that had used the executable before.

Fury3 runs the same engine; [FURY3_EXE_ANALYSIS.md](FURY3_EXE_ANALYSIS.md) lists its
addresses and its own cheat codes. Hellbender is a later, heavily extended branch:
[HELLBENDER_EXE_ANALYSIS.md](HELLBENDER_EXE_ANALYSIS.md).

## Summary

| Topic | Finding | Viewer today |
|---|---|---|
| Terrain sampling | Two triangles per cell, the diagonal alternating in a checkerboard | Bilinear for markers, fixed diagonal for the mesh |
| Object height | On a surface level the stored Y is **discarded**; the engine puts every object on the terrain, then adds the DEF Y offset, then half the model radius for flying logics | Stored Y plus the DEF Y offset |
| Hit radius | DEF slot 2 is overwritten at load by a radius computed from the simple model | Read from the DEF |
| Model scale | `raw * 65536 / magnify` world units, confirmed | Correct |
| Vertical proportion | The world is isotropic: one height step is 1/32 of a cell, 2 editor units | Terrain drawn at 3 units per step, models at true size |
| Chambers | Ceiling = the floor mirrored about altitude 255 (`510 - h`), texture from the CLR cell 10 to the right | Not drawn |
| Altitude 255 | A terrain triangle whose three corners are all 255 is never drawn | Drawn |
| Tunnels | `.TNL` fully decoded: a tube of elliptical rings, one segment per 2^20 world units | Only the surface mouths are marked |
| Cheats | 28 codes, plain text in the executable | n/a |

---

## 1. Source and method

`TV.EXE` (29 KB) is only a launcher. The game is `GAME.EXE` (624,695 bytes, 30 June 1995), a
Watcom C/C++32 program bound to the DOS/4GW extender in LE format. Ghidra does not load LE, so
the executable was rewritten as a flat PE with every one of its 13,266 internal fixups applied
and both objects kept at their native addresses (code object at `0x10000`, data object at
`0x60000`). Every address below is in that native space, which is also the space
TV_F3_LEVEL_FORMAT_ANALYSIS.md section 11 uses (`0x17be0`, `0x18b60`).

The converter (`le2pe.py`) and the Ghidra workspace were kept out of every repository. As with
OpenMTM2's `re/` folder, decompiled output is never published; only facts, layouts and
constants are recorded here.

Watcom passes arguments in registers, so Ghidra's view of the `fscanf` calls in the loaders is
unreliable. Every field offset given for a scanned record below was read from the
disassembly (the order of the pushes), not from the decompiler.

---

## 2. Terrain

### 2.1 Height sampling is triangular, not bilinear (`0x3c940`)

The function every system uses to ask "how high is the ground here" (39 callers: placement,
collision, shadows, AI) splits each cell into two triangles:

- cell `(cx, cz) = ((x >> 20) & 255, (z >> 20) & 255)`, fractions `fx, fz = (coord & 0xFFFFF) >> 4`
  (0 to 65535);
- the RAW is row-major by z: index `cz * 256 + cx`; a height byte is `0x8000` world units;
- when `cx & 1 == cz & 1` the diagonal runs from `(cx, cz)` to `(cx+1, cz+1)`, otherwise from
  `(cx+1, cz)` to `(cx, cz+1)`;
- the result is the plane of the triangle the point falls in, in 16.16 fixed point, and
  neighbours wrap at 256.

That is the same checkerboard rule JSTrackViewer already implements for CPR
(`terrain.cellSplit === "checkerboard"` in [terrain-builder.js](../src/worker/terrain-builder.js)).

**Measured against the shipped data.** Every DEF placement on every surface level, sampled
both ways, counting a placement whose stored Y is within 2 world units of the sample:

| Archive | Placements | Triangle (engine) | Bilinear |
|---|---|---|---|
| TV `CDROM.POD` | 4,181 | 3,034 (72.6%) | 2,053 (49.1%) |
| Fury3 `FURY3.POD` | 5,723 | 3,726 (65.1%) | 2,840 (49.6%) |
| F!Zone `FURYSE.POD` | 3,627 | 2,530 (69.8%) | 2,472 (68.2%) |

Swapping the axes drops the triangle count to 177 of 4,181, so the axis order above is right.
The remaining quarter of placements are not on the ground at all in the file, which section 3
explains: the engine never reads their stored Y.

### 2.2 Cell drawing (`0x3caf0`)

- A triangle whose three corners are all at altitude 255 is not drawn. A cell whose four
  corners are all 255 is skipped before any setup. Altitude 255 is "solid rock": the roof of
  a chamber, never seen from above in play because the flight ceiling sits below it.
- The texture is the CLR byte; a short table of `(x, z)` cells (count at `0x104e20`, entries
  at `0x104bac`) substitutes another texture for those cells. Its only plausible source is the
  `.TDF` tunnel mouth textures; this was not traced further.
- The normal and plane of each triangle are computed per cell from the four corner bytes.

### 2.3 Chambers (`0x3d0a0`, `0x3d5e0`)

The F!Zone manual's description ("the chamber ceiling area is automatically created by
mirroring the ground area and flipping it", ceiling texture from ten squares to the right) is
exactly what the engine does:

- **Ceiling height** for a corner of height `h` is `255 + (255 - h)`, that is `510 - h`
  steps, facing down. Where the floor reaches 255 at the chamber wall, the ceiling comes down
  to 255 too, so the room closes itself; there is no wall geometry.
- **Ceiling texture** is the CLR byte at `(cx + 10, cz)`, same row.
- A cell with all four corners at 255 has no ceiling (`255 - h = 0` everywhere).

**When the engine switches to it.** Every frame, the terrain dispatcher (`0x3d5e0`) looks at
the cells 7 squares away from the camera along +x, -x, +z and -z, for 8 steps. If any of them
is not 255, it draws the normal outdoor world (`0x42fa0`). If all are rock and the camera is
below altitude 255 (`0x7F8000`), it draws a 15 x 15 cell window around the camera: every
ceiling first, then every floor. So a chamber is, by construction, a hollow enclosed by rock
within 7 cells in each axis direction, and the manual's 10-square width limit is what keeps
the `+10` ceiling texture lookup inside the solid rock.

---

## 3. Objects

### 3.1 The DEF header, by offset (`0x230a0`)

The header line `%d,%d,%d,%d,%d,%d,%s` scans into the 0x244-byte definition record as:

| Slot | Record offset | Meaning |
|---|---|---|
| 0 | `+0x0C` | logic (TVCAD.INI's 42 names) |
| 1 | `+0x1C` | not exposed by TVCAD |
| 2 | `+0x08` | hit radius, **overwritten at load** (3.3) |
| 3 | `+0x10` | X offset, added to the placement |
| 4 | `+0x14` | Y offset, added to the placement |
| 5 | `+0x18` | Z offset, added to the placement |

The complex model name is kept at `+0x24` and the simple one at `+0x44`; the 13-word bounds
block of the simple model lands at `+0x74` and that of the complex model at `+0xA8`. Limits:
50 definitions, 500 placements, 50 distinct models (`Too many models!`).

### 3.2 Where a placement ends up (`0x230a0`, `0x22f20`)

In this order:

1. X and Z are sign-extended from 28 bits, so they wrap at 256 cells.
2. **On a surface level, Y is replaced by the terrain height at (x, z)** from the triangle
   sampler (2.1). Only a tunnel level (LVL line 0 = 1, held at `0x64d48`) keeps the stored Y.
3. The definition's X, Y and Z offsets (slots 3, 4, 5) are added.
4. For logics 2, 4, 7 and 8 (Flying (Dumb), Flying (Smart), Flying Attack/Retreat (Smart),
   CISHIP Split (Smart)) half of the model radius is added to Y, so a flyer starts half its
   size above the ground plus its offset.
5. Difficulty 2 multiplies the placement strength (`+0x1C`) by 1.5 and difficulty 3 by 2.

### 3.3 The hit radius comes from the model (`0x405b0`, `0x22df0`)

At load the engine measures each definition's simple model: the per-axis minimum and maximum
vertex, scaled to world units, then the per-axis maximum absolute value, and from those
`round(sqrt(ax^2 + ay^2 + az^2))`, the radius of the bounding-box corner. That value (bounds
word 9, record `+0x98`) is written over the DEF hit radius, and also becomes the per-axis
extents for most logics (logic 6 copies the true max extents instead).

This is the explanation for the "hit radius is 1.00 to 1.4 times the vertex radius" pattern
in TV_F3_LEVEL_FORMAT_ANALYSIS.md 10.2: an AABB corner radius is exactly 1 for a model that
fills a cube corner and up to sqrt(3) for a long thin one. The stored number is the editor's
copy of what the game recomputes.

### 3.4 Model scale

The same function confirms the vertex scale: `(0x7FFFFFFF / magnify) * 2` applied as a 16.16
multiply, so world = `raw * 65536 / magnify`, with magnify from the BIN's 0x14 record (0x20
records chain to another model). The viewer's `BIN_GEOMETRY_DIVISOR` (8192 with `raw >> 1`)
gives `raw * 4 / magnify` editor units, which is the same thing at 2^14 world units per editor
unit. **No change is needed to model scale.**

### 3.5 Vertical proportion

One cell is `2^20` world units and one height step `2^15`, and models use the same world
units on all three axes. So in the viewer's units (64 per cell) the true height scale is **2
units per step**. The viewer draws terrain at 3 units per step by default and models at true
size, so the ground is exaggerated by 1.5x relative to every object standing on it. Objects
placed at the scaled terrain height stay on the ground, but anything defined relative to the
ground (a flyer's Y offset, the half-radius lift, a chamber's height) is drawn at 2/3 of its
real proportion to the hills around it.

---

## 4. Tunnels: the `.TNL` format

Read by `0x34770`, built into geometry by `0x33f00`, flown by `0x26e60` and `0x38820`.
Plain ASCII, CRLF:

```
<segmentCount>                       at most 90 ("Tunnel is too big!")
per segment, 13 + N lines:
  ax, ay, bx, by, N                  +0x00 +0x04 +0x08 +0x0C +0x10
  a0, a1, unk28                      +0x18 +0x1C +0x28   ring A angle start, end
  rxA, ryA                           +0x2C +0x30         ring A radii
  b0, b1                             +0x20 +0x24         ring B angle start, end
  rxB, ryB                           +0x34 +0x38         ring B radii
  timer                              +0x40               door countdown (65535)
  unk48                              +0x48
  open                               +0x14               sides left open (0 = closed ring)
  type                               +0x3C               segment behaviour, 0 = plain
  texList                            +0x44               index into the tunnel texture list
  side texture x N                   +0x4C...            one per face
  unk234, unk23C, unk240             +0x234 +0x23C +0x240  (0, 65535, 32768 typically)
```

**Geometry.** A segment is the space between two elliptical rings of `N - open` vertices.
Ring A, at the segment's start, has vertex `k` at `(cos(t) * rxA, sin(t) * ryA, 0)` with `t`
stepping from `a0` towards `a1` in `(a1 - a0) / (N - open)` (angles are 65536 per turn). Ring
B, at the end, is the same with its own angles and radii, offset by `(bx - ax, by - ay)` and
`0x1000` along the tube. When `open` is non-zero the missing sides leave the ring open (a
floor-less or roof-less section). Each face then gets a plane from its four corners.

**Scale.** Segment coordinates are in units of 256 world units: the segment centre is
`(ax * 256, ay * 256)` and the ring step `0x1000 * 256 = 2^20`, so **each segment is exactly
one terrain cell long**, and an object's Z in a tunnel level divided by 2^20 is the segment it
is in. The tube is laid along +Z; there are no rotations, only the centre moving between
segments. A typical radius of 3200 is `819,200` world units, 0.78 of a cell, 25 height steps.

**Segment types** (the `type` line, handled in `0x38820`): 2 is a door whose countdown
(`timer`, decremented by four times the frame time) opens it into type 3 with an explosion;
4 to 15 clamp the craft above, below, left or right of the centre line at a fraction of the
radius (blocking half or part of the tube); 0x12 is a blocker turned by a random angle drawn
at load; 0x13 is a horizontal band. The shipped files use types 0 to 30, so 0x14 and above
remain to be read.

**Validation.** All 148 shipped `.TNL` files (65 in TV, 52 in Fury3, 31 in F!Zone) read to EOF
under this layout, with `N` in {4, 5, 6, 8} and at most 82 segments.

The second file the loader opens is the tunnel texture list (24-byte names, uppercased). The
level's `.DEF`, `.PUP` and `.NAV` share the tunnel's own frame: X and Y in the ring plane,
Z along the tube.

---

## 5. Cheat codes

Typed during play, single player only (the check is skipped when more than one player is in
the game). The input is matched letter by letter against a 28-entry table at `0x64e9c`
(strings at `0x600f4`); seven matching letters fire the code. The handler is `0x10d30`.

| Code | Effect |
|---|---|
| `TRIGODS` | Invincibility on/off ("Invincible!") |
| `TRISHLD` | Shields to full |
| `TRINEXT` | End the level and go to the next |
| `TRIHOVR` | Hover pad: while held, the throttle drops to zero and the ship stops dead |
| `MANIACS` | Eight Afterburner pickups |
| `TRSCOPE` | Oscilloscope display on/off |
| `TRIBURN` | Afterburner thrust x9 instead of x3 ("Terminal Velocity!") |
| `TRFRAME` | Frame counter on/off |
| `3DREALM` | Every weapon, plus eight Afterburners ("Smokin'!") |
| `TRWARP1` to `TRWARP9` | Warp: the level index is set so the next level loaded is slot n - 1 (planet n) |
| `TRIFIR1` to `TRIFIR9`, `TRIFIR0` | One pickup each: Plasma, Ion Burst, Laser, Missile, Guided Missile, Super Missile, Smart Bomb, Afterburner, Invisibility, Invincibility |

The `TRIFIRn` mapping goes through `0x40300`, which turns n into a `.PUP` powerup type (1, 2,
0, 3, 4, 5, 9, 10, 7, 8); names as in TV_F3_LEVEL_FORMAT_ANALYSIS.md 10.4.

**"This version of TV has been modified."** The warning text and its printing routine
(`0x2c7b0`) are in the executable, but nothing references the routine in this build. It is
dead code, not an active integrity check.

---

## 6. Suggested changes

**Status.** Applied:

- **JSTrackViewer:** items 1 to 7 (`engine-placement.js`, checkerboard split, height scale 2,
  engine hit radius, `tv-chambers.js` with the Rock tops toggle, `tunnel-builder.js`). Item 8
  is these tables, linked from the README.
- **OpenPhotex:** everything in 6.3 (`parseTvTunnel`, `tunnelSegmentGeometry`,
  `heightAtPoint`, `cellTriangleHeight`, DEF offsets).
- **OpenMTM2:** the height step and the triangle sampler from 6.2. Tunnels and chambers there
  remain to be built.

### 6.1 JSTrackViewer (in priority order)

1. **Objects on the ground the way the engine puts them.** For TV/F3 surface levels, ignore
   the placement's stored Y and compute it as triangle-sampled terrain + DEF Y offset + (half
   the simple model's AABB corner radius for logics 2, 4, 7, 8). Keep stored Y for tunnel
   levels. This fixes the quarter of objects whose file Y is stale and lifts flyers the way
   the game does. File: [def-loader.js](../src/worker/def-loader.js), with the radius taken
   from the decoded simple model in [bin-decoder.js](../src/worker/bin-decoder.js).
2. **Checkerboard terrain for TV/F3.** Set `cellSplit: "checkerboard"` for the TV family in
   [lvl-parser.js](../src/worker/lvl-parser.js) and use the same triangle rule in the marker
   sampler in [scene.js](../src/scene.js) (around line 2289, today bilinear). Check the parity
   once against the viewer's flipped z (`(gridSize - cz)` in terrain-builder.js): the engine's
   rule is "same diagonal when `cx` and `cz` have the same parity" in file coordinates.
3. **True vertical scale.** Default the TV/F3 height scale to 2 units per step (true
   proportion) instead of 3, keeping the slider as an exaggeration control. With 2, terrain,
   models, offsets and chambers all agree.
4. **Hit radius from the model.** Where the hit radius is shown or used, prefer the computed
   AABB corner radius and show the DEF value as "editor value".
5. **Chambers.** Add a "Chambers" layer: for every cell with a corner below 255 that lies in a
   hollow (the engine's test: rock at distance 7 in all four axis directions), draw a ceiling
   quad pair at `510 - h` with the CLR texture of `(cx + 10, cz)`, wound downwards and unlit
   like the Hellbender cavern. Reuse the cavern path in terrain-builder.js (height offset,
   cell mask, `faceDown`). This supersedes the "chamber ceilings are out of scope" row of
   TV_F3_LEVEL_FORMAT_ANALYSIS.md section 8: the ceiling is fully determined by the data.
6. **Hide altitude-255 tops (option).** The game never draws a triangle whose corners are all
   255. A toggle that skips them lets the user look down into chambers from above; the
   default can stay as today, since the viewer's camera, unlike the player, flies above them.
7. **Tunnel interiors.** A tunnel level can now be opened: build the tube from the `.TNL`
   (section 4), segment `i` from `z = i * 2^20` to `(i + 1) * 2^20`, ring vertices in 256-unit
   steps, faces textured from the tunnel texture list, then place the tunnel level's `.DEF`,
   `.PUP` and `.NAV` in that frame. The track picker already identifies tunnel levels by LVL
   line 0. A first version can ignore segment types (doors and blockers are gameplay).
8. **Cheat-free, but worth showing.** Nothing to implement; the table above can go in the
   README's game notes.

### 6.2 OpenMTM2

- **Height scale.** `docs/CHANGELOG.md` (Stage 3.2) reads "a cell is 32 ft; a height step 2 ft
  (Terminal Velocity, Fury3)". The engine's units make a step 1/32 of a cell, so **1 ft** at
  32 ft per cell. Today TV/F3 hills are twice as tall as the objects and craft expect.
- **Ground sampling.** The sim's ground for TV/F3 levels should use the checkerboard
  triangles (2.1), as it already does for MTM tracks.
- **Objects.** Same placement rule as 6.1 item 1; the hit radius as the collision sphere.
- **Tunnels and chambers**, listed as "not built", now have complete geometry rules
  (sections 2.3 and 4).

### 6.3 OpenPhotex

- A `.TNL` reader (`parseTvTunnel`) returning the segment records of section 4, with the 148
  shipped files as its test corpus. `.TNL` is in its "not covered" list today.
- A triangle sampler variant for the TV family next to the existing heightfield samplers; it
  is format semantics (how the heightfield is meant to be read), not game logic.
- The DEF reader's `hitRadius` could carry a note that the game recomputes it.

---

## 7. Corrections to earlier documents

| Document | Statement | Correction |
|---|---|---|
| TV_F3_LEVEL_FORMAT_ANALYSIS.md 5.1, 10.3 | Placement Y "equals the terrain" (89% to 99.9%) | The engine overwrites Y on surface levels; the file Y is the editor's copy, and matches best under the triangle sampler |
| same, 10.2 | Hit radius is the model radius times 1.0 to 1.4 | It is the AABB corner radius of the simple model, recomputed at load |
| same, 8 | Chamber ceilings and tunnel interiors cannot be understood from the data | Both are fully specified (sections 2.3 and 4) |
| same, Appendix A | "Tunnel logic 0 to 3" etc. | Unchanged; add: `.TNL` segment = 2^20 world units, ring units 256 world units |

---

## 8. Names inside the program

- **No "Velocity Brawl".** No string containing "brawl" exists in `GAME.EXE`, `TV.EXE`, the
  setup and help programs, the PODs or the TVCAD editor, in ASCII or UTF-16. `VEL2.RAW` is a
  picture of a ship over a planet with no text. The only internal name is the demo recording
  `cyberdem.vox`; "Cyber" carries on as Fury3's `CYBERUI` and the "The Cyber Fighter" string in
  Fury3 and Hellbender.
- **Display.** `GAME.EXE` draws 320x200 VGA, or 640x480 through a VESA 1.0 driver ("Res: SVGA
  (Pentium)" in setup, "SVGA enabled!" in game). Fury3 dropped the SVGA mode (see
  FURY3_EXE_ANALYSIS.md 5).
- **`.QKE`.** TV ships a `.QKE` beside most levels, but it is not Hellbender's quake script: 181
  of the 190 TV-family files hold a single `0`, and the rest are a small unlabelled table.

