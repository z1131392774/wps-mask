# AGENTS.md — Repository instructions and documentation

*[中文](AGENTS_zh.md)*

This file defines how instructions and documentation are organized in this repository: what belongs at which level, how the levels load, how to write a rule, and when a file has outgrown its budget. Working procedure — how to make a change and verify it — lives in [development.md](development.md).

The rationale for this split is recorded in [the first note](../.agents/notes/implemented/2026-11-02-layered-agent-instructions.md).

## The tier model

Each fact has exactly one home; everywhere else, link to it. Without this rule, the separate files grow into one unreadable document.

| Tier | What belongs there | What does not |
| --- | --- | --- |
| Root `AGENTS.md` | Standing orders: rules an agent needs in context in every session, one to three lines each, each linked to its home | Stories, worked examples, step-by-step procedures, anything restated from a linked document |
| Subtree `AGENTS.md` | Rules specific to that directory, and only those | Rules the root file already states |
| `docs/` | Procedures, architecture maps, standards like this one | Decision rationale; copies of it quickly go stale |
| `.agents/skills/` | Procedures that apply only in one situation; each loads when its description matches the task | Rules an agent needs in every session, product contracts |
| `.agents/notes/` | Why a decision was made, what was rejected, what it costs; status encoded in the folder | Current behavior, which the code and docs own |
| Code comments and doc comments | The local contract: preconditions, guarantees, failure modes, non-obvious ownership | Restating the code, narrating the implementation, preserving review history |
| `README.md` | What the project is, how to run it, where to start | Rules for agents |

Budgets, counted in words:

| File | Ceiling |
| --- | --- |
| Root `AGENTS.md` | 1,200 |
| Subtree `AGENTS.md` | 400 |
| Each document in `docs/` | 1,200 |

Budgets exist to stop growth, not to be filled. The manifest [`scripts/doc-budgets.json`](../scripts/doc-budgets.json) is authoritative and overrides the fallbacks above; `npm run check` reads it: word budgets, bilingual pairs, links and heading anchors, the fixed note header, one trailing newline, and no link leaving the repository. When a file goes over, relocate content to its proper home first, condense second, and raise the ceiling last, in a change that explains why the words are needed. A file permanently at its ceiling is no longer a summary. Notes are unbudgeted: one decision per file, and a note grows only when the decision needs more explanation.

The test for the root file: if an agent skipped the rule, would it plausibly do the wrong thing? If the answer is "only when working on X", the rule belongs in X's subtree file, not here.

## How instructions load

Most agent harnesses load instruction files automatically, and the mechanics explain the rules above.

- **Broad to specific.** The chain runs from the repository root down to the directory the agent is working in. Nearer files load later and win conflicts.
- **Deduplicated.** A `CLAUDE.md` that repeats its `AGENTS.md` renders once.
- **Budgeted.** Each chain has a byte budget. When it is exceeded, broader files are dropped before the most specific file is truncated, because the specific file usually matters more to the current task.
- **Loaded once, refreshed on access.** Touched directories pull their files in on the next request; changed or removed files are reconciled.

Two practical consequences:

1. Do not duplicate a rule across tiers to make it more visible. Duplication consumes budget twice and creates two copies that will disagree.
2. Put a rule as deep as it can go while still reaching everyone who needs it. A rule for the deploy script belongs next to the deploy script.

## Writing a rule

- **Imperative, one clause, bold lead.** `**Fail loud, near the cause.**` then one sentence. The bold lead is how a scanning agent finds the rule; everything after it is the detail.
- **Name the trigger and the action.** "Run the parser suite after changing a tokenizer" beats "keep tests green". A rule that does not map to a moment in the agent's work will be ignored.
- **Attach the reason or the link.** An agent follows a rule it understands and over-applies one it does not. Put long rationale in a note under [`.agents/notes/`](../.agents/notes/README.md) and link it.
- **State current behavior.** History belongs in git and decision records. "We no longer use X" and "will migrate to Y" are not rules; "use Y for new code" is.
- **Do not restate a catalog.** Package lists, option tables, and test inventories belong to the source or a generator. A hand-copied list goes stale and then misleads.
- **Reserve emphasis.** If everything is bold, capitalised, or "critical", nothing is. Emphasis marks the clause that changes behavior.
- **Write for a reader who is competent but new.** No metaphors, no inherited shorthand, no references to a meeting or a chat.

Keep a rule only if it changes a decision the agent would otherwise get wrong. Delete rules that restate practices every competent engineer already follows; they dilute the ones that matter.

## Bilingual documents

- **English is the source, Chinese the twin.** `docs/usage.md` and `docs/usage_zh.md` are one document in two files; the stem stays identical and only the suffix differs.
- **Link both ways in the opening lines.** A reader who lands on either file reaches the other in one click; the check fails when the link is missing.
- **Translate the meaning, not the syntax.** A Chinese twin that keeps English word order reads as machine translation. Rewrite the sentence in Chinese, keep the facts, the numbers, and the commands exact.
- **Refresh the twin when the source moves.** A translation whose English half changed afterwards fails `npm run check`; retranslate the affected paragraphs instead of leaving a stale copy, or list the file under `pendingTranslations` while the rewrite is in progress.
- **Move, rename, and delete both halves in one commit.** A pair that disagrees is worse than a single language, because the reader may trust the outdated half.
- **Both halves obey the same budget.** Chinese is longer than English, so its ceiling is the English budget times `zhMultiplier` in `scripts/doc-budgets.json`, measured one unit per CJK character plus one per Latin word.
- **Exempt only what is generated.** Files listed in `excludePairs` may stay single-language; everything hand-written is paired.

## Maintaining these files

- **Review quarterly, and after any incident** where an agent did the wrong thing. Add the missing rule or remove the rule that misled it.
- **Grow downward.** When a file approaches its budget, move a paragraph into the subtree file or the procedure document it belongs to, and leave one line behind.
- **Prefer deletion.** Two years of accreted rules make an unreadable file. If a rule no longer matches reality, fix or delete it; an outdated rule misleads every reader who trusts it.
- **Check links and age mechanically.** `npm run check` resolves every local link and heading anchor, and reports a twin whose English half moved afterwards. A broken link in an instruction file sends the agent to the wrong place or to nothing.
- **A rule with no executor is advice.** If violating the rule cannot fail a check, say so in the rule, or accept that it depends on review.
- **Treat a violation as a documentation bug first.** If an agent repeatedly ignores a rule, the rule is probably vague, buried, or contradicted elsewhere. Fix the writing before blaming the agent.

## Pre-commit checklist

Check every instruction file against this list before committing:

- Duplicated rules: search a distinctive phrase; keep one home and link the rest.
- History outside its permitted home: state the current fact, link the record.
- Status annotations in prose ("implemented", "planned"): the code and the tree carry status.
- Hand-copied catalogs: link the source instead.
- Reasoning transcripts: keep the conclusion and delete how you reached it.
- Long paragraphs: split them, or move the detail to its proper home.
- Emphasis on everything: bold on every line marks nothing.
