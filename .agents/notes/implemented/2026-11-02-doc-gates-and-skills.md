# Note: Gate documentation invariants and add conditional-procedure skills

*[中文](2026-11-02-doc-gates-and-skills_zh.md)*

Status: implemented

## Problem

The instruction standard states rules that nothing enforced. It also puts every procedure in an always-read document: an agent loading `docs/development.md` pays for the pre-push procedure on every request, though it matters once per push. A rule nobody checks decays into advice, and advice that is always loaded crowds out the rules that matter.

## Decision

[`scripts/check-docs.mjs`](../../../scripts/check-docs.mjs) enforces the mechanical invariants: word budgets, local links, heading anchors, one trailing newline, and a non-empty corpus. `npm run check` runs it. Word ceilings live in [`scripts/doc-budgets.json`](../../../scripts/doc-budgets.json), which overrides the fallbacks the script carries, so the numbers have one machine-checkable home. The [gate rules](../../../scripts/AGENTS.md) govern the script itself.

Procedures that apply only in one situation live in `.agents/skills/<name>/SKILL.md`, with YAML frontmatter describing when to load it. The first is [pre-push-checks](../../../.agents/skills/pre-push-checks/SKILL.md), which selects the smallest checks covering an outgoing diff.

## Alternatives considered

**Rely on review for everything.** Cheap to adopt, but the failure is silent and cumulative: a broken anchor or a file at twice its budget looks fine in a diff. The checks that matter are mechanical, so a machine should own them.

**Enforce only in CI.** CI is the backstop, not the feedback loop. A contributor who learns about a broken link after pushing has already lost the context to fix it cheaply.

**Keep the pre-push procedure in `docs/development.md`.** Simple, and wrong for the same reason the root file is short: it charges every session for a procedure that applies once per push.

## Consequences

Two rules lost their "advice" status and now fail a command. The cost is a Node dependency for the gate, which is why the script imports nothing outside the standard library and runs with no install step. Skills add one convention to learn; a skill whose description does not match the task costs nothing at runtime, because only the description enters context.
