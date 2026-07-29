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
| Inspection | `inspect overview`, `inspect run`, `inspect node`, `inspect ready`, `inspect mermaid`, `inspect events` |
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

Pause prevents new scheduling in that Run while existing Assignment handles
remain reportable. Lease expiry preserves the Attempt; `next` reconciles it
automatically, and `recover reconcile [run-or-graph]` exposes the exceptional
path explicitly.

## Progressive Help

```bash
burn-graph --help
burn-graph graph --help
burn-graph done --help
burn-graph help ai-loop
burn-graph help graph-spec
burn-graph help inspect
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
└── runtime/         # ignored SQLite, WAL, Viewer records, and logs
```

Every Run pins an immutable GraphSpec revision. Editing JSON does not mutate a
Run; `graph apply` validates and registers a strictly newer revision.
