# Hellbender Level Support: Format Findings and Viewer Improvements

Hellbender shares Terminal Velocity's and Fury3's level container. Its `.LVL` header has the
same lines in the same order, its `.DEF` extends the TV enemy record rather than replacing it,
and its `.PUP`, `.TDF` and `.ANI` files are byte-for-byte the same grammar. That similarity is
why the viewer could open a Hellbender level at all, and also why the parts that are *not* the
same went unread: [TV_F3_LEVEL_FORMAT_ANALYSIS.md](TV_F3_LEVEL_FORMAT_ANALYSIS.md) §9.1 read
one bogus navigation point out of `HOTH.NAV`, concluded the record shape was different, and
left the whole file unread rather than half-read.

This document is what that deferred work turned up. Four things were wrong or missing:

1. The `.NAV` record really is a different shape, and it is now fully decoded.
2. The `.PUP`, `.TDF` and `.ANI` readers were correct but were gated off for Hellbender, and
   the two that carry positions were reading the wrong coordinate scale.
3. `.LVL` header line 1, `null.txt` in every TV and Fury3 level, is a per-world mission
   briefing in every Hellbender one.
4. **Every Hellbender level has a second world underneath it**, and six companion files
   describe it. The viewer used to hide everything down there; it now draws it. See
   [§6](#6-the-underground).

## Scope

Same as the TV/F3 document: content that exists on the map and can be shown or marked there.
Hellbender's ground and box quakes (`.QKE`), its animated light strips (`.GLT`) and its patrol
paths (`.CRS`) are real files this pass does not read; they are noted in [§7](#7-still-not-read)
so the next pass starts from a list rather than a directory.

---

## 1. The placement scale

Hellbender's `.DEF` placements are 16.16 fixed point world units with 8 world units per
terrain cell, and heights are half a world unit per heightfield step. The viewer's
`def-loader.js` has always known this. What was not established is that the side files share
that space rather than TV's 2^20-units-per-cell one.

They do, and the `.NAV` proves it against the `.DEF` without any appeal to the terrain.

Every type-0 `.NAV` entry is a target list: it names the `.DEF` placement indices that make up
one objective, and its own stored position is where the game puts the objective marker. So the
entry should sit on the objects it names. Converting both through the Hellbender scale and
measuring the distance from each entry to the nearest placement it names, over the 179 target
lists in the 26 shipped levels:

| Reading | Median | Mean | Within 4 cells |
|---|---|---|---|
| Hellbender scale (16.16, 8 units/cell) | 0.00 cells | 0.30 cells | 178 / 179 |
| TV scale (2^20 units/cell) | 23.26 cells | 23.00 cells | 3 / 179 |

A median of exactly zero is the entry landing on the same cell as one of its own objectives,
which is what the file means. The TV reading puts every marker in the wrong quarter of the
map.

Implemented as `hbPlacementToEditor` in [tv-coords.js](../src/worker/tv-coords.js), selected
by origin rather than sniffed from the values, since the two ranges overlap and a heuristic
would fail silently.

---

## 2. Navigation points: a different record, fully decoded

### 2.1 The grammar

The TV form is `<type>`, `<x,y,z>`, `<description>`, then a type-specific payload. Hellbender
keeps the first two lines and then interleaves four named sections the TV form has no place
for, terminating each entry with a rule of dashes:

```
<entryCount>
  <type>
  <x>,<y>,<z>
  !priority,time
  <priority>,<time>
  @Completion sound & completion text (39 chars max)
  <completion .wav, or null>
  null: line ignored
  ; Proximity Sound file
  <proximity .wav, or null>
  <objective text>
  <type-specific payload>
  -------------------------------------------------
```

The objective text is the line the game prints on the HUD ("Locate and destroy the
communications center at these coordinates."), which is why it is worth reading: it is the
level explaining itself.

The payload is read as the run of lines between the objective text and the terminator, rather
than by a per-type line count. That way an unrecognised type costs its own payload and
nothing else - the walk resynchronizes on the dashes.

### 2.2 Types

Types 0 to 6 are the TV seven, in the same order, with the same payloads. Types 7 and above
are Hellbender's own. No editor for this game survives to name them, so each is named from
what the shipped levels do with it and nothing further is claimed.

| Type | Name | Count | Payload | Evidence for the name |
|---|---|---|---|---|
| 0 | Target list | 179 | count + placement indices | Same as TV. Every index resolves. |
| 1 | Tunnel entrance | 17 | none | "Proceed to the icy entrance of the underground city." TV's type 1 additionally names the tunnel `.LVL`; Hellbender's does not. |
| 2 | Checkpoint | 61 | none | "Proceed to checkpoint Icor 7.", completion sound `chkreach.wav`. |
| 3 | Jump zone | 16 | none | "Jump Zone to warp to the next mission." |
| 4 | Tunnel exit | 14 | none | "Proceed to the entrance back to the surface of this planet.", completion sound `accpzone.wav`. |
| 5 | Boss | 5 | enemy index, `.MOD`, placeholder, `!NewH`, secondary count | Same five-line shape as TV. All five name a boss music file (`Fog-Boss.Mod`, `BionBoss.Mod`). |
| 6 | Start point | 47 | pitch,bank,heading | "Start for Snow City Level 1". Same triple as TV; only the heading is used. |
| 7 | Sync point | 69 | none | Text is always "Sync Point" or "Sync point: auto added", position always (0, level height, 0). |
| 8 | Rescue beacon | 2 | none | Both read "Locate the prison and drop a Rescue Beacon for our Coalition Rescue forces." |
| 9 | End of navs | 26 | none | The last entry of all 26 files, text "End of Navs". A terminator. |
| 12 | Escort | 3 | one placement index | "Escort Rishi's shuttle to the Jump Zone and protect him at all costs." |
| 13 | Retrieve | 1 | one placement index | "Retrieve the Message Pod left behind at the abandoned relay station." |
| 14 | Pursue | 1 | one placement index | "It's Nyx again! His backup ships are destroyed, take him down." |

There are no types 10 or 11 in shipped content.

### 2.3 Validation

All 26 `.NAV` files in Hellbender's `GAME.POD`:

```
files                    26 of 26 read to EOF with nothing left over
entries                  441, matching every file's declared count
label lines              !priority,time / @Completion... / null: line ignored /
                         ; Proximity Sound file present on all 441
placement indices        786 across target lists, bosses, escorts, retrieves and pursues,
                         every one inside its own level's .DEF placement list, no misses
```

The index check is the strong one. It is not a self-consistency check on the parser: it takes
a number the `.NAV` produced and looks it up in a list a completely separate reader built out
of a different file. 786 hits and no misses means the payloads are being cut in the right
places.

### 2.4 Two cases that have no place on the map

**Sync points and terminators.** Type 7 is stored at (0, level height, 0) in all 69 instances,
and type 9 at the same spot in 20 of the 26 files. They order the objectives; they are not
places. Drawing them stacks a pile of markers in one corner of every Hellbender map. They are
kept in the parsed list, where the sequence is the point, and not drawn.

**Escort, retrieve and pursue.** These follow an object that moves, so the file has no fixed
position to name and the editor left the field at whatever it held - `IOWAH2.NAV` stores
x = -2105071345, z = 2, which is not a point on any 128-cell map. The placement index in the
payload is the real answer. Entries whose coordinates are out of range are flagged
`positionIsPlaceholder` and not drawn. Type 14's single entry does carry a usable position and
keeps it.

### 2.5 Underground

107 of the 441 entries have a negative height, up to 16 of 28 in `ROID4`. Hellbender authors
whole sections of a level below zero, and the viewer draws only the surface heightfield.

The marker layers otherwise snap every marker onto the terrain, on the argument that a marker
floating above the ground reads as a position error. That argument inverts here: snapping an
underground objective onto the surface moves it somewhere it is not. So an underground point
keeps the altitude its own record states and its label carries "(below)". Markers already draw
with depth testing off, so it stays visible through the hill above it.

This matches the existing treatment of underground `.DEF` placements, which `def-loader.js`
flags `hellbenderUndergroundHidden` and the scene skips.

---

## 3. Side files that were correct but switched off

`.PUP`, `.TDF` and `.ANI` were gated behind `origin === "TV/F3"`. All three grammars are
identical in Hellbender; only the coordinate scale differs, and only for the two that carry
positions.

| File | Hellbender content | Result |
|---|---|---|
| `.PUP` | one placement, `MORBOS3` only | Reads. The TV document already predicted this. |
| `.TDF` | one tunnel each in `JURASIC` and `JURASIC3`, zero elsewhere, three files empty | Reads. `JURASIC.TDF` names `artic-t1.lvl` with both mouths at logic 1. |
| `.ANI` | **130 animations, 448 frames, across 8 of the 26 levels** | Reads. This is the one that was actually costing something. |

The `.ANI` result is worth calling out because the TV document's animated-texture section
counted 123 animations across all three TV-family archives put together. Hellbender alone has
more than that, and none of them were being drawn.

---

## 4. The mission briefing

`.LVL` header line 1 is `null.txt` in every Terminal Velocity and Fury3 level, and
`<stem>.txt` in every Hellbender one. It is the pre-mission briefing screen:

```
globe.bin                     <- the globe model that screen spins
roidg1.raw                    <- the texture on it
PLANET: Snow City
MISSION: Freedom
<briefing text, one line per displayed line>
.                             <- terminator
```

Nine files, one per world, shared by that world's two or three levels. The label before the
colon is not fixed - `PLANET`, `AREA`, `LOCATION` and `OBJECTIVE` all occur - so both labelled
lines are kept as authored rather than forced into a planet/mission shape the data does not
always have. `ROID.TXT` is the case that settles it: its first two labels are `LOCATION` and
`OBJECTIVE`, and a third, `MISSION: Heavy Metal`, appears inside the body text.

**Only the two labelled lines are read.** They belong on the info panel because they are what
a Hellbender level has instead of the "Race Track Locale" and race type every other game
writes, and a Hellbender level otherwise has almost no metadata: its name is its filename. The
briefing prose below them is a page of pre-mission screen copy, hard-wrapped for that screen.
It is not a property of the map and the viewer has nowhere it belongs, so it is skipped.

---

## 5. What was implemented

| File | Change |
|---|---|
| [hb-nav-parser.js](../src/worker/hb-nav-parser.js) | New. The `.NAV` grammar and the thirteen types. |
| [hb-briefing.js](../src/worker/hb-briefing.js) | New. The `.TXT` briefing's two labelled lines. |
| [tv-coords.js](../src/worker/tv-coords.js) | `hbPlacementToEditor`, and `placementToEditor` to select by origin. |
| [lvl-parser.js](../src/worker/lvl-parser.js) | Reads lines 1, 7, 8, 9 and 13 for Hellbender, with the right reader and the right scale for each. |
| [pup-parser.js](../src/worker/pup-parser.js), [tdf-parser.js](../src/worker/tdf-parser.js) | Take an origin and convert positions through it. |
| [hb-underground.js](../src/worker/hb-underground.js) | New. The cavern layers; see §6. |
| [terrain-builder.js](../src/worker/terrain-builder.js) | A height offset, a cell mask, downward-facing quads, and a shared atlas, so the cavern reuses the terrain mesher. |
| [gbox-loader.js](../src/worker/gbox-loader.js) | Takes the layer's extensions and altitude bias, so the cavern's box layer is the same reader. |
| [scene.js](../src/scene.js) | Colours for the six Hellbender-only types; skips the two that have no place; keeps an underground marker at its own altitude and tags its label; draws the cavern. |
| [app.js](../src/app.js) | The briefing's location and mission as Track Data rows; an Underground toggle and two cavern stats. |

A visible consequence beyond the markers: `TrackCamera.resetToCourseStart` already preferred a
`.NAV` start point over the map centre, and Hellbender levels now have one. A Hellbender level
opens where the game drops the player instead of in the middle of the map.

---

## 6. The underground

### 6.1 It is not a separate level

The obvious guess, given the family, is that Hellbender's underground works like a Terminal
Velocity tunnel: a separate `.LVL`, listed in the `.TDF`, entered through a mouth on the
surface. It does not. Hellbender declares two tunnels in the whole game, both in JURASIC, and
they are ordinary TV-style tunnels to a separate level.

The underground is the same level. Same `.LVL`, same 128-square grid, same `.DEF` placement
list, same `.NAV`, same `.TEX` texture list, same 16.16 coordinates. The only thing that
distinguishes a thing underground from a thing on the surface is its altitude: the `.DEF`
places 2,950 objects at a negative height, and the `.NAV` puts 107 of its 441 entries down
there.

What describes the space those objects stand in is six companion files that the `.LVL` never
mentions. They are found by stem, exactly the way `.RA0`/`.RA1`/`.CL0` already were:

| File | Bytes/cell | Role |
|---|---|---|
| `RAW` | 1 | surface heightfield *(already drawn)* |
| `CLR` | 2 | surface texture per cell *(already drawn)* |
| `RA0` / `RA1` | 1 + 1 | surface ground-box lower / upper bound *(already drawn)* |
| `CL0` | 12 | surface ground-box face textures, 6 x uint16 *(already drawn)* |
| **`RA2`** | 1 | **cavern floor heightfield** |
| **`RA3`** | 1 | **cavern ceiling heightfield** |
| **`CL1`** | 4 | **cavern floor texture, then ceiling texture** |
| **`RA4`** / **`RA5`** | 1 + 1 | **cavern ground-box lower / upper bound** |
| **`CL2`** | 12 | **cavern ground-box face textures** |

All eleven are exactly these sizes in all 26 levels, with no exceptions. The symmetry is the
giveaway: the underground is described with the same three records as the surface, one
heightfield pair plus a box layer, and `CL1` holds the two texture words a floor-and-ceiling
pair needs where `CLR` holds the one a single surface needs.

### 6.2 The altitude bias

The cavern grids are byte heightfields like the surface one, but biased down by a full byte:
the altitude is `value - 256`.

This is measured. The test does not need the terrain at all - it uses the objects Hellbender
already places down there. An underground `.DEF` placement should stand between the cavern
floor and its ceiling, and at this bias it does:

| | count | share |
|---|---|---|
| underground placements inside `RA2-256 .. RA3-256` (+-3) | 2,862 | **97.0%** |
| below the floor | 21 | 0.7% |
| above the ceiling | 7 | 0.2% |
| in a cell the layer says is solid | 60 | 2.0% |

The 105 underground `.NAV` points agree independently, 104 of 105 inside the band. Against the
unbiased grids the same placements miss by a median of 255 altitude steps, which is the bias
showing up as the size of the error.

### 6.3 Where there is no cavern

`RA3` equals `RA2` wherever the rock is solid, and that is most of the map: 160,630 of the
426,008 cells across the game are hollow. The distribution is not uniform - KREASH has no
cavern at all, HOTH3 writes a nominal 2-step gap everywhere and has no underground section,
while FLOAT, ROID, ROID2, ROID3 and SHIP are hollow across the whole grid, which is what a
floating-island or asteroid level should look like from below.

So the floor and ceiling meshes are masked to the hollow cells rather than covering the grid,
with a gap of more than two steps required to count. Without that, HOTH3 gains 6,425 cells of
zero-thickness z-fighting geometry standing for nothing.

### 6.4 Which half of CL1 is which

`CL1` holds two of the same 2-byte texture words the `.CLR` uses, and nothing labels them. The
reading is floor first, then ceiling, on three independent signals:

- every texture whose name says ceiling or roof appears in the second field, 76 uses to 0;
- textures whose name says floor lean to the first, 2,451 uses to 1,976;
- the second field repeats that cell's own **surface** texture in 54,281 of 160,630 hollow
  cells against 10,453 for the first, which is what a shallow cavern roofed by the underside
  of the ground above it should look like.

A fourth test - whether each field is better predicted by the floor height or the ceiling
height - came out too close to call and is not counted. So this is a strong reading rather
than a proven one. Swapping the two would swap two textures and change nothing structural.

### 6.5 Drawing it

The cavern floor and ceiling are ordinary terrain meshes: same builder, same grid, same
texture atlas as the ground above, plus three things the mesher did not have - a height offset
for the bias, a cell mask for the solid cells, and reversed winding with flipped normals for a
ceiling that is only ever seen from below. The cavern's ground boxes go through the existing
`.RA0`/`.RA1`/`.CL0` reader with the other three extensions and the bias.

**Where are the walls?** Hellbender authors none. Of the 24,963 hollow-to-solid boundary edges
in the shipped game, only 7% have a cavern ground box on the hollow side and 5% on the solid
side, so the boxes are furniture rather than walls. They are not needed: in a solid cell the
ceiling grid equals the floor grid, so growing the mask by one cell lets the floor rise and the
ceiling drop into the same seam and the volume closes itself out of the two heightfields. No
wall geometry, and no guess about what a wall should look like.

That is worth contrasting with Terminal Velocity and Fury3, because the two games solve the
same problem in opposite ways. TV and Fury3 have no second heightfield at all - a level is one
`.RAW` and one `.CLR` - so their chambers are a construction trick, and the F!Zone manual
(docs/`fzone for fury3 manual.txt`, p.21) spells it out: raise a large area to altitude 255,
hollow out a smaller one inside it, and "the chamber ceiling area is automatically created by
mirroring the ground area and flipping it to form our ceiling". Chambers are capped at ten
squares wide in X so that the ceiling texture of each floor square can be read from the square
ten to its right.

`ARTIC.LVL` in Terminal Velocity's CDROM.POD is that construction verbatim. Around the centre
of the map an 864-cell plateau at altitude 255 spans x 113..145, z 113..141, and hollowed into
it is a 24-cell chamber at x 124..129, z 126..131 - six squares wide, inside the ten-square
limit - with its floor at 220 and 230. There is nowhere in the level's files for a ceiling to
be stored, and the texture ten squares right of the chamber floor is a different, wall-like set
(`ICELITW1.RAW`, `SNORING.RAW`) where the floor itself carries `ICEG3`..`ICEG8`.

**Hellbender does not use that trick, and does not need to.** Its cavern ceiling is a real
heightfield with its own texture grid, which is exactly what `RA3` and the second half of `CL1`
are - the successor to the mirroring hack rather than a variant of it. Nor is there any
mirroring in its box faces: all six faces of a cavern box carry a texture index at much the
same rate (8-15% left at zero), and opposite faces merely tend to repeat, S matching N on 86%
of boxes and E matching W on 83%, which is an author reusing a texture rather than the engine
generating one.

Two decisions worth stating:

**One atlas, not three.** A Hellbender level now builds three surfaces from one texture list,
and an atlas for 205 tiles is about 3 MB. It is built once and shared. That is not only
memory: the atlas is transferred to the main thread, and transferring the same `ArrayBuffer`
twice detaches it, so exactly one of the three meshes returns it.

**The cavern is drawn unlit, and double-sided.** The scene has one directional light standing
in for the sun, and underground there is no sun - the ceiling faces away from it by definition
and the floor is shadowed by the whole map above it, so a Lambert cavern renders almost black
at any sun setting. Hellbender's art is already shaded into those 64x64 tiles, so the two
cavern surfaces are drawn at texture brightness.

Double-sided because a heightfield quad is wound to be seen from above, which is the only side
there is when the surface is the ground. A cavern has two: its floor folds into cliffs
approached from either hand, and the seam that closes it is a near-vertical quad whose facing
depends on which way the cavern happens to end. Under FrontSide roughly half of those walls
are culled, which reads as a cave with two of its four sides missing.

The objects that used to be hidden are now part of that layer rather than skipped, so the
Underground toggle shows and hides the room and its contents together.

---

## 7. Still not read

Files that exist in `DATA/` and that this pass does not touch.

| Extension | Count | What it appears to be |
|---|---|---|
| `.QKE` | 26 | Ground quakes and box quakes: counted sections with per-entry timing and amplitude rows. |
| `.GLT` | 10 | Animated light strips - triples of on/off/broken `.RAW` names with a timing row. |
| `.CRS` | 24 | Polyline paths, `numPoints,groundCourse,periodic` then that many 16.16 points. Patrol or camera routes. |
| `.TTY` | 26 | Present for every level; `FLOAT.TTY` contains only `0`. |
