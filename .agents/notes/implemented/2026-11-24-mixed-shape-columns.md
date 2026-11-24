# Note: Masking a column that is not one kind of thing

Status: implemented

*[中文](2026-11-24-mixed-shape-columns_zh.md)*

## Problem

A real workbook has account columns that hold a mobile number on one row, an email on the next, a landline on the third, and an order code on the fourth. Every earlier mode assumed a column had *one* type, decided by a majority vote: ≥60% mobile-shaped means phone, ≥80% numeric means number, otherwise text. A mixed column falls through that vote into text, and text means every value becomes 字段名+数字 — a phone number, an email address, an interbank code all flattened into `账号4527`. The masking is technically correct, one-to-one, and reversible, and the result is useless as test data: nothing about the column survives.

Forcing one type instead is worse. `账号4527` in a phone column breaks validation in whatever consumes the file; planting a phone number where an email belongs breaks it in a different place. The column's own variety is the thing that has to be preserved.

## Decision

Add a fifth mode, 混合 (mixed), where the shape is decided per cell instead of per column. `shapeOf()` classifies one value into mobile, email, landline, digits, alnum, or text, in that order, and `genMixed` dispatches to a generator that keeps the shape:

| Shape | Preserved | Example |
| --- | --- | --- |
| mobile | validity (`1[3-9]` + 9 digits), uniqueness | `13812345678` → `15924494139` |
| email | domain, so only the local part changes | `li.na@corp.com` → `u005288@corp.com` |
| landline | area code, separator, digit count, extension | `020-88997766` → `020-41283071` |
| digits | length, leading zero | `000123` → `000233` |
| alnum | letter/digit positions | `kf_2024_001` → `ud_9309_739` |
| text | nothing — falls back to 字段名+数字 | `王小明` → `账号4527` |

One-to-one is unaffected, and that is the point of keeping the mapping keyed by original rather than by shape: the table stores `原值 → 新值`, so reverting never needs to know which generator produced a value. A column can therefore mix six shapes and still revert in one click.

`guessMode()` falls back to `mixed` when any value is an email or a landline, or when at least two of the mobile/digits/alnum/text families are present; a header matched to a phone field, a ≥60% mobile majority, or ≥80% numbers still wins as phone or number first. The card shows the mode and a per-shape sentence, and the snapshot/edit machinery treats `mixed` like any other mode.

## The defect this uncovered

Writing a probe that masks a mixed column two hundred times exposed a bug that had nothing to do with mixed columns. The occupancy map `used` is keyed by `keyOf()` — `n:12`, `s:李雷`, `b:true` — because a number and a string of the same characters must not collide. `genPhone` and `genText` probed `used[rawValue]` and `used[candidate]` without the prefix, so they never saw an occupied slot. Two originals could therefore be assigned the same mapped value; the table then held two entries pointing at one value, and reverting restored whichever entry won the lookup. In two hundred runs of a forty-value phone column, twelve produced a duplicate and eleven reverted a row to the wrong original — a 6% chance per mask, silent, and only visible on a revert diff.

Both generators now probe `used[keyOf(...)]`. The same probe reports zero duplicates and zero wrong reverts. Section [18] of `engine.test.js` locks it down by calling `genText` with ninety-nine slots occupied and asserting the one free suffix comes back, and section [16] masks the same column eight times to catch a regression that only appears sometimes.

The same probe caught a second, smaller lie in the digits generator. Its comment said "a value starting with 0 keeps starting with 0" and its code only widened the random range to include zero, which makes a leading zero about a 10% accident; `000123` came back as `216343` in 184 of 200 runs. A zero-padded code is a format — 工号 `000123` and `000233` belong to the same column, `216343` does not. The generator now keeps the original zero run verbatim and randomises only the digits after it, with `000000` falling back to one varying digit and `123456` still unable to grow a leading zero. The probe went to zero losses, and section [20] runs the padded column two hundred times plus an end-to-end mask and revert.

While fixing that, `PURE_DIGITS_RE` dropped from three digits to two: a province or channel code like `01` was being classified as text and replaced with `账号6549`. A one-character value is still too short to call a code and takes the text fallback, which is documented rather than papered over.

## Alternatives considered

**Per-value manual choice in the panel.** Rejected: it moves the work onto the user, and the whole request was "handle this automatically". A column of two hundred accounts would need two hundred decisions.

**Force the majority type and accept the loss.** Rejected: it produces data that fails downstream validation, which is the failure the masking was supposed to prevent.

**Keep the original domain, local part, and *also* the original digits.** Rejected: `138****5678`-style partial masking is a different feature (display masking) with different guarantees; here the value must be entirely synthetic while remaining valid.

**Replace the email domain too.** Rejected: a domain is often a company identity the test data should still recognise, and swapping it makes the column useless for anything that groups by domain. The cost — the domain stays visible — is stated in the README rather than hidden.

**Drop mixed cells (leave them unmasked).** Rejected: leaving real phone numbers and emails in a "masked" file is the worst outcome available.

**A separate 账号 mode with one generator.** Rejected in favour of shape dispatch: a single generator cannot produce a valid mobile and a valid email from the same rule, and the taxonomy is the thing that makes the behaviour explainable in a table.

## Consequences

The shape taxonomy is now a contract. Adding a shape means a `shapeOf` branch, a generator, and a test asserting the bit that must survive — the domain, the area code, the digit count, the leading zero. `AGENTS.md` states it as a standing rule.

Two limits are documented rather than removed: an email keeps its domain, so `@corp.com` remains visible; and a very short code such as `a1` has a small shape space (`26 × 10`), where the add-in reports 空间不足 instead of repeating a value.

The classification is by regex, so a code that begins with a digit (`2024abc`) or carries punctuation outside `_ . -` falls to the text fallback. It stays one-to-one and revertible; it just does not look like the original. Widening `ALNUM_RE` would fix those two families and start swallowing Chinese text with a digit prefix, which is why the narrow rule was kept and the fallback documented in the troubleshooting table.

The README and `AGENTS.md` budgets were raised (`1600 → 1780`, `450 → 480`) after trimming duplicated prose: a fifth mode with five shapes and two stated limits does not fit in the old numbers without deleting verified facts, and the gate exists to stop bloat, not to cap coverage.
