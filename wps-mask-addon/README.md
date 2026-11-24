# Data masking add-in for WPS Spreadsheet

*[中文](README_zh.md)*

Select a range, and every value in it is replaced by fake data that still looks real; the originals are stored encrypted in the workbook and come back with one click.

## What it does, against the request

| Requirement | How it is implemented |
| --- | --- |
| Pick a range, map its data to random values | Ribbon tab "数据脱敏" → mapping panel, or the panel-free "快速映射" button |
| One-to-one: the same value always maps to the same result | The mapping table persists `original → mapped`. A repeat original always resolves to the recorded entry; distinct originals are forced onto distinct results (retry on collision, hard error when the value space is too small instead of a silent duplicate) |
| Two kinds of mapped value: number and text | "Map to" dropdown per column: phone, number, text, leave alone |
| Numbers take parameters, uniform by default | Uniform (default), normal (mean/sd, out-of-range folded back into the interval), exponential (λ sets the decay); bounds and decimal places are editable |
| Phone numbers must be valid | Real prefixes (130–199) plus 8 random digits, `1[3-9]` first and 11 digits total, unique within the column, never equal to the original |
| Text is a prefix plus a random numeric suffix | Chinese prefix (field name by default, e.g. 姓名9527) or English prefix (built-in word list: 姓名→Name, 地址→Address, and so on, or type your own); suffix length 1–8 |
| Auto-detect the field name and type | Header matched against 手机/电话/phone/tel → phone; ≥60% of values shaped like a mobile number → phone; ≥80% numeric → number; everything else → text with the field name as prefix. Whole-column and whole-row selections resolve the field name correctly |
| One-click reverse mapping, mapping stored encrypted | "反映射回原值" looks each cell up in the encrypted table and writes the original back, preserving number/text type and blanks; the table is AES-128-CBC ciphertext in a hidden worksheet |
| Remember the last settings for this document | Per-field type, distribution, parameters, and prefix are stored in the same encrypted blob, keyed by field name. "重新识别" ignores the memory and re-detects |

## Install

The add-in directory is `%APPDATA%\kingsoft\wps\jsaddons` (`Win+R`, type `%appdata%`, then `kingsoft\wps\jsaddons`; create it if absent).

