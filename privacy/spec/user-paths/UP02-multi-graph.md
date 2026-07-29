# UP02 AI advances several graphs concurrently

## User and starting point

One primary AI has initialized burn-graph and created at least two independent
GraphSpecs in the same project.

## Path

The AI starts both graphs and receives initial Assignments. `next` fills the
Actor's available slots from Ready work across all active Runs, rotating
deterministically instead of draining one Run first. The primary AI focuses an
owned Assignment in one graph, then switches to another without changing
execution state. Both graphs continue independently under their own
`maxActive` limits and the project-wide per-Actor cap. Completion in one graph
cannot unlock or mutate the other.

## Variants and recovery

Two processes may race to schedule one node; exactly one receives its
Assignment while both receive valid responses. Pausing one graph prevents new
scheduling only in that graph. Restarting the CLI or Viewer does not lose
either graph.

## End-to-end oracle

Two active graphs show overlapping Running intervals, no node or Attempt has
two live Assignments, and each graph reaches its own correct result.
