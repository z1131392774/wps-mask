# Verification status

*[中文](verification_zh.md)*

What was tested, how to reproduce it, what failed in the field, and what reference is still missing.

## Verified locally

Commands run against the mock host and the real pane page under jsdom:

```sh
# from the repository root
npm install                 # installs jsdom, needed by the panel and utility tests
npm test                    # aes, engine, taskpane, utils and rpc tests, in order
```

One file at a time from `wps-mask-addon/`: `node test/aes.test.js`, `test/engine.test.js`, `test/taskpane.test.js`, `test/utils.test.js`, `test/rpc.test.mjs` (install at the root first).

- AES matches `node:crypto` byte for byte in both directions: empty string, Chinese, emoji, a 5,000-character body, tamper detection, IV randomness.
- Engine: detection, one-to-one and uniqueness, capacity and span errors, exact reverse mapping including types and blanks, row and column trimming, the header switch and `headerAuto`, ciphertext round-trip through backup, read-back and rollback, loud loading of empty or damaged tables, old-format migration only, remembered settings, mixed shapes, leading zeros, suffix sizing, the exact-fit permutation, per-cell skip records, and reverse mapping scoped to recorded areas including the second-click no-op and ambiguous fakes.
- Panel: cards and parameters, type switch, mask and revert, the two-phase mask that writes no cell when the table cannot be saved, revert saving the trimmed table and the second no-op, recovery from a damaged table, the header-auto warning, dropping the table, empty and late-host states, selection-change re-analysis, configuration remembered by column position, and interval growth keeping the same fakes.
- Bridge: one line split across chunks, several lines in one chunk, CRLF and blank lines, noise lines kept out, an `ok:false` reason intact, a timeout staying local, every pending call rejected when the bridge exits, and a real child-process round-trip.
- No test drives WPS itself: everything runs against `test/mock-wps.js` and the real pane page under jsdom.

## Measured on a real device

WPS Spreadsheets 12.1.0.29161, `tools/live/probe.mjs` plus one panel opened by hand, 2026-11-25:

| Item | Result | Evidence |
| --- | --- | --- |
| The 「数据脱敏」 tab appears | passes | Tab visible, so `publish.xml` is accepted |
| `window.Application` inside the pane | passes | The pane listed the selection (`mask-small.csv!A1:C11`, 3 columns, header row), masked it and reverted it: three columns changed, originals came back. `window.Application` first, `wps.WpsApplication()` second; not probed apart |
| `CreateTaskPane` takes a `file://` URL | passes | Opened from the add-in's own `file://` URL and rendered |
| `Worksheets.Add(undefined, <last>)` | passes | Passing `Missing` works; the sheet lands at the end |
| A hidden sheet survives a save | passes | `Visible = 2` survives and the ciphertext reads back intact |
| 100k-row performance | passes | 100,000 rows in one column: 「快速映射」 to the first masked cell took about 7 seconds end to end, hidden table and read-back included (`Visible = 2`) |
| A protected sheet rejects writes | passes | Host refuses; engine rolls back and reports |
| Writes into merged cells | **caution** | A non-anchor merge cell neither throws nor takes effect; read-back catches it and rolls back |
| Saving a read-only document | **caution** | `Save()` neither throws nor writes; the engine refuses before saving |

**One finding stands alone: the add-in buttons cannot be clicked from outside.** Nothing in the 186 `CommandBars` carries them and UIA lists no tabs: WPS draws its ribbon itself. The panel is the way in; opened once by hand, it drives the same engine, and the results above were measured through it.

To reproduce, run `npm run live:probe:log`: it writes only into a scratch workbook it creates and puts the result in `probe.log`. The bridge (`tools/live/wps-bridge.ps1`) only moves data and every verdict is decided in Node, so split lines, noise, timeouts and a bridge dying mid-call are covered by `test/rpc.test.mjs` without WPS.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No "数据脱敏" tab | Folder must be named `wpsmask_1.0.0`; `version`/`url` in `publish.xml` must match it; restart WPS after editing |
| Panel empty, "未取到 WPS 应用对象" | The pane has no host object: check the tab row above |
| The first row came back unchanged | It is being read as a header: 「首行是表头」 is checked, or detection guessed it. Uncheck to mask the first row as data, or start the selection one row lower |
| Reverse mapping restored only part of the range | Only recorded areas are restored; a second click is a no-op. Restore with the range that was masked; each area keeps its masking signature, so later parameter edits do not matter. A fake owned by two originals is left alone and counted `有歧义` |
| A dialog appeared while the mapping table was saved | The table is saved before cells are written, so a save failure leaves the range unchanged — run the mask again. If the message mentions an incomplete rollback, inspect the range before retrying |
| "映射表损坏，已用备份恢复" | The main ciphertext was damaged and the backup was used. Save the workbook to replace the damaged copy; if this repeats, work from a saved copy |
| Re-masking a column changes nothing | Those cells already hold mapped values, so they are skipped. Revert first if you meant to map the current values again |
| A second revert did nothing | The first revert already trimmed those recorded areas; mask again to create new records |
| Numbers show as left-aligned text | Those cells were text-formatted and kept it. Change the cell format |
| "装不下 N 个不同值" | The interval cannot hold these values (12 amounts inside 1–5). Auto-mapping widens the bounds; this only appears after hand-narrowing |
| "文档是只读打开的" | A read-only document ignores `Save()` silently, so the table cannot be stored and the mask could never be reverted. Save the file as a new file, then mask |
| "写入后读回不一致" | A cell did not keep what was written. Merged cells are the usual cause — writing a non-anchor cell of a merge neither throws nor takes effect — so unmerge first; a protected sheet does this too |
| "解密失败" | `KEY_TEXT` changed, the hidden table was edited by hand, or main and backup ciphertext are both damaged — restore a saved copy of the workbook |
| A mixed cell came back as "字段名+数字" though it looked like an account | It fits none of the five shapes (Chinese text, one character, a code starting with a digit like `2024abc`, punctuation outside `_ . -` and spaces). The text fallback is still one-to-one and reverts correctly |

## Missing reference material

Ordered by importance; with these, the unverified items above become measured results:

1. **Add-in development as a whole:** the `wpsjs` toolchain (`create`, `debug`, `build --exe`, `publish`), project layout, `publish.xml` versus `jsplugins.xml`, offline packaging, and how add-in trust differs from macros.
2. **`ribbon.xml`:** available controls, every callback and signature (`onLoad`, `onAction`, `getImage`…), the `imageMso` list, and `2006/01` versus `2009/07` namespace differences.
3. **Web JSAPI versus macro API:** `window.Application` versus `wps.WpsApplication()`, cross-context arrays (`instanceof Array` fails across contexts), `Selection`, `CreateTaskPane`/`GetTaskPane`/`ShowDialog`, `PluginStorage`, `ApiEvent`, `OAAssist`, and pane-to-host communication.
4. Async semantics in an add-in, and the `DoEvents` equivalent for long loops.
5. An official minimal sample with its real `publish.xml`.

## Tests

Same commands as [Verified locally](#verified-locally), plus `node wps-mask-addon/tools/make-icons.mjs`. Icons need nothing but Edge: edit the SVGs, regenerate, never hand-edit a PNG.
