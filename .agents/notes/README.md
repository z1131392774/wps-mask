# Notes

*[中文](README_zh.md)*

Notes are short decision records written by agents, for agents and maintainers. Code says *what* happens; documentation says *how* to use it; a note says *why* we chose this, what we rejected, and what it cost. Without that record, the same argument happens again six months later, usually with less information.

One decision, one note. A note is not a changelog, a task list, or a tutorial.

## Layout and naming

Notes live under `.agents/notes/{lifecycle}/YYYY-MM-DD-topic-slug.md`. The folder is the note's status, and the note moves between folders when its status changes. The date is when the topic was **first proposed**, not when it was last edited; git records the rest.

- **`proposed/`** — reviewed before implementation, or not yet built.
- **`implemented/`** — the decision shipped. Kept current with what actually exists.
- **`rejected/`** — considered and declined, kept only while its reasoning prevents a plausible repeat.

The directory tree is the inventory. Do not add an index file: it duplicates the paths and turns every unrelated note change into a merge conflict.

Link notes to each other with relative Markdown links, never by number or title alone, so the link survives a move and can be checked mechanically.

## When to write one

Write or update a note in the same change as the decision, when the reasoning will outlive the diff: a structural choice, a rejected alternative worth remembering, a compatibility promise, a security rule, a trade-off that will be re-litigated.

Do not write one for a mechanical edit, a local UI adjustment, a bug fix whose cause is obvious from the test, or anything already explained by the code and its documentation. Update the note that already owns the decision instead of adding a second one.

## The file format

The first three lines are fixed:

```markdown
# Note: <title>

Status: <proposed | implemented | rejected — one-line reason>
```

The status must agree with the folder. It carries no dates or parentheticals.

The body opens with `## Problem`, written so it stands without the solution. What follows depends on the lifecycle.

**`proposed/`**

```markdown
## Problem
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
```

**`implemented/`**

```markdown
## Problem
## Decision
## Alternatives considered
## Consequences
```

`## Decision` is present tense. `## Proposal`, `## Plan`, and `## Acceptance criteria` do not belong in an implemented note: the plan is gone and its checklist is either true or it is not. `## Testing` or `## Deferred` are fine where they state a present fact.

**`rejected/`** keeps its proposal-time sections. The verdict lives on the `Status:` line; the body is the proposal, frozen.

**`## Alternatives considered` is mandatory in every note.** Each real alternative and why it lost, one bold-led paragraph each. A decision recorded without what it beat invites exactly the argument the note exists to end. Alternatives are recorded, never invented: if the reasoning is genuinely lost, say so in one line rather than reconstructing it.

## Keeping an implemented note true

An implemented note describes shipped reality, so it changes when the facts change: a renamed file, a moved package, a new default, a replaced mechanism. Update those facts in the same change that moves them. The decision itself is not rewritten; a note whose decision has changed is superseded, not edited into its opposite.

A fully superseded note may be consolidated into its successor and deleted only when the successor preserves every unique rationale, alternative, consequence, and open question. Partial supersession keeps both notes, cross-linked, with every fact that remains current corrected.

## Deleting and rejecting

- Delete an implemented note that only recorded a small or mechanical change, together with any inbound links.
- Delete a rejected note once it no longer prevents a mistake someone would plausibly make.
- Never archive a note into a frozen museum in a small repository. If a decision has historical value, link it from the successor that replaced it and leave it in `implemented/`.
- Never delete a note to win an argument. Supersede it with a better-reasoned one, and say in the new note what changed your mind.
