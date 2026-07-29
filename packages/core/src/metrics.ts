import type {
  DurationMetrics,
  ReadyWork,
  RuntimeMetrics,
} from "./contracts.ts";
import {
  numberValue,
  optionalString,
  stringValue,
  type Row,
} from "./sql.ts";
import type { BurnGraphDatabase } from "./storage.ts";

export interface RuntimeMetricsInput {
  readonly database: BurnGraphDatabase;
  readonly runIds: readonly string[];
  readonly scopeRunId: string | null;
  readonly ready: readonly Pick<ReadyWork, "runId" | "eligibility">[];
  readonly now: Date;
}

function durationMetrics(values: readonly number[]): DurationMetrics {
  if (values.length === 0) {
    return {
      count: 0,
      totalMs: 0,
      averageMs: null,
      maximumMs: null,
    };
  }
  const totalMs = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    totalMs,
    averageMs: Math.round(totalMs / values.length),
    maximumMs: Math.max(...values),
  };
}

function elapsed(
  startedAt: string,
  finishedAt: string | null,
  now: Date,
): number {
  const started = new Date(startedAt).getTime();
  const finished =
    finishedAt === null ? now.getTime() : new Date(finishedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

function averageLiveAssignments(
  attempts: readonly Row[],
  now: Date,
): { readonly current: number; readonly maximum: number; readonly average: number } {
  const timeline = attempts.flatMap((attempt) => {
    const started = new Date(stringValue(attempt, "started_at")).getTime();
    const finishedAt = optionalString(attempt, "finished_at");
    return [
      { at: started, delta: 1 },
      ...(finishedAt === null
        ? []
        : [{ at: new Date(finishedAt).getTime(), delta: -1 }]),
    ];
  }).filter((entry) => Number.isFinite(entry.at))
    .sort((left, right) => left.at - right.at || left.delta - right.delta);
  if (timeline.length === 0) {
    return { current: 0, maximum: 0, average: 0 };
  }
  let live = 0;
  let maximum = 0;
  let area = 0;
  let cursor = timeline[0]!.at;
  for (const entry of timeline) {
    area += live * Math.max(0, entry.at - cursor);
    live += entry.delta;
    maximum = Math.max(maximum, live);
    cursor = entry.at;
  }
  const end = Math.max(cursor, now.getTime());
  area += live * (end - cursor);
  const span = Math.max(1, end - timeline[0]!.at);
  return {
    current: live,
    maximum,
    average: Math.round((area / span) * 1_000) / 1_000,
  };
}

export function deriveRuntimeMetrics(
  input: RuntimeMetricsInput,
): RuntimeMetrics {
  const capturedAt = input.now.toISOString();
  if (input.runIds.length === 0) {
    const empty = durationMetrics([]);
    return {
      schemaVersion: 1,
      capturedAt,
      scope: { runId: input.scopeRunId, runCount: 0, rootCount: 0 },
      totals: { nodes: 0, attempts: 0, repairs: 0, leaseRecoveries: 0 },
      assignments: {
        current: 0,
        maximumLive: 0,
        averageLive: 0,
        duration: empty,
      },
      gates: {
        claimed: 0,
        success: 0,
        nonSuccess: 0,
        timeout: 0,
        outputLimit: 0,
        spawnError: 0,
        staleOrExpired: 0,
        duration: empty,
      },
      signals: {
        waiting: 0,
        resolved: 0,
        timedOut: 0,
        stale: 0,
        latency: empty,
      },
      resources: {
        activeLocks: 0,
        contendedReadyNodes: 0,
        contendedResources: 0,
      },
      excludedPrivateFields: [
        "prompts",
        "results",
        "checkOutput",
        "environment",
      ],
      unknownFields: [],
    };
  }

  const placeholders = input.runIds.map(() => "?").join(", ");
  const runs = input.database.db
    .query(
      `SELECT run_id, parent_run_id
         FROM runs
        WHERE run_id IN (${placeholders})`,
    )
    .all(...input.runIds) as Row[];
  const nodeCount = input.database.db
    .query(
      `SELECT COUNT(*) AS count
         FROM node_runs
        WHERE run_id IN (${placeholders})`,
    )
    .get(...input.runIds) as Row;
  const attempts = input.database.db
    .query(
      `SELECT attempt, status, assignment_id, started_at, finished_at
         FROM attempts
        WHERE run_id IN (${placeholders})`,
    )
    .all(...input.runIds) as Row[];
  const repairTraversals = input.database.db
    .query(
      `SELECT COALESCE(SUM(traversals), 0) AS count
         FROM edge_runs
        WHERE run_id IN (${placeholders})
          AND max_traversals IS NOT NULL`,
    )
    .get(...input.runIds) as Row;
  const assignmentAttempts = attempts.filter(
    (attempt) => optionalString(attempt, "assignment_id") !== null,
  );
  const assignmentLive = averageLiveAssignments(
    assignmentAttempts,
    input.now,
  );
  const assignmentDurations = assignmentAttempts.map((attempt) =>
    elapsed(
      stringValue(attempt, "started_at"),
      optionalString(attempt, "finished_at"),
      input.now,
    ),
  );

  const gateRows = input.database.db
    .query(
      `SELECT status, classification, created_at, finished_at
         FROM check_executions
        WHERE run_id IN (${placeholders})`,
    )
    .all(...input.runIds) as Row[];
  const gateCount = (classification: string): number =>
    gateRows.filter(
      (row) => optionalString(row, "classification") === classification,
    ).length;
  const gateDurations = gateRows
    .filter((row) => optionalString(row, "finished_at") !== null)
    .map((row) =>
      elapsed(
        stringValue(row, "created_at"),
        optionalString(row, "finished_at"),
        input.now,
      ),
    );

  const signalRows = input.database.db
    .query(
      `SELECT status, created_at, resolved_at
         FROM wait_signals
        WHERE run_id IN (${placeholders})`,
    )
    .all(...input.runIds) as Row[];
  const signalCount = (status: string): number =>
    signalRows.filter((row) => stringValue(row, "status") === status).length;
  const signalLatency = signalRows
    .filter((row) => optionalString(row, "resolved_at") !== null)
    .map((row) =>
      elapsed(
        stringValue(row, "created_at"),
        optionalString(row, "resolved_at"),
        input.now,
      ),
    );

  const locks = input.database.db
    .query(
      `SELECT resource
         FROM resource_locks
        WHERE run_id IN (${placeholders})`,
    )
    .all(...input.runIds) as Row[];
  const scopedReady = input.ready.filter((candidate) =>
    input.runIds.includes(candidate.runId),
  );
  const contended = scopedReady.filter(
    (candidate) => candidate.eligibility.reason === "RESOURCE_BUSY",
  );
  const contendedResources = new Set(
    contended.flatMap(
      (candidate) => candidate.eligibility.blockedResources,
    ),
  );

  return {
    schemaVersion: 1,
    capturedAt,
    scope: {
      runId: input.scopeRunId,
      runCount: runs.length,
      rootCount: runs.filter(
        (run) => optionalString(run, "parent_run_id") === null,
      ).length,
    },
    totals: {
      nodes: numberValue(nodeCount, "count"),
      attempts: attempts.length,
      repairs: numberValue(repairTraversals, "count"),
      leaseRecoveries: attempts.filter(
        (attempt) => stringValue(attempt, "status") === "expired",
      ).length,
    },
    assignments: {
      current: assignmentLive.current,
      maximumLive: assignmentLive.maximum,
      averageLive: assignmentLive.average,
      duration: durationMetrics(assignmentDurations),
    },
    gates: {
      claimed: gateRows.filter(
        (row) => stringValue(row, "status") === "claimed",
      ).length,
      success: gateCount("success"),
      nonSuccess: gateCount("non_success"),
      timeout: gateCount("timeout"),
      outputLimit: gateCount("output_limit"),
      spawnError: gateCount("spawn_error"),
      staleOrExpired: gateRows.filter((row) =>
        ["stale", "expired"].includes(stringValue(row, "status")),
      ).length,
      duration: durationMetrics(gateDurations),
    },
    signals: {
      waiting: signalCount("waiting"),
      resolved: signalCount("resolved"),
      timedOut: signalCount("timed_out"),
      stale: signalCount("stale"),
      latency: durationMetrics(signalLatency),
    },
    resources: {
      activeLocks: locks.length,
      contendedReadyNodes: contended.length,
      contendedResources: contendedResources.size,
    },
    excludedPrivateFields: [
      "prompts",
      "results",
      "checkOutput",
      "environment",
    ],
    unknownFields: [],
  };
}
