# Note: The marks field needs no vault version bump

Status: implemented

*[中文](2026-11-25-marks-without-version-bump_zh.md)*

## Problem

The marker outline stores its pre-mask border styles in the vault, which adds a `marks` field to the encrypted JSON. The vault-format rule says a change to the format needs a version field and a migration in the same change, or a note explaining why the orphans are fine. Old documents have no `marks`, so a reader that required it would treat them as damaged.

## Decision

`marks` is additive, optional data, so the vault stays at version 2:

- `loadVault()` fills a missing `ranges` or `marks` with `[]`; a document written before the outline loads as "nothing was ever painted", which is exactly true.
- No existing key changes meaning and no bucket key changes, so there is nothing to migrate. The only effect of an old vault is that its already-masked areas have no outline until they are masked again.
- New saves always write `marks`, so the field appears the first time the add-in saves a table.
- The mixed-edge rule lives with the field: `readEdge()` returns `null` when line style, weight or colour is missing, because the host cannot express one style for an edge whose cells disagree. A `null` edge is unknown — never painted, and cleared only where the marker style is still present.
- `marks` travels in the same single save as the mapping and the areas; `prepareMask` paints and records before that save and `abortMask` restores the pre-mask border state when the save fails. `writeMask` rolls cells, ranges and marks back together through `restoreMaskBase()`.
- The colour is the packed integer `15547004` (R124 G58 B237, `#7C3AED`), not the hex literal: the host reads `Border.Color` in RGB byte order, and the hex value measured red on a real device.

## Alternatives considered

**Bump `VAULT_VERSION` to 3 and migrate by filling `marks: []`.** Rejected: there is no data to transform, only an absent optional field; a bump would force every reader to handle a new version for a field that defaults correctly. Version 2 already exists for the real v1→v2 bucket rename.

**Store the border styles outside the vault** (a second hidden sheet, a separate file). Rejected: no governed format home, it would not travel with the workbook through `dropVault()`, and the vault's save/backup guarantees would not cover it.

**Repaint outlines for old vaults when they load.** Rejected: it needs host work on open and would have to guess styles that were never recorded, painting over the user's borders.

## Consequences

`loadVault()` defaults the field and `tryParseVault()` does not reject its absence; the loader still rejects an empty main ciphertext once a table exists. Tests group [31] pins the new-document-versus-damaged distinction, and groups [45], [51]–[53] cover painting, stale-record cleanup and drop. Any future change to `marks` follows the vault rule again: a version bump and migration in the same change, or another note like this one.
