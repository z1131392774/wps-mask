# AGENTS.md — GitHub Actions

*[中文](AGENTS_zh.md)*

- **Two jobs, two purposes.** `docs` runs `npm run check`; `tests` runs the three Node scripts under Node 22 with `jsdom` installed. A documentation invariant belongs in the check script, not in a workflow step; a check that needs a different Node version or an install step gets its own job here.
- **The check needs no install step.** It imports only the Node standard library, so the `docs` job skips `npm ci` and caching. Adding a dependency to the check means adding an install step to that job in the same change.
- **Prove a workflow change on a pull request.** A workflow edited without a run has unknown syntax and unknown permissions. Open the pull request, watch the job, then merge.
