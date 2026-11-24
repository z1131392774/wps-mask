# wps-mask-addon

*[中文](README_zh.md)*

A WPS Spreadsheet add-in that replaces the values in a selected range with realistic fake data, keeps the value mapping encrypted inside the workbook, and restores the originals on demand. This repository also carries the instruction system that governs how the add-in is changed.

## Layout

| Path | What it is |
| --- | --- |
| `wps-mask-addon/` | The add-in. Product manual: [README.md](wps-mask-addon/README.md). Directory rules: [AGENTS.md](wps-mask-addon/AGENTS.md) |
| `wps-mask-addon/test/` | Node scripts: engine logic on a mock object model, AES against `node:crypto`, task pane under jsdom |
| `AGENTS.md` | Standing orders for agents. Read first, every session |
| `docs/` | Standards: [instruction structure](docs/AGENTS.md), [how to make and verify a change](docs/development.md), [seeding this tree elsewhere](docs/adopting.md) |
| `.agents/notes/` | Decision records: why, what was rejected, what it cost |
| `.agents/skills/` | Procedures that load only when their description matches: [pre-push checks](.agents/skills/pre-push-checks/SKILL.md) |
| `scripts/check-docs.mjs` | Documentation gate: budgets, bilingual pairs, links, anchors, trailing newline |

## Run it

```sh
npm run check                              # documentation gate, no install needed
node wps-mask-addon/test/engine.test.js    # mapping engine
node wps-mask-addon/test/aes.test.js       # cipher, compared with node:crypto
npm i jsdom --no-save                      # only for the panel test
node wps-mask-addon/test/taskpane.test.js  # task pane, driven through jsdom
```

Installing the add-in itself: copy `wps-mask-addon/wpsmask_1.0.0/` and `publish.xml` into `%APPDATA%\kingsoft\wps\jsaddons`, then restart WPS. The [product manual](wps-mask-addon/README.md) carries the install steps, the feature map, and the list of parts still unverified on a real device.

## Two mechanical facts

- Root `package.json` declares no `"type"`: the gate is `.mjs` and loads as ESM anyway, while the test scripts are CommonJS and would stop loading under `"type": "module"`.
- `CLAUDE.md` is a symlink to `AGENTS.md`. On Windows it needs developer mode or `New-Item -ItemType SymbolicLink`; a plain copy drifts.
