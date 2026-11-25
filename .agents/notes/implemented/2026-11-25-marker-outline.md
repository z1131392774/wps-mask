# Note: A purple outline shows every masked area

Status: implemented

*[中文](2026-11-25-marker-outline_zh.md)*

## Problem

After a mask the sheet showed nothing about which areas the add-in had written. The only way to see the masked state was to open the panel and read the selection, and a user who had left the document for a while could not tell masked blocks from edited ones. An earlier design kept a separate area list to drive this, but it went stale as soon as areas were reverted or edited, and it could not tell the user's own borders from the marker's.

## Decision

A successful mask paints a marker on every area it records:

- Four edges, dashed, medium weight, colour `15547004` — the packed RGB integer for R124 G58 B237, `#7C3AED`. The host reads `Border.Color` as a packed integer; handing it the hex literal `0x7C3AED` paints the bytes reversed, which measured red on a real device.
- The pre-mask style of each edge is recorded in `vault.marks` at mask time, so revert and 全部去边框 can write the user's borders back instead of clearing them.
- Painting happens after generation and before the single vault save; if that save fails, `abortMask` restores the pre-mask border state and no cell is written.
- A mixed edge (the host cannot express one style for the whole edge) is unknown: it is not painted, and cleanup clears only cells still in the marker style instead of guessing a style for the rest.
- 全部加边框 / 全部去边框 on the ribbon repaint or remove every outline, clean up purple left by older failed runs, and touch no cell value and no masked record. A mask that writes nothing leaves borders alone, because it must not replay over manual border edits.

## Alternatives considered

**Keep the panel as the only view of masked areas.** Rejected: the whole point is to see the masked state without opening anything, and a user cannot find a stale block from the panel.

**Keep an explicit area-list worksheet or range.** Rejected: it duplicates the recorded rectangles, goes stale when areas are reverted, and still cannot distinguish a user border from the marker.

**Save the border records in a second save after the cells are written.** Rejected: the second save adds another failure window in which the values are already masked and the styles are not stored; the vault already goes through one atomic save before any cell is written.

**Clear the whole edge when removing an outline.** Rejected: on a mixed edge that would wipe the user's own borders. Clearing only marker-styled cells keeps them.

## Consequences

`vault.marks` is part of the vault ([why it needs no version bump](2026-11-25-marks-without-version-bump.md)), and `outlineAreas()` unions recorded rectangles so overlapping records paint once. `dropVault()` restores the outlines before deleting the hidden sheet and reports per-sheet failures. The 200-area cap and the name-only table lookup still apply to the outline. Engine groups [44]–[58] and the ribbon suite pin the painting, restore, mixed-edge, overlap, colour-byte and read-only behaviour; the real-device colour row in [verification](../../../wps-mask-addon/docs/verification.md#measured-on-a-real-device) records the byte-order fix.
