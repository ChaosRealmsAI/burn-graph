// The runtime substrate: row access, event append, snapshot assembly, subgraph
// normalisation, cascade, loop reset and resource release.
//
// Forty-seven helpers every public group leans on. They were 1872 lines — 44% of
// service.ts — sitting under the API they serve, which is why the claim and
// Assignment groups each appeared to depend on thirty separate service members.
// They depend on one thing: this.
//
// Measured before extracting: the layer makes exactly two calls back up, both to
// snapshot reads already delegated to RunProjection. It is acyclic, so it can be
// a collaborator rather than a base class.

import { z } from "zod";

import {
  BurnGraphError,
  DynamicSubgraphOutputSchema,
  GraphStatusSchema,
  IdempotencyKeySchema,
  IdentifierSchema,
  NodeStatusSchema,
  type AssignmentPacket,
  type CheckSpec,
  type CheckpointInput,
  type ChildRunDescriptor,
  type CompletionInput,
  type GraphCounts,
  type GraphEvent,
  type GraphSnapshot,
  type GraphSpec,
  type GraphStatus,
  type GraphSummary,
  type IdempotentMutationResult,
  type MutationResult,
  type ProjectConfig,
  type ReadyWork,
  type RunPriority,
  type RuntimeChange,
  type RuntimeEdge,
  type RuntimeNode,
  type WorkSchedule,
} from "./contracts.ts";
import { gateResources, validateCheckSpec } from "./gate.ts";
import { GraphAuthoring } from "./service-authoring.ts";
import { RunLifecycle } from "./service-lifecycle.ts";
import { RunProjection } from "./service-projection.ts";
import { deriveRuntimeMetrics } from "./metrics.ts";
import { renderMermaid, renderTreeMermaid } from "./mermaid.ts";
import {
} from "./project.ts";
import {
  json,
  numberValue,
  optionalNumber,
  optionalString,
  parseJson,
  stableJson,
  stringValue,
  type Row,
} from "./sql.ts";
import {
} from "./scheduler.ts";
import { BurnGraphDatabase } from "./storage.ts";
import {
} from "./template-service.ts";
import {
  loopBodyNodeIds,
  validateGraphSpec,
  type GraphEdgeRef,
  type ValidatedGraph,
} from "./validator.ts";

const MAX_SCHEDULE_READY_PREVIEW = 32;
const MAX_SCHEDULE_RUN_SUMMARIES = 8;
const MAX_TREE_PROJECTION_RUNS = 10_000;

interface AssignmentIdentity {
  readonly assignmentId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly actorId: string;
  readonly status: string;
  readonly result: CompletionInput | null;
}

interface AssignmentExpectation {
  readonly assignmentId: string;
  readonly attempt: number;
}

type LifecycleOperation =
  | "pause"
  | "resume"
  | "cancel"
  | `priority:${RunPriority}`;

type ResumeContinuation = WorkSchedule & {
  readonly resumed: GraphSummary;
  readonly replayed: boolean;
};

interface LifecycleReceipt {
  readonly runId: string;
  readonly rootSequence: number;
  readonly rootRevision: number;
  readonly snapshot?: GraphSnapshot;
  readonly changes: readonly {
    readonly revision: number;
    readonly eventSequence: number;
  }[];
}

type NormalizedChildDescriptor = ChildRunDescriptor & {
  readonly runId: string;
};

function runIdFor(graphId: string, now: Date): string {
  return `${graphId}:run:${now.getTime().toString(36)}:${crypto
    .randomUUID()
    .slice(0, 8)}`;
}

function leaseTime(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

function validateLeaseSeconds(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86_400) {
    throw new BurnGraphError(
      "INVALID_LEASE",
      "Lease must be an integer between 30 and 86400 seconds",
    );
  }
  return seconds;
}

function isExpired(value: string | null, now: Date): boolean {
  return value !== null && new Date(value).getTime() <= now.getTime();
}

function isAssignableNode(
  node: GraphSpec["nodes"][number],
): node is GraphSpec["nodes"][number] & {
  readonly type: "task" | "decision" | "subgraph";
} {
  return (
    node.type === "task" ||
    node.type === "decision" ||
    (node.type === "subgraph" && node.mode === "dynamic")
  );
}

function resourceEligibility(
  resources: readonly string[],
  lockedResources: ReadonlySet<string>,
): ReadyWork["eligibility"] {
  const blockedResources = resources.filter((resource) =>
    lockedResources.has(resource)
  );
  return {
    eligible: blockedResources.length === 0,
    reason: blockedResources.length === 0 ? null : "RESOURCE_BUSY",
    blockedResources,
  };
}


export interface RuntimeInternalsOptions {
  readonly config: ProjectConfig;
  readonly database: BurnGraphDatabase;
  readonly now: () => Date;
  readonly authoring: GraphAuthoring;
  readonly getSnapshot: (reference: string, eventLimit?: number) => GraphSnapshot;
  readonly readSnapshot: (reference: string, eventLimit: number) => GraphSnapshot;
}

export class RuntimeInternals {
  constructor(private readonly options: RuntimeInternalsOptions) {}

  timestamp(): string {
    return this.options.now().toISOString();
  }

