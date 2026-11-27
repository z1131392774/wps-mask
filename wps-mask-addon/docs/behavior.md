# Masking behavior

*[中文](behavior_zh.md)*

How the add-in decides, writes and restores. Installation is in [README.md](../README.md); the encrypted table is in [storage.md](storage.md).

## Detection order

The engine reads the selection as one block and decides each column's mode by its values' JavaScript type:

1. Every non-blank value is a number → number.
2. Every non-blank value is text (including digit strings) → text, with the field name as its prefix.
3. Numbers and text together → mixed: numbers stay numbers, text gets non-numeric text.

The type is the JavaScript type, not the shape: a phone, email or zero-padded account stored as text is text, so numeric-looking text is never coerced on write-back.

A whole column spans row 1 to its last non-empty cell (`End(xlUp)`); a whole row stops at its last used column (`End(xlToLeft)`); blank columns are dropped.

## The header row

The first row is a header only when 「首行是表头」 is checked, or, unchecked, when detection guesses it: mostly text, a field keyword, a number just below, or a selection starting at row 1. **Detection can guess wrong.** A first data row with 备注 or similar wording is taken for a header and left unmasked — the table looks masked, its first row intact. Read the panel's 「首行为字段名」 / 「无表头」 label before writing; uncheck the box to mask the first row as data.

When the guess is weak — a detected header, every column plain text, an untouched checkbox — the panel appends: `；首行自动判定为字段名，若首行其实是数据，请取消勾选「首行是表头」`. Toggling the checkbox silences the hint; 「重新识别」 guesses again and the hint returns.

## Masking and reverting

**Panel.** Select the range (whole column, whole row, or any block) and open "映射面板". It follows the selection; no refresh button. Each column gets a card — type and a sample in the header, parameters on demand. 「映射并写入」 replaces the range in place; 「反映射回原值」 restores the areas this add-in masked in the selection, and cells it never wrote are left untouched. Edited card settings survive a selection refresh: remembered per sheet and column position.

**Repeated masking does not stack.** A cell is skipped only when it lies in a range this add-in has written and its value reverses through the table; the status reports the count, so masking in stages never processes a cell twice. Reverting subtracts what it restored, so a second revert finds nothing to write. To map current values again, revert first.

**Seeing what is masked.** A mask leaves a purple dashed outline around the block; inner grid lines stay untouched. Reverting trims the outline with the block. 全部加边框 / 全部去边框 repaint or remove every outline — appearance only. They also clear purple from an older failed mask; a mask that writes nothing leaves every border alone.

Records live in the hidden table from the moment you mask; only a saved document keeps them.

Each edge's style, weight and colour is recorded in that save before any cell is written and written back on removal, so the user's borders survive. An edge whose style differs across the block is unknown: it is not painted, and removal clears only cells still in the marker style. If a protected sheet blocks painting, values are still written and the status appends `；区域边框没画上：…`. A mask that writes cells repaints the new areas and any recorded area they overlap or merge into; unrelated areas stay. 「全部加边框」 still repaints every recorded area. A refresh whose filter matches no recorded area repaints the whole sheet instead of skipping.

**Quick buttons.** 「快速映射」 uses detection or remembered settings, skipping mapped cells and writing nothing when none remain. 「反映射」 restores recorded areas in the selection; cells it never masked keep their values, and with nothing to restore it says so.

**Messages.** The panel reports in its status line; the ribbon reports a successful quick action as a toast that stays until the next message and appends `。耗时 N 毫秒/秒。`. Success reads `已映射 12 格` (`，跳过 3 格`) or `已还原 12 格` (`，2 格没有映射记录`; a fake owned by two originals adds `，1 格有歧义未还原`). Failures open a dialog: `这个区域已经映射过，先执行「反映射」再映射。`, `没有可还原的映射，选区要和映射时一致。`, `映射表保存失败：…，没有写入任何单元格，已撤回区域边框，请重新映射。`, `写入失败：…；已回滚，请重新映射。`, or `写入失败：…；回滚未完成（…）；只有第 N 列未能回滚，映射记录只保留失败列…` plus the panel's `；回滚未完成，请按提示核对受损单元格。` — a failed rollback keeps records only for that column, and revert checks those cells one by one against the planned fakes, counting skipped cells as `skippedPartial`. Other failures: `写入失败：…；回滚后的映射表没保存：…，请检查映射表。` and `映射表未保存：…，请勿关闭文档，重新映射前先检查映射表。` A revert whose outline refresh failed adds `；区域边框没更新：…`; the outline buttons answer `已给 N 块区域加上边框` / `已去掉 N 块区域的边框`, or say nothing was recorded.

**Conventions.** Blank cells stay blank; columns set to "leave alone" are skipped. Numeric cells read back as serial numbers (a date is one), so masked values stay numeric and the format untouched; reverse mapping writes the original type back. A text original is written back with the host's `'` marker, so `008081` stays text and keeps its format. Number mapping keeps the column's decimal places; integer columns get integers.

## Mixed columns

A mixed column can hold numbers and text. Set it to "混合" and each cell is mapped by its JavaScript type: a number becomes a number from the column's numeric range; a text value becomes the field name plus digits, with a non-digit character guaranteed, so the host cannot coerce it. Phone numbers, emails, landlines and zero-padded codes stored as text are plain text, not kept in their original shape. Buckets recorded by an earlier version are reused as recorded, so an old document re-masked now can keep the old shapes. One-to-one holds: the original stays the key, and reverting ignores the type that produced a value. When recorded fakes fill the numeric range, a later batch widens its upper bound so new numbers fit; a truly full range still errors.
