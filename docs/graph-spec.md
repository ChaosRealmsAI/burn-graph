# GraphSpec

GraphSpec is authored as JSON. Start, Join, and End are structural and
auto-complete. Task and Decision are assignable in both versions; a v2 dynamic
Subgraph is also assignable because its completion seals an immutable child
set. Static Subgraph, Gate, and Wait are package-driven System Nodes.

```json
{
  "schemaVersion": 1,
  "id": "delivery",
  "title": "Deliver one verified change",
  "goal": "Implement and verify two independent branches.",
  "revision": 1,
  "maxActive": 2,
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "title": "Start",
      "next": [{ "to": "implement" }, { "to": "verify" }]
    },
    {
      "id": "implement",
      "type": "task",
      "title": "Implement",
      "prompt": {
        "objective": "Implement the smallest working result.",
        "instructions": ["Keep the provider boundary neutral."],
        "mustRead": ["README.md"],
        "doneWhen": ["Typecheck passes."],
        "outputSchema": {
          "type": "object",
          "required": ["checks"],
          "properties": {
            "checks": { "type": "array", "items": { "type": "string" } }
          },
          "additionalProperties": false
        }
      },
      "next": [{ "to": "join" }]
    },
    {
      "id": "verify",
      "type": "task",
      "title": "Verify",
      "prompt": { "objective": "Verify from the public entry." },
      "next": [{ "to": "join" }]
    },
    {
      "id": "join",
      "type": "join",
      "title": "Converge",
      "next": [{ "to": "accept" }]
    },
    {
      "id": "accept",
      "type": "decision",
      "title": "Accept",
      "prompt": { "objective": "Choose pass or repair from evidence." },
      "next": [
        { "to": "end", "route": "pass", "label": "accepted" },
        {
          "to": "implement",
          "route": "repair",
          "label": "repair implementation",
          "maxTraversals": 2
        }
      ]
    },
    {
      "id": "end",
      "type": "end",
      "title": "Done",
      "next": []
    }
  ]
}
```

Omitted prompt arrays, `actorHint`, `tags`, and `maxAttempts` receive normalized
defaults during validation. `actorHint` affects scheduler ranking but does not
restrict ownership.

## Version 2 hierarchy

Version 1 remains valid and immutable. Validation normalizes the additional
prompt fields `role`, `lockedContracts`, `writablePaths`, `forbidden`, and
`runtime` to empty values when omitted; non-empty values and node resources
require version 2. Version 2 adds `subgraph`, `gate`, and `wait` nodes while
keeping the CLI response envelope at schema version 1.

In `0.1.0-dev.6`, Gate and Wait execute through the package-owned bounded
System Node Driver. A Gate pins an immutable CheckSpec revision registered
with `check apply`; a Wait creates one durable opaque Signal and consumes no
Actor slot. Mutating loop commands converge these System Nodes before returning
AI Assignments, while all inspection and rendering commands remain inert.

A static Subgraph pins one to 32 exact child Graph revisions:

```json
{
  "id": "slices",
  "type": "subgraph",
  "title": "Run slices",
  "mode": "static",
  "children": [
    { "graphId": "vertical-slice", "revision": 3, "label": "hierarchy" },
    {
      "graphId": "vertical-slice",
      "revision": 3,
      "runId": "stable-slice-render",
      "label": "render"
    }
  ],
  "resources": [],
  "next": [
    { "to": "done", "route": "success" },
    { "to": "repair", "route": "failure" },
    { "to": "cancelled", "route": "cancelled" }
  ]
}
```

A dynamic Subgraph replaces `children` with `minChildren` and `maxChildren`,
and requires a non-empty prompt. Its ordinary `done.output.children` contains
only exact `graphId`, `revision`, optional stable `runId`, and optional
`label`. The entire set validates before any child link or Run is created.
Equivalent replay returns the first continuation without creating another
Assignment, Run, revision, or event; changed replay input is rejected.

Subgraph routes are `success`, `failure`, and `cancelled`; `success` is
required while failure outcomes without a declared route fail the parent
instead of being inferred. Gate requires exact `pass` and `fail` routes. Wait
edges exactly match its declared Signal routes and optional timeout route.

CheckSpec uses exact argv, a confined project-relative cwd, bounded timeout and
output, explicit success codes, a small inherited-environment allowlist, and
optional exclusive resources. Shell executables, parent traversal, absolute
paths, inline environment values, and unregistered revisions are rejected.
Use `check validate`, then `check apply`, before applying a Graph that pins it.

Hierarchy is bounded to 32 children per Subgraph, eight levels, and 256
unfinished descendants per root. Project config may lower but never raise the
package limits. A child pins one Graph revision, has one parent node and root,
and cannot reference a GraphSpec already present in its ancestor chain.

The runtime exposes one canonical bounded tree projection:

```bash
burn-graph inspect tree <run> --depth 0 --limit 500
burn-graph inspect mermaid <run> --scope tree --depth 1 --limit 500
burn-graph render <run> --scope tree --depth 1 --format svg
```

Depth zero expands only the selected Run. Each expanded Run exposes its direct
children as folded status/progress nodes; deeper descendants remain summarized
behind that frontier instead of being enumerated. Each additional depth expands
one more child topology level. Expanded Graph nodes and visible folded Runs
share the same 500-node budget. CLI, Viewer, SVG, and PNG consume one
transactionally consistent projection and never mutate it.

## Invariants

- Exactly one Start and one End exist.
- Every node is reachable from Start and has a non-loop path to End.
- A forward cycle is invalid.
- A bounded back-edge must go from Decision to an ancestor Task and declare a
  positive `maxTraversals`.
- Every Decision edge has a unique route.
- Join has at least two incoming branches and waits until all are resolved.
- A normal Task activates every Next edge; Decision activates exactly one.
- A Subgraph seals its child set before entering Waiting and selects one
  declared structural outcome only after every child is terminal.
- All-disabled branches become Skipped and propagate that state.
- A Run pins one immutable GraphSpec revision.

Use `burn-graph graph validate --input graph.json` before
`burn-graph graph apply --input graph.json`.
