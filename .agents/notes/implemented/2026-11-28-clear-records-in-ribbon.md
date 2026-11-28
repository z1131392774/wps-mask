# Note: Clearing the masking records moves to the ribbon

Status: implemented

*[中文](2026-11-28-clear-records-in-ribbon_zh.md)*

## Problem

The person using the workbook is a spreadsheet user, not an implementer: "映射表" is our word for the hidden worksheet that holds the encrypted records, and a user looking for a way to discard this document's masking data has no reason to connect that term to a footer link. The only such entry — a small "clear this document's mapping table" link at the bottom of the panel — was easy to miss, and it also had to be protected from every panel layout change: a destructive action kept in a scrolling footer competes with whatever the panel displays next.

## Decision

Deleting the records becomes a ribbon action with its own group:

- The 「数据脱敏」 tab gains a 「脱敏记录」 group with one large button, 「清除脱敏记录」 (`btnMaskClearRecords`, `images/clear.png`), beside the mapping and border groups. The panel no longer offers deletion; its footer link is gone and its help text points at the ribbon group.
- The click runs in this order: read-only pre-check (a read-only document would silently not persist the delete, so it is refused first), then the confirmation `清除后，本文档中已脱敏的数据将无法还原。确定清除脱敏记录？`, then the delete and the outline restore. A confirm that is unavailable or throws counts as "no": a failed dialog never deletes.
- Every user-visible sentence — save, load, damage, rollback, clear — says 「脱敏记录」. The hidden worksheet keeps its name 「脱敏映射表」: existing documents are recognized by that name, and renaming it would make them look like new documents with no records. The internal names (`VAULT_SHEET`, `dropVault`) also stay.
- The outcome is always stated: no records gives `本文档没有脱敏记录。`; success toasts `脱敏记录已清除。` plus `已恢复 N 块区域的边框。` when outlines were restored, plus `记得保存文档。`; partial cleanup says `脱敏记录已清除，但有些善后没做完：…。`; a failed delete says `清除脱敏记录失败：…` and re-hides the sheet instead of pretending it was removed.
- Clearing is not an undo: it deletes the ability to restore. Masked cells keep their fake values, no original is written back, and a saved copy of the document is the only way back.

## Alternatives considered

**Keep the panel entry and only rename it.** Rejected: it stays buried at the bottom, still competes with the panel layout, and a destructive action needs a home a user can find without scrolling — the reason it was hard to discover in the first place.

**Call it 「清除还原备份」.** Rejected: "backup" suggests another copy still exists and names the storage rather than the consequence; it reads safer than the action is.

**Keep both entries, panel and ribbon.** Rejected: two paths to an irreversible delete mean two confirmations, two messages and two places to keep in step; one obvious home is simpler and safer.

**Rename the hidden worksheet as well.** Rejected: existing workbooks identify their table by name; a new name would orphan their records and lose every restore.

## Consequences

The entry is visible and the wording states the consequence in a term a table user understands. Existing documents are untouched — the sheet name, the ciphertext format and the internal API are unchanged, so no migration is involved; only wording changed. The confirmation and the read-only pre-check are now the safety net, and both leave the records intact when they refuse. The ribbon test suite grew a direct case ([16]): confirm → delete → restore outlines → toast, plus cancel, read-only refusal, no-records message, partial cleanup and a failed delete that keeps the sheet but reports loudly; the panel suite ([7]) pins that deletion is no longer there. What is not verified on a device: whether a third ribbon group still fits at narrow window widths, and the button itself cannot be clicked from outside (see [verification](../../../wps-mask-addon/docs/verification.md)).
