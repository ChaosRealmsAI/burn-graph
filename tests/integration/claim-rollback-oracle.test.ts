// I0011 permanent Gate. The correction is that an oversized claim rolls back
// inside the transaction, and the only honest Oracle for "rolled back" is the
// persisted database read after the writing process is gone: the previous
// regression asked the same BurnGraphService that performed the claim whether the
// claim had happened, so a service that reported failure while holding committed
// state would still have passed.
//
// The Gate therefore reads .burn/graph/runtime/state.sqlite with a plain
// bun:sqlite handle, from a process that never opened a BurnGraphService, after
// the writer exited. Its first assertion is that a committing double judges red.

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { Database } from "bun:sqlite";

import { createTestDirectory, removeTestProject } from "../helpers/fixtures.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const child = path.join(
  repositoryRoot,
  "tests",
  "helpers",
  "claim-rollback-child.ts",
);
const roots: string[] = [];

interface ChildResult {
  readonly exitCode: number;
  readonly receipt: any;
  readonly stderr: string;
}

interface ClaimNodeRow {
  readonly run_id: string;
  readonly node_id: string;
  readonly status: string;
  readonly attempt: number;
  readonly assignment_id: string | null;
  readonly actor_id: string | null;
  readonly lease_expires_at: string | null;
  readonly heartbeat_at: string | null;
  readonly updated_at: string;
}

interface RunRow {
  readonly run_id: string;
  readonly runtime_revision: number;
  readonly scheduler_ready_at: string | null;
  readonly updated_at: string;
}

interface FocusRow {
  readonly actor_id: string;
  readonly run_id: string;
  readonly node_id: string;
  readonly updated_at: string;
}

