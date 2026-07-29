import type {
  GraphSpec,
  GraphStatus,
  RunTreeEntry,
  RuntimeEdge,
  RuntimeNode,
} from "./contracts.ts";

function escapeLabel(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "'")
    .replaceAll("|", "&#124;")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .slice(0, 100);
}

function mermaidId(id: string): string {
  return `n_${Buffer.from(id).toString("hex")}`;
}

function shape(
  node: GraphSpec["nodes"][number],
  id = mermaidId(node.id),
  titleOverride?: string,
): string {
  const title = escapeLabel(titleOverride ?? node.title);
  switch (node.type) {
    case "start":
    case "end":
      return `${id}(["${title}"])`;
    case "decision":
      return `${id}{"${title}"}`;
    case "join":
      return `${id}{{"${title}"}}`;
    case "subgraph":
      return `${id}[["${title}"]]`;
    case "gate":
      return `${id}{"${title}"}`;
    case "wait":
      return `${id}(["${title}"])`;
    case "task":
      return `${id}["${title}"]`;
  }
}

function statusClass(status: GraphStatus): string {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    case "pausing":
    case "paused":
    case "cancelling":
      return "waiting";
    case "draft":
      return "pending";
  }
}

function statusClasses(): readonly string[] {
  return [
    "  classDef pending fill:#171d2a,stroke:#7c8799,color:#f3f6fb",
    "  classDef ready fill:#17223a,stroke:#6e9fff,color:#f3f6fb,stroke-width:3px",
    "  classDef running fill:#2a2318,stroke:#f5b84b,color:#f3f6fb,stroke-width:3px",
    "  classDef waiting fill:#1b2130,stroke:#9b87f5,color:#f3f6fb,stroke-width:3px",
    "  classDef blocked fill:#2a171c,stroke:#ff6e7c,color:#f3f6fb,stroke-width:3px",
    "  classDef done fill:#14271f,stroke:#54ce8f,color:#f3f6fb",
    "  classDef failed fill:#2f1319,stroke:#ff475d,color:#f3f6fb,stroke-width:3px",
    "  classDef skipped fill:#171d2a,stroke:#667084,color:#a7b1c2,stroke-dasharray: 4 4",
    "  classDef cancelled fill:#1c2028,stroke:#808b9e,color:#c3cad5,stroke-dasharray: 5 3",
  ];
}

export function renderMermaid(
  spec: GraphSpec,
  nodes: readonly RuntimeNode[],
  edges: readonly RuntimeEdge[],
): string {
  const nodeState = new Map(nodes.map((node) => [node.id, node]));
  const lines = ["flowchart LR"];
  for (const node of spec.nodes) {
    lines.push(
      `  ${shape(node)}:::${nodeState.get(node.id)?.status ?? "pending"}`,
    );
  }
  for (const edge of edges) {
    const from = mermaidId(edge.from);
    const to = mermaidId(edge.to);
    const traversal =
      edge.maxTraversals === null
        ? ""
        : ` · ${edge.traversals}/${edge.maxTraversals}`;
    const label = escapeLabel(edge.label ?? edge.route ?? "");
    const renderedLabel = label || traversal ? `|${label}${traversal}|` : "";
    const arrow = edge.maxTraversals === null ? "-->" : "-.->";
    lines.push(`  ${from} ${arrow}${renderedLabel} ${to}`);
  }
  lines.push(...statusClasses());
  return lines.join("\n");
}

function scopedNodeId(runId: string, nodeId: string): string {
  return `n_${Buffer.from(runId).toString("hex")}_${Buffer.from(nodeId).toString("hex")}`;
}

function foldedRunId(runId: string): string {
  return `r_${Buffer.from(runId).toString("hex")}`;
}

function runProgress(entry: RunTreeEntry): string {
  const counts = entry.summary.counts;
  return `${counts.done + counts.skipped}/${counts.total}`;
}

export function renderTreeMermaid(entries: readonly RunTreeEntry[]): string {
  const byRunId = new Map(entries.map((entry) => [entry.summary.runId, entry]));
  const childrenByNode = new Map<string, RunTreeEntry[]>();
  for (const entry of entries) {
    const parentRunId = entry.summary.parentRunId;
    const parentNodeId = entry.summary.parentNodeId;
    if (parentRunId === null || parentNodeId === null) continue;
    const key = `${parentRunId}\u0000${parentNodeId}`;
    const children = childrenByNode.get(key) ?? [];
    children.push(entry);
    childrenByNode.set(key, children);
  }

  const lines = ["flowchart TB"];
  for (const entry of entries) {
    const summary = entry.summary;
    if (entry.folded || entry.topology === null) {
      const descendants =
        entry.descendantRuns > 0 ? ` · +${entry.descendantRuns}` : "";
      const label = escapeLabel(
        `${summary.status} · ${summary.priority} · ${runProgress(entry)}${descendants} · ${entry.label ?? summary.title}`,
      );
      lines.push(
        `  ${foldedRunId(summary.runId)}["${label}"]:::${statusClass(summary.status)}`,
      );
      continue;
    }

    const runLabel = escapeLabel(
      `${summary.status} · ${summary.priority} · ${runProgress(entry)} · ${entry.label ?? summary.title} · ${summary.runId}`,
    );
    lines.push(`  subgraph g_${Buffer.from(summary.runId).toString("hex")}["${runLabel}"]`);
    lines.push("    direction LR");
    const nodeState = new Map(
      entry.topology.nodes.map((node) => [node.id, node]),
    );
    for (const node of entry.topology.spec.nodes) {
      const children =
        childrenByNode.get(`${summary.runId}\u0000${node.id}`) ?? [];
      const completed = children.filter(
        (child) => child.summary.status === "completed",
      ).length;
      const childProgress =
        children.length === 0
          ? undefined
          : `${completed}/${children.length} child Runs · ${node.title}`;
      lines.push(
        `    ${shape(node, scopedNodeId(summary.runId, node.id), childProgress)}:::${nodeState.get(node.id)?.status ?? "pending"}`,
      );
    }
    for (const edge of entry.topology.edges) {
      const traversal =
        edge.maxTraversals === null
          ? ""
          : ` · ${edge.traversals}/${edge.maxTraversals}`;
      const label = escapeLabel(edge.label ?? edge.route ?? "");
      const renderedLabel = label || traversal ? `|${label}${traversal}|` : "";
      const arrow = edge.maxTraversals === null ? "-->" : "-.->";
      lines.push(
        `    ${scopedNodeId(summary.runId, edge.from)} ${arrow}${renderedLabel} ${scopedNodeId(summary.runId, edge.to)}`,
      );
    }
    lines.push("  end");
  }

  for (const entry of entries) {
    const parentRunId = entry.summary.parentRunId;
    if (parentRunId === null) continue;
    const parent = byRunId.get(parentRunId);
    if (!parent) continue;
    const parentNodeId = entry.summary.parentNodeId;
    const from =
      parent.folded || parent.topology === null || parentNodeId === null
        ? foldedRunId(parentRunId)
        : scopedNodeId(parentRunId, parentNodeId);
    const startNode = entry.topology?.spec.nodes.find(
      (node) => node.type === "start",
    );
    const to =
      entry.folded || startNode === undefined
        ? foldedRunId(entry.summary.runId)
        : scopedNodeId(entry.summary.runId, startNode.id);
    const label = escapeLabel(entry.label ?? "child");
    lines.push(`  ${from} -.->|${label}| ${to}`);
  }

  lines.push(...statusClasses());
  return lines.join("\n");
}
