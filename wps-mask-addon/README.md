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
| Auto-detect the field name and type | Field-name keywords, email and landline shapes, a mobile or numeric majority, then a text fallback — the exact order is under [Detection order](docs/behavior.md#detection-order). Whole-column and whole-row selections are trimmed to their used cells first |
| One-click reverse mapping, mapping stored encrypted | 「反映射回原值」 looks each cell up in the encrypted table and writes the original back, preserving number/text type and blanks. It only touches areas this add-in recorded as masked: expanding a selection is safe, and a second click is a no-op. A fake value that two originals could own is left alone and counted. The table is AES-128-CBC ciphertext in a hidden worksheet ([storage](docs/storage.md)) |
| Remember the last settings for this document | Per-field type, distribution, parameters, and prefix are stored in the same encrypted blob, keyed by field name; a numeric interval only grows (union with the current data), so a wider column elsewhere never trips the old range; "重新识别" ignores them and re-detects |
| See what is masked at a glance | Mapped areas get a purple dashed outline automatically, no panel needed; 全部加边框 / 全部去边框 on the ribbon redraw or remove every outline in one click, changing appearance only |

Detection, the header guess, messages and mixed columns are in [masking behavior](docs/behavior.md); the hidden table and its encryption limits are in [storage](docs/storage.md).

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
   ├─ images\           ribbon icons: panel, quick, revert, mark, unmark, each with an @2x copy
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

The SVG sources under `assets/icons/` are repository-only; only the PNGs are copied. If `wpsjs` is installed (not required), its generated `publish.xml` also works.

### Develop without copying

Edits here take effect only after the files reach `jsaddons`. `tools/link-addon.ps1` replaces the copied folder with a junction to this directory, so WPS reads the working tree and a restart picks up changes:

```powershell
powershell -File tools/link-addon.ps1            # old folder kept as .bak-<timestamp>
powershell -File tools/link-addon.ps1 -Rollback  # remove it, put the backup back
```

A junction needs no admin rights or developer mode, and a hard link cannot point at a folder. Close WPS first — the rename fails while the add-in is loaded.

## Usage

**Panel.** Select the range (whole column, whole row, or any block) and open "映射面板". It reads the selection and updates when it changes; there is no refresh button. Each column gets a card — detected type and a sample in the header, parameters on demand — then 「映射并写入」 replaces the range in place, and 「反映射回原值」 restores the areas this add-in masked in the selection; cells it never wrote are left untouched. Card settings you edit survive a selection refresh: they are remembered per sheet and column position.

**Header row.** The checkbox 「首行是表头」 decides whether the first row is data. Checked: row 1 is never masked, and supplies the column name and the text prefix. Unchecked: row 1 is data, and detection may still guess it as a header — read the panel's 「首行为字段名」 / 「无表头」 label before writing. The full rule, and the warning shown when the guess is weak, is under [The header row](docs/behavior.md#the-header-row).

**Repeated masking does not stack.** A cell is skipped only when it lies in a range this add-in has already written and its value reverses through the table; the status line reports the count. Reverting subtracts the restored parts, so a second revert finds nothing to write. To map current values again, revert first.

**Seeing what is masked.** Mapped blocks get a purple dashed outline in the sheet, so no panel is needed to see them; 全部加边框 / 全部去边框 on the ribbon redraw or remove every outline in one click, and also clear purple left by an older failed mask. The records live in the hidden table as soon as you mask — the same save that stores the mapping, before any cell is written — and only saving keeps them across sessions.

**Quick buttons.** "快速映射" uses detection or the remembered settings on the current selection, skipping mapped cells the same way and writing nothing when none remain. "反映射" restores the areas recorded in the selection; cells it never masked keep their values, and with nothing to restore it says so instead of writing.

Messages, conventions and mixed columns are in [masking behavior](docs/behavior.md).

## Mapping storage and encryption limits

- **Where the originals live:** a hidden worksheet named "脱敏映射表" holds AES-128-CBC ciphertext; `KEY_TEXT` in `js/aes.js` is the key. A second, backup column keeps the previous ciphertext.
- **A failed save writes nothing:** the panel saves the table (backup, write, read-back and decrypt check) before writing any cell. A damaged main copy is either recovered from the backup or reported loudly — never mistaken for a new document.
- **Protection limit:** the key ships with the code, so this is obfuscation only. Anyone holding this add-in can revert without a passphrase; uninstalling it, switching machines or forwarding the workbook leaves no UI path to the originals, while WPS's backup center, version history and undo stack may still hold pre-masking values.
- **What does not survive:** formula cells are overwritten and only their values come back; a hidden sheet is not a lock against macros; at most the last 200 masked areas are remembered; a read-only document is refused before saving. Deleting the table restores the outlines first, lists any sheet whose borders could not be restored or no longer exists, and deletes the table anyway.

Everything else — the algorithm, the failure messages, who can restore, the full limits list — is in [storage](docs/storage.md).

## Verification

```sh
# from the repository root
npm install                 # installs jsdom, needed by the panel and utility tests
npm test                    # engine, aes, ribbon, taskpane, utils and rpc tests, in order
```

All local tests run against a mock WPS object model and the real panel page under jsdom. On a real device (WPS Spreadsheets 12.1.0.29161) the tab, the pane's host object, `CreateTaskPane` with a `file://` URL, the hidden sheet surviving a save and the packed outline colour passed; merged cells and read-only documents need care. The single-save flow measured 8.1 s for 100,000 rows on local mock (the old two-save flow measured 21.1 s), but has not been re-measured on a device. The test inventory, the measured table, reproduction steps, troubleshooting and the reference material still missing are in [verification](docs/verification.md).

## Tests

```sh
# from the repository root
npm install                  # installs jsdom (devDependency), once
npm test                     # engine, aes, ribbon, taskpane, utils and rpc tests, in order
node wps-mask-addon/tools/make-icons.mjs
```

Icons are generated on a Windows dev machine — the script looks for Edge/Chrome at Windows paths, so Linux cannot reproduce them. Edit the SVGs, regenerate, never hand-edit a PNG.
