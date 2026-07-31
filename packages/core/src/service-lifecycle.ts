// Run lifecycle control: pause, resume, cancel and priority.
//
// These four are the operator-facing verbs that change what a Run is doing
// without touching any individual node's work. They share a distinctive shape —
// each is an idempotent mutation over a whole Run tree, cascading to descendants
// and settling ancestors — which is why they belong together and away from the
// node-level claim/complete machinery.
//
// Extracted with ten injected dependencies. The neighbouring claim and
// Assignment groups were measured at thirty each and deliberately left in place:
// they are two faces of one state machine, and a collaborator needing thirty
// injected functions is the service again with an extra layer of indirection.

import {
  BurnGraphError,
  GraphStatusSchema,
  RunPrioritySchema,
  type GraphEvent,
  type GraphSnapshot,
  type IdempotentMutationResult,
  type RunPriority,
  type RuntimeChange,
} from "./contracts.ts";
import { numberValue, optionalString, stringValue, type Row } from "./sql.ts";
import { BurnGraphDatabase } from "./storage.ts";

export type LifecycleOperation =
  | "pause"
  | "resume"
  | "cancel"
  | `priority:${RunPriority}`;

export interface RunLifecycleOptions {
  readonly database: BurnGraphDatabase;
  readonly runRow: (runId: string) => Row;
  readonly descendantRunRows: (runId: string) => readonly Row[];
  readonly appendEvent: (entry: {
    readonly runId: string;
    readonly graphId: string;
    readonly nodeId: string | null;
    readonly type: string;
    readonly summary: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly at: string;
  }) => number;
  readonly getEvent: (sequence: number) => GraphEvent;
  readonly getSnapshot: (reference: string, eventLimit?: number) => GraphSnapshot;
  readonly bumpRun: (runId: string, at: string) => number;
  readonly settleAncestors: (runId: string, at: string) => readonly RuntimeChange[];
  readonly driveStaticSubgraphs: (
    runId: string,
    at: string,
    changes: Array<Record<string, unknown>>,
    runtimeChanges: RuntimeChange[],
  ) => void;
  readonly executeLifecycleMutation: (
    operation: LifecycleOperation,
    reference: string,
    idempotencyKey: string,
    mutate: (
      runId: string,
      at: string,
    ) => {
      readonly rootSequence: number;
      readonly changes: readonly RuntimeChange[];
    },
  ) => IdempotentMutationResult<GraphSnapshot>;
}

export class RunLifecycle {
  constructor(private readonly options: RunLifecycleOptions) {}

  pauseRun(
    reference: string,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.options.executeLifecycleMutation(
      "pause",
      reference,
      idempotencyKey,
      (runId, at) => {
      const target = this.options.runRow(runId);
      if (stringValue(target, "status") !== "running") {
        throw new BurnGraphError(
          "INVALID_RUN_STATE",
          `Cannot pause ${runId} from ${stringValue(target, "status")}`,
        );
      }
      const tree = this.options.descendantRunRows(runId).filter((row) =>
        stringValue(row, "status") === "running",
      );
      const conflicting = this.options.descendantRunRows(runId).find(
        (row) =>
          optionalString(row, "pause_scope_run_id") !== null &&
          optionalString(row, "pause_scope_run_id") !== runId,
      );
      if (conflicting) {
        throw new BurnGraphError(
          "LIFECYCLE_CONFLICT",
          `Run ${stringValue(conflicting, "run_id")} is already paused by another scope`,
          true,
          {
            runId: stringValue(conflicting, "run_id"),
            pauseScopeRunId: optionalString(conflicting, "pause_scope_run_id"),
          },
        );
      }
      const ids = tree.map((row) => stringValue(row, "run_id"));
      const placeholders = ids.map(() => "?").join(", ");
      const live = this.options.database.db
        .query(
          `SELECT
             (SELECT COUNT(*)
                FROM node_runs
               WHERE run_id IN (${placeholders})
                 AND status = 'running'
                 AND assignment_id IS NOT NULL) +
             (SELECT COUNT(*)
                FROM check_executions
               WHERE run_id IN (${placeholders})
                 AND status = 'claimed') AS count`,
        )
        .get(...ids, ...ids) as Row;
      const nextStatus = numberValue(live, "count") > 0 ? "pausing" : "paused";
      this.options.database.db
        .query(
          `UPDATE runs
              SET status = ?, pause_requested_at = ?,
                  pause_scope_run_id = ?,
                  paused_at = CASE WHEN ? = 'paused' THEN ? ELSE NULL END,
                  runtime_revision = runtime_revision + 1,
                  updated_at = ?
            WHERE run_id IN (${placeholders})
              AND status = 'running'`,
        )
        .run(nextStatus, at, runId, nextStatus, at, at, ...ids);
      const changes: RuntimeChange[] = [];
      let rootSequence = 0;
      for (const row of tree) {
        const affectedRunId = stringValue(row, "run_id");
        const revision = numberValue(
          this.options.runRow(affectedRunId),
          "runtime_revision",
        );
        const sequence = this.options.appendEvent({
          runId: affectedRunId,
          graphId: stringValue(row, "graph_id"),
          nodeId: null,
          type: nextStatus === "paused" ? "run.paused" : "run.pausing",
          summary:
            nextStatus === "paused"
              ? `Paused run ${affectedRunId}.`
              : `Run ${affectedRunId} is quiescing.`,
          payload: { rootRequestRunId: runId, revision },
          at,
        });
        if (affectedRunId === runId) rootSequence = sequence;
        changes.push({ revision, event: this.options.getEvent(sequence) });
      }
      return { rootSequence, changes };
      },
    );
  }

