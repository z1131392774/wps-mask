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
| Phone numbers must be valid | `1[3-9]` plus 9 digits drawn from the real prefix ranges (130–199), unique within the column and never equal to the original |
| Text is a prefix plus a random numeric suffix | Chinese prefix (field name by default, e.g. 姓名37) or English prefix (built-in word list: 姓名→Name, 地址→Address, or type your own). Suffix digits default to the fewest that hold this column's non-blank cells with 10% headroom, so 41 customers get 姓名37, never 姓名0037; editable 1–8 |
| Auto-detect the field name and type | Header matched against 手机/电话/phone/tel → phone; ≥60% of values shaped like a mobile number → phone; ≥80% numeric → number; everything else → text with the field name as prefix. Whole-column and whole-row selections resolve the field name correctly |
| One-click reverse mapping, mapping stored encrypted | "反映射回原值" looks each cell up in the encrypted table and writes the original back, preserving number/text type and blanks; the table is AES-128-CBC ciphertext in a hidden worksheet |
| Remember the last settings for this document | Per-field type, distribution, parameters, and prefix are stored in the same encrypted blob, keyed by field name; "重新识别" ignores them and re-detects |

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

If `wpsjs` is installed, its generated `publish.xml` works too: replace the files by name; `wpsjs debug` loads the add-in.

### Develop without copying

Edits here take effect only after the files reach `jsaddons`. `tools/link-addon.ps1` replaces the copied folder with a junction to this directory, so WPS reads the working tree and a restart picks up changes:

```powershell
powershell -File tools/link-addon.ps1            # old folder kept as .bak-<timestamp>
powershell -File tools/link-addon.ps1 -Rollback  # remove it, put the backup back
```

A junction needs no admin rights or developer mode; a hard link cannot point at a folder. Close WPS first — the rename fails while the add-in is loaded.

## Usage

**Panel.** Select the range (whole column, whole row, or any block) and open "映射面板". It reads the selection and updates when it changes; there is no refresh button. With no selection it shows a single hint line, the toolbar hidden and the write buttons disabled. Each column gets a card — detected type and a sample in the header, parameters beneath on demand — then "映射并写入" replaces the range in place, and "反映射回原值" puts the originals back.

**Repeated masking does not stack.** Cells already holding mapped values are skipped and the status line reports the count, so masking a part and then the whole never processes a cell twice. To map current values again, revert first.

**Quick buttons.** "快速映射" uses detection or the remembered settings on the current selection, skipping mapped cells the same way and writing nothing when none remain. "反映射" reverses the selection directly.

**Conventions.** Blank cells stay blank. Columns set to "leave alone" are skipped entirely. Numeric cells read back as serial numbers (a date is one), so masked values stay numeric and the cell format is untouched; reverse mapping writes the original type back. Number mapping keeps the column's decimal places; integer columns get integers.

**Mixed columns.** Account columns often mix mobiles, emails, landlines, and order codes. Set it to "混合" and each cell is handled by its own shape: a mobile becomes a valid mobile; an email becomes `u` plus six digits with its domain kept; a landline keeps area code, separator, digit count, and extension; a digit run keeps its length and leading zero; a letter-digit code is re-lettered character by character (`kf_2024_001` → `ud_9309_739`); anything else falls back to "field name + digits". One-to-one holds, since the original stays the key and reverting ignores which shape produced the value. Two limits: the email domain stays visible, and a very short code such as `a1` can exhaust its shape space, which the add-in reports instead of repeating a value.

## Mapping storage and encryption limits

- **Location:** a hidden worksheet named "脱敏映射表". A1 is a notice, A2 onward holds ciphertext chunks of 20,000 characters.
- **Algorithm:** AES-128-CBC, random IV, PKCS#7, Base64 behind an `M1:` prefix. Two saves of one plaintext differ.
- **Key:** `KEY_TEXT` at the top of `js/aes.js`, 16 bytes.
- **Protection limit:** the key ships with the code, so this is obfuscation only. It prevents reading the originals by simply opening the workbook; it cannot stop someone holding this add-in from decrypting the table. Real protection requires deriving the key from a local config or a passphrase, outside the document.
- **Cost of changing the key:** every existing document's table becomes undecryptable (the panel reports a decryption failure). Do not change it while existing documents still hold mapping tables.
- **Save the file.** The table is saved with the workbook. Close without saving and the masked data stays while the mapping is lost; the originals cannot be recovered.

