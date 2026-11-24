# Development guide

*[中文](development_zh.md)*

How to make a change in this repository and how to know it is finished. The instruction standard lives in [AGENTS.md](AGENTS.md); the standing orders an agent reads every session are in the [root AGENTS.md](../AGENTS.md).

## Change discipline

1. **Understand before editing.** Read the target file, its tests, and one nearby example of the same pattern. If the change crosses a package or module boundary, read that boundary's definition too.
2. **Plan in writing.** Three bullets: what changes, what could break, how you will verify. If the plan needs more than three bullets, the change is too big for one pass.
3. **Change the smallest surface.** Prefer editing an existing function to adding a parallel one, extending a config object to adding a config file, and adding a test to rewriting the suite.
4. **Delete as you go.** When your change makes code, config, or documentation obsolete, remove it in the same change and repair inbound references. Leaving it "for later" converts a working system into a liability.
5. **No new dependency without a reason.** Justify it by the code and maintenance it removes, not by convenience alone.
6. **Keep commits legible.** One logical change per commit, message states the why. Do not mix formatting churn with behavior.

## Failure and error handling

- **Validate at the boundary** where data enters from a user, a file, a network call, a process, or a model. Inside a typed, same-process boundary, trust the type; do not re-validate defensively.
- **Stop and report on unknown outcomes.** A failed write, a timeout, a partial batch: say what is known, what is not, and what the user must decide. Never retry destructively and never pretend success.
- **Preserve the cause.** Wrap errors to add context; keep the original message and stack. Log once, where the error is handled, not at every level.
- **Name ignored errors.** An empty `catch` carries a comment saying which error is expected and why continuing is safe.

## Verification ladder

Run the cheapest check that would catch your mistake, and widen only when the change justifies it.

1. **The focused test** for the changed function or file.
2. **The package or module suite** when you changed a shared helper or a public behavior.
3. **Lint and typecheck** when you changed signatures, config, or anything the compiler can see.
4. **The full suite** only for repository-wide changes, CI debugging, or when the user asks. CI owns exhaustive coverage; repeating a passing full run locally spends time without adding evidence.
5. **The built artifact or a manual run** when the change affects something users actually execute.

Report exactly what you ran and what it returned. "Should pass" is not a result. If a check cannot run in this environment, say which check and why, rather than silently skipping it.

## Review checklist

Read your own diff before handoff and answer each line.

- Does the diff do one thing, and does the description say what and why?
- Does every changed file have a reason, with no formatting noise or debug leftovers?
- Are errors handled where they occur, with the cause preserved?
- Do new paths handle empty, boundary, and oversized input, not just the happy case?
- Do tests fail if the behavior regresses, and do they avoid asserting implementation details?
- Are public interfaces, docs, and examples updated together with the behavior?
- Do comments state contracts rather than narrate the change?
- Are secrets, credentials, and machine-specific paths absent?
- Does the change leave dead code, unused exports, or stale references behind?
- If a reviewer reverted one hunk, would a test or check fail? If not, that hunk is unverified.

## Decision records

A note records a decision that outlives its diff: a structural choice, a rejected alternative worth remembering, a compatibility promise, a trade-off future maintainers will re-litigate. Notes live in `.agents/notes/`, with the status encoded in the folder, so a reader can tell a proposal from shipped reality without opening the file.

[The note standard](../.agents/notes/README.md) owns the format: the fixed header, the per-lifecycle body skeleton, the mandatory `## Alternatives considered` section, and the supersession and deletion rules. Write a note in the same change as the decision, and update the note that already owns it rather than opening a second one.

A note is neither a changelog nor a tutorial. If a reader needs current behavior, the code and the documentation carry it.
