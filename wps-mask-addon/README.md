# Data masking add-in for WPS Spreadsheet

*[中文](README_zh.md)*

Select a range and replace every value with realistic fake data; the originals are stored encrypted in the workbook and restored with one click.

## Features, mapped to the requirements

| Requirement | Implementation |
| --- | --- |
| Pick a range, map its data to random values | Ribbon tab "数据脱敏" → mapping panel, or the panel-free "快速映射" button |
| One-to-one: the same value always maps to the same result | The table stores `original → mapped`; a repeat original resolves to its recorded entry, and distinct originals always get distinct results. Collisions are retried; an undersized value space fails with an error, never a duplicate |
| Two kinds of mapped value: number and text | "Map to" dropdown per column: phone, number, text, mixed, leave alone |
| Numbers take parameters, uniform by default | Uniform (default), normal (mean/sd, outliers folded back into the interval), exponential (λ sets the decay); bounds and decimal places editable |
| Phone numbers must be valid | 11 digits: a real 3-digit mobile prefix (e.g. 138, 150, 186) plus 8 random digits, unique within the column and never equal to the original |
| Text is a prefix plus a random numeric suffix | Prefix defaults to the field name (e.g. 姓名37) and stays editable. Suffix digits default to the fewest that hold this column's non-blank cells with 10% headroom, so 41 customers get 姓名37, never 姓名0037; editable 1–8 |
| Auto-detect the field name and type | Field-name keywords, email and landline shapes, a mobile or numeric majority, then a text fallback — the exact order is under [Detection order](#detection-order). Whole-column and whole-row selections are trimmed to their used cells first |
| One-click reverse mapping, mapping stored encrypted | "反映射回原值" looks each cell up in the encrypted table and writes the original back, preserving number/text type and blanks. It only touches areas this add-in recorded as masked: expanding a selection is safe, and a second click is a no-op. A fake value that two originals could own is left alone and counted. The table is AES-128-CBC ciphertext in a hidden worksheet |
| Remember the last settings for this document | Per-field type, distribution, parameters, and prefix are stored in the same encrypted blob, keyed by field name; a numeric interval only grows (union with the current data), so a wider column elsewhere never trips the old range; "重新识别" ignores them and re-detects |

### Detection order

The engine reads the selection as one block and decides each column's mode in this order:

1. Any value is an email or a landline number → mixed.
2. A matched field name with at least half the values mobile-shaped → phone.
3. Without a name match, at least 60% of the values mobile-shaped → phone.
4. The field name matches, whatever the values are → phone.
5. At least 80% of the values are numeric → number.
6. At least two of the mobile / plain-digits / letters-and-digits / text families appear → mixed.
7. Anything else → text, with the field name as its prefix.

A whole column becomes row 1 to its last non-empty cell (`End(xlUp)`); a whole row stops at its last used column (`End(xlToLeft)`); entirely blank columns are dropped.

The first row is a header only when 「首行是表头」 is checked, or, unchecked, when detection guesses it: mostly text, plus a field keyword, a number just below, or a selection starting at row 1. **Detection can guess wrong.** A first data row that happens to contain 备注 or similar wording is taken for a header and left unmasked — the table then looks masked while its original first row is intact. Read the panel's 「首行为字段名」 / 「无表头」 label before writing, and uncheck the box to mask the first row as data.

When the guess is weak — the header was detected, every column would be plain text, and you have not touched the checkbox — the panel appends a warning: `；首行自动判定为字段名，若首行其实是数据，请取消勾选「首行是表头」`. Toggling the checkbox settles the reading and silences the hint; 「重新识别」 makes the add-in guess again, and the hint can come back.

## Install

The add-in directory is `%APPDATA%\kingsoft\wps\jsaddons` (`Win+R`, type `%appdata%`, then `kingsoft\wps\jsaddons`; create it if absent).

No Node.js, npm, or `wpsjs` is needed: the add-in is plain files, and these three steps are the whole installation.

1. Copy the whole `wpsmask_1.0.0` folder in. **Do not rename it** — `name_version` is how WPS finds the add-in.
2. Handle the manifest `publish.xml`:
   - not present → copy `wps-mask-addon/publish.xml` from this repository;
   - already present (another add-in is installed) → **do not overwrite**, add this line inside `<jsplugins>`:

   ```xml
   <jsplugin name="wpsmask" type="et" url="wpsmask_1.0.0" version="1.0.0" enable="enable" install="null" customDomain="" debug=""/>
   ```
3. Restart WPS; the "数据脱敏" tab appears. WPS may ask you to trust the add-in once.

Resulting tree:

```
jsaddons\
├─ publish.xml
└─ wpsmask_1.0.0\
   ├─ index.html        entry page
   ├─ main.js           script loader
   ├─ ribbon.xml        ribbon definition
   ├─ images\           ribbon icons: panel, quick, revert, each with an @2x copy
   ├─ js\
   │   ├─ utils.js      host object, resource path
   │   ├─ aes.js        AES-128-CBC, plain JS
   │   ├─ engine.js     detection, generation, mapping, storage
   │   └─ ribbon.js     button callbacks
   └─ taskpane\
       ├─ index.html    mapping panel
       ├─ taskpane.css
       └─ taskpane.js
```

The SVG sources under `assets/icons/` are repository-only; only the PNGs are copied.

If `wpsjs` is installed (not required), its generated `publish.xml` also works; `wpsjs debug` loads the add-in.

### Develop without copying

Edits here take effect only after the files reach `jsaddons`. `tools/link-addon.ps1` replaces the copied folder with a junction to this directory, so WPS reads the working tree and a restart picks up changes:

```powershell
powershell -File tools/link-addon.ps1            # old folder kept as .bak-<timestamp>
powershell -File tools/link-addon.ps1 -Rollback  # remove it, put the backup back
```

A junction needs no admin rights or developer mode; a hard link cannot point at a folder. Close WPS first — the rename fails while the add-in is loaded.

## Usage

**Panel.** Select the range (whole column, whole row, or any block) and open "映射面板". It reads the selection and updates when it changes; there is no refresh button. With no selection it shows a hint and disables both write buttons. Each column gets a card — detected type and a sample in the header, parameters on demand — then "映射并写入" replaces the range in place, and "反映射回原值" restores the areas this add-in masked in the selection; cells it never wrote are left untouched. Card settings you edit survive a selection refresh: they are remembered per sheet and column position.

**Header row.** The checkbox 「首行是表头」 decides whether the first row is data. Checked: row 1 is never masked, and supplies the column name and the text prefix. Unchecked: row 1 is data, and detection may still guess it as a header — see [Detection order](#detection-order), which also explains the warning shown when that guess is weak. The panel shows 「首行为字段名」 or 「无表头」 for the current reading; check it before writing.

**Repeated masking does not stack.** A cell is skipped only when it lies in a range this add-in has already written and its value reverses through the table; the status line reports the count, so masking part then the whole never processes a cell twice. Reverting subtracts the restored parts from those records, so a second revert finds nothing to write. To map current values again, revert first.

**Quick buttons.** "快速映射" uses detection or the remembered settings on the current selection, skipping mapped cells the same way and writing nothing when none remain. "反映射" restores the areas recorded in the selection; cells it never masked keep their values, and with nothing to restore it says so instead of writing.

**Messages.** Quick actions report success in the status bar, e.g. `已映射 12 格` (`，跳过 3 格` when some cells already held fakes) or `已还原 12 格` (`，2 格没有映射记录`; a fake owned by two originals adds `，1 格有歧义未还原`). A failure opens a dialog instead: `这个区域已经映射过，先执行「反映射」再映射。` when there is nothing new to map, `没有可还原的映射，选区要和映射时一致。` when the selection holds no recorded area, `映射表保存失败：…，没有写入任何单元格，请重新映射。` when the table could not be saved, `写入失败：…；已回滚，请重新映射。` when the host rejected a write (with `回滚未完成` instead of `已回滚` when it could not undo it), or `映射表未保存：…，请勿关闭文档，重新映射前先检查映射表。` after a revert whose trimmed table could not be saved. The panel reports the same outcomes on its status line and appends `，记得保存文档。` after a mask.

**Conventions.** Blank cells stay blank. Columns set to "leave alone" are skipped entirely. Numeric cells read back as serial numbers (a date is one), so masked values stay numeric and the cell format is untouched; reverse mapping writes the original type back. Number mapping keeps the column's decimal places; integer columns get integers.

**Mixed columns.** Account columns often mix mobiles, emails, landlines, and order codes. Set it to "混合" and each cell is handled by its own shape: a mobile becomes a valid mobile; an email becomes `u` plus six digits with its domain kept; a landline keeps area code, separator, digit count, and extension; a digit run keeps its length and leading zero; a letter-digit code is re-lettered character by character (`kf_2024_001` → `ud_9309_739`); anything else falls back to "field name + digits". One-to-one holds — the original stays the key, and reverting ignores the shape that produced a value. Two limits: the email domain stays visible, and a very short code such as `a1` can exhaust its shape space, which the add-in reports instead of repeating a value.

## Mapping storage and encryption limits

- **Location:** a hidden worksheet named "脱敏映射表". A1 is a notice, A2 onward holds ciphertext chunks of 20,000 characters. Column B is the backup area: B1 marks it, B2 onward keeps the previous ciphertext. Before each save the add-in drops signature buckets that no recorded area references any more, so repeatedly widening an interval does not grow the table without bound.
- **Algorithm:** AES-128-CBC, random IV, PKCS#7, Base64 behind an `M1:` prefix. Two saves of one plaintext differ. There is no MAC, so damage is reported only when decryption or the JSON check fails.
- **Key:** `KEY_TEXT` at the top of `js/aes.js`, 16 bytes.
- **A save is verified before any cell is written.** The previous ciphertext is copied to the backup column and read back, then the new ciphertext is written to column A, read back, and decrypted to compare. A failure rolls back to the previous table (`已回滚到上一份映射表`), clears a half-written save (`已清空本次未完成写入`), or keeps the backup (`回滚未完成…备份区保留上一份密文，重新读取时会自动恢复`). The panel and the quick buttons save before writing cells, so a failed save writes nothing.
- **Loading a damaged table is loud.** No hidden table means a new document and an empty mapping. Once this add-in has written a table, an empty or unreadable main ciphertext is not mistaken for a new document: an empty main copy is an error (`映射表密文为空，为保护数据不返回空映射表…`) — delete the table to start over. If the main ciphertext is damaged but the backup is readable, the add-in recovers from the backup and says `映射表损坏，已用备份恢复，请重新保存`; when neither copy is usable it reports the decryption or content error instead of pretending the document has no mapping.
- **Protection limit:** the key ships with the code, so this is obfuscation only. It prevents reading the originals by simply opening the workbook; it cannot stop someone holding this add-in from decrypting the table. Real protection requires deriving the key from a local config or a passphrase, outside the document.
- **Who can restore:** anyone holding this add-in version can click "反映射" — no passphrase — and get the originals back. Uninstalling the add-in, switching to another machine, forwarding the workbook to someone without it, or opening it where add-ins are blocked leaves no UI path to the originals — the document alone cannot produce them.
- **WPS may keep copies elsewhere:** the backup center, cloud version history, and the undo stack can still hold pre-masking values. Masking the workbook does not delete those copies.
- **Formulas are overwritten:** a formula cell receives a constant fake, and the formula is gone. Reverting restores the value, not the formula; keep a copy when the sheet is a working model.
- **The hidden sheet is not a lock:** anyone with a macro can unhide it or read its ciphertext, and deleting it — or saving a copy without it — loses the mapping for good. The add-in finds the table by name alone: a sheet you named 脱敏映射表 is treated as the mapping table. It cannot restore data whose table is gone. Old-format (v1) documents: if upgrading had to drop records while merging buckets, areas recorded before signatures existed are left untouched and counted ambiguous instead of guessing an original.
- **Only the last 200 masked areas are remembered:** the vault keeps the 200 most recent masked rectangles and drops the oldest. Once more than 200 areas have been masked, revert can no longer restore the oldest of them from the UI; their fakes stay unless a saved copy of the document is restored.
- **No pre-flight checks:** protected, read-only, and merged cells are not inspected before writing. A rejected write rolls back the columns already written and reports it; if the rollback also fails, the message says so and the sheet may hold a partial mask.
- **What the fakes still reveal:** fakes are drawn at random from a range with 10% headroom past the data (20~43, not 20~40), so the column is not reshuffled — neither the sorted values nor the frequencies match. Still visible: the range's min and max, row count, blank positions, row order, and the shape of text and phone values.
- **Cost of changing the key:** every existing document's table becomes undecryptable (the panel reports a decryption failure); do not change it while such documents exist.
- **Save the file.** The table is saved with the workbook. Close without saving and the masked data stays while the mapping is lost; the originals cannot be recovered.

## Verification status

**Verified locally** with these commands, against a mock WPS object model and the real panel page under jsdom:

```sh
# from the repository root
npm install                 # installs jsdom, needed by the panel and utility tests
npm test                    # aes, engine, taskpane and utils tests, in order
```

Or run one file at a time from `wps-mask-addon/`: `node test/aes.test.js`, `node test/engine.test.js`, `node test/taskpane.test.js`, `node test/utils.test.js` (install at the root first for the last two).

- AES matches `node:crypto` byte for byte in both directions: empty string, Chinese, emoji, a 5,000-character body, tamper detection, IV randomness.
- Engine: field detection, one-to-one and uniqueness, capacity errors, exact reverse mapping including types and blanks, whole-column and whole-row trimming, the header switch and the `headerAuto` flag, ciphertext round-trip through the backup, read-back, and rollback path, loud loading of empty and damaged tables, migration of old-format buckets only, remembered settings, mixed shapes, leading zeros, suffix sizing, the exact-fit permutation and its span guard, the per-cell skip records, and reverse mapping scoped to recorded areas — including the second-click no-op and ambiguous fakes.
- Panel: cards and parameter reveal, type switch, mask and revert, the two-phase mask that writes no cell when the table cannot be saved, revert saving the trimmed table and the second revert no-op, recovery from a damaged table, the header-auto warning, drop the table, no-selection state, late host object, selection-change re-analysis, column configuration remembered across headerless and same-named columns, interval growth keeping the same fakes.
- Nothing here drives a real WPS instance: every test runs against `test/mock-wps.js` and the real panel page under jsdom.

**Not yet verified on a real device.** No local reference measures these; the implementation follows official and community samples:

1. Whether this WPS build accepts the `publish.xml` fields and the `enable` value — success means the tab appears.
2. **Whether the pane receives `window.Application`.** A panel reporting "未取到 WPS 应用对象" means the host object is not injected and the panel code must run on the host page. `ribbon.js` calls the same engine, so the "快速映射/反映射" buttons are a temporary fallback.
3. Whether `CreateTaskPane` accepts a `file://`-style relative URL.
4. Whether `Worksheets.Add(undefined, <last sheet>)` returns a sheet. The code makes that one call with no fallback; if the host rejects it, the hidden mapping table is never created and masking stops with the error.
5. Whether a very hidden sheet (`Visible = 2`) survives a save and reads back.
6. Responsiveness at a hundred thousand rows.
7. Whether protected, read-only, and merged cells behave as the save-then-write and rollback paths assume.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No "数据脱敏" tab | Folder must be named `wpsmask_1.0.0`; `version`/`url` in `publish.xml` must match it; restart WPS after editing |
| Panel empty, "未取到 WPS 应用对象" | See item 2 above |
| The first row came back unchanged | It is being read as a header: 「首行是表头」 is checked, or detection guessed it. Uncheck to mask the first row as data, or start the selection one row lower |
| Reverse mapping restored only part of the range | Only areas the table recorded are restored, and a second click is a no-op. Restore with the range that was masked; each recorded area keeps the signature it was masked under, so later parameter edits do not matter. A fake owned by two originals is left alone and counted `有歧义` |
| A dialog appeared while the mapping table was saved | The table is saved before cells are written, so a save failure leaves the range unchanged — run the mask again. If the message mentions an incomplete rollback, inspect the range before retrying |
| "映射表损坏，已用备份恢复" | The main ciphertext was damaged and the backup was used. Save the workbook to replace the damaged copy; if this repeats, work from a saved copy |
| Re-masking a column changes nothing | Those cells already hold mapped values, so they are skipped. Revert first if you meant to map the current values again |
| A second revert did nothing | The first revert already trimmed those recorded areas; mask again to create new records |
| Numbers show as left-aligned text | Those cells were text-formatted and kept it. Change the cell format |
| "装不下 N 个不同值" | The interval cannot hold these distinct values (12 amounts inside 1–5). Auto-mapping widens the bounds, so this only appears after you narrow them by hand |
| "解密失败" | `KEY_TEXT` changed, the hidden table was edited by hand, or main and backup ciphertext are both damaged — restore a saved copy of the workbook |
| A mixed cell came back as "字段名+数字" though it looked like an account | It fits none of the five shapes (Chinese text, one character, a code starting with a digit like `2024abc`, punctuation outside `_ . -` and spaces). The text fallback is still one-to-one and reverts correctly |

## Missing reference material

Ordered by importance; with these, the unverified items above become measured results:

1. **Add-in development as a whole:** the `wpsjs` toolchain (`create`, `debug`, `build --exe`, `publish`), the project layout, `publish.xml` versus `jsplugins.xml`, offline `.7z`/`.exe` packaging, and how add-in permissions and trust differ from macros.
2. **`ribbon.xml`:** available controls (tab/group/button/toggleButton/dropDown/menu…), every callback and its signature (`onLoad`, `onAction`, `getImage`, `getEnabled`, `getVisible`, `getLabel`, `getScreentip`…), the `imageMso` list, and namespace differences between `2006/01` and `2009/07`.
3. **Web JSAPI versus macro API:** `window.Application` versus `wps.WpsApplication()`, `Range.Value2` and cross-context arrays (`instanceof Array` fails across contexts, a past engine bug), `Selection`, `CreateTaskPane`/`GetTaskPane`/`ShowDialog`, `PluginStorage`, `ApiEvent`, `OAAssist`, and how a pane talks to its host page.
4. Async semantics in an add-in, and the `DoEvents` equivalent for long loops.
5. An official minimal sample project with its real `publish.xml`, for regression testing.

## Tests

```sh
# from the repository root
npm install                  # installs jsdom (devDependency), once
npm test                     # aes, engine, taskpane and utils tests, in order
node wps-mask-addon/tools/make-icons.mjs
```

Icons need nothing but Edge: edit the SVGs, regenerate, never hand-edit a PNG.
