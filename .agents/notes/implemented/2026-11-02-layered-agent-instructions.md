# Note: Layer agent instructions and keep decisions in notes

*[中文](2026-11-02-layered-agent-instructions_zh.md)*

Status: implemented

## Problem

Agents working in this repository had no standing instructions, so every session re-derived conventions from the code: how to verify a change, what to do with unfamiliar uncommitted work, where a design rationale should go. The obvious fix, one large `AGENTS.md`, fails in a predictable way: the file grows with every incident until it is too long to read, and the rules that matter are buried among the ones that apply once a year.

## Decision

Instructions are layered. `AGENTS.md` at the root holds only rules an agent needs in every session, one to three lines each, and links to [`docs/AGENTS.md`](../../../docs/AGENTS.md) for how instruction files are structured and [`docs/development.md`](../../../docs/development.md) for how to make and verify a change. Rules that apply to one directory go in that directory's `AGENTS.md`.

Declarations that outlive a diff are notes under `.agents/notes/{proposed,implemented,rejected}/`, following the [note format](../README.md). Code and documentation describe current behavior; notes carry the reasoning and the rejected alternatives.

## Alternatives considered

**A single root `AGENTS.md` with everything in it.** Simplest to adopt, but it has no relocation path: once the file exceeds a reader's patience, the only options are deleting rules that still apply or tolerating a file nobody finishes. The layering gives detail somewhere to go.

**Record rationale in `docs/decisions/` without lifecycle.** Close, but the folder mixes proposals, shipped decisions, and rejected ideas under one name. A reader cannot tell whether a document describes reality or an abandoned plan, and abandoned plans read like instructions. Encoding status in the path removes the ambiguity.

**Adopt the full upstream system: note classes, bilingual pairs, a frozen archive, and format gates.** Each part earns its cost at the scale of the repository it came from. Here they would be maintenance with no reader, so they are deferred until the note tree is large enough that browsing by class beats browsing by date.

## Consequences

An agent loads a short file every session and the detail only when relevant. The cost is discipline: a new rule must be placed, not merely appended, and an implemented note must be corrected when paths move. Both are cheaper than a root file nobody trusts.
