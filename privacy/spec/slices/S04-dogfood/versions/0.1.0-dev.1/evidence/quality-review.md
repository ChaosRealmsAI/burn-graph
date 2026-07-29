# 0.1.0-dev.1 quality review

Main Codex reviewed the final source, public CLI behavior, runtime recovery,
lightweight package, and staged repository contents. No external Agent
reviewer was used.

## Confirmed fixes

- Expired claims reconcile across multiple Graphs without cross-Graph failure.
- Concurrent first use waits for SQLite initialization instead of racing
  migrations.
- Atomic duplicate Claim has exactly one winner across separate processes.
- Lease recovery removes only the stale Actor's exact focus.
- A bounded repair assignment carries the prior Decision route, summary, and
  evidence while preserving Attempt history.
- CLI error envelopes expose command paths without copying argument values.
- `--version` exits successfully after Commander emits the version.
- The source installer runs Bun from an isolated temporary directory, so a
  global install cannot inject the release archive into source manifests.
- Only an explicitly applied GraphSpec can start a Run.
- Viewer launch health identifies its exact recorded process and the HTTP
  surface remains read-only.

## Final gates

- Type check, 16 core and integration tests, both production builds, and two
  E2E files with 133 assertions passed.
- The duplicate-Claim process race passed 10 consecutive repetitions.
- Dependency audit returned no advisories.
- Project control data validates against the Codex project-control schema.
- The approximately 1.10 MB package declares zero dependencies; its isolated
  install, parallel CLI use, state persistence, and Viewer smoke passed.
- All five persisted self-hosted Runs completed with no Ready, Running,
  Blocked, or Failed nodes; revisions 2, 3, and 4 were driven by installed
  CLIs.

No release blocker or accepted technical debt remains for `0.1.0-dev.1`.
