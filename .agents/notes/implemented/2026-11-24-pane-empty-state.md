# The pane loses its refresh button, and its empty state says one thing

*[中文](2026-11-24-pane-empty-state_zh.md)*

## Problem

With nothing selected the pane said three things at once: "未读取到选区" under the title, "读取选区失败" in the middle with "调整选区后点上方「刷新选区」重试" beneath it, and a red "请选中至少两个单元格" in the status bar. All three described the same situation, and two of them described it as a failure — the user had simply not selected anything yet. The red line was the worst of it: the pane reported an error before the user did anything.

The user then asked five questions about that screenshot: what 刷新选区 is for and whether it should exist; whether 首行是表头 must exist; whether 重新识别 must exist; whether the two stacked messages contradict each other; and whether the "click refresh to retry" sentence earns its place.

## Decision

**Remove 刷新选区.** The pane already compares a selection fingerprint every 800 ms and re-reads when it changes; a button that re-reads on demand does what the poll does anyway. Its real fault was the failure path: it told the user to retry by pressing it, when a failed read usually means the host object or the selection is not ready — pressing the same button returns the same failure. The poll is now the recovery path: a late host object is picked up on the next tick.

Stated cost: editing cells inside the same rectangle does not refresh the samples, because the fingerprint only tracks position. The written result is unaffected — `doMask` re-analyzes before writing, so it always writes the current values — only the sample line can go stale. A content hash every 800 ms is not worth that.

**Four empty states, one sentence each.** Nothing selected → "在表格里选一块区域". One cell → "选中的格子太少", plus a note that with a header the first row counts as field names. All blank → "这块区域没有可处理的数据". No host object → the only real error, "未取到 WPS 应用对象", pointing at the ribbon's quick mask. None of the four writes to the status bar: that line is for the result of an action.

**No toolbar without a selection.** Nothing to expand, nothing to re-detect. The header checkbox is part of that bar for the same reason: it acts on the current region, and there is no region yet.

**首行是表头 stays.** It is not a WPS switch, it is this feature's semantics: with it on, the first row is not masked and supplies the text prefix; with it off, the first row is data. Detection can be wrong — a data row containing 备注 turns into a header — and nothing else can correct it.

**重新识别 only appears when there is something to ignore.** In a fresh document it was a no-op occupying the most prominent spot on the bar. It now shows only when the document carries remembered settings, and masking or reverting refreshes the cards — so the samples show what was just written, and the document's new memory makes the button appear at that moment.

**Write buttons start disabled.** Between opening the pane and reading a selection there is up to five seconds of retries, waiting for the host object. Both buttons were clickable in that window and could only answer "请先读取选区"; they now start disabled and open when columns arrive.

## Alternatives considered

**Keep the button, fix its label.** Rejected: the action duplicates the poll. Better words for a redundant action are still a redundant action.

**Merge the empty states into "请选择区域后重试".** Rejected: three of the four are ordinary, one is a fault. One sentence for all of them hides the fault.

**Delete the header checkbox and rely on detection.** Rejected: detection keys on "mostly text plus a field-name word", so a headerless sheet whose first row contains 备注 is misread, and the cost of that misread is a whole data row left unmasked.

**Show 重新识别 always.** Rejected: in a new document it does nothing, in the most visible place. Showing it on demand costs nothing — documents with memory still get it.

## Consequences

`showEmpty(kind, detail)` is the only way into an empty state; `showTools(model)` owns the bar and the 重新识别 visibility. The catch block in `refresh()` now separates no-host, no-selection, too-small and real error.

Tests wait for the poll (`await sleep(1900)`; the fingerprint must repeat before it re-analyzes) instead of clicking a button, which means the auto-follow path is now actually exercised. New assertions: no toolbar in the empty state, no "读取失败" when nothing is selected, no duplicate in the status bar, "太少" for a single cell, 重新识别 absent in a fresh document and present after masking, and samples refreshed to the masked values.

One small regression is accepted: after editing cells inside the same selection, the samples wait until the selection moves or the pane reopens.
