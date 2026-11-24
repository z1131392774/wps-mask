# Adopting this system

*[中文](adopting_zh.md)*

Two starting points. A new repository has no rules yet, so an agent must receive the template before it writes code. An existing repository already contains the truth the rules must describe, so adoption is an audit first and a copy second.

Both paths end in the same place: a short root file, a gate that keeps it honest, and detail that lives where it is used.

## New repository

The bootstrap problem is circular: the agent needs instructions before the repository has any. Break it by handing the agent the template and the commands, not by asking it to invent conventions.

1. Seed the repository from this tree.

```sh
git clone <template-repo> my-project
cd my-project
rm -rf .git
git init
```

To add it to an existing empty directory instead, copy the contents including dotfiles:

```sh
cp -R <template>/. my-project/
```

2. Let the agent fill in **Project facts** with commands it has run, delete rules that do not apply, and run `npm run check`.

3. Review the result as you would any first commit. The three facts and the deleted rules are the parts that encode decisions about this project.

### The brief to give the agent

Paste this as the first message, replacing the path. It works because every step ends in evidence.

```text
Bootstrap this repository's agent instructions from <path-to-template>.

Copy AGENTS.md, CLAUDE.md, docs/, .agents/, scripts/, .github/, and package.json
to the repository root, then work in this order:

1. Inspect the repository and determine the real stack, test, lint, typecheck,
   and build commands. Prefer commands that already exist in the project.
2. Replace the three lines under "Project facts". Run each command once. Never
   record a command you have not run.
3. Delete every rule that does not apply here, and say which ones you deleted
   and why. Do not add rules yet; the first rules come from real incidents.
4. Run `npm run check` and report its exact output.
5. Commit everything as one change titled "Add agent instructions".
```

## Existing repository

Do not copy the rules wholesale. Most of them will describe a project that does not exist, and a rule that is wrong is worse than a missing one: it teaches the agent to trust the file less.

**Stage 1 — record reality.** Copy `AGENTS.md`, `CLAUDE.md`, `docs/AGENTS.md`, `docs/development.md`, `scripts/`, `package.json`, and `.github/`. Fill the three Project facts with commands that work today. Delete every rule you cannot tie to something in this repository. Run `npm run check`.

**Stage 2 — set budgets from current size.** If you already have long documents, set each ceiling to its current word count plus roughly 10%, then lower it as you condense. A ceiling below the current size forces deletions you have not thought through, and the first thing deleted is usually the rule that mattered.

**Stage 3 — notes start from the next decision.** Do not generate decision records for past choices. You no longer remember the alternatives, so you will invent them, and an invented rationale is a false statement that outlives everyone who could correct it. Predictions: the first real note arrives within a month, usually for a dependency or a format choice.

**Stage 4 — skills after repetition.** When you have explained the same procedure twice ("which checks before pushing?", "how do we release?"), move it to `.agents/skills/<name>/SKILL.md`. One explanation is a conversation; two is a process.

**Stage 5 — subtree files when a directory accumulates rules.** Three rules about one directory, or one rule that keeps being buried, earns that directory an `AGENTS.md`.

## Two mechanical details

A symlinked `CLAUDE.md` survives a clone only when Git stores it as a symlink; on Windows, enable Developer Mode or create it with `New-Item -ItemType SymbolicLink -Path CLAUDE.md -Target AGENTS.md`.

Keep the gate green from the first commit. A red gate in week one becomes a habit of ignoring it in week two, and then the file's promises are decorative.

## Keep or drop the two languages

Every document here ships twice: an English source and a `_zh.md` twin. `check-docs.mjs` fails when a twin is missing, when it does not link back, or when either side overruns its budget. A stale twin is worse than none.

Pick one state, and change the gate in the same commit:

- **Both languages.** Keep the pairing rule. Translate from the English source with a subagent, then check the result against the writing rules in `docs/AGENTS.md`. A twin that mirrors English syntax has failed.
- **One language.** Delete the twins, drop `zhMultiplier` usage and the pairing check from `check-docs.mjs`, and remove the rule from `AGENTS.md` and `docs/AGENTS.md`. Leave the rest of the gate alone; budgets and links still earn their keep.
- **One language for now.** List the missing ones in `excludePairs` in `doc-budgets.json`. The exemption is visible, and it goes away when the twin lands.

## What to expect

The first version will be wrong in the direction of too many rules. That is the normal failure: rules written before the incidents that justify them. The correction is deletion, not addition, and it happens in the first month as the agent does something you did not anticipate. Budget two or three revisions before the root file settles.

After that, maintenance is small: add a rule when an incident reveals one, move a paragraph down when a file approaches its budget, and run `npm run check` before every push.
