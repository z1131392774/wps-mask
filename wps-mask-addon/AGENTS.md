# AGENTS.md — wps-mask-addon

*[中文](AGENTS_zh.md)*

Rules for the add-in itself. Standing orders are in the [root file](../AGENTS.md); the product manual is [README.md](README.md).

- **Reach the host only through `MaskGetApp()`.** No bare `Range("A1")` exists in an add-in: every object hangs off what that helper returns.
- **Judge arrays with `Array.isArray`.** Host values cross a realm boundary: `instanceof Array` is false and a 2D range collapses to one cell. This broke `analyze` once.
- **Move whole blocks through `Value2`.** Read into a 2D array, transform in JS, write back in one assignment. A per-cell loop is an order slower and leaves partial state when it fails.
- **Keep the mapping one-to-one — through `keyOf()` — or throw.** Two originals sharing a mapped value make reverse mapping ambiguous. The table is keyed `n:`/`s:`/`b:`, so a generator probing `used[rawValue]` never sees a collision; `genPhone`/`genText` did that and one run in sixteen reverted to the wrong original. Probe `used[keyOf(candidate)]`. When an interval only just holds the distinct values, assign a whole-column offset permutation: generating value by value forces the last one onto its own value and fails at random. When it cannot hold them, fail naming the column by letter and header.
- **A mixed column is classified per cell.** `shapeOf()` returns mobile/email/landline/digits/alnum/text; `genMixed` dispatches to a generator that keeps that shape, else `genText`. A new shape needs its `shapeOf` branch, its generator, and a test for the bit that must survive: domain, area code, digit count, leading zero.
- **The vault is a file format.** `M1:`, `sigOf()` and `KEY_TEXT` are read by documents already in the wild; change one and old tables become garbage — add a version field and a migration in the same change.
- **`engine.js` stays host-agnostic.** No DOM, no `window`, no top-level `require`: it must run unchanged in the pane, the host page and Node. `aes.js` uses no `crypto`.
- **Behaviour changes run the tests.** `node test/engine.test.js` and `node test/aes.test.js` cover the engine; anything a user clicks also goes through the jsdom panel test.
- **The AES key is obfuscation, not a credential.** `KEY_TEXT` is a constant; moving it into a passphrase or env var means changing the storage format in the same change.
- **Edit files here, never under `%APPDATA%`.** `tools/link-addon.ps1` makes the installed `jsaddons\wpsmask_1.0.0` a junction onto this folder. `-Rollback` restores the `.bak-<timestamp>` folder.
- **Check UI changes in a real render.** `node tools/preview-pane.mjs` writes a preview page over a ten-column mock workbook; screenshot at 260, 300 and 380 px, the widths a pane takes. jsdom proves behaviour, not layout. Keep the pane free of flex `gap`, CSS variables and grid: the browser version is unknown and those fail silently. Show only what the pane must — type, one sample, parameters; counts belong to WPS's status bar, and a "本列 N 个不同值" line was removed for duplicating it.