  resumeRun(
    reference: string,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.options.executeLifecycleMutation(
      "resume",
      reference,
      idempotencyKey,
      (runId, at) => {
      const target = this.options.runRow(runId);
      if (!["pausing", "paused"].includes(stringValue(target, "status"))) {
        throw new BurnGraphError(
          "INVALID_RUN_STATE",
          `Cannot resume ${runId} from ${stringValue(target, "status")}`,
        );
      }
      if (optionalString(target, "pause_scope_run_id") !== runId) {
        throw new BurnGraphError(
          "LIFECYCLE_CONFLICT",
          `Run ${runId} is not the owner of its effective pause`,
          true,
          {
            pauseScopeRunId: optionalString(target, "pause_scope_run_id"),
          },
        );
      }
      const tree = this.options.descendantRunRows(runId).filter((row) =>
        optionalString(row, "pause_scope_run_id") === runId,
      );
      const liveRows = tree.filter((row) =>
        ["pausing", "paused"].includes(stringValue(row, "status")),
      );
      const ids = tree.map((row) => stringValue(row, "run_id"));
      const liveIds = liveRows.map((row) => stringValue(row, "run_id"));
      const placeholders = ids.map(() => "?").join(", ");
      const livePlaceholders = liveIds.map(() => "?").join(", ");
      for (const row of tree) {
        const pauseRequestedAt = optionalString(row, "pause_requested_at");
        if (pauseRequestedAt === null) continue;
        const pausedMs = Math.max(
          0,
          new Date(at).getTime() - new Date(pauseRequestedAt).getTime(),
        );
        const signals = this.options.database.db
          .query(
            `SELECT signal_id, deadline_at
               FROM wait_signals
              WHERE run_id = ? AND status = 'waiting'
                AND deadline_at IS NOT NULL`,
          )
          .all(stringValue(row, "run_id")) as Row[];
        for (const signal of signals) {
          const shifted = new Date(
            new Date(stringValue(signal, "deadline_at")).getTime() + pausedMs,
          ).toISOString();
          this.options.database.db
            .query(
              `UPDATE wait_signals
                  SET deadline_at = ?, updated_at = ?
                WHERE signal_id = ?`,
            )
            .run(shifted, at, stringValue(signal, "signal_id"));
        }
      }
      this.options.database.db
        .query(
          `UPDATE runs
              SET status = 'running',
                  pause_requested_at = NULL, pause_scope_run_id = NULL,
                  paused_at = NULL,
                  runtime_revision = runtime_revision + 1,
                  scheduler_ready_at = ?, updated_at = ?
            WHERE run_id IN (${livePlaceholders})
              AND status IN ('pausing', 'paused')`,
        )
        .run(at, at, ...liveIds);
      this.options.database.db
        .query(
          `UPDATE runs
              SET pause_requested_at = NULL, pause_scope_run_id = NULL,
                  paused_at = NULL
            WHERE run_id IN (${placeholders})
              AND status NOT IN ('pausing', 'paused')`,
        )
        .run(...ids);
      const systemChanges: RuntimeChange[] = [];
      for (const affectedRunId of liveIds) {
        const structural: Array<Record<string, unknown>> = [];
        this.options.driveStaticSubgraphs(
          affectedRunId,
          at,
          structural,
          systemChanges,
        );
      }
      const changes: RuntimeChange[] = [...systemChanges];
      let rootSequence = 0;
      for (const row of liveRows) {
        const affectedRunId = stringValue(row, "run_id");
        const revision = numberValue(
          this.options.runRow(affectedRunId),
          "runtime_revision",
        );
        const sequence = this.options.appendEvent({
          runId: affectedRunId,
          graphId: stringValue(row, "graph_id"),
          nodeId: null,
          type: "run.resumed",
          summary: `Resumed run ${affectedRunId}.`,
          payload: { rootRequestRunId: runId, revision },
          at,
        });
        if (affectedRunId === runId) rootSequence = sequence;
        changes.push({ revision, event: this.options.getEvent(sequence) });
      }
      return { rootSequence, changes };
      },
    );
  }

