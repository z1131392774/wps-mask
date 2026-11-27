# Note: The panel warns when the header was only guessed

Status: implemented

*[中文](2026-11-24-header-auto-warning_zh.md)*

Updated 2026-11-27: the content-based guess this note made visible was replaced by one deterministic rule — the selection starts at row 1 and the first row contains no number — in [the retire-phone and simple-header decision](2026-11-27-retire-phone-and-simple-header.md). `headerAuto`, the hint and the checkbox survive; the hint now covers the all-text case.

## Problem

`looksLikeHeader()` guesses whether the first row of a selection is a header. It is right for the normal table, and wrong in one shape that matters: a first data row containing a keyword such as 备注, or a selection starting at row 1, is taken for a header and left unmasked. The table then looks masked while the original first row is still there — a privacy failure that looks like success, with no signal in the panel's reading beyond a label the user may not know to check.

The ambiguous case is narrow: when the columns carry a numeric majority, the first row almost certainly is a header, and a warning would be noise on every open.

## Decision

Make the guess visible without changing it.

- `analyze()` returns `headerAuto`: true when the header came from `looksLikeHeader`, false when the caller passed an explicit `hasHeader`.
- The panel appends `；首行自动判定为字段名，若首行其实是数据，请取消勾选「首行是表头」` when the header was auto-detected, every column's default configuration is text mode (no numeric evidence), and the user has not touched the checkbox.
- Checking or unchecking the box sets `headerTouched` and silences the hint; 「重新识别」 resets the state so the guess — and the hint — can return.
- The checkbox itself remains the escape hatch: unchecking makes row 1 data.

## Alternatives considered

**Always show the warning.** Rejected after reading the actual condition: strong-evidence columns would trigger it on nearly every open, and a warning that is always on is ignored.

**Never show it and rely on the 「首行为字段名」 label.** Rejected: the label states what was decided, not that the decision is shaky; the failure mode is exactly a user who does not know to check.

**Block masking until the user confirms the header reading.** Rejected: the guess is correct for most real tables, and a confirmation step on every mask would be worse than the rare wrong guess.

## Consequences

Engine group [35] pins `headerAuto`; pane group [21] pins the hint's appearance, its disappearance after a toggle, and its return after 重新识别. The hint is one sentence and is appended to the existing selection line, so the pane keeps its one-sentence-per-state rule. Tables where every column is text now get an explicit prompt before their first row is left in the clear.
