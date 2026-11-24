# The interval never fills up, and permutations are random cycles

*[中文](2026-11-24-no-rotation-on-full-interval_zh.md)*

## Problem

After learning that numeric columns are permuted as a whole inside the interval, the user asked whether that means the masked data still shows characteristics of the original — and separately, why the distinct count is needed at all when counting cells is enough.

The first question was right, and worse than expected. `assignExact()` runs when the distinct values exactly equal the integers in the interval; it sorts the originals, sorts the slots, and shifts by r. The interval defaults to the data range, so when the column tiles it the two lists are the same set, and the result is **the original column rotated**:

```
IDs 1~300 → fakes 293,294,…,300,1,2,…,292
sorted, identical to the original   → same multiset, same frequencies
position delta is 292 everywhere    → a substitution cipher with one parameter
know any one real ID                → all 300 rows invert correctly
```

Ages 20~40, each once, behave the same way (shift 6). Sequential IDs and narrow integer columns — ages, ratings, 1~N codes — all land on this path.

The second question does not hold in number mode: capacity there is *how many integers the interval holds*, and one-to-one needs a slot per distinct original. Cell count is a safe upper bound mathematically, but it wrecks the interval: 44 age cells would need 44 slots, turning 20~40 into 20~63 and mapping someone to 57. Text mode can size by cells because its capacity is 10^digits, where the cell count already is the safe bound. That asymmetry is now recorded here and in the README.

## Decision

Two changes, neither sufficient alone:

1. **Leave empty slots in the default interval.** The numeric branch of `defaultCfg` no longer aims for "just enough": `want = max(need + 1, ceil(need × 1.1))`, growing the upper bound when needed — ages 20~40 become 20~43 (24 slots for 21 values), IDs 1~300 become 1~330. At least one spare slot guarantees "distinct values < integers", so the fill-up path never happens under automatic mapping. The 10% matches the ruler used for text suffix width.
2. **Permute as a random cycle.** `assignExact` shuffles the slots with `sattolo()` before pairing: the result is a single cycle, which has no fixed points for length ≥ 2 and leaves no constant offset. This is the path taken when someone narrows the interval by hand until it just fits.

The interval is part of `sigOf()`, so growing it changes the signature — the union plus `absorbBucket()` work from the previous round covers that: records move, old fakes stay valid, new values come from a wider space. No extra migration path was needed.

## Alternatives considered

**Spare slots only, keep the shift.** Not enough: narrowing the interval in the pane until it just fits still degrades to a rotation, and "exactly full" is an easy state to reach in the pane.

**Random cycle only, no spare slots.** Not enough: the sorted multiset still equals the original, so the frequency profile leaks (even though it is no longer invertible from one known value).

**Size the interval by cell count** (the user's suggestion). Rejected: 44 cells demand 44 slots, so 20~40 becomes 20~63 and someone is 57. Number mode needs the distinct count — it *is* the capacity constraint, not an optional statistic.

**Give the lower bound headroom too.** Not done: lowering an amount range produces negative fakes and lowering an age range produces 2-year-olds, and whether that is plausible depends on the field. The residual is documented instead: the interval's minimum and maximum still equal the data's, and can be observed.

## Consequences

`engine.js` gains `sattolo()`; the numeric branch of `defaultCfg` uses `want`; `assignExact` loses the offset. Intervals are about 10% wider than the data (ages 20~43, IDs 1~330) — more spread out, same order of magnitude, still plausible.

Areas already masked in existing documents do not change: that history cannot be recalled, and the fix only affects values written from now on. Saved intervals are recomputed on the next hydrate through the union and spare-slot rules, with records carried along.

Tests: group [16] now narrows the interval by hand to force the permutation path and asserts that the position delta is not constant (the old assertion — no fixed points — was satisfied by a rotation too); group [26] runs 300 IDs through the default path and asserts the 1~330 interval, unique fakes, no fixed points, a sorted list different from the original, and a non-constant delta; [24] and [25] update their expected intervals to 43 / 49 / 112. The README's encryption-limits section gained "what the fakes still reveal", spelling out the residuals: min/max, row count, blank positions, row order, and the shape of text values.
