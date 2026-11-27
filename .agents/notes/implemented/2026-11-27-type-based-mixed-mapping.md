# Note: Mask a mixed column by JavaScript type, not by shape

Status: implemented

*[中文](2026-11-27-type-based-mixed-mapping_zh.md)*

## Problem

Real account columns mix formats: a mobile number on one row, an email on the next, a landline on the third, a zero-padded code on the fourth. The [mixed-shape decision](2026-11-24-mixed-shape-columns.md) answered with a per-cell shape classifier: `shapeOf()` recognised mobile, email, landline, digits, alnum or text, and `genMixed` kept the shape with one generator per family. It preserved shape validity, at the price of becoming the most intricate branch in the engine — five shape regexes, five shape generators, a shape table in the docs, a separate "shape space" capacity failure per family, and a standing rule in `AGENTS.md` that every new shape is a contract.

Shape fidelity is not the requirement. Masking has to make the value stop being the original; test data does not need to pass the production validators the original did. The classifier also decides by looking at content, which is the other thing the add-in is supposed to stop doing: the column mode is chosen by JavaScript type, and a second, regex-based classifier inside the mixed branch reintroduces "smart" guessing. Every regex is a place where an unusual value silently falls to the text fallback and the table has to explain why.

Shape preservation also fights the host's own parsing. A General-format cell parses numeric-looking text: on a real device `008081` becomes `8081`, `1.20` becomes `1.2`, `2024-01-01` becomes a date serial, `50%` becomes `0.5`, `1,234` becomes `1234`, and `=1+1` becomes a formula. A digit-shaped fake such as the old digits generator produced (`000123`) is exactly the text the host silently converts, so "the shape is preserved" is true only until the value crosses the cell boundary. Writing text back as text needs the host's leading-apostrophe marker, and the old revert path did that while the write-failure rollback did not.

The first version of this change shipped without two pieces the review of commit `a76abd7` made load-bearing:

- `writeMask`'s failure branch wrote the original values raw, so a batch that failed after `008081` had been written rolled it back as the number 8081, then reset the area records, leaving the user no revert path to the damaged cells.
- Old mixed buckets (from the superseded note) contain digit-string fakes that the host already stored as numbers. Their loose index entry is what makes revert work, but nothing stopped a new number fake from taking the same numeric value: revert then found the new typed entry first and restored the wrong original, silently and irreversibly once the document was saved.

## Decision

Keep the three column modes — number, text, mixed — and make mixed mean "both JavaScript types are present", not "many shapes". Mapping is by `typeof`, never by content:

| Value | Masked value |
| --- | --- |
| number | a number from the column's numeric range, keeping the column's decimal places |
| string | the field name plus digits with at least one non-digit, so the host cannot coerce it to a number |

`shapeOf()`, the mobile/email/landline/alnum/digit-shape generators and the shape table are removed; `genMixed` survives only as a thin dispatcher that sends a number to `genNumber` and anything else to `genText`. `guessMode()` no longer falls back to mixed because of shapes. A mixed column is decided by the JS types actually present, the same rule as number and text columns. When a later batch adds numbers and the recorded fakes already fill the column's numeric slots, `prepareMask` widens `num.max` upward until `slots - occupied >= max(need + 1, ceil(need * 1.1))`; a range that truly cannot hold the batch still fails loudly instead of reusing a fake.

Revert writes string originals through `textForWrite()`: a leading `'` for every non-empty string under 32,767 characters, so the host stores text and keeps the General format, and the read-back returns the value without the marker. `008081` stays `008081`, `000123` stays `000123`.

The write-failure rollback uses the same path. `writeMask` restores the originals through the marker, so a failed batch cannot convert leading-zero text to numbers. A rollback that still fails does not call `restoreMaskBase()`: the recorded ranges go back to the pre-mask set, and each failed column adds one `partial` record — a per-row snapshot of the planned fake and the original's bucket key, plus the column's signature — and the marks stay as a damage hint, so a restored column may keep a purple outline until the next revert. Revert treats a partial record cell by cell: a cell is written back only when its current value equals that row's planned fake, anything else is left alone and counted in `skippedPartial`, and the snapshot is nulled as it is consumed. A bucket lookup never runs on those cells, so a value that happens to equal another row's fake cannot be rewritten. The two-phase mask itself is unchanged ([two-phase mask](2026-11-24-two-phase-mask.md)).

