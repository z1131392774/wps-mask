# Note: A vault save keeps a verified backup of the previous table

Status: implemented

*[中文](2026-11-24-atomic-vault-save_zh.md)*

## Problem

`saveVault()` cleared the previous ciphertext from the hidden sheet and then wrote the new chunks. A host error or an interrupted save between those steps left the sheet with no readable table. `loadVault()` read a missing ciphertext as "this document never had a mapping", so the failure surfaced as an empty mapping: the masked data was still in the sheet, the originals were unrecoverable, and nothing had reported an error.

The same read treated a damaged table as new, which made tampering and corruption silent in the same way.

## Decision

Make the save transactional through a backup column, and make the load distinguish "new document" from "unreadable table":

- The vault sheet keeps column A as the live ciphertext (A1 notice, A2 onward chunks) and column B as the previous ciphertext (B1 backup marker, B2 onward).
- `saveVault()` copies the current readable ciphertext (A, else B) into B, reads B back and checks the marker; it then writes A, reads the whole chunk back, and decrypts it to compare with the plaintext it meant to save. Any failure rolls A back from the backup (or clears it when there was no previous table), keeps the readable backup, and throws an error naming which of the three outcomes happened.
- `loadVault()`: no hidden sheet → new document, empty vault. Sheet present but main ciphertext empty → error (`映射表密文为空，为保护数据不返回空映射表…`). Main ciphertext unreadable but backup readable → use the backup and mark the vault `recovered`, so the panel can say `映射表损坏，已用备份恢复，请重新保存`. Both unreadable → decryption/content error.
- `migrateVault()` only rewrites old-format buckets when the stored version is below 2; a current table is returned untouched.

## Alternatives considered

**Write to a second, temporary sheet and swap it in.** Rejected: the swap itself is a multi-step host operation with no transaction, and a crash leaves an extra visible sheet behind.

**Keep the backup as a `PluginStorage` entry.** Rejected: the mapping belongs to the document and must travel with it; plugin storage is keyed to the install, not the workbook.

**Treat an unreadable table as a new document and let the user re-map.** Rejected: that is the silent data loss this change exists to remove.

**Only track errors, trust the host's own save.** Rejected: the host save covers the workbook file, not the intermediate state of a multi-step write into one sheet cell range.

## Consequences

The hidden sheet now stores two ciphertext copies, roughly doubling what the table costs when it is large; the read-back adds one extra pass over the chunk. The vault version stays 2 because the layout is additive: a table without the B column still loads, and the next save creates the backup. Tests [31] and [32] cover the load classification and the backup/read-back/rollback path; the panel's recovery prompt is exercised in [20].

Users see three new outcomes instead of silence: a save failure that wrote nothing, an auto-recovery prompt after a damaged main copy, and an explicit error when nothing is readable.
