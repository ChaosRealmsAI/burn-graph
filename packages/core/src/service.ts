import { z } from "zod";

import {
  BurnGraphError,
  CheckpointInputSchema,
  CompletionInputSchema,
  GraphStatusSchema,
  IdentifierSchema,
  NodeStatusSchema,
  type ActorWork,
  type AssignmentPacket,
  type CheckpointInput,
  type CompletionInput,
  type GraphCounts,
  type GraphEvent,
  type GraphSnapshot,
  type GraphSpec,
  type GraphStatus,
  type GraphSummary,
  type MutationResult,
  type ProjectConfig,
  type RuntimeEdge,
  type RuntimeNode,
} from "./contracts.ts";
import { renderMermaid } from "./mermaid.ts";
import {
  discoverProjectRoot,
  readProjectConfig,
  writeGraphSpec,
} from "./project.ts";
import { BurnGraphDatabase } from "./storage.ts";
import {
  loopBodyNodeIds,
  validateGraphSpec,
  type GraphEdgeRef,
  type ValidatedGraph,
} from "./validator.ts";

type SqlValue = string | number | bigint | null;
type Row = Record<string, SqlValue>;

function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new BurnGraphError("CORRUPT_STATE", `Expected ${key} to be text`);
  }
  return value;
}

function optionalString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new BurnGraphError("CORRUPT_STATE", `Expected ${key} to be nullable text`);
  }
  return value;
}

