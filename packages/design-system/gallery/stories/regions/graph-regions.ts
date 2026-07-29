export const graphRegionStories = [
  {
    id: "REGION-GRAPH-OVERVIEW",
    title: "Multi-graph overview",
    platforms: ["web"],
    states: [
      "active",
      "hierarchy-folded",
      "mixed-status",
      "resource-contention",
      "empty",
      "reconnecting",
      "narrow",
    ],
    userPathRefs: ["UP02", "UP03", "UP06", "UP09"],
    notes:
      "Root progress, descendant counts, priority, active work, and durable Waits remain readable before any child detail is opened.",
  },
  {
    id: "REGION-GRAPH-DETAIL",
    title: "Live graph detail",
    platforms: ["web"],
    states: [
      "parallel",
      "hierarchy-expanded",
      "machine-gate-repair",
      "durable-wait",
      "metrics",
      "blocked",
      "completed",
      "long-content",
    ],
    userPathRefs: ["UP01", "UP03", "UP06", "UP07", "UP08", "UP10"],
    notes:
      "Fold controls, child Runs, topology, machine evidence, node contract, metrics, and events share one read-only viewport.",
  },
] as const;
