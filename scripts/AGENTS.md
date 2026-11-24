# AGENTS.md — Gate scripts

*[中文](AGENTS_zh.md)*

Rules for the scripts in this directory, which enforce documentation invariants.

- **Dependency-free Node ESM.** A gate runs from a fresh checkout with no install step. Adding a dependency to a gate means the gate is unavailable exactly when it is needed.
- **Budgets live in `doc-budgets.json`.** The manifest is authoritative; the script owns only the fallback for files it does not list. Never repeat a limit in another file.
- **Fail with location and exit non-zero.** Report `path:line`, print every finding, and exit 1. A gate that warns and passes teaches everyone to ignore it.
- **An empty corpus is a failure.** A check that inspects nothing passes everything.
- **Treat unseen input as hostile.** A malformed manifest, an unreadable file, or a link that escapes the repository stops the gate; it never degrades to a partial check.
- **Prove the check rejects.** Before committing a gate change, introduce the defect it should catch, watch it fail, then revert. A gate whose failure path was never exercised is unverified.
- **Keep it under a second.** A slow gate stops being run locally, and the local run is what gives it value.
