# burn-graph Product Preview

Revision `v2-draft` renders deterministic UP06 through UP10 fixtures through
the public design-system Regions. It is the pre-implementation contract for:

- Folded parent-child portfolio and one-level hierarchy expansion.
- Static and dynamic Subgraph progress.
- Machine Gate failure, injected repair context, and rerun.
- Durable Wait with no Assignment, restart recovery, and timeout.
- Quiescing pause and two-phase cancellation with an unowned Gate execution.
- Root priority, resource contention, bounded metrics, empty state,
  reconnecting state, and narrow layout.

Preview scene IDs are `hierarchy-overview`, `hierarchy-expanded`,
`gate-repair`, `durable-wait`, `lifecycle-control`, `template-portfolio`,
`resource-contention`, and `dogfood-metrics`.

The Preview has no backend, cannot mutate graph state, and does not claim the
new runtime exists. Revision v2 becomes locked only after user confirmation.