function numberValue(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new BurnGraphError("CORRUPT_STATE", `Expected ${key} to be numeric`);
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

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

export interface BurnGraphServiceOptions {
  readonly now?: () => Date;
}

export class BurnGraphService {
  readonly root: string;
  readonly config: ProjectConfig;
  readonly database: BurnGraphDatabase;
  private readonly now: () => Date;

  constructor(rootInput: string, options: BurnGraphServiceOptions = {}) {
    this.root = discoverProjectRoot(rootInput);
    this.config = readProjectConfig(this.root);
    this.database = new BurnGraphDatabase(this.root);
    this.now = options.now ?? (() => new Date());
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

  listGraphs(): readonly {
    readonly id: string;
    readonly title: string;
    readonly goal: string;
    readonly revision: number;
    readonly latestRun: GraphSummary | null;
  }[] {
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
  }

  getGraph(graphId: string): GraphSpec {
    return this.loadGraph(graphId).spec;
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

  startRun(graphId: string, requestedRunId?: string): MutationResult<GraphSnapshot> {
    const validated = this.loadGraph(graphId);
    const now = this.now();
    const at = now.toISOString();
    const runId = requestedRunId ?? runIdFor(graphId, now);
    IdentifierSchema.parse(runId);

    const eventSequence = this.database.immediate(() => {
      const live = this.database.db
        .query(
          `SELECT run_id
             FROM runs
            WHERE graph_id = ?
              AND status IN ('running', 'paused')
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
             focused_node_id, created_at, updated_at
           ) VALUES (?, ?, ?, 'running', 1, NULL, ?, ?)`,
        )
        .run(runId, graphId, validated.spec.revision, at, at);

      for (const node of validated.spec.nodes) {
        this.database.db
          .query(
            `INSERT INTO node_runs (
               run_id, node_id, node_type, title, status, attempt,
               actor_id, lease_expires_at, heartbeat_at,
               route, result_json, checkpoint_json, last_error, updated_at
             ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL,
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
      this.cascade(validated, runId, at, changes);
      this.refreshRunTerminalStatus(runId, at);
      return this.appendEvent({
        runId,
        graphId,
        nodeId: start.id,
        type: "run.started",
        summary: `Started ${validated.spec.title} at revision ${validated.spec.revision}.`,
        payload: { changes },
        at,
      });
    });

    const snapshot = this.getSnapshot(runId);
    return {
      revision: snapshot.summary.runtimeRevision,
      event: this.getEvent(eventSequence),
      value: snapshot,
    };
  }

  listRuns(): readonly GraphSummary[] {
    const rows = this.database.db
      .query("SELECT run_id FROM runs ORDER BY updated_at DESC")
      .all() as Row[];
    return rows.map((row) =>
      this.summaryForRun(stringValue(row, "run_id")),
    );
  }

  getSnapshot(reference: string, eventLimit = 100): GraphSnapshot {
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
      events: this.listEvents(runId, 0, eventLimit),
      mermaid: renderMermaid(spec, nodes, edges),
    };
  }

  pauseRun(reference: string): MutationResult<GraphSnapshot> {
    return this.changeRunStatus(reference, "running", "paused", "run.paused");
  }

  resumeRun(reference: string): MutationResult<GraphSnapshot> {
    return this.changeRunStatus(reference, "paused", "running", "run.resumed");
  }

  cancelRun(reference: string): MutationResult<GraphSnapshot> {
    const runId = this.resolveRun(reference);
    const at = this.timestamp();
    const sequence = this.database.immediate(() => {
      const row = this.runRow(runId);
      const status = GraphStatusSchema.parse(stringValue(row, "status"));
      if (status !== "running" && status !== "paused") {
        throw new BurnGraphError(
          "INVALID_RUN_STATE",
          `Cannot cancel ${runId} from ${status}`,
        );
      }
      this.database.db
        .query(
          `UPDATE attempts
              SET status = 'cancelled', finished_at = ?
            WHERE run_id = ? AND finished_at IS NULL`,
        )
        .run(at, runId);
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = CASE WHEN status = 'running' THEN 'blocked' ELSE status END,
                  actor_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                  updated_at = ?
            WHERE run_id = ?`,
        )
        .run(at, runId);
      this.database.db
        .query("DELETE FROM actor_focus WHERE run_id = ?")
        .run(runId);
      const revision = this.bumpRun(runId, at, "cancelled", null);
      return this.appendEvent({
        runId,
        graphId: stringValue(row, "graph_id"),
        nodeId: null,
        type: "run.cancelled",
        summary: `Cancelled run ${runId}.`,
        payload: { revision },
        at,
      });
    });
    return this.mutationSnapshot(runId, sequence);
  }

  listReady(graphReference?: string): readonly {
    readonly runId: string;
    readonly graphId: string;
    readonly nodeId: string;
    readonly type: "task" | "decision";
    readonly title: string;
    readonly actorHint: string | null;
    readonly attempt: number;
    readonly updatedAt: string;
  }[] {
    const parameters: string[] = [];
    let filter = "";
    if (graphReference) {
      const runId = this.resolveRun(graphReference);
      filter = "AND n.run_id = ?";
      parameters.push(runId);
    }
    const rows = this.database.db
      .query(
        `SELECT n.run_id, r.graph_id, n.node_id, n.node_type, n.title,
                n.attempt, n.updated_at, s.document_json
           FROM node_runs n
           JOIN runs r ON r.run_id = n.run_id
           JOIN graph_specs s
             ON s.graph_id = r.graph_id AND s.revision = r.spec_revision
          WHERE r.status = 'running'
            AND n.status = 'ready'
            ${filter}
          ORDER BY n.updated_at, n.run_id, n.node_id`,
      )
      .all(...parameters) as Row[];
    return rows.map((row) => {
      const spec = validateGraphSpec(
        JSON.parse(stringValue(row, "document_json")),
      ).spec;
      const nodeId = stringValue(row, "node_id");
      const node = spec.nodes.find((candidate) => candidate.id === nodeId)!;
      return {
        runId: stringValue(row, "run_id"),
        graphId: stringValue(row, "graph_id"),
        nodeId,
        type: node.type as "task" | "decision",
        title: stringValue(row, "title"),
        actorHint: node.actorHint,
        attempt: numberValue(row, "attempt") + 1,
        updatedAt: stringValue(row, "updated_at"),
      };
    });
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
    if (!nodeSpec || (nodeSpec.type !== "task" && nodeSpec.type !== "decision")) {
      throw new BurnGraphError(
        "NODE_NOT_CLAIMABLE",
        `${nodeId} is not a Task or Decision`,
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
                SET status = 'ready', actor_id = NULL, lease_expires_at = NULL,
                    heartbeat_at = NULL, updated_at = ?
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
      if (numberValue(runningCount, "count") >= validated.spec.maxActive) {
        throw new BurnGraphError(
          "MAX_ACTIVE_REACHED",
          `Run ${runId} already has ${validated.spec.maxActive} active nodes`,
          true,
        );
      }
      const attempt = numberValue(row, "attempt") + 1;
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = 'running', attempt = ?, actor_id = ?,
                  lease_expires_at = ?, heartbeat_at = ?,
                  checkpoint_json = NULL, last_error = NULL, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(
          attempt,
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
             run_id, node_id, attempt, status, actor_id, result_json,
             checkpoint_json, route, started_at, finished_at
           ) VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL, ?, NULL)`,
        )
        .run(runId, nodeId, attempt, actorId, at);
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
          leaseExpiresAt: expiresAt,
          recoveredExpiredAttempt,
          revision,
        },
        at,
      });
    });

    const packet = this.assignmentPacket(runId, nodeId, actorId);
    const snapshot = this.getSnapshot(runId);
    return {
      revision: snapshot.summary.runtimeRevision,
      event: this.getEvent(sequence),
      value: packet,
    };
  }

  heartbeat(
    reference: string,
    nodeId: string,
    actorId: string,
    leaseSeconds?: number,
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
      const row = this.requireOwnedRunningNode(runId, nodeId, actorId, now);
      this.database.db
        .query(
          `UPDATE node_runs
              SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(expiresAt, at, at, runId, nodeId);
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
  ): MutationResult<RuntimeNode> {
    const checkpoint = CheckpointInputSchema.parse(input);
    const runId = this.resolveRun(reference);
    const now = this.now();
    const at = now.toISOString();
    const sequence = this.database.immediate(() => {
      const row = this.requireOwnedRunningNode(runId, nodeId, actorId, now);
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
  ): MutationResult<GraphSnapshot> {
    const completion = CompletionInputSchema.parse(input);
    const runId = this.resolveRun(reference);
    const validated = this.graphForRun(runId);
    const nodeSpec = validated.nodesById.get(nodeId);
    if (!nodeSpec) {
      throw new BurnGraphError("NODE_NOT_FOUND", `Unknown node ${nodeId}`);
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
    const sequence = this.database.immediate(() => {
      const node = this.requireOwnedRunningNode(runId, nodeId, actorId, now);
      const attempt = numberValue(node, "attempt");
      const run = this.runRow(runId);
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = 'done', actor_id = NULL, lease_expires_at = NULL,
                  heartbeat_at = NULL, route = ?,
                  result_json = ?, checkpoint_json = NULL, updated_at = ?
            WHERE run_id = ? AND node_id = ?`,
        )
        .run(completion.route ?? null, json(completion), at, runId, nodeId);
      this.database.db
        .query(
          `UPDATE attempts
              SET status = 'done', result_json = ?, route = ?, finished_at = ?
            WHERE run_id = ? AND node_id = ? AND attempt = ?`,
        )
        .run(
          json(completion),
          completion.route ?? null,
          at,
          runId,
          nodeId,
          attempt,
        );
      this.database.db
        .query(
          "DELETE FROM actor_focus WHERE actor_id = ? AND run_id = ? AND node_id = ?",
        )
        .run(actorId, runId, nodeId);

      const changes: Array<Record<string, unknown>> = [
        { nodeId, status: "done", attempt },
      ];
      if (nodeSpec.type === "decision") {
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
        }
      } else {
        this.takeAllForwardEdges(runId, nodeId, at);
        this.cascade(validated, runId, at, changes);
      }
      this.refreshRunTerminalStatus(runId, at);
      const revision = this.bumpRun(runId, at, undefined, null);
      return this.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type: "node.completed",
        summary: completion.summary,
        payload: {
          actorId,
          attempt,
          route: completion.route ?? null,
          evidence: completion.evidence,
          changes,
          revision,
        },
        at,
      });
    });
    return this.mutationSnapshot(runId, sequence);
  }

  block(
    reference: string,
    nodeId: string,
    actorId: string,
    reason: string,
  ): MutationResult<RuntimeNode> {
    return this.stopNode(reference, nodeId, actorId, "blocked", reason, false);
  }

  fail(
    reference: string,
    nodeId: string,
    actorId: string,
    reason: string,
    retry: boolean,
  ): MutationResult<RuntimeNode> {
    return this.stopNode(reference, nodeId, actorId, "failed", reason, retry);
  }

  release(
    reference: string,
    nodeId: string,
    actorId: string,
    reason = "Released by actor.",
  ): MutationResult<RuntimeNode> {
    return this.stopNode(reference, nodeId, actorId, "ready", reason, false);
  }

  unblock(reference: string, nodeId: string): MutationResult<RuntimeNode> {
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
  ): MutationResult<AssignmentPacket> {
    IdentifierSchema.parse(actorId);
    const runId = this.resolveRun(reference);
    const at = this.timestamp();
    const sequence = this.database.immediate(() => {
      const node = this.nodeRow(runId, nodeId);
      if (
        stringValue(node, "status") !== "running" ||
        optionalString(node, "actor_id") !== actorId
      ) {
        throw new BurnGraphError(
          "NOT_NODE_OWNER",
          `${actorId} does not own running node ${nodeId}`,
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
        `SELECT n.run_id, r.graph_id, n.node_id, n.title, n.lease_expires_at
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
        title: stringValue(row, "title"),
        leaseExpiresAt: stringValue(row, "lease_expires_at"),
      })),
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
            `SELECT node_id, actor_id
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
                  SET status = 'ready', actor_id = NULL, lease_expires_at = NULL,
                      heartbeat_at = NULL,
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
          nodeIds: stale.map((row) => stringValue(row, "node_id")),
        };
      });
      if (!reconciled) continue;

      const snapshot = this.getSnapshot(runId);
      results.push({
        revision: snapshot.summary.runtimeRevision,
        event: this.getEvent(reconciled.sequence),
        value: snapshot.nodes.filter((node) =>
          reconciled.nodeIds.includes(node.id),
        ),
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

  projectSnapshot(): {
    readonly projectId: string;
    readonly graphs: ReturnType<BurnGraphService["listGraphs"]>;
    readonly runs: readonly GraphSummary[];
    readonly lastEventSequence: number;
    readonly capturedAt: string;
  } {
    const row = this.database.db
      .query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events")
      .get() as Row;
    return {
      projectId: this.config.projectId,
      graphs: this.listGraphs(),
      runs: this.listRuns(),
      lastEventSequence: numberValue(row, "sequence"),
      capturedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
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

  private graphForRun(runId: string): ValidatedGraph {
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
          ORDER BY CASE WHEN status IN ('running', 'paused') THEN 0 ELSE 1 END,
                   updated_at DESC
          LIMIT 1`,
      )
      .get(reference) as Row | null;
    return graph ? stringValue(graph, "run_id") : null;
  }

  private resolveRun(reference: string): string {
    const runId = this.tryResolveRun(reference);
    if (!runId) {
      throw new BurnGraphError("RUN_NOT_FOUND", `Unknown run or graph ${reference}`);
    }
    return runId;
  }

  private runRow(runId: string): Row {
    const row = this.database.db
      .query("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as Row | null;
    if (!row) throw new BurnGraphError("RUN_NOT_FOUND", `Unknown run ${runId}`);
    return row;
  }

  private nodeRow(runId: string, nodeId: string): Row {
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
      blocked: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    };
    for (const countRow of countRows) {
      const status = NodeStatusSchema.parse(stringValue(countRow, "status"));
      counts[status] = numberValue(countRow, "count");
    }
    const focusedNodeId = optionalString(row, "focused_node_id");
    const focused = focusedNodeId
      ? spec.nodes.find((node) => node.id === focusedNodeId)
      : undefined;
    return {
      runId,
      graphId,
      title: spec.title,
      goal: spec.goal,
      specRevision: numberValue(row, "spec_revision"),
      runtimeRevision: numberValue(row, "runtime_revision"),
      status: GraphStatusSchema.parse(stringValue(row, "status")),
      maxActive: spec.maxActive,
      focusedNodeId,
      focusedNodeTitle: focused?.title ?? null,
      counts,
      createdAt: stringValue(row, "created_at"),
      updatedAt: stringValue(row, "updated_at"),
    };
  }

  private requireOwnedRunningNode(
    runId: string,
    nodeId: string,
    actorId: string,
    now: Date,
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

  private selectDecisionEdge(
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

  private cascade(
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
            SET status = 'pending', actor_id = NULL, lease_expires_at = NULL,
                heartbeat_at = NULL, route = NULL,
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

  private refreshRunTerminalStatus(runId: string, at: string): void {
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

  private stopNode(
    reference: string,
    nodeId: string,
    actorId: string,
    requestedStatus: "ready" | "blocked" | "failed",
    reason: string,
    retry: boolean,
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
    const sequence = this.database.immediate(() => {
      const node = this.requireOwnedRunningNode(runId, nodeId, actorId, now);
      const attempt = numberValue(node, "attempt");
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
      this.database.db
        .query(
          `UPDATE node_runs
              SET status = ?, actor_id = NULL, lease_expires_at = NULL,
                  heartbeat_at = NULL,
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
      if (status === "failed") {
        this.database.db
          .query(
            "UPDATE runs SET status = 'failed', focused_node_id = NULL, updated_at = ? WHERE run_id = ?",
          )
          .run(at, runId);
      }
      const revision = this.bumpRun(runId, at, undefined, null);
      const type =
        status === "ready"
          ? shouldRetry
            ? "node.retry_scheduled"
            : "node.released"
          : `node.${status}`;
      return this.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId,
        type,
        summary: reason,
        payload: { actorId, attempt, status, retry: shouldRetry, revision },
        at,
      });
    });
    return this.mutationNode(runId, nodeId, sequence);
  }

  private changeRunStatus(
    reference: string,
    from: GraphStatus,
    to: GraphStatus,
    eventType: string,
  ): MutationResult<GraphSnapshot> {
    const runId = this.resolveRun(reference);
    const at = this.timestamp();
    const sequence = this.database.immediate(() => {
      const row = this.runRow(runId);
      if (stringValue(row, "status") !== from) {
        throw new BurnGraphError(
          "INVALID_RUN_STATE",
          `Cannot move ${runId} from ${stringValue(row, "status")} to ${to}`,
        );
      }
      const revision = this.bumpRun(runId, at, to);
      return this.appendEvent({
        runId,
        graphId: stringValue(row, "graph_id"),
        nodeId: null,
        type: eventType,
        summary: `${to === "paused" ? "Paused" : "Resumed"} run ${runId}.`,
        payload: { revision },
        at,
      });
    });
    return this.mutationSnapshot(runId, sequence);
  }

  private bumpRun(
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

  private appendEvent(input: {
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

  private getEvent(sequence: number): GraphEvent {
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

  private assignmentPacket(
    runId: string,
    nodeId: string,
    actorId: string,
  ): AssignmentPacket {
    const snapshot = this.getSnapshot(runId);
    const nodeRuntime = snapshot.nodes.find((node) => node.id === nodeId);
    const nodeSpec = snapshot.spec.nodes.find((node) => node.id === nodeId);
    if (
      !nodeRuntime ||
      !nodeSpec ||
      (nodeSpec.type !== "task" && nodeSpec.type !== "decision")
    ) {
      throw new BurnGraphError("NODE_NOT_FOUND", `Unknown assignment ${nodeId}`);
    }
    if (nodeRuntime.actorId !== actorId || nodeRuntime.leaseExpiresAt === null) {
      throw new BurnGraphError(
        "NOT_NODE_OWNER",
        `${actorId} does not own ${nodeId}`,
      );
    }
    const incoming = snapshot.edges.filter((edge) => edge.to === nodeId);
    const predecessors = incoming
      .map((edge) => {
        const runtime = snapshot.nodes.find((candidate) => candidate.id === edge.from);
        const spec = snapshot.spec.nodes.find((candidate) => candidate.id === edge.from);
        if (!runtime || !spec) return null;
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
      projectId: this.config.projectId,
      graph: {
        runId,
        graphId: snapshot.summary.graphId,
        title: snapshot.summary.title,
        goal: snapshot.summary.goal,
        specRevision: snapshot.summary.specRevision,
        runtimeRevision: snapshot.summary.runtimeRevision,
        progress: snapshot.summary.counts,
      },
      node: {
        id: nodeId,
        type: nodeSpec.type,
        title: nodeSpec.title,
        attempt: nodeRuntime.attempt,
        actorHint: nodeSpec.actorHint,
        prompt: nodeSpec.prompt,
        routes: snapshot.edges
          .filter((edge) => edge.from === nodeId && edge.route !== null)
          .map((edge) => ({
            route: edge.route!,
            to: edge.to,
            label: edge.label,
            remainingTraversals:
              edge.maxTraversals === null
                ? null
                : edge.maxTraversals - edge.traversals,
          })),
      },
      context: { predecessors },
      claim: {
        actorId,
        leaseExpiresAt: nodeRuntime.leaseExpiresAt,
      },
      returnProtocol: {
        checkpoint: `burn-graph work checkpoint ${runId} ${nodeId} --actor ${actorId} --input -`,
        complete: `burn-graph work complete ${runId} ${nodeId} --actor ${actorId} --input -`,
        block: `burn-graph work block ${runId} ${nodeId} --actor ${actorId} --reason <text>`,
        fail: `burn-graph work fail ${runId} ${nodeId} --actor ${actorId} --reason <text>`,
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

function optionalNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new BurnGraphError("CORRUPT_STATE", `Expected ${key} to be nullable number`);
}

function edgeStatus(row: Row): RuntimeEdge["status"] {
  const value = stringValue(row, "status");
  if (value === "pending" || value === "taken" || value === "disabled") {
    return value;
  }
  throw new BurnGraphError("CORRUPT_STATE", `Unknown edge status ${value}`);
}
