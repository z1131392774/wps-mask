# AGENTS.md

*[中文](AGENTS_zh.md)*

Standing orders for any agent working in this repository. Read this file at the start of every session. The standard behind them lives in [docs/AGENTS.md](docs/AGENTS.md) for instruction and documentation structure, and in [docs/development.md](docs/development.md) for how to make and verify a change. Read the relevant one before your first change.

Rules here are deliberately short. Background, examples, and procedures belong in the linked home, not in this file.

When this file and a nearer `AGENTS.md` disagree, the nearer file wins for paths under its directory. When this file is silent, those two documents decide.

## Project facts

- Stack: JavaScript (ES5 style, no bundler) against the WPS JSAPI; Node 22 for the test scripts; the add-in itself ships no dependency
- Verify: `node wps-mask-addon/test/engine.test.js`, `node wps-mask-addon/test/aes.test.js`, `npm i jsdom` then `node wps-mask-addon/test/taskpane.test.js`; documentation changes run `npm run check`. No linter or typechecker exists
- Build: none — the add-in is plain files copied into `%APPDATA%\kingsoft\wps\jsaddons`

## Before you start

- **Restate the task and your plan in one short message before editing.** If two readings of the request are plausible, ask which one. A wrong assumption costs more than a question.
- **Inspect the working tree first.** `git status` and the relevant file tell you whether someone else is mid-change. Treat unfamiliar or uncommitted work as the user's; read it, never revert, reformat, or delete it to make your change easier.
- **Find the existing owner before adding anything.** Search for the function, config key, test, or document that already covers the area. Extend it, or explain why a second one is needed. Duplicate mechanisms are the most expensive kind of change ([tiers](docs/AGENTS.md#the-tier-model)).

## Change discipline

- **One change, one purpose.** A bug fix does not carry a refactor; a feature does not carry a dependency upgrade. Split unrelated work into separate commits or pull requests.
- **Make the smallest diff that fully solves the problem.** No drive-by formatting, no renaming outside the change, no speculative abstraction for a caller that does not exist ([change discipline](docs/development.md#change-discipline)).
- **Match the surrounding code.** Follow the file's naming, error handling, logging, and test layout even if you would choose differently. Consistency beats personal preference in an existing codebase.
- **Fail loud, near the cause.** Reject invalid input at the boundary where it enters; never silently substitute a default, swallow an error, or continue with partial state. Every empty `catch` names the error it ignores and why ([failure handling](docs/development.md#failure-and-error-handling)).
- **Treat interfaces as contracts.** Changing a public function, CLI flag, config key, file format, or wire field affects callers outside the diff: update every consumer and every reference in the same change.
- **Record decisions that outlive the diff as a note.** Proposals start in `proposed/`, shipped decisions in `implemented/`; update the note that owns the decision instead of adding a second one ([format](.agents/notes/README.md)).
- **Never commit secrets.** No keys, tokens, credentials, or `.env` contents in code, tests, fixtures, logs, or commit messages.

## Verification

- **Run the smallest check that covers what you changed**, then widen only if the change crosses a boundary. Report the exact commands and their results. Never claim a check you did not run ([verification ladder](docs/development.md#verification-ladder), [pre-push selection](.agents/skills/pre-push-checks/SKILL.md)). Documentation changes run `npm run check`.
- **Tests describe behavior, not implementation.** A behavior change updates its tests in the same commit; a test that only asserts the old implementation is replaced, and the pull request says why.
- **Review your own diff before handing off.** Read `git diff` top to bottom against [the review checklist](docs/development.md#review-checklist). Leftover debug output, dead code, and half-finished comments are defects.

## Reporting

- **State what you did, what you verified, and what remains uncertain.** Name files and commands. Do not narrate your exploration; the user needs the outcome and the evidence.
- **Report failures plainly and stop dependent work.** If a check fails or an outcome is unknown, say so with the output; do not degrade silently or retry blindly.
- **Ask when the rules do not cover the situation.** A short question beats an invented convention.

## Where knowledge lives

Rules live as deep as they can while still reaching their reader; the [tier model](docs/AGENTS.md#the-tier-model) names each home. A procedure that matters only at one moment lives in [`.agents/skills/`](.agents/skills/pre-push-checks/SKILL.md) and loads when its description matches the task. Decisions live in [`.agents/notes/`](.agents/notes/README.md).

Add a rule here only if it is needed in every session. Otherwise put it in the correct home and link it once.

## Documentation language

English is the source; every document carries a Chinese twin beside it whose name ends in `_zh.md`, and the pair links in both directions. `npm run check` fails when a twin is missing, so a document that exists in one language only cannot land. The [bilingual rule](docs/AGENTS.md#bilingual-documents) says what a translation may change and what it must not.
