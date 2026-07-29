# 0.1.0-dev.2 verification evidence

The converged product was exercised through the public CLI against
project-local SQLite state. Runtime mutation used only opaque Assignment
handles returned by `run start`, `next`, `current`, and `done`.

## Guarded CLI loop

- `bun run verify` passed from the final source: 25 unit and integration tests,
  four E2E tests, 301 E2E assertions, and all CLI, Viewer, and Product Preview
  production builds.
- Recursive JSON Help coverage reached every root group and leaf command.
  Missing arguments returned command-local Help and recovery commands.
- Removed `work`, top-level `events`, `mermaid`, `serve`, and superseded Run
  query commands were rejected.
- Start, resume, Next, and Done automatically scheduled bounded prompt
  Assignments. Each packet included objective, instructions, Must Read, Done
  When, predecessor context, route limits, lease, and exact return commands.
- Equivalent concurrent Done calls converged on one completion event; a
  conflicting replay failed. Stale Assignment handles could not mutate a newer
  Attempt.
- Four concurrent Next processes respected the per-Actor cap of eight.
  Per-Graph `maxActive`, actor hints, deterministic round-robin, parallel nodes,
  and multiple active Graphs were covered.
- Normal scheduling output was bounded to eight Assignments, eight Run
  summaries, and 32 Ready previews while retaining total counts.

## Dogfood

- `selfhost-cli-convergence:dev2` and `selfhost-cli-release:dev2` ran in
  parallel and completed.
- Initial scheduling returned five simultaneous prompt Assignments across the
  two Graphs.
- The convergence Decision first selected `repair`, returned to
  `cli-blackbox`, injected prior Decision context into Attempt 2, then selected
  `pass`. Its bounded repair edge traversed exactly once.
- Final `current --actor main-codex` returned no claimed or focused
  Assignment, and both self-hosted Runs had no Pending, Ready, Running,
  Blocked, or Failed nodes.
- `inspect mermaid` rendered the completed parallel branches, Join, Decision,
  traversed repair edge, and End state.

## Performance and Viewer

- A cold 500-Task `run start` fixture measured
  `235 / 267 / 306 / 444 / 518 ms`; p50 was 306 ms and observed p95/max was
  518 ms, below the 1,000 ms regression Gate.
- The test machine was Darwin 25.0.0 arm64 with Bun 1.2.17.
- Two independently named Viewer instances started concurrently. Stopping one
  exact instance did not affect the other.
- Viewer health and overview passed, mutation returned
  `405 READ_ONLY_VIEWER`, and public responses exposed no ownership token or
  private runtime path.

## Lightweight artifact

- `dist/releases/burn-graph-0.1.0-dev.2.tgz` is 1,109,642 bytes with SHA-256
  `24b085433c2dda01b2c56d28ad74de084fd50ebaf828c490dca4617d118fa670`.
- The archive declares zero package dependencies and requires Bun 1.2.17 or
  newer.
- Isolated installation, installed CLI convergence, and packaged named Viewer
  E2E passed without Docker.
