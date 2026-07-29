# UP01 AI runs a prompt graph to completion

## User and starting point

An AI is operating inside a real project directory that has no burn-graph
state. It can invoke local CLI commands and read JSON stdout.

## Path

The AI initializes burn-graph, submits a complete GraphSpec, validates it, and
starts it with an Actor ID. Start activates two Tasks and the same command
immediately returns both complete Assignment packets. The AI executes the
prompts externally, optionally checkpoints by Assignment ID, and reports each
result with `done`. Completion automatically unlocks and returns legal
successors; the AI never calls a separate unlock or direct-node claim command.
A Join waits until both branches settle. A Decision returns `repair`, reopening
the bounded earlier Task with a new Assignment and preserved Attempt context.
After repair the Decision returns `pass`; End completes the graph.

## Variants and recovery

The AI may block, release, fail, retry, or switch focus between owned
Assignments. `current` recovers complete prompt packets after interruption.
An expired lease returns eligible work to Ready through reconciliation. The
same `done` input is safe to replay; a conflicting replay is rejected. A
process restart retains definitions, attempts, results, and event order.

## End-to-end oracle

The CLI snapshot reports the graph `completed`, every activated node has a
terminal state, skipped routes are explicit, the bounded loop count is one,
each Attempt has one Assignment identity, and event history reconstructs every
transition.
