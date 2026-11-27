# Verification status

*[中文](verification_zh.md)*

What was tested, how to reproduce it, what failed in the field, and the reference still missing.

## Verified locally

Commands run against the mock host and the real pane page under jsdom:

```sh
# from the repository root
npm install                 # installs jsdom, needed by the panel and utility tests
npm test                    # six suites: engine, aes, ribbon, taskpane, utils and rpc
```

Each suite runs alone too from the repository root, e.g. `node wps-mask-addon/test/engine.test.js`; the bridge is `wps-mask-addon/test/rpc.test.mjs`.

- AES matches `node:crypto` byte for byte both ways: empty, Chinese, emoji, 5,000 characters, tamper detection, IV randomness.
- Engine: detection, one-to-one, capacity and span errors, typed reverse mapping, trimming, the header switch and `headerAuto`, backup/read-back/rollback, damaged-table loading, migration, remembered settings, type-based mixed mapping, suffix sizing, the exact-fit permutation, per-cell skip records, scoped revert (second-click no-op, ambiguous fakes), `prepareMask`/`writeMask`/`abortMask` (save-failure abort, write-failure rollback), and the outline (mixed edges unpainted, only purple cells cleared, overlapping records drawn once).
- Panel: cards and parameters, mask and revert, the save-then-write flow, save-failure abort, write-failure rollback and re-save, revert saving the trimmed table, damaged-table recovery, the header-auto warning, dropping the table including partial border-restore failures, empty and late-host states, selection-change re-analysis, settings remembered by position, interval growth keeping the same fakes, and read-only refusals before any write.
- Ribbon: a quick mask paints the outline and saves its records; 全部加边框 / 全部去边框 repaint or remove outlines, write no cell, keep the masked records, report partial failures, and refuse read-only documents.
- Bridge: chunk splitting, CRLF and blank lines, noise kept out, an `ok:false` reason intact, timeouts local, pending calls rejected when the bridge exits, and a real child-process round-trip.
- No test drives WPS: everything runs against `test/mock-wps.js` and the pane page under jsdom.

## Measured on a real device

WPS Spreadsheets 12.1.0.29161, `tools/live/probe.mjs` plus one panel opened by hand, 2026-11-25:

| Item | Result | Evidence |
| --- | --- | --- |
| The 「数据脱敏」 tab appears | passes | Tab visible, so `publish.xml` is accepted |
| `window.Application` inside the pane | passes | The pane listed the selection (`mask-small.csv!A1:C11`, 3 columns, header row) and masked and reverted it. `window.Application` first, `wps.WpsApplication()` second, not probed apart |
| `CreateTaskPane` takes a `file://` URL | passes | Opened from the add-in's own URL and rendered |
| `Worksheets.Add(undefined, <last>)` | passes | Passing `Missing` works; the sheet lands at the end |
| A hidden sheet survives a save | passes | `Visible = 2` survives and the ciphertext reads back intact |
| Writing numeric text | passes | `008081` becomes 8081 in a General cell; `'008081` stays the string `008081` with General format |
| The outline colour | passes | The first run painted red: `Border.Color` is packed RGB, so `0x7C3AED` (8141549) came out #ED3A7C — byte order confirmed. The shipped 15547004 (#7C3AED) read back correctly on 2026-11-27 |
| 100k-row performance | local mock only | New single-save flow 8.1 s total (analyze 0.09 s, prepare incl. outline 1.5 s, save 6.4 s, write 0.1 s); the old two-save flow measured 21.1 s; not re-measured on a device |
| A protected sheet rejects writes | passes | Host refuses; engine rolls back and reports |
| Writes into merged cells | **caution** | A non-anchor merge cell neither throws nor takes effect; read-back catches it and rolls back |
| Saving a read-only document | **caution** | `Save()` opens a replace prompt; the engine refuses first |

Still unverified on a device: whether `Weight` assignment forces `LineStyle` to solid (the code writes style last), whether the host returns `null` for a mixed edge, whether single-cell `Borders.Item` matches range semantics, and the 4,096-block fragmentation cap error.

**The add-in buttons cannot be clicked from outside.** No `CommandBars` entry or UIA tab carries them: WPS draws its ribbon itself; results came from one panel opened by hand.

To reproduce, run `npm run live:probe:log`: it writes only into a scratch workbook it creates and logs to `probe.log`. The bridge only moves data; verdicts are decided in Node, so split lines, noise, timeouts and a mid-call exit are covered by `test/rpc.test.mjs` without WPS.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No "数据脱敏" tab | Folder named `wpsmask_1.0.0`; `version`/`url` in `publish.xml` match it; restart WPS |
| Panel empty, "未取到 WPS 应用对象" | The pane has no host object: check the tab row above |
| The first row came back unchanged | Read as a header; uncheck 「首行是表头」 to mask it, or start a row lower |
| Reverse mapping restored only part of the range | Only recorded areas are restored; a second click is a no-op. Restore with the masked range; a fake owned by two originals is left, counted `有歧义` |
| A dialog appeared while the mapping table was saved | The table is saved before cells are written, so the range is unchanged — run the mask again. On "回滚未完成", inspect first |
| "映射表损坏，已用备份恢复" | The main ciphertext was damaged; the backup was used. Save to replace it; if it repeats, work from a saved copy |
| Re-masking a column changes nothing | Those cells hold mapped values and are skipped. Revert first |
| A second revert did nothing | The first revert trimmed those records; mask again |
| A purple outline is left over | Left by an older failed mask; 全部加边框 or 全部去边框 clears it. Fragmented edges stop after 4,096 blocks and report it; the records stay, click again to finish. A mask that writes nothing leaves borders alone |
| Numbers show as left-aligned text | Text-formatted cells kept the format; change it |
| "装不下 N 个不同值" | The interval cannot hold the values (12 amounts in 1–5). Auto-mapping widens; this only appears after narrowing |
| "文档是只读打开的" | A read-only Save() prompts to replace; save as a new file, then mask |
| "写入后读回不一致" | A cell did not keep the write. Merged cells are the usual cause (non-anchor merges neither throw nor apply); a protected sheet does too |
| "解密失败" | `KEY_TEXT` changed, the table was edited by hand, or both ciphertext copies are damaged — restore a saved copy |
| A text cell came back as "field name + digits" | Expected under type-based mapping: every string is replaced by non-numeric text, whatever its original shape (phone, email, zero-padded code). None of the original shape is preserved |

## Missing reference material

Ordered by importance; with these, the unverified items become measured results:

1. **Add-in development:** the `wpsjs` toolchain, project layout, `publish.xml` versus `jsplugins.xml`, offline packaging, and add-in trust versus macros.
2. **`ribbon.xml`:** controls, callbacks and signatures, the `imageMso` list, and `2006/01` versus `2009/07`.
3. **Web JSAPI versus macro API:** `window.Application` versus `wps.WpsApplication()`, cross-context arrays, `Selection`, `CreateTaskPane`/`GetTaskPane`/`ShowDialog`, `PluginStorage`, `ApiEvent`, `OAAssist`, pane communication.
4. Async semantics and the `DoEvents` equivalent.
5. An official minimal sample with its real `publish.xml`.

## Tests

Same commands as [Verified locally](#verified-locally), plus `node wps-mask-addon/tools/make-icons.mjs`. Icons are generated on a Windows dev machine (the script looks for Edge/Chrome at Windows paths), so Linux cannot reproduce them; edit the SVGs, regenerate, never hand-edit a PNG. `npm run check` covers documentation only, so icons, SVG and JS are checked by eye and by the tests.