  executeLifecycleMutation(
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
  ): IdempotentMutationResult<GraphSnapshot> {
    const key = IdempotencyKeySchema.parse(idempotencyKey);
    if (reference.length === 0 || reference.length > 128) {
      throw new BurnGraphError(
        "INVALID_RUN_REFERENCE",
        "Run reference must contain 1-128 characters",
      );
    }
    const at = this.timestamp();
    const outcome = this.options.database.immediate(() => {
      const existing = this.options.database.db
        .query(
          `SELECT operation, request_reference, result_json
             FROM lifecycle_requests
            WHERE idempotency_key = ?`,
        )
        .get(key) as Row | null;
      if (existing) {
        const storedOperation = stringValue(existing, "operation");
        const storedReference = stringValue(existing, "request_reference");
        if (
          storedOperation !== operation ||
          storedReference !== reference
        ) {
          throw new BurnGraphError(
            "IDEMPOTENCY_KEY_CONFLICT",
            `Idempotency key ${key} already owns another lifecycle request`,
            false,
            {
              operation: storedOperation,
              requestReference: storedReference,
            },
          );
        }
        let receipt: LifecycleReceipt;
        try {
          receipt = JSON.parse(
            stringValue(existing, "result_json"),
          ) as LifecycleReceipt;
        } catch {
          throw new BurnGraphError(
            "CORRUPT_STATE",
            `Lifecycle receipt ${key} is invalid`,
          );
        }
        return { receipt, replayed: true };
      }

      const runId = this.resolveRun(reference);
      const mutation = mutate(runId, at);
      const rootChange = mutation.changes.find(
        (change) => change.event.sequence === mutation.rootSequence,
      );
      if (!rootChange) {
        throw new BurnGraphError(
          "CORRUPT_STATE",
          `Lifecycle ${operation} did not produce a root change`,
        );
      }
      const receipt: LifecycleReceipt = {
        runId,
        rootSequence: mutation.rootSequence,
        rootRevision: rootChange.revision,
        snapshot: this.options.readSnapshot(runId, 100),
        changes: mutation.changes.map((change) => ({
          revision: change.revision,
          eventSequence: change.event.sequence,
        })),
      };
      this.options.database.db
        .query(
          `INSERT INTO lifecycle_requests (
             idempotency_key, operation, request_reference, target_run_id,
             result_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(key, operation, reference, runId, json(receipt), at);
      return { receipt, replayed: false };
    });

    return {
      revision: outcome.receipt.rootRevision,
      event: this.getEvent(outcome.receipt.rootSequence),
      value:
        outcome.receipt.snapshot ??
        this.options.getSnapshot(outcome.receipt.runId),
      changes: outcome.receipt.changes.map((change) => ({
        revision: change.revision,
        event: this.getEvent(change.eventSequence),
      })),
      replayed: outcome.replayed,
    };
  }

  loadGraph(graphId: string, revision?: number): ValidatedGraph {
    IdentifierSchema.parse(graphId);
    let row: Row | null;
    if (revision === undefined) {
      row = this.options.database.db
        .query(
          `SELECT document_json
             FROM graph_specs
            WHERE graph_id = ?
            ORDER BY revision DESC
            LIMIT 1`,
        )
        .get(graphId) as Row | null;
    } else {
      row = this.options.database.db
        .query(
          `SELECT document_json
             FROM graph_specs
            WHERE graph_id = ? AND revision = ?`,
        )
        .get(graphId, revision) as Row | null;
    }
    if (!row) {
      throw new BurnGraphError("GRAPH_NOT_FOUND", `Unknown graph ${graphId}`);
    }
    return validateGraphSpec(JSON.parse(stringValue(row, "document_json")));
  }

  loadCheck(checkId: string, revision?: number): CheckSpec {
    IdentifierSchema.parse(checkId);
    let row: Row | null;
    if (revision === undefined) {
      row = this.options.database.db
        .query(
          `SELECT document_json
             FROM check_specs
            WHERE check_id = ?
            ORDER BY revision DESC
            LIMIT 1`,
        )
        .get(checkId) as Row | null;
    } else {
      row = this.options.database.db
        .query(
          `SELECT document_json
             FROM check_specs
            WHERE check_id = ? AND revision = ?`,
        )
        .get(checkId, revision) as Row | null;
    }
    if (!row) {
      throw new BurnGraphError(
        "CHECK_NOT_FOUND",
        `Unknown Check ${checkId}${revision === undefined ? "" : `@${revision}`}`,
      );
    }
    return validateCheckSpec(JSON.parse(stringValue(row, "document_json")));
  }

  graphForRun(runId: string): ValidatedGraph {
    const row = this.runRow(runId);
    return this.loadGraph(
      stringValue(row, "graph_id"),
      numberValue(row, "spec_revision"),
    );
  }

  tryResolveRun(reference: string): string | null {
    const exact = this.options.database.db
      .query("SELECT run_id FROM runs WHERE run_id = ?")
      .get(reference) as Row | null;
    if (exact) return stringValue(exact, "run_id");
    const graph = this.options.database.db
      .query(
        `SELECT run_id
           FROM runs
          WHERE graph_id = ?
          ORDER BY CASE
                     WHEN status IN
                          ('running', 'pausing', 'paused', 'cancelling')
                     THEN 0 ELSE 1
                   END,
                   updated_at DESC
          LIMIT 1`,
      )
      .get(reference) as Row | null;
    return graph ? stringValue(graph, "run_id") : null;
  }

  resolveRun(reference: string): string {
    const runId = this.tryResolveRun(reference);
    if (!runId) {
      throw new BurnGraphError("RUN_NOT_FOUND", `Unknown run or graph ${reference}`);
    }
    return runId;
  }

  runRow(runId: string): Row {
    const row = this.options.database.db
      .query("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as Row | null;
    if (!row) throw new BurnGraphError("RUN_NOT_FOUND", `Unknown run ${runId}`);
    return row;
  }

  descendantRunRows(runId: string): readonly Row[] {
    return this.options.database.db
      .query(
        `WITH RECURSIVE tree(run_id) AS (
           SELECT ?
           UNION ALL
           SELECT r.run_id
             FROM runs r
             JOIN tree ON r.parent_run_id = tree.run_id
         )
         SELECT r.*
           FROM runs r
           JOIN tree ON tree.run_id = r.run_id
          ORDER BY r.depth DESC, r.run_id`,
      )
      .all(runId) as Row[];
  }

  quiescePauseContainingRun(
    runId: string,
    at: string,
  ): readonly RuntimeChange[] {
    const pauseScopeRunId = optionalString(
      this.runRow(runId),
      "pause_scope_run_id",
    );
    if (pauseScopeRunId === null) return [];
    const pausing = this.options.database.db
      .query(
        `SELECT *
           FROM runs
          WHERE pause_scope_run_id = ? AND status = 'pausing'
          ORDER BY depth DESC, run_id`,
      )
      .all(pauseScopeRunId) as Row[];
    if (pausing.length === 0) return [];
    const live = this.options.database.db
      .query(
        `SELECT
           (SELECT COUNT(*)
              FROM node_runs n
              JOIN runs r ON r.run_id = n.run_id
             WHERE r.pause_scope_run_id = ?
               AND r.status = 'pausing'
               AND n.status = 'running'
               AND n.assignment_id IS NOT NULL) +
           (SELECT COUNT(*)
              FROM check_executions e
              JOIN runs r ON r.run_id = e.run_id
             WHERE r.pause_scope_run_id = ?
               AND r.status = 'pausing'
               AND e.status = 'claimed') AS count`,
      )
      .get(pauseScopeRunId, pauseScopeRunId) as Row;
    if (numberValue(live, "count") > 0) return [];

    this.options.database.db
      .query(
        `UPDATE runs
            SET status = 'paused', paused_at = ?,
                runtime_revision = runtime_revision + 1,
                updated_at = ?
          WHERE pause_scope_run_id = ? AND status = 'pausing'`,
      )
      .run(at, at, pauseScopeRunId);
    return pausing.map((row) => {
      const affectedRunId = stringValue(row, "run_id");
      const revision = numberValue(
        this.runRow(affectedRunId),
        "runtime_revision",
      );
      const sequence = this.appendEvent({
        runId: affectedRunId,
        graphId: stringValue(row, "graph_id"),
        nodeId: null,
        type: "run.paused",
        summary: `Paused run ${affectedRunId} after quiescing.`,
        payload: { pauseScopeRunId, revision },
        at,
      });
      return { revision, event: this.getEvent(sequence) };
    });
  }

  nodeRow(runId: string, nodeId: string): Row {
    const row = this.options.database.db
      .query(
        `SELECT *
           FROM node_runs
          WHERE run_id = ? AND node_id = ?`,
      )
      .get(runId, nodeId) as Row | null;
    if (!row) {
      throw new BurnGraphError(
        "NODE_NOT_FOUND",
        `Unknown node ${nodeId} in ${runId}`,
      );
    }
    return row;
  }

  edgeRowsFrom(runId: string, nodeId: string): Row[] {
    return this.options.database.db
      .query(
        `SELECT *
           FROM edge_runs
          WHERE run_id = ? AND from_node_id = ?
          ORDER BY edge_id`,
      )
      .all(runId, nodeId) as Row[];
  }

  insertEdge(runId: string, edge: GraphEdgeRef, at: string): void {
    this.options.database.db
      .query(
        `INSERT INTO edge_runs (
           run_id, edge_id, from_node_id, to_node_id, route, label,
           max_traversals, traversals, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)`,
      )
      .run(
        runId,
        edge.id,
        edge.from,
        edge.to,
        edge.route,
        edge.label,
        edge.maxTraversals,
        at,
      );
  }

  nodesForRun(runId: string, spec: GraphSpec): readonly RuntimeNode[] {
    const rows = this.options.database.db
      .query("SELECT * FROM node_runs WHERE run_id = ?")
      .all(runId) as Row[];
    const byId = new Map(rows.map((row) => [stringValue(row, "node_id"), row]));
    return spec.nodes.map((node) => {
      const row = byId.get(node.id);
      if (!row) {
        throw new BurnGraphError(
          "CORRUPT_STATE",
          `Runtime is missing node ${node.id}`,
        );
      }
      return this.runtimeNode(row);
    });
  }

  edgesForRun(runId: string): readonly RuntimeEdge[] {
    return (
      this.options.database.db
        .query("SELECT * FROM edge_runs WHERE run_id = ? ORDER BY edge_id")
        .all(runId) as Row[]
    ).map((row) => ({
      id: stringValue(row, "edge_id"),
      from: stringValue(row, "from_node_id"),
      to: stringValue(row, "to_node_id"),
      route: optionalString(row, "route"),
      label: optionalString(row, "label"),
      maxTraversals: optionalNumber(row, "max_traversals"),
      traversals: numberValue(row, "traversals"),
      status: edgeStatus(row),
      updatedAt: stringValue(row, "updated_at"),
    }));
  }

  runtimeNode(row: Row): RuntimeNode {
    return {
      id: stringValue(row, "node_id"),
      type: stringValue(row, "node_type") as RuntimeNode["type"],
      title: stringValue(row, "title"),
      status: NodeStatusSchema.parse(stringValue(row, "status")),
      attempt: numberValue(row, "attempt"),
      assignmentId: optionalString(row, "assignment_id"),
      actorId: optionalString(row, "actor_id"),
      leaseExpiresAt: optionalString(row, "lease_expires_at"),
      route: optionalString(row, "route"),
      result: parseJson<CompletionInput>(optionalString(row, "result_json")),
      checkpoint: parseJson<CheckpointInput>(
        optionalString(row, "checkpoint_json"),
      ),
      lastError: optionalString(row, "last_error"),
      updatedAt: stringValue(row, "updated_at"),
    };
  }

  summaryForRun(runId: string): GraphSummary {
    const row = this.runRow(runId);
    const graphId = stringValue(row, "graph_id");
    const spec = this.loadGraph(
      graphId,
      numberValue(row, "spec_revision"),
    ).spec;
    const countRows = this.options.database.db
      .query(
        `SELECT status, COUNT(*) AS count
           FROM node_runs
          WHERE run_id = ?
          GROUP BY status`,
      )
      .all(runId) as Row[];
    const counts: { -readonly [Key in keyof GraphCounts]: GraphCounts[Key] } = {
      total: spec.nodes.length,
      pending: 0,
      ready: 0,
      running: 0,
      waiting: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
    };
    for (const countRow of countRows) {
      const status = NodeStatusSchema.parse(stringValue(countRow, "status"));
      counts[status] = numberValue(countRow, "count");
    }
    const focusedNodeId = optionalString(row, "focused_node_id");
    const focused = focusedNodeId
      ? spec.nodes.find((node) => node.id === focusedNodeId)
      : undefined;
    const priority = stringValue(row, "priority");
    if (!["low", "normal", "high"].includes(priority)) {
      throw new BurnGraphError(
        "CORRUPT_STATE",
        `Run ${runId} has invalid priority ${priority}`,
      );
    }
    return {
      runId,
      graphId,
      title: spec.title,
      goal: spec.goal,
      specRevision: numberValue(row, "spec_revision"),
      runtimeRevision: numberValue(row, "runtime_revision"),
      status: GraphStatusSchema.parse(stringValue(row, "status")),
      maxActive: spec.maxActive,
      parentRunId: optionalString(row, "parent_run_id"),
      parentNodeId: optionalString(row, "parent_node_id"),
      rootRunId: stringValue(row, "root_run_id"),
      depth: numberValue(row, "depth"),
      priority: priority as GraphSummary["priority"],
      focusedNodeId,
      focusedNodeTitle: focused?.title ?? null,
      counts,
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
    };
  }

  assignmentIdentity(assignmentId: string): AssignmentIdentity {
    if (!z.string().uuid().safeParse(assignmentId).success) {
      throw new BurnGraphError(
        "ASSIGNMENT_NOT_FOUND",
        "Assignment ID is not a valid handle",
      );
    }
    const row = this.options.database.db
      .query(
        `SELECT assignment_id, run_id, node_id, attempt, actor_id, status,
                result_json
           FROM attempts
          WHERE assignment_id = ?`,
      )
      .get(assignmentId) as Row | null;
    if (!row) {
      throw new BurnGraphError(
        "ASSIGNMENT_NOT_FOUND",
        `Unknown Assignment ${assignmentId}`,
      );
    }
    return {
      assignmentId: stringValue(row, "assignment_id"),
      runId: stringValue(row, "run_id"),
      nodeId: stringValue(row, "node_id"),
      attempt: numberValue(row, "attempt"),
      actorId: stringValue(row, "actor_id"),
      status: stringValue(row, "status"),
      result: parseJson<CompletionInput>(optionalString(row, "result_json")),
    };
  }

  requireMatchingReplay(
    identity: AssignmentIdentity,
    completion: CompletionInput,
  ): void {
    let candidate = completion;
    const node = this.graphForRun(identity.runId).nodesById.get(
      identity.nodeId,
    );
    if (
      node?.type === "subgraph" &&
      node.mode === "dynamic" &&
      identity.result !== null
    ) {
      const storedOutput = DynamicSubgraphOutputSchema.safeParse(
        identity.result.output,
      );
      const replayOutput = DynamicSubgraphOutputSchema.safeParse(
        completion.output,
      );
      if (
        storedOutput.success &&
        replayOutput.success &&
        storedOutput.data.children.length === replayOutput.data.children.length
      ) {
        candidate = {
          ...completion,
          output: {
            children: replayOutput.data.children.map((child, index) => ({
              ...child,
              runId:
                child.runId ?? storedOutput.data.children[index]?.runId,
            })),
          },
        };
      }
    }
    if (
      identity.result === null ||
      stableJson(identity.result) !== stableJson(candidate)
    ) {
      throw new BurnGraphError(
        "ASSIGNMENT_INPUT_CONFLICT",
        `Assignment ${identity.assignmentId} was already completed with different input`,
        false,
        { runId: identity.runId, nodeId: identity.nodeId },
      );
    }
  }

  scheduleState(
    assignments: readonly AssignmentPacket[],
    runs: readonly GraphSummary[],
  ): WorkSchedule["state"] {
    if (assignments.length > 0) return "assigned";
    if (runs.length === 0) return "waiting";
    if (
      runs.some(
        (run) =>
          run.status === "running" ||
          run.status === "pausing" ||
          run.status === "paused" ||
          run.status === "cancelling",
      )
    ) {
      const active = runs.filter(
        (run) =>
          run.status === "running" ||
          run.status === "pausing" ||
          run.status === "paused" ||
          run.status === "cancelling",
      );
      return active.some(
        (run) =>
          run.counts.blocked > 0 &&
          run.counts.ready === 0 &&
          run.counts.running === 0,
      )
        ? "blocked"
        : "waiting";
    }
    return runs.every(
      (run) => run.status === "completed" || run.status === "cancelled",
    )
      ? "completed"
      : "blocked";
  }

  requireOwnedRunningNode(
    runId: string,
    nodeId: string,
    actorId: string,
    now: Date,
    expectation?: AssignmentExpectation,
  ): Row {
    IdentifierSchema.parse(actorId);
    const row = this.nodeRow(runId, nodeId);
    if (stringValue(row, "status") !== "running") {
      throw new BurnGraphError(
        "NODE_NOT_RUNNING",
        `Node ${nodeId} is ${stringValue(row, "status")}`,
      );
    }
    if (optionalString(row, "actor_id") !== actorId) {
      throw new BurnGraphError(
        "NOT_NODE_OWNER",
        `${actorId} does not own ${nodeId}`,
      );
    }
    if (
      expectation !== undefined &&
      (optionalString(row, "assignment_id") !== expectation.assignmentId ||
        numberValue(row, "attempt") !== expectation.attempt)
    ) {
      throw new BurnGraphError(
        "ASSIGNMENT_STALE",
        `Assignment ${expectation.assignmentId} is no longer active`,
        false,
        {
          expectedAttempt: expectation.attempt,
          currentAttempt: numberValue(row, "attempt"),
        },
      );
    }
    if (isExpired(optionalString(row, "lease_expires_at"), now)) {
      throw new BurnGraphError(
        "LEASE_EXPIRED",
        `Claim for ${nodeId} has expired`,
        true,
      );
    }
    return row;
  }

  takeAllForwardEdges(runId: string, nodeId: string, at: string): void {
    this.options.database.db
      .query(
        `UPDATE edge_runs
            SET status = 'taken', updated_at = ?
          WHERE run_id = ? AND from_node_id = ? AND max_traversals IS NULL`,
      )
      .run(at, runId, nodeId);
  }

  selectDecisionEdge(
    runId: string,
    nodeId: string,
    route: string,
    at: string,
  ): void {
    this.options.database.db
      .query(
        `UPDATE edge_runs
            SET status = CASE WHEN route = ? THEN 'taken' ELSE 'disabled' END,
                updated_at = ?
          WHERE run_id = ? AND from_node_id = ?`,
      )
      .run(route, at, runId, nodeId);
  }

  ancestorGraphIds(runId: string): ReadonlySet<string> {
    const graphIds = new Set<string>();
    let current: string | null = runId;
    while (current !== null) {
      const row = this.runRow(current);
      graphIds.add(stringValue(row, "graph_id"));
      current = optionalString(row, "parent_run_id");
    }
    return graphIds;
  }

  normalizedChildSet(
    parentRunId: string,
    nodeId: string,
    descriptors: readonly ChildRunDescriptor[],
  ): readonly NormalizedChildDescriptor[] {
    const graph = this.graphForRun(parentRunId);
    const node = graph.nodesById.get(nodeId);
    if (!node || node.type !== "subgraph") {
      throw new BurnGraphError(
        "CHILD_RUN_CONFLICT",
        `${nodeId} is not a Subgraph`,
      );
    }
    const minimum = node.mode === "dynamic" ? (node.minChildren ?? 1) : 1;
    const maximum =
      node.mode === "dynamic" ? (node.maxChildren ?? 32) : 32;
    if (descriptors.length < minimum || descriptors.length > maximum) {
      throw new BurnGraphError(
        "HIERARCHY_LIMIT",
        `Subgraph ${nodeId} requires ${minimum}-${maximum} children`,
        false,
        { count: descriptors.length, minimum, maximum },
      );
    }

    const parent = this.runRow(parentRunId);
    const depth = numberValue(parent, "depth") + 1;
    if (depth > this.options.config.maxHierarchyDepth) {
      throw new BurnGraphError(
        "HIERARCHY_LIMIT",
        `Child depth ${depth} exceeds ${this.options.config.maxHierarchyDepth}`,
        false,
        { depth, limit: this.options.config.maxHierarchyDepth },
      );
    }
    const rootRunId = stringValue(parent, "root_run_id");
    const unfinished = this.options.database.db
      .query(
        `SELECT COUNT(*) AS count
           FROM runs
          WHERE root_run_id = ?
            AND parent_run_id IS NOT NULL
            AND status NOT IN ('completed', 'failed', 'cancelled')`,
      )
      .get(rootRunId) as Row;

    const ancestors = this.ancestorGraphIds(parentRunId);
    const runIds = new Set<string>();
    let requestedDescendants = 0;
    const normalized = descriptors.map((descriptor) => {
      if (ancestors.has(descriptor.graphId)) {
        throw new BurnGraphError(
          "HIERARCHY_CYCLE",
          `Graph ${descriptor.graphId} already exists in the Run ancestry`,
          false,
          { graphId: descriptor.graphId, parentRunId, nodeId },
        );
      }
      const childGraph = this.loadGraph(
        descriptor.graphId,
        descriptor.revision,
      ).spec;
      this.options.authoring.validateCheckReferences(childGraph);
      requestedDescendants +=
        1 +
        this.assertStaticDescendantsAvoidAncestors(
          childGraph,
          new Set([...ancestors, descriptor.graphId]),
          depth,
        );
      const runId = descriptor.runId ?? `child-${crypto.randomUUID()}`;
      IdentifierSchema.parse(runId);
      if (runIds.has(runId)) {
        throw new BurnGraphError(
          "CHILD_RUN_CONFLICT",
          `Child Run ${runId} is repeated in one child set`,
          false,
          { runId },
        );
      }
      runIds.add(runId);
      if (
        this.options.database.db
          .query("SELECT run_id FROM runs WHERE run_id = ?")
          .get(runId)
      ) {
        throw new BurnGraphError(
          "CHILD_RUN_CONFLICT",
          `Child Run ${runId} already exists`,
          false,
          { runId },
        );
      }
      return { ...descriptor, runId };
    });
    if (
      numberValue(unfinished, "count") + requestedDescendants >
      this.options.config.maxUnfinishedDescendants
    ) {
      throw new BurnGraphError(
        "HIERARCHY_LIMIT",
        `Root ${rootRunId} exceeds ${this.options.config.maxUnfinishedDescendants} unfinished descendants`,
        false,
        {
          existing: numberValue(unfinished, "count"),
          requested: requestedDescendants,
          limit: this.options.config.maxUnfinishedDescendants,
        },
      );
    }
    return normalized;
  }

  assertStaticDescendantsAvoidAncestors(
    graph: GraphSpec,
    ancestors: ReadonlySet<string>,
    depth: number,
  ): number {
    let descendants = 0;
    for (const node of graph.nodes) {
      if (node.type !== "subgraph" || node.mode !== "static") continue;
      for (const child of node.children ?? []) {
        descendants += 1;
        if (ancestors.has(child.graphId)) {
          throw new BurnGraphError(
            "HIERARCHY_CYCLE",
            `Graph ${child.graphId} repeats in the attached ancestry`,
            false,
            { graphId: child.graphId, nodeId: node.id },
          );
        }
        if (depth + 1 > this.options.config.maxHierarchyDepth) {
          throw new BurnGraphError(
            "HIERARCHY_LIMIT",
            `Attached Graph exceeds depth ${this.options.config.maxHierarchyDepth}`,
            false,
            { depth: depth + 1, limit: this.options.config.maxHierarchyDepth },
          );
        }
        const childGraph = this.loadGraph(
          child.graphId,
          child.revision,
        ).spec;
        descendants += this.assertStaticDescendantsAvoidAncestors(
          childGraph,
          new Set([...ancestors, child.graphId]),
          depth + 1,
        );
      }
    }
    return descendants;
  }

  insertChildRun(
    parentRunId: string,
    parentNodeId: string,
    descriptor: NormalizedChildDescriptor,
    position: number,
    at: string,
    runtimeChanges: RuntimeChange[],
  ): void {
    const parent = this.runRow(parentRunId);
    const child = this.loadGraph(descriptor.graphId, descriptor.revision);
    const rootRunId = stringValue(parent, "root_run_id");
    const depth = numberValue(parent, "depth") + 1;
    this.options.database.db
      .query(
        `INSERT INTO runs (
           run_id, graph_id, spec_revision, status, runtime_revision,
           focused_node_id, parent_run_id, parent_node_id, root_run_id,
           depth, priority, pause_requested_at, paused_at,
           cancel_requested_at, scheduler_ready_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'running', 1, NULL, ?, ?, ?, ?,
                   'normal', NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        descriptor.runId,
        descriptor.graphId,
        descriptor.revision,
        parentRunId,
        parentNodeId,
        rootRunId,
        depth,
        at,
        at,
        at,
      );
    this.options.database.db
      .query(
        `INSERT INTO subgraph_links (
           parent_run_id, parent_node_id, position, child_run_id,
           child_graph_id, child_spec_revision, label, outcome,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        parentRunId,
        parentNodeId,
        position,
        descriptor.runId,
        descriptor.graphId,
        descriptor.revision,
        descriptor.label ?? null,
        at,
        at,
      );

    for (const node of child.spec.nodes) {
      this.options.database.db
        .query(
          `INSERT INTO node_runs (
             run_id, node_id, node_type, title, status, attempt,
             assignment_id, actor_id, lease_expires_at, heartbeat_at,
             route, result_json, checkpoint_json, last_error, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL,
                     NULL, NULL, NULL, NULL, ?)`,
        )
        .run(descriptor.runId, node.id, node.type, node.title, at);
    }
    for (const edge of [...child.forwardEdges, ...child.loopEdges]) {
      this.insertEdge(descriptor.runId, edge, at);
    }
    const start = child.spec.nodes.find((node) => node.type === "start")!;
    this.options.database.db
      .query(
        `UPDATE node_runs
            SET status = 'done', attempt = 1, updated_at = ?
          WHERE run_id = ? AND node_id = ?`,
      )
      .run(at, descriptor.runId, start.id);
    this.takeAllForwardEdges(descriptor.runId, start.id, at);
    const changes: Array<Record<string, unknown>> = [
      { nodeId: start.id, status: "done" },
    ];
    this.cascade(child, descriptor.runId, at, changes);
    this.driveStaticSubgraphs(
      descriptor.runId,
      at,
      changes,
      runtimeChanges,
    );
    this.refreshRunTerminalStatus(descriptor.runId, at);
    const sequence = this.appendEvent({
      runId: descriptor.runId,
      graphId: descriptor.graphId,
      nodeId: start.id,
      type: "run.started",
      summary: `Started ${child.spec.title} at revision ${descriptor.revision}.`,
      payload: {
        parentRunId,
        parentNodeId,
        rootRunId,
        depth,
        changes,
      },
      at,
    });
    runtimeChanges.push({
      revision: numberValue(
        this.runRow(descriptor.runId),
        "runtime_revision",
      ),
      event: this.getEvent(sequence),
    });
  }

  sealSubgraphChildren(
    parentRunId: string,
    nodeId: string,
    descriptors: readonly ChildRunDescriptor[],
    at: string,
    changes: Array<Record<string, unknown>>,
    runtimeChanges: RuntimeChange[],
  ): readonly ChildRunDescriptor[] {
    const existing = this.options.database.db
      .query(
        `SELECT child_run_id
           FROM subgraph_links
          WHERE parent_run_id = ? AND parent_node_id = ?
          ORDER BY position`,
      )
      .all(parentRunId, nodeId) as Row[];
    if (existing.length > 0) {
      throw new BurnGraphError(
        "CHILD_RUN_CONFLICT",
        `Subgraph ${parentRunId}/${nodeId} already sealed its child set`,
      );
    }

    const normalized = this.normalizedChildSet(
      parentRunId,
      nodeId,
      descriptors,
    );
    return this.attachNormalizedSubgraphChildren(
      parentRunId,
      nodeId,
      normalized,
      at,
      changes,
      runtimeChanges,
    );
  }

  attachNormalizedSubgraphChildren(
    parentRunId: string,
    nodeId: string,
    normalized: readonly NormalizedChildDescriptor[],
    at: string,
    changes: Array<Record<string, unknown>>,
    runtimeChanges: RuntimeChange[],
  ): readonly NormalizedChildDescriptor[] {
    normalized.forEach((descriptor, position) => {
      this.insertChildRun(
        parentRunId,
        nodeId,
        descriptor,
        position,
        at,
        runtimeChanges,
      );
    });
    this.options.database.db
      .query(
        `UPDATE node_runs
            SET status = 'waiting', attempt = CASE
                  WHEN attempt = 0 THEN 1 ELSE attempt END,
                assignment_id = NULL, actor_id = NULL,
                lease_expires_at = NULL, heartbeat_at = NULL,
                updated_at = ?
          WHERE run_id = ? AND node_id = ?`,
      )
      .run(at, parentRunId, nodeId);
    changes.push({
      nodeId,
      status: "waiting",
      children: normalized.map((descriptor) => descriptor.runId),
    });
    runtimeChanges.push(
      ...this.settleSubgraphIfTerminal(
        parentRunId,
        nodeId,
        at,
        changes,
        false,
      ),
    );
    return normalized;
  }

  driveStaticSubgraphs(
    runId: string,
    at: string,
    changes: Array<Record<string, unknown>>,
    runtimeChanges: RuntimeChange[],
  ): void {
    const run = this.runRow(runId);
    if (stringValue(run, "status") !== "running") return;
    const graph = this.graphForRun(runId);
    for (const node of graph.spec.nodes) {
      if (
        node.type !== "subgraph" ||
        node.mode !== "static" ||
        stringValue(this.nodeRow(runId, node.id), "status") !== "ready"
      ) {
        continue;
      }
      this.sealSubgraphChildren(
        runId,
        node.id,
        node.children ?? [],
        at,
        changes,
        runtimeChanges,
      );
    }
  }

  settleSubgraphIfTerminal(
    parentRunId: string,
    nodeId: string,
    at: string,
    changes: Array<Record<string, unknown>>,
    emitEvent = true,
  ): readonly RuntimeChange[] {
    const node = this.nodeRow(parentRunId, nodeId);
    if (stringValue(node, "status") !== "waiting") return [];
    const children = this.options.database.db
      .query(
        `SELECT l.child_run_id, r.status
           FROM subgraph_links l
           JOIN runs r ON r.run_id = l.child_run_id
          WHERE l.parent_run_id = ? AND l.parent_node_id = ?
          ORDER BY l.position`,
      )
      .all(parentRunId, nodeId) as Row[];
    if (children.length === 0) return [];
    const statuses = children.map((child) => stringValue(child, "status"));
    if (
      !statuses.every((status) =>
        ["completed", "failed", "cancelled"].includes(status),
      )
    ) {
      return [];
    }
    let outcome: "success" | "failure" | "cancelled" | null = null;
    if (statuses.includes("failed")) outcome = "failure";
    else if (statuses.includes("cancelled")) outcome = "cancelled";
    else if (statuses.every((status) => status === "completed")) {
      outcome = "success";
    }
    if (outcome === null) return [];

    this.options.database.db
      .query(
        `UPDATE subgraph_links
            SET outcome = (
                  SELECT status FROM runs
                   WHERE runs.run_id = subgraph_links.child_run_id
                ),
                updated_at = ?
          WHERE parent_run_id = ? AND parent_node_id = ?`,
      )
      .run(at, parentRunId, nodeId);
    const selected = this.edgeRowsFrom(parentRunId, nodeId).find(
      (edge) => optionalString(edge, "route") === outcome,
    );
    const run = this.runRow(parentRunId);
    const nestedChanges: RuntimeChange[] = [];
    if (!selected) {
      this.options.database.db
        .query(
          `UPDATE node_runs
              SET status = 'failed', route = ?, last_error = ?,
                  updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(
          outcome,
          `Missing declared ${outcome} route`,
          at,
          parentRunId,
          nodeId,
        );
      this.options.database.db
        .query(
          "UPDATE runs SET status = 'failed', focused_node_id = NULL, updated_at = ? WHERE run_id = ?",
        )
        .run(at, parentRunId);
    } else {
      const result: CompletionInput = {
        summary: `Child Runs settled as ${outcome}.`,
        evidence: [],
        route: outcome,
      };
      this.options.database.db
        .query(
          `UPDATE node_runs
              SET status = 'done', route = ?, result_json = ?,
                  updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(outcome, json(result), at, parentRunId, nodeId);
      this.selectDecisionEdge(parentRunId, nodeId, outcome, at);
      const graph = this.graphForRun(parentRunId);
      this.cascade(graph, parentRunId, at, changes);
      this.driveStaticSubgraphs(
        parentRunId,
        at,
        changes,
        nestedChanges,
      );
      this.refreshRunTerminalStatus(parentRunId, at);
    }
    changes.push({ nodeId, status: selected ? "done" : "failed", outcome });
    if (!emitEvent) return nestedChanges;
    const revision = this.bumpRun(parentRunId, at, undefined, null);
    const sequence = this.appendEvent({
      runId: parentRunId,
      graphId: stringValue(run, "graph_id"),
      nodeId,
      type: selected ? "subgraph.settled" : "subgraph.failed",
      summary: selected
        ? `Subgraph ${nodeId} settled as ${outcome}.`
        : `Subgraph ${nodeId} has no ${outcome} route.`,
      payload: {
        outcome,
        children: children.map((child) => ({
          runId: stringValue(child, "child_run_id"),
          status: stringValue(child, "status"),
        })),
        revision,
      },
      at,
    });
    return [
      ...nestedChanges,
      { revision, event: this.getEvent(sequence) },
    ];
  }

  settleAncestors(
    childRunId: string,
    at: string,
  ): readonly RuntimeChange[] {
    const settled: RuntimeChange[] = [];
    let current = this.runRow(childRunId);
    while (optionalString(current, "parent_run_id") !== null) {
      const parentRunId = optionalString(current, "parent_run_id")!;
      const parentNodeId = optionalString(current, "parent_node_id")!;
      const payloadChanges: Array<Record<string, unknown>> = [];
      const changes = this.settleSubgraphIfTerminal(
        parentRunId,
        parentNodeId,
        at,
        payloadChanges,
      );
      if (changes.length === 0) break;
      settled.push(...changes);
      current = this.runRow(parentRunId);
    }
    return settled;
  }

  cascade(
    graph: ValidatedGraph,
    runId: string,
    at: string,
    changes: Array<Record<string, unknown>>,
  ): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const specNode of graph.spec.nodes) {
        if (specNode.type === "start") continue;
        const row = this.nodeRow(runId, specNode.id);
        if (stringValue(row, "status") !== "pending") continue;
        const incoming = this.options.database.db
          .query(
            `SELECT *
               FROM edge_runs
              WHERE run_id = ? AND to_node_id = ?
                AND max_traversals IS NULL`,
          )
          .all(runId, specNode.id) as Row[];
        if (incoming.length === 0) continue;
        const statuses = incoming.map(edgeStatus);
        if (statuses.includes("pending")) continue;
        if (statuses.every((status) => status === "disabled")) {
          this.options.database.db
            .query(
              `UPDATE node_runs
                  SET status = 'skipped', updated_at = ?
                WHERE run_id = ? AND node_id = ?`,
            )
            .run(at, runId, specNode.id);
          this.options.database.db
            .query(
              `UPDATE edge_runs
                  SET status = 'disabled', updated_at = ?
                WHERE run_id = ? AND from_node_id = ? AND status = 'pending'`,
            )
            .run(at, runId, specNode.id);
          changes.push({ nodeId: specNode.id, status: "skipped" });
          changed = true;
          continue;
        }
        if (statuses.some((status) => status === "taken")) {
          if (specNode.type === "join" || specNode.type === "end") {
            this.options.database.db
              .query(
                `UPDATE node_runs
                    SET status = 'done', attempt = 1, updated_at = ?
                  WHERE run_id = ? AND node_id = ?`,
              )
              .run(at, runId, specNode.id);
            if (specNode.type === "join") {
              this.takeAllForwardEdges(runId, specNode.id, at);
            }
            changes.push({ nodeId: specNode.id, status: "done" });
          } else {
            this.options.database.db
              .query(
                `UPDATE node_runs
                    SET status = 'ready', updated_at = ?
                  WHERE run_id = ? AND node_id = ?`,
              )
              .run(at, runId, specNode.id);
            changes.push({ nodeId: specNode.id, status: "ready" });
          }
          changed = true;
        }
      }
    }
  }

  resetLoop(
    graph: ValidatedGraph,
    runId: string,
    edgeId: string,
    sourceId: string,
    targetId: string,
    at: string,
    changes: Array<Record<string, unknown>>,
  ): void {
    const body = loopBodyNodeIds(graph, sourceId, targetId);
    const reachableFromBody = new Set(body);
    const queue = [...body];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of graph.forwardEdges) {
        if (edge.from !== current || reachableFromBody.has(edge.to)) continue;
        reachableFromBody.add(edge.to);
        queue.push(edge.to);
      }
    }
    const resetNodes = new Set(body);
    for (const nodeId of reachableFromBody) {
      if (
        stringValue(this.nodeRow(runId, nodeId), "status") === "skipped"
      ) {
        resetNodes.add(nodeId);
      }
    }
    const placeholders = [...resetNodes].map(() => "?").join(", ");
    this.options.database.db
      .query(
        `UPDATE node_runs
            SET status = 'pending', assignment_id = NULL, actor_id = NULL,
                lease_expires_at = NULL, heartbeat_at = NULL, route = NULL,
                result_json = NULL, checkpoint_json = NULL, last_error = NULL,
                updated_at = ?
          WHERE run_id = ? AND node_id IN (${placeholders})`,
      )
      .run(at, runId, ...resetNodes);
    this.options.database.db
      .query(
        `UPDATE edge_runs
            SET status = 'pending', updated_at = ?
          WHERE run_id = ? AND from_node_id IN (${placeholders})`,
      )
      .run(at, runId, ...resetNodes);
    this.options.database.db
      .query(
        `UPDATE edge_runs
            SET traversals = traversals + 1, status = 'pending', updated_at = ?
          WHERE run_id = ? AND edge_id = ?`,
      )
      .run(at, runId, edgeId);
    this.options.database.db
      .query(
        `UPDATE node_runs
            SET status = 'ready', updated_at = ?
          WHERE run_id = ? AND node_id = ?`,
      )
      .run(at, runId, targetId);
    changes.push({
      loop: `${sourceId}->${targetId}`,
      resetNodes: [...resetNodes],
      ready: targetId,
    });
  }

  refreshRunTerminalStatus(runId: string, at: string): void {
    const failed = this.options.database.db
      .query(
        `SELECT COUNT(*) AS count
           FROM node_runs
          WHERE run_id = ? AND status = 'failed'`,
      )
      .get(runId) as Row;
    if (numberValue(failed, "count") > 0) {
      this.options.database.db
        .query("UPDATE runs SET status = 'failed', updated_at = ? WHERE run_id = ?")
        .run(at, runId);
      return;
    }
    const unfinished = this.options.database.db
      .query(
        `SELECT COUNT(*) AS count
           FROM node_runs
          WHERE run_id = ?
            AND status NOT IN ('done', 'skipped')`,
      )
      .get(runId) as Row;
    const end = this.options.database.db
      .query(
        `SELECT status
           FROM node_runs
          WHERE run_id = ? AND node_type = 'end'`,
      )
      .get(runId) as Row;
    if (
      numberValue(unfinished, "count") === 0 &&
      stringValue(end, "status") === "done"
    ) {
      this.options.database.db
        .query(
          "UPDATE runs SET status = 'completed', focused_node_id = NULL, updated_at = ? WHERE run_id = ?",
        )
        .run(at, runId);
    }
  }

  releaseAssignmentResources(assignmentId: string): void {
    this.options.database.db
      .query(
        `DELETE FROM resource_locks
          WHERE owner_kind = 'assignment' AND owner_id = ?`,
      )
      .run(assignmentId);
  }

  stopNode(
    reference: string,
    nodeId: string,
    actorId: string,
    requestedStatus: "ready" | "blocked" | "failed",
    reason: string,
    retry: boolean,
    expectation?: AssignmentExpectation,
  ): MutationResult<RuntimeNode> {
    if (reason.trim().length === 0) {
      throw new BurnGraphError("REASON_REQUIRED", "A non-empty reason is required");
    }
    const runId = this.resolveRun(reference);
    const graph = this.graphForRun(runId);
    const nodeSpec = graph.nodesById.get(nodeId);
    if (!nodeSpec) throw new BurnGraphError("NODE_NOT_FOUND", `Unknown node ${nodeId}`);
    const now = this.options.now();
    const at = now.toISOString();
    const stopped = this.options.database.immediate(() => {
      const node = this.requireOwnedRunningNode(
        runId,
        nodeId,
        actorId,
        now,
        expectation,
      );
      const attempt = numberValue(node, "attempt");
      const assignmentId = optionalString(node, "assignment_id");
      const shouldRetry =
        requestedStatus === "failed" && retry && attempt < nodeSpec.maxAttempts;
      const status = shouldRetry ? "ready" : requestedStatus;
      const attemptStatus =
        requestedStatus === "ready" ? "released" : requestedStatus;
      this.options.database.db
        .query(
          `UPDATE attempts
              SET status = ?, finished_at = ?
            WHERE run_id = ? AND node_id = ? AND attempt = ?`,
        )
        .run(attemptStatus, at, runId, nodeId, attempt);
      if (assignmentId !== null) {
        this.releaseAssignmentResources(assignmentId);
      }
      this.options.database.db
        .query(
          `UPDATE node_runs
              SET status = ?, assignment_id = NULL, actor_id = NULL,
                  lease_expires_at = NULL, heartbeat_at = NULL,
                  last_error = ?, checkpoint_json = NULL, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(status, reason, at, runId, nodeId);
      this.options.database.db
        .query(
          "DELETE FROM actor_focus WHERE actor_id = ? AND run_id = ? AND node_id = ?",
        )
        .run(actorId, runId, nodeId);
      const run = this.runRow(runId);
      let failureCleanup: {
        readonly changes: readonly RuntimeChange[];
        readonly cancelledNodeCount: number;
        readonly cancelledNodes: readonly string[];
      } = {
        changes: [],
        cancelledNodeCount: 0,
        cancelledNodes: [],
      };
      if (status === "failed") {
        this.options.database.db
          .query(
            "UPDATE runs SET status = 'failed', focused_node_id = NULL, updated_at = ? WHERE run_id = ?",
          )
          .run(at, runId);
        failureCleanup = this.cancelFailureRemainder(runId, at);
      }
      const revision = this.bumpRun(runId, at, undefined, null);
      const type =
        status === "ready"
          ? shouldRetry
            ? "node.retry_scheduled"
            : "node.released"
          : `node.${status}`;
      const sequence = this.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type,
        summary: reason,
        payload: {
          actorId,
          attempt,
          status,
          retry: shouldRetry,
          cancelledNodeCount: failureCleanup.cancelledNodeCount,
          cancelledNodes: failureCleanup.cancelledNodes,
          revision,
        },
        at,
      });
      const changes: RuntimeChange[] = [
        ...failureCleanup.changes,
        { revision, event: this.getEvent(sequence) },
      ];
      if (status === "failed") {
        changes.push(...this.settleAncestors(runId, at));
      }
      return { sequence, changes };
    });
    const quiesced = this.options.database.immediate(() =>
      this.quiescePauseContainingRun(runId, at),
    );
    return {
      ...this.mutationNode(runId, nodeId, stopped.sequence),
      changes: [...stopped.changes, ...quiesced],
    };
  }

  cancelFailureRemainder(
    runId: string,
    at: string,
  ): {
    readonly changes: readonly RuntimeChange[];
    readonly cancelledNodeCount: number;
    readonly cancelledNodes: readonly string[];
  } {
    const tree = this.descendantRunRows(runId);
    const unfinishedDescendants = tree.filter(
      (row) =>
        stringValue(row, "run_id") !== runId &&
        !["completed", "failed", "cancelled"].includes(
          stringValue(row, "status"),
        ),
    );
    const affectedRunIds = [
      runId,
      ...unfinishedDescendants.map((row) => stringValue(row, "run_id")),
    ];
    const placeholders = affectedRunIds.map(() => "?").join(", ");
    const cancelledRows = this.options.database.db
      .query(
        `SELECT run_id, node_id
           FROM node_runs
          WHERE run_id IN (${placeholders})
            AND status IN
                ('pending', 'ready', 'running', 'waiting', 'blocked')
          ORDER BY run_id, node_id`,
      )
      .all(...affectedRunIds) as Row[];
    this.options.database.db
      .query(
        `UPDATE attempts
            SET status = 'cancelled', finished_at = ?
          WHERE run_id IN (${placeholders}) AND finished_at IS NULL`,
      )
      .run(at, ...affectedRunIds);
    this.options.database.db
      .query(
        `UPDATE node_runs
            SET status = CASE
                  WHEN status IN
                       ('pending', 'ready', 'running', 'waiting', 'blocked')
                  THEN 'cancelled' ELSE status END,
                assignment_id = NULL, actor_id = NULL,
                lease_expires_at = NULL, heartbeat_at = NULL,
                updated_at = ?
          WHERE run_id IN (${placeholders})`,
      )
      .run(at, ...affectedRunIds);
    this.options.database.db
      .query(`DELETE FROM actor_focus WHERE run_id IN (${placeholders})`)
      .run(...affectedRunIds);
    this.options.database.db
      .query(
        `DELETE FROM resource_locks
          WHERE owner_kind = 'assignment'
            AND run_id IN (${placeholders})`,
      )
      .run(...affectedRunIds);

    const descendantIds = unfinishedDescendants.map((row) =>
      stringValue(row, "run_id"),
    );
    const runtimeChanges: RuntimeChange[] = [];
    if (descendantIds.length > 0) {
      const descendantPlaceholders = descendantIds.map(() => "?").join(", ");
      this.options.database.db
        .query(
          `UPDATE runs
              SET status = 'cancelled', cancel_requested_at = ?,
                  focused_node_id = NULL, runtime_revision = runtime_revision + 1,
                  updated_at = ?
            WHERE run_id IN (${descendantPlaceholders})`,
        )
        .run(at, at, ...descendantIds);
      this.options.database.db
        .query(
          `UPDATE subgraph_links
              SET outcome = 'cancelled', updated_at = ?
            WHERE child_run_id IN (${descendantPlaceholders})`,
        )
        .run(at, ...descendantIds);
      for (const row of unfinishedDescendants) {
        const affectedRunId = stringValue(row, "run_id");
        const revision = numberValue(
          this.runRow(affectedRunId),
          "runtime_revision",
        );
        const sequence = this.appendEvent({
          runId: affectedRunId,
          graphId: stringValue(row, "graph_id"),
          nodeId: null,
          type: "run.cancelled",
          summary: `Cancelled ${affectedRunId} after ancestor failure.`,
          payload: { failureRunId: runId, revision },
          at,
        });
        runtimeChanges.push({
          revision,
          event: this.getEvent(sequence),
        });
      }
    }

    return {
      changes: runtimeChanges,
      cancelledNodeCount: cancelledRows.length,
      cancelledNodes: cancelledRows
        .slice(0, 32)
        .map(
          (row) =>
            `${stringValue(row, "run_id")}/${stringValue(row, "node_id")}`,
        ),
    };
  }

  bumpRun(
    runId: string,
    at: string,
    status?: GraphStatus,
    focusedNodeId?: string | null,
  ): number {
    const assignments = ["runtime_revision = runtime_revision + 1", "updated_at = ?"];
    const values: Array<string | null> = [at];
    if (status !== undefined) {
      assignments.push("status = ?");
      values.push(status);
    }
    if (focusedNodeId !== undefined) {
      assignments.push("focused_node_id = ?");
      values.push(focusedNodeId);
    }
    this.options.database.db
      .query(`UPDATE runs SET ${assignments.join(", ")} WHERE run_id = ?`)
      .run(...values, runId);
    return numberValue(this.runRow(runId), "runtime_revision");
  }

  appendEvent(input: {
    readonly runId: string;
    readonly graphId: string;
    readonly nodeId: string | null;
    readonly type: string;
    readonly summary: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly at: string;
  }): number {
    const result = this.options.database.db
      .query(
        `INSERT INTO events (
           run_id, graph_id, node_id, type, summary, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.graphId,
        input.nodeId,
        input.type,
        input.summary,
        json(input.payload),
        input.at,
      );
    return Number(result.lastInsertRowid);
  }

  getEvent(sequence: number): GraphEvent {
    const row = this.options.database.db
      .query("SELECT * FROM events WHERE sequence = ?")
      .get(sequence) as Row | null;
    if (!row) {
      throw new BurnGraphError("EVENT_NOT_FOUND", `Missing event ${sequence}`);
    }
    return this.eventFromRow(row);
  }

  eventFromRow(row: Row): GraphEvent {
    return {
      sequence: numberValue(row, "sequence"),
      runId: stringValue(row, "run_id"),
      graphId: stringValue(row, "graph_id"),
      nodeId: optionalString(row, "node_id"),
      type: stringValue(row, "type"),
      summary: stringValue(row, "summary"),
      payload:
        parseJson<Record<string, unknown>>(
          optionalString(row, "payload_json"),
        ) ?? {},
      createdAt: stringValue(row, "created_at"),
    };
  }

  recentEventsForRun(
    runId: string,
    limit: number,
  ): readonly GraphEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new BurnGraphError("INVALID_LIMIT", "Event limit must be 1-1000");
    }
    const rows = this.options.database.db
      .query(
        `SELECT *
           FROM events
          WHERE run_id = ?
          ORDER BY sequence DESC
          LIMIT ?`,
      )
      .all(runId, limit) as Row[];
    return rows.reverse().map((row) => this.eventFromRow(row));
  }

  assignmentPacket(
    runId: string,
    nodeId: string,
    actorId: string,
  ): AssignmentPacket {
    const summary = this.summaryForRun(runId);
    const graph = this.graphForRun(runId);
    const nodeRuntime = this.runtimeNode(this.nodeRow(runId, nodeId));
    const nodeSpec = graph.nodesById.get(nodeId);
    if (
      !nodeSpec ||
      !isAssignableNode(nodeSpec)
    ) {
      throw new BurnGraphError("NODE_NOT_FOUND", `Unknown assignment ${nodeId}`);
    }
    if (
      nodeRuntime.actorId !== actorId ||
      nodeRuntime.assignmentId === null ||
      nodeRuntime.leaseExpiresAt === null
    ) {
      throw new BurnGraphError(
        "NOT_NODE_OWNER",
        `${actorId} does not own ${nodeId}`,
      );
    }
    const incoming = this.options.database.db
      .query(
        `SELECT from_node_id
           FROM edge_runs
          WHERE run_id = ? AND to_node_id = ?
          ORDER BY edge_id`,
      )
      .all(runId, nodeId) as Row[];
    const predecessorIds = [
      ...new Set(
        incoming.map((edge) => stringValue(edge, "from_node_id")),
      ),
    ];
    const predecessors = predecessorIds
      .map((predecessorId) => {
        const runtime = this.runtimeNode(
          this.nodeRow(runId, predecessorId),
        );
        const spec = graph.nodesById.get(predecessorId);
        if (!spec) return null;
        const previous =
          runtime.result === null
            ? this.latestAttemptCompletion(runId, runtime.id)
            : {
                attempt: runtime.attempt,
                route: runtime.route,
                completion: runtime.result,
              };
        return {
          nodeId: runtime.id,
          title: spec.title,
          status: runtime.status,
          attempt: previous?.attempt ?? runtime.attempt,
          route: previous?.route ?? runtime.route,
          summary: previous?.completion.summary ?? null,
          evidence: previous?.completion.evidence ?? [],
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
    return {
      schemaVersion: 1,
      assignmentId: nodeRuntime.assignmentId,
      projectId: this.options.config.projectId,
      graph: {
        runId,
        graphId: summary.graphId,
        title: summary.title,
        goal: summary.goal,
        specRevision: summary.specRevision,
        runtimeRevision: summary.runtimeRevision,
        progress: summary.counts,
      },
      node: {
        id: nodeId,
        type: nodeSpec.type,
        title: nodeSpec.title,
        attempt: nodeRuntime.attempt,
        actorHint: nodeSpec.actorHint,
        prompt: nodeSpec.prompt,
        routes: this.edgeRowsFrom(runId, nodeId)
          .filter((edge) => optionalString(edge, "route") !== null)
          .map((edge) => ({
            route: stringValue(edge, "route"),
            to: stringValue(edge, "to_node_id"),
            label: optionalString(edge, "label"),
            remainingTraversals:
              optionalNumber(edge, "max_traversals") === null
                ? null
                : optionalNumber(edge, "max_traversals")! -
                  numberValue(edge, "traversals"),
          })),
      },
      context: { predecessors },
      claim: {
        actorId,
        leaseExpiresAt: nodeRuntime.leaseExpiresAt,
      },
      returnProtocol: {
        checkpoint: `burn-graph recover checkpoint --assignment ${nodeRuntime.assignmentId} --input -`,
        complete: `burn-graph done --assignment ${nodeRuntime.assignmentId} --input -`,
        block: `burn-graph recover block --assignment ${nodeRuntime.assignmentId} --reason <text>`,
        fail: `burn-graph recover fail --assignment ${nodeRuntime.assignmentId} --reason <text>`,
      },
    };
  }

  latestAttemptCompletion(
    runId: string,
    nodeId: string,
  ): {
    readonly attempt: number;
    readonly route: string | null;
    readonly completion: CompletionInput;
  } | null {
    const row = this.options.database.db
      .query(
        `SELECT attempt, route, result_json
           FROM attempts
          WHERE run_id = ? AND node_id = ? AND result_json IS NOT NULL
          ORDER BY attempt DESC
          LIMIT 1`,
      )
      .get(runId, nodeId) as Row | null;
    if (!row) return null;
    const completion = parseJson<CompletionInput>(
      optionalString(row, "result_json"),
    );
    if (!completion) return null;
    return {
      attempt: numberValue(row, "attempt"),
      route: optionalString(row, "route"),
      completion,
    };
  }

  mutationSnapshot(
    runId: string,
    sequence: number,
  ): MutationResult<GraphSnapshot> {
    const snapshot = this.options.getSnapshot(runId);
    return {
      revision: snapshot.summary.runtimeRevision,
      event: this.getEvent(sequence),
      value: snapshot,
    };
  }

  mutationNode(
    runId: string,
    nodeId: string,
    sequence: number,
  ): MutationResult<RuntimeNode> {
    return {
      revision: this.summaryForRun(runId).runtimeRevision,
      event: this.getEvent(sequence),
      value: this.runtimeNode(this.nodeRow(runId, nodeId)),
    };
  }
}


function edgeStatus(row: Row): RuntimeEdge["status"] {
  const value = stringValue(row, "status");
  if (value === "pending" || value === "taken" || value === "disabled") {
    return value;
  }
  throw new BurnGraphError("CORRUPT_STATE", `Unknown edge status ${value}`);
}
