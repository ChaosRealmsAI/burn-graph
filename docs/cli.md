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
emits one envelope per JSONL line. Each envelope is limited to 256 KiB and
public output never exposes an absolute project or package path. Global options
precede the command:

```bash
burn-graph --root path/to/project --pretty inspect overview
```

## Guarded AI loop

```bash
burn-graph init
burn-graph help authoring
burn-graph graph example decision
burn-graph graph schema
burn-graph graph apply --input graph.json
burn-graph run start delivery

# Execute every returned AssignmentPacket prompt.
printf '%s' '{"summary":"Verified","evidence":["tests/"]}' |
  burn-graph done --assignment <assignment-id> --input -

# Recover complete packets after interruption or fill empty Actor slots.
burn-graph current
burn-graph next
```

Every structured input accepts a project-relative file or `--input -` for
stdin. Absolute paths, parent traversal, and paths that escape through a
symlink are rejected before mutation. JSON input is limited to 2 MiB.
`graph validate` and `check validate` return bounded normalized size and digest
receipts; they do not turn a valid large document into an output-limit failure.

`run start`, `run resume`, `next`, `done`, and routed Signal resolution return
zero or more complete Assignment packets. Before scheduling AI work, their
bounded System Node Driver runs only registered Gate Checks and materializes or
settles durable Waits. Each AI packet contains an opaque `assignmentId`, Graph
and node identity, Attempt, prompt contract, direct predecessor context, legal
Decision routes, lease, and exact return commands. burn-graph never executes an
AI prompt. One normalized prompt contract is limited to 32 KiB. Completion
summary, evidence, and route share an 8 KiB successor-context limit;
node-specific output is not repeated into successor context.

`done` is idempotent for the same Assignment ID and byte-equivalent JSON input.
A different result for an already completed Assignment returns
`ASSIGNMENT_INPUT_CONFLICT`. Structural Start, Join, Skip, bounded repair, and
End transitions are automatic.

Read-only commands never invoke the System Node Driver. An overdue Wait may be
visible through inspection but selects its timeout route only on a mutating
loop or explicit reconciliation command.

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
| Templates | `template list`, `template show`, `template instantiate` |
| GraphSpec | `graph schema`, `graph example`, `graph validate`, `graph apply`, `graph list`, `graph show`, `graph clone` |
| CheckSpec | `check validate`, `check apply`, `check list`, `check show` |
| Run lifecycle | `run start`, `run pause`, `run resume`, `run cancel`, `run priority` |
| Normal loop | `next`, `current`, `focus`, `done` |
| External outcome | `signal resolve` |
| Artifact | `render` with `run` or `tree` scope |
| Inspection | `inspect overview`, `inspect run`, `inspect tree`, `inspect node`, `inspect ready`, `inspect waits`, `inspect resources`, `inspect metrics`, `inspect executions`, `inspect mermaid`, `inspect events` |
| Recovery | `recover heartbeat`, `recover checkpoint`, `recover block`, `recover unblock`, `recover release`, `recover fail`, `recover reconcile` |
| Human Viewer | `viewer start`, `viewer status`, `viewer stop` |

The Runtime chooses nodes. There is no public command that directly claims a
named Ready node. Scheduling is transactional, respects each Graph's
`maxActive`, caps one Actor at eight live Assignments, ranks matching
`actorHint` first, and rotates deterministically across root Run trees.
Low/normal/high priority affects order, while five-minute aging prevents an
older eligible root from starving. Concurrent `next` calls cannot create
duplicate live Assignments.

Task, dynamic Subgraph, and Gate resource ownership is exclusive and acquired
in the same transaction as the Assignment or Check execution. Inspect
contention without claiming it:

```bash
burn-graph inspect ready --actor primary
burn-graph inspect resources
```

Normal-loop responses are bounded: at most eight complete Assignment packets,
128 KiB of complete packets per Actor, eight relevant Run summaries, and 32
Ready preview rows. `assignmentOutput` reports packet bytes, the limit, a
bounded blocked sample, and its full blocked count. `activeRunCount` and
`remainingReadyCount` preserve the full queue totals; deeper history belongs
under `inspect`.

If a committed mutation's full response would still exceed 256 KiB, the CLI
returns exit 0 with a bounded success receipt containing `responseOmitted`,
the omitted response size and SHA-256, committed-change count, and read-only
recovery actions. It never converts committed state into an apparent command
failure. Oversized read-only output remains `OUTPUT_LIMIT_EXCEEDED`.

Lifecycle mutations require a stable retry key:

