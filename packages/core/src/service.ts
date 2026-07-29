import { z } from "zod";

import {
  BurnGraphError,
  CheckpointInputSchema,
  CompletionInputSchema,
  DynamicSubgraphOutputSchema,
  GraphStatusSchema,
  IdempotencyKeySchema,
  IdentifierSchema,
  NodeStatusSchema,
  RunPrioritySchema,
  type ActorWork,
  type AssignmentPacket,
  type CheckSpec,
  type CheckpointInput,
  type ChildRunDescriptor,
  type CompletionInput,
  type CompletionContinuation,
  type GraphCounts,
  type GraphEvent,
  type GraphSnapshot,
  type GraphSpec,
  type GraphStatus,
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
  type RunTreeEntry,
  type RuntimeChange,
  type RuntimeEdge,
  type RuntimeNode,
  type RuntimeMetrics,
  type RunPriority,
  type TemplateInstantiationReceipt,
  type TemplateInstantiationRequest,
  type WorkSchedule,
} from "./contracts.ts";
import { gateResources, validateCheckSpec } from "./gate.ts";
import { deriveRuntimeMetrics } from "./metrics.ts";
import { renderMermaid, renderTreeMermaid } from "./mermaid.ts";
import {
  discoverProjectRoot,
  readProjectConfig,
  writeCheckSpec,
  writeGraphSpec,
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
  effectivePriority,
  orderReadyWork,
} from "./scheduler.ts";
import { BurnGraphDatabase } from "./storage.ts";
import {
  recoverTemplateTransactions,
  TemplateRegistry,
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
    recoverTemplateTransactions(this.root, this.database);
  }

  close(): void {
    this.database.close();
  }

  validateGraph(input: unknown): GraphSpec {
    return validateGraphSpec(input).spec;
  }

  applyGraph(input: unknown): GraphSpec {
    const validated = validateGraphSpec(input);
    const spec = validated.spec;
    this.validateCheckReferences(spec);
    this.validateHierarchyReferences(spec);
    const at = this.timestamp();
    this.database.immediate(() => {
      const latest = this.database.db
        .query(
          `SELECT revision
             FROM graph_specs
            WHERE graph_id = ?
            ORDER BY revision DESC
            LIMIT 1`,
        )
        .get(spec.id) as Row | null;
      if (latest && numberValue(latest, "revision") >= spec.revision) {
        throw new BurnGraphError(
          "STALE_GRAPH_REVISION",
          `Graph ${spec.id} already has revision ${numberValue(latest, "revision")}`,
          true,
          { submittedRevision: spec.revision },
        );
      }
      this.database.db
        .query(
          `INSERT INTO graph_specs (
             graph_id, revision, document_json, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(spec.id, spec.revision, json(spec), at);
    });
    try {
      writeGraphSpec(this.root, spec);
    } catch (error) {
      this.database.immediate(() => {
        this.database.db
          .query(
            `DELETE FROM graph_specs
              WHERE graph_id = ? AND revision = ?`,
          )
          .run(spec.id, spec.revision);
      });
      throw error;
    }
    return spec;
  }

  instantiateTemplate(
    request: TemplateInstantiationRequest,
  ): TemplateInstantiationReceipt {
    return new TemplateRegistry({
      root: this.root,
      database: this.database,
      timestamp: () => this.timestamp(),
      validateGraph: (input) => this.validateGraph(input),
      validateReferences: (spec) => {
        this.validateCheckReferences(spec);
        this.validateHierarchyReferences(spec);
      },
    }).instantiate(request);
  }

  private validateHierarchyReferences(spec: GraphSpec): void {
    if (spec.schemaVersion !== 2) return;

    let descendantCount = 0;
    const visit = (
      current: GraphSpec,
      ancestors: ReadonlySet<string>,
      depth: number,
    ): void => {
      for (const node of current.nodes) {
        if (node.type !== "subgraph" || node.mode !== "static") continue;
        for (const child of node.children ?? []) {
          descendantCount += 1;
          if (depth + 1 > this.config.maxHierarchyDepth) {
            throw new BurnGraphError(
              "HIERARCHY_LIMIT",
              `Graph ${spec.id} exceeds hierarchy depth ${this.config.maxHierarchyDepth}`,
              false,
              {
                graphId: spec.id,
                depth: depth + 1,
                limit: this.config.maxHierarchyDepth,
              },
            );
          }
          if (descendantCount > this.config.maxUnfinishedDescendants) {
            throw new BurnGraphError(
              "HIERARCHY_LIMIT",
              `Graph ${spec.id} exceeds ${this.config.maxUnfinishedDescendants} static descendants`,
              false,
              {
                graphId: spec.id,
                descendants: descendantCount,
                limit: this.config.maxUnfinishedDescendants,
              },
            );
          }
          if (ancestors.has(child.graphId)) {
            throw new BurnGraphError(
              "HIERARCHY_CYCLE",
              `Graph ${child.graphId} repeats in a static ancestry chain`,
              false,
              {
                graphId: child.graphId,
                parentGraphId: current.id,
                nodeId: node.id,
              },
            );
          }
          const childSpec = this.loadGraph(
            child.graphId,
            child.revision,
          ).spec;
          visit(
            childSpec,
            new Set([...ancestors, child.graphId]),
            depth + 1,
          );
        }
      }
    };

    visit(spec, new Set([spec.id]), 0);
  }

  listGraphs(): readonly {
    readonly id: string;
    readonly title: string;
    readonly goal: string;
    readonly revision: number;
    readonly latestRun: GraphSummary | null;
  }[] {
    return this.database.read(() => {
      const rows = this.database.db
        .query(
          `SELECT s.graph_id, s.revision, s.document_json
             FROM graph_specs s
             JOIN (
               SELECT graph_id, MAX(revision) AS revision
                 FROM graph_specs
                GROUP BY graph_id
             ) latest
               ON latest.graph_id = s.graph_id
              AND latest.revision = s.revision
            ORDER BY s.graph_id`,
        )
        .all() as Row[];
      return rows.map((row) => {
        const spec = validateGraphSpec(
          JSON.parse(stringValue(row, "document_json")),
        ).spec;
        const latestRun = this.tryResolveRun(spec.id);
        return {
          id: spec.id,
          title: spec.title,
          goal: spec.goal,
          revision: spec.revision,
          latestRun: latestRun ? this.summaryForRun(latestRun) : null,
        };
      });
    });
  }

  getGraph(graphId: string): GraphSpec {
    return this.loadGraph(graphId).spec;
  }

  validateCheck(input: unknown): CheckSpec {
    return validateCheckSpec(input);
  }

  applyCheck(input: unknown): CheckSpec {
    const spec = validateCheckSpec(input);
    const at = this.timestamp();
    this.database.immediate(() => {
      const latest = this.database.db
        .query(
          `SELECT revision
             FROM check_specs
            WHERE check_id = ?
            ORDER BY revision DESC
            LIMIT 1`,
        )
        .get(spec.id) as Row | null;
      if (latest && numberValue(latest, "revision") >= spec.revision) {
        throw new BurnGraphError(
          "STALE_CHECK_REVISION",
          `Check ${spec.id} already has revision ${numberValue(latest, "revision")}`,
          true,
          { submittedRevision: spec.revision },
        );
      }
      this.database.db
        .query(
          `INSERT INTO check_specs (
             check_id, revision, document_json, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(spec.id, spec.revision, json(spec), at);
    });
    try {
      writeCheckSpec(this.root, spec);
    } catch (error) {
      this.database.immediate(() => {
        this.database.db
          .query(
            `DELETE FROM check_specs
              WHERE check_id = ? AND revision = ?`,
          )
          .run(spec.id, spec.revision);
      });
      throw error;
    }
    return spec;
  }

  listChecks(): readonly CheckSpec[] {
    return this.database.read(() => {
      const rows = this.database.db
        .query(
          `SELECT c.document_json
             FROM check_specs c
             JOIN (
               SELECT check_id, MAX(revision) AS revision
                 FROM check_specs
                GROUP BY check_id
             ) latest
               ON latest.check_id = c.check_id
              AND latest.revision = c.revision
            ORDER BY c.check_id`,
        )
        .all() as Row[];
      return rows.map((row) =>
        validateCheckSpec(JSON.parse(stringValue(row, "document_json"))),
      );
    });
  }

  getCheck(checkId: string, revision?: number): CheckSpec {
    return this.loadCheck(checkId, revision);
  }

  cloneGraph(sourceId: string, targetId: string, title?: string): GraphSpec {
    IdentifierSchema.parse(targetId);
    const source = this.loadGraph(sourceId).spec;
    return this.applyGraph({
      ...source,
      id: targetId,
      title: title ?? `${source.title} copy`,
      revision: 1,
    });
  }

  private validateCheckReferences(spec: GraphSpec): void {
    for (const node of spec.nodes) {
      if (node.type !== "gate" || !node.check) continue;
      this.loadCheck(node.check.id, node.check.revision);
    }
  }

  startRun(graphId: string, requestedRunId?: string): MutationResult<GraphSnapshot> {
    const validated = this.loadGraph(graphId);
    this.validateCheckReferences(validated.spec);
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
        this.insertEdge(runId, edge, at);
      }

      const start = validated.spec.nodes.find((node) => node.type === "start")!;
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = 'done', attempt = 1, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(at, runId, start.id);
      this.takeAllForwardEdges(runId, start.id, at);
      const changes = [{ nodeId: start.id, status: "done" }];
      const childChanges: RuntimeChange[] = [];
      this.cascade(validated, runId, at, changes);
      this.driveStaticSubgraphs(runId, at, changes, childChanges);
      this.refreshRunTerminalStatus(runId, at);
      const sequence = this.appendEvent({
        runId,
        graphId,
        nodeId: start.id,
        type: "run.started",
        summary: `Started ${validated.spec.title} at revision ${validated.spec.revision}.`,
        payload: { changes },
        at,
      });
      const rootChange = {
        revision: numberValue(this.runRow(runId), "runtime_revision"),
        event: this.getEvent(sequence),
      };
      return {
        sequence,
        changes: [...childChanges, rootChange],
      };
    });

    const snapshot = this.getSnapshot(runId);
    return {
      revision: snapshot.summary.runtimeRevision,
      event: this.getEvent(started.sequence),
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
        this.summaryForRun(stringValue(row, "run_id")),
      );
    });
  }

  getSnapshot(reference: string, eventLimit = 100): GraphSnapshot {
    return this.database.read(() =>
      this.readSnapshot(reference, eventLimit),
    );
  }

  private readSnapshot(reference: string, eventLimit: number): GraphSnapshot {
    const runId = this.resolveRun(reference);
    const summary = this.summaryForRun(runId);
    const spec = this.loadGraph(summary.graphId, summary.specRevision).spec;
    const nodes = this.nodesForRun(runId, spec);
    const edges = this.edgesForRun(runId);
    return {
      summary,
      spec,
      nodes,
      edges,
      events:
        eventLimit === 0 ? [] : this.recentEventsForRun(runId, eventLimit),
      mermaid: renderMermaid(spec, nodes, edges),
    };
  }

  getTreeSnapshot(
    reference: string,
    depth = 0,
    limit = 500,
    eventLimit = 100,
  ): GraphTreeSnapshot {
    if (
      !Number.isInteger(depth) ||
      depth < 0 ||
      depth > this.config.maxHierarchyDepth
    ) {
      throw new BurnGraphError(
        "PROJECTION_LIMIT",
        `Tree depth must be 0-${this.config.maxHierarchyDepth}`,
        false,
        { depth, maximumDepth: this.config.maxHierarchyDepth },
      );
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new BurnGraphError(
        "PROJECTION_LIMIT",
        "Tree projection limit must be 1-500",
        false,
        { limit, maximum: 500 },
      );
    }

    return this.database.read(() =>
      this.readTreeSnapshot(reference, depth, limit, eventLimit),
    );
  }

  private readTreeSnapshot(
    reference: string,
    depth: number,
    limit: number,
    eventLimit: number,
  ): GraphTreeSnapshot {
    const runId = this.resolveRun(reference);
    const rows = this.database.db
      .query(
        `WITH RECURSIVE tree (
           run_id, parent_run_id, parent_node_id, relative_depth,
           path, label, trail
         ) AS (
           SELECT r.run_id, r.parent_run_id, r.parent_node_id, 0,
                  '', NULL, ',' || r.run_id || ','
             FROM runs r
            WHERE r.run_id = ?
           UNION ALL
           SELECT child.run_id, child.parent_run_id, child.parent_node_id,
                  tree.relative_depth + 1,
                  tree.path || '/' || printf('%03d', link.position) ||
                    ':' || child.run_id,
                  link.label,
                  tree.trail || child.run_id || ','
             FROM tree
             JOIN subgraph_links link
               ON link.parent_run_id = tree.run_id
             JOIN runs child
               ON child.run_id = link.child_run_id
            WHERE instr(tree.trail, ',' || child.run_id || ',') = 0
         )
         SELECT run_id, parent_run_id, parent_node_id, relative_depth,
                path, label
           FROM tree
          ORDER BY path
          LIMIT ?`,
      )
      .all(runId, MAX_TREE_PROJECTION_RUNS + 1) as Row[];
    if (rows.length > MAX_TREE_PROJECTION_RUNS) {
      throw new BurnGraphError(
        "PROJECTION_LIMIT",
        `Tree ${runId} exceeds the ${MAX_TREE_PROJECTION_RUNS}-Run projection bound`,
        false,
        {
          runId,
          maximumRuns: MAX_TREE_PROJECTION_RUNS,
          minimumRuns: MAX_TREE_PROJECTION_RUNS + 1,
        },
      );
    }

    const root = this.readSnapshot(runId, eventLimit);
    const visibleRows = rows.filter(
      (row) => numberValue(row, "relative_depth") <= depth + 1,
    );
    const summaries = visibleRows.map((row) => {
      const candidateRunId = stringValue(row, "run_id");
      return {
        summary:
          candidateRunId === runId
            ? root.summary
            : this.summaryForRun(candidateRunId),
        label: optionalString(row, "label"),
        relativeDepth: numberValue(row, "relative_depth"),
      };
    });
    const byRunId = new Map(
      rows.map((row) => [
        stringValue(row, "run_id"),
        optionalString(row, "parent_run_id"),
      ]),
    );
    const visibleRunIds = new Set(
      summaries.map((candidate) => candidate.summary.runId),
    );
    const directChildren = new Map<string, number>();
    const descendants = new Map<string, number>();
    for (const candidate of summaries) {
      directChildren.set(candidate.summary.runId, 0);
      descendants.set(candidate.summary.runId, 0);
    }
    for (const row of rows) {
      let parentRunId = optionalString(row, "parent_run_id");
      if (parentRunId !== null && visibleRunIds.has(parentRunId)) {
        directChildren.set(
          parentRunId,
          (directChildren.get(parentRunId) ?? 0) + 1,
        );
      }
      while (parentRunId !== null && byRunId.has(parentRunId)) {
        if (visibleRunIds.has(parentRunId)) {
          descendants.set(
            parentRunId,
            (descendants.get(parentRunId) ?? 0) + 1,
          );
        }
        parentRunId = byRunId.get(parentRunId) ?? null;
      }
    }

    let renderedNodes = 0;
    const entries: RunTreeEntry[] = summaries.map((candidate) => {
      const folded = candidate.relativeDepth > depth;
      let topology: RunTreeEntry["topology"] = null;
      if (folded) {
        renderedNodes += 1;
      } else if (candidate.summary.runId === runId) {
        topology = {
          spec: root.spec,
          nodes: root.nodes,
          edges: root.edges,
        };
        renderedNodes += root.nodes.length;
      } else {
        const spec = this.loadGraph(
          candidate.summary.graphId,
          candidate.summary.specRevision,
        ).spec;
        const nodes = this.nodesForRun(candidate.summary.runId, spec);
        const edges = this.edgesForRun(candidate.summary.runId);
        topology = { spec, nodes, edges };
        renderedNodes += nodes.length;
      }
      return {
        ...candidate,
        folded,
        directChildRuns: directChildren.get(candidate.summary.runId) ?? 0,
        descendantRuns: descendants.get(candidate.summary.runId) ?? 0,
        topology,
      };
    });
    if (renderedNodes > limit) {
      throw new BurnGraphError(
        "PROJECTION_LIMIT",
        `Tree ${runId} needs ${renderedNodes} rendered nodes`,
        false,
        { runId, limit, renderedNodes, depth },
      );
    }

    const latestEvent = numberValue(
      this.database.db
        .query(
          `WITH RECURSIVE tree(run_id) AS (
             SELECT ?
             UNION ALL
             SELECT child.run_id
               FROM runs child
               JOIN tree ON child.parent_run_id = tree.run_id
           )
           SELECT COALESCE(MAX(events.sequence), 0) AS sequence
             FROM tree
             LEFT JOIN events ON events.run_id = tree.run_id`,
        )
        .get(runId) as Row,
      "sequence",
    );
    const maximumDepth = rows.reduce(
      (maximum, row) =>
        Math.max(maximum, numberValue(row, "relative_depth")),
      0,
    );
    const expandedRuns = rows.filter(
      (row) => numberValue(row, "relative_depth") <= depth,
    ).length;
    return {
      schemaVersion: 1,
      root,
      treeRootRunId: runId,
      runs: entries,
      projection: {
        depth,
        maximumDepth,
        limit,
        totalRuns: rows.length,
        expandedRuns,
        foldedRuns: rows.length - expandedRuns,
        renderedNodes,
        lastEventSequence: latestEvent,
        capturedAt: this.timestamp(),
      },
      mermaid: renderTreeMermaid(entries),
    };
  }

  inspectNode(reference: string, nodeId: string, eventLimit = 50): {
    readonly summary: GraphSummary;
    readonly spec: GraphSpec["nodes"][number];
    readonly runtime: RuntimeNode;
    readonly incoming: readonly RuntimeEdge[];
    readonly outgoing: readonly RuntimeEdge[];
    readonly attempts: readonly {
      readonly attempt: number;
      readonly assignmentId: string | null;
      readonly status: string;
      readonly actorId: string | null;
      readonly result: CompletionInput | null;
      readonly checkpoint: CheckpointInput | null;
      readonly route: string | null;
      readonly startedAt: string;
      readonly finishedAt: string | null;
    }[];
    readonly events: readonly GraphEvent[];
  } {
    const runId = this.resolveRun(reference);
    const snapshot = this.getSnapshot(runId, eventLimit);
    const spec = snapshot.spec.nodes.find((node) => node.id === nodeId);
    const runtime = snapshot.nodes.find((node) => node.id === nodeId);
    if (!spec || !runtime) {
      throw new BurnGraphError("NODE_NOT_FOUND", `Unknown node ${nodeId}`);
    }
    const attempts = this.database.db
      .query(
        `SELECT attempt, assignment_id, status, actor_id, result_json,
                checkpoint_json, route, started_at, finished_at
           FROM attempts
          WHERE run_id = ? AND node_id = ?
          ORDER BY attempt`,
      )
      .all(runId, nodeId) as Row[];
    return {
      summary: snapshot.summary,
      spec,
      runtime,
      incoming: snapshot.edges.filter((edge) => edge.to === nodeId),
      outgoing: snapshot.edges.filter((edge) => edge.from === nodeId),
      attempts: attempts.map((row) => ({
        attempt: numberValue(row, "attempt"),
        assignmentId: optionalString(row, "assignment_id"),
        status: stringValue(row, "status"),
        actorId: optionalString(row, "actor_id"),
        result: parseJson<CompletionInput>(optionalString(row, "result_json")),
        checkpoint: parseJson<CheckpointInput>(
          optionalString(row, "checkpoint_json"),
        ),
        route: optionalString(row, "route"),
        startedAt: stringValue(row, "started_at"),
        finishedAt: optionalString(row, "finished_at"),
      })),
      events: snapshot.events.filter(
        (event) => event.nodeId === null || event.nodeId === nodeId,
      ),
    };
  }

  pauseRun(
    reference: string,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.executeLifecycleMutation(
      "pause",
      reference,
      idempotencyKey,
      (runId, at) => {
      const target = this.runRow(runId);
      if (stringValue(target, "status") !== "running") {
        throw new BurnGraphError(
          "INVALID_RUN_STATE",
          `Cannot pause ${runId} from ${stringValue(target, "status")}`,
        );
      }
      const tree = this.descendantRunRows(runId).filter((row) =>
        stringValue(row, "status") === "running",
      );
      const conflicting = this.descendantRunRows(runId).find(
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
      const live = this.database.db
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
      this.database.db
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
          this.runRow(affectedRunId),
          "runtime_revision",
        );
        const sequence = this.appendEvent({
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
        changes.push({ revision, event: this.getEvent(sequence) });
      }
      return { rootSequence, changes };
      },
    );
  }

  resumeRun(
    reference: string,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.executeLifecycleMutation(
      "resume",
      reference,
      idempotencyKey,
      (runId, at) => {
      const target = this.runRow(runId);
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
      const tree = this.descendantRunRows(runId).filter((row) =>
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
        const signals = this.database.db
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
          this.database.db
            .query(
              `UPDATE wait_signals
                  SET deadline_at = ?, updated_at = ?
                WHERE signal_id = ?`,
            )
            .run(shifted, at, stringValue(signal, "signal_id"));
        }
      }
      this.database.db
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
      this.database.db
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
        this.driveStaticSubgraphs(
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
          this.runRow(affectedRunId),
          "runtime_revision",
        );
        const sequence = this.appendEvent({
          runId: affectedRunId,
          graphId: stringValue(row, "graph_id"),
          nodeId: null,
          type: "run.resumed",
          summary: `Resumed run ${affectedRunId}.`,
          payload: { rootRequestRunId: runId, revision },
          at,
        });
        if (affectedRunId === runId) rootSequence = sequence;
        changes.push({ revision, event: this.getEvent(sequence) });
      }
      return { rootSequence, changes };
      },
    );
  }

  cancelRun(
    reference: string,
    idempotencyKey: string,
  ): IdempotentMutationResult<GraphSnapshot> {
    return this.executeLifecycleMutation(
      "cancel",
      reference,
      idempotencyKey,
      (runId, at) => {
      const target = this.runRow(runId);
      const status = GraphStatusSchema.parse(stringValue(target, "status"));
      if (!["running", "pausing", "paused"].includes(status)) {
        throw new BurnGraphError(
          "INVALID_RUN_STATE",
          `Cannot cancel ${runId} from ${status}`,
        );
      }
      const tree = this.descendantRunRows(runId).filter(
        (row) =>
          !["completed", "failed", "cancelled"].includes(
            stringValue(row, "status"),
          ),
      );
      const ids = tree.map((row) => stringValue(row, "run_id"));
      const placeholders = ids.map(() => "?").join(", ");
      const liveGates = this.database.db
        .query(
          `SELECT execution_id, run_id, node_id, attempt
             FROM check_executions
            WHERE run_id IN (${placeholders}) AND status = 'claimed'
            ORDER BY run_id, node_id`,
        )
        .all(...ids) as Row[];
      const waits = this.database.db
        .query(
          `SELECT signal_id
             FROM wait_signals
            WHERE run_id IN (${placeholders}) AND status = 'waiting'`,
        )
        .all(...ids) as Row[];
      this.database.db
        .query(
          `UPDATE check_executions
              SET status = 'stale'
            WHERE run_id IN (${placeholders}) AND status = 'claimed'`,
        )
        .run(...ids);
      this.database.db
        .query(
          `UPDATE wait_signals
              SET status = 'stale', updated_at = ?
            WHERE run_id IN (${placeholders}) AND status = 'waiting'`,
        )
        .run(at, ...ids);
      this.database.db
        .query(
          `DELETE FROM resource_locks
            WHERE owner_kind = 'assignment'
              AND run_id IN (${placeholders})`,
        )
        .run(...ids);
      this.database.db
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
      this.database.db
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
      this.database.db
        .query(`DELETE FROM actor_focus WHERE run_id IN (${placeholders})`)
        .run(...ids);
      this.database.db
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
        this.database.db
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
          this.runRow(affectedRunId),
          "runtime_revision",
        );
        const sequence = this.appendEvent({
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
        changes.push({ revision, event: this.getEvent(sequence) });
      }
      if (liveGates.length === 0) {
        changes.push(...this.settleAncestors(runId, at));
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
    const target = this.getSnapshot(reference, 0).summary;
    if (target.parentRunId !== null) {
      throw new BurnGraphError(
        "PRIORITY_ROOT_REQUIRED",
        `Run ${target.runId} is not a root Run`,
        false,
        { rootRunId: target.rootRunId },
      );
    }
    return this.executeLifecycleMutation(
      `priority:${priority}`,
      reference,
      idempotencyKey,
      (runId, at) => {
        const run = this.runRow(runId);
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
        this.database.db
          .query(
            `UPDATE runs
                SET priority = ?, updated_at = ?
              WHERE run_id = ?`,
          )
          .run(priority, at, runId);
        const revision = this.bumpRun(runId, at);
        const sequence = this.appendEvent({
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
          changes: [{ revision, event: this.getEvent(sequence) }],
        };
      },
    );
  }

  listReady(graphReference?: string): readonly ReadyWork[] {
    const parameters: string[] = [];
    let filter = "";
    if (graphReference) {
      const runId = this.resolveRun(graphReference);
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
      const check = this.loadCheck(node.check.id, node.check.revision);
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
    const runId = this.resolveRun(reference);
    const validated = this.graphForRun(runId);
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

    const sequence = this.database.immediate(() => {
      const run = this.runRow(runId);
      if (stringValue(run, "status") !== "running") {
        throw new BurnGraphError(
          "RUN_NOT_RUNNING",
          `Run ${runId} is ${stringValue(run, "status")}`,
          true,
        );
      }
      const row = this.nodeRow(runId, nodeId);
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
          this.releaseAssignmentResources(staleAssignmentId);
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
      const revision = this.bumpRun(runId, at, undefined, nodeId);
      return this.appendEvent({
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
    });

    const packet = this.assignmentPacket(runId, nodeId, actorId);
    return {
      revision: this.summaryForRun(runId).runtimeRevision,
      event: this.getEvent(sequence),
      value: packet,
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
    const runId = this.resolveRun(reference);
    const now = this.now();
    const at = now.toISOString();
    const duration = validateLeaseSeconds(
      leaseSeconds ?? this.config.defaultLeaseSeconds,
    );
    const expiresAt = leaseTime(now, duration);
    const sequence = this.database.immediate(() => {
      const row = this.requireOwnedRunningNode(
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
      const run = this.runRow(runId);
      const revision = this.bumpRun(runId, at);
      return this.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.heartbeat",
        summary: `${actorId} renewed ${stringValue(row, "title")}.`,
        payload: { actorId, leaseExpiresAt: expiresAt, revision },
        at,
      });
    });
    return this.mutationNode(runId, nodeId, sequence);
  }

  checkpoint(
    reference: string,
    nodeId: string,
    actorId: string,
    input: unknown,
    expectation?: AssignmentExpectation,
  ): MutationResult<RuntimeNode> {
    const checkpoint = CheckpointInputSchema.parse(input);
    const runId = this.resolveRun(reference);
    const now = this.now();
    const at = now.toISOString();
    const sequence = this.database.immediate(() => {
      const row = this.requireOwnedRunningNode(
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
      const run = this.runRow(runId);
      const revision = this.bumpRun(runId, at);
      return this.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.checkpointed",
        summary: checkpoint.summary,
        payload: { actorId, progress: checkpoint.progress, revision },
        at,
      });
    });
    return this.mutationNode(runId, nodeId, sequence);
  }

  complete(
    reference: string,
    nodeId: string,
    actorId: string,
    input: unknown,
    expectation?: AssignmentExpectation,
  ): MutationResult<GraphSnapshot> {
    const completion = CompletionInputSchema.parse(input);
    const runId = this.resolveRun(reference);
    const validated = this.graphForRun(runId);
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
      const node = this.requireOwnedRunningNode(
        runId,
        nodeId,
        actorId,
        now,
        expectation,
      );
      const attempt = numberValue(node, "attempt");
      const assignmentId = optionalString(node, "assignment_id");
      const run = this.runRow(runId);
      const normalizedChildren =
        dynamicChildren !== null && dynamicChildren.success
          ? this.normalizedChildSet(
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
        this.releaseAssignmentResources(assignmentId);
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
        this.attachNormalizedSubgraphChildren(
          runId,
          nodeId,
          normalizedChildren,
          at,
          changes,
          childChanges,
        );
      } else if (nodeSpec.type === "decision") {
        const selected = this.edgeRowsFrom(runId, nodeId).find(
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
          this.resetLoop(
            validated,
            runId,
            stringValue(selected, "edge_id"),
            nodeId,
            stringValue(selected, "to_node_id"),
            at,
            changes,
          );
        } else {
          this.selectDecisionEdge(runId, nodeId, completion.route!, at);
          this.cascade(validated, runId, at, changes);
          this.driveStaticSubgraphs(
            runId,
            at,
            changes,
            childChanges,
          );
        }
      } else {
        this.takeAllForwardEdges(runId, nodeId, at);
        this.cascade(validated, runId, at, changes);
        this.driveStaticSubgraphs(
          runId,
          at,
          changes,
          childChanges,
        );
      }
      this.refreshRunTerminalStatus(runId, at);
      const revision = this.bumpRun(runId, at, undefined, null);
      const sequence = this.appendEvent({
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
        { revision, event: this.getEvent(sequence) },
        ...this.settleAncestors(runId, at),
      ];
      return { sequence, mutationChanges };
    });
    const quiesced = this.database.immediate(() =>
      this.quiescePauseContainingRun(runId, at),
    );
    return {
      ...this.mutationSnapshot(runId, completed.sequence),
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
    return this.stopNode(
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
    return this.stopNode(
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
    return this.stopNode(
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
    const runId = this.resolveRun(reference);
    const at = this.timestamp();
    const sequence = this.database.immediate(() => {
      const node = this.nodeRow(runId, nodeId);
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
      const run = this.runRow(runId);
      const revision = this.bumpRun(runId, at);
      return this.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.unblocked",
        summary: `Returned ${stringValue(node, "title")} to Ready.`,
        payload: { revision },
        at,
      });
    });
    return this.mutationNode(runId, nodeId, sequence);
  }

  focus(
    reference: string,
    nodeId: string,
    actorId: string,
    expectation?: AssignmentExpectation,
  ): MutationResult<AssignmentPacket> {
    IdentifierSchema.parse(actorId);
    const runId = this.resolveRun(reference);
    const at = this.timestamp();
    const sequence = this.database.immediate(() => {
      const node = this.requireOwnedRunningNode(
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
      const run = this.runRow(runId);
      const revision = this.bumpRun(runId, at, undefined, nodeId);
      return this.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.focused",
        summary: `${actorId} focused ${stringValue(node, "title")}.`,
        payload: { actorId, revision },
        at,
      });
    });
    const packet = this.assignmentPacket(runId, nodeId, actorId);
    return {
      revision: this.summaryForRun(runId).runtimeRevision,
      event: this.getEvent(sequence),
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
        const packet = this.assignmentPacket(
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
      state: this.scheduleState(finalAssignments, allRuns),
      assignments: finalAssignments,
      remainingReady: allRemainingReady.slice(
        0,
        MAX_SCHEDULE_READY_PREVIEW,
      ),
      remainingReadyCount: allRemainingReady.length,
      activeRunCount: activeRuns.length,
      runs,
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
      state: this.scheduleState(assignments, allRuns),
      assignments,
      remainingReady: remainingReady.slice(
        0,
        MAX_SCHEDULE_READY_PREVIEW,
      ),
      remainingReadyCount: remainingReady.length,
      activeRunCount: activeRuns.length,
      runs,
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
        started: this.summaryForRun(runId),
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
        resumed: this.summaryForRun(runId),
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
    let identity = this.assignmentIdentity(assignmentId);
    let replayed = false;
    const changes: RuntimeChange[] = [];

    if (identity.status === "done") {
      this.requireMatchingReplay(identity, completion);
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
        identity = this.assignmentIdentity(assignmentId);
      } catch (error) {
        const current = this.assignmentIdentity(assignmentId);
        if (current.status !== "done") throw error;
        this.requireMatchingReplay(current, completion);
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
    const identity = this.assignmentIdentity(assignmentId);
    return this.focus(identity.runId, identity.nodeId, identity.actorId, {
      assignmentId,
      attempt: identity.attempt,
    });
  }

  heartbeatAssignment(
    assignmentId: string,
  ): MutationResult<RuntimeNode> {
    const identity = this.assignmentIdentity(assignmentId);
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
    const identity = this.assignmentIdentity(assignmentId);
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
    const identity = this.assignmentIdentity(assignmentId);
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
    const identity = this.assignmentIdentity(assignmentId);
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
    const identity = this.assignmentIdentity(assignmentId);
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
    const identity = this.assignmentIdentity(assignmentId);
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
    const at = this.timestamp();
    const requestedRunId = reference ? this.resolveRun(reference) : null;
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
          const node = this.nodeRow(runId, nodeId);
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
            this.releaseAssignmentResources(assignmentId);
          }
        }

        const run = this.runRow(runId);
        const revision = this.bumpRun(runId, at);
        const sequence = this.appendEvent({
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
        this.quiescePauseContainingRun(runId, at),
      );
      const snapshot = this.getSnapshot(runId);
      const reconciledChange = {
        revision: reconciled.revision,
        event: this.getEvent(reconciled.sequence),
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
      const runId = this.resolveRun(reference);
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
    return rows.map((row) => this.eventFromRow(row));
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
        ? this.resolveRun(options.run)
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
      const scopeRunId = reference ? this.resolveRun(reference) : null;
      const runIds =
        scopeRunId === null
          ? this.listRuns().map((run) => run.runId)
          : this.descendantRunRows(scopeRunId).map((row) =>
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
        capturedAt: this.timestamp(),
        metrics: this.inspectMetrics(),
      };
    });
  }

  protected timestamp(): string {
    return this.now().toISOString();
  }

  private executeLifecycleMutation(
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
    const outcome = this.database.immediate(() => {
      const existing = this.database.db
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
        snapshot: this.readSnapshot(runId, 100),
        changes: mutation.changes.map((change) => ({
          revision: change.revision,
          eventSequence: change.event.sequence,
        })),
      };
      this.database.db
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
        this.getSnapshot(outcome.receipt.runId),
      changes: outcome.receipt.changes.map((change) => ({
        revision: change.revision,
        event: this.getEvent(change.eventSequence),
      })),
      replayed: outcome.replayed,
    };
  }

  private loadGraph(graphId: string, revision?: number): ValidatedGraph {
    IdentifierSchema.parse(graphId);
    let row: Row | null;
    if (revision === undefined) {
      row = this.database.db
        .query(
          `SELECT document_json
             FROM graph_specs
            WHERE graph_id = ?
            ORDER BY revision DESC
            LIMIT 1`,
        )
        .get(graphId) as Row | null;
    } else {
      row = this.database.db
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

  protected loadCheck(checkId: string, revision?: number): CheckSpec {
    IdentifierSchema.parse(checkId);
    let row: Row | null;
    if (revision === undefined) {
      row = this.database.db
        .query(
          `SELECT document_json
             FROM check_specs
            WHERE check_id = ?
            ORDER BY revision DESC
            LIMIT 1`,
        )
        .get(checkId) as Row | null;
    } else {
      row = this.database.db
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

  protected graphForRun(runId: string): ValidatedGraph {
    const row = this.runRow(runId);
    return this.loadGraph(
      stringValue(row, "graph_id"),
      numberValue(row, "spec_revision"),
    );
  }

  private tryResolveRun(reference: string): string | null {
    const exact = this.database.db
      .query("SELECT run_id FROM runs WHERE run_id = ?")
      .get(reference) as Row | null;
    if (exact) return stringValue(exact, "run_id");
    const graph = this.database.db
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

  protected resolveRun(reference: string): string {
    const runId = this.tryResolveRun(reference);
    if (!runId) {
      throw new BurnGraphError("RUN_NOT_FOUND", `Unknown run or graph ${reference}`);
    }
    return runId;
  }

  protected runRow(runId: string): Row {
    const row = this.database.db
      .query("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as Row | null;
    if (!row) throw new BurnGraphError("RUN_NOT_FOUND", `Unknown run ${runId}`);
    return row;
  }

  protected descendantRunRows(runId: string): readonly Row[] {
    return this.database.db
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

  protected quiescePauseContainingRun(
    runId: string,
    at: string,
  ): readonly RuntimeChange[] {
    const pauseScopeRunId = optionalString(
      this.runRow(runId),
      "pause_scope_run_id",
    );
    if (pauseScopeRunId === null) return [];
    const pausing = this.database.db
      .query(
        `SELECT *
           FROM runs
          WHERE pause_scope_run_id = ? AND status = 'pausing'
          ORDER BY depth DESC, run_id`,
      )
      .all(pauseScopeRunId) as Row[];
    if (pausing.length === 0) return [];
    const live = this.database.db
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

    this.database.db
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

  protected nodeRow(runId: string, nodeId: string): Row {
    const row = this.database.db
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

  private edgeRowsFrom(runId: string, nodeId: string): Row[] {
    return this.database.db
      .query(
        `SELECT *
           FROM edge_runs
          WHERE run_id = ? AND from_node_id = ?
          ORDER BY edge_id`,
      )
      .all(runId, nodeId) as Row[];
  }

  private insertEdge(runId: string, edge: GraphEdgeRef, at: string): void {
    this.database.db
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

  private nodesForRun(runId: string, spec: GraphSpec): readonly RuntimeNode[] {
    const rows = this.database.db
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

  private edgesForRun(runId: string): readonly RuntimeEdge[] {
    return (
      this.database.db
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

  private runtimeNode(row: Row): RuntimeNode {
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

  private summaryForRun(runId: string): GraphSummary {
    const row = this.runRow(runId);
    const graphId = stringValue(row, "graph_id");
    const spec = this.loadGraph(
      graphId,
      numberValue(row, "spec_revision"),
    ).spec;
    const countRows = this.database.db
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

  private assignmentIdentity(assignmentId: string): AssignmentIdentity {
    if (!z.string().uuid().safeParse(assignmentId).success) {
      throw new BurnGraphError(
        "ASSIGNMENT_NOT_FOUND",
        "Assignment ID is not a valid handle",
      );
    }
    const row = this.database.db
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

  private requireMatchingReplay(
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

  private scheduleState(
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

  private requireOwnedRunningNode(
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

  private takeAllForwardEdges(runId: string, nodeId: string, at: string): void {
    this.database.db
      .query(
        `UPDATE edge_runs
            SET status = 'taken', updated_at = ?
          WHERE run_id = ? AND from_node_id = ? AND max_traversals IS NULL`,
      )
      .run(at, runId, nodeId);
  }

  protected selectDecisionEdge(
    runId: string,
    nodeId: string,
    route: string,
    at: string,
  ): void {
    this.database.db
      .query(
        `UPDATE edge_runs
            SET status = CASE WHEN route = ? THEN 'taken' ELSE 'disabled' END,
                updated_at = ?
          WHERE run_id = ? AND from_node_id = ?`,
      )
      .run(route, at, runId, nodeId);
  }

  private ancestorGraphIds(runId: string): ReadonlySet<string> {
    const graphIds = new Set<string>();
    let current: string | null = runId;
    while (current !== null) {
      const row = this.runRow(current);
      graphIds.add(stringValue(row, "graph_id"));
      current = optionalString(row, "parent_run_id");
    }
    return graphIds;
  }

  private normalizedChildSet(
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
    if (depth > this.config.maxHierarchyDepth) {
      throw new BurnGraphError(
        "HIERARCHY_LIMIT",
        `Child depth ${depth} exceeds ${this.config.maxHierarchyDepth}`,
        false,
        { depth, limit: this.config.maxHierarchyDepth },
      );
    }
    const rootRunId = stringValue(parent, "root_run_id");
    const unfinished = this.database.db
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
      this.validateCheckReferences(childGraph);
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
        this.database.db
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
      this.config.maxUnfinishedDescendants
    ) {
      throw new BurnGraphError(
        "HIERARCHY_LIMIT",
        `Root ${rootRunId} exceeds ${this.config.maxUnfinishedDescendants} unfinished descendants`,
        false,
        {
          existing: numberValue(unfinished, "count"),
          requested: requestedDescendants,
          limit: this.config.maxUnfinishedDescendants,
        },
      );
    }
    return normalized;
  }

  private assertStaticDescendantsAvoidAncestors(
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
        if (depth + 1 > this.config.maxHierarchyDepth) {
          throw new BurnGraphError(
            "HIERARCHY_LIMIT",
            `Attached Graph exceeds depth ${this.config.maxHierarchyDepth}`,
            false,
            { depth: depth + 1, limit: this.config.maxHierarchyDepth },
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

  private insertChildRun(
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
    this.database.db
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
    this.database.db
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
      this.database.db
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
    this.database.db
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

  private sealSubgraphChildren(
    parentRunId: string,
    nodeId: string,
    descriptors: readonly ChildRunDescriptor[],
    at: string,
    changes: Array<Record<string, unknown>>,
    runtimeChanges: RuntimeChange[],
  ): readonly ChildRunDescriptor[] {
    const existing = this.database.db
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

  private attachNormalizedSubgraphChildren(
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
    this.database.db
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

  protected driveStaticSubgraphs(
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

  private settleSubgraphIfTerminal(
    parentRunId: string,
    nodeId: string,
    at: string,
    changes: Array<Record<string, unknown>>,
    emitEvent = true,
  ): readonly RuntimeChange[] {
    const node = this.nodeRow(parentRunId, nodeId);
    if (stringValue(node, "status") !== "waiting") return [];
    const children = this.database.db
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

    this.database.db
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
      this.database.db
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
      this.database.db
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
      this.database.db
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

  protected settleAncestors(
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

  protected cascade(
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
        const incoming = this.database.db
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
          this.database.db
            .query(
              `UPDATE node_runs
                  SET status = 'skipped', updated_at = ?
                WHERE run_id = ? AND node_id = ?`,
            )
            .run(at, runId, specNode.id);
          this.database.db
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
            this.database.db
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
            this.database.db
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

  private resetLoop(
    graph: ValidatedGraph,
    runId: string,
    edgeId: string,
    sourceId: string,
    targetId: string,
    at: string,
    changes: Array<Record<string, unknown>>,
  ): void {
    const body = loopBodyNodeIds(graph, sourceId, targetId);
    const placeholders = [...body].map(() => "?").join(", ");
    this.database.db
      .query(
        `UPDATE node_runs
            SET status = 'pending', assignment_id = NULL, actor_id = NULL,
                lease_expires_at = NULL, heartbeat_at = NULL, route = NULL,
                result_json = NULL, checkpoint_json = NULL, last_error = NULL,
                updated_at = ?
          WHERE run_id = ? AND node_id IN (${placeholders})`,
      )
      .run(at, runId, ...body);
    this.database.db
      .query(
        `UPDATE edge_runs
            SET status = 'pending', updated_at = ?
          WHERE run_id = ? AND from_node_id IN (${placeholders})`,
      )
      .run(at, runId, ...body);
    this.database.db
      .query(
        `UPDATE edge_runs
            SET traversals = traversals + 1, status = 'pending', updated_at = ?
          WHERE run_id = ? AND edge_id = ?`,
      )
      .run(at, runId, edgeId);
    this.database.db
      .query(
        `UPDATE node_runs
            SET status = 'ready', updated_at = ?
          WHERE run_id = ? AND node_id = ?`,
      )
      .run(at, runId, targetId);
    changes.push({
      loop: `${sourceId}->${targetId}`,
      resetNodes: [...body],
      ready: targetId,
    });
  }

  protected refreshRunTerminalStatus(runId: string, at: string): void {
    const failed = this.database.db
      .query(
        `SELECT COUNT(*) AS count
           FROM node_runs
          WHERE run_id = ? AND status = 'failed'`,
      )
      .get(runId) as Row;
    if (numberValue(failed, "count") > 0) {
      this.database.db
        .query("UPDATE runs SET status = 'failed', updated_at = ? WHERE run_id = ?")
        .run(at, runId);
      return;
    }
    const unfinished = this.database.db
      .query(
        `SELECT COUNT(*) AS count
           FROM node_runs
          WHERE run_id = ?
            AND status NOT IN ('done', 'skipped')`,
      )
      .get(runId) as Row;
    const end = this.database.db
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
      this.database.db
        .query(
          "UPDATE runs SET status = 'completed', focused_node_id = NULL, updated_at = ? WHERE run_id = ?",
        )
        .run(at, runId);
    }
  }

  private releaseAssignmentResources(assignmentId: string): void {
    this.database.db
      .query(
        `DELETE FROM resource_locks
          WHERE owner_kind = 'assignment' AND owner_id = ?`,
      )
      .run(assignmentId);
  }

  private stopNode(
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
    const now = this.now();
    const at = now.toISOString();
    const stopped = this.database.immediate(() => {
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
      this.database.db
        .query(
          `UPDATE attempts
              SET status = ?, finished_at = ?
            WHERE run_id = ? AND node_id = ? AND attempt = ?`,
        )
        .run(attemptStatus, at, runId, nodeId, attempt);
      if (assignmentId !== null) {
        this.releaseAssignmentResources(assignmentId);
      }
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = ?, assignment_id = NULL, actor_id = NULL,
                  lease_expires_at = NULL, heartbeat_at = NULL,
                  last_error = ?, checkpoint_json = NULL, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(status, reason, at, runId, nodeId);
      this.database.db
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
        this.database.db
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
    const quiesced = this.database.immediate(() =>
      this.quiescePauseContainingRun(runId, at),
    );
    return {
      ...this.mutationNode(runId, nodeId, stopped.sequence),
      changes: [...stopped.changes, ...quiesced],
    };
  }

  private cancelFailureRemainder(
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
    const cancelledRows = this.database.db
      .query(
        `SELECT run_id, node_id
           FROM node_runs
          WHERE run_id IN (${placeholders})
            AND status IN
                ('pending', 'ready', 'running', 'waiting', 'blocked')
          ORDER BY run_id, node_id`,
      )
      .all(...affectedRunIds) as Row[];
    this.database.db
      .query(
        `UPDATE attempts
            SET status = 'cancelled', finished_at = ?
          WHERE run_id IN (${placeholders}) AND finished_at IS NULL`,
      )
      .run(at, ...affectedRunIds);
    this.database.db
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
    this.database.db
      .query(`DELETE FROM actor_focus WHERE run_id IN (${placeholders})`)
      .run(...affectedRunIds);
    this.database.db
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
      this.database.db
        .query(
          `UPDATE runs
              SET status = 'cancelled', cancel_requested_at = ?,
                  focused_node_id = NULL, runtime_revision = runtime_revision + 1,
                  updated_at = ?
            WHERE run_id IN (${descendantPlaceholders})`,
        )
        .run(at, at, ...descendantIds);
      this.database.db
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

  protected bumpRun(
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
    this.database.db
      .query(`UPDATE runs SET ${assignments.join(", ")} WHERE run_id = ?`)
      .run(...values, runId);
    return numberValue(this.runRow(runId), "runtime_revision");
  }

  protected appendEvent(input: {
    readonly runId: string;
    readonly graphId: string;
    readonly nodeId: string | null;
    readonly type: string;
    readonly summary: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly at: string;
  }): number {
    const result = this.database.db
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

  protected getEvent(sequence: number): GraphEvent {
    const row = this.database.db
      .query("SELECT * FROM events WHERE sequence = ?")
      .get(sequence) as Row | null;
    if (!row) {
      throw new BurnGraphError("EVENT_NOT_FOUND", `Missing event ${sequence}`);
    }
    return this.eventFromRow(row);
  }

  private eventFromRow(row: Row): GraphEvent {
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

  private recentEventsForRun(
    runId: string,
    limit: number,
  ): readonly GraphEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new BurnGraphError("INVALID_LIMIT", "Event limit must be 1-1000");
    }
    const rows = this.database.db
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

  private assignmentPacket(
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
    const incoming = this.database.db
      .query(
        `SELECT from_node_id
           FROM edge_runs
          WHERE run_id = ? AND to_node_id = ?
          ORDER BY edge_id`,
      )
      .all(runId, nodeId) as Row[];
    const predecessors = incoming
      .map((edge) => {
        const predecessorId = stringValue(edge, "from_node_id");
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
      projectId: this.config.projectId,
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

  private latestAttemptCompletion(
    runId: string,
    nodeId: string,
  ): {
    readonly attempt: number;
    readonly route: string | null;
    readonly completion: CompletionInput;
  } | null {
    const row = this.database.db
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

  private mutationSnapshot(
    runId: string,
    sequence: number,
  ): MutationResult<GraphSnapshot> {
    const snapshot = this.getSnapshot(runId);
    return {
      revision: snapshot.summary.runtimeRevision,
      event: this.getEvent(sequence),
      value: snapshot,
    };
  }

  private mutationNode(
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
