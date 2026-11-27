# Engine implementation details

*[中文](implementation_zh.md)*

The contracts behind [AGENTS.md](../AGENTS.md). Read this before changing generation, classification or the vault; rules keep one-liners there.

## One-to-one mapping

The table is keyed `n:`/`s:`/`b:` (number, string, boolean); probe `used[keyOf(candidate)]`, not `used[rawValue]`; a collision reverts wrongly. A loose index keeps coerced old fakes matchable; `used` records both forms.

When a numeric interval only just holds the distinct values, permute the column with `sattolo()` (one cycle, no fixed points); value-by-value generation forces the last onto itself; a fixed offset is the column rotated. `assignExact` computes the span before materialising: 1,000,000 is the ceiling, a non-finite bound is rejected, and a too-wide stretch falls back to random. An interval too small fails naming the column and header.

## Mixed columns

Values are typed, not shaped. A number becomes one from the column range; a string goes through `genText`, which appends digits to the field-name prefix and guarantees a non-digit character. On revert, `writeColumnParts` prefixes every string with `'`, the host's text marker, so `008081` survives a general-format cell unchanged. A mixed batch with full recorded slots widens `num.max`; the write-failure rollback reuses `textForWrite`.

## Vault format

`M1:`, `sigOf()` and `KEY_TEXT` are read by existing documents; change one and old buckets stop matching. Add a version field and migration in the same change, or say why orphans are fine. Every `sigOf()` field must change the output; one that only changes the signature silently renames everyone, as `lang` did.

Remembered `min`/`max` are data, not policy: union with the batch, grow only, then `absorbBucket()`. Keep a bucket ranges still reference; never fall back to the global index for a missing one — count those cells ambiguous. `pruneUnusedBuckets()` drops buckets no range references.

Saving is one write after a verified backup: the previous ciphertext goes to column B and is read back, then the new one goes to column A and is read back to compare; a failure rolls back or keeps the backup. Mapping, areas, settings and marks share that save; `prepareMask` paints the outline before it, and `abortMask` restores the pre-mask border state if the save fails. `checkWritten()` re-reads every written cell (loose type tolerance), so a silently dropped write fails the batch. A failed rollback keeps base records plus `partial` records per unrestored column — per-row planned fake and original key, plus the column signature; revert compares each cell with that fake, never through a bucket.

## Masked-area outline

`outlineAreas(vault)` unions row intervals per column (overlaps and adjacent records merge, signatures ignored), then identical-union adjacent columns. `readEdge()` returns `null` when line style, weight or colour is missing: a mixed edge is unknown, never painted or guessed. `clearMarkedEdge()` clears only marker-style cells, halves a mixed edge, and gives up after 4,096 blocks. The colour is the packed integer `15547004` (R124 G58 B237, #7C3AED); the hex literal reaches the host byte-reversed, measured red on device. `clearEdge()` writes colour, weight, then line style, because assigning weight can force the style back to solid. `refreshSheetMarks()` restores recorded styles, paints only known edges, and rolls a half-painted area back.

## Pane and ribbon rendering

The fallback layout avoids flex `gap` and CSS variables: the browser version is unknown; those fail silently. Grid is enhancement only, inside `@supports (display: grid)`; an old engine ignores the block and keeps the fallback unchanged. It shows only type, a sample and parameters; counts belong to the status bar, every state gets one sentence. Ribbon icons are SVG in `assets/icons/`, rendered to PNG by `tools/make-icons.mjs`; only `getImage` shows one, `image=` is ignored. Screenshot at 260, 300, 380 px with `node tools/preview-pane.mjs`.
