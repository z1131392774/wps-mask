# AGENTS.md — GitHub Actions

*[中文](AGENTS_zh.md)*

- **One gate, one command.** Workflows run `npm run check`. A new check belongs in that script unless it needs a different runner or a different Node version; a new workflow step that duplicates the script hides which invariants actually run.
- **No install step.** The gate imports only the Node standard library, so the workflow skips `npm ci` and caching. Adding a dependency to the gate means adding an install step here in the same change.
- **Prove a workflow change on a pull request.** A workflow edited without a run has unknown syntax and unknown permissions. Open the pull request, watch the job, then merge.
