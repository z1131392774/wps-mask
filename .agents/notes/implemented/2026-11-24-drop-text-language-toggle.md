# The text-language dropdown did nothing but split the mapping space

*[中文](2026-11-24-drop-text-language-toggle_zh.md)*

## Problem

The text card carried a 语言 selector — 中文前缀 / 英文前缀 — next to the suffix width. The user asked what it was for, and suspected it was useless. It was worse than useless.

`lang` never reached a generator. `genText` builds `prefix + padNum(random, digits)`; `genMixed` delegates to the same helper. Nothing read `lang`. The selector's only effect was on `sigOf()`:

```
text|zh|姓名|2   vs   text|en|姓名|2
```

Two signatures, same prefix, same digits, same generation. Flipping the dropdown therefore created a *second bucket over the same value space*, and `sigOf` is exactly what separates one mapping from another.

Two consequences, both silent. The same original value mapped on two sheets produced two different fakes, so the token stopped being a stable pseudonym across the workbook. Worse, two buckets sharing a prefix and width draw from the same ten slots, so they collide: a probe with seven names in one bucket and seven accounts in the other produced 姓名4 for both 乙 and E, 姓名7 for both 丙 and F, and so on. `buildIndex` merges buckets with first-wins and no collision check, so reverting Sheet1 turned 甲 乙 丙 丁 戊 己 庚 into 甲 E F 丁 戊 C B — silently, with no error.

The dropdown also never changed what the user saw: switching it left the sample line untouched, because the sample goes through the same `genText`.

`enPrefixOf()` and its twenty-line `EN_DICT` (姓名→Name, 地址→Address, …) were the only consumers of the idea, and nothing in the shipped code called them; both lived in the export list only.

## Decision

Remove the selector, and remove `lang` from the configuration entirely.

- `sigOf` is now `text|prefix|digits` — the two things that actually determine the output.
- `defaultCfg`, `applyMask`'s mixed fallback, `sample`, and `defaultForMode` stopped writing `lang: 'zh'`.
- `enPrefixOf` and `EN_DICT` are deleted, along with the export.
- The card shows 前缀 then 后缀, both full-width rows; the prefix input was already free text, so "type the English name" covers the case the selector pretended to serve.

Old buckets are rewritten on load, by `migrateVault`. Only the bucket key changes — `text|zh|姓名|2` becomes `text|姓名|2` — and the records move across. Nothing in the sheet is touched: no fake value is re-generated, no masked cell is written, so a document masked by the old build keeps its data and its reverse mapping.

The rewrite earned its place by measurement, not by principle. Without it, in a document masked before the change, a person appearing again in a fresh area got a second fake 34 times out of 40, and the two buckets — same prefix, same width — collided 33 times out of 40. Since `buildIndex` merges buckets first-wins, that collision is a wrong restore: the sheet says 姓名3, the table says two different people own it, and revert picks one. With the rewrite, forty runs of mask-then-revert across two areas restored every cell correctly.

Two guards keep the merge honest. A record is dropped rather than moved when the target bucket already has that key, or when its fake value is already taken there — dropping one record loses a mapping, while creating a second owner for a value breaks the one-to-one promise the whole tool rests on. And the rewrite only fires when the middle segment is a two-letter code, so it is idempotent: a migrated key like `text|姓名|2` has a prefix there, not `zh`, and never matches again. The vault version moves to 2, and the load returns a `migrated: {moved, dropped}` count that the tests assert on.

## Alternatives considered

**Keep the selector and make it work.** Rejected: it would have to map 姓名→Name before generating, which is what the prefix field already does in one edit. It would also change the signature whenever switched, so the identity bug would survive the fix.

**Keep `lang` in the config but drop it from `sigOf`.** Rejected: it would leave a field that nothing reads and nothing hashes — a trap for the next reader, and the exact shape of the bug being removed.

**Leave old buckets orphaned.** Rejected after measuring: revert alone survives, because `buildIndex` looks up mapped values across every bucket, and the skip path falls back to the same index. But new work in an old document starts a second bucket over the same value space, which produced a different fake for the same person 34 times in 40 and a collision 33 times in 40.

**Reuse an old `text|zh|…` bucket whenever the new signature misses.** Rejected: it needs a per-header scan on every mask, and it invents a fallback rule that the signature scheme exists to avoid. Rewriting the keys once, at load, costs one pass and leaves no such rule behind.

## Consequences

A regression test (section [22]) pins the shape: `sigOf({mode:'text',prefix:'姓名',digits:2})` must equal `text|姓名|2`, a config carrying a stray `lang` must land in that same bucket, and both langs must sample to the same 姓名 + two digits form. Section [23] builds a document with an old `text|zh|姓名|1` bucket and asserts the load merges it, the records survive, the old area still reverts, a new area reuses the old fake instead of inventing one, only one text bucket remains, and a colliding record is dropped rather than duplicated.

The lesson recorded in `AGENTS.md` about occupancy checks applies here in reverse: anything that enters `sigOf` must change the output. The signature is the identity of a mapping; a field that only changes the signature is a switch that silently renames everyone.

Documents written by the previous build keep working for revert and for skip detection. Anyone who deliberately chose 英文前缀 in such a document will find the old bucket unreferenced; the data in the sheet still reverts, it just no longer shares a mapping with new work.
