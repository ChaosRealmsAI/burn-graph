# UP03 Human watches live graph convergence

## User and starting point

A human has a running local burn-graph project while AI actors update graph
state through the CLI.

## Path

The human starts a named Viewer and opens its printed loopback URL. The
dashboard lists all graphs with progress and Ready, Running, Blocked, Done, and
Failed counts. The human opens one graph and sees a Mermaid diagram whose
shapes distinguish Start, Task, Decision, Join, and End. Colors update after
CLI mutations without a page refresh. Selecting a node shows its prompt
contract, actor, Assignment, Attempt, direct predecessor summaries, result
summary, and event timeline. `viewer status` reports exact process health;
`viewer stop` terminates only that recorded instance. A restart reconstructs
the same state from disk.

## Variants and recovery

Distinct names and ports allow parallel Viewer instances. An empty project
explains how to create the first graph. A disconnected SSE stream visibly
reconnects and resumes from the last cursor. Long labels and narrow viewports
remain readable.

## End-to-end oracle

The visible counts, selected-node details, and Mermaid classes match a fresh
public CLI snapshot, and the browser offers no mutation control.
