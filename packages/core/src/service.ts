import { z } from "zod";

import {
  BurnGraphError,
  CheckpointInputSchema,
  CompletionInputSchema,
  DynamicSubgraphOutputSchema,
  IdempotencyKeySchema,
  IdentifierSchema,
  MAX_ACTOR_ASSIGNMENT_BYTES,
  NodeStatusSchema,
  RunPrioritySchema,
  type ActorWork,
  type AssignmentPacket,
  type CheckSpec,
  type ChildRunDescriptor,
  type CompletionInput,
  type CompletionContinuation,
  type GraphEvent,
  type GraphSnapshot,
  type GraphSpec,
  type GraphSummary,
  type GraphTreeSnapshot,
  type IdempotentMutationResult,
  type MutationResult,
  type PortfolioOverview,
  type PortfolioOverviewNode,
  type PortfolioOverviewOptions,
  type PortfolioRun,
  type ProjectConfig,
  type ReadyWork,
  type RuntimeChange,
  type RuntimeNode,
  type RuntimeMetrics,
  type RunPriority,
  type TemplateInstantiationReceipt,
  type TemplateInstantiationRequest,
  type WorkSchedule,
} from "./contracts.ts";
import { gateResources, validateCheckSpec } from "./gate.ts";
import { GraphAuthoring } from "./service-authoring.ts";
import {
  isAssignableNode,
  isExpired,
  leaseTime,
  resourceEligibility,
  runIdFor,
  RuntimeInternals,
  validateLeaseSeconds,
} from "./service-internals.ts";
import { RunLifecycle } from "./service-lifecycle.ts";
import { RunProjection } from "./service-projection.ts";
import { deriveRuntimeMetrics } from "./metrics.ts";
import { renderMermaid, renderTreeMermaid } from "./mermaid.ts";
import {
  discoverProjectRoot,
  readProjectConfig,
} from "./project.ts";
import {
  json,
  numberValue,
  optionalNumber,
  optionalString,
  parseJson,
  stringValue,
  type Row,
} from "./sql.ts";
import {
  effectivePriority,
  orderReadyWork,
} from "./scheduler.ts";
import { BurnGraphDatabase } from "./storage.ts";
import {
  recoverTemplateTransactions,
} from "./template-service.ts";
import {
  validateGraphSpec,
  type ValidatedGraph,
} from "./validator.ts";

const MAX_SCHEDULE_READY_PREVIEW = 32;
const MAX_SCHEDULE_RUN_SUMMARIES = 8;
const MAX_ASSIGNMENT_OUTPUT_BLOCK_SAMPLE = 8;
const MAX_ASSIGNMENT_OUTPUT_BLOCK_PROBES = 32;
const MAX_TREE_PROJECTION_RUNS = 10_000;

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

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







export interface BurnGraphServiceOptions {
  readonly now?: () => Date;
}

export class BurnGraphServiceBase {
  readonly root: string;
  readonly config: ProjectConfig;
  readonly database: BurnGraphDatabase;
  protected readonly now: () => Date;

  constructor(rootInput: string, options: BurnGraphServiceOptions = {}) {
    this.root = discoverProjectRoot(rootInput);
    this.config = readProjectConfig(this.root);
    this.database = new BurnGraphDatabase(this.root);
    this.now = options.now ?? (() => new Date());
    this.authoring = new GraphAuthoring({
      root: this.root,
      config: this.config,
      database: this.database,
      timestamp: () => this.internals.timestamp(),
      loadGraph: (graphId, revision) => this.internals.loadGraph(graphId, revision),
      loadCheck: (checkId, revision) => this.internals.loadCheck(checkId, revision),
      summaryForRun: (runId) => this.internals.summaryForRun(runId),
      tryResolveRun: (reference) => this.internals.tryResolveRun(reference),
    });
    this.projection = new RunProjection({
      config: this.config,
      database: this.database,
      timestamp: () => this.internals.timestamp(),
      loadGraph: (graphId, revision) => this.internals.loadGraph(graphId, revision),
      resolveRun: (reference) => this.internals.resolveRun(reference),
      summaryForRun: (runId) => this.internals.summaryForRun(runId),
      nodesForRun: (runId, spec) => this.internals.nodesForRun(runId, spec),
      edgesForRun: (runId) => this.internals.edgesForRun(runId),
      recentEventsForRun: (runId, limit) => this.internals.recentEventsForRun(runId, limit),
    });
    this.internals = new RuntimeInternals({
      config: this.config,
      database: this.database,
      now: () => this.now(),
      authoring: this.authoring,
      getSnapshot: (reference, eventLimit) => this.getSnapshot(reference, eventLimit),
      readSnapshot: (reference, eventLimit) => this.readSnapshot(reference, eventLimit),
    });
    this.lifecycle = new RunLifecycle({
      database: this.database,
      runRow: (runId) => this.internals.runRow(runId),
      descendantRunRows: (runId) => this.internals.descendantRunRows(runId),
      appendEvent: (entry) => this.internals.appendEvent(entry),
      getEvent: (sequence) => this.internals.getEvent(sequence),
      getSnapshot: (reference, eventLimit) => this.getSnapshot(reference, eventLimit),
      bumpRun: (runId, at) => this.internals.bumpRun(runId, at),
      settleAncestors: (runId, at) => this.internals.settleAncestors(runId, at),
      driveStaticSubgraphs: (runId, at, changes, runtimeChanges) =>
        this.internals.driveStaticSubgraphs(runId, at, changes, runtimeChanges),
      executeLifecycleMutation: (kind, reference, idempotencyKey, mutate) =>
        this.internals.executeLifecycleMutation(kind, reference, idempotencyKey, mutate),
    });
    recoverTemplateTransactions(this.root, this.database);
  }

  close(): void {
    this.database.close();
  }

  // Authoring lives in GraphAuthoring; these delegates keep the public service
  // surface unchanged for every existing caller.
  private readonly authoring: GraphAuthoring;
  private readonly projection: RunProjection;
  private readonly lifecycle: RunLifecycle;
  protected readonly internals: RuntimeInternals;

  validateGraph(input: unknown): GraphSpec {
    return this.authoring.validateGraph(input);
  }

  applyGraph(input: unknown): GraphSpec {
    return this.authoring.applyGraph(input);
  }

  instantiateTemplate(
    request: TemplateInstantiationRequest,
  ): TemplateInstantiationReceipt {
    return this.authoring.instantiateTemplate(request);
  }

  listGraphs(): readonly {
    readonly id: string;
    readonly title: string;
    readonly goal: string;
    readonly revision: number;
    readonly latestRun: GraphSummary | null;
  }[] {
    return this.authoring.listGraphs();
  }

  getGraph(graphId: string): GraphSpec {
    return this.authoring.getGraph(graphId);
  }

  validateCheck(input: unknown): CheckSpec {
    return this.authoring.validateCheck(input);
  }

  applyCheck(input: unknown): CheckSpec {
    return this.authoring.applyCheck(input);
  }

  listChecks(): readonly CheckSpec[] {
    return this.authoring.listChecks();
  }

  getCheck(checkId: string, revision?: number): CheckSpec {
    return this.authoring.getCheck(checkId, revision);
  }

  cloneGraph(sourceId: string, targetId: string, title?: string): GraphSpec {
    return this.authoring.cloneGraph(sourceId, targetId, title);
  }