1. Copy the whole `wpsmask_1.0.0` folder in. **Do not rename it** — `name_version` is how WPS finds the add-in.
2. Handle the manifest `publish.xml`:
   - not present → copy the one at the repository root;
   - already present (another add-in is installed) → **do not overwrite**, add this line inside `<jsplugins>`:

   ```xml
   <jsplugin name="wpsmask" type="et" url="wpsmask_1.0.0" version="1.0.0" enable="enable_dev" install="null" customDomain="" debug=""/>
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

If `wpsjs` is installed, its generated `publish.xml` works too: replace the files above by name, and `wpsjs debug` starts WPS with the add-in loaded.

### Develop without copying

Editing a file here changes nothing until it lands in `jsaddons`. `tools/link-addon.ps1` swaps that folder for a junction onto this tree, leaving a restart as the only step:

```powershell
powershell -File tools/link-addon.ps1            # old folder kept as .bak-<timestamp>
powershell -File tools/link-addon.ps1 -Rollback  # remove it, put the backup back
```

A junction needs no elevation, unlike a symlink; a hard link cannot point at a folder. Close WPS first — the rename fails while the add-in is loaded.

## Usage

**Panel.** Select the range (whole column, whole row, or any block), open "映射面板", press "刷新选区". Each column gets a card: detected type and a sample value in the header, parameters beneath opened on demand. Check them, then "映射并写入" — the new values replace the range in place. "反映射回原值" puts the originals back.

**Masking twice is safe.** A cell that already holds a value from the mapping table is skipped, and the status line names the columns it skipped. A partial mask followed by a whole-region mask therefore cannot map the same cells twice; to map the current values again, revert first.

**Quick buttons.** "快速映射" processes the current selection using auto-detection or the remembered settings. Already-mapped cells are skipped here too; when no new cell is left it says so and writes nothing. "反映射" reverses the current selection directly.

**Conventions.** Blank cells stay blank. Columns set to "leave alone" are skipped entirely. Numeric cells read back as serial numbers (a date is one), so masked values stay numeric and the cell format is untouched; reverse mapping writes the original type back. Number mapping keeps the column's decimal places; integer columns get integers.

## Where the mapping lives, and how far the encryption goes

- **Location:** a hidden worksheet named "脱敏映射表". A1 is a notice, A2 onward holds ciphertext chunks of 20,000 characters.
- **Algorithm:** AES-128-CBC, random IV, PKCS#7, Base64 behind an `M1:` prefix. Two saves of one plaintext differ.
- **Key:** `KEY_TEXT` at the top of `js/aes.js`, 16 bytes.
- **Boundary, stated plainly:** the key ships with the code, so this is obfuscation. It stops someone opening the workbook and reading the originals; it does not stop someone holding this add-in from reversing it. Real protection means moving the key out of the document — derived from a local config or a passphrase.
- **Cost of changing the key:** every existing document's table becomes undecryptable (the panel reports a decryption failure). Do not touch it while documents in the wild carry a table.
- **Save the file.** The table is saved with the workbook. Close without saving and the masked data stays while the mapping is gone — unrecoverable.

## Verification status

**Verified locally** (`node test/*.test.js`, against a mock object model and the real panel page in jsdom):

- The AES implementation matches `node:crypto` byte for byte in both directions: empty string, Chinese, emoji, a 5,000-character body, tamper detection, IV randomness.
- Engine: field detection, one-to-one and uniqueness, capacity errors, exact reverse mapping including types and blanks, whole-column and whole-row trimming, header toggle, ciphertext round-trip, remembered settings, stable mapping across a reopened document.
- Panel: four cards rendered, distribution switch reveals its parameters, type switch rebuilds the card, mask, revert, header toggle, drop the table, and the no-selection error path.
- Syntax check on every script, XML well-formedness of `ribbon.xml`.

**Needs one run on a real device** — nothing in the local documentation set measures these; they follow official and community samples:

1. Whether this WPS build accepts the `publish.xml` fields and the `enable` value. Test: the "数据脱敏" tab appears.
2. **Whether the task pane page receives `window.Application`.** If the panel reports "未取到 WPS 应用对象", this build does not inject the host object into the pane; the fallback is the ribbon buttons, which run the same engine from the host page.
3. Whether `CreateTaskPane` accepts a `file://`-style relative URL.
4. The parameter form of `Worksheets.Add(undefined, lastSheet)` — the code falls back from `undefined` to `null` to no-argument before it reports a failure.
5. Whether a very hidden sheet (`Visible = 2`) survives a save to `.xlsx`/`.et` and reads back.
6. Performance and UI responsiveness at a hundred thousand rows.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No "数据脱敏" tab | Folder must be named `wpsmask_1.0.0`; `version`/`url` in `publish.xml` must match it; restart WPS after editing |
| Panel empty, "未取到 WPS 应用对象" | See item 2 above |
| Reverse mapping restored only part of the range | The selection must match the one used to mask; or the column parameters changed, in which case the lookup prefers the current signature before falling back to the global table |
| Re-masking a column changes nothing | Those cells already hold mapped values, so they are skipped. Revert first if you meant to map the current values again |
| Numbers show as left-aligned text | The cells were text-formatted before; the numeric values kept that format. Change the cell format |
| "区间容量不足" | The integer interval cannot hold that many distinct values (12 distinct amounts inside 1–5). Widen the bounds or add decimal places |
| "解密失败" | `KEY_TEXT` changed, or the hidden table was edited by hand |

## What the documentation set still lacks

Ordered by importance; with these, the unverified items above become measured facts:

1. **Add-in development as a whole:** the `wpsjs` toolchain (`create`, `debug`, `build --exe`, `publish`), project layout, `publish.xml` versus `jsplugins.xml` deployment, offline `.7z`/`.exe` packaging, and the permission differences between macros and add-ins.
2. **`ribbon.xml` specification:** available controls (tab/group/button/toggleButton/dropDown/menu), every callback and its signature (`onLoad`, `onAction`, `getImage`, `getEnabled`, `getVisible`, `getLabel`, `getScreentip`), the `imageMso` value list, and behaviour differences between the `2006/01` and `2009/07` namespaces.
3. **Web-side JSAPI versus macro API:** `window.Application` versus `wps.WpsApplication()`, the shape of `Range.Value2` and cross-context arrays (`instanceof Array` fails — this bit the engine once), `Selection`, `CreateTaskPane`/`GetTaskPane`/`ShowDialog`, `PluginStorage`, `ApiEvent`, `OAAssist`, and how a task pane talks to the host page.
4. Async and synchronous semantics in an add-in, and the `DoEvents` equivalent for long loops.
5. One official minimal project sample, including the real `publish.xml`, to serve as a regression baseline.

## Tests

```sh
cd wps-mask-addon
node test/aes.test.js       # cipher against node:crypto
node test/engine.test.js    # mapping, reverting, storage
npm i jsdom --no-save       # needed by the panel test
node test/taskpane.test.js  # the real panel page on a mock object model
```
