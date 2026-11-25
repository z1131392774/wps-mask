# Masking behavior

*[中文](behavior_zh.md)*

How the add-in decides what to mask, what it writes, and what a revert restores. Installation and the feature map stay in [README.md](../README.md); the encrypted table is in [storage.md](storage.md).

## Detection order

The engine reads the selection as one block and decides each column's mode in this order:

1. Any value is an email or a landline number → mixed.
2. A matched field name with at least half the values mobile-shaped → phone.
3. Without a name match, at least 60% of the values mobile-shaped → phone.
4. The field name matches, whatever the values are → phone.
5. At least 80% of the values are numeric → number.
6. At least two of the mobile / plain-digits / letters-and-digits / text families appear → mixed.
7. Anything else → text, with the field name as its prefix.

A whole column becomes row 1 to its last non-empty cell (`End(xlUp)`); a whole row stops at its last used column (`End(xlToLeft)`); entirely blank columns are dropped.

## The header row

The first row is a header only when 「首行是表头」 is checked, or, unchecked, when detection guesses it: mostly text, plus a field keyword, a number just below, or a selection starting at row 1. **Detection can guess wrong.** A first data row that happens to contain 备注 or similar wording is taken for a header and left unmasked — the table then looks masked while its original first row is intact. Read the panel's 「首行为字段名」 / 「无表头」 label before writing, and uncheck the box to mask the first row as data.

When the guess is weak — the header was detected, every column would be plain text, and you have not touched the checkbox — the panel appends a warning: `；首行自动判定为字段名，若首行其实是数据，请取消勾选「首行是表头」`. Toggling the checkbox settles the reading and silences the hint; 「重新识别」 makes the add-in guess again, and the hint can come back.

## Masking and reverting

**Panel.** Select the range (whole column, whole row, or any block) and open "映射面板". It reads the selection and updates when it changes; there is no refresh button. Each column gets a card — detected type and a sample in the header, parameters on demand. 「映射并写入」 replaces the range in place; 「反映射回原值」 restores the areas this add-in masked in the selection, and cells it never wrote are left untouched. Card settings you edit survive a selection refresh: they are remembered per sheet and column position.

**Repeated masking does not stack.** A cell is skipped only when it lies in a range this add-in has already written and its value reverses through the table; the status line reports the count, so masking part then the whole never processes a cell twice. Reverting subtracts the restored parts from those records, so a second revert finds nothing to write. To map current values again, revert first.

**Quick buttons.** 「快速映射」 uses detection or the remembered settings on the current selection, skipping mapped cells the same way and writing nothing when none remain. 「反映射」 restores the areas recorded in the selection; cells it never masked keep their values, and with nothing to restore it says so instead of writing.

**Messages.** Quick actions report success in the status bar, e.g. `已映射 12 格` (`，跳过 3 格`) or `已还原 12 格` (`，2 格没有映射记录`; a fake owned by two originals adds `，1 格有歧义未还原`). A failure opens a dialog instead: `这个区域已经映射过，先执行「反映射」再映射。` when nothing new can be mapped, `没有可还原的映射，选区要和映射时一致。` when the selection holds no recorded area, `映射表保存失败：…，没有写入任何单元格，请重新映射。`, `写入失败：…；已回滚，请重新映射。` (with `回滚未完成` when it could not undo), or `映射表未保存：…，请勿关闭文档，重新映射前先检查映射表。` The panel reports the same outcomes on its status line and appends `，记得保存文档。` after a mask.

**Conventions.** Blank cells stay blank. Columns set to "leave alone" are skipped entirely. Numeric cells read back as serial numbers (a date is one), so masked values stay numeric and the cell format is untouched; reverse mapping writes the original type back. Number mapping keeps the column's decimal places; integer columns get integers.

## Mixed columns

Account columns often mix mobiles, emails, landlines, and order codes. Set it to "混合" and each cell is handled by its own shape: a mobile becomes a valid mobile; an email becomes `u` plus six digits with its domain kept; a landline keeps area code, separator, digit count, and extension; a digit run keeps its length and leading zero; a letter-digit code is re-lettered character by character (`kf_2024_001` → `ud_9309_739`); anything else falls back to "field name + digits". One-to-one holds — the original stays the key, and reverting ignores the shape that produced a value. Two limits: the email domain stays visible, and a very short code such as `a1` can exhaust its shape space, which the add-in reports instead of repeating a value.