  startRun(graphId: string, requestedRunId?: string): MutationResult<GraphSnapshot> {
    const validated = this.internals.loadGraph(graphId);
    this.authoring.validateCheckReferences(validated.spec);
    const now = this.now();
    const at = now.toISOString();
    const runId = requestedRunId ?? runIdFor(graphId, now);
    IdentifierSchema.parse(runId);

    const started = this.database.immediate(() => {
      const live = this.database.db
        .query(
          `SELECT run_id
           FROM runs
            WHERE graph_id = ?
              AND parent_run_id IS NULL
              AND status IN ('running', 'pausing', 'paused', 'cancelling')
            LIMIT 1`,
        )
        .get(graphId) as Row | null;
      if (live) {
        throw new BurnGraphError(
          "GRAPH_ALREADY_RUNNING",
          `Graph ${graphId} already has live run ${stringValue(live, "run_id")}`,
          true,
        );
      }
      const existing = this.database.db
        .query("SELECT run_id FROM runs WHERE run_id = ?")
        .get(runId) as Row | null;
      if (existing) {
        throw new BurnGraphError("RUN_ALREADY_EXISTS", `Run ${runId} already exists`);
      }

      this.database.db
        .query(
          `INSERT INTO runs (
             run_id, graph_id, spec_revision, status, runtime_revision,
             focused_node_id, parent_run_id, parent_node_id, root_run_id,
             depth, priority, pause_requested_at, paused_at,
             cancel_requested_at, scheduler_ready_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'running', 1, NULL, NULL, NULL, ?,
                     0, 'normal', NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(runId, graphId, validated.spec.revision, runId, at, at, at);

      for (const node of validated.spec.nodes) {
        this.database.db
          .query(
            `INSERT INTO node_runs (
               run_id, node_id, node_type, title, status, attempt,
               assignment_id, actor_id, lease_expires_at, heartbeat_at,
               route, result_json, checkpoint_json, last_error, updated_at
             ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL,
                       NULL, NULL, NULL, NULL, ?)`,
          )
          .run(runId, node.id, node.type, node.title, at);
      }
      for (const edge of [
        ...validated.forwardEdges,
        ...validated.loopEdges,
      ]) {
        this.internals.insertEdge(runId, edge, at);
      }

      const start = validated.spec.nodes.find((node) => node.type === "start")!;
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = 'done', attempt = 1, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(at, runId, start.id);
      this.internals.takeAllForwardEdges(runId, start.id, at);
      const changes = [{ nodeId: start.id, status: "done" }];
      const childChanges: RuntimeChange[] = [];
      this.internals.cascade(validated, runId, at, changes);
      this.internals.driveStaticSubgraphs(runId, at, changes, childChanges);
      this.internals.refreshRunTerminalStatus(runId, at);
      const sequence = this.internals.appendEvent({
        runId,
        graphId,
        nodeId: start.id,
        type: "run.started",
        summary: `Started ${validated.spec.title} at revision ${validated.spec.revision}.`,
        payload: { changes },
        at,
      });
      const rootChange = {
        revision: numberValue(this.internals.runRow(runId), "runtime_revision"),
        event: this.internals.getEvent(sequence),
      };
      return {
        sequence,
        changes: [...childChanges, rootChange],
      };
    });

    const snapshot = this.getSnapshot(runId);
    return {
      revision: snapshot.summary.runtimeRevision,
      event: this.internals.getEvent(started.sequence),
      value: snapshot,
      changes: started.changes,
    };
  }

  listRuns(): readonly GraphSummary[] {
    return this.database.read(() => {
      const rows = this.database.db
        .query("SELECT run_id FROM runs ORDER BY updated_at DESC")
        .all() as Row[];
      return rows.map((row) =>
        this.internals.summaryForRun(stringValue(row, "run_id")),
      );
    });
  }

  // Read-only projections live in RunProjection; these delegates keep the public
  // service surface unchanged.
  getSnapshot(reference: string, eventLimit = 100): GraphSnapshot {
    return this.projection.getSnapshot(reference, eventLimit);
  }

  protected readSnapshot(reference: string, eventLimit: number): GraphSnapshot {
    return this.projection.readSnapshot(reference, eventLimit);
  }

  getTreeSnapshot(
    reference: string,
    depth = 0,
    limit = 500,
    eventLimit = 100,
  ): GraphTreeSnapshot {
    return this.projection.getTreeSnapshot(reference, depth, limit, eventLimit);
  }

  inspectNode(
    reference: string,
    nodeId: string,
    eventLimit = 50,
  ): ReturnType<RunProjection["inspectNode"]> {
    return this.projection.inspectNode(reference, nodeId, eventLimit);
  }

  // Run lifecycle lives in RunLifecycle; these delegates keep the public surface.
  pauseRun(
    reference: string,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.lifecycle.pauseRun(reference, idempotencyKey);
  }

  resumeRun(
    reference: string,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.lifecycle.resumeRun(reference, idempotencyKey);
  }

  cancelRun(
    reference: string,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.lifecycle.cancelRun(reference, idempotencyKey);
  }

  setRunPriority(
    reference: string,
    value: RunPriority,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.lifecycle.setRunPriority(reference, value, idempotencyKey);
  }

  listReady(graphReference?: string): readonly ReadyWork[] {
    const parameters: string[] = [];
    let filter = "";
    if (graphReference) {
      const runId = this.internals.resolveRun(graphReference);
      filter = "AND n.run_id = ?";
      parameters.push(runId);
    }
    const rows = this.database.db
      .query(
        `SELECT n.run_id, r.root_run_id, r.depth, root.priority,
                root.scheduler_ready_at, r.graph_id, n.node_id,
                n.node_type, n.title, n.attempt, n.updated_at,
                s.document_json
           FROM node_runs n
           JOIN runs r ON r.run_id = n.run_id
           JOIN runs root ON root.run_id = r.root_run_id
           JOIN graph_specs s
             ON s.graph_id = r.graph_id AND s.revision = r.spec_revision
          WHERE r.status = 'running'
            AND n.status = 'ready'
            ${filter}
          ORDER BY n.updated_at, n.run_id, n.node_id`,
      )
      .all(...parameters) as Row[];
    const lockedResources = new Set(
      (
        this.database.db
          .query("SELECT resource FROM resource_locks ORDER BY resource")
          .all() as Row[]
      ).map((lock) => stringValue(lock, "resource")),
    );
    const graphsByRun = new Map<string, ValidatedGraph>();
    return rows.flatMap((row) => {
      const runId = stringValue(row, "run_id");
      let graph = graphsByRun.get(runId);
      if (!graph) {
        graph = validateGraphSpec(
          JSON.parse(stringValue(row, "document_json")),
        );
        graphsByRun.set(runId, graph);
      }
      const nodeId = stringValue(row, "node_id");
      const node = graph.nodesById.get(nodeId)!;
      if (!isAssignableNode(node)) return [];
      const resources = node.resources ?? [];
      const priority = RunPrioritySchema.parse(
        stringValue(row, "priority"),
      );
      const readySince = stringValue(row, "scheduler_ready_at");
      return [{
        runId,
        rootRunId: stringValue(row, "root_run_id"),
        graphId: stringValue(row, "graph_id"),
        nodeId,
        type: node.type,
        title: stringValue(row, "title"),
        actorHint: node.actorHint,
        attempt: numberValue(row, "attempt") + 1,
        depth: numberValue(row, "depth"),
        priority,
        effectivePriority: effectivePriority(
          priority,
          readySince,
          this.now(),
        ),
        readySince,
        resources,
        eligibility: resourceEligibility(resources, lockedResources),
        updatedAt: stringValue(row, "updated_at"),
      }];
    });
  }

  private listReadyResourceMetrics(): readonly Pick<
    ReadyWork,
    "runId" | "eligibility"
  >[] {
    const assignable = this.listReady().map((candidate) => ({
      runId: candidate.runId,
      eligibility: candidate.eligibility,
    }));
    const lockedResources = new Set(
      (
        this.database.db
          .query("SELECT resource FROM resource_locks ORDER BY resource")
          .all() as Row[]
      ).map((lock) => stringValue(lock, "resource")),
    );
    const gateRows = this.database.db
      .query(
        `SELECT n.run_id, n.node_id, s.document_json
           FROM node_runs n
           JOIN runs r ON r.run_id = n.run_id
           JOIN graph_specs s
             ON s.graph_id = r.graph_id AND s.revision = r.spec_revision
          WHERE r.status = 'running'
            AND n.status = 'ready'
            AND n.node_type = 'gate'
          ORDER BY n.updated_at, n.run_id, n.node_id`,
      )
      .all() as Row[];
    const graphsByRun = new Map<string, ValidatedGraph>();
    const gates = gateRows.map((row) => {
      const runId = stringValue(row, "run_id");
      let graph = graphsByRun.get(runId);
      if (!graph) {
        graph = validateGraphSpec(
          JSON.parse(stringValue(row, "document_json")),
        );
        graphsByRun.set(runId, graph);
      }
      const nodeId = stringValue(row, "node_id");
      const node = graph.nodesById.get(nodeId);
      if (!node || node.type !== "gate" || !node.check) {
        throw new BurnGraphError(
          "CORRUPT_STATE",
          `${runId}/${nodeId} is not a valid ready Gate`,
        );
      }
      const check = this.internals.loadCheck(node.check.id, node.check.revision);
      const resources = gateResources(node.resources ?? [], check.resources);
      return {
        runId,
        eligibility: resourceEligibility(resources, lockedResources),
      };
    });
    return [...assignable, ...gates];
  }

  claim(
    reference: string,
    nodeId: string,
    actorId: string,
    leaseSeconds?: number,
  ): MutationResult<AssignmentPacket> {
    IdentifierSchema.parse(nodeId);
    IdentifierSchema.parse(actorId);
    const runId = this.internals.resolveRun(reference);
    const validated = this.internals.graphForRun(runId);
    const nodeSpec = validated.nodesById.get(nodeId);
    if (!nodeSpec || !isAssignableNode(nodeSpec)) {
      throw new BurnGraphError(
        "NODE_NOT_CLAIMABLE",
        `${nodeId} is not an assignable node`,
      );
    }
    const now = this.now();
    const at = now.toISOString();
    const duration = validateLeaseSeconds(
      leaseSeconds ?? this.config.defaultLeaseSeconds,
    );
    const expiresAt = leaseTime(now, duration);

    const claimed = this.database.immediate(() => {
      const run = this.internals.runRow(runId);
      if (stringValue(run, "status") !== "running") {
        throw new BurnGraphError(
          "RUN_NOT_RUNNING",
          `Run ${runId} is ${stringValue(run, "status")}`,
          true,
        );
      }
      const row = this.internals.nodeRow(runId, nodeId);
      let status = NodeStatusSchema.parse(stringValue(row, "status"));
      let recoveredExpiredAttempt: {
        readonly attempt: number;
        readonly actorId: string | null;
      } | null = null;
      if (
        status === "running" &&
        isExpired(optionalString(row, "lease_expires_at"), now)
      ) {
        const staleAttempt = numberValue(row, "attempt");
        const staleActorId = optionalString(row, "actor_id");
        const staleAssignmentId = optionalString(row, "assignment_id");
        this.database.db
          .query(
            `UPDATE attempts
                SET status = 'expired', finished_at = ?
              WHERE run_id = ? AND node_id = ? AND attempt = ?`,
          )
          .run(at, runId, nodeId, staleAttempt);
        this.database.db
          .query(
            `UPDATE node_runs
                SET status = 'ready', assignment_id = NULL, actor_id = NULL,
                    lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
              WHERE run_id = ? AND node_id = ?`,
          )
          .run(at, runId, nodeId);
        if (staleActorId !== null) {
          this.database.db
            .query(
              `DELETE FROM actor_focus
                WHERE actor_id = ? AND run_id = ? AND node_id = ?`,
            )
            .run(staleActorId, runId, nodeId);
        }
        if (staleAssignmentId !== null) {
          this.internals.releaseAssignmentResources(staleAssignmentId);
        }
        recoveredExpiredAttempt = {
          attempt: staleAttempt,
          actorId: staleActorId,
        };
        status = "ready";
      }
      if (status !== "ready") {
        throw new BurnGraphError(
          "NODE_NOT_READY",
          `Node ${nodeId} is ${status}`,
          true,
          { status },
        );
      }
      const runningCount = this.database.db
        .query(
          `SELECT COUNT(*) AS count
             FROM node_runs
            WHERE run_id = ? AND status = 'running'`,
        )
        .get(runId) as Row;
      const actorRunningCount = this.database.db
        .query(
          `SELECT COUNT(*) AS count
             FROM node_runs
            WHERE actor_id = ? AND status = 'running'`,
        )
        .get(actorId) as Row;
      if (
        numberValue(actorRunningCount, "count") >=
        this.config.maxAssignmentsPerActor
      ) {
        throw new BurnGraphError(
          "ACTOR_ASSIGNMENT_LIMIT_REACHED",
          `${actorId} already has ${this.config.maxAssignmentsPerActor} active Assignments`,
          true,
          { limit: this.config.maxAssignmentsPerActor },
        );
      }
      if (numberValue(runningCount, "count") >= validated.spec.maxActive) {
        throw new BurnGraphError(
          "MAX_ACTIVE_REACHED",
          `Run ${runId} already has ${validated.spec.maxActive} active nodes`,
          true,
        );
      }
      const resources = nodeSpec.resources ?? [];
      if (resources.length > 0) {
        const locks = this.database.db
          .query(
            `SELECT resource, owner_kind, owner_id
               FROM resource_locks
              WHERE resource IN (${resources.map(() => "?").join(", ")})
              ORDER BY resource`,
          )
          .all(...resources) as Row[];
        if (locks.length > 0) {
          throw new BurnGraphError(
            "RESOURCE_BUSY",
            `Resources are unavailable for ${runId}/${nodeId}`,
            true,
            {
              resources: locks.map((lock) => ({
                resource: stringValue(lock, "resource"),
                ownerKind: stringValue(lock, "owner_kind"),
                ownerId: stringValue(lock, "owner_id"),
              })),
            },
          );
        }
      }
      const attempt = numberValue(row, "attempt") + 1;
      const assignmentId = crypto.randomUUID();
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = 'running', attempt = ?, assignment_id = ?, actor_id = ?,
                  lease_expires_at = ?, heartbeat_at = ?,
                  checkpoint_json = NULL, last_error = NULL, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(
          attempt,
          assignmentId,
          actorId,
          expiresAt,
          at,
          at,
          runId,
          nodeId,
        );
      this.database.db
        .query(
          `INSERT INTO attempts (
             run_id, node_id, attempt, status, assignment_id, actor_id, result_json,
             checkpoint_json, route, started_at, finished_at
           ) VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, ?, NULL)`,
        )
        .run(runId, nodeId, attempt, assignmentId, actorId, at);
      for (const resource of resources) {
        this.database.db
          .query(
            `INSERT INTO resource_locks (
               resource, owner_kind, owner_id, root_run_id, run_id, node_id,
               expires_at, created_at
             ) VALUES (?, 'assignment', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            resource,
            assignmentId,
            stringValue(run, "root_run_id"),
            runId,
            nodeId,
            expiresAt,
            at,
          );
      }
      this.database.db
        .query(
          `INSERT INTO actor_focus (actor_id, run_id, node_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(actor_id) DO UPDATE SET
             run_id = excluded.run_id,
             node_id = excluded.node_id,
             updated_at = excluded.updated_at`,
        )
        .run(actorId, runId, nodeId, at);
      this.database.db
        .query(
          `UPDATE runs
              SET scheduler_ready_at = ?
            WHERE run_id = ?`,
        )
        .run(at, stringValue(run, "root_run_id"));
      const revision = this.internals.bumpRun(runId, at, undefined, nodeId);
      // I0011: the event sequence is kept rather than returned here, because the
      // packet and the Actor's aggregate payload must be bounded inside this
      // transaction. Returning early would commit the claim and leave an
      // oversized Assignment to fail at the output edge, after the state
      // transition — the exact defect I0011 records.
      const sequence = this.internals.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.claimed",
        summary: `${actorId} claimed ${nodeSpec.title}.`,
        payload: {
          actorId,
          attempt,
          assignmentId,
          leaseExpiresAt: expiresAt,
          resources,
          recoveredExpiredAttempt,
          revision,
        },
        at,
      });
      const packet = this.internals.assignmentPacket(runId, nodeId, actorId);
      const actorAssignments = this.assignmentsForActor(actorId);
      const requestedBytes = serializedBytes(actorAssignments);
      if (requestedBytes > MAX_ACTOR_ASSIGNMENT_BYTES) {
        throw new BurnGraphError(
          "ACTOR_ASSIGNMENT_OUTPUT_LIMIT",
          `Claiming ${runId}/${nodeId} would exceed the Actor Assignment output limit`,
          true,
          {
            runId,
            nodeId,
            maximumBytes: MAX_ACTOR_ASSIGNMENT_BYTES,
            requestedBytes,
            currentAssignmentCount: actorAssignments.length - 1,
          },
        );
      }
      return { sequence, packet };
    });

    // The packet comes from inside the transaction, not from a second read after
    // it: only the in-transaction value is the one that was bounds-checked and
    // would have rolled back had it been too large.
    return {
      revision: this.internals.summaryForRun(runId).runtimeRevision,
      event: this.internals.getEvent(claimed.sequence),
      value: claimed.packet,
    };
  }

  heartbeat(
    reference: string,
    nodeId: string,
    actorId: string,
    leaseSeconds?: number,
    expectation?: AssignmentExpectation,
  ): MutationResult<RuntimeNode> {
    IdentifierSchema.parse(actorId);
    const runId = this.internals.resolveRun(reference);
    const now = this.now();
    const at = now.toISOString();
    const duration = validateLeaseSeconds(
      leaseSeconds ?? this.config.defaultLeaseSeconds,
    );
    const expiresAt = leaseTime(now, duration);
    const sequence = this.database.immediate(() => {
      const row = this.internals.requireOwnedRunningNode(
        runId,
        nodeId,
        actorId,
        now,
        expectation,
      );
      this.database.db
        .query(
          `UPDATE node_runs
              SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(expiresAt, at, at, runId, nodeId);
      const assignmentId = optionalString(row, "assignment_id");
      if (assignmentId !== null) {
        this.database.db
          .query(
            `UPDATE resource_locks
                SET expires_at = ?
              WHERE owner_kind = 'assignment' AND owner_id = ?`,
          )
          .run(expiresAt, assignmentId);
      }
      const run = this.internals.runRow(runId);
      const revision = this.internals.bumpRun(runId, at);
      return this.internals.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.heartbeat",
        summary: `${actorId} renewed ${stringValue(row, "title")}.`,
        payload: { actorId, leaseExpiresAt: expiresAt, revision },
        at,
      });
    });
    return this.internals.mutationNode(runId, nodeId, sequence);
  }

  checkpoint(
    reference: string,
    nodeId: string,
    actorId: string,
    input: unknown,
    expectation?: AssignmentExpectation,
  ): MutationResult<RuntimeNode> {
    const checkpoint = CheckpointInputSchema.parse(input);
    const runId = this.internals.resolveRun(reference);
    const now = this.now();
    const at = now.toISOString();
    const sequence = this.database.immediate(() => {
      const row = this.internals.requireOwnedRunningNode(
        runId,
        nodeId,
        actorId,
        now,
        expectation,
      );
      const attempt = numberValue(row, "attempt");
      this.database.db
        .query(
          `UPDATE node_runs
              SET checkpoint_json = ?, heartbeat_at = ?, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(json(checkpoint), at, at, runId, nodeId);
      this.database.db
        .query(
          `UPDATE attempts
              SET checkpoint_json = ?
            WHERE run_id = ? AND node_id = ? AND attempt = ?`,
        )
        .run(json(checkpoint), runId, nodeId, attempt);
      const run = this.internals.runRow(runId);
      const revision = this.internals.bumpRun(runId, at);
      return this.internals.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.checkpointed",
        summary: checkpoint.summary,
        payload: { actorId, progress: checkpoint.progress, revision },
        at,
      });
    });
    return this.internals.mutationNode(runId, nodeId, sequence);
  }

  complete(
    reference: string,
    nodeId: string,
    actorId: string,
    input: unknown,
    expectation?: AssignmentExpectation,
  ): MutationResult<GraphSnapshot> {
    const completion = CompletionInputSchema.parse(input);
    const runId = this.internals.resolveRun(reference);
    const validated = this.internals.graphForRun(runId);
    const nodeSpec = validated.nodesById.get(nodeId);
    if (!nodeSpec) {
      throw new BurnGraphError("NODE_NOT_FOUND", `Unknown node ${nodeId}`);
    }
    const dynamicChildren =
      nodeSpec.type === "subgraph" && nodeSpec.mode === "dynamic"
        ? DynamicSubgraphOutputSchema.safeParse(completion.output)
        : null;
    if (dynamicChildren !== null && !dynamicChildren.success) {
      throw new BurnGraphError(
        "INVALID_GRAPH",
        `Dynamic Subgraph ${nodeId} requires output.children`,
        false,
        { issues: dynamicChildren.error.issues },
      );
    }
    if (nodeSpec.type === "decision") {
      if (!completion.route) {
        throw new BurnGraphError(
          "ROUTE_REQUIRED",
          `Decision ${nodeId} requires route`,
        );
      }
      if (!nodeSpec.next.some((edge) => edge.route === completion.route)) {
        throw new BurnGraphError(
          "INVALID_ROUTE",
          `Decision ${nodeId} has no route ${completion.route}`,
          false,
          { routes: nodeSpec.next.map(({ route }) => route) },
        );
      }
    } else if (completion.route) {
      throw new BurnGraphError(
        "ROUTE_NOT_ALLOWED",
        `Only Decision nodes may return route`,
      );
    }
    if (nodeSpec.prompt.outputSchema !== null) {
      let outputSchema: z.ZodType;
      try {
        outputSchema = z.fromJSONSchema(
          nodeSpec.prompt.outputSchema as Parameters<typeof z.fromJSONSchema>[0],
        );
      } catch (error) {
        throw new BurnGraphError(
          "INVALID_OUTPUT_SCHEMA",
          `Node ${nodeId} has an invalid output schema`,
          false,
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
      const output = outputSchema.safeParse(completion.output);
      if (!output.success) {
        throw new BurnGraphError(
          "OUTPUT_SCHEMA_MISMATCH",
          `Output for ${nodeId} does not match its schema`,
          false,
          { errors: output.error.issues },
        );
      }
    }

    const now = this.now();
    const at = now.toISOString();
    const completed = this.database.immediate(() => {
      const node = this.internals.requireOwnedRunningNode(
        runId,
        nodeId,
        actorId,
        now,
        expectation,
      );
      const attempt = numberValue(node, "attempt");
      const assignmentId = optionalString(node, "assignment_id");
      const run = this.internals.runRow(runId);
      const normalizedChildren =
        dynamicChildren !== null && dynamicChildren.success
          ? this.internals.normalizedChildSet(
              runId,
              nodeId,
              dynamicChildren.data.children,
            )
          : null;
      const storedCompletion: CompletionInput =
        normalizedChildren === null
          ? completion
          : {
              ...completion,
              output: { children: normalizedChildren },
            };
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = ?, assignment_id = NULL, actor_id = NULL,
                  lease_expires_at = NULL, heartbeat_at = NULL, route = ?,
                  result_json = ?, checkpoint_json = NULL, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(
          dynamicChildren === null ? "done" : "waiting",
          completion.route ?? null,
          json(storedCompletion),
          at,
          runId,
          nodeId,
        );
      this.database.db
        .query(
          `UPDATE attempts
              SET status = 'done', result_json = ?, route = ?, finished_at = ?
            WHERE run_id = ? AND node_id = ? AND attempt = ?`,
        )
        .run(
          json(storedCompletion),
          completion.route ?? null,
          at,
          runId,
          nodeId,
          attempt,
        );
      if (assignmentId !== null) {
        this.internals.releaseAssignmentResources(assignmentId);
      }
      this.database.db
        .query(
          "DELETE FROM actor_focus WHERE actor_id = ? AND run_id = ? AND node_id = ?",
        )
        .run(actorId, runId, nodeId);

      const changes: Array<Record<string, unknown>> = [
        {
          nodeId,
          status: dynamicChildren === null ? "done" : "waiting",
          attempt,
        },
      ];
      const childChanges: RuntimeChange[] = [];
      if (normalizedChildren !== null) {
        this.internals.attachNormalizedSubgraphChildren(
          runId,
          nodeId,
          normalizedChildren,
          at,
          changes,
          childChanges,
        );
      } else if (nodeSpec.type === "decision") {
        const selected = this.internals.edgeRowsFrom(runId, nodeId).find(
          (edge) => optionalString(edge, "route") === completion.route,
        )!;
        const maxTraversals = optionalNumber(selected, "max_traversals");
        if (maxTraversals !== null) {
          const traversals = numberValue(selected, "traversals");
          if (traversals >= maxTraversals) {
            throw new BurnGraphError(
              "LOOP_LIMIT_REACHED",
              `Route ${completion.route} reached its ${maxTraversals} traversal limit`,
              false,
              { traversals, maxTraversals },
            );
          }
          this.internals.resetLoop(
            validated,
            runId,
            stringValue(selected, "edge_id"),
            nodeId,
            stringValue(selected, "to_node_id"),
            at,
            changes,
          );
        } else {
          this.internals.selectDecisionEdge(runId, nodeId, completion.route!, at);
          this.internals.cascade(validated, runId, at, changes);
          this.internals.driveStaticSubgraphs(
            runId,
            at,
            changes,
            childChanges,
          );
        }
      } else {
        this.internals.takeAllForwardEdges(runId, nodeId, at);
        this.internals.cascade(validated, runId, at, changes);
        this.internals.driveStaticSubgraphs(
          runId,
          at,
          changes,
          childChanges,
        );
      }
      this.internals.refreshRunTerminalStatus(runId, at);
      const revision = this.internals.bumpRun(runId, at, undefined, null);
      const sequence = this.internals.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.completed",
        summary: storedCompletion.summary,
        payload: {
          actorId,
          attempt,
          route: completion.route ?? null,
          evidence: storedCompletion.evidence,
          changes,
          revision,
        },
        at,
      });
      const mutationChanges: RuntimeChange[] = [
        ...childChanges,
        { revision, event: this.internals.getEvent(sequence) },
        ...this.internals.settleAncestors(runId, at),
      ];
      return { sequence, mutationChanges };
    });
    const quiesced = this.database.immediate(() =>
      this.internals.quiescePauseContainingRun(runId, at),
    );
    return {
      ...this.internals.mutationSnapshot(runId, completed.sequence),
      changes: [...completed.mutationChanges, ...quiesced],
    };
  }

  block(
    reference: string,
    nodeId: string,
    actorId: string,
    reason: string,
    expectation?: AssignmentExpectation,
  ): MutationResult<RuntimeNode> {
    return this.internals.stopNode(
      reference,
      nodeId,
      actorId,
      "blocked",
      reason,
      false,
      expectation,
    );
  }

  fail(
    reference: string,
    nodeId: string,
    actorId: string,
    reason: string,
    retry: boolean,
    expectation?: AssignmentExpectation,
  ): MutationResult<RuntimeNode> {
    return this.internals.stopNode(
      reference,
      nodeId,
      actorId,
      "failed",
      reason,
      retry,
      expectation,
    );
  }

  release(
    reference: string,
    nodeId: string,
    actorId: string,
    reason = "Released by actor.",
    expectation?: AssignmentExpectation,
  ): MutationResult<RuntimeNode> {
    return this.internals.stopNode(
      reference,
      nodeId,
      actorId,
      "ready",
      reason,
      false,
      expectation,
    );
  }

  unblock(
    reference: string,
    nodeId: string,
    expectation?: AssignmentExpectation,
  ): MutationResult<RuntimeNode> {
    const runId = this.internals.resolveRun(reference);
    const at = this.internals.timestamp();
    const sequence = this.database.immediate(() => {
      const node = this.internals.nodeRow(runId, nodeId);
      if (stringValue(node, "status") !== "blocked") {
        throw new BurnGraphError(
          "NODE_NOT_BLOCKED",
          `Node ${nodeId} is ${stringValue(node, "status")}`,
        );
      }
      if (
        expectation !== undefined &&
        numberValue(node, "attempt") !== expectation.attempt
      ) {
        throw new BurnGraphError(
          "ASSIGNMENT_STALE",
          `Assignment ${expectation.assignmentId} no longer owns the blocked Attempt`,
          false,
          {
            expectedAttempt: expectation.attempt,
            currentAttempt: numberValue(node, "attempt"),
          },
        );
      }
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = 'ready', last_error = NULL, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(at, runId, nodeId);
      const run = this.internals.runRow(runId);
      const revision = this.internals.bumpRun(runId, at);
      return this.internals.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.unblocked",
        summary: `Returned ${stringValue(node, "title")} to Ready.`,
        payload: { revision },
        at,
      });
    });
    return this.internals.mutationNode(runId, nodeId, sequence);
  }

  focus(
    reference: string,
    nodeId: string,
    actorId: string,
    expectation?: AssignmentExpectation,
  ): MutationResult<AssignmentPacket> {
    IdentifierSchema.parse(actorId);
    const runId = this.internals.resolveRun(reference);
    const at = this.internals.timestamp();
    const sequence = this.database.immediate(() => {
      const node = this.internals.requireOwnedRunningNode(
        runId,
        nodeId,
        actorId,
        new Date(at),
        expectation,
      );
      this.database.db
        .query(
          `INSERT INTO actor_focus (actor_id, run_id, node_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(actor_id) DO UPDATE SET
             run_id = excluded.run_id,
             node_id = excluded.node_id,
             updated_at = excluded.updated_at`,
        )
        .run(actorId, runId, nodeId, at);
      const run = this.internals.runRow(runId);
      const revision = this.internals.bumpRun(runId, at, undefined, nodeId);
      return this.internals.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.focused",
        summary: `${actorId} focused ${stringValue(node, "title")}.`,
        payload: { actorId, revision },
        at,
      });
    });
    const packet = this.internals.assignmentPacket(runId, nodeId, actorId);
    return {
      revision: this.internals.summaryForRun(runId).runtimeRevision,
      event: this.internals.getEvent(sequence),
      value: packet,
    };
  }

  actorWork(actorId: string): ActorWork {
    IdentifierSchema.parse(actorId);
    const focusedRow = this.database.db
      .query(
        `SELECT run_id, node_id
           FROM actor_focus
          WHERE actor_id = ?`,
      )
      .get(actorId) as Row | null;
    const rows = this.database.db
      .query(
        `SELECT n.run_id, r.graph_id, n.node_id, n.assignment_id, n.title,
                n.lease_expires_at
           FROM node_runs n
           JOIN runs r ON r.run_id = n.run_id
          WHERE n.actor_id = ? AND n.status = 'running'
          ORDER BY n.updated_at DESC`,
      )
      .all(actorId) as Row[];
    return {
      actorId,
      focused: focusedRow
        ? {
            runId: stringValue(focusedRow, "run_id"),
            nodeId: stringValue(focusedRow, "node_id"),
          }
        : null,
      claimed: rows.map((row) => ({
        runId: stringValue(row, "run_id"),
        graphId: stringValue(row, "graph_id"),
        nodeId: stringValue(row, "node_id"),
        assignmentId: stringValue(row, "assignment_id"),
        title: stringValue(row, "title"),
        leaseExpiresAt: stringValue(row, "lease_expires_at"),
      })),
    };
  }

  assignmentsForActor(actorId: string): readonly AssignmentPacket[] {
    const work = this.actorWork(actorId);
    const focused = work.focused;
    const claims = [...work.claimed]
      .sort((left, right) => {
        const leftFocused =
          focused?.runId === left.runId && focused.nodeId === left.nodeId;
        const rightFocused =
          focused?.runId === right.runId && focused.nodeId === right.nodeId;
        if (leftFocused !== rightFocused) return leftFocused ? -1 : 1;
        return left.assignmentId.localeCompare(right.assignmentId);
      });
    const packets: AssignmentPacket[] = [];
    for (const claim of claims) {
      try {
        const packet = this.internals.assignmentPacket(
          claim.runId,
          claim.nodeId,
          actorId,
        );
        if (packet.assignmentId === claim.assignmentId) packets.push(packet);
      } catch (error) {
        if (
          error instanceof BurnGraphError &&
          error.code === "NOT_NODE_OWNER"
        ) {
          continue;
        }
        throw error;
      }
    }
    return packets;
  }

  schedule(actorId: string, preferredRunId?: string): WorkSchedule {
    return this.database.immediate(() =>
      this.scheduleAtomic(actorId, preferredRunId),
    );
  }

  private scheduleAtomic(
    actorId: string,
    preferredRunId?: string,
  ): WorkSchedule {
    IdentifierSchema.parse(actorId);
    const changes: RuntimeChange[] = this.reconcileExpired().flatMap(
      (result) =>
        result.changes ?? [
          {
            revision: result.revision,
            event: result.event,
          },
        ],
    );
    const assignments = [...this.assignmentsForActor(actorId)];
    const assignmentOutputBlocks: Array<{
      readonly runId: string;
      readonly nodeId: string;
      readonly requestedBytes: number;
    }> = [];
    let assignmentOutputBlockedCount = 0;
    let availableSlots =
      this.config.maxAssignmentsPerActor - assignments.length;

    const saturatedRuns = new Set<string>();
    const candidates = orderReadyWork(
      this.listReady().filter((candidate) => candidate.eligibility.eligible),
      actorId,
      preferredRunId,
    );
    const rootOrder: string[] = [];
    const candidatesByRoot = new Map<string, ReadyWork[]>();
    for (const candidate of candidates) {
      const queue = candidatesByRoot.get(candidate.rootRunId);
      if (queue) {
        queue.push(candidate);
      } else {
        rootOrder.push(candidate.rootRunId);
        candidatesByRoot.set(candidate.rootRunId, [candidate]);
      }
    }

    while (availableSlots > 0 && rootOrder.length > 0) {
      let claimedInRound = false;
      for (const rootRunId of rootOrder) {
        if (availableSlots === 0) break;
        const queue = candidatesByRoot.get(rootRunId) ?? [];
        while (queue.length > 0) {
          const candidate = queue.shift()!;
          if (saturatedRuns.has(candidate.runId)) continue;
          try {
            const claimed = this.claim(
              candidate.runId,
              candidate.nodeId,
              actorId,
            );
            assignments.push(claimed.value);
            changes.push({
              revision: claimed.revision,
              event: claimed.event,
            });
            availableSlots -= 1;
            claimedInRound = true;
            break;
          } catch (error) {
            if (
              error instanceof BurnGraphError &&
              ["MAX_ACTIVE_REACHED", "RUN_NOT_RUNNING"].includes(error.code)
            ) {
              saturatedRuns.add(candidate.runId);
              continue;
            }
            if (
              error instanceof BurnGraphError &&
              error.code === "ACTOR_ASSIGNMENT_LIMIT_REACHED"
            ) {
              availableSlots = 0;
              break;
            }
            if (
              error instanceof BurnGraphError &&
              error.code === "ACTOR_ASSIGNMENT_OUTPUT_LIMIT"
            ) {
              assignmentOutputBlockedCount += 1;
              if (
                assignmentOutputBlocks.length <
                MAX_ASSIGNMENT_OUTPUT_BLOCK_SAMPLE
              ) {
                assignmentOutputBlocks.push({
                  runId: String(error.details["runId"] ?? candidate.runId),
                  nodeId: String(error.details["nodeId"] ?? candidate.nodeId),
                  requestedBytes: Number(
                    error.details["requestedBytes"] ?? 0,
                  ),
                });
              }
              if (
                assignmentOutputBlockedCount >=
                MAX_ASSIGNMENT_OUTPUT_BLOCK_PROBES
              ) {
                availableSlots = 0;
              }
              break;
            }
            if (
              error instanceof BurnGraphError &&
              error.retryable &&
              ["NODE_NOT_READY", "RESOURCE_BUSY"].includes(error.code)
            ) {
              continue;
            }
            throw error;
          }
        }
      }
      if (!claimedInRound) break;
    }

    const finalAssignments = [...this.assignmentsForActor(actorId)];
    const allRuns = this.listRuns();
    const activeRuns = allRuns.filter(
      (run) =>
        run.status === "running" ||
        run.status === "pausing" ||
        run.status === "paused" ||
        run.status === "cancelling",
    );
    const runCandidates = [
      ...(preferredRunId
        ? allRuns.filter((run) => run.runId === preferredRunId)
        : []),
      ...activeRuns,
    ];
    const seenRuns = new Set<string>();
    const runs = runCandidates
      .filter((run) => {
        if (seenRuns.has(run.runId)) return false;
        seenRuns.add(run.runId);
        return true;
      })
      .slice(0, MAX_SCHEDULE_RUN_SUMMARIES);
    const allRemainingReady = this.listReady();
    return {
      actorId,
      state: this.internals.scheduleState(finalAssignments, allRuns),
      assignments: finalAssignments,
      remainingReady: allRemainingReady.slice(
        0,
        MAX_SCHEDULE_READY_PREVIEW,
      ),
      remainingReadyCount: allRemainingReady.length,
      activeRunCount: activeRuns.length,
      runs,
      assignmentOutput: {
        maximumBytes: MAX_ACTOR_ASSIGNMENT_BYTES,
        usedBytes: serializedBytes(finalAssignments),
        limited: assignmentOutputBlockedCount > 0,
        blockedCount: assignmentOutputBlockedCount,
        blocked: assignmentOutputBlocks,
      },
      changes,
    };
  }

  observeSchedule(
    actorId: string,
    preferredRunId?: string,
  ): WorkSchedule {
    IdentifierSchema.parse(actorId);
    const assignments = this.assignmentsForActor(actorId);
    const allRuns = this.listRuns();
    const activeRuns = allRuns.filter(
      (run) =>
        run.status === "running" ||
        run.status === "pausing" ||
        run.status === "paused" ||
        run.status === "cancelling",
    );
    const candidates = [
      ...(preferredRunId
        ? allRuns.filter((run) => run.runId === preferredRunId)
        : []),
      ...activeRuns,
    ];
    const seenRuns = new Set<string>();
    const runs = candidates
      .filter((run) => {
        if (seenRuns.has(run.runId)) return false;
        seenRuns.add(run.runId);
        return true;
      })
      .slice(0, MAX_SCHEDULE_RUN_SUMMARIES);
    const remainingReady = this.listReady();
    return {
      actorId,
      state: this.internals.scheduleState(assignments, allRuns),
      assignments,
      remainingReady: remainingReady.slice(
        0,
        MAX_SCHEDULE_READY_PREVIEW,
      ),
      remainingReadyCount: remainingReady.length,
      activeRunCount: activeRuns.length,
      runs,
      assignmentOutput: {
        maximumBytes: MAX_ACTOR_ASSIGNMENT_BYTES,
        usedBytes: serializedBytes(assignments),
        limited: serializedBytes(assignments) > MAX_ACTOR_ASSIGNMENT_BYTES,
        blockedCount: 0,
        blocked: [],
      },
      changes: [],
    };
  }

  storeAssignmentContinuation(
    assignmentId: string,
    continuation: unknown,
  ): void {
    const result = this.database.db
      .query(
        `UPDATE attempts
            SET continuation_json = ?
          WHERE assignment_id = ?`,
      )
      .run(json(continuation), assignmentId);
    if (result.changes !== 1) {
      throw new BurnGraphError(
        "ASSIGNMENT_NOT_FOUND",
        `Unknown Assignment ${assignmentId}`,
      );
    }
  }

  storeLifecycleContinuation(
    operation: LifecycleOperation,
    idempotencyKey: string,
    continuation: unknown,
  ): void {
    const key = IdempotencyKeySchema.parse(idempotencyKey);
    const result = this.database.db
      .query(
        `UPDATE lifecycle_requests
            SET continuation_json = ?
          WHERE idempotency_key = ? AND operation = ?`,
      )
      .run(json(continuation), key, operation);
    if (result.changes !== 1) {
      throw new BurnGraphError(
        "IDEMPOTENCY_KEY_CONFLICT",
        `No ${operation} request owns idempotency key ${key}`,
      );
    }
  }

  signalContinuation(signalId: string): unknown | null {
    const row = this.database.db
      .query(
        `SELECT continuation_json
           FROM wait_signals
          WHERE signal_id = ?`,
      )
      .get(signalId) as Row | null;
    if (!row) {
      throw new BurnGraphError(
        "SIGNAL_NOT_FOUND",
        `Unknown Signal ${signalId}`,
      );
    }
    return parseJson(optionalString(row, "continuation_json"));
  }

  storeSignalContinuation(
    signalId: string,
    continuation: unknown,
  ): void {
    const result = this.database.db
      .query(
        `UPDATE wait_signals
            SET continuation_json = ?
          WHERE signal_id = ?`,
      )
      .run(json(continuation), signalId);
    if (result.changes !== 1) {
      throw new BurnGraphError(
        "SIGNAL_NOT_FOUND",
        `Unknown Signal ${signalId}`,
      );
    }
  }

  startWithAssignments(
    graphId: string,
    actorId: string,
    requestedRunId?: string,
  ): WorkSchedule & { readonly started: GraphSummary } {
    return this.database.immediate(() => {
      const started = this.startRun(graphId, requestedRunId);
      const runId = started.value.summary.runId;
      const scheduled = this.scheduleAtomic(actorId, runId);
      return {
        ...scheduled,
        started: this.internals.summaryForRun(runId),
        changes: [
          ...(started.changes ?? [
            { revision: started.revision, event: started.event },
          ]),
          ...scheduled.changes,
        ],
      };
    });
  }

  resumeWithAssignments(
    reference: string,
    actorId: string,
    idempotencyKey: string,
  ): ResumeContinuation {
    const key = IdempotencyKeySchema.parse(idempotencyKey);
    return this.database.immediate(() => {
      const resumed = this.resumeRun(reference, key);
      const runId = resumed.value.summary.runId;
      if (resumed.replayed) {
        const row = this.database.db
          .query(
            `SELECT continuation_json
               FROM lifecycle_requests
              WHERE idempotency_key = ? AND operation = 'resume'`,
          )
          .get(key) as Row | null;
        const stored = row
          ? parseJson<ResumeContinuation>(
              optionalString(row, "continuation_json"),
            )
          : null;
        if (stored) {
          if (stored.actorId !== actorId) {
            throw new BurnGraphError(
              "IDEMPOTENCY_KEY_CONFLICT",
              `Idempotency key ${key} already owns another resume Actor`,
              false,
              { actorId: stored.actorId },
            );
          }
          return { ...stored, replayed: true };
        }

        const observed = this.observeSchedule(actorId, runId);
        const fallback: ResumeContinuation = {
          ...observed,
          resumed: resumed.value.summary,
          replayed: true,
          changes:
            resumed.changes ?? [
              { revision: resumed.revision, event: resumed.event },
            ],
        };
        this.database.db
          .query(
            `UPDATE lifecycle_requests
                SET continuation_json = ?
              WHERE idempotency_key = ? AND operation = 'resume'`,
          )
          .run(json(fallback), key);
        return fallback;
      }

      const scheduled = this.scheduleAtomic(actorId, runId);
      const result: ResumeContinuation = {
        ...scheduled,
        resumed: this.internals.summaryForRun(runId),
        replayed: false,
        changes: [
          ...(resumed.changes ?? [
            { revision: resumed.revision, event: resumed.event },
          ]),
          ...scheduled.changes,
        ],
      };
      this.database.db
        .query(
          `UPDATE lifecycle_requests
              SET continuation_json = ?
            WHERE idempotency_key = ? AND operation = 'resume'`,
        )
        .run(json(result), key);
      return result;
    });
  }

  completeAndContinue(
    assignmentId: string,
    input: unknown,
  ): CompletionContinuation {
    return this.database.immediate(() =>
      this.completeAndContinueAtomic(assignmentId, input),
    );
  }

  private completeAndContinueAtomic(
    assignmentId: string,
    input: unknown,
  ): CompletionContinuation {
    const completion = CompletionInputSchema.parse(input);
    let identity = this.internals.assignmentIdentity(assignmentId);
    let replayed = false;
    const changes: RuntimeChange[] = [];

    if (identity.status === "done") {
      this.internals.requireMatchingReplay(identity, completion);
      const row = this.database.db
        .query(
          `SELECT continuation_json
             FROM attempts
            WHERE assignment_id = ?`,
        )
        .get(assignmentId) as Row | null;
      const stored = row
        ? parseJson<CompletionContinuation>(
            optionalString(row, "continuation_json"),
          )
        : null;
      if (stored) return { ...stored, replayed: true };
      replayed = true;
    } else if (identity.status === "running") {
      try {
        const completed = this.complete(
          identity.runId,
          identity.nodeId,
          identity.actorId,
          completion,
          {
            assignmentId,
            attempt: identity.attempt,
          },
        );
        changes.push(
          ...(completed.changes ?? [
            {
              revision: completed.revision,
              event: completed.event,
            },
          ]),
        );
        identity = this.internals.assignmentIdentity(assignmentId);
      } catch (error) {
        const current = this.internals.assignmentIdentity(assignmentId);
        if (current.status !== "done") throw error;
        this.internals.requireMatchingReplay(current, completion);
        identity = current;
        replayed = true;
      }
    } else {
      throw new BurnGraphError(
        "ASSIGNMENT_NOT_ACTIVE",
        `Assignment ${assignmentId} is ${identity.status}`,
        false,
        { status: identity.status },
      );
    }

    const scheduled = replayed
      ? this.observeSchedule(identity.actorId, identity.runId)
      : this.scheduleAtomic(identity.actorId, identity.runId);
    const result: CompletionContinuation = {
      ...scheduled,
      completed: {
        assignmentId,
        runId: identity.runId,
        nodeId: identity.nodeId,
        attempt: identity.attempt,
        result: identity.result ?? completion,
      },
      replayed,
      changes: [...changes, ...scheduled.changes],
    };
    this.database.db
      .query(
        `UPDATE attempts
            SET continuation_json = ?
          WHERE assignment_id = ?`,
      )
      .run(json(result), assignmentId);
    return result;
  }

  focusAssignment(assignmentId: string): MutationResult<AssignmentPacket> {
    const identity = this.internals.assignmentIdentity(assignmentId);
    return this.focus(identity.runId, identity.nodeId, identity.actorId, {
      assignmentId,
      attempt: identity.attempt,
    });
  }

  heartbeatAssignment(
    assignmentId: string,
  ): MutationResult<RuntimeNode> {
    const identity = this.internals.assignmentIdentity(assignmentId);
    return this.heartbeat(
      identity.runId,
      identity.nodeId,
      identity.actorId,
      undefined,
      { assignmentId, attempt: identity.attempt },
    );
  }

  checkpointAssignment(
    assignmentId: string,
    input: unknown,
  ): MutationResult<RuntimeNode> {
    const identity = this.internals.assignmentIdentity(assignmentId);
    return this.checkpoint(
      identity.runId,
      identity.nodeId,
      identity.actorId,
      input,
      { assignmentId, attempt: identity.attempt },
    );
  }

  blockAssignment(
    assignmentId: string,
    reason: string,
  ): WorkSchedule & { readonly blocked: RuntimeNode } {
    const identity = this.internals.assignmentIdentity(assignmentId);
    const blocked = this.block(
      identity.runId,
      identity.nodeId,
      identity.actorId,
      reason,
      { assignmentId, attempt: identity.attempt },
    );
    const scheduled = this.schedule(identity.actorId, identity.runId);
    return {
      ...scheduled,
      blocked: blocked.value,
      changes: [
        ...(blocked.changes ?? [
          { revision: blocked.revision, event: blocked.event },
        ]),
        ...scheduled.changes,
      ],
    };
  }

  releaseAssignment(
    assignmentId: string,
    reason: string,
  ): WorkSchedule & { readonly released: RuntimeNode } {
    const identity = this.internals.assignmentIdentity(assignmentId);
    const released = this.release(
      identity.runId,
      identity.nodeId,
      identity.actorId,
      reason,
      { assignmentId, attempt: identity.attempt },
    );
    const scheduled = this.schedule(identity.actorId, identity.runId);
    return {
      ...scheduled,
      released: released.value,
      changes: [
        ...(released.changes ?? [
          { revision: released.revision, event: released.event },
        ]),
        ...scheduled.changes,
      ],
    };
  }

  failAssignment(
    assignmentId: string,
    reason: string,
    retry: boolean,
  ): WorkSchedule & { readonly failed: RuntimeNode } {
    const identity = this.internals.assignmentIdentity(assignmentId);
    const failed = this.fail(
      identity.runId,
      identity.nodeId,
      identity.actorId,
      reason,
      retry,
      { assignmentId, attempt: identity.attempt },
    );
    const scheduled = this.schedule(identity.actorId, identity.runId);
    return {
      ...scheduled,
      failed: failed.value,
      changes: [
        ...(failed.changes ?? [
          { revision: failed.revision, event: failed.event },
        ]),
        ...scheduled.changes,
      ],
    };
  }

  unblockAssignment(
    assignmentId: string,
  ): WorkSchedule & { readonly unblocked: RuntimeNode } {
    const identity = this.internals.assignmentIdentity(assignmentId);
    if (identity.status !== "blocked") {
      throw new BurnGraphError(
        "ASSIGNMENT_NOT_BLOCKED",
        `Assignment ${assignmentId} is ${identity.status}`,
      );
    }
    const unblocked = this.unblock(
      identity.runId,
      identity.nodeId,
      { assignmentId, attempt: identity.attempt },
    );
    const scheduled = this.schedule(identity.actorId, identity.runId);
    return {
      ...scheduled,
      unblocked: unblocked.value,
      changes: [
        { revision: unblocked.revision, event: unblocked.event },
        ...scheduled.changes,
      ],
    };
  }

  reconcileExpired(
    reference?: string,
  ): readonly MutationResult<readonly RuntimeNode[]>[] {
    const at = this.internals.timestamp();
    const requestedRunId = reference ? this.internals.resolveRun(reference) : null;
    const runRows = requestedRunId
      ? ([{ run_id: requestedRunId }] as Row[])
      : (this.database.db
          .query(
            `SELECT DISTINCT run_id
               FROM node_runs
              WHERE status = 'running'
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= ?
              ORDER BY run_id`,
          )
          .all(at) as Row[]);
    const results: MutationResult<readonly RuntimeNode[]>[] = [];

    for (const runRow of runRows) {
      const runId = stringValue(runRow, "run_id");
      const reconciled = this.database.immediate(() => {
        const stale = this.database.db
          .query(
            `SELECT node_id, actor_id, assignment_id
               FROM node_runs
              WHERE run_id = ?
                AND status = 'running'
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= ?
              ORDER BY node_id`,
          )
          .all(runId, at) as Row[];
        if (stale.length === 0) return null;

        for (const row of stale) {
          const nodeId = stringValue(row, "node_id");
          const actorId = optionalString(row, "actor_id");
          const assignmentId = optionalString(row, "assignment_id");
          const node = this.internals.nodeRow(runId, nodeId);
          const attempt = numberValue(node, "attempt");
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
                  SET status = 'ready', assignment_id = NULL, actor_id = NULL,
                      lease_expires_at = NULL, heartbeat_at = NULL,
                      last_error = 'Lease expired', updated_at = ?
                WHERE run_id = ? AND node_id = ?`,
            )
            .run(at, runId, nodeId);
          if (actorId !== null) {
            this.database.db
              .query(
                `DELETE FROM actor_focus
                  WHERE actor_id = ? AND run_id = ? AND node_id = ?`,
              )
              .run(actorId, runId, nodeId);
          }
          if (assignmentId !== null) {
            this.internals.releaseAssignmentResources(assignmentId);
          }
        }

        const run = this.internals.runRow(runId);
        const revision = this.internals.bumpRun(runId, at);
        const sequence = this.internals.appendEvent({
          runId,
          graphId: stringValue(run, "graph_id"),
          nodeId: null,
          type: "claims.reconciled",
          summary: `Reopened ${stale.length} expired claim(s).`,
          payload: {
            nodes: stale.map((row) => stringValue(row, "node_id")),
            revision,
          },
          at,
        });
        return {
          sequence,
          revision,
          nodeIds: stale.map((row) => stringValue(row, "node_id")),
        };
      });
      if (!reconciled) continue;

      const quiesced = this.database.immediate(() =>
        this.internals.quiescePauseContainingRun(runId, at),
      );
      const snapshot = this.getSnapshot(runId);
      const reconciledChange = {
        revision: reconciled.revision,
        event: this.internals.getEvent(reconciled.sequence),
      };
      results.push({
        revision: reconciled.revision,
        event: reconciledChange.event,
        value: snapshot.nodes.filter((node) =>
          reconciled.nodeIds.includes(node.id),
        ),
        changes: [reconciledChange, ...quiesced],
      });
    }
    return results;
  }

  listEvents(
    reference?: string,
    afterSequence = 0,
    limit = 100,
  ): readonly GraphEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new BurnGraphError("INVALID_LIMIT", "Event limit must be 1-1000");
    }
    let rows: Row[];
    if (reference) {
      const runId = this.internals.resolveRun(reference);
      rows = this.database.db
        .query(
          `SELECT *
             FROM events
            WHERE run_id = ? AND sequence > ?
            ORDER BY sequence
            LIMIT ?`,
        )
        .all(runId, afterSequence, limit) as Row[];
    } else {
      rows = this.database.db
        .query(
          `SELECT *
             FROM events
            WHERE sequence > ?
            ORDER BY sequence
            LIMIT ?`,
        )
        .all(afterSequence, limit) as Row[];
    }
    return rows.map((row) => this.internals.eventFromRow(row));
  }

  inspectOverview(options: PortfolioOverviewOptions): PortfolioOverview {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 1_000
    ) {
      throw new BurnGraphError(
        "INVALID_LIMIT",
        "Overview limit must be 1-1000",
      );
    }
    if (
      options.depth !== undefined &&
      (!Number.isInteger(options.depth) ||
        options.depth < 0 ||
        options.depth > this.config.maxHierarchyDepth)
    ) {
      throw new BurnGraphError(
        "INVALID_DEPTH",
        `Overview depth must be 0-${this.config.maxHierarchyDepth}`,
      );
    }
    return this.database.read(() => {
      const project = this.projectSnapshot();
      const selectedRunId = options.run
        ? this.internals.resolveRun(options.run)
        : null;
      const selectedRootRunId = options.root
        ? this.getSnapshot(options.root, 0).summary.rootRunId
        : null;
      const summaries = new Map(
        project.runs.map((summary) => [summary.runId, summary]),
      );
      const rootPriority = (summary: GraphSummary): RunPriority =>
        summaries.get(summary.rootRunId)?.priority ?? summary.priority;
      const candidateRuns = project.runs.filter(
        (summary) =>
          (selectedRunId === null || summary.runId === selectedRunId) &&
          (selectedRootRunId === null ||
            summary.rootRunId === selectedRootRunId) &&
          (options.runStatus === undefined ||
            summary.status === options.runStatus) &&
          (options.depth === undefined || summary.depth === options.depth) &&
          (options.priority === undefined ||
            rootPriority(summary) === options.priority),
      );
      const readyByNode = new Map(
        this.listReady().map((candidate) => [
          `${candidate.runId}\u0000${candidate.nodeId}`,
          candidate,
        ]),
      );
      const locksByNode = new Map<string, string[]>();
      const activeResources = new Set<string>();
      const lockRows = this.database.db
        .query(
          `SELECT run_id, node_id, resource
             FROM resource_locks
            ORDER BY resource`,
        )
        .all() as Row[];
      for (const lock of lockRows) {
        activeResources.add(stringValue(lock, "resource"));
        const key = `${stringValue(lock, "run_id")}\u0000${stringValue(lock, "node_id")}`;
        locksByNode.set(key, [
          ...(locksByNode.get(key) ?? []),
          stringValue(lock, "resource"),
        ]);
      }
      const matchingNodes: PortfolioOverviewNode[] = [];
      for (const summary of candidateRuns) {
        const snapshot = this.getSnapshot(summary.runId, 0);
        for (const node of snapshot.nodes) {
          if (!options.nodeStatuses.includes(node.status)) continue;
          if (options.actor !== undefined && node.actorId !== options.actor) {
            continue;
          }
          const spec = snapshot.spec.nodes.find(
            (candidate) => candidate.id === node.id,
          );
          if (!spec) continue;
          if (options.tag !== undefined && !spec.tags.includes(options.tag)) {
            continue;
          }
          const key = `${summary.runId}\u0000${node.id}`;
          const ready = readyByNode.get(key);
          const declaredResources =
            "resources" in spec && Array.isArray(spec.resources)
              ? spec.resources
              : [];
          const checkResources =
            spec.type === "gate" && spec.check
              ? this.getCheck(spec.check.id, spec.check.revision).resources
              : [];
          const resources = [
            ...new Set([
              ...declaredResources,
              ...checkResources,
              ...(ready?.resources ?? []),
              ...(locksByNode.get(key) ?? []),
            ]),
          ].sort();
          if (
            options.resource !== undefined &&
            !resources.includes(options.resource)
          ) {
            continue;
          }
          matchingNodes.push({
            runId: summary.runId,
            rootRunId: summary.rootRunId,
            graphId: summary.graphId,
            depth: summary.depth,
            priority: rootPriority(summary),
            nodeId: node.id,
            type: node.type,
            title: node.title,
            status: node.status,
            attempt: node.attempt,
            assignmentId: node.assignmentId,
            actorId: node.actorId,
            tags: spec.tags,
            resources,
            eligibility:
              ready?.eligibility ??
              (node.status === "ready" && spec.type === "gate"
                ? resourceEligibility(resources, activeResources)
                : null),
            updatedAt: node.updatedAt,
          });
        }
      }
      const nodeScoped =
        options.actor !== undefined ||
        options.tag !== undefined ||
        options.resource !== undefined;
      const nodeMatchedRunIds = new Set(
        matchingNodes.map((node) => node.runId),
      );
      const matchingRuns = nodeScoped
        ? candidateRuns.filter((summary) =>
            nodeMatchedRunIds.has(summary.runId),
          )
        : candidateRuns;
      return {
        schemaVersion: 1,
        projectId: project.projectId,
        capturedAt: project.capturedAt,
        filters: {
          run: selectedRunId,
          root: selectedRootRunId,
          runStatus: options.runStatus ?? null,
          nodeStatuses: options.nodeStatuses,
          actor: options.actor ?? null,
          tag: options.tag ?? null,
          resource: options.resource ?? null,
          priority: options.priority ?? null,
          depth: options.depth ?? null,
          limit: options.limit,
        },
        totals: {
          graphs: project.graphs.length,
          matchingRuns: matchingRuns.length,
          listedRuns: Math.min(matchingRuns.length, options.limit),
          matchingNodes: matchingNodes.length,
          listedNodes: Math.min(matchingNodes.length, options.limit),
        },
        truncated: {
          runs: matchingRuns.length > options.limit,
          nodes: matchingNodes.length > options.limit,
        },
        runs: matchingRuns.slice(0, options.limit).map((summary) => ({
          ...summary,
          rootPriority: rootPriority(summary),
        })),
        nodes: matchingNodes.slice(0, options.limit),
        metrics: this.inspectMetrics(
          selectedRootRunId ?? selectedRunId ?? undefined,
        ),
        lastEventSequence: project.lastEventSequence,
      };
    });
  }

  inspectMetrics(reference?: string): RuntimeMetrics {
    return this.database.read(() => {
      const scopeRunId = reference ? this.internals.resolveRun(reference) : null;
      const runIds =
        scopeRunId === null
          ? this.listRuns().map((run) => run.runId)
          : this.internals.descendantRunRows(scopeRunId).map((row) =>
              stringValue(row, "run_id"),
            );
      return deriveRuntimeMetrics({
        database: this.database,
        runIds,
        scopeRunId,
        ready: this.listReadyResourceMetrics(),
        now: this.now(),
      });
    });
  }

  projectSnapshot(): {
    readonly projectId: string;
    readonly graphs: ReturnType<BurnGraphServiceBase["listGraphs"]>;
    readonly runs: readonly GraphSummary[];
    readonly rootRuns: readonly PortfolioRun[];
    readonly lastEventSequence: number;
    readonly capturedAt: string;
    readonly metrics: RuntimeMetrics;
  } {
    return this.database.read(() => {
      const row = this.database.db
      .query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events")
      .get() as Row;
      const runs = this.listRuns();
      const byRunId = new Map(runs.map((run) => [run.runId, run]));
      const directChildren = new Map<string, number>();
      const descendants = new Map<string, number>();
      for (const run of runs) {
        directChildren.set(run.runId, 0);
        descendants.set(run.runId, 0);
      }
      for (const run of runs) {
        let parentRunId = run.parentRunId;
        if (parentRunId !== null && byRunId.has(parentRunId)) {
          directChildren.set(
            parentRunId,
            (directChildren.get(parentRunId) ?? 0) + 1,
          );
        }
        while (parentRunId !== null && byRunId.has(parentRunId)) {
          descendants.set(
            parentRunId,
            (descendants.get(parentRunId) ?? 0) + 1,
          );
          parentRunId = byRunId.get(parentRunId)?.parentRunId ?? null;
        }
      }
      return {
        projectId: this.config.projectId,
        graphs: this.listGraphs(),
        runs,
        rootRuns: runs
          .filter((run) => run.parentRunId === null)
          .map((summary) => ({
            summary,
            directChildRuns: directChildren.get(summary.runId) ?? 0,
            descendantRuns: descendants.get(summary.runId) ?? 0,
          })),
        lastEventSequence: numberValue(row, "sequence"),
        capturedAt: this.internals.timestamp(),
        metrics: this.inspectMetrics(),
      };
    });
  }

}
