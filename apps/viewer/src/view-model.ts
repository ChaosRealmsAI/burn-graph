import type {
  GraphDetailView,
  GraphEventView,
  GraphSummaryView,
  NodeView,
} from "@burn-graph/design-system";
import type {
  GraphSnapshot,
  GraphSummary,
  GraphTreeSnapshot,
  PortfolioRun,
  RunTreeEntry,
  RuntimeNode,
} from "@burn-graph/core";

type HierarchyCounts = Pick<
  PortfolioRun,
  "directChildRuns" | "descendantRuns"
>;

export function graphSummaryView(
  summary: GraphSummary,
  hierarchy?: HierarchyCounts,
): GraphSummaryView {
  return {
    id: summary.runId,
    title: summary.title,
    goal: summary.goal,
    status: summary.status,
    revision: summary.runtimeRevision,
    counts: summary.counts,
    focusedNodeTitle: summary.focusedNodeTitle,
    priority: summary.priority,
    ...(hierarchy
      ? {
          hierarchy: {
            rootRunId: summary.rootRunId,
            parentRunId: summary.parentRunId,
            parentNodeId: summary.parentNodeId,
            depth: summary.depth,
            childRuns: hierarchy.directChildRuns,
            descendantRuns: hierarchy.descendantRuns,
          },
        }
      : {}),
    updatedAt: summary.updatedAt,
  };
}

function nodeView(
  snapshot: GraphSnapshot,
  runtime: RuntimeNode,
  tree?: GraphTreeSnapshot,
): NodeView {
  const spec = snapshot.spec.nodes.find((node) => node.id === runtime.id);
  if (!spec) throw new Error(`Missing spec for ${runtime.id}`);
  const predecessors = snapshot.edges
    .filter((edge) => edge.to === runtime.id && edge.status === "taken")
    .map((edge) =>
      snapshot.nodes.find((candidate) => candidate.id === edge.from),
    )
    .filter((node): node is RuntimeNode => node !== undefined)
    .map((node) => node.result?.summary)
    .filter((summary): summary is string => Boolean(summary));
  const children =
    tree?.runs.filter(
      (entry) =>
        entry.summary.parentRunId === snapshot.summary.runId &&
        entry.summary.parentNodeId === runtime.id,
    ) ?? [];
  return {
    id: runtime.id,
    title: runtime.title,
    type: runtime.type,
    status: runtime.status,
    objective: spec.prompt.objective,
    instructions: spec.prompt.instructions,
    doneWhen: spec.prompt.doneWhen,
    actorId: runtime.actorId,
    attempt: runtime.attempt,
    route: runtime.route,
    predecessorSummaries: predecessors,
    resultSummary: runtime.result?.summary ?? runtime.checkpoint?.summary ?? null,
    systemDetail:
      children.length === 0
        ? null
        : `${children.filter((entry) => entry.summary.status === "completed").length}/${children.length} child Runs completed.`,
    updatedAt: runtime.updatedAt,
  };
}

function eventView(event: GraphSnapshot["events"][number]): GraphEventView {
  return {
    sequence: event.sequence,
    type: event.type,
    nodeId: event.nodeId,
    summary: event.summary,
    at: event.createdAt,
  };
}

export function graphDetailView(snapshot: GraphSnapshot): GraphDetailView {
  return {
    summary: graphSummaryView(snapshot.summary),
    mermaid: snapshot.mermaid,
    nodes: snapshot.nodes.map((node) => nodeView(snapshot, node)),
    events: snapshot.events.map(eventView),
  };
}

function hierarchyCounts(entry: RunTreeEntry): HierarchyCounts {
  return {
    directChildRuns: entry.directChildRuns,
    descendantRuns: entry.descendantRuns,
  };
}

export function graphTreeDetailView(tree: GraphTreeSnapshot): GraphDetailView {
  const rootEntry = tree.runs.find(
    (entry) => entry.summary.runId === tree.root.summary.runId,
  );
  const children = tree.runs.filter(
    (entry) => entry.summary.parentRunId === tree.root.summary.runId,
  );
  return {
    summary: graphSummaryView(
      tree.root.summary,
      rootEntry ? hierarchyCounts(rootEntry) : undefined,
    ),
    mermaid: tree.mermaid,
    nodes: tree.root.nodes.map((node) => nodeView(tree.root, node, tree)),
    events: tree.root.events.map(eventView),
    children: children.map((entry) =>
      graphSummaryView(entry.summary, hierarchyCounts(entry)),
    ),
    projection: {
      depth: tree.projection.depth,
      maximumDepth: tree.projection.maximumDepth,
      foldedRuns: tree.projection.foldedRuns,
      renderedNodes: tree.projection.renderedNodes,
    },
    metrics: [
      {
        label: "Run tree",
        value: `${tree.projection.totalRuns} Runs`,
      },
      {
        label: "Projection",
        value: `${tree.projection.expandedRuns} expanded · ${tree.projection.foldedRuns} folded`,
      },
      {
        label: "Rendered nodes",
        value: `${tree.projection.renderedNodes}/${tree.projection.limit}`,
        tone:
          tree.projection.renderedNodes > tree.projection.limit * 0.8
            ? "warning"
            : "good",
      },
    ],
  };
}
