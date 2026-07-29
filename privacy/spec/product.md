# burn-graph product

## Users and promise

burn-graph serves a primary AI that needs to keep several durable prompt graphs
moving while the human retains a truthful overview. The AI can create, inspect,
start, resume, complete, recover, and observe work through one local CLI.
burn-graph chooses eligible nodes and returns complete prompt Assignments; the
AI reports through opaque handles and automatically receives successors. The
human can open a named local Viewer without becoming the scheduler. A small
dependency-free Bun package installs the CLI and Viewer in one command.

## Boundaries

- A graph is a prompt-task topology and state machine, not an Agent runtime.
- Task content, delegation, code changes, tests, and verification are performed
  by the calling AI with its existing tools.
- Graph definitions are local JSON; runtime history is local SQLite.
- Multiple graphs and multiple eligible nodes may progress concurrently.
- The public CLI does not let a caller directly claim a named Ready node.
- Assignment identity, leases, idempotent completion, and bounded output keep
  retries from duplicating or corrupting work.
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
- UP02: AI advances parallel nodes and multiple graphs without duplicate work.
- UP03: Human observes live Mermaid state through named Viewer instances.
- UP04: User installs the CLI and Viewer without a container or dependency tree.
