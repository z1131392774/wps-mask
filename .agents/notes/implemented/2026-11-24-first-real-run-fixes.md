# What the first real run taught us

*[中文](2026-11-24-first-real-run-fixes_zh.md)*

## Problem

The first run against a real workbook produced one hard failure and three complaints, and every one of them traced to something the mock could not see.

The failure: quick mask stopped with "第「7列」有 41 个不同值，但区间只有 40 个整数可取". The sheet's 工号 column holds exactly 1001–1040, forty values in forty integer slots. Two independent defects were hiding under that number. First, header detection vetoed the whole table when a single cell in the first row was empty — a selection that reached one column past the data was enough — so the header cell 工号 became data, giving forty integers plus one string: 41 distinct values against 40 slots. Second, with the header question fixed the same column still failed at random: forty distinct values in forty slots requires a derangement, and generating value by value walks itself into a corner — the last value's only remaining slot is its own, which the engine refuses — so the same selection succeeded or failed depending on the shuffle.

The complaints: the error named "第 7 列" instead of the G the user was looking at; opening the panel did not identify anything until 刷新选区 was pressed; and the first successful mask switched the view to another sheet.

## Decision

Fix each cause at its own level rather than adding guards around them.

Empty cells no longer vote in header detection, and no longer veto it: a row whose non-empty cells are mostly text with a field-name keyword is a header, whatever sits in the gaps. Columns that are entirely blank inside the selection are dropped from the model, so an over-wide selection stops producing empty cards.

When the interval holds exactly as many integers as the column has distinct values, the column is assigned as a whole: keys and slots sorted, then offset by a random amount between 1 and n−1. That is a permutation with no fixed point, it always exists when n ≥ 2, and the random offset keeps it from being a visible +1 shift.

Capacity messages name the column the way the user sees it — `G 列（工号）` — and say what to do: widen the interval, or set the column to 不处理.

`defaultCfg` widens an integer interval to the smallest bound that fits (`1001~1040` missing one slot becomes `1001~1041`) instead of letting a stray text value in a numeric column abort the mask. It widens to the smallest sufficient value, not to the next power of ten, because a "年龄" column with one 待定 in it must not start producing seven-thousand-year-olds.

Creating the hidden mapping sheet now records the active sheet, adds and names the sheet, activates the original again, and only then hides the new one. Hiding an active sheet is what fails silently and leaves it visible; adding one is what moves the user's view.

The panel reads the selection on open with a retry loop (20 × 250 ms, because the host object may not be injected at first paint), and afterwards polls a selection fingerprint every 800 ms. A new fingerprint must appear twice before it re-analyses, which debounces drag-selection; the parameters the user already edited are snapshotted by header name and reapplied, so following the selection does not throw away their work.

## Alternatives considered

**Keep the ratio/veto header heuristic and tell the user to deselect the empty column.** Rejected: the tool saw the user's data and got it wrong; making them work around it is the wrong side of the deal.

**Partial masking: skip the failing column and mask the rest.** Rejected for now. Half-masked sheets are worse than a stopped one unless the report is impossible to miss, and with the two fixes above the ordinary cases no longer fail. The message tells the user which column to fix.

**Raise every tight interval to the next digit boundary (`1001~1040` → `9999`).** Rejected: it fixes nothing for a two-digit column and produces absurd values for 年龄.

**Skip the column when its interval is tight, leaving those cells untouched.** Rejected: silent partial masking of a single column is the failure mode the whole feature exists to prevent.

**Watch the selection through a host event (`ApiEvent`/`SheetSelectionChange`).** Preferred if it exists, but no version of it is documented in the local set, and a listener that silently never fires would look exactly like a broken panel. Polling 4 property reads every 800 ms is cheap and verifiable today; the event is a follow-up once someone confirms it.

**Re-read on every poll tick instead of on change.** Rejected: it would rebuild the cards under the user's cursor while they type.

## Consequences

Two failure modes are gone but both fixes are now load-bearing: the derangement path is the only way a tight column can ever succeed, so `engine.test.js` runs it eight times per run to catch a regression that only appears sometimes. Header detection now tolerates gaps, which means a data row whose non-empty cells are mostly text and contain a field-name keyword (a stray "备注" in the data) could be mistaken for a header — narrow enough to accept, and the 首行是表头 checkbox is the escape hatch. Polling assumes reading `Selection.Row/Column/Rows.Count/Columns.Count` is cheap in WPS; unverified on a large workbook, and the interval is one constant if it needs raising.
