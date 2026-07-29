# UP01 AI runs a prompt graph to completion

## User and starting point

An AI is operating inside a real project directory that has no burn-graph
state. It can invoke local CLI commands and read JSON stdout.

## Path

The AI initializes burn-graph, submits a complete GraphSpec, validates it, and
starts the graph. The Start node activates two Task nodes in parallel. The AI
lists Ready work, claims one node, receives a bounded assignment packet, does
the task externally, checkpoints, and reports completion with a result.
Another actor claims and completes the second task. A Join waits until both
activated branches settle. A Decision then returns `repair`, reopening a
bounded earlier region while preserving its first Attempt. After repair the
Decision returns `pass`; End completes the graph. At every step, duplicate
claims and stale revisions return structured errors without corrupting state.

## Variants and recovery

The AI may block, release, fail, retry, or switch focus between claimed nodes.
An expired lease returns eligible work to Ready through reconciliation. A
process restart retains definitions, attempts, results, and event order.

## End-to-end oracle

The CLI snapshot reports the graph `completed`, every activated node has a
terminal state, skipped routes are explicit, the bounded loop count is one,
and the event history can reconstruct each transition.
