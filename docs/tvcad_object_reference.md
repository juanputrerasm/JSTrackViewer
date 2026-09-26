# Terminal Velocity Object Placement & POD Format Reference

## Overview

This document describes how object placement works in Terminal Velocity–style levels,
including:

- POD container structure
- Level file extraction workflow
- Object placement data format
- Coordinate system and scaling
- Grid conversion (256 × 256 terrain)

This document is self-contained and does not rely on external reverse-engineered file references.

---

# 1. POD File Format

A POD file is a container that stores multiple files.

## Structure

```
Long    fileCount
80 bytes description/comment

Repeat fileCount times:
    32 bytes filename (null-padded string)
    Long     fileSize
    Long     fileOffset

Then:
    Raw file data blobs
```

## Extraction Process

To read files from a POD:

1. Read `fileCount`
2. Skip 80-byte description
3. Read file directory entries
4. For each file:
   - Seek to `fileOffset`
   - Read `fileSize` bytes

---

# 2. Level File Workflow

The POD contains a level descriptor file (`.LVL`), which acts as a manifest.

## The LVL file references:

- Terrain data
- Object data file (contains definitions + placements)

## Workflow

```
1. Open POD
2. Locate .LVL file
3. Extract .LVL
4. Parse .LVL to find object data filename
5. Load object data file
```

---

# 3. Object Data File

This file contains:

1. Object definitions
2. Object placement list

---

## 3.1 Object Definitions

Each object type is defined in a table.

These definitions describe:

- Object type (tree, bunker, enemy, etc.)
- Behavior
- Model or sprite
- Attributes (HP, flags, etc.)

Objects in the level refer to these definitions by **index**.

---

## 3.2 Object Placement Format

Each placed object is stored as a CSV line:

```
objectType,hitPoints,worldX,worldY,worldZ,pitch,bank,heading
```

### Fields

| Field       | Description |
|------------|------------|
| objectType | Index into object definition table |
| hitPoints  | Object health |
| worldX     | X coordinate (fixed-point) |
| worldY     | Y coordinate / height (fixed-point) |
| worldZ     | Z coordinate (fixed-point) |
| pitch      | Rotation |
| bank       | Rotation |
| heading    | Rotation |

---

# 4. Coordinate System

## Grid Space

Terrain is defined as:

```
256 × 256 grid
```

Objects are placed on grid cells.

---

## Fixed-Point Coordinates

Object positions are stored using fixed-point integers.

### Conversion constants

```
X/Z scale = 1048576 (2^20)
Y scale   = 32768   (2^15)
```

---

## Conversion: File → Grid

```
gridX = worldX / 1048576
gridZ = worldZ / 1048576
height = worldY / 32768
```

### Bit-shift equivalent

```
gridX = worldX >> 20
gridZ = worldZ >> 20
height = worldY >> 15
```

---

## Conversion: Grid → File

```
worldX = gridX * 1048576
worldZ = gridZ * 1048576
worldY = height * 32768
```

### Bit-shift equivalent

```
worldX = gridX << 20
worldZ = gridZ << 20
worldY = height << 15
```

---

# 5. Placement Rules

## Snap-to-grid

Objects are aligned to terrain cells:

```
gridX ∈ [0..255]
gridZ ∈ [0..255]
```

No sub-cell positioning is used.

---

## Height Behavior

Object height is derived from terrain:

```
height = terrain[gridX][gridZ]
worldY = height * 32768
```

---

# 6. Object Type Mapping

Object type is an index:

```
objectType → objectDefinitions[objectType]
```

This maps to real objects such as:

- Trees
- Bunkers
- Enemies
- Structures

---

# 7. Full Parsing Pipeline

```
1. Open POD file
2. Read directory entries
3. Locate .LVL file
4. Extract and parse .LVL
5. Identify object data file
6. Load object data file
7. Read object definitions
8. Read object placement records
9. Convert coordinates
10. Build runtime objects
```

---

# 8. Common Mistakes

## Incorrect: using raw coordinates

```
gridX = worldX   // WRONG
```

## Correct

```
gridX = worldX >> 20
gridZ = worldZ >> 20
height = worldY >> 15
```

---

## Incorrect: treating values as pixels

These values are grid indices, not screen coordinates.

---

## Incorrect: axis confusion

Correct mapping:

```
X = worldX
Z = worldZ
Y = worldY (height)
```

---

# 9. Example

## Raw object line

```
12,100,125829120,2621440,47185920,0,0,90
```

## Converted values

```
type = 12
hp = 100

gridX = 120
gridZ = 45
height = 80
```

---

# 10. Recommended Data Model

```
class ObjectInstance {
    int type;
    int gridX;
    int gridZ;
    int height;
    int pitch;
    int bank;
    int heading;
}
```

---

# 11. Rendering Considerations

After conversion, apply your own scaling:

```
renderX = gridX * tileSize
renderZ = gridZ * tileSize
renderY = height * heightScale
```

---

# 12. Key Takeaways

- Object placement is grid-based
- Coordinates are fixed-point encoded
- POD contains level and data files
- Object type is an index, not a label
- Height comes from terrain