function runChild(args: readonly string[]): ChildResult {
  const result = Bun.spawnSync(["bun", child, ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString();
  if (stdout.length === 0) {
    throw new Error(`child produced no receipt: ${stderr}`);
  }
  return {
    exitCode: result.exitCode,
    receipt: JSON.parse(stdout.split("\n").at(-1)!),
    stderr,
  };
}

// The Oracle. Every row the claim would have written is read back from the file
// itself, by table, so a partial commit cannot hide behind an aggregate.
function externalClaimState(
  root: string,
  runId: string,
  nodeId: string,
  actorId: string,
): {
  readonly node: ClaimNodeRow;
  readonly attempts: readonly unknown[];
  readonly claimedEvents: readonly unknown[];
  readonly eventCount: number;
  readonly eventSequence: { readonly seq: number } | null;
  readonly run: RunRow;
  readonly focus: FocusRow | null;
  readonly resourceLocks: readonly unknown[];
} {
  const database = new Database(
    path.join(root, ".burn", "graph", "runtime", "state.sqlite"),
    { readonly: true, strict: true },
  );
  try {
    return {
      node: database
        .query(
          `SELECT run_id, node_id, status, attempt, assignment_id, actor_id,
                  lease_expires_at, heartbeat_at, updated_at
             FROM node_runs WHERE run_id = ? AND node_id = ?`,
        )
        .get(runId, nodeId) as ClaimNodeRow,
      attempts: database
        .query(
          `SELECT run_id, node_id, attempt, status, assignment_id, actor_id,
                  result_json, checkpoint_json, route, started_at, finished_at
             FROM attempts WHERE run_id = ? AND node_id = ? ORDER BY attempt`,
        )
        .all(runId, nodeId) as unknown[],
      claimedEvents: database
        .query(
          `SELECT sequence, run_id, graph_id, node_id, type, summary,
                  payload_json, created_at FROM events
            WHERE run_id = ? AND node_id = ? AND type = 'node.claimed'
            ORDER BY sequence`,
        )
        .all(runId, nodeId) as unknown[],
      eventCount: (
        database
          .query("SELECT COUNT(*) AS count FROM events WHERE run_id = ?")
          .get(runId) as { count: number }
      ).count,
      eventSequence: database
        .query("SELECT seq FROM sqlite_sequence WHERE name = 'events'")
        .get() as { readonly seq: number } | null,
      run: database
        .query(
          `SELECT run_id, runtime_revision, scheduler_ready_at, updated_at
             FROM runs WHERE run_id = ?`,
        )
        .get(runId) as RunRow,
      focus: database
        .query(
          `SELECT actor_id, run_id, node_id, updated_at
             FROM actor_focus WHERE actor_id = ?`,
        )
        .get(actorId) as FocusRow | null,
      resourceLocks: database
        .query(
          `SELECT resource, owner_kind, owner_id, root_run_id, run_id, node_id,
                  expires_at, created_at FROM resource_locks
            WHERE run_id = ? AND node_id = ? ORDER BY resource`,
        )
        .all(runId, nodeId) as unknown[],
    };
  } finally {
    database.close();
  }
}

function prepared(): {
  readonly root: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly actorId: string;
  readonly before: ReturnType<typeof externalClaimState>;
} {
  const root = createTestDirectory();
  roots.push(root);
  const setup = runChild(["--root", root, "--phase", "setup"]);
  expect(setup.exitCode, setup.stderr).toBe(0);
  expect(setup.receipt.ok).toBe(true);
  expect(setup.receipt.blockedCount).toBeGreaterThan(0);
  const { runId, nodeId, actorId } = setup.receipt;
  return {
    root,
    runId,
    nodeId,
    actorId,
    before: externalClaimState(root, runId, nodeId, actorId),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("I0011 external claim rollback Oracle", () => {
  test("judges a committing double red on the persisted database", () => {
    const { root, runId, nodeId, actorId, before } = prepared();

    const attempted = runChild([
      "--root",
      root,
      "--phase",
      "claim",
      "--mode",
      "committing-double",
      "--run",
      runId,
      "--node",
      nodeId,
      "--actor",
      actorId,
    ]);
    // The double reports exactly the failure the guarded implementation reports,
    // so the public result cannot distinguish them.
    expect(attempted.exitCode).toBe(1);
    expect(attempted.receipt.code).toBe("ACTOR_ASSIGNMENT_OUTPUT_LIMIT");

    const after = externalClaimState(root, runId, nodeId, actorId);
    expect(after).not.toEqual(before);
    expect(after.node.status).toBe("running");
    expect(after.node.assignment_id).not.toBeNull();
    expect(after.attempts.length).toBeGreaterThan(before.attempts.length);
    expect(after.claimedEvents.length).toBeGreaterThan(
      before.claimedEvents.length,
    );
    expect(after.eventCount).toBeGreaterThan(before.eventCount);
    expect(after.eventSequence?.seq).toBeGreaterThan(
      before.eventSequence?.seq ?? 0,
    );
    expect(after.run.runtime_revision).toBeGreaterThan(
      before.run.runtime_revision,
    );
    expect(after.focus).toMatchObject({
      actor_id: actorId,
      run_id: runId,
      node_id: nodeId,
    });
    expect(after.resourceLocks.length).toBeGreaterThan(
      before.resourceLocks.length,
    );
  });

  test("leaves nothing committed when the guarded claim exceeds the budget", () => {
    const { root, runId, nodeId, actorId, before } = prepared();

    const attempted = runChild([
      "--root",
      root,
      "--phase",
      "claim",
      "--mode",
      "guarded",
      "--run",
      runId,
      "--node",
      nodeId,
      "--actor",
      actorId,
    ]);
    expect(attempted.exitCode).toBe(1);
    expect(attempted.receipt.code).toBe("ACTOR_ASSIGNMENT_OUTPUT_LIMIT");

    const after = externalClaimState(root, runId, nodeId, actorId);
    // One equality over the whole Oracle, then the named rows, so a future
    // partial rollback fails on the specific row rather than only in aggregate.
    expect(after).toEqual(before);
    expect(after.node.status).toBe("ready");
    expect(after.node.assignment_id).toBeNull();
    expect(after.node.actor_id).toBeNull();
    expect(after.attempts).toEqual([]);
    expect(after.claimedEvents).toEqual([]);
    expect(after.eventCount).toBe(before.eventCount);
    expect(after.eventSequence).toEqual(before.eventSequence);
    expect(after.run).toEqual(before.run);
    expect(after.focus).toEqual(before.focus);
    expect(after.resourceLocks).toEqual([]);
  });
});
