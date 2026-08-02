import { z } from "zod";

import {
  BurnGraphError,
  IdempotencyKeySchema,
  IdentifierSchema,
  type CheckExecutionInspection,
  type CheckExecutionSummary,
  type CompletionInput,
  type GateExecutionClaim,
  type GraphSnapshot,
  type IdempotentMutationResult,
  type MutationResult,
  type ResourceLockSummary,
  type RuntimeChange,
  type SignalResolutionInput,
  type SystemNodeMutation,
  type WaitSignalSummary,
} from "./contracts.ts";
import {
  gateResources,
  gateRoute,
  validateGateExecutionResult,
} from "./gate.ts";
import {
  BurnGraphServiceBase,
} from "./service.ts";
import {
  json,
  numberValue,
  optionalString,
  parseJson,
  stableJson,
  stringValue,
  type Row,
} from "./sql.ts";
import {
  validateSignalResolutionInput,
  waitCompletion,
  waitDeadline,
} from "./wait.ts";

interface SignalReceipt {
  readonly runId: string;
  readonly route: string;
  readonly input: SignalResolutionInput;
  readonly revision: number;
  readonly eventSequence: number;
  readonly changes: readonly {
    readonly revision: number;
    readonly eventSequence: number;
  }[];
}

import { SystemNodeProjection } from "./system-node-projection.ts";

export class BurnGraphService extends BurnGraphServiceBase {
  private readonly systemProjection = new SystemNodeProjection({
    database: this.database,
    now: () => this.now(),
    runRow: (runId) => this.internals.runRow(runId),
    resolveRun: (reference) => this.internals.resolveRun(reference),
    descendantRunRows: (runId) => this.internals.descendantRunRows(runId),
  });

  advanceSystemNodes(
    reference?: string,
  ): SystemNodeMutation<GateExecutionClaim | null> {
    const now = this.now();
    const at = now.toISOString();
    return this.database.immediate(() => {
      const runIds = this.systemProjection.systemRunIds(reference);
      if (runIds.length === 0) return { value: null, changes: [] };

      const expired = this.expiredGateExecution(runIds, at);
      if (expired) {
        return {
          value: null,
          changes: this.expireGateExecution(expired, at),
        };
      }

      const due = this.dueWaitSignal(runIds, at);
      if (due) {
        return {
          value: null,
          changes: this.settleWaitSignal(
            due,
            stringValue(due, "timeout_route"),
            {
              summary: "Wait deadline elapsed.",
              evidence: [],
            },
            "timed_out",
            at,
          ),
        };
      }

      const ready = this.readySystemNodes(runIds);
      const wait = ready.find(
        (candidate) => stringValue(candidate, "node_type") === "wait",
      );
      if (wait) {
        return {
          value: null,
          changes: this.materializeWait(wait, at),
        };
      }
      for (const candidate of ready) {
        const claimed = this.claimGate(candidate, now, at);
        if (claimed) return claimed;
      }
      return { value: null, changes: [] };
    });
  }

