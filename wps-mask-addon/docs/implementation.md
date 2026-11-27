# Engine implementation details

*[中文](implementation_zh.md)*

The contracts behind the rules in [AGENTS.md](../AGENTS.md). Read this before changing generation, classification or the vault format; the rules file keeps the one-line rules and links here for the reasoning and the traps.

## One-to-one mapping

The table is keyed `n:`/`s:`/`b:` (number, string, boolean); probe `used[keyOf(candidate)]`, not `used[rawValue]`, or a colliding key reverts to the wrong original (one run in sixteen did).

When a numeric interval only just holds the distinct values, permute the whole column with `sattolo()` (one cycle, no fixed points); generating value by value forces the last one onto itself, and a fixed offset is the original column rotated. `assignExact` computes the span before materialising: 1,000,000 is the ceiling, a non-finite bound is rejected, and a too-wide stretch falls back to random assignment. An interval too small fails naming the column by letter and header.

## Mixed columns

Values are typed, not shaped. A number becomes one from the column range; a string goes through `genText`, which appends digits to the field-name prefix and guarantees a non-digit character. On revert, `writeColumnParts` prefixes every string with `'`, the host's text marker, so `008081` survives a general-format cell with format unchanged. Revert stays keyed on the original.

## Vault format

`M1:`, `sigOf()` and `KEY_TEXT` are read by existing documents; change one and old buckets stop matching. Add a version field and migration in the same change, or say in the note why orphans are fine. Every `sigOf()` field must change the output; one that only changes the signature silently renames everyone, as `lang` did.

Remembered `min`/`max` are data, not policy: union with the current batch, grow only, then `absorbBucket()`. Keep a bucket that ranges still reference; never fall back to the global index for a missing recorded bucket — count those cells ambiguous. `pruneUnusedBuckets()` drops a bucket once no range references it.

Saving is one write after a verified backup: the previous ciphertext is copied to column B and read back, then the new ciphertext is written to column A, read back and decrypted to compare; a failure rolls back or keeps the backup. Mapping, areas, settings and marks go into that one save; `prepareMask` paints the outline before it, and `abortMask` restores the pre-mask border state if the save fails. `checkWritten()` re-reads every written cell (with loose type tolerance) so a host that silently drops a write fails the batch instead of reporting success.

## Masked-area outline

`outlineAreas(vault)` unions row intervals per column (overlaps and adjacent records merge, signatures ignored), then merges adjacent columns with identical row unions. `readEdge()` returns `null` when line style, weight or colour is missing: a mixed edge is unknown, neither painted nor guessed. `clearMarkedEdge()` clears only cells still in the marker style, halves a mixed edge, and gives up after 4,096 blocks. The colour is the packed integer `15547004` (R124 G58 B237, #7C3AED); the hex literal reaches the host byte-reversed and measured red on device. `clearEdge()` writes colour, weight, then line style, because assigning weight can force the style back to solid. `refreshSheetMarks()` restores recorded styles, paints only known edges, and rolls a half-painted area back.

## Pane and ribbon rendering

The pane avoids flex `gap`, CSS variables and grid: the browser version is unknown and those fail silently. It shows only type, a sample and parameters; counts belong to the status bar, and every state gets one sentence. Ribbon icons are SVG in `assets/icons/`, rendered to PNG by `tools/make-icons.mjs`; only a `getImage` callback shows one, `image=` is ignored. Screenshot at 260, 300 and 380 px with `node tools/preview-pane.mjs`.
