# UP02 AI advances several graphs concurrently

## User and starting point

One primary AI has initialized burn-graph and created at least two independent
GraphSpecs in the same project.

## Path

The AI starts both graphs and asks for Ready work across all graphs. Distinct
actors atomically claim different nodes. The primary AI focuses a node in one
graph, then switches to a node in the other without changing either node's
execution state. Both graphs continue independently under their own
`maxActive` limits. Completion in one graph cannot unlock or mutate the other.

## Variants and recovery

Two actors may race for one node; exactly one receives the assignment. Pausing
one graph prevents new claims only in that graph. Restarting the CLI or Viewer
does not lose either graph.

## End-to-end oracle

Two active graphs show overlapping Running intervals, no node has two live
claims, and each graph reaches its own correct result.
