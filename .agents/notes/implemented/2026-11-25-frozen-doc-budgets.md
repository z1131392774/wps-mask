# Note: Freeze documentation budgets

Status: implemented

*[中文](2026-11-25-frozen-doc-budgets_zh.md)*

## Problem

The documentation gate was healthy where it enforced structure — bilingual pairs, links, anchors, the fixed note header, the manifest check — but its word ceilings were not enforcing brevity. Every time a manual grew, the ceiling grew with it: `wps-mask-addon/README.md` went 1600 → 1780 → 1840 → 1840 → 1900 → 3840 units across six changes, and by the end four of eleven governed files sat at 95–100% of their ceiling. The ceiling recorded history instead of stopping growth, so "raise the ceiling last" had become the first move.

## Decision

Ceilings are frozen. `wps-mask-addon/README.md` is capped at 2000 units and `wps-mask-addon/AGENTS.md` at 400; the overflow moved into four new governed pages — [behavior](../../../wps-mask-addon/docs/behavior.md) 1200, [storage](../../../wps-mask-addon/docs/storage.md) 1000, [verification](../../../wps-mask-addon/docs/verification.md) 1200, [implementation](../../../wps-mask-addon/docs/implementation.md) 600 — each frozen when created. `docs/AGENTS.md` now states the rule: when a file goes over, move the overflow into a new governed page with its own ceiling, or condense; a raise is a product decision recorded in a note, not a routine edit. `_budgetReasons` in the manifest records earlier raises and now records freezes. The nine ceilings this repository shares with DeepSeek's `agents-template` — root `AGENTS.md` 1200, root `README.md` 700, `docs/AGENTS.md` 1300, `docs/adopting.md` 900, `docs/development.md` 900, `.agents/notes/README.md` 900, the two skill files 500 and 600, and `scripts/AGENTS.md` 400 — were copied from the template's manifest and stay exactly as the template defines them; only the add-on entries, which the template does not contain, are local product decisions; they stay within the template fallbacks wherever one applies (subtree `AGENTS.md` 400, each document in `docs/` 1200).

## Alternatives considered

**Keep raising the ceiling with a written reason.** Rejected: six raises in one week showed the reason was always available, so the mechanism only made growth visible after the fact.

**Drop word budgets and rely on review.** Rejected: length then drifts silently; the overflow is discovered by a reader who has to do the splitting.

**Derive each ceiling automatically from the current size.** Rejected: that is the same ratchet with extra steps, and it moves the raise into the tool meant to resist it.

## Consequences

Total budgeted units rise from 4,490 to 6,400: five pages each pay for a heading, an opening cross-link and a twin link, and the total was never the constraint — per-page honesty was. Freezing means a future addition has three exits: replace text, create a new governed page (with its pair and its own frozen ceiling), or delete. A file that stays at its ceiling is a signal to split it, not to raise the number. While the new pages still have room, a ceiling may move only down: new prose cannot arrive by raising it. The structural checks are unchanged, and `npm run check` still fails when a page exceeds its ceiling, a twin is missing, or a link leaves the repository.
