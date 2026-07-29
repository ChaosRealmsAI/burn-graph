# CLI contract

Every bounded command prints one JSON envelope. Help, version, success, and
failure use the same top-level shape:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "next",
  "data": {},
  "changes": [],
  "nextActions": []
}
```

Failures exit `1` with stable `error.code`, `retryable`, `details`, and exact
`recoveryActions`. `inspect events --follow` is the only streaming command and
emits one envelope per JSONL line. Global options precede the command:

```bash
burn-graph --root path/to/project --pretty inspect overview
```

## Guarded AI loop

```bash
burn-graph init
burn-graph graph apply --input graph.json
burn-graph run start delivery --actor primary

# Execute every returned AssignmentPacket prompt.
printf '%s' '{"summary":"Verified","evidence":["tests/"]}' |
  burn-graph done --assignment <assignment-id> --input -

# Recover complete packets after interruption or fill empty Actor slots.
burn-graph current --actor primary
burn-graph next --actor primary
```

`run start`, `run resume`, `next`, and `done` return zero or more complete
Assignment packets. Each packet contains an opaque `assignmentId`, Graph and
node identity, Attempt, prompt contract, direct predecessor context, legal
Decision routes, lease, and exact return commands. The AI executes the prompt;
burn-graph never executes it.

`done` is idempotent for the same Assignment ID and byte-equivalent JSON input.
A different result for an already completed Assignment returns
`ASSIGNMENT_INPUT_CONFLICT`. Structural Start, Join, Skip, bounded repair, and
End transitions are automatic.

The dev.5 runtime executes Subgraph but deliberately fails before mutation with
`SYSTEM_NODE_UNAVAILABLE` when a root or statically reachable child contains
Gate or Wait. Their GraphSpec shapes can already be validated and registered;
the Check/Signal System Node Driver becomes executable in dev.6.

Decision completion includes one declared route:

```json
{
  "summary": "One blocker remains",
  "route": "repair",
  "evidence": ["quality finding"]
}
```

A reopened Task gets a new Assignment ID and Attempt number plus the prior
Decision route, summary, and evidence.

## Public commands

| Area | Commands |
|---|---|
| Project | `init`, `doctor`, `help` |
| GraphSpec | `graph validate`, `graph apply`, `graph list`, `graph show`, `graph clone` |
| Run lifecycle | `run start`, `run pause`, `run resume`, `run cancel` |
| Normal loop | `next`, `current`, `focus`, `done` |
| Artifact | `render` with `run` or `tree` scope |
| Inspection | `inspect overview`, `inspect run`, `inspect tree`, `inspect node`, `inspect ready`, `inspect mermaid`, `inspect events` |
| Recovery | `recover heartbeat`, `recover checkpoint`, `recover block`, `recover unblock`, `recover release`, `recover fail`, `recover reconcile` |
| Human Viewer | `viewer start`, `viewer status`, `viewer stop` |

The Runtime chooses nodes. There is no public command that directly claims a
named Ready node. Scheduling is transactional, respects each Graph's
`maxActive`, caps one Actor at eight live Assignments, ranks matching
`actorHint` first, and rotates deterministically across Runs. Concurrent `next`
calls cannot create duplicate live Assignments.

Normal-loop responses are bounded: at most eight complete Assignment packets,
eight relevant Run summaries, and 32 Ready preview rows. `activeRunCount` and
`remainingReadyCount` preserve the full queue totals; deeper history belongs
under `inspect`.

Lifecycle mutations require a stable retry key:

```bash
burn-graph run pause delivery --idempotency-key pause-20260730-1
burn-graph run resume delivery --actor primary \
  --idempotency-key resume-20260730-1
burn-graph run cancel delivery --idempotency-key cancel-20260730-1
```

Pause suppresses new scheduling across the selected Run subtree while existing
Assignment handles remain reportable. Completion, release, or lease expiry of
the last owned Assignment moves the subtree from Pausing to Paused. Equivalent
key replay returns the first bounded continuation and adds no Assignment,
revision, or event; using the key for another operation, Run, or resume Actor
is rejected. Equivalent `done` replay follows the same rule for its Assignment
handle. `next` reconciles expired leases automatically, and
`recover reconcile [run-or-graph]` exposes the exceptional path explicitly.

## Graph artifacts

```bash
burn-graph render delivery
burn-graph render delivery --format png
burn-graph render delivery --scope tree --depth 1 --limit 500
```

`render` reads the canonical Run snapshot and returns bounded metadata for a
file beneath `.burn-graph/runtime/renders/`. SVG is the default. Metadata
includes the Run and Graph IDs, runtime revision, scope, projection depth,
source hash, project-relative artifact path, dimensions, bytes, SHA-256, cache
status, and renderer versions. It does not change Run revision or events.

`run` scope preserves the original one-Run diagram. `tree` scope reads the same
canonical hierarchy snapshot as `inspect tree` and the Viewer. Depth zero
expands the selected Run and shows only its direct children as folded
status/progress nodes. Hidden descendants contribute to aggregate totals but
are not enumerated until their parent level is expanded. Every expanded node
and visible folded Run counts against `--limit`, whose package maximum is 500.
An oversized request fails with `PROJECTION_LIMIT` before rendering.

```bash
burn-graph inspect tree delivery --depth 0 --limit 500
burn-graph inspect tree delivery --depth 1 --limit 500
burn-graph inspect mermaid delivery --scope tree --depth 1
```

The tree response includes one immutable projection root, ordered visible Run
entries, full-tree totals, fold state, direct and descendant totals,
rendered-node count, event cursor, and Mermaid source. The whole response is
read under one SQLite snapshot. Read-only projection does not increment a
revision or append an event.

A cache miss launches a new Chrome-family headless child with an ephemeral
profile and loopback-only static page. burn-graph stops only that exact child.
Set `BURN_GRAPH_CHROME_BIN` when automatic discovery is unavailable. A
validated cache hit does not require a browser. `doctor` reports this as
`capabilities.render`; browser absence does not make core health fail.

## Progressive Help

```bash
burn-graph --help
burn-graph graph --help
burn-graph done --help
burn-graph help ai-loop
burn-graph help graph-spec
burn-graph help lifecycle
burn-graph help inspect
burn-graph help render
burn-graph help recover
burn-graph help errors
```

Root Help returns only command groups, quick start, and links to deeper Help.
Area and leaf Help disclose arguments, options, mutation behavior, input,
output, errors, and next commands. Argument failures retain the recognized
command label and point to that command's leaf Help. Removed legacy commands
fail as invalid arguments: `work`, top-level `events`, top-level `mermaid`,
`serve`, `run list`, and `run show`.

## Local state

```text
.burn-graph/
├── config.json
├── graphs/          # normalized, versionable GraphSpecs
└── runtime/         # ignored SQLite, WAL, Viewer records, and render cache
```

Every Run pins an immutable GraphSpec revision. Editing JSON does not mutate a
Run; `graph apply` validates and registers a strictly newer revision.
