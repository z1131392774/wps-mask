# Choosing the narrowest check

*[中文](check-selection_zh.md)*

The rule is coverage, not convenience: run what would fail if your change were wrong, and nothing that would succeed regardless.

## Work an example

You changed one function in `src/parse.ts` and added a case to `tests/parse.test.ts`.

- The focused test covers the new branch and the old ones.
- The package suite adds coverage only if another test imports that function. Check with a search; do not assume.
- The typecheck adds coverage only if the signature changed. A body-only change cannot fail it.

That is one command, not three. Running the suite as well is not diligence; it is a claim you did not need to verify.

## Widen when the change crosses a boundary

- **Shared helper:** every caller is now in scope. Run the suite for the module that owns it.
- **Default value or config key:** the behavior of code you did not touch changed. Run the suites of its consumers.
- **Serialization, persistence, or wire format:** old data must still load and new data must still be readable. Run both directions.
- **Dependency or build configuration:** the result depends on the artifact, not the source. Build and run the artifact.
- **Platform-specific code:** the check must run on that platform. A green check elsewhere is not evidence.

## Widen to the full suite when

- The change is repository-wide: a lint rule, a test harness, a shared fixture, a build script.
- CI failed and you are reproducing it.
- The user asked for it.

## What does not count as evidence

- Reading the code and concluding it is correct.
- A test that asserts the implementation you just wrote rather than the behavior it promises.
- A check that passed before the change and was not rerun.
- A check run on a different commit, branch, or working tree.