The outline uses `BorderAround`: four outside edges in one call, leaving the inside grid lines untouched. `vault.marks` records each edge's pre-mask style, weight and colour before any cell is written and restores it on removal; the marker colour is the packed RGB integer `15547004`. BorderAround measured 203 ms to paint and 79 ms to clear on an 8,240×3 block, against 325 ms for per-edge `Borders` assignment, and the host cannot express one style for a mixed edge, so an unknown edge is never painted. A refresh filter that matches no recorded rectangle (another sheet, an illegal rectangle) falls back to repainting the whole used range instead of silently doing nothing. The outline and mark decisions keep their own notes ([marker outline](2026-11-25-marker-outline.md), [marks without a version bump](2026-11-25-marks-without-version-bump.md)).

Bulk mask, revert and drop run inside `MaskQuietHost`: ScreenUpdating off, calculation manual, events off, all restored in a `finally`. Whether to restore is decided by what was read before the assignment, not by reading the property back — a busy COM call can throw or return a stale value, and a host left in manual calculation is a broken session, while writing the original value once more is harmless. Quick-action success on the ribbon is a status-bar toast that persists and appends `。耗时 N 毫秒/秒。`; the panel uses its status line; failures stay dialogs.

The vault stays at version 2 and `sigOf()` formulas do not change. No key changed meaning, `ranges` and `marks` are optional with `[]` defaults, and old v1/v2 documents, phone buckets and mixed buckets stay readable and revertible. The loose collision above is fixed without migration: `buildIndex()` keeps both the typed index (`n:`/`s:`/`b:`) and the loose index, and `prepareMask` now registers both `keyOf(fake)` and `looseOf(fake)` in `used`; `genNumber` checks both forms, so a new numeric fake can never take a value an old coerced fake already holds. Revert still tries the typed entry first and the loose entry second. Old buckets are reused as recorded, so a re-masked old document can keep old-shape fakes — documented in the behavior page, not hidden.

The phone mode is now legacy: detection never returns it, but a saved setting from an old document can still select it. Its fakes are digit strings that a General cell stores as numbers, and revert recovers them through the loose index; retiring it is a P2 for a later change with its own version bump and migration, not part of this one.

## Alternatives considered

**Fix the shape generators and keep the taxonomy.** Rejected: it keeps six generators, six regexes, per-shape capacity failures and two paragraphs of shape rules in the docs, to preserve a property the masked data does not need. The type rule is smaller, one sentence to explain, and its output cannot look like the original by construction.

**Let the user pick a shape per value in the panel.** Rejected: it moves the work onto the user; a column of two hundred accounts would need two hundred decisions, and the request was to handle a mixed column automatically.

**Force the majority type and accept the loss.** Rejected: it produces data that fails downstream validation, and a genuine mixed column has no majority worth trusting.

**Bump `VAULT_VERSION` to 3 and migrate mixed and phone buckets to typed numbers.** Rejected for this change: registering the loose keys removes the collision without rewriting any vault, old buckets stay valid mapping records, and their signatures are unchanged. A version bump is reserved for a change to the format itself, such as retiring the phone mode; if that happens, the migration lands with the bump.

**Keep raw rollback writes and rely on the read-back check.** Rejected: a read-back failure can be reported, but it cannot restore leading zeros the host has already dropped. The loss has to be avoided before the write, not detected after it.

**Keep assigning `Range.Borders` edge by edge.** Rejected: slower on the measured block and it paints the inside lines; BorderAround is one call and leaves them alone.

**Decide quiet-host restoration by reading the property back after assignment.** Rejected: the same COM busy state that makes the read fail is exactly when the property may be stuck; the intent recorded before the write is the only safe signal.

## Consequences

The engine loses the shape classifier, the five shape generators and the shape table; `genMixed` keeps only its two type branches. The behavior page, `AGENTS.md` and the README describe masking by type. Masked values no longer resemble their originals — that trade is stated in the behavior page and the troubleshooting table instead of being papered over.

Old documents stay usable: the vault version does not move, signatures match, phone-mode fakes revert through the loose index, and reused mixed buckets may keep old-shape fakes. New documents contain only type-shaped fakes. The loose-key registration, the marker rollback and the failed-column `partial` snapshot are covered by the local mock, including a coerce-General cell and an injected write failure; the host's `'` behaviour for numeric text was measured earlier (`'008081` stays a string with General format), but the rollback path, the partial snapshot and the loose collision fix have no real-device run yet, and the verification page says so.

The failed-column contract replaced an earlier attempt that kept every recorded range on a failed rollback. An independent review found that contract could rewrite originals of successfully rolled-back columns — a value equal to another row's fake in the same column was reverted to that row's original — so it moved to per-column isolation plus the per-cell snapshot, and the mock now covers that regression scenario.

The shape taxonomy is no longer a contract. Adding a mode is now a type decision, not a new generator, and the [superseded note](2026-11-24-mixed-shape-columns.md) is kept as the record of the taxonomy and the two generator defects it exposed, not as current behaviour.
