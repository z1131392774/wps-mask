# Note: The mapping table is saved before any cell is written

Status: implemented

*[中文](2026-11-24-two-phase-mask_zh.md)*

## Problem

`applyMask()` planned, generated and wrote in one call, and its callers saved the vault afterwards. Two failure windows followed. If the save failed, the cells were already masked while the mapping table was not updated, so the workbook held fakes nobody could revert. If a write failed part-way, the vault had already recorded the ranges and values it thought it had written, and the sheet held a mix of masked and original cells — the next mask then treated the half-written area as done.

## Decision

Split the operation at the point where state becomes durable:

- `prepareMask(model, vault)` builds the mapping, records the written ranges, remembers the settings and paints the outline, recording each edge's pre-mask style in `vault.marks`. It returns a plan and touches no cell value. The mapping, the areas and the marks are one batch, so a successful mask needs one vault save, not two.
- The caller saves the vault once (atomic — see [the vault save note](2026-11-24-atomic-vault-save.md)). If that save fails, `abortMask(plan)` restores the pre-mask border state, nothing is written to the sheet and the caller does not save again.
- `writeMask(plan)` writes one `Value2` block per column. On a host error it rewrites the columns already written back to their originals, restores `vault.ranges` and `vault.marks` together through `restoreMaskBase()`, and throws with a `rollback` record. The caller saves the restored vault again, and reports a failed re-save loudly.
- `applyMask()` remains as a thin wrapper (`prepare` plus, unless `dryRun`, `write`) for tests and one-call callers.

The panel and both quick buttons call the steps in that order and update `state.vault` only after the save succeeds.

## Alternatives considered

**Write, then save, and undo the cells if the save fails.** Rejected: the undo needs the originals, which are exactly what the vault was supposed to hold; after a crash neither copy exists.

**Keep `applyMask` and save inside the engine.** Rejected: the engine is host-agnostic and has no `saveVault` of its own; mixing storage with generation also made the dry-run path need a flag that changed write behavior.

**Write cell by cell to shrink the rollback window.** Rejected: per-cell writes are an order of magnitude slower on the host, and they make partial state more likely, not less.

**Record the outline styles in a second save after the cells.** Rejected: the cells would be masked while the styles were still unsaved, and the second save would add another failure window; painting before the one save and aborting on failure keeps one durable step.

## Consequences

`engine.js` exports `prepareMask`, `writeMask` and `abortMask` next to `applyMask`; the tests drive each half directly (engine groups [28], [46] and [47]). The order is a contract for every caller, not a suggestion: saving between prepare and write is what guarantees "a save failure writes no cell", and `abortMask` is what takes the painted outline back when that save fails. A write failure rolls the written cells back. A clean rollback restores the recorded ranges and marks to their pre-mask state; a rollback that also fails keeps records only for the columns it could not restore — one per-column `partial` snapshot of the planned fakes and their bucket keys — while the marks stay as a damage hint. Reverting such a record checks the cells one by one against the snapshot instead of looking a value up in a bucket, so a column that did roll back cleanly cannot have its originals mistaken for fakes.

The user-visible error texts follow the split: `映射表保存失败：…，没有写入任何单元格，已撤回区域边框，请重新映射。` and `写入失败：…；已回滚，请重新映射。` (a failed rollback names the column that could not be restored, says the other columns are back, and the panel appends `；回滚未完成，请按提示核对受损单元格。`), with a failed re-save appended as `；回滚后的映射表没保存：…，请检查映射表。`.
