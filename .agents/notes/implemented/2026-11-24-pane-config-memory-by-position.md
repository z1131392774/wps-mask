# Note: The pane remembers edited column settings by sheet and position

Status: implemented

*[中文](2026-11-24-pane-config-memory-by-position_zh.md)*

## Problem

The pane re-reads the selection on every change and rebuilds the cards. To keep the user's parameter edits across those refreshes it snapshotted edited configurations under the column header. Two collisions followed: headerless columns all key on the empty string, so every headerless column looked like the same column; and two sheets can share a header such as 姓名, so an interval edited on one sheet was carried to the other. The carried interval could be too small for the new sheet's values, which produced capacity errors or a different set of fakes for the same people.

## Decision

Key the snapshot by sheet name plus column position (`cfgKey(sheetName, col)`), and keep only the columns the user actually edited (`state.edited`). Untouched columns go through `hydrate()` again, so they pick up the remembered settings that belong to the new selection. A full refresh — changed selection, 重新识别, or dropping the table — clears `state.edited` first.

**Updated 2026-11-28:** clearing now runs from the ribbon's 「清除脱敏记录」, not the panel ([clear records in the ribbon](2026-11-28-clear-records-in-ribbon.md)).

## Alternatives considered

**Key by header only.** Rejected: that is the collision above.

**Key by index only.** Rejected: switching sheets with the same column count would carry settings across documents' sheets.

**Never preserve edits; let the user re-enter them.** Rejected: the pane refreshes on selection change, and losing every edit on a stray click makes the panel unusable.

**Store the snapshot in the vault.** Rejected: the vault is document state, and these are unsaved UI edits; writing them would make a selection carry unconfirmed parameters into the document.

## Consequences

Renaming or inserting a column loses that column's session edit and re-derives it from the vault — the safe direction. Pane groups [14] and [15] pin the headerless case and the two-sheets-same-header case. The document-level remembered settings remain keyed by header (`rememberSettings`), because those are meant to follow a field across selections; only the in-session snapshot uses position.