  cancelRun(
    reference: string,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.options.executeLifecycleMutation(
      "cancel",
      reference,
      idempotencyKey,
      (runId, at) => {
      const target = this.options.runRow(runId);
      const status = GraphStatusSchema.parse(stringValue(target, "status"));
      if (!["running", "pausing", "paused"].includes(status)) {
        throw new BurnGraphError(
          "INVALID_RUN_STATE",
          `Cannot cancel ${runId} from ${status}`,
        );
      }
      const tree = this.options.descendantRunRows(runId).filter(
        (row) =>
          !["completed", "failed", "cancelled"].includes(
            stringValue(row, "status"),
          ),
      );
      const ids = tree.map((row) => stringValue(row, "run_id"));
      const placeholders = ids.map(() => "?").join(", ");
      const liveGates = this.options.database.db
        .query(
          `SELECT execution_id, run_id, node_id, attempt
             FROM check_executions
            WHERE run_id IN (${placeholders}) AND status = 'claimed'
            ORDER BY run_id, node_id`,
        )
        .all(...ids) as Row[];
      const waits = this.options.database.db
        .query(
          `SELECT signal_id
             FROM wait_signals
            WHERE run_id IN (${placeholders}) AND status = 'waiting'`,
        )
        .all(...ids) as Row[];
      this.options.database.db
        .query(
          `UPDATE check_executions
              SET status = 'stale'
            WHERE run_id IN (${placeholders}) AND status = 'claimed'`,
        )
        .run(...ids);
      this.options.database.db
        .query(
          `UPDATE wait_signals
              SET status = 'stale', updated_at = ?
            WHERE run_id IN (${placeholders}) AND status = 'waiting'`,
        )
        .run(at, ...ids);
      this.options.database.db
        .query(
          `DELETE FROM resource_locks
            WHERE owner_kind = 'assignment'
              AND run_id IN (${placeholders})`,
        )
        .run(...ids);
      this.options.database.db
        .query(
          `UPDATE attempts
              SET status = 'cancelled', finished_at = ?
            WHERE run_id IN (${placeholders}) AND finished_at IS NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM check_executions e
                 WHERE e.run_id = attempts.run_id
                   AND e.node_id = attempts.node_id
                   AND e.attempt = attempts.attempt
                   AND e.status = 'stale'
              )`,
        )
        .run(at, ...ids);
      this.options.database.db
        .query(
          `UPDATE node_runs
              SET status = CASE
                    WHEN EXISTS (
                      SELECT 1
                        FROM check_executions e
                       WHERE e.run_id = node_runs.run_id
                         AND e.node_id = node_runs.node_id
                         AND e.attempt = node_runs.attempt
                         AND e.status = 'stale'
                    ) THEN 'running'
                    WHEN status IN
                         ('pending', 'ready', 'running', 'waiting', 'blocked')
                    THEN 'cancelled' ELSE status END,
                  assignment_id = NULL, actor_id = NULL,
                  lease_expires_at = NULL, heartbeat_at = NULL,
                  updated_at = ?
            WHERE run_id IN (${placeholders})`,
        )
        .run(at, ...ids);
      this.options.database.db
        .query(`DELETE FROM actor_focus WHERE run_id IN (${placeholders})`)
        .run(...ids);
      this.options.database.db
        .query(
          `UPDATE runs
              SET status = ?, cancel_requested_at = ?,
                  focused_node_id = NULL, pause_scope_run_id = NULL,
                  runtime_revision = runtime_revision + 1,
                  updated_at = ?
            WHERE run_id IN (${placeholders})`,
        )
        .run(liveGates.length > 0 ? "cancelling" : "cancelled", at, at, ...ids);
      if (liveGates.length === 0) {
        this.options.database.db
          .query(
            `UPDATE subgraph_links
                SET outcome = 'cancelled', updated_at = ?
              WHERE child_run_id IN (${placeholders})`,
          )
          .run(at, ...ids);
      }
      const changes: RuntimeChange[] = [];
      let rootSequence = 0;
      for (const row of tree) {
        const affectedRunId = stringValue(row, "run_id");
        const revision = numberValue(
          this.options.runRow(affectedRunId),
          "runtime_revision",
        );
        const sequence = this.options.appendEvent({
          runId: affectedRunId,
          graphId: stringValue(row, "graph_id"),
          nodeId: null,
          type: liveGates.length > 0 ? "run.cancelling" : "run.cancelled",
          summary:
            liveGates.length > 0
              ? `Run ${affectedRunId} is waiting for ${liveGates.length} stale Gate execution(s).`
              : `Cancelled run ${affectedRunId}.`,
          payload: {
            rootRequestRunId: runId,
            staleGateExecutions: liveGates.map((gate) =>
              stringValue(gate, "execution_id"),
            ),
            staleSignals: waits.map((wait) =>
              stringValue(wait, "signal_id"),
            ),
            revision,
          },
          at,
        });
        if (affectedRunId === runId) rootSequence = sequence;
        changes.push({ revision, event: this.options.getEvent(sequence) });
      }
      if (liveGates.length === 0) {
        changes.push(...this.options.settleAncestors(runId, at));
      }
      return { rootSequence, changes };
      },
    );
  }