  reportGateExecution(
    executionId: string,
    input: unknown,
  ): MutationResult<GraphSnapshot> {
    if (!z.string().uuid().safeParse(executionId).success) {
      throw new BurnGraphError(
        "CHECK_EXECUTION_NOT_FOUND",
        "Execution ID is not a valid handle",
      );
    }
    const execution = this.database.db
      .query("SELECT * FROM check_executions WHERE execution_id = ?")
      .get(executionId) as Row | null;
    if (!execution) {
      throw new BurnGraphError(
        "CHECK_EXECUTION_NOT_FOUND",
        `Unknown Check execution ${executionId}`,
      );
    }
    const executionStatus = stringValue(execution, "status");
    if (
      !["claimed", "stale"].includes(executionStatus) ||
      optionalString(execution, "finished_at") !== null
    ) {
      throw new BurnGraphError(
        "CHECK_EXECUTION_STALE",
        `Check execution ${executionId} is ${executionStatus}`,
      );
    }
    const check = this.internals.loadCheck(
      stringValue(execution, "check_id"),
      numberValue(execution, "check_revision"),
    );
    const result = validateGateExecutionResult(input, check);
    const now = this.now();
    const at = now.toISOString();

    const mutation = this.database.immediate(() => {
      const current = this.database.db
        .query("SELECT * FROM check_executions WHERE execution_id = ?")
        .get(executionId) as Row | null;
      if (
        !current ||
        !["claimed", "stale"].includes(stringValue(current, "status")) ||
        optionalString(current, "finished_at") !== null
      ) {
        throw new BurnGraphError(
          "CHECK_EXECUTION_STALE",
          `Check execution ${executionId} is no longer current`,
        );
      }
      const runId = stringValue(current, "run_id");
      const nodeId = stringValue(current, "node_id");
      const attempt = numberValue(current, "attempt");
      const node = this.internals.nodeRow(runId, nodeId);
      if (
        stringValue(node, "status") !== "running" ||
        numberValue(node, "attempt") !== attempt ||
        optionalString(node, "assignment_id") !== null
      ) {
        throw new BurnGraphError(
          "CHECK_EXECUTION_STALE",
          `Check execution ${executionId} no longer owns ${runId}/${nodeId}`,
        );
      }
      const run = this.internals.runRow(runId);
      if (
        stringValue(current, "status") === "stale" ||
        stringValue(run, "status") === "cancelling"
      ) {
        this.database.db
          .query(
            `UPDATE check_executions
                SET status = 'stale', classification = ?, exit_code = ?,
                    duration_ms = ?, byte_count = ?, digest = ?,
                    stdout_text = ?, stderr_text = ?, finished_at = ?
              WHERE execution_id = ?`,
          )
          .run(
            result.classification,
            result.exitCode,
            result.durationMs,
            result.byteCount,
            result.digest,
            result.stdout,
            result.stderr,
            at,
            executionId,
          );
        this.releaseGateResources(executionId);
        const changes = this.finalizeCancellingTree(runId, at);
        return {
          runId,
          sequence: changes.at(-1)?.event.sequence ?? 0,
          changes,
          stale: true,
        };
      }

      const route = gateRoute(result);
      const blocked = route === null;
      const completion: CompletionInput = {
        summary: blocked
          ? "Gate executable could not be started."
          : `Gate ${result.classification}.`,
        evidence: [],
        route: route ?? undefined,
      };
      this.database.db
        .query(
          `UPDATE check_executions
              SET status = ?, classification = ?, exit_code = ?,
                  duration_ms = ?, byte_count = ?, digest = ?,
                  stdout_text = ?, stderr_text = ?, finished_at = ?
            WHERE execution_id = ?`,
        )
        .run(
          blocked ? "blocked" : "completed",
          result.classification,
          result.exitCode,
          result.durationMs,
          result.byteCount,
          result.digest,
          result.stdout,
          result.stderr,
          at,
          executionId,
        );
      this.releaseGateResources(executionId);
      this.database.db
        .query(
          `UPDATE attempts
              SET status = ?, result_json = ?, route = ?, finished_at = ?
            WHERE run_id = ? AND node_id = ? AND attempt = ?`,
        )
        .run(
          blocked ? "blocked" : "done",
          json(completion),
          route,
          at,
          runId,
          nodeId,
          attempt,
        );
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = ?, route = ?, result_json = ?,
                  last_error = ?, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(
          blocked ? "blocked" : "done",
          route,
          json(completion),
          blocked ? "CHECK_SPAWN_ERROR" : null,
          at,
          runId,
          nodeId,
        );

      const payloadChanges: Array<Record<string, unknown>> = [{
        nodeId,
        status: blocked ? "blocked" : "done",
        attempt,
        route,
      }];
      const childChanges: RuntimeChange[] = [];
      if (!blocked) {
        this.internals.selectDecisionEdge(runId, nodeId, route! , at);
        const graph = this.internals.graphForRun(runId);
        this.internals.cascade(graph, runId, at, payloadChanges);
        this.internals.driveStaticSubgraphs(
          runId,
          at,
          payloadChanges,
          childChanges,
        );
        this.internals.refreshRunTerminalStatus(runId, at);
      }
      const revision = this.internals.bumpRun(runId, at, undefined, null);
      const sequence = this.internals.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: blocked ? "gate.blocked" : "gate.completed",
        summary: completion.summary,
        payload: {
          executionId,
          attempt,
          classification: result.classification,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          byteCount: result.byteCount,
          digest: result.digest,
          route,
          changes: payloadChanges,
          revision,
        },
        at,
      });
      const changes: RuntimeChange[] = [
        ...childChanges,
        { revision, event: this.internals.getEvent(sequence) },
        ...this.internals.settleAncestors(runId, at),
      ];
      return { runId, sequence, changes, stale: false };
    });

    if (mutation.stale) {
      throw new BurnGraphError(
        "CHECK_EXECUTION_STALE",
        `Check execution ${executionId} was cancelled`,
      );
    }
    const quiesced = this.database.immediate(() =>
      this.internals.quiescePauseContainingRun(mutation.runId, at),
    );
    const snapshot = this.getSnapshot(mutation.runId);
    return {
      revision: snapshot.summary.runtimeRevision,
      event: this.internals.getEvent(mutation.sequence),
      value: snapshot,
      changes: [...mutation.changes, ...quiesced],
    };
  }

  // Read-only System Node projections live in SystemNodeProjection.
  listCheckExecutions(reference?: string): readonly CheckExecutionSummary[] {
    return this.systemProjection.listCheckExecutions(reference);
  }

  inspectCheckExecutions(
    reference?: string,
    limit = 100,
    maximumOutputBytes = 4_096,
  ): readonly CheckExecutionInspection[] {
    return this.systemProjection.inspectCheckExecutions(
      reference,
      limit,
      maximumOutputBytes,
    );
  }

  listWaitSignals(reference?: string): readonly WaitSignalSummary[] {
    return this.systemProjection.listWaitSignals(reference);
  }

  listResourceLocks(reference?: string): readonly ResourceLockSummary[] {
    return this.systemProjection.listResourceLocks(reference);
  }

  resolveSignal(
    signalId: string,
    route: string,
    input: unknown,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    const key = IdempotencyKeySchema.parse(idempotencyKey);
    const resolution = validateSignalResolutionInput(input);
    IdentifierSchema.parse(route);
    const at = this.internals.timestamp();

    const outcome = this.database.immediate(() => {
      const keyOwner = this.database.db
        .query(
          `SELECT signal_id
             FROM wait_signals
            WHERE idempotency_key = ?`,
        )
        .get(key) as Row | null;
      if (
        keyOwner &&
        stringValue(keyOwner, "signal_id") !== signalId
      ) {
        throw new BurnGraphError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `Idempotency key ${key} already belongs to another Signal`,
        );
      }
      const row = this.database.db
        .query("SELECT * FROM wait_signals WHERE signal_id = ?")
        .get(signalId) as Row | null;
      if (!row) {
        throw new BurnGraphError(
          "SIGNAL_NOT_FOUND",
          `Unknown Signal ${signalId}`,
        );
      }
      const status = stringValue(row, "status");
      if (status !== "waiting") {
        if (status === "stale") {
          throw new BurnGraphError(
            "SIGNAL_STALE",
            `Signal ${signalId} was cancelled`,
          );
        }
        const stored = parseJson<SignalReceipt>(
          optionalString(row, "resolution_json"),
        );
        if (
          stored &&
          optionalString(row, "idempotency_key") === key &&
          stored.route === route &&
          stableJson(stored.input) === stableJson(resolution)
        ) {
          return { receipt: stored, replayed: true };
        }
        throw new BurnGraphError(
          "SIGNAL_INPUT_CONFLICT",
          `Signal ${signalId} is already ${status}`,
          false,
          { status },
        );
      }
      const routes =
        parseJson<readonly string[]>(stringValue(row, "routes_json")) ?? [];
      if (!routes.includes(route)) {
        throw new BurnGraphError(
          "INVALID_SIGNAL_ROUTE",
          `Signal ${signalId} has no route ${route}`,
          false,
          { routes },
        );
      }
      const run = this.internals.runRow(stringValue(row, "run_id"));
      if (stringValue(run, "status") !== "running") {
        throw new BurnGraphError(
          "RUN_NOT_RUNNING",
          `Run ${stringValue(row, "run_id")} is ${stringValue(run, "status")}`,
          true,
        );
      }
      const changes = this.settleWaitSignal(
        row,
        route,
        resolution,
        "resolved",
        at,
      );
      const rootChange = changes.find(
        (change) => change.event.runId === stringValue(row, "run_id"),
      );
      if (!rootChange) {
        throw new BurnGraphError(
          "CORRUPT_STATE",
          `Signal ${signalId} produced no Run event`,
        );
      }
      const receipt: SignalReceipt = {
        runId: stringValue(row, "run_id"),
        route,
        input: resolution,
        revision: rootChange.revision,
        eventSequence: rootChange.event.sequence,
        changes: changes.map((change) => ({
          revision: change.revision,
          eventSequence: change.event.sequence,
        })),
      };
      this.database.db
        .query(
          `UPDATE wait_signals
              SET idempotency_key = ?, resolution_json = ?
            WHERE signal_id = ?`,
        )
        .run(key, json(receipt), signalId);
      return { receipt, replayed: false };
    });

    return {
      revision: outcome.receipt.revision,
      event: this.internals.getEvent(outcome.receipt.eventSequence),
      value: this.getSnapshot(outcome.receipt.runId),
      changes: outcome.receipt.changes.map((change) => ({
        revision: change.revision,
        event: this.internals.getEvent(change.eventSequence),
      })),
      replayed: outcome.replayed,
    };
  }

  reconcileSystemNodes(
    reference?: string,
  ): SystemNodeMutation<null> {
    const now = this.now();
    const at = now.toISOString();
    return this.database.immediate(() => {
      const runIds = this.systemProjection.systemRunIds(reference);
      const changes: RuntimeChange[] = [];
      while (true) {
        const expired = this.expiredGateExecution(runIds, at);
        if (!expired) break;
        changes.push(...this.expireGateExecution(expired, at));
      }
      while (true) {
        const due = this.dueWaitSignal(runIds, at);
        if (!due) break;
        changes.push(
          ...this.settleWaitSignal(
            due,
            stringValue(due, "timeout_route"),
            { summary: "Wait deadline elapsed.", evidence: [] },
            "timed_out",
            at,
          ),
        );
      }
      return { value: null, changes };
    });
  }

  private expiredGateExecution(
    runIds: readonly string[],
    at: string,
  ): Row | null {
    if (runIds.length === 0) return null;
    const placeholders = runIds.map(() => "?").join(", ");
    return this.database.db
      .query(
        `SELECT e.*
           FROM check_executions e
          WHERE e.run_id IN (${placeholders})
            AND e.status IN ('claimed', 'stale')
            AND e.finished_at IS NULL
            AND e.lease_expires_at <= ?
          ORDER BY e.lease_expires_at, e.execution_id
          LIMIT 1`,
      )
      .get(...runIds, at) as Row | null;
  }

  private dueWaitSignal(
    runIds: readonly string[],
    at: string,
  ): Row | null {
    if (runIds.length === 0) return null;
    const placeholders = runIds.map(() => "?").join(", ");
    return this.database.db
      .query(
        `SELECT s.*
           FROM wait_signals s
           JOIN runs r ON r.run_id = s.run_id
          WHERE s.run_id IN (${placeholders})
            AND r.status = 'running'
            AND s.status = 'waiting'
            AND s.timeout_route IS NOT NULL
            AND s.deadline_at IS NOT NULL
            AND s.deadline_at <= ?
          ORDER BY s.deadline_at, s.signal_id
          LIMIT 1`,
      )
      .get(...runIds, at) as Row | null;
  }

  private readySystemNodes(runIds: readonly string[]): readonly Row[] {
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => "?").join(", ");
    return this.database.db
      .query(
        `SELECT n.*, r.graph_id, r.root_run_id, r.spec_revision
           FROM node_runs n
           JOIN runs r ON r.run_id = n.run_id
          WHERE n.run_id IN (${placeholders})
            AND r.status = 'running'
            AND n.status = 'ready'
            AND n.node_type IN ('wait', 'gate')
          ORDER BY CASE n.node_type WHEN 'wait' THEN 0 ELSE 1 END,
                   n.updated_at, n.run_id, n.node_id
          LIMIT 1_000`,
      )
      .all(...runIds) as Row[];
  }

  private materializeWait(
    row: Row,
    at: string,
  ): readonly RuntimeChange[] {
    const runId = stringValue(row, "run_id");
    const nodeId = stringValue(row, "node_id");
    const run = this.internals.runRow(runId);
    if (
      stringValue(run, "status") !== "running" ||
      stringValue(this.internals.nodeRow(runId, nodeId), "status") !== "ready"
    ) {
      return [];
    }
    const graph = this.internals.graphForRun(runId);
    const node = graph.nodesById.get(nodeId);
    if (!node || node.type !== "wait" || !node.signal) {
      throw new BurnGraphError(
        "CORRUPT_STATE",
        `${runId}/${nodeId} is not a valid Wait`,
      );
    }
    const attempt = numberValue(row, "attempt") + 1;
    const signalId = crypto.randomUUID();
    const deadlineAt = waitDeadline(at, node.signal.timeout?.afterMs);
    this.database.db
      .query(
        `UPDATE node_runs
            SET status = 'waiting', attempt = ?, assignment_id = NULL,
                actor_id = NULL, lease_expires_at = NULL,
                heartbeat_at = NULL, route = NULL, result_json = NULL,
                checkpoint_json = NULL, last_error = NULL, updated_at = ?
          WHERE run_id = ? AND node_id = ?`,
      )
      .run(attempt, at, runId, nodeId);
    this.database.db
      .query(
        `INSERT INTO attempts (
           run_id, node_id, attempt, status, assignment_id, actor_id,
           result_json, checkpoint_json, route, started_at, finished_at
         ) VALUES (?, ?, ?, 'waiting', NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(runId, nodeId, attempt, at);
    this.database.db
      .query(
        `INSERT INTO wait_signals (
           signal_id, run_id, node_id, attempt, status, routes_json,
           timeout_route, deadline_at, resolved_route, summary,
           evidence_json, idempotency_key, resolution_json, created_at,
           resolved_at, updated_at
         ) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, NULL, NULL, NULL,
                   NULL, NULL, ?, NULL, ?)`,
      )
      .run(
        signalId,
        runId,
        nodeId,
        attempt,
        json(node.signal.routes),
        node.signal.timeout?.route ?? null,
        deadlineAt,
        at,
        at,
      );
    const revision = this.internals.bumpRun(runId, at, undefined, null);
    const sequence = this.internals.appendEvent({
      runId,
      graphId: stringValue(run, "graph_id"),
      nodeId,
      type: "wait.created",
      summary: `Waiting for ${node.title}.`,
      payload: {
        signalId,
        attempt,
        routes: node.signal.routes,
        timeoutRoute: node.signal.timeout?.route ?? null,
        deadlineAt,
        revision,
      },
      at,
    });
    return [{ revision, event: this.internals.getEvent(sequence) }];
  }

  private claimGate(
    row: Row,
    now: Date,
    at: string,
  ): SystemNodeMutation<GateExecutionClaim | null> | null {
    const runId = stringValue(row, "run_id");
    const nodeId = stringValue(row, "node_id");
    const run = this.internals.runRow(runId);
    if (
      stringValue(run, "status") !== "running" ||
      stringValue(this.internals.nodeRow(runId, nodeId), "status") !== "ready"
    ) {
      return null;
    }
    const graph = this.internals.graphForRun(runId);
    const node = graph.nodesById.get(nodeId);
    if (!node || node.type !== "gate" || !node.check) {
      throw new BurnGraphError(
        "CORRUPT_STATE",
        `${runId}/${nodeId} is not a valid Gate`,
      );
    }
    const active = this.database.db
      .query(
        `SELECT COUNT(*) AS count
           FROM node_runs
          WHERE run_id = ? AND status = 'running'`,
      )
      .get(runId) as Row;
    if (numberValue(active, "count") >= graph.spec.maxActive) return null;

    const check = this.internals.loadCheck(node.check.id, node.check.revision);
    const resources = gateResources(node.resources ?? [], check.resources);
    if (resources.length > 0) {
      const placeholders = resources.map(() => "?").join(", ");
      const conflict = this.database.db
        .query(
          `SELECT resource, owner_id
             FROM resource_locks
            WHERE resource IN (${placeholders})
            ORDER BY resource
            LIMIT 1`,
        )
        .get(...resources) as Row | null;
      if (conflict) return null;
    }

    const attempt = numberValue(row, "attempt") + 1;
    const executionId = crypto.randomUUID();
    const leaseExpiresAt = new Date(
      now.getTime() + check.timeoutMs + 30_000,
    ).toISOString();
    this.database.db
      .query(
        `UPDATE node_runs
            SET status = 'running', attempt = ?, assignment_id = NULL,
                actor_id = NULL, lease_expires_at = ?,
                heartbeat_at = ?, route = NULL, result_json = NULL,
                checkpoint_json = NULL, last_error = NULL, updated_at = ?
          WHERE run_id = ? AND node_id = ?`,
      )
      .run(attempt, leaseExpiresAt, at, at, runId, nodeId);
    this.database.db
      .query(
        `INSERT INTO attempts (
           run_id, node_id, attempt, status, assignment_id, actor_id,
           result_json, checkpoint_json, route, started_at, finished_at
         ) VALUES (?, ?, ?, 'running', NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(runId, nodeId, attempt, at);
    this.database.db
      .query(
        `INSERT INTO check_executions (
           execution_id, run_id, node_id, attempt, check_id, check_revision,
           status, lease_expires_at, classification, exit_code, duration_ms,
           byte_count, digest, stdout_text, stderr_text, created_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, NULL, NULL, NULL, NULL,
                   NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        executionId,
        runId,
        nodeId,
        attempt,
        check.id,
        check.revision,
        leaseExpiresAt,
        at,
      );
    for (const resource of resources) {
      this.database.db
        .query(
          `INSERT INTO resource_locks (
             resource, owner_kind, owner_id, root_run_id, run_id, node_id,
             expires_at, created_at
           ) VALUES (?, 'gate', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resource,
          executionId,
          stringValue(run, "root_run_id"),
          runId,
          nodeId,
          leaseExpiresAt,
          at,
        );
    }
    const revision = this.internals.bumpRun(runId, at, undefined, null);
    const sequence = this.internals.appendEvent({
      runId,
      graphId: stringValue(run, "graph_id"),
      nodeId,
      type: "gate.claimed",
      summary: `Claimed ${node.title} for registered Check execution.`,
      payload: {
        executionId,
        attempt,
        check: { id: check.id, revision: check.revision },
        resources,
        leaseExpiresAt,
        revision,
      },
      at,
    });
    return {
      value: {
        executionId,
        runId,
        rootRunId: stringValue(run, "root_run_id"),
        nodeId,
        attempt,
        check,
        leaseExpiresAt,
      },
      changes: [{ revision, event: this.internals.getEvent(sequence) }],
    };
  }

  private releaseGateResources(executionId: string): void {
    this.database.db
      .query(
        `DELETE FROM resource_locks
          WHERE owner_kind = 'gate' AND owner_id = ?`,
      )
      .run(executionId);
  }

  private expireGateExecution(
    execution: Row,
    at: string,
  ): readonly RuntimeChange[] {
    const executionId = stringValue(execution, "execution_id");
    const runId = stringValue(execution, "run_id");
    const nodeId = stringValue(execution, "node_id");
    const attempt = numberValue(execution, "attempt");
    this.database.db
      .query(
        `UPDATE check_executions
            SET status = 'expired', finished_at = ?
          WHERE execution_id = ?
            AND status IN ('claimed', 'stale')
            AND finished_at IS NULL`,
      )
      .run(at, executionId);
    this.releaseGateResources(executionId);
    const run = this.internals.runRow(runId);
    if (stringValue(run, "status") === "cancelling") {
      return this.finalizeCancellingTree(runId, at);
    }
    const graph = this.internals.graphForRun(runId);
    const nodeSpec = graph.nodesById.get(nodeId);
    if (!nodeSpec || nodeSpec.type !== "gate") {
      throw new BurnGraphError(
        "CORRUPT_STATE",
        `${runId}/${nodeId} is not a Gate`,
      );
    }
    const retry = attempt < nodeSpec.maxAttempts;
    this.database.db
      .query(
        `UPDATE attempts
            SET status = 'expired', finished_at = ?
          WHERE run_id = ? AND node_id = ? AND attempt = ?`,
      )
      .run(at, runId, nodeId, attempt);
    this.database.db
      .query(
        `UPDATE node_runs
            SET status = ?, lease_expires_at = NULL, heartbeat_at = NULL,
                last_error = 'CHECK_EXECUTION_EXPIRED', updated_at = ?
          WHERE run_id = ? AND node_id = ? AND status = 'running'
            AND attempt = ?`,
      )
      .run(retry ? "ready" : "blocked", at, runId, nodeId, attempt);
    const revision = this.internals.bumpRun(runId, at, undefined, null);
    const sequence = this.internals.appendEvent({
      runId,
      graphId: stringValue(run, "graph_id"),
      nodeId,
      type: retry ? "gate.retry_scheduled" : "gate.blocked",
      summary: retry
        ? "Gate execution lease expired; retry is eligible."
        : "Gate execution lease expired at its attempt limit.",
      payload: { executionId, attempt, retry, revision },
      at,
    });
    return [{ revision, event: this.internals.getEvent(sequence) }];
  }

  private settleWaitSignal(
    signal: Row,
    route: string,
    input: SignalResolutionInput,
    status: "resolved" | "timed_out",
    at: string,
  ): readonly RuntimeChange[] {
    const signalId = stringValue(signal, "signal_id");
    const runId = stringValue(signal, "run_id");
    const nodeId = stringValue(signal, "node_id");
    const attempt = numberValue(signal, "attempt");
    const current = this.database.db
      .query("SELECT status FROM wait_signals WHERE signal_id = ?")
      .get(signalId) as Row | null;
    if (!current || stringValue(current, "status") !== "waiting") return [];
    const graph = this.internals.graphForRun(runId);
    const node = graph.nodesById.get(nodeId);
    if (!node || node.type !== "wait" || !node.signal) {
      throw new BurnGraphError(
        "CORRUPT_STATE",
        `${runId}/${nodeId} is not a Wait`,
      );
    }
    const legalRoutes = [
      ...node.signal.routes,
      ...(node.signal.timeout ? [node.signal.timeout.route] : []),
    ];
    if (!legalRoutes.includes(route)) {
      throw new BurnGraphError(
        "INVALID_SIGNAL_ROUTE",
        `Wait ${nodeId} has no route ${route}`,
        false,
        { routes: legalRoutes },
      );
    }
    const completion = waitCompletion(route, input);
    this.database.db
      .query(
        `UPDATE wait_signals
            SET status = ?, resolved_route = ?, summary = ?,
                evidence_json = ?, resolved_at = ?, updated_at = ?
          WHERE signal_id = ? AND status = 'waiting'`,
      )
      .run(
        status,
        route,
        input.summary,
        json(input.evidence),
        at,
        at,
        signalId,
      );
    this.database.db
      .query(
        `UPDATE attempts
            SET status = 'done', result_json = ?, route = ?, finished_at = ?
          WHERE run_id = ? AND node_id = ? AND attempt = ?`,
      )
      .run(json(completion), route, at, runId, nodeId, attempt);
    this.database.db
      .query(
        `UPDATE node_runs
            SET status = 'done', route = ?, result_json = ?,
                last_error = NULL, updated_at = ?
          WHERE run_id = ? AND node_id = ? AND status = 'waiting'
            AND attempt = ?`,
      )
      .run(route, json(completion), at, runId, nodeId, attempt);
    this.internals.selectDecisionEdge(runId, nodeId, route, at);
    const payloadChanges: Array<Record<string, unknown>> = [{
      nodeId,
      status: "done",
      route,
      attempt,
    }];
    const childChanges: RuntimeChange[] = [];
    this.internals.cascade(graph, runId, at, payloadChanges);
    this.internals.driveStaticSubgraphs(runId, at, payloadChanges, childChanges);
    this.internals.refreshRunTerminalStatus(runId, at);
    const run = this.internals.runRow(runId);
    const revision = this.internals.bumpRun(runId, at, undefined, null);
    const sequence = this.internals.appendEvent({
      runId,
      graphId: stringValue(run, "graph_id"),
      nodeId,
      type: status === "timed_out" ? "wait.timed_out" : "wait.resolved",
      summary: input.summary,
      payload: {
        signalId,
        route,
        evidence: input.evidence,
        changes: payloadChanges,
        revision,
      },
      at,
    });
    return [
      ...childChanges,
      { revision, event: this.internals.getEvent(sequence) },
      ...this.internals.settleAncestors(runId, at),
    ];
  }

  private finalizeCancellingTree(
    runId: string,
    at: string,
  ): readonly RuntimeChange[] {
    let scopeRunId = runId;
    for (;;) {
      const row = this.internals.runRow(scopeRunId);
      const parentRunId = optionalString(row, "parent_run_id");
      if (parentRunId === null) break;
      if (stringValue(this.internals.runRow(parentRunId), "status") !== "cancelling") {
        break;
      }
      scopeRunId = parentRunId;
    }
    const scopeIds = this.internals.descendantRunRows(scopeRunId)
      .filter((row) => stringValue(row, "status") === "cancelling")
      .map((row) => stringValue(row, "run_id"));
    if (scopeIds.length === 0) return [];
    const placeholders = scopeIds.map(() => "?").join(", ");
    const live = this.database.db
      .query(
        `SELECT COUNT(*) AS count
           FROM check_executions e
          WHERE e.run_id IN (${placeholders})
            AND e.status IN ('claimed', 'stale')
            AND e.finished_at IS NULL`,
      )
      .get(...scopeIds) as Row;
    if (numberValue(live, "count") > 0) return [];
    const rows = this.database.db
      .query(
        `SELECT *
           FROM runs
          WHERE run_id IN (${placeholders}) AND status = 'cancelling'
          ORDER BY depth DESC, run_id`,
      )
      .all(...scopeIds) as Row[];
    const changes: RuntimeChange[] = [];
    for (const row of rows) {
      const affectedRunId = stringValue(row, "run_id");
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = CASE
                    WHEN status IN ('pending', 'ready', 'running', 'waiting', 'blocked')
                    THEN 'cancelled' ELSE status END,
                  assignment_id = NULL, actor_id = NULL,
                  lease_expires_at = NULL, heartbeat_at = NULL,
                  updated_at = ?
            WHERE run_id = ?`,
        )
        .run(at, affectedRunId);
      this.database.db
        .query(
          `UPDATE attempts
              SET status = 'cancelled', finished_at = COALESCE(finished_at, ?)
            WHERE run_id = ? AND finished_at IS NULL`,
        )
        .run(at, affectedRunId);
      this.database.db
        .query(
          `UPDATE runs
              SET status = 'cancelled', focused_node_id = NULL,
                  pause_scope_run_id = NULL,
                  runtime_revision = runtime_revision + 1, updated_at = ?
            WHERE run_id = ?`,
        )
        .run(at, affectedRunId);
      this.database.db
        .query(
          `UPDATE subgraph_links
              SET outcome = 'cancelled', updated_at = ?
            WHERE child_run_id = ?`,
        )
        .run(at, affectedRunId);
      const revision = numberValue(
        this.internals.runRow(affectedRunId),
        "runtime_revision",
      );
      const sequence = this.internals.appendEvent({
        runId: affectedRunId,
        graphId: stringValue(row, "graph_id"),
        nodeId: null,
        type: "run.cancelled",
        summary: `Cancelled run ${affectedRunId}.`,
        payload: { scopeRunId, revision },
        at,
      });
      changes.push({ revision, event: this.internals.getEvent(sequence) });
    }
    return [...changes, ...this.internals.settleAncestors(scopeRunId, at)];
  }

}