## Verification status

**Verified locally** (`node test/*.test.js`, against a mock object model and the real panel page in jsdom):

- The AES implementation matches `node:crypto` byte for byte in both directions: empty string, Chinese, emoji, a 5,000-character body, tamper detection, IV randomness.
- Engine: field detection, one-to-one and uniqueness, capacity errors, exact reverse mapping including types and blanks, whole-column and whole-row trimming, header toggle, ciphertext round-trip, remembered settings, stable mapping across a reopened document.
- Mixed mode: each shape detected and replaced in kind (domain kept, area code kept, length and leading zero kept, letters re-lettered), ten mixed values reverted exactly, and single-shape columns still detected as before.
- Panel: four cards rendered, distribution switch reveals its parameters, type switch rebuilds the card, mask, revert, header toggle, drop the table, and the no-selection error path.
- Syntax check on every script, XML well-formedness of `ribbon.xml`.

**Not yet verified on a real device.** No local reference measures these; the implementation follows official and community samples:

1. Whether this WPS build accepts the `publish.xml` fields and the `enable` value — success means the tab appears.
2. **Whether the pane receives `window.Application`.** A panel reporting "未取到 WPS 应用对象" means the host object is not injected and the panel code must run on the host page. `ribbon.js` calls the same engine, so the "快速映射/反映射" buttons are a temporary fallback.
3. Whether `CreateTaskPane` accepts a `file://`-style relative URL.
4. The parameter form of `Worksheets.Add(undefined, lastSheet)` — the code falls back to `null`, then to no argument, and reports an error only when all three fail.
5. Whether a very hidden sheet (`Visible = 2`) survives a save and reads back.
6. Responsiveness at a hundred thousand rows.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No "数据脱敏" tab | Folder must be named `wpsmask_1.0.0`; `version`/`url` in `publish.xml` must match it; restart WPS after editing |
| Panel empty, "未取到 WPS 应用对象" | See item 2 above |
| Reverse mapping restored only part of the range | The selection must match the one used to mask; or the column parameters changed, in which case the lookup prefers the current signature before falling back to the global table |
| Re-masking a column changes nothing | Those cells already hold mapped values, so they are skipped. Revert first if you meant to map the current values again |
| Numbers show as left-aligned text | Those cells were text-formatted and kept it. Change the cell format |
| "装不下 N 个不同值" | The interval cannot hold these distinct values (12 amounts inside 1–5). Widen the bounds or add decimal places |
| "解密失败" | `KEY_TEXT` changed, or the hidden table was edited by hand |
| A mixed cell came back as "字段名+数字" though it looked like an account | It fits none of the five shapes — Chinese text, a one-character value, a code beginning with a digit such as `2024abc`, or one carrying punctuation other than `_ . -` and spaces. The text fallback is still one-to-one and reverts correctly |

## Missing reference material

Ordered by importance; with these, the unverified items above become measured results:

1. **Add-in development as a whole:** the `wpsjs` toolchain (`create`, `debug`, `build`, `publish`), layout, `publish.xml` versus `jsplugins.xml`, offline packaging, and how add-in permissions differ from macros.
2. **`ribbon.xml`:** available controls, every callback and its signature (`onLoad`, `onAction`, `getImage`, `getEnabled`, `getVisible`…), the `imageMso` list, and namespace differences between `2006/01` and `2009/07`.
3. **Web JSAPI versus macro API:** `window.Application` versus `wps.WpsApplication()`, `Range.Value2` and cross-context arrays (`instanceof Array` fails across contexts, a past engine bug), `CreateTaskPane`, `PluginStorage`, `ApiEvent`, and how a pane talks to its host page.
4. Async semantics in an add-in, and the `DoEvents` equivalent for long loops.
5. An official minimal sample project with its real `publish.xml`, for regression testing.

## Tests

```sh
cd wps-mask-addon
node test/aes.test.js       # cipher against node:crypto
node test/engine.test.js    # mapping, reverting, storage
npm i jsdom --no-save       # needed by the panel test
node test/taskpane.test.js  # the real panel page on a mock object model
```
