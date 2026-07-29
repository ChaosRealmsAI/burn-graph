# GraphSpec

GraphSpec is authored as JSON. Start, Join, and End are structural and
auto-complete. Task and Decision are the only assignable node types.

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

## Invariants

- Exactly one Start and one End exist.
- Every node is reachable from Start and has a non-loop path to End.
- A forward cycle is invalid.
- A bounded back-edge must go from Decision to an ancestor Task and declare a
  positive `maxTraversals`.
- Every Decision edge has a unique route.
- Join has at least two incoming branches and waits until all are resolved.
- A normal Task activates every Next edge; Decision activates exactly one.
- All-disabled branches become Skipped and propagate that state.
- A Run pins one immutable GraphSpec revision.

Use `burn-graph graph validate --input graph.json` before
`burn-graph graph apply --input graph.json`.
