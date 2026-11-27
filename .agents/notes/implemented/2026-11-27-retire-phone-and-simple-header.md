# Note: Retire the phone mode, and detect headers by position and type

Status: implemented

*[中文](2026-11-27-retire-phone-and-simple-header_zh.md)*

## Problem

Two content-reading branches survived after masking moved to JavaScript types.

The phone mode matched a column header against a phone-word list and generated 11-digit numbers from real mobile prefixes. Those fakes are digit strings, so a General-format cell stores them as numbers; revert then needs the loose index to match the coerced value, and every later write has to know about the coercion. The mode also promised a property no requirement asks for once mapping is type-based: a valid, unique phone number.

Header detection was the other kind of guess: a keyword list (姓名/备注/金额/邮箱/手机号 …), a phone-word regex, a text ratio, a "a number follows" rule and a `top === 1` fallback. It produced a documented privacy failure: a first data row containing 备注 was taken for a header and left in the clear while the table looked masked. Every rule was also another list to maintain, and none of them could be explained to a user in one sentence.

## Decision

Delete the phone mode and reduce header detection to one deterministic rule.

- **Phone mode is gone.** `PHONE_HEADER`, `PHONE_PREFIX`, `genPhone`, the `'phone'` signature branch, the `手机号已经用满` error and the `phone` option in the pane dropdown are removed; no configuration can produce it any more.
- **Old settings degrade to text.** A saved configuration from an older document that still says `mode: 'phone'` is read as text: its prefix and digit settings survive, and the values become field-name-plus-digits text.
- **Old documents stay readable without migration.** The vault version stays 2, no bucket is rewritten, and a recorded `'phone'` signature still selects its old bucket, so old fakes revert exactly. A legacy bucket is pruned only by the normal unreferenced-bucket rule, never by this change. Fakes in a retired mixed bucket that happen to look like phone numbers revert the same way, through their recorded entry, not by recognising the value.
- **Header detection uses position and type only.** The selection starts at the worksheet's first row (`top === 1`), the first row has at least one non-empty cell, and no cell in it is a JavaScript number. Any number makes the row data. No keyword list, no phone/email shape, no text ratio, no "a number follows" rule. A single-row selection has no data row and is never a header.
- **The checkbox still wins.** An explicit on or off returns `headerAuto: false`; an auto-detected header stays `headerAuto: true`, so the existing panel hint remains the escape hatch.
- **Trade-off.** All-text data selected from row 1 is indistinguishable from a header and is treated as one. The pane's hint — `首行自动判定为字段名，若首行其实是数据，请取消勾选「首行是表头」` — and the checkbox are the fallback. Keeping a content heuristic to avoid that trade-off is exactly what produced the failure above.

## Alternatives considered

**Keep the phone mode as a deprecated option.** Rejected: the generator, prefix list, capacity error and loose-index path all stay, and the pane would keep offering a mode no requirement wants now that type-based text mapping exists.

**Migrate phone buckets to text and bump `VAULT_VERSION` to 3.** Rejected: the recorded signature and the loose index already revert old fakes; a migration would rewrite vaults that work, and the stored format did not change.

**Delete the phone buckets or let them become orphans.** Rejected: old documents would lose their revert path, and the vault rule says a change either migrates or explains why orphans are fine — here nothing needs to become an orphan.

**Keep a trimmed header heuristic (keywords or a text ratio).** Rejected: the documented failure is a first data row with 备注 left unmasked; any content rule can repeat it with a different word, and a text ratio cannot tell a field name from a name.

**Require the user to set the header flag every time.** Rejected: most tables start with a header at row 1, and a confirmation on every mask is worse than one visible hint in the ambiguous case.

**Drop the header hint because detection is now deterministic.** Rejected: deterministic is not the same as right; the all-text case is exactly where the rule's default can be wrong.

## Consequences

The pane's dropdown loses one mode; the engine loses the phone regex, prefix list, generator and error. `guessMode()` no longer takes a header argument it never used, and `numericStats()` stops parsing numeric strings because its caller already passes real numbers — both private cleanups, no behaviour change.

The header rule is now one sentence with no word list to drift, and the all-text trade-off is stated in the behaviour page and the panel hint instead of hidden. The README, behaviour and verification pages describe four options: number, text, mixed and leave alone.

Old phone documents are covered by engine groups [74] (old bucket and old setting: exact revert, no migration, text fallback on re-mask) and [75] (phone-shaped fakes in an old mixed bucket revert by value type), and group [73] pins the header rule. All six suites and the 74-group engine run pass locally; the retired-phone revert path has no real-device run, and the verification page says so.
