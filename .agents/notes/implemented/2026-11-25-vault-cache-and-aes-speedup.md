# Note: Cache the vault with a content stamp and make AES fast

Status: implemented

*[中文](2026-11-25-vault-cache-and-aes-speedup_zh.md)*

## Problem

Every panel action reloaded and decrypted the whole mapping table. On the tables this add-in stores that is the dominant cost: on the local MockWPS host, a 30,000-cell table took about 2.7 s to load and 2.2 s to save, a 60,000-cell table 5.7 s and 6.0 s, and decrypting a 1.4 MB vault as JSON took 3,970 ms with the pure-JS cipher. A historical save also read the backup column on every call and decrypted the ciphertext it had just written a second time to check it, and a mask loaded the table twice: once in the action and once in the refresh that followed.

## Decision

**AES as a standard T-table.** `aes.js` now uses the classic 32-bit T-tables (`Te0`–`Te3`, `Td0`–`Td3`) with precomputed `SBOX`/`INV_SBOX`, a cached key expansion, and a block-level path for the utf8/base64/CBC work. The public API (`encrypt`/`decrypt`), the `M1:` vault format, `KEY_TEXT` and every error text are unchanged; only the round function got faster. Compatibility is pinned by the NIST AES vectors, by decrypting in the old implementation what the new one encrypts and vice versa, and by a byte-for-byte cross-check against `node:crypto` over more than a thousand random inputs from 0 to 200 KB, including Chinese, emoji and four-byte UTF-8. On this machine's MockWPS host a 1.4 MB JSON vault decrypts in 98 ms instead of 3,970 ms (about 40×) and encrypts 3.2× faster. Real-device speed was not measured.

**Read the backup only when the main column is unusable.** `loadVault` parses column A and returns on success; the backup marker and the whole backup column are read only when A does not parse. On a healthy document the number of backup-column value reads is zero. A damaged A still recovers from B, with the same `recovered` flag and prompt as before.

**Save without redundant work.** `saveVault` reads the previous backup lazily: when A parses, A itself is the backup, and B is read only when A is damaged. When A parses it does not read B and rewrites it from A; when A is unusable it reads B and rewrites it only if the readable copy differs from what B already holds. It then writes A and verifies by comparing the ciphertext string alone — AES is deterministic, so `back === cipher` implies the same plaintext and a second decrypt of the full column is pure cost. That removes one full decrypt per save: on the same local host a 30,000-cell table now saves in about 152 ms (down 60%) and loads in about 96 ms; at 60,000 cells the save is 54% faster than with the old cipher. After a successful save the in-memory `recovered` flag is deleted, so a cached vault does not keep repeating "recovered from backup". Ciphertext chunks are written as one range assignment rather than one `Value2` per chunk: a 270,000-cell vault is about 368 chunks (roughly 7.4 MB), which used to cost 368 COM calls per save and now costs one.

**A content stamp for the panel cache.** `Engine.vaultStamp(app)` returns a string derived from the hidden sheet: the A1 marker, the last row of column A (located with `End`, not a column scan), and the first, middle and last chunk cells, each folded with FNV-1a. It reads at most four cells and never whole columns, and it never decrypts. The same content gives the same stamp; `saveVault` rewrites the column with a random IV, so a save always changes it. `''` means no table, an empty table, or a read failure, and the function never throws — `loadVault` stays the loud path. The panel never caches `''`.

**The panel reuses what it has.** `refresh(useRemember, keepEdits, vaultOverride)` accepts a freshly loaded or saved vault, so `doMask` and `doRevert` load the table once instead of twice. A plain refresh compares the stamp and skips `loadVault` on a hit: a 30,000-cell refresh drops from 82 ms to 42 ms (MockWPS). A `loadVault` error clears the cache and is rethrown, and `doDrop` resets it. Ribbon commands share no panel state; the panel sees their writes as a changed stamp on its next refresh.

## Alternatives considered

**Keep the byte-at-a-time AES loops.** Rejected: they are easier to read but roughly 40× slower on the tables this add-in actually stores. The T-table is the standard, widely reviewed tradeoff, and the format-level compatibility tests keep the change honest.

**Rebuild the S-boxes or the expanded key on every call.** Rejected: that is pure overhead. The tables and the expanded key depend only on `KEY_TEXT`, so they are built once per context.

**Always read both ciphertext columns, or verify the write by decrypting again.** Rejected: whole-column COM reads and a second full decrypt are exactly the cost this change removes. The backup matters only when A is unusable, and a deterministic cipher makes ciphertext equality sufficient.

**Cache the vault in the panel without a stamp.** Rejected: another window, a macro or a ribbon command can save the table while the panel is open. A pane acting on that stale copy would map or restore against the wrong records.

**Stamp by reading the whole column or by decrypting it.** Rejected: that is the work the cache exists to avoid. Because the IV is random, a save changes every ciphertext character, so a few sampled cells are enough to notice.

**Add a version or counter field to the vault file.** Rejected: it would change the stored format for a cache concern. Deriving the stamp from the file bytes keeps the format and needs no migration.

## Consequences

The cache is a performance measure, not a consistency guarantee, and the gaps are real:

- Sampling can collide. An external edit that changes only unsampled rows of column A, or only column B while A still parses, may leave the stamp unchanged; for the B case `loadVault` would also return the unchanged A, so the cached result matches a real load, but for arbitrary row edits the pane may serve the previous vault.
- The read of the stamp and the call to `loadVault` are separate steps; an external save in between is accepted as current (an optimistic window).
- Multi-window and shared-document consistency rest on the stamp. Ribbon commands do not invalidate the pane's memory directly — the next refresh does, through the changed stamp.
- The cache must be cleared when `loadVault` throws, and it is: corruption and decrypt errors stay loud instead of being hidden behind an old vault.
- The two advertised speeds are machine measurements on MockWPS, not device measurements. Whether the four cell reads are cheaper than the skipped whole-column read on a real COM host, and how fast the new AES is there, are unverified.

Verification: the six suites pass on the mock host — engine 429 assertions, taskpane 200, AES 42 new assertions — and `npm run check` passes on the 84-file documentation tree. The vault format rules in [implementation.md](../../../wps-mask-addon/docs/implementation.md#vault-format) are unchanged; `aes.js` is still obfuscation rather than a credential, as [the manual](../../../wps-mask-addon/README.md) says.
