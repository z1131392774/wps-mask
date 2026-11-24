# AGENTS.md — Documentation check scripts

*[中文](AGENTS_zh.md)*

Rules for the scripts in this directory, which enforce documentation invariants.

- **Dependency-free Node ESM.** A check runs from a fresh checkout with no install step. Adding a dependency makes the check unavailable exactly when it is needed.
- **Budgets live in `doc-budgets.json`.** The manifest is authoritative; the script owns only the fallback for files it does not list. Never repeat a limit in another file.
- **Fail with location and exit non-zero.** Report `path:line`, print every finding, and exit 1. A check that warns and passes will be ignored.
- **An empty corpus is a failure.** A check that inspects nothing passes everything.
- **Treat unseen input as hostile.** A malformed manifest, an unreadable file, or a link that escapes the repository stops the check; it never degrades to a partial one.
- **Prove the check rejects.** Before committing a change to the script, introduce the defect it should catch, watch it fail, then revert. A check whose failure path was never exercised is unverified.
- **Keep it under a second.** A slow check stops being run locally, and the local run is what gives it value.
