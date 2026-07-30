// Read-only projections over System Node runtime state: Check executions, Wait
// signals and resource locks.
//
// Split out of BurnGraphService because these four queries answer "what is the
// system doing" and never change it. The mutation paths beside them — claiming
// Gates, materialising Waits, expiring executions — are a different concern with
// a different failure mode, and they were sharing a 1229-line file.
//
// Five injected dependencies, in the range that has proved worth extracting.

import {
  BurnGraphError,
  type CheckExecutionInspection,
  type CheckExecutionSummary,
  type ResourceLockSummary,
  type WaitSignalSummary,
} from "./contracts.ts";
import {
  numberValue,
  optionalNumber,
  optionalString,
  parseJson,
  stringValue,
  type Row,
} from "./sql.ts";
import { BurnGraphDatabase } from "./storage.ts";

export interface SystemNodeProjectionOptions {
  readonly database: BurnGraphDatabase;
  readonly now: () => Date;
  readonly runRow: (runId: string) => Row;
  readonly resolveRun: (reference: string) => string;
  readonly descendantRunRows: (runId: string) => readonly Row[];
}

export class SystemNodeProjection {
  constructor(private readonly options: SystemNodeProjectionOptions) {}

  listCheckExecutions(reference?: string): readonly CheckExecutionSummary[] {
    const runIds = this.systemRunIds(reference, true);
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => "?").join(", ");
    const rows = this.options.database.db
      .query(
        `SELECT *
           FROM check_executions
          WHERE run_id IN (${placeholders})
          ORDER BY created_at DESC, execution_id`,
      )
      .all(...runIds) as Row[];
    return rows.map((row) => ({
      executionId: stringValue(row, "execution_id"),
      runId: stringValue(row, "run_id"),
      nodeId: stringValue(row, "node_id"),
      attempt: numberValue(row, "attempt"),
      check: {
        id: stringValue(row, "check_id"),
        revision: numberValue(row, "check_revision"),
      },
      status: stringValue(row, "status") as CheckExecutionSummary["status"],
      leaseExpiresAt: stringValue(row, "lease_expires_at"),
      classification: optionalString(
        row,
        "classification",
      ) as CheckExecutionSummary["classification"],
      exitCode: optionalNumber(row, "exit_code"),
      durationMs: optionalNumber(row, "duration_ms"),
      byteCount: optionalNumber(row, "byte_count"),
      digest: optionalString(row, "digest"),
      createdAt: stringValue(row, "created_at"),
      finishedAt: optionalString(row, "finished_at"),
    }));
  }

  inspectCheckExecutions(
    reference?: string,
    limit = 100,
    maximumOutputBytes = 4_096,
  ): readonly CheckExecutionInspection[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BurnGraphError(
        "INVALID_LIMIT",
        "Execution inspection limit must be 1-100",
      );
    }
    if (
      !Number.isInteger(maximumOutputBytes) ||
      maximumOutputBytes < 1 ||
      maximumOutputBytes > 16_384
    ) {
      throw new BurnGraphError(
        "INVALID_LIMIT",
        "Execution output limit must be 1-16384 bytes per row",
      );
    }
    const summaries = this.listCheckExecutions(reference).slice(0, limit);
    return summaries.map((summary) => {
      const row = this.options.database.db
        .query(
          `SELECT stdout_text, stderr_text
             FROM check_executions
            WHERE execution_id = ?`,
        )
        .get(summary.executionId) as Row;
      const stdout = optionalString(row, "stdout_text") ?? "";
      const stderr = optionalString(row, "stderr_text") ?? "";
      const stdoutBytes = Buffer.from(stdout);
      const stderrBytes = Buffer.from(stderr);
      const retainedStdout = stdoutBytes.subarray(0, maximumOutputBytes);
      const remaining = maximumOutputBytes - retainedStdout.byteLength;
      const retainedStderr = stderrBytes.subarray(0, remaining);
      const retainedBytes =
        retainedStdout.byteLength + retainedStderr.byteLength;
      return {
        ...summary,
        output: {
          stdout: retainedStdout.toString(),
          stderr: retainedStderr.toString(),
          retainedBytes,
          truncated:
            stdoutBytes.byteLength + stderrBytes.byteLength > retainedBytes,
        },
      };
    });
  }

  listWaitSignals(reference?: string): readonly WaitSignalSummary[] {
    const runIds = this.systemRunIds(reference, true);
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => "?").join(", ");
    const now = this.options.now().getTime();
    const rows = this.options.database.db
      .query(
        `SELECT *
           FROM wait_signals
          WHERE run_id IN (${placeholders})
          ORDER BY created_at, signal_id`,
      )
      .all(...runIds) as Row[];
    return rows.map((row) => {
      const deadlineAt = optionalString(row, "deadline_at");
      const runStatus = stringValue(
        this.options.runRow(stringValue(row, "run_id")),
        "status",
      );
      return {
        signalId: stringValue(row, "signal_id"),
        runId: stringValue(row, "run_id"),
        nodeId: stringValue(row, "node_id"),
        status: stringValue(row, "status") as WaitSignalSummary["status"],
        routes: parseJson<readonly string[]>(
          stringValue(row, "routes_json"),
        ) ?? [],
        timeoutRoute: optionalString(row, "timeout_route"),
        deadlineAt,
        overdue:
          stringValue(row, "status") === "waiting" &&
          runStatus === "running" &&
          deadlineAt !== null &&
          new Date(deadlineAt).getTime() <= now,
        resolvedRoute: optionalString(row, "resolved_route"),
        summary: optionalString(row, "summary"),
        evidence:
          parseJson<readonly string[]>(optionalString(row, "evidence_json")) ??
          [],
        createdAt: stringValue(row, "created_at"),
        resolvedAt: optionalString(row, "resolved_at"),
      };
    });
  }

  listResourceLocks(reference?: string): readonly ResourceLockSummary[] {
    const runIds = this.systemRunIds(reference, true);
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => "?").join(", ");
    const rows = this.options.database.db
      .query(
        `SELECT *
           FROM resource_locks
          WHERE run_id IN (${placeholders})
          ORDER BY resource`,
      )
      .all(...runIds) as Row[];
    return rows.map((row) => ({
      resource: stringValue(row, "resource"),
      ownerKind: stringValue(
        row,
        "owner_kind",
      ) as ResourceLockSummary["ownerKind"],
      ownerId: stringValue(row, "owner_id"),
      rootRunId: stringValue(row, "root_run_id"),
      runId: stringValue(row, "run_id"),
      nodeId: stringValue(row, "node_id"),
      expiresAt: stringValue(row, "expires_at"),
      createdAt: stringValue(row, "created_at"),
    }));
  }


  systemRunIds(
    reference?: string,
    includeTerminal = false,
  ): readonly string[] {
    if (reference) {
      const runId = this.options.resolveRun(reference);
      return this.options.descendantRunRows(runId).map((row) =>
        stringValue(row, "run_id"),
      );
    }
    const rows = this.options.database.db
      .query(
        includeTerminal
          ? "SELECT run_id FROM runs ORDER BY updated_at DESC, run_id"
          : `SELECT run_id
               FROM runs
              WHERE status IN ('running', 'pausing', 'paused', 'cancelling')
              ORDER BY updated_at, run_id`,
      )
      .all() as Row[];
    return rows.map((row) => stringValue(row, "run_id"));
  }

}
