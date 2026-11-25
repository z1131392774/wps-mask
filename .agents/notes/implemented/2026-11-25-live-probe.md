# Note: Ask the host, don't guess

Status: implemented

*[中文](2026-11-25-live-probe_zh.md)*

## Problem

Every test in this repository runs against `test/mock-wps.js` and the real panel page under jsdom. The manual then lists seven host behaviors — whether `publish.xml` is accepted, whether the pane receives `window.Application`, whether `CreateTaskPane` takes a `file://` URL, whether `Worksheets.Add(undefined, <last>)` returns a sheet, whether a very hidden sheet survives a save, how 100k rows feel, how protected and merged cells behave — and each one can force a code change. The previous practice for the ribbon was a hand-run sixteen-case script, which is neither repeatable nor reviewable.

## Decision

Real-machine work starts with a probe, not a scenario.

`tools/live/wps-bridge.ps1` is a long-lived PowerShell process that speaks one JSON object per line on stdin and stdout: `{"id","op","args"}` in, `{"id","ok","data"|"error"}` out. It owns COM and nothing else — it opens workbooks, reads cells, creates a sheet the way the engine does, hides it, saves, closes, reopens, protects, merges, builds a pane, and times one 100k-row write and read-back.

`tools/live/rpc.mjs` is the Node half of the transport: framing, per-op timeouts, pairing, and rejection of every pending call when the bridge exits. It is deliberately transport-only so it can be tested with fake streams and a real child process.

`tools/live/probe.mjs` asks the seven questions in dependency order and prints one line per answer with a fixed vocabulary: `OK`, `NO`, `UNK` (the host answered but the answer does not settle it), `MANUAL` (no programmatic channel), `SKIP` (needs `--ui` or `--perf`). It ends with an item-to-verdict table meant to be pasted into the manual.

Two rules make the probe safe to hand to a user: it writes only into a scratch workbook it created, never into an open document; and it closes only what it opened. Verdicts live in Node, never in PowerShell.

## Alternatives considered

**Drive the whole mask-and-revert flow through the ribbon first.** Rejected: `invoke` depends on whether `CommandBars` exposes the add-in's controls, which is item 1 of the unverified list. A scenario runner written before that answer either dead-ends at the first click or hardcodes an assumption the probe then contradicts.

**Use UIAutomation for everything.** Rejected: element trees and coordinates drift with language, DPI and theme, and every assertion becomes a screenshot diff. UIA is kept as one narrow fallback — "is the tab reachable at all" — for the case where `CommandBars` says nothing.

**One `powershell -Command` per call.** Rejected: process startup costs more than most operations, so the 100k-row timing would measure PowerShell, and COM state cannot survive between calls — each step would reopen the workbook.

**A native COM binding on the Node side (`winax`, `edge-js`).** Rejected: it needs a native build per Node version and the add-in's promise is that it ships no dependencies. jsdom is already the only devDependency, and adding a native module just to run tests makes the tests harder to run than the product.

**Put the assertions in PowerShell.** Rejected: then framing, timeout and exit behavior could only be checked on a machine with WPS installed. Keeping every verdict in Node is what let `test/rpc.test.mjs` cover the transport with fakes and one real child process.

## Consequences

Item 2 is the probe's weakest answer. Whether the pane receives `window.Application` has no programmatic channel from outside the pane, so the probe opens a page that states the answer in one line and the verdict is `MANUAL`. A human must look once; the alternative was pretending a screenshot check was an assertion.

The record stays manual: probe output has to be pasted into the manual by hand. No script rewrites the verification table, so a stale table is possible and the note says so.

The probe leaves state when it crashes — a scratch workbook may stay open, since cleanup runs at the end. That is visible and harmless, and the alternative (closing everything in a `finally` over COM) was rejected as the kind of cleanup that itself throws.

The first two runs settled four items and produced three wrong verdicts, all mine: a collapsed single-cell read indexed as a string returned its first character, `KetMainFrame` was a class name this host never had, and a missing `CreateTaskPane` was scored as "the host does not support it" when the method simply lives on the add-in JS API surface rather than on the COM object. The probe now prints the raw payload next to each verdict, which is what made the third one visible.

The run also changed the product: a read-only document ignores `Save()` silently, so the mapping table could be dropped while looking saved, and the engine now refuses before saving it.

What the probe cannot answer is now known too. The add-in's buttons are unreachable from outside — no CommandBars entry and no UIA tabs, because WPS draws its ribbon itself — and late binding cannot pass arrays, so 100k-row timing and the pane items have to be answered from inside the add-in, or by a person. That is the next layer, not a gap in this one.

The follow-up on the same day closed those three items. The pane was opened once by hand; from then on it listed the selection's columns, masked them and reverted them, which settles both the pane's host object and the `file://` questions. A single column of 100,000 rows went through 「快速映射」 in about seven seconds end to end, so the host does accept the whole-column array the engine assigns, and the read-back check passed. Two traps cost time and live in `wps-mask-addon/tools/live/HANDOFF.md`: every fresh COM client gets its own hidden WPS instance and cannot see the window a person is looking at, so attaching needs the ROT; and an unclicked confirmation dialog leaves the COM surface answering zeros — 0 CommandBars, a null `Worksheets` — which reads as a failing host unless someone looks at the screen.
