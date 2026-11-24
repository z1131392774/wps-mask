# Note: Text suffixes sized by need, not by a round number

Status: implemented

*[中文](2026-11-24-suffix-digits-by-need_zh.md)*

## Problem

The text mode shipped with a hard-coded four-digit suffix — 10,000 slots. That number was a leftover default, never tied to the data; but it looked tied to it. A 41-row name column came out as 姓名0037, which reads like a running index and is one digit longer than the column needs.

After the mixed-mode work the user asked directly: why must the suffix be sized by the data count — that is unnecessary, 1.1× is about enough.

## Decision

Suffix digits are now derived from the column's non-blank cell count, with 10% headroom:

```
n = ceil(cells × 1.1)
digits = the smallest d with 10^d ≥ n, clamped to 1..8
```

So 7 cells get one digit, 41 get two (姓名37), 100 get three, 999 get four.

The count is cells, not distinct values. A one-to-one mapping never needs more distinct results than there are cells, so the cell count is a safe upper bound, and it is already known — while a distinct count means building a set keyed by every value in the column, a ten-thousand-key table for a ten-thousand-row sheet, to save one digit at most. The user put it plainly: no need to count distinct values.

The trade-off is real and accepted: a column of 41 rows holding only 3 distinct departments gets two digits where one would do. It costs a digit, never a guarantee.

The headroom is 10% rather than zero because exact sizing repeats the integer-interval lesson: when the space equals the count, the last record has only its own slot left and the random retry collapses into a deterministic scan. Ten percent is enough for a retry to dodge the original, and not enough to cost another digit.

The multiplier has one inevitable edge: past 909 cells a digit is added, because 909 × 1.1 = 999.9 rounds to 1000 and 910 does not. That boundary is asserted in the test rather than papered over.

Switching a column's mode by hand uses the same rule (`defaultForMode` calls `E.suffixDigits(col.nonEmptyCount)`); otherwise auto-detection would show two digits and a manual switch would silently restore four.

## Alternatives considered

**Keep the fixed four digits.** Rejected: 10,000 slots for 41 rows is 244× headroom, and 姓名0037 is longer and more index-like than 姓名37.

**Size exactly, no headroom.** Rejected: the last few records thrash in the retry loop — the integer interval already taught that lesson.

**Count distinct values instead of cells.** Rejected: it needs a pass that keys every value into a set — a ten-thousand-key table for a ten-thousand-row sheet — and buys one digit at most on duplicated columns.

**Leave 1.5× or 2× headroom.** Rejected: ten values would jump to three digits and a hundred to four, buying nothing. Uniqueness is per column, not a defence against collision attacks.

**Floor the suffix at two digits.** Not done: 部门0 looks like a subscript, but nine departments really do need only nine suffixes, and adding a digit for looks is exactly the "digits unrelated to the data" problem again. One word from the user and it changes.

## Consequences

`defaultCfg` now carries the computed `digits` on both the text and mixed branches, so a mixed column's Chinese fallback shortens too. Documents that already stored settings keep the digits recorded in their table.

The card no longer reports "本列 N 个不同值，M 个非空" — the user pointed out that WPS's own status bar already counts a selection, so the line was duplicating the host. With the display gone, `analyze` stopped building a per-column distinct set as well: nothing consumed `distinctCount`, and it was one `keyOf` call per cell on every analysis. `nonEmptyCount` stayed, because the suffix width needs it. Tests that used the field as a premise now count the fixture themselves.

Section [21] of `engine.test.js` walks the integer boundaries of the rule (0/7/9/10/41/90/100/900/909/910/one hundred million), masks a 41-row name column asserting 姓名 plus two digits and forty-one distinct results, and pins the cells-not-distinct choice with a 41-row column of three repeated names that still gets two digits.

Number mode has since moved in the same direction: the default interval now leaves spare slots and permutes them as a random cycle ([the interval never fills up](2026-11-24-no-rotation-on-full-interval.md)), so the exact `ceil(lo) + need - 1` sizing only survives when someone narrows the interval by hand. Text mode's cell-count rule here is unchanged.
