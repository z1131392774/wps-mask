# Handoff: finish the last three real-machine items

*[中文](HANDOFF_zh.md)*

Status: handoff note, written for whoever can create COM objects.

This repository is a WPS Spreadsheets add-in that masks data. Nearly all of it is verified against mocks; **three questions only a real host can answer are still open**. You have COM, so they are yours. Everything else in this file says what has already been measured (do not measure it again), how to measure the rest, and where the answers go.

---

## 1. Facts already measured

Host: WPS Spreadsheets **12.1.0.29161** (`C:\Users\Administrator\AppData\Local\Kingsoft\WPS Office\12.1.0.29161\office6`), Windows Server 2022, from two complete probe runs on 2026-11-25. Treat these as premises; do not re-verify them.

| Fact | Result |
| --- | --- |
| ProgID | `Ket.Application` works; `app.Name` returns `Microsoft Excel 12.0` (WPS presents an Excel-compatible surface) |
| Main window UIA class | **`KPromeMainWindow`** (title "WPS Office"). `KetMainFrame`, `XLMAIN` and `OpusApp` do not exist here |
| Ribbon reachability | `CommandBars` has 186 bars and **none** belong to the add-in; UIA lists **no Tab/TabItem** under `KPromeMainWindow` (WPS draws its ribbon itself) |
| `Worksheets.Add(undefined, <last>)` | **Works** with `[System.Reflection.Missing]::Value`; the sheet lands at the end |
| Hiding a sheet | `Visible = 2` is accepted, **even on the active sheet** (Excel refuses this; WPS does not) |
| Hidden sheet across save/reopen | Passes: `Visible` is still 2 and the ciphertext reads back intact |
| Write into a protected sheet | Refused by the host (error `0x8FE30C28`) |
| `Save()` on a read-only document | **Neither throws nor writes** (mtime unchanged), while edits stay in memory |
| Write into a non-anchor merged cell | **Neither throws nor takes effect**; reading back gives `[[null, null]]` |
| Late-bound `Range.Value2 = array` | **Refused**, one- and two-dimensional alike: `Unable to cast object of type 'System.Object[,]' to type 'System.String'`. Single-cell writes and large reads work (100k cells back in 72ms) |
| `CreateTaskPane` | **Not on the COM object** (`System.__ComObject` has no such method). It lives on the add-in's own JS API surface; not seeing it does not mean the host lacks it |

---

## 2. The three that remain, and why I could not measure them

### 2.1 100k-row performance and whether array writes work (item 6, the important one)

This is not only about speed. The engine writes a whole column at once (`engine.js:1577 writeColumn`: `rng.Value2 = arr`), so **if WPS rejects arrays, masking fails in one batch**. Answer "are arrays accepted" before asking "how fast".

The blocker was not COM, it was **late binding, which does not pass SAFEARRAYs**. Another host language does:

- **Python + pywin32**: `ws.Range(ws.Cells(1,1), ws.Cells(n,1)).Value2 = tuple((v,) for v in values)`
- **C#**: `Add-Type`, then assign `object[,]` to a `dynamic` `Value2`
- **VBScript/JScript under cscript**: `rng.Value2 = arr` passes too

Measure three things and record all of them:
1. One column of 100k rows assigned as `object[]`/`tuple`: accepted? how many milliseconds?
2. N rows × 3 columns assigned as one 2-D array: accepted? how long?
3. The shape read back from `Value2` — `(n,1)` or collapsed to one dimension. `to2D()` in the engine depends on this.

### 2.2 Whether the pane receives `window.Application` (item 2)

The pane is an HTML page (`wpsmask_1.0.0/taskpane/index.html`) opened by `CreateTaskPane(file://…)`; it reaches the host through `window.Application`. When that is missing it shows 「未取到 WPS 应用对象」.

This cannot be measured from the COM side (see above: `CreateTaskPane` is not on that surface). Options, cheapest first:

1. **Fastest:** a person clicks 「数据脱敏 → 面板」 once and reads what the panel says. One sentence settles it.
2. If it must be programmatic: try the other ProgIDs (`KET.Application`, `et.Application`, `WPS.Application`) — they return objects, but `CreateTaskPane` is still absent from that late-bound surface. **Do not spend more than twenty minutes here**; one look is faster.
3. If it really is unavailable: run the operations on the host page instead — `MaskQuickApply` and `MaskQuickRevert` in `ribbon.js` already call the same engine, and the panel can degrade to a read-only explanation.

### 2.3 Whether `CreateTaskPane` accepts a `file://` URL (item 3)

Same cause. **If 2.2 works, this comes free**: the returned pane reports a non-empty `ID`, `Visible = true` sticks, and `GetTaskPane(id)` finds it again. The bridge already has a `pane` op taking `{ url, visible }` and returning `{ id, visible, reopenVisible, url }`.

---

## 3. Tools that already exist

```sh
cd D:\workspace\wps-mask
npm run live:probe        # machine-checkable steps only, no window
npm run live:probe:all    # adds the window, the pane, and 100k rows
npm run live:probe:log    # same, and writes the result to probe.log
```

Four files under `tools/live/`:

