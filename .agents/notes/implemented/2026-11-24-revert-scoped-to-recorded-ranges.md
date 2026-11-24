# Note: Revert restores only the areas the table recorded

Status: implemented

*[中文](2026-11-24-revert-scoped-to-recorded-ranges_zh.md)*

## Problem

`revert()` built one index across every bucket and rewrote every value in the selection that reverse-mapped to some original. Three failures followed. A selection larger than the masked block restored cells the add-in had never written — visible as "revert changed my data". When two originals owned the same fake (cross-bucket, or a bucket merged during a migration), the first-wins index silently restored the wrong person. And running revert twice wrote the same cells twice, so an edited original could be overwritten by the second pass.

## Decision

The vault already records each written column as a rectangle with the signature used (`recordRange`, newest 200 kept). Revert now trusts that record:

- Only rectangles that overlap the selection are considered; a column with no recorded rectangle is skipped entirely.
- For a cell inside a rectangle, the signature of the last matching rectangle selects the bucket for that column; the lookup runs typed first, then loose, inside that bucket.
- The global index is used only as a last resort, and only when exactly one bucket owns the fake; if two originals do, the cell is left alone and counted `ambiguous` instead of guessing.
- Areas recorded before signatures existed (documents written by v1) fall back to the global index only when the upgrade dropped no records while merging buckets; if it dropped any, the cell is left alone and counted `ambiguous`, because a unique key may be missing its true original.
- Only columns with at least one hit are written, in continuous parts, so an unmasked column in an expanded selection is never rewritten.
- After restoring, the restored parts are subtracted from the recorded rectangles (`forgetRanges`), so a second revert finds nothing, writes nothing, and does not re-save.

The caller saves the trimmed vault after a revert that restored or disambiguated something; saving failure is reported loudly (`映射表未保存：…，请勿关闭文档…`).

## Alternatives considered

**Use the current card/column configuration as the signature.** Rejected: after the user edits a parameter, the recorded fakes were made under the old signature; the revert would look in the new bucket first and miss.

**Keep the global first-wins index and document the ambiguity.** Rejected: a wrong restore is silent and irreversible from the user's point of view; leaving the cell alone and counting it is honest and testable.

**Restore everything that reverse-maps, as before.** Rejected: that is the expanded-selection bug.

**Keep the rectangles after a revert.** Rejected: the next mask would treat restored cells as already masked and skip them, and a second revert would rewrite data the user may have edited since.

## Consequences

The user-visible results are `没有可还原的映射，选区要和映射时一致。` when nothing matches (including a second click), `已还原 N 格` with `，M 格未命中` and `，K 格有歧义未还原` tails, and `映射表未保存：…` when the trimmed table cannot be saved. Selections may now be expanded safely: only recorded areas change.

Both write directions verify what the host actually stored: `writeColumn()`/`writeColumnParts()` read the block back and throw `写入后读回不一致` when it differs, so a host that silently drops assignments cannot become a fake success. A failed revert therefore leaves the rectangles in place and can be retried; it never trims a range whose cells were not restored. Two limits remain by construction: documents whose vault predates `ranges` have nothing to restore until they are masked again ([skip records](2026-11-24-skip-already-masked-cells.md)), and the newest-200 cap means old areas drop out of the revert path. Engine tests [33], [34], [36]–[39] pin the scoping, the ambiguity rule, bucket survival across interval widening, and the read-back check; pane group [19] covers the second-click no-op.
