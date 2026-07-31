# System Node Driver

Status: current locked implementation contract.

## Ownership

- `packages/core` owns Check and Signal contracts, immutable revisions,
  transactional Gate/Wait transitions, execution identities, resource rows,
  events, replay, lifecycle interaction, and bounded read models.
- `packages/gate` owns exact argv process execution, selected environment,
  bounded stdout/stderr capture, timeout through the held child handle, and
  result classification. It never opens SQLite.
- `packages/system-driver` owns the bounded application loop shared by CLI
  mutations. It composes Core and Gate Runner but owns neither policy nor
  persistence.
- `apps/cli` owns arguments, JSON stdin/stdout, progressive Help, and
  command-specific recovery actions. It does not choose a route or execute a
  Check directly.

Gate implementation changes own `packages/gate`, Check commands, Gate Core
transitions, and Gate tests. Wait implementation changes own Wait Core
transitions, Signal commands, and Wait tests. Shared contract or migration
edits integrate before either behavior changes.

## Core transaction boundary

`advanceSystemNodes(reference?)` commits one bounded transition and returns at
most one `GateExecutionClaim`. In one immediate transaction it may:

1. reconcile expired owned state;
2. settle due Wait timeout routes;
3. materialize eligible Wait nodes as opaque Signals;
4. claim one eligible Gate execution and its sorted resources.

The method never starts a process. A Gate claim contains one opaque execution
ID, the pinned normalized CheckSpec, project root, Run/node/attempt identity,
and lease. The Gate node is Running with no Assignment or Actor.

`reportGateExecution(executionId, result)` accepts only the current live
execution identity. It stores bounded local output, exposes only
classification, duration, byte count, and digest in public events, releases
resources, selects `pass` or `fail`, cascades structural state, and settles
ancestors in one transaction. Configuration or spawn failure makes the Gate
Blocked without taking a product route. Stale, cancelled, expired, or already
replaced identities cannot settle a node.

Wait materialization sets the node to Waiting and inserts one opaque Signal.
`resolveSignal` validates a declared route plus bounded summary and
project-relative evidence. Equivalent replay returns its stored receipt;
conflicting content is inert and returns `SIGNAL_INPUT_CONFLICT`.

## Driver loop

The Driver accepts a mutation callback, optional Actor, preferred Run, and a
maximum transition count. It:

1. commits the initiating Core mutation;
2. repeatedly asks Core for one System Node transition;
3. releases SQLite before running at most one claimed Gate;
4. reports that result through the opaque execution ID;
5. stops at an AI Assignment, unresolved Wait, paused/cancelling tree,
   terminal state, or transition bound;
6. schedules only the requested Actor after System Nodes settle.

Read-only commands never instantiate or invoke the Driver. `current`,
`inspect`, Viewer, render, and doctor may display overdue Waits or live
executions but cannot select a route, launch a Check, or increment a revision.

## Persistence migration

Migration v5 adds:

- `check_specs`: immutable normalized CheckSpec JSON by ID and revision;
- `check_executions`: opaque execution identity, pinned Check, attempt, lease,
  state, bounded local output, public classification/digest, and timestamps;
- `wait_signals`: opaque Signal, routes, deadline, pause accounting,
  resolution identity, bounded summary/evidence, and continuation receipt;
- `resource_locks`: exclusive resource, owner kind and identity, Run/node/root,
  expiry, and timestamps.

All tables are created in the existing immediate migration transaction.
Historical v1-v4 rows and events remain unchanged.

## Lifecycle

- Pause freezes every unresolved Wait at the root request time. Existing Gate
  execution identities remain valid; no new Gate or Wait transition starts.
- Resume shifts each frozen deadline exactly once, clears pause state, and
  invokes the Driver.
- Cancel immediately invalidates Signals and AI handles. Live Gate executions
  become stale while retaining resources; another process never signals their
  recorded PID. The tree remains Cancelling until exact runner exit or lease
  reconciliation releases the final Gate resource.

## Executable contract

`tests/system-driver/contracts.test.ts` is the shared executable oracle.
It proves immutable Check registration, one two-phase Gate claim, durable Wait
materialization, no Assignment consumption, and restart recovery without
weakening the existing hierarchy suite.
