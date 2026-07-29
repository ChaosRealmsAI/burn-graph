# burn-graph product

## Users and promise

burn-graph serves a primary AI that needs to keep several durable prompt graphs
moving while the human retains a truthful overview. The AI can create, inspect,
claim, switch, checkpoint, complete, block, and fail nodes through one local
CLI. The human can open a local live graph without becoming the scheduler. A
small dependency-free Bun package installs that CLI and Viewer in one command.

## Boundaries

- A graph is a prompt-task topology and state machine, not an Agent runtime.
- Task content, delegation, code changes, tests, and verification are performed
  by the calling AI with its existing tools.
- Graph definitions are local JSON; runtime history is local SQLite.
- Multiple graphs and multiple eligible nodes may progress concurrently.
- Mermaid and the Web Viewer are projections, never alternate sources of truth.
- Distribution reuses an existing Bun runtime instead of requiring a container
  or embedding another runtime.

## Non-goals for v0.1

- Launching or selecting AI providers.
- Executing shell commands declared by nodes.
- Cloud sync, accounts, remote collaboration, or production deployment.
- Browser-based graph editing.
- Unbounded loops or implicit routing inferred from free text.

## Current capability index

- UP01: AI creates and completes a convergent graph.
- UP02: AI advances multiple graphs and actors without duplicate claims.
- UP03: Human observes live Mermaid state and restart recovery.
- UP04: User installs the CLI and Viewer without a container or dependency tree.