```bash
burn-graph run pause delivery --idempotency-key pause-20260730-1
burn-graph run resume delivery \
  --idempotency-key resume-20260730-1
burn-graph run cancel delivery --idempotency-key cancel-20260730-1
burn-graph run priority delivery --value high \
  --idempotency-key priority-20260730-1
```

Pause suppresses new scheduling across the selected Run subtree while existing
Assignment handles remain reportable. Completion, release, or lease expiry of
the last owned Assignment moves the subtree from Pausing to Paused. Equivalent
key replay returns the first bounded continuation and adds no Assignment,
revision, or event; using the key for another operation, Run, or resume Actor
is rejected. Equivalent `done` replay follows the same rule for its Assignment
handle. `next` reconciles expired leases automatically, and
`recover reconcile [run-or-graph]` exposes the exceptional path explicitly.

Resolve a Wait with one declared route and a stable retry key:

```bash
printf '%s' '{"summary":"Approved","evidence":["evidence/approval.json"]}' |
  burn-graph signal resolve --signal <opaque-id> --route approved \
    --actor primary --idempotency-key approval-1 --input -
```

Without `--actor`, successors remain Ready. Equivalent replay is inert;
conflicting content or a cancelled Signal cannot unlock work.

Public events and normal-loop responses never contain Check stdout/stderr.
Use `inspect executions --include-output --output-bytes <1..16384>` for an
explicit bounded local diagnostic view.

## Templates and portfolio inspection

```bash
burn-graph template list
burn-graph template show bugfix
burn-graph template instantiate bugfix --input template-input.json

burn-graph inspect overview --root-run delivery --depth 1
burn-graph inspect overview --node-status ready,running \
  --actor primary --tag review --resource rust-build \
  --priority high --limit 50
burn-graph inspect metrics
```

Template instantiation validates the entire generated set before atomically
writing normalized GraphSpec JSON and immutable revisions. A stable
idempotency key makes equivalent retry inert.

Overview rows and totals come from one read snapshot. Filters cover Run/root,
exact hierarchy depth, Run status, multiple Node statuses, Actor, tag,
resource, and root priority. `totals` distinguishes matching and listed rows;
`truncated.runs` and `truncated.nodes` make every bound explicit.

Metrics expose only durable operational facts. Prompt/result text, Check
stdout/stderr, and environment values are never inputs to this projection.

## Graph artifacts

```bash
burn-graph render delivery
burn-graph render delivery --format png
burn-graph render delivery --scope tree --depth 1 --limit 500
```

`render` reads the canonical Run snapshot and returns bounded metadata for a
file beneath `.burn/graph/runtime/renders/`. SVG is the default. Metadata
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
burn-graph help authoring
burn-graph graph --help
burn-graph done --help
burn-graph help ai-loop
burn-graph help graph-spec
burn-graph help lifecycle
burn-graph help templates
burn-graph help inspect
burn-graph help render
burn-graph help recover
burn-graph help errors
```

Root Help returns exactly `init`, `template`, `run`, `next`, `current`, `done`,
`inspect`, and `help`, plus quick start and links to deeper topics. Graph,
Check, lifecycle, recovery, Signal, render, Viewer, and doctor commands remain
callable but require explicit progressive Help.
Area and leaf Help disclose arguments, options, mutation behavior, input,
output, errors, and next commands. Argument failures retain the recognized
command label and point to that command's leaf Help. Removed legacy commands
fail as invalid arguments: `work`, top-level `events`, top-level `mermaid`,
`serve`, `run list`, and `run show`.

## Local state

```text
.burn/graph/
├── config.json
├── graphs/          # normalized, versionable GraphSpecs
├── checks/          # normalized, versionable immutable CheckSpecs
└── runtime/         # ignored SQLite, WAL, Viewer records, and render cache
```

`.burn/` is the shared project state root of every Burn product; burn-graph
owns only `.burn/graph/`. Discovery walks parents from the working directory,
adopts the first directory containing `.burn/`, and stops at `$HOME`. `init`
creates `.burn/graph/` at the exact directory it is given and adds one
`.burn/graph/runtime/` entry to the project `.gitignore`, leaving GraphSpecs
and CheckSpecs versionable.

A pre-3.0 `.burn-graph/` directory without `.burn/graph/` fails every command
with `LEGACY_STATE_ROOT`: state is never migrated, read, or written through the
legacy root. Run `init`, then re-register the specifications kept in
`.burn-graph/graphs` and `.burn-graph/checks` with `graph apply` and
`check apply`; Run history under `.burn-graph/runtime` does not carry over.
Once `.burn/graph/` exists it wins, and `doctor` reports the leftover as
`legacyStateRoot` until it is gone.

Every Run pins an immutable GraphSpec revision. Editing JSON does not mutate a
Run; `graph apply` validates and registers a strictly newer revision.
