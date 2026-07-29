# CLI contract

burn-graph prints one compact JSON envelope per bounded command:

```json
{
  "ok": true,
  "command": "work.claim",
  "revision": 2,
  "event": {},
  "data": {}
}
```

Failures use exit code `1` and a stable `error.code`, `retryable`, and
structured `details`. Argument values are never copied into the `command`
label. `mermaid` emits Mermaid source and `events follow` emits JSON Lines.

Global options precede the command:

```bash
burn-graph --root path/to/project --pretty run list
```

## AI loop

```bash
# See every eligible Task and Decision across all active Graphs.
burn-graph work ready --all

# Start one node atomically and receive its prompt contract.
burn-graph work claim delivery implement --actor primary --lease 900

# Recover the Actor's focused and other claimed work after interruption.
burn-graph work current --actor primary

# Persist bounded progress without ending the node.
printf '%s' '{"summary":"Tests added","progress":70,"artifacts":["tests/"]}' |
  burn-graph work checkpoint delivery implement --actor primary --input -

# End the node. burn-graph resolves and activates structural Next.
printf '%s' '{"summary":"Verified","evidence":["tests/"]}' |
  burn-graph work complete delivery implement --actor primary --input -
```

Claim is the node start boundary and the prompt-injection boundary. The
calling AI performs the task with its own tools; burn-graph never executes the
instructions. Complete is the node end boundary. Task fan-out, Join, Decision,
Skip, bounded repair, and End are deterministic runtime transitions.

Decision completion adds one declared route:

```json
{
  "summary": "One blocker remains",
  "route": "repair",
  "evidence": ["quality finding"]
}
```

A reopened repair assignment includes the prior Decision Attempt, route,
summary, and evidence so the AI knows why it returned.

## Commands

| Area | Commands |
|---|---|
| Project | `init`, `doctor` |
| GraphSpec | `graph validate`, `graph apply`, `graph list`, `graph show`, `graph clone` |
| Run | `run start`, `run list`, `run show`, `run pause`, `run resume`, `run cancel` |
| Work | `work ready`, `work claim`, `work current`, `work focus`, `work heartbeat`, `work checkpoint`, `work complete` |
| Recovery | `work block`, `work unblock`, `work release`, `work fail --retry`, `work reconcile` |
| Observation | `events list`, `events follow`, `mermaid`, `serve` |

`work ready --all` spans active Graphs. Each Graph enforces its own
`maxActive`; a Claim beyond that limit is a retryable conflict. Claim uses a
SQLite `BEGIN IMMEDIATE` transaction, so two processes racing for one node
produce exactly one winner.

Pause prevents new Claims in that Run but lets an already Running Actor report
its result. Lease expiry preserves the old Attempt and can be recovered
opportunistically by a new Claim or explicitly with `work reconcile`.

## Local state

```text
.burn-graph/
├── config.json
├── graphs/          # normalized, versionable GraphSpecs
└── runtime/         # ignored SQLite, WAL, and runtime artifacts
```

Every Run pins a GraphSpec revision in SQLite. Editing a JSON file does not
change runtime state; `graph apply` validates and registers a strictly newer
revision.
