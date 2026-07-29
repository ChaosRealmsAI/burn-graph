# M02 — Assignment-driven CLI convergence

Target version: `0.1.0-dev.2`.

An AI starts a Graph with an Actor, immediately receives complete prompt
Assignments, reports work through opaque Assignment handles, and receives
automatically scheduled successors across parallel nodes and multiple Graphs.

Exit Gates:

- Root, area, command, topic, and error Help are stable JSON.
- Start, Next, Done, Current, Focus, recovery, inspection, and Viewer paths
  pass from the installed CLI.
- Scheduler fairness, per-Graph `maxActive`, per-Actor cap eight, leases,
  idempotent completion, bounded loops, and concurrent scheduling are proven.
- A cold 500-Task `run start` stays below the 1,000 ms regression threshold on
  the local Bun test fixture, with five-sample p50/p95 recorded in Evidence.
- The old manual Work surface and superseded query/server commands are absent.
- New self-hosted Graphs dogfood the converged CLI and full verification passes.
