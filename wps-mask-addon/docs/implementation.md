# Engine implementation details

*[中文](implementation_zh.md)*

The contracts behind the rules in [AGENTS.md](../AGENTS.md). Read this before changing generation, classification or the vault format; the rules file keeps the one-line rules and links here for the reasoning and the traps.

## One-to-one mapping

The table is keyed `n:`/`s:`/`b:` (number, string, boolean). A generator that probes `used[rawValue]` never sees a collision, because the table's key is not the raw value: `genPhone`/`genText` did that once and one run in sixteen reverted to the wrong original. Probe `used[keyOf(candidate)]`.

When a numeric interval only just holds the distinct values, permute the whole column at random (`sattolo()`, one cycle, no fixed points). Generating value by value forces the last one onto its own value and fails at random; a fixed offset is the original column rotated, which anyone can invert. When the interval cannot hold the values, fail naming the column by letter and header.

`assignExact` computes the span before materialising: a bound of 1,000,000 values is the ceiling, and a non-finite `min`/`max` is rejected rather than looped over. A stretch too wide to permute falls back to ordinary random assignment.

## Mixed-column shapes

`shapeOf()` returns mobile, email, landline, digits, alnum or text; `genMixed` dispatches to a generator that keeps that shape, else `genText`. A new shape needs a `shapeOf` branch, a generator, and a test for what must survive: domain, area code, digits, leading zero. Reverse mapping stays keyed on the original, so the shape that produced a fake is irrelevant at revert time.

## Vault format

`M1:`, `sigOf()` and `KEY_TEXT` are read by existing documents; change one and old buckets stop matching. Add a version field and a migration in the same change, or say in the note why the orphans are fine. Every field in `sigOf()` must change the output; one that only changes the signature silently renames everyone, as `lang` did while also splitting the value space.

Remembered `min`/`max` are data, not policy: union them with the current batch, grow only, then `absorbBucket()`. Keep a bucket that ranges still reference; never fall back to the global index for a missing recorded bucket — count those cells ambiguous instead. A bucket kept only because a range references it is dropped by `pruneUnusedBuckets()` on the next save once no range references it.

Saving is two-phase: the previous ciphertext is backed up to column B and read back, then the new ciphertext is written to column A, read back and decrypted to compare; a failure rolls back or keeps the backup. `checkWritten()` re-reads every written cell (with loose type tolerance) so a host that silently drops a write fails the batch instead of reporting success.

## Pane and ribbon rendering

The pane avoids flex `gap`, CSS variables and grid: the browser version is unknown and those fail silently. It shows only type, a sample and parameters; counts belong to the status bar, and every state gets one sentence. Ribbon icons are SVG in `assets/icons/`, rendered to PNG by `tools/make-icons.mjs`; only a `getImage` callback shows one, `image=` is ignored. Screenshot at 260, 300 and 380 px with `node tools/preview-pane.mjs`.
