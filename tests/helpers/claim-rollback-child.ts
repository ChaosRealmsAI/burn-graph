// Purpose: run one oversized claim in a process that then exits, so the I0011
// rollback Oracle can be read from the persisted database by a reader that never
// shared a BurnGraphService, a transaction, or a process with the writer.
//
// Usage:
//   bun tests/helpers/claim-rollback-child.ts --root <dir> --phase setup
//   bun tests/helpers/claim-rollback-child.ts --root <dir> --phase claim \
//     --mode guarded|committing-double --run <id> --node <id> --actor <id>
//
// `committing-double` is the known-bad implementation the Oracle must judge red:
// it performs exactly the writes a claim performs, commits them, and only then
// reports ACTOR_ASSIGNMENT_OUTPUT_LIMIT. Both modes exit 1 with the same public
// error, so nothing but the persisted database can tell them apart — which is the
// whole point of I0011.

import path from "node:path";

import { Database } from "bun:sqlite";

import {
  BurnGraphError,
  BurnGraphService,
  initializeProject,
  type GraphSpec,
  type NodeSpec,
} from "@burn-graph/core";

const OVERSIZED_PROMPT_BYTES = 30_000;
const TASK_COUNT = 8;

function option(name: string): string | undefined {
  const args = Bun.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function required(name: string): string {
  const value = option(name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function prompt(objective: string): NodeSpec["prompt"] {
  return {
    objective,
    instructions: [],
    mustRead: [],
    doneWhen: [],
    outputSchema: null,
    role: "",
    lockedContracts: [],
    writablePaths: [],
    forbidden: [],
    runtime: [],
  };
}

// Every Task owns its own resource, so each granted claim inserts one lock and no
// two Tasks contend. That makes `resource_locks` part of the Oracle instead of an
// always-empty table.
function oversizedGraph(id: string): GraphSpec {
  const tasks: NodeSpec[] = Array.from({ length: TASK_COUNT }, (_, index) => ({
    id: `task-${index}`,
    type: "task",
    title: `Task ${index}`,
    prompt: prompt("x".repeat(OVERSIZED_PROMPT_BYTES)),
    next: [{ to: "join" }],
    maxAttempts: 3,
    actorHint: null,
    tags: [],
    resources: [`resource-${index}`],
  }));
  return {
    schemaVersion: 2,
    id,
    title: "Oversized Actor Assignment aggregate",
    goal: "Exceed the Actor Assignment output budget on the last claim.",
    revision: 1,
    maxActive: TASK_COUNT,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: tasks.map((task) => ({ to: task.id })),
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      ...tasks,
      {
        id: "join",
        type: "join",
        title: "Join",
        prompt: prompt(""),
        next: [{ to: "end" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "end",
        type: "end",
        title: "End",
        prompt: prompt(""),
        next: [],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
    ],
  };
}

function setup(root: string): void {
  initializeProject(root, new Date().toISOString());
  const service = new BurnGraphService(root);
  try {
    const graphId = "claim-rollback-oracle";
    service.applyGraph(oversizedGraph(graphId));
    service.startRun(graphId, `${graphId}:run`);
    const actorId = "rollback-oracle-actor";
    const schedule = service.schedule(actorId, `${graphId}:run`);
    if (schedule.assignmentOutput.blocked.length === 0) {
      throw new Error(
        "fixture did not exhaust the Actor Assignment output budget",
      );
    }
    const blocked = schedule.assignmentOutput.blocked[0]!;
    emit({
      ok: true,
      phase: "setup",
      graphId,
      runId: blocked.runId,
      nodeId: blocked.nodeId,
      actorId,
      grantedAssignments: schedule.assignments.length,
      blockedCount: schedule.assignmentOutput.blockedCount,
    });
  } finally {
    service.close();
  }
}

// The known-bad double. It repeats the claim's persistent writes, commits them,
// and then reports the output-limit failure — the pre-I0011 ordering, where a
// mutation told the caller it failed after the state transition had landed.
function commitThenFail(
  root: string,
  runId: string,
  nodeId: string,
  actorId: string,
): never {
  const file = path.join(
    root,
    ".burn-graph",
    "runtime",
    "state.sqlite",
  );
  const database = new Database(file, { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    const at = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    const assignmentId = crypto.randomUUID();
    const run = database
      .query("SELECT graph_id, root_run_id FROM runs WHERE run_id = ?")
      .get(runId) as { graph_id: string; root_run_id: string };
    const node = database
      .query(
        "SELECT attempt, title FROM node_runs WHERE run_id = ? AND node_id = ?",
      )
      .get(runId, nodeId) as { attempt: number; title: string };
    const attempt = node.attempt + 1;
    database.exec("BEGIN IMMEDIATE;");
    database
      .query(
        `UPDATE node_runs
            SET status = 'running', attempt = ?, assignment_id = ?, actor_id = ?,
                lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
          WHERE run_id = ? AND node_id = ?`,
      )
      .run(attempt, assignmentId, actorId, expiresAt, at, at, runId, nodeId);
    database
      .query(
        `INSERT INTO attempts (
           run_id, node_id, attempt, status, assignment_id, actor_id, result_json,
           checkpoint_json, route, started_at, finished_at
         ) VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(runId, nodeId, attempt, assignmentId, actorId, at);
    database
      .query(
        `INSERT INTO resource_locks (
           resource, owner_kind, owner_id, root_run_id, run_id, node_id,
           expires_at, created_at
         ) VALUES (?, 'assignment', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `resource-${nodeId.replace("task-", "")}`,
        assignmentId,
        run.root_run_id,
        runId,
        nodeId,
        expiresAt,
        at,
      );
    database
      .query(
        `INSERT INTO actor_focus (actor_id, run_id, node_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(actor_id) DO UPDATE SET
           run_id = excluded.run_id,
           node_id = excluded.node_id,
           updated_at = excluded.updated_at`,
      )
      .run(actorId, runId, nodeId, at);
    database
      .query(
        `UPDATE runs
            SET runtime_revision = runtime_revision + 1,
                scheduler_ready_at = ?, updated_at = ?
          WHERE run_id = ?`,
      )
      .run(at, at, runId);
    database
      .query(
        `INSERT INTO events (
           run_id, graph_id, node_id, type, summary, payload_json, created_at
         ) VALUES (?, ?, ?, 'node.claimed', ?, ?, ?)`,
      )
      .run(
        runId,
        run.graph_id,
        nodeId,
        `${actorId} claimed ${node.title}.`,
        JSON.stringify({ actorId, attempt, assignmentId }),
        at,
      );
    database.exec("COMMIT;");
  } finally {
    database.close();
  }
  throw new BurnGraphError(
    "ACTOR_ASSIGNMENT_OUTPUT_LIMIT",
    `Claiming ${runId}/${nodeId} would exceed the Actor Assignment output limit`,
    true,
  );
}

function claim(
  root: string,
  mode: string,
  runId: string,
  nodeId: string,
  actorId: string,
): void {
  if (mode === "committing-double") {
    commitThenFail(root, runId, nodeId, actorId);
  }
  const service = new BurnGraphService(root);
  try {
    service.claim(runId, nodeId, actorId);
  } finally {
    service.close();
  }
}

const root = required("root");
const phase = required("phase");

try {
  if (phase === "setup") {
    setup(root);
  } else if (phase === "claim") {
    claim(
      root,
      required("mode"),
      required("run"),
      required("node"),
      required("actor"),
    );
    // Reaching here means the oversized claim was granted, which is a different
    // failure from the one under test and must never look like success.
    emit({ ok: true, phase: "claim", granted: true });
    process.exitCode = 1;
  } else {
    throw new Error(`unknown phase ${phase}`);
  }
} catch (error) {
  emit({
    ok: false,
    phase,
    code: error instanceof BurnGraphError ? error.code : "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
