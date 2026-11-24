# A remembered numeric interval may only grow

*[中文](2026-11-24-widen-remembered-interval_zh.md)*

## Problem

Auto-mapping stopped with a modal: "A 列（年龄）的区间只有 21 个整数，装不下 27 个不同值，请放宽区间或设为「不处理」". The user asked two questions: why does auto-mapping hit this at all, and why is it still counting distinct values.

Two mechanisms were stacked:

- Quick mask goes through `hydrate()`: it computes a default config from the current data, then overwrites it wholesale with the config remembered in the vault — `min`/`max` included. So the second run still uses the range of the **previous** batch.
- The first batch, 20~40, is 21 integers and used all 21 slots (`defaultCfg` widens to `hi = ceil(lo) + need - 1`, so capacity equals need exactly, no headroom). The same-named column in another sheet of the same workbook runs 20~46 — 27 distinct values — one more than the old interval holds.

Measured on a 「年龄」 column: first batch 20~40 stores 20/40; second batch 20~46 still resolves to 20~40 and throws; with the same data and no remembered settings the interval comes out 20~46 and passes.

A wider same-name column elsewhere in the workbook, or a few appended rows, is enough to trigger it. Text mode has the same shape: a remembered `digits` that is too small throws "N 位后缀只有 X 个可用".

As for "still counting distinct values": number mode does not invent values, it permutes the column inside the interval — the integers in the interval are the slots, and one-to-one requires distinct originals to occupy distinct slots, so "slots ≥ distinct values" is a hard constraint. The count both sizes the interval and decides feasibility. The earlier "don't count distinct values" decision only covered **text/mixed suffix width**, where the non-empty cell count is already a sufficient upper bound (distinct ≤ cells). In number mode the capacity *is* the interval length, so there is nothing to compute without it.

## Decision

In remembered settings, `mode`/`dist`/`dec`/prefix/digits are the user's choice and are kept as-is; `min`/`max` only describe the batch they came from, so they are **unioned**:

```
cfg.min = min(saved.min, default min of this batch)
cfg.max = max(saved.max, default max of this batch)
```

Grow only, never shrink. This batch always fits its own default interval, and the union is never smaller, so capacity is always sufficient — the "装不下" case can no longer happen on the automatic path. Shrinking is refused too: a smaller interval is a different value space.

The interval is part of `sigOf()`, so growing it means a different bucket. `hydrate()` therefore calls `absorbBucket(vault.maps, oldSig, newSig)` right after widening, carrying records over under their original keys, and writes the widened config back to `vault.settings`. Skipping the move would repeat the `lang` removal accident: the same person gets two different fakes in two areas.

The move reuses the existing collision rules (drop a record when the target already has that key, or when its fake is already taken) through the same `absorbBucket()` the bucket-name migration now uses. Dropped records do not hurt reversion — lookups go through the global index.

Widening only happens when `dec <= 0` and both sides are number mode: fractional intervals have no capacity constraint, and touching them would only change the signature for nothing.

## Alternatives considered

**Widen to "just enough" when the error fires.** Rejected: it fixes this batch and breaks on the next extra value, and it changes the signature without moving records, splitting fakes across sheets.

**Remember policy only, recompute the interval from current data each time.** Rejected: smallest change, but one original can get different fakes in different batches, breaking "identical data in two sheets maps to the same value".

**Keep the error and tell people to widen it in the pane.** Rejected: the point of quick mask is not opening the pane, and a purely data-driven quantity should not need manual upkeep.

**Add 10% headroom to the interval, like text suffixes.** Not done: text headroom exists so random retries can dodge the original, while number mode already has the whole-column permutation; with headroom the `assignExact` condition (equal counts) fails and it falls back to per-value random anyway.

## Consequences

`engine.js` gains `absorbBucket()` (`migrateVault` now reuses it), `widenInterval()` and `copyCfg()`; `mergeCfg()` now takes a precomputed `base` so the default config is not built twice per column. The `capacityHint()` error stays — it is still correct when someone narrows the interval by hand, and the README troubleshooting row now says so.

The pane side needed two fixes, both the same disease in another place:

1. `doMask()` reloads the vault and then applies the pane's configs. A widened cfg against a vault whose bucket was not moved means handing out fakes from a new signature into an empty bucket — the same 28 comes back different in another sheet. It now runs `hydrate()` before applying the pane's configs.
2. The `refresh(true, true)` snapshot copied every column's cfg by header from the **previous selection**, overwriting the union `hydrate()` had just computed: switching sheets brought the narrow interval back. The snapshot now carries only columns the user actually touched (`state.edited`, set in `readCard` and the type dropdown) and is cleared when `keepEdits` is false. Untouched columns must take whatever `hydrate()` computes.

Test group [24] pins the rule with three sheets in one workbook: 20~40 is mapped first (storing 20/40); the 20~46 batch no longer throws and the interval becomes 20~46; 28 gets the same fake in both sheets; only one bucket remains under the new signature; a narrower third batch neither shrinks the interval nor creates records, and 28 keeps its fake; the old area still reverts to 28. `taskpane.test.js` group [12] drives the same scenario through the pane's buttons for the UI-side regression.

The previous note ended with "number mode still balances its interval exactly against the distinct count; changing that needs its own pass". This change is about **memory and the interval**, not the balancing (`hi = ceil(lo) + need - 1` is untouched) — balancing now only sets the starting point on first detection.
