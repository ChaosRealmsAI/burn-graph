# Architecture

## Owners

| Owner | Responsibility |
|---|---|
| Core Contract | GraphSpec, node types, runtime snapshots, events, errors, and assignment packets |
| Graph Validator | Topology, reachability, convergence grammar, branch labels, and bounded back-edges |
| Runtime Engine | Deterministic activation, Assignment scheduling, attempts, route resolution, joins, retries, and completion |
| SQLite Store | Transactions, revisions, WAL persistence, migrations, event sequence, and recovery |
| CLI Surface | Stable JSON Help, stdin/stdout envelopes, Assignment loop, inspection, recovery, and exit behavior |
| Release Packager | Dependency-free Bun archive containing the bundled CLI and Viewer |
| Design System | Tokens and complete dashboard/detail Regions |
| Viewer Server | Read-only snapshots, Mermaid, static assets, health, and SSE |

## Dependency direction

```text
CLI ───────┐
Viewer ────┼──> Core contracts + application service ──> SQLite
Preview ───┘

AI tools ──> CLI
CLI ──X──> AI providers, shell task execution, or model selection
```

## Canonical data

Graph JSON owns authoring facts. A graph run pins one graph revision. SQLite
owns every runtime fact and append-only event. Every live Attempt has one
opaque Assignment ID. Assignment packets include the graph summary, active
node, prompt contract, lease, legal routes, direct predecessor result
summaries, artifact references, and exact return commands; callers explicitly
inspect more context.

## State invariants

- Start and End are unique.
- Every node is reachable from Start and can reach End.
- Non-decision forward nodes activate every Next edge.
- Decision activates exactly one named route and disables its alternatives.
- A node becomes Ready only when every incoming edge is resolved and at least
  one is taken; all-disabled nodes become Skipped and propagate disablement.
- Join is structural and auto-completes after its activated inputs settle.
- Back-edges target ancestors, are explicit, and have a positive traversal cap.
- Scheduling respects per-Run `maxActive`, an eight-Assignment per-Actor cap,
  actor hints, and deterministic cross-Run rotation.
- The Actor cap is checked inside the same write transaction as Assignment
  creation. Normal-loop output returns at most eight Assignment packets, eight
  relevant Run summaries, and 32 Ready previews with full counts.
- Ready scheduling validates each pinned GraphSpec once per Run. The local cold
  500-Task start fixture has a 1,000 ms failure threshold and records
  five-sample p50/p95/max before staging.
- Public callers cannot directly select a Ready node; they can focus only an
  already-owned Assignment.
- Completion is idempotent for equivalent JSON and rejects conflicting replay.
- A blocked Assignment can only unblock its own Attempt; stale handles cannot
  mutate a later Attempt.
- One state transaction increments one revision and emits one event.
- Viewer HTTP handlers cannot access mutation methods.

## Runtime and privacy

The CLI discovers the nearest parent containing `.burn-graph/config.json`.
Runtime files use owner-only permissions where supported. Prompt and result
content never enters shareable logs. Named Viewer records contain exact PID
ownership data internally, but ownership tokens are not returned by public
commands. The Viewer binds loopback.

## Distribution

The release archive owns only the bundled CLI, static Viewer assets, package
metadata, and README. It declares no package dependencies and requires an
existing Bun runtime. Installation is handled by Bun's global package link;
runtime graph state remains project-local and is never packaged.
