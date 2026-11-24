# wps-mask-addon

*[中文](README_zh.md)*

A WPS Spreadsheet add-in: replace the values in a selected range with realistic fake data, keep the mapping encrypted inside the workbook, and restore the originals on demand. The repository also holds the instructions that govern changes to the add-in.

## Layout

| Path | What it is |
| --- | --- |
| `wps-mask-addon/` | The add-in. Product manual: [README.md](wps-mask-addon/README.md). Directory rules: [AGENTS.md](wps-mask-addon/AGENTS.md) |
| `wps-mask-addon/test/` | Node scripts: engine tests on a mock object model, AES compared with `node:crypto`, task pane tests under jsdom |
| `AGENTS.md` | Rules for agents, read at the start of every session |
| `docs/` | Standards: [instruction structure](docs/AGENTS.md), [how to make and verify a change](docs/development.md), [reusing this layout in another repository](docs/adopting.md) |
| `.agents/notes/` | Decision records: why this option, what was rejected, what it cost |
| `.agents/skills/` | Procedures loaded only when their description matches the task: [pre-push checks](.agents/skills/pre-push-checks/SKILL.md) |
| `scripts/check-docs.mjs` | Documentation checks: word budgets, bilingual pairs, links, anchors, note headers, trailing newline |

## Checks and tests

```sh
npm run check                              # documentation checks, no install needed
node wps-mask-addon/test/engine.test.js    # mapping engine
node wps-mask-addon/test/aes.test.js       # cipher, compared with node:crypto
npm install                                # test dependency (jsdom), for the panel and helper tests
node wps-mask-addon/test/taskpane.test.js  # task pane, driven through jsdom
node wps-mask-addon/test/utils.test.js     # shared helpers: status bar, errors, host lookup
```

`npm test` runs all four test files in that order.

To install the add-in itself, copy `wps-mask-addon/wpsmask_1.0.0/` and `wps-mask-addon/publish.xml` into `%APPDATA%\kingsoft\wps\jsaddons`, then restart WPS. The [product manual](wps-mask-addon/README.md) has the install steps, the feature list, and the parts still unverified on a real device.

## Two setup details

- Root `package.json` declares no `"type"`: the check script is `.mjs` and loads as ESM regardless, while the test scripts are CommonJS and would fail to load under `"type": "module"`.
- `CLAUDE.md` is a symlink to `AGENTS.md`. On Windows it needs developer mode or `New-Item -ItemType SymbolicLink`; a plain copy gets out of sync.