  setRunPriority(
    reference: string,
    value: RunPriority,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    const priority = RunPrioritySchema.parse(value);
    const target = this.options.getSnapshot(reference, 0).summary;
    if (target.parentRunId !== null) {
      throw new BurnGraphError(
        "PRIORITY_ROOT_REQUIRED",
        `Run ${target.runId} is not a root Run`,
        false,
        { rootRunId: target.rootRunId },
      );
    }
    return this.options.executeLifecycleMutation(
      `priority:${priority}`,
      reference,
      idempotencyKey,
      (runId, at) => {
        const run = this.options.runRow(runId);
        const status = GraphStatusSchema.parse(stringValue(run, "status"));
        if (
          !["running", "pausing", "paused", "cancelling"].includes(status)
        ) {
          throw new BurnGraphError(
            "INVALID_RUN_STATE",
            `Cannot change priority for ${runId} from ${status}`,
          );
        }
        const previous = RunPrioritySchema.parse(
          stringValue(run, "priority"),
        );
        this.options.database.db
          .query(
            `UPDATE runs
                SET priority = ?, updated_at = ?
              WHERE run_id = ?`,
          )
          .run(priority, at, runId);
        const revision = this.options.bumpRun(runId, at);
        const sequence = this.options.appendEvent({
          runId,
          graphId: stringValue(run, "graph_id"),
          nodeId: null,
          type: "run.priority_changed",
          summary: `Changed ${runId} priority from ${previous} to ${priority}.`,
          payload: { previous, priority, revision },
          at,
        });
        return {
          rootSequence: sequence,
          changes: [{ revision, event: this.options.getEvent(sequence) }],
        };
      },
    );
  }

}
