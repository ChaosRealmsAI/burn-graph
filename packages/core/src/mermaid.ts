import type {
  GraphSpec,
  RuntimeEdge,
  RuntimeNode,
} from "./contracts.ts";

function escapeLabel(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "'")
    .replaceAll("\n", " ")
    .slice(0, 100);
}

function mermaidId(id: string): string {
  return `n_${Buffer.from(id).toString("hex")}`;
}

function shape(node: GraphSpec["nodes"][number]): string {
  const id = mermaidId(node.id);
  const title = escapeLabel(node.title);
  switch (node.type) {
    case "start":
    case "end":
      return `${id}(["${title}"])`;
    case "decision":
      return `${id}{"${title}"}`;
    case "join":
      return `${id}{{"${title}"}}`;
    case "task":
      return `${id}["${title}"]`;
  }
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
  lines.push(
    "  classDef pending fill:#171d2a,stroke:#7c8799,color:#f3f6fb",
    "  classDef ready fill:#17223a,stroke:#6e9fff,color:#f3f6fb,stroke-width:3px",
    "  classDef running fill:#2a2318,stroke:#f5b84b,color:#f3f6fb,stroke-width:3px",
    "  classDef blocked fill:#2a171c,stroke:#ff6e7c,color:#f3f6fb,stroke-width:3px",
    "  classDef done fill:#14271f,stroke:#54ce8f,color:#f3f6fb",
    "  classDef failed fill:#2f1319,stroke:#ff475d,color:#f3f6fb,stroke-width:3px",
    "  classDef skipped fill:#171d2a,stroke:#667084,color:#a7b1c2,stroke-dasharray: 4 4",
  );
  return lines.join("\n");
}
