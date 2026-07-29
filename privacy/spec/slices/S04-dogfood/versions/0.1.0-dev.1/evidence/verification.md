# 0.1.0-dev.1 verification evidence

The product was driven through its built public CLI, with each command opening
a new process against project-local SQLite state.

## CLI convergence

- `bun run check`: passed.
- `bun run test`: 16 tests passed, including known-bad topology, output Schema,
  bounded-loop cap, restart recovery, multi-graph lease recovery, and stale
  Actor focus cleanup.
- The two-process duplicate Claim race passed 10 consecutive repetitions.
- `bun run e2e`: passed with 36 public CLI processes, two concurrent Graphs,
  four overlapping Running nodes, one bounded repair traversal, and no
  cross-Graph mutation.
- `bun run verify`: passed the complete check, 16 core tests, builds, and two
  E2E files with 133 assertions from the final source.
- Claim returned objective, instructions, Must Read, Done When, prior Decision
  evidence, route limits, and exact return commands.
- Complete activated structural Next; Join waited for every active branch;
  Decision repair preserved Attempt 1 and the second pass reached End.
- The project dogfooded two persisted Graphs concurrently. All 12 nodes reached
  Done, the repair edge traversed exactly once, the final Decision passed on
  Attempt 2, and `work ready --all` returned an empty set.
- After the installation requirement changed, the installed CLI applied
  self-host revision 2 and completed all seven nodes, including the new
  lightweight install proof and final Decision.
- After hardening the install boundary, the installed CLI applied revision 3
  and again completed all seven nodes with source manifest immutability as an
  explicit Gate.
- Revision 4 added both explicit `--prefix` and inherited `BUN_INSTALL`
  rejection as Gates; the installed CLI completed all seven nodes again.

Generated detailed Evidence is retained at ignored runtime path
`.tmp/e2e/cli/result.json` with its HTML projection.

## Viewer smoke

- The named process survived its launcher and answered health on loopback.
- The overview read two simultaneous self-hosted Graphs and five Running nodes.
- `POST /api/snapshot` returned `405 READ_ONLY_VIEWER`.

## Lightweight install

- `release:pack` produced an approximately 1.10 MB archive containing the
  bundled CLI and Viewer with zero package dependencies.
- Final archive size is 1,099,500 bytes with SHA-256
  `d15dc44dedb717b78bc85add5e0d502a6bf2fe92e1f4f9f6febe296ffccc4f72`.
- `bun add --global <archive>` installed into an isolated Bun prefix in 40 ms
  on the verification machine; installed package content was 4,290,945 bytes.
- The installed command returned version with exit `0`, initialized and
  persisted a project, claimed two nodes in parallel processes, completed the
  Graph, and ran outside the source tree.
- The packaged Viewer returned health `200`; mutation returned `405`.
- This install dogfood found and fixed a prior `--version` false failure.
- A second install dogfood found and fixed Bun injecting the local archive into
  source manifests when its working directory contained `package.json`; the
  installer now uses an isolated temporary working directory and the E2E
  asserts byte-identical source manifests.

Generated installation Evidence is retained at
`.tmp/e2e/install/result.json`.
