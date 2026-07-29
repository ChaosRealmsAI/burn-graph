export const graphRegionStories = [
  {
    id: "REGION-GRAPH-OVERVIEW",
    title: "Multi-graph overview",
    platforms: ["web"],
    states: ["active", "mixed-status", "empty", "reconnecting", "narrow"],
    userPathRefs: ["UP02", "UP03"],
    notes:
      "Graph progress and active work remain readable before any node detail is opened.",
  },
  {
    id: "REGION-GRAPH-DETAIL",
    title: "Live graph detail",
    platforms: ["web"],
    states: ["parallel", "decision", "blocked", "completed", "long-content"],
    userPathRefs: ["UP01", "UP03"],
    notes:
      "Topology, status legend, node contract, and event history share one viewport without editing controls.",
  },
] as const;
