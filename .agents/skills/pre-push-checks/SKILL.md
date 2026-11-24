---
name: pre-push-checks
description: Use before pushing, opening a pull request, or claiming a change is verified, to select the smallest checks that cover the outgoing diff instead of rerunning the whole suite.
---

# Pre-push checks

*[中文](SKILL_zh.md)*

Run the checks that cover this diff, once. Everything else is CI's job.

Open [references/check-selection.md](references/check-selection.md) when the mapping below is unclear, when a check fails and you need to decide whether it is in scope, or when the change crosses a boundary you did not expect.

## 1. Know what is leaving

```sh
git status --short --branch
git diff --stat <base>...HEAD
```

Include staged, unstaged, and committed work that the base does not have. A check selected from a partial diff proves nothing about the rest.

## 2. Map changed paths to checks

| Changed paths | Check |
| --- | --- |
| Any `*.md`, `AGENTS.md`, `.agents/notes/**` | `node scripts/check-docs.mjs` |
| One source file and its test | The focused test for that file |
| A shared helper, public signature, config key, or serialization format | The package suite, plus the typecheck |
| Dependency manifests, build config, entrypoints | The build, then one manual run of the built artifact |
| Nothing at all | No check. Say so instead of inventing one. |

## 3. Run each check once and record the result

Report the exact command and what it returned. "Should pass" is not evidence.

## 4. Stop rules

- A failing check blocks the push. Fix it, or report it with the output and do not claim the change is verified.
- A check that cannot run in this environment is reported with the reason. Never replace it with a weaker check silently.
- Never re-run a passing check because the run "felt incomplete". If the diff did not change, the result stands.

## 5. Hand off

State the checks run, their results, and anything you chose not to run. The reviewer should not have to reconstruct your evidence.
