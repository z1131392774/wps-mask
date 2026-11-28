# Masking behavior

*[中文](behavior_zh.md)*

How the add-in decides, writes and restores. Installation is in [README.md](../README.md); the encrypted table is in [storage.md](storage.md).

## Detection order

The engine reads the selection as one block and decides each column's mode by its values' JavaScript type:

1. Every non-blank value is a number → number.
2. Every non-blank value is text (including digit strings) → text, with the field name as its prefix.
3. Numbers and text together → mixed: numbers stay numbers, text gets non-numeric text.

A numeric-looking string stored as text stays text, never coerced on write-back.

A whole column spans row 1 to its last non-empty cell (`End(xlUp)`); a whole row stops at its last used column (`End(xlToLeft)`); blank columns are dropped.

## The header row

The checkbox 「首行是表头」 decides whether the first row is data: checked, row 1 is never masked and supplies the column name and text prefix; unchecked, row 1 is data. A fresh selection is guessed: checked when it starts at row 1, row 1 is non-empty and holds no number; position and type only, never wording. **One case stays ambiguous.** All-text data at row 1 is guessed as a header, so row 1 stays unmasked; the hint and the checkbox are the fix.

While row 1 is treated as a header, the checkbox is unconfirmed, and every column would be text, the panel appends: `；首行自动判定为字段名，若首行其实是数据，请取消勾选「首行是表头」`. Toggling the checkbox silences the hint; 「重新识别」 resets it and the hint returns.

## Masking and reverting

**Panel.** Select the range (whole column, whole row, or any block) and open "映射面板". It follows the selection; no refresh button. Each column gets a card — type and a sample in the header, parameters on demand. 「映射并写入」 replaces the range in place; 「反映射回原值」 restores the areas this add-in masked in the selection, leaving cells it never wrote untouched. Edited card settings survive a selection refresh: remembered per sheet and column position. Clearing records is the ribbon's 「清除脱敏记录」 button, not the panel.

**Repeated masking does not stack.** A cell is skipped only inside a masked range when its value reverses through the table; the status reports the count. Reverting subtracts what it restored, so a second revert finds nothing to write; to map current values again, revert first.

**Seeing what is masked.** A mask leaves a purple dashed outline around the block; inner grid lines stay. Reverting trims the outline with the block. 全部加边框 / 全部去边框 repaint or remove every outline — appearance only. They also clear purple from an older failed mask; a mask that writes nothing leaves borders alone.

Records live in the hidden table from the moment you mask; only a saved document keeps them.

Each edge's style is recorded in that save before any cell is written and written back on removal, so the user's borders survive. An edge with different styles across the block is unknown: not painted, and removal clears only cells still marked. If a protected sheet blocks painting, values are still written and the status appends `；区域边框没画上：…`. A mask repaints its new areas and any recorded areas they overlap; a refresh matching no area repaints the whole sheet.

**Quick buttons.** 「快速映射」 uses detection or remembered settings, skipping mapped cells and writing nothing when none remain. 「反映射」 restores recorded areas in the selection; cells it never masked keep their values, and with nothing to restore it says so.

**Messages.** The panel reports in its status line; the ribbon reports a successful quick action as a toast that stays until the next message, appending `。耗时 N 毫秒/秒。`. Success reads `已映射 12 格` (`，跳过 3 格`) or `已还原 12 格` (`，2 格没有映射记录`; a fake owned by two originals adds `，1 格有歧义未还原`). Failures open a dialog: `这个区域已经映射过，先执行「反映射」再映射。`, `没有可还原的映射，选区要和映射时一致。`, `脱敏记录保存失败：…，没有写入任何单元格，已撤回区域边框，请重新映射。`, `写入失败：…；已回滚，请重新映射。`, `写入失败：…；回滚未完成（…）…` plus `；回滚未完成，请按提示核对受损单元格。`, `写入失败：…；回滚后的脱敏记录没保存：…，请检查脱敏记录。` and `脱敏记录未保存：…，请勿关闭文档，重新映射前先检查脱敏记录。` A revert whose outline refresh failed adds `；区域边框没更新：…`; the outline buttons answer `已给 N 块区域加上边框` / `已去掉 N 块区域的边框`, or report none recorded.

**Clearing the records.** 「清除脱敏记录」 on the ribbon first asks `清除后，本文档中已脱敏的数据将无法还原。确定清除脱敏记录？`; after deleting it toasts `脱敏记录已清除。` (`已恢复 N 块区域的边框。`) `记得保存文档。` With no records it says `本文档没有脱敏记录。`; partial cleanup `脱敏记录已清除，但有些善后没做完：…。`; a refusal or failure is loud (`脱敏记录删不掉` / `清除脱敏记录失败：…`) and leaves the records in place. Clearing never un-masks: masked cells keep their fakes, and only a saved copy of the document brings the originals back.

**Conventions.** Masked values stay numeric (dates are serial numbers) and keep the format; reverse mapping writes the original type back. A text original is written with the host's `'` marker, so `008081` stays text with its format. Blank cells stay blank, leave-alone columns are skipped, decimals are kept and integer columns get integers.

## Mixed columns

A mixed column can hold numbers and text. Set it to "混合" and each cell is mapped by its JavaScript type: a number becomes a number from the column's numeric range; a text value becomes the field name plus digits, with a non-digit character guaranteed, so the host cannot coerce it. Buckets from an earlier version are reused, so an old document keeps fakes from an older generator. One-to-one holds: the original stays the key; reverting ignores the type that produced a value. When recorded fakes fill the numeric range, a later batch widens the upper bound so new numbers fit; a full range still errors.
