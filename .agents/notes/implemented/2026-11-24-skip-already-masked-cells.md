# Skipping cells that were already masked

*[中文](2026-11-24-skip-already-masked-cells_zh.md)*

## Problem

Masking a selection that was only partly masked before maps the already-masked columns a second time. The old guard asked whether more than 30% of the whole selection reverse-mapped to an original, and a selection spanning eight untouched columns diluted two fully masked ones below that line: 80 of 388 cells, 21%, no warning. Any share-of-the-selection threshold has the same defect, because the columns that matter are judged by their neighbours. The failure is also silent — the second pass stores `masked value → new value`, so recovering the original takes two reverts and nobody knows that.

## Decision

Decide per cell, not per selection. Before writing, a cell is skipped when both hold: it sits inside a rectangle this add-in recorded as written, and its current value reverse-maps to some original. The recorded rectangles live in the encrypted vault as `ranges`; revert deletes the rectangles it covers, so restored data can be masked again.

## Alternatives considered

**Raise the ratio, or compute it per column.** Rejected: an integer column maps within its own range, so originals and mapped values share one value space. After a revert roughly 85% of the cells in such a column still reverse-map to *some* original, and a per-column ratio would call a restored column "already masked" and refuse to touch it. The signal cannot distinguish the two states; no threshold fixes that.

**Reverse-map only, without recording rectangles.** Rejected for the same reason: an unmasked original that happens to equal another original's mapped value is indistinguishable from a mapped value.

**Make the mapping deterministic so a second pass is idempotent by construction.** Rejected: idempotence would hold only for the exact same configuration. Changing the prefix, the suffix length, or the interval changes the signature, and the cells get mapped again — while a deterministic function still cannot be reversed, which is the whole point of the vault.

## Consequences

The vault gained a field. Documents whose vault was written before `ranges` existed carry no rectangles, so their masked areas are not protected until they are reverted and masked again; the manual says so. The list keeps the most recent 200 rectangles and drops the oldest, which is enough for a workbook edited by hand and bounded enough to stay small inside a cell-limited ciphertext.
