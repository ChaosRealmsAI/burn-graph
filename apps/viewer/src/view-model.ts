import type {
  GraphDetailView,
  GraphEventView,
  GraphSummaryView,
  NodeView,
} from "@burn-graph/design-system";
import type {
  GraphSnapshot,
  GraphSummary,
  RuntimeNode,
} from "@burn-graph/core";

export function graphSummaryView(summary: GraphSummary): GraphSummaryView {
  return {
    id: summary.runId,
    title: summary.title,
    goal: summary.goal,
    status: summary.status,
    revision: summary.runtimeRevision,
    counts: summary.counts,
    focusedNodeTitle: summary.focusedNodeTitle,
    updatedAt: summary.updatedAt,
  };
}

function nodeView(
  snapshot: GraphSnapshot,
  runtime: RuntimeNode,
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
