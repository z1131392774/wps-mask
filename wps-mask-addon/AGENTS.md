# AGENTS.md — wps-mask-addon

*[中文](AGENTS_zh.md)*

Rules for the add-in. Standing orders: [root file](../AGENTS.md). Manual: [README.md](README.md). Detail behind these rules: [docs/implementation.md](docs/implementation.md).

- **Reach the host only through `MaskGetApp()`.** No bare `Range("A1")`: every object comes from what that helper returns.
- **Judge arrays with `Array.isArray`.** Host values cross a realm boundary: `instanceof Array` is false and a 2D range collapses to one cell.
- **Move whole blocks through `Value2`.** Read into a 2D array, transform in JS, write back in one assignment; per-cell loops are far slower and leave partial state. `checkWritten()` re-reads so a silently dropped write fails loudly.
- **Keep the mapping one-to-one — through `keyOf()` — or throw.** Two originals sharing a mapped value make reverse mapping ambiguous. Capacity, permutation and span guard: [one-to-one mapping](docs/implementation.md#one-to-one-mapping); fail naming the column by letter and header.
- **A mixed column is classified per cell.** `shapeOf()` returns mobile/email/landline/digits/alnum/text and `genMixed` keeps that shape; a new shape needs a `shapeOf` branch, a generator and a test for what must survive ([mixed-column shapes](docs/implementation.md#mixed-column-shapes)).
- **The vault is a file format.** `M1:`, `sigOf()` and `KEY_TEXT` are read by existing documents; a change needs a version field and migration. Bucket retention, migration and save rules: [vault format](docs/implementation.md#vault-format).
- **The outline is part of the vault.** `marks` is a vault field and follows the version/migration rules; its colour is the packed RGB integer, never hex. Internals: [masked-area outline](docs/implementation.md#masked-area-outline).
- **`engine.js` stays host-agnostic.** No DOM, no `window`, no top-level `require`: it must run unchanged in the pane, the host page and Node. `aes.js` uses no `crypto`.
- **Behaviour changes run the tests.** Engine: `node test/engine.test.js`, `node test/aes.test.js`. Clickable or visible: `test/ribbon.test.js`, `test/taskpane.test.js`, `test/utils.test.js` under jsdom.
- **The AES key is obfuscation, not a credential.** `KEY_TEXT` is a constant; moving it into a passphrase or env var means changing the storage format in the same change.
- **Edit files here, never under `%APPDATA%`.** `tools/link-addon.ps1` junctions the installed `jsaddons\wpsmask_1.0.0` onto this folder; `-Rollback` restores `.bak-<timestamp>`.
- **Real-host answers: `tools/live/HANDOFF.md`.** WPS 12.1 measurements, methods and COM traps; `npm run live:probe:log` reproduces the machine-checkable part.
- **Check UI changes in a real render.** jsdom proves behaviour, not layout: preview with `node tools/preview-pane.mjs` at 260, 300 and 380 px. Rules: [pane and ribbon rendering](docs/implementation.md#pane-and-ribbon-rendering).
