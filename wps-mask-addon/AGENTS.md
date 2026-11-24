# AGENTS.md — wps-mask-addon

*[中文](AGENTS_zh.md)*

Rules for the add-in itself. Standing orders are in the [root file](../AGENTS.md); the product manual is [README.md](README.md).

- **Reach the host only through `MaskGetApp()`.** There is no bare `Range("A1")` inside an add-in: every object hangs off the application object that helper returns, or off a worksheet obtained from it.
- **Judge arrays with `Array.isArray`.** Host values cross a realm boundary, so `instanceof Array` returns false and a 2D range silently collapses to a single cell. This broke `analyze` once.
- **Move whole blocks through `Value2`.** Read the block into a 2D array, transform in JS, write it back in one assignment. A per-cell loop is an order of magnitude slower and leaves partial state when it fails.
- **Keep the mapping one-to-one or throw.** Two originals sharing one mapped value make reverse mapping ambiguous. When the value space cannot hold the distinct originals, fail with a readable message instead of duplicating.
- **The vault is a file format.** The `M1:` envelope, `sigOf()`, and `KEY_TEXT` are read by documents already in the wild. Change any of them and old tables become garbage: add a version field and a migration path in the same change.
- **`engine.js` stays host-agnostic.** No DOM, no `window`, no top-level `require`: it must run unchanged in the task pane, in the add-in host page, and under Node for tests. `aes.js` uses no `crypto`.
- **Behaviour changes run the tests.** `node test/engine.test.js` and `node test/aes.test.js` cover the engine; anything a user clicks also goes through the jsdom panel test.
- **The AES key is obfuscation, not a credential.** `KEY_TEXT` is a constant. Do not move it into a passphrase or an environment variable without changing the storage format.
- **Edit files here, never under `%APPDATA%`.** `tools/link-addon.ps1` turns the installed `jsaddons\wpsmask_1.0.0` into a junction onto this folder, so both paths are one set of files; a change made on the `jsaddons` side is a change to the repository. The link can be undone with `-Rollback`, which restores the `.bak-<timestamp>` folder it saved.
- **Check UI changes in a real render.** `node tools/preview-pane.mjs` writes a preview page over a ten-column mock workbook; screenshot it at 260, 300 and 380 px — the widths a task pane actually takes. The jsdom test proves behaviour, not layout. Keep the pane free of flex `gap`, CSS variables and grid: the embedded browser version is unknown and those fail silently rather than loudly.