- **`wps-bridge.ps1`** — a long-lived process speaking one JSON object per line: stdin `{"id","op","args"}`, stdout `{"id","ok","data"|"error"}`. It moves data and decides nothing. Try one op by hand:
  `'{"id":1,"op":"app"}' | pwsh -NoProfile -File wps-mask-addon/tools/live/wps-bridge.ps1`
- **`rpc.mjs`** — the Node transport: framing, per-op timeouts, id pairing, and rejecting every pending call when the bridge exits. Transport only, so it is tested without WPS (`test/rpc.test.mjs`).
- **`log.mjs`** — the `--log` tee: whatever reaches the screen also reaches the file.
- **`probe.mjs`** — asks the seven questions in dependency order, prints one verdict per line, and ends with a table meant for the manual.

**Ops** (argument names already cost a bug once; use these):

| op | args | Notes |
| --- | --- | --- |
| `hello` / `echo` | `text` | No COM; verifies the bridge and UTF-8 |
| `show` | `visible` | Show or hide the window |
| `app` | — | Version, path, open workbook count, TaskPane-related members |
| `newbook` | `visible` | New workbook; returns `name` |
| `open` | `path`, `readOnly`, `visible` | Returns `name`, `readOnly` |
| `addsheet` | **`book`**, **`sheet`**, `visible`, `marker`, `style` | `style: 'plain'` uses the bare `Add()`; the default reproduces the engine's call |
| `set` | `book`, `sheet`, `r`, `c`, `rows` | `rows` is an array of arrays |
| `read` | `book`, `sheet`, `r`, `c`, `rows`, `cols` | Returns `{ rows }`; **a single cell may collapse to a bare value** |
| `sheets` | `book` | Name, visibility, index |
| `setvisible` | `book`, `sheet`, `visible` | |
| `activate` | `book`, `sheet` or `index` | |
| `protect` | `book`, `sheet`, `password`, `off` | |
| `merge` | `book`, `sheet`, `r1`, `c1`, `r2`, `c2` | |
| `stat` | `path` | `mtime`, `size` — decides whether a save actually wrote |
| `save` | `book`, `as` | Returns the new `name` (`SaveAs` renames it), `saved`, `mtime` |
| `close` / `quit` | `book` | |
| `controls` | — | `items` (add-in controls), `bars` (bar names), `barTotal` |
| `uia` / `uiaribbon` | — | Top-level windows / ribbon tabs and buttons |
| `pane` | `url`, `visible` | Creates a task pane |
| `bench` | `book`, `rows`, `cols` | Times a 1-D column write and a 2-D block write, recording refusals too |
| `invoke` | `id`/`tag`/`caption` | Executes a CommandBars control by name (**add-in buttons are not there**) |

---

## 4. Where the answers go

Section five of `wps-mask-addon/README_zh.md` holds a "measured on a real device" table; its English twin is `README.md`. **Both halves change together** — `npm run check` enforces pairing, budgets and links.

Only four verdicts exist: passes, fails, unmeasured, needs a human. **Never write "unmeasured" as "fails"** — that mistake produced three wrong verdicts in this round (a collapsed single-cell read, a class name that does not exist, and a method absent from the COM surface).

If something does fail, this is what to change:

| Symptom | Where |
| --- | --- |
| Creating the hidden sheet fails | `engine.js:561` — `Add(undefined, <last>)` has no fallback |
| Array writes are refused | `engine.js:1577 writeColumn`, and the chunked writer near `:1565` |
| A read-only document can be masked | `engine.js:797 saveVault` already refuses on `ReadOnly`; find the path around it |
| Merged cells drop writes silently | `engine.js:1562 checkWritten` — the read-back already detects and rolls back |
| The pane has no host object | `ribbon.js:76` `CreateTaskPane`; move the operations to `MaskQuickApply` / `MaskQuickRevert` |

---

## 5. Do not

- **Do not edit `test/mock-wps.js` to match the host.** The mock states the contract; when the host disagrees, the contract is wrong — fix `engine.js` and add a test.
- **Do not commit `probe*.log`** (already ignored; it carries local paths).
- **Do not edit files under `%APPDATA%\kingsoft\wps\jsaddons\`.** It is a junction onto this tree, so editing the tree is enough; `tools/link-addon.ps1 -Rollback` undoes it.
- **Do not use `name` to mean a workbook.** That name once meant both "workbook" and "new sheet", and creating a sheet reported "no open workbook named 探针表".
- **Do not trust UIA to click buttons.** The ribbon is drawn by WPS, UIA lists no tabs; either a person clicks, or assertions run inside the add-in.
- **Do not claim something was verified when it was not.** Three doc statements were corrected this round for exactly that.

---

## 6. The cheapest path forward

1. Run `npm run live:probe:log` and confirm the baseline still matches the table; if it moved, explain the difference before going on.
2. Measure **array writes** (item 6) with Python/pywin32 or C# — it is the only item that can overturn the architecture.
3. Have a person click the panel once to settle item 2; then run the `pane` op for item 3.
4. Write both README halves, run `npm test && npm run check`, commit.

To see why this tooling looks the way it does, read `.agents/notes/implemented/2026-11-25-live-probe.md` first.
