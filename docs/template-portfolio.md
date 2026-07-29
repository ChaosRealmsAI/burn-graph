# Template portfolio control

burn-graph ships six immutable workflow templates: `delivery`,
`vertical-slice`, `poc`, `bugfix`, `review-repair`, and `release`. Templates
remove structural boilerplate; generated GraphSpecs remain ordinary
project-local JSON and every Run uses the same Assignment loop.

## Instantiate a template

Discover the contract progressively:

```bash
burn-graph template list
burn-graph template show vertical-slice
```

Create `template-input.json`:

```json
{
  "schemaVersion": 1,
  "idempotencyKey": "slice-auth-1",
  "graphId": "slice-auth",
  "goal": "Deliver the authenticated user result.",
  "include": ["security", "performance"],
  "context": {
    "mustRead": ["README.md", "../privacy/product.md"],
    "lockedContracts": ["../privacy/architecture.md"],
    "writablePaths": ["features/auth"],
    "forbidden": ["Do not change unrelated features."],
    "runtime": ["bun run check"]
  },
  "promptOverrides": []
}
```

Then instantiate and start:

```bash
burn-graph template instantiate vertical-slice --input template-input.json
burn-graph run start slice-auth --actor primary --run-id slice-auth:run
```

The complete generated set validates before one file or immutable revision is
registered. Equivalent idempotency replay returns the original receipt. A bad
path, Check reference, override, GraphSpec, or conflicting key leaves no
partial file or database revision. Read-only prompt references may address the
project or one direct sibling contract repository; writable paths always stay
inside the initialized project.

Each supported `include` value materializes one ordered `risk-<stage>` Task
before the optional machine Gate and review. Unsupported stages fail with
`TEMPLATE_STAGE_NOT_SUPPORTED`; they are never accepted as inert metadata.

Prompt overrides may change only `objective`, `instructions`, and `doneWhen`
for one known injectable node. Absolute and multi-parent read references are
rejected, as is any parent traversal in `writablePaths`. Templates cannot
inject commands, environment values, results, or arbitrary Graph structure.

## Coordinate several root trees

The Runtime rotates eligible work across roots before taking another candidate
from the same root. Priority changes the initial order; every five minutes of
eligible waiting raises effective priority by one level, so old low-priority
work cannot starve.

```bash
burn-graph run priority slice-auth:run --value high \
  --idempotency-key slice-auth-priority-1
burn-graph next --actor primary
```

Task, dynamic Subgraph, and Gate resources are exclusive. Assignment creation
and resource acquisition share one SQLite transaction. A conflict stays Ready
with `eligibility.reason = "RESOURCE_BUSY"` while unrelated work proceeds.
Completion, release, failure, cancellation, or lease reconciliation releases
only the exact owner's locks.

## Inspect without mutation

```bash
burn-graph inspect overview --root-run slice-auth:run --depth 0
burn-graph inspect overview --node-status ready,running \
  --resource rust-build --priority high --limit 50
burn-graph inspect ready --actor primary
burn-graph inspect resources
burn-graph inspect metrics
burn-graph inspect metrics slice-auth:run
```

Overview filters include Run/root, exact depth, Run status, multiple Node
statuses, Actor, tag, resource, and root priority. The response reports
matching rows, listed rows, and separate Run/Node truncation. All rows and
totals come from one SQLite read snapshot.

Metrics derive only from durable numeric, status, timestamp, and ownership
records. They summarize attempts, repairs, lease recovery, live Assignment
concurrency, Gate classifications and duration, Wait latency, active locks,
and visible contention. Prompt text, Task results, Check output, and
environment values are explicitly excluded.

The Viewer consumes the same project snapshot. `inspect tree`, Mermaid, SVG,
and PNG use the same bounded tree projection; artifact responses include that
projection so consumers can compare totals directly.
