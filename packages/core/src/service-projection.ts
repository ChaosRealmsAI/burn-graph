// Read-only projections of a Run: flat snapshots, hierarchical tree snapshots
// and single-node inspection.
//
// Split out of BurnGraphService so the shapes callers actually read are defined
// away from the mutation paths that produce them. Every method here is a pure
// read — nothing in this file writes, and nothing in it decides lifecycle.
//
// Bounding note: `eventLimit` bounds events only. `nodes` is still materialised
// in full, which is what makes wide-graph responses large and slow (I0010).
// Isolating the projection is the precondition for fixing that without touching
// scheduling.

import {
  BurnGraphError,
  type CheckpointInput,
  type CheckSpec,
  type CompletionInput,
  type GraphSpec,
  type GraphEvent,
  type GraphSnapshot,
  type GraphSummary,
  type GraphTreeSnapshot,
  type ProjectConfig,
  type RuntimeEdge,
  type RuntimeNode,
  type RunTreeEntry,
} from "./contracts.ts";
import { numberValue, optionalString, parseJson, stringValue, type Row } from "./sql.ts";
import { renderMermaid, renderTreeMermaid } from "./mermaid.ts";
import { BurnGraphDatabase } from "./storage.ts";
import { type ValidatedGraph } from "./validator.ts";

export interface RunProjectionOptions {
  readonly config: ProjectConfig;
  readonly database: BurnGraphDatabase;
  readonly timestamp: () => string;
  readonly loadGraph: (graphId: string, revision?: number) => ValidatedGraph;
  readonly resolveRun: (reference: string) => string;
  readonly summaryForRun: (runId: string) => GraphSummary;
  readonly nodesForRun: (runId: string, spec: GraphSpecLike) => readonly RuntimeNode[];
  readonly edgesForRun: (runId: string) => readonly RuntimeEdge[];
  readonly recentEventsForRun: (runId: string, limit: number) => readonly GraphEvent[];
}

// The projection only ever forwards the spec it was handed by loadGraph, so it
// does not need the full GraphSpec type surface here.
type GraphSpecLike = ValidatedGraph["spec"];

const MAX_TREE_PROJECTION_RUNS = 10_000;

export class RunProjection {
  constructor(private readonly options: RunProjectionOptions) {}

  getSnapshot(reference: string, eventLimit = 100): GraphSnapshot {
    return this.options.database.read(() =>
      this.readSnapshot(reference, eventLimit),
    );
  }

  readSnapshot(reference: string, eventLimit: number): GraphSnapshot {
    const runId = this.options.resolveRun(reference);
    const summary = this.options.summaryForRun(runId);
    const spec = this.options.loadGraph(summary.graphId, summary.specRevision).spec;
    const nodes = this.options.nodesForRun(runId, spec);
    const edges = this.options.edgesForRun(runId);
    return {
      summary,
      spec,
      nodes,
      edges,
      events:
        eventLimit === 0 ? [] : this.options.recentEventsForRun(runId, eventLimit),
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
      depth > this.options.config.maxHierarchyDepth
    ) {
      throw new BurnGraphError(
        "PROJECTION_LIMIT",
        `Tree depth must be 0-${this.options.config.maxHierarchyDepth}`,
        false,
        { depth, maximumDepth: this.options.config.maxHierarchyDepth },
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

    return this.options.database.read(() =>
      this.readTreeSnapshot(reference, depth, limit, eventLimit),
    );
  }

  readTreeSnapshot(
    reference: string,
    depth: number,
    limit: number,
    eventLimit: number,
  ): GraphTreeSnapshot {
    const runId = this.options.resolveRun(reference);
    const rows = this.options.database.db
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
            : this.options.summaryForRun(candidateRunId),
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
        const spec = this.options.loadGraph(
          candidate.summary.graphId,
          candidate.summary.specRevision,
        ).spec;
        const nodes = this.options.nodesForRun(candidate.summary.runId, spec);
        const edges = this.options.edgesForRun(candidate.summary.runId);
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
      this.options.database.db
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
        capturedAt: this.options.timestamp(),
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
    const runId = this.options.resolveRun(reference);
    const snapshot = this.getSnapshot(runId, eventLimit);
    const spec = snapshot.spec.nodes.find((node) => node.id === nodeId);
    const runtime = snapshot.nodes.find((node) => node.id === nodeId);
    if (!spec || !runtime) {
      throw new BurnGraphError("NODE_NOT_FOUND", `Unknown node ${nodeId}`);
    }
    const attempts = this.options.database.db
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

}
