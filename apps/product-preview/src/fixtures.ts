import type {
  GraphDetailView,
  GraphSummaryView,
  NodeView,
} from "@burn-graph/design-system";

const classDefinitions = `  classDef pending fill:#171d2a,stroke:#7c8799,color:#f3f6fb
  classDef ready fill:#17223a,stroke:#6e9fff,color:#f3f6fb,stroke-width:3px
  classDef running fill:#2a2318,stroke:#f5b84b,color:#f3f6fb,stroke-width:3px
  classDef waiting fill:#241b35,stroke:#a984ff,color:#f3f6fb,stroke-width:3px
  classDef blocked fill:#2a171c,stroke:#ff6e7c,color:#f3f6fb,stroke-width:3px
  classDef done fill:#14271f,stroke:#54ce8f,color:#f3f6fb
  classDef failed fill:#2f1319,stroke:#ff475d,color:#f3f6fb,stroke-width:3px
  classDef cancelled fill:#25171c,stroke:#b86a76,color:#d7c4c8,stroke-dasharray: 5 4
  classDef skipped fill:#171d2a,stroke:#667084,color:#a7b1c2,stroke-dasharray: 4 4`;

function node(
  value: Pick<NodeView, "id" | "title" | "type" | "status"> &
    Partial<Omit<NodeView, "id" | "title" | "type" | "status">>,
): NodeView {
  return {
    objective: "",
    instructions: [],
    doneWhen: [],
    actorId: null,
    attempt: 0,
    route: null,
    predecessorSummaries: [],
    resultSummary: null,
    systemDetail: null,
    updatedAt: "2026-07-30T08:30:00.000Z",
    ...value,
  };
}

const deliveryRoot: GraphSummaryView = {
  id: "delivery-rc1",
  title: "Converge burn-graph 1.0.0-dev.3",
  goal: "Deliver hierarchy, machine evidence, durable waits, templates, and an honest dogfood verdict.",
  status: "running",
  revision: 28,
  priority: "high",
  hierarchy: {
    rootRunId: "delivery-rc1",
    parentRunId: null,
    parentNodeId: null,
    depth: 0,
    childRuns: 4,
    descendantRuns: 8,
  },
  counts: {
    total: 12,
    pending: 2,
    ready: 1,
    running: 2,
    waiting: 1,
    blocked: 0,
    done: 6,
    failed: 0,
    skipped: 0,
  },
  focusedNodeTitle: "Deliver vertical slices",
  updatedAt: "2026-07-30T08:30:00.000Z",
};

const hotfixRoot: GraphSummaryView = {
  id: "bugfix-signal-replay",
  title: "Repair stale Signal replay",
  goal: "Reproduce, repair, machine-check, and review one bounded bug fix.",
  status: "running",
  revision: 9,
  priority: "normal",
  hierarchy: {
    rootRunId: "bugfix-signal-replay",
    parentRunId: null,
    parentNodeId: null,
    depth: 0,
    childRuns: 2,
    descendantRuns: 2,
  },
  counts: {
    total: 7,
    pending: 1,
    ready: 1,
    running: 1,
    waiting: 0,
    blocked: 0,
    done: 4,
    failed: 0,
    skipped: 0,
  },
  focusedNodeTitle: "Run concurrency regression",
  updatedAt: "2026-07-30T08:28:40.000Z",
};

const releaseRoot: GraphSummaryView = {
  id: "release-package",
  title: "Build isolated candidate package",
  goal: "Wait for delivery evidence, then package and verify the exact local release candidate.",
  status: "running",
  revision: 5,
  priority: "low",
  hierarchy: {
    rootRunId: "release-package",
    parentRunId: null,
    parentNodeId: null,
    depth: 0,
    childRuns: 1,
    descendantRuns: 1,
  },
  counts: {
    total: 5,
    pending: 2,
    ready: 0,
    running: 0,
    waiting: 1,
    blocked: 0,
    done: 2,
    failed: 0,
    skipped: 0,
  },
  focusedNodeTitle: "Wait for full verification",
  updatedAt: "2026-07-30T08:24:12.000Z",
};

export const previewGraphs: readonly GraphSummaryView[] = [
  deliveryRoot,
  hotfixRoot,
  releaseRoot,
];

const childRuns: readonly GraphSummaryView[] = [
  {
    id: "contracts-dev5",
    title: "Lock v2 contracts",
    goal: "Lock schema, migration, CLI, BDD, and projection contracts.",
    status: "completed",
    revision: 11,
    priority: "high",
    hierarchy: {
      rootRunId: "delivery-rc1",
      parentRunId: "delivery-rc1",
      parentNodeId: "contracts",
      depth: 1,
      childRuns: 0,
      descendantRuns: 0,
    },
    counts: {
      total: 6,
      pending: 0,
      ready: 0,
      running: 0,
      waiting: 0,
      blocked: 0,
      done: 6,
      failed: 0,
      skipped: 0,
    },
    focusedNodeTitle: null,
    updatedAt: "2026-07-30T08:10:00.000Z",
  },
  {
    id: "slice-hierarchy",
    title: "Parent-child runtime",
    goal: "Start, aggregate, recover, and render static and dynamic child Runs.",
    status: "running",
    revision: 16,
    priority: "high",
    hierarchy: {
      rootRunId: "delivery-rc1",
      parentRunId: "delivery-rc1",
      parentNodeId: "slices",
      depth: 1,
      childRuns: 2,
      descendantRuns: 2,
    },
    counts: {
      total: 8,
      pending: 2,
      ready: 1,
      running: 2,
      waiting: 0,
      blocked: 0,
      done: 3,
      failed: 0,
      skipped: 0,
    },
    focusedNodeTitle: "Implement atomic child start",
    updatedAt: "2026-07-30T08:29:40.000Z",
  },
  {
    id: "slice-gate-wait",
    title: "Machine Gate and Wait",
    goal: "Reject known-bad evidence and resume durable external outcomes.",
    status: "running",
    revision: 13,
    priority: "normal",
    hierarchy: {
      rootRunId: "delivery-rc1",
      parentRunId: "delivery-rc1",
      parentNodeId: "slices",
      depth: 1,
      childRuns: 1,
      descendantRuns: 1,
    },
    counts: {
      total: 9,
      pending: 2,
      ready: 0,
      running: 1,
      waiting: 1,
      blocked: 0,
      done: 5,
      failed: 0,
      skipped: 0,
    },
    focusedNodeTitle: "Wait for isolated package",
    updatedAt: "2026-07-30T08:29:15.000Z",
  },
  {
    id: "review-rc1",
    title: "Read-only quality review",
    goal: "Attack contracts, safety, migration, E2E, performance, and package boundaries.",
    status: "paused",
    revision: 2,
    priority: "normal",
    hierarchy: {
      rootRunId: "delivery-rc1",
      parentRunId: "delivery-rc1",
      parentNodeId: "review",
      depth: 1,
      childRuns: 0,
      descendantRuns: 0,
    },
    counts: {
      total: 6,
      pending: 5,
      ready: 1,
      running: 0,
      waiting: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    },
    focusedNodeTitle: null,
    updatedAt: "2026-07-30T08:15:00.000Z",
  },
];

const rootNodes: readonly NodeView[] = [
  node({
    id: "start",
    title: "Start delivery root",
    type: "start",
    status: "done",
    attempt: 1,
    resultSummary: "Root pinned delivery template revision 3.",
  }),
  node({
    id: "contracts",
    title: "Contract child",
    type: "subgraph",
    status: "done",
    attempt: 1,
    route: "success",
    resultSummary: "contracts-dev5 completed 6/6 nodes.",
    systemDetail:
      "Static child contracts-dev5 · GraphSpec delivery-contract@2 · depth 1.",
  }),
  node({
    id: "plan-slices",
    title: "Plan vertical slices",
    type: "subgraph",
    status: "done",
    objective:
      "Inspect the locked product and return the complete immutable child set.",
    instructions: [
      "Create one child per user-visible vertical result.",
      "Return child GraphSpec IDs and exact revisions through ordinary done.",
    ],
    doneWhen: ["Every child has a locked path, BDD, and file owner."],
    actorId: "main-codex",
    attempt: 1,
    resultSummary: "Attached four child Runs atomically.",
    systemDetail:
      "Dynamic child set sealed · replay digest 8c9f… · no attach/seal command.",
  }),
  node({
    id: "slices",
    title: "Deliver vertical slices",
    type: "subgraph",
    status: "waiting",
    attempt: 1,
    systemDetail:
      "2/4 direct child Runs completed · 2 Running · parent Assignment released.",
  }),
  node({
    id: "package-wait",
    title: "Wait for isolated package",
    type: "wait",
    status: "waiting",
    systemDetail:
      "Signal sig_7fc2… awaits package.pass or package.fail · timeout in 18m.",
  }),
  node({
    id: "quality-gate",
    title: "Full verification",
    type: "gate",
    status: "ready",
    systemDetail:
      "Pinned Check full-verify@4 · exact argv · exclusive resource rust-build.",
  }),
  node({
    id: "review",
    title: "Quality review child",
    type: "subgraph",
    status: "pending",
  }),
  node({
    id: "end",
    title: "Candidate ready",
    type: "end",
    status: "pending",
  }),
];

const foldedMermaid = `flowchart LR
  start([Start]):::done --> contracts[["Contracts child · 6/6"]]:::done
  contracts --> plan[["Plan slice children · 4 attached"]]:::done
  plan --> slices[["Vertical slices · 2/4"]]:::waiting
  slices --> wait[/"Wait: isolated package"/]:::waiting
  wait --> gate{{"Gate: full verification"}}:::ready
  gate -->|pass| review[["Quality review child"]]:::pending
  gate -.->|fail · repair 0/2| slices
  review --> finish([RC ready]):::pending
${classDefinitions}`;

const expandedMermaid = `flowchart TB
  subgraph root["delivery-rc1 · root"]
    start([Start]):::done --> contracts[["Contracts · 6/6"]]:::done
    contracts --> slices[["Vertical slices · 2/4"]]:::waiting
    slices --> wait[/"Wait: package"/]:::waiting
    wait --> gate{{"Gate: full verification"}}:::ready
    gate --> finish([RC ready]):::pending
  end
  subgraph hierarchy["slice-hierarchy · child depth 1"]
    hstart([Start]):::done --> hcore["Atomic child start"]:::running
    hcore --> hview["Tree projection"]:::ready
    hview --> hcheck{{"Migration Gate"}}:::pending
  end
  subgraph system["slice-gate-wait · child depth 1"]
    sstart([Start]):::done --> runner["Exact Gate runner"]:::running
    runner --> signal[/"Wait signal restart"/]:::waiting
    signal --> scheck{{"Known-bad Gate"}}:::pending
  end
  slices -.-> hierarchy
  slices -.-> system
${classDefinitions}`;

const baseEvents = [
  {
    sequence: 228,
    type: "subgraph.waiting",
    nodeId: "slices",
    summary: "Vertical slices is waiting on two unfinished child Runs.",
    at: "2026-07-30T08:29:45.000Z",
  },
  {
    sequence: 227,
    type: "wait.created",
    nodeId: "package-wait",
    summary: "Created durable package Signal with a bounded timeout.",
    at: "2026-07-30T08:29:15.000Z",
  },
  {
    sequence: 226,
    type: "subgraph.children_started",
    nodeId: "plan-slices",
    summary: "Atomically attached and started four dynamic child Runs.",
    at: "2026-07-30T08:25:00.000Z",
  },
];

export const hierarchyFoldedDetail: GraphDetailView = {
  summary: deliveryRoot,
  mermaid: foldedMermaid,
  nodes: rootNodes,
  children: childRuns,
  projection: {
    depth: 0,
    maximumDepth: 8,
    foldedRuns: 8,
    renderedNodes: 8,
  },
  metrics: [
    { label: "Live Assignments", value: "2", tone: "good" },
    { label: "Waiting Runs", value: "2", tone: "warning" },
    { label: "Repairs", value: "1" },
    { label: "Recovered leases", value: "1", tone: "good" },
  ],
  events: baseEvents,
};

export const hierarchyExpandedDetail: GraphDetailView = {
  ...hierarchyFoldedDetail,
  mermaid: expandedMermaid,
  projection: {
    depth: 1,
    maximumDepth: 8,
    foldedRuns: 4,
    renderedNodes: 14,
  },
};

export const gateRepairDetail: GraphDetailView = {
  summary: {
    ...childRuns[2]!,
    focusedNodeTitle: "Repair known-bad fixture",
  },
  mermaid: `flowchart LR
  start([Start]):::done --> implement["Implement Gate runner"]:::done
  implement --> gate{{"Check: known-bad fixture"}}:::failed
  gate -->|fail| repair["Repair timeout cleanup"]:::running
  repair --> retry{{"Check: fixed fixture"}}:::pending
  retry -->|pass| finish([Done]):::pending
  retry -.->|fail · 1/2| repair
${classDefinitions}`,
  nodes: [
    node({ id: "start", title: "Start", type: "start", status: "done" }),
    node({
      id: "implement",
      title: "Implement Gate runner",
      type: "task",
      status: "done",
      actorId: "main-codex",
      attempt: 1,
      resultSummary: "Exact argv runner and execution token implemented.",
    }),
    node({
      id: "gate",
      title: "Known-bad fixture",
      type: "gate",
      status: "failed",
      attempt: 1,
      route: "fail",
      resultSummary: "Exit 1 · digest 44f1… · 842 ms.",
      systemDetail:
        "Check gate-known-bad@1 rejected the seeded stale-signal behavior.",
    }),
    node({
      id: "repair",
      title: "Repair timeout cleanup",
      type: "task",
      status: "running",
      actorId: "main-codex",
      attempt: 1,
      predecessorSummaries: [
        "Known-bad fixture failed with one stale Signal accepted.",
      ],
      objective: "Reject stale Signal handles without changing the active Wait.",
      doneWhen: ["Known-bad check exits zero after proving the defect is gone."],
    }),
    node({
      id: "retry",
      title: "Fixed fixture",
      type: "gate",
      status: "pending",
      systemDetail: "Pinned Check gate-known-bad@1 will run without a shell.",
    }),
    node({ id: "finish", title: "Done", type: "end", status: "pending" }),
  ],
  metrics: [
    { label: "Gate attempts", value: "1" },
    { label: "Known-bad caught", value: "yes", tone: "good" },
    { label: "Sentinel", value: "alive", tone: "good" },
    { label: "Output captured", value: "3.1 KiB" },
  ],
  events: [
    {
      sequence: 182,
      type: "gate.completed",
      nodeId: "gate",
      summary: "Known-bad fixture selected fail and unlocked repair.",
      at: "2026-07-30T08:20:12.000Z",
    },
  ],
};

export const durableWaitDetail: GraphDetailView = {
  summary: releaseRoot,
  mermaid: `flowchart LR
  start([Start]):::done --> prepare["Prepare package input"]:::done
  prepare --> wait[/"Wait: delivery verified"/]:::waiting
  wait -->|verified| package["Build exact artifact"]:::pending
  wait -->|timeout| inspect["Inspect stalled delivery"]:::pending
  package --> finish([Done]):::pending
  inspect -.->|resume · 0/1| wait
${classDefinitions}`,
  nodes: [
    node({ id: "start", title: "Start", type: "start", status: "done" }),
    node({
      id: "prepare",
      title: "Prepare package input",
      type: "task",
      status: "done",
      resultSummary: "Candidate manifest is ready.",
    }),
    node({
      id: "wait",
      title: "Wait for delivery verified",
      type: "wait",
      status: "waiting",
      systemDetail:
        "Signal sig_7fc2… survived restart · no Assignment · paused time excluded.",
    }),
    node({
      id: "package",
      title: "Build exact artifact",
      type: "task",
      status: "pending",
    }),
    node({
      id: "inspect",
      title: "Inspect stalled delivery",
      type: "task",
      status: "pending",
    }),
    node({ id: "finish", title: "Done", type: "end", status: "pending" }),
  ],
  metrics: [
    { label: "Signal age", value: "11m 42s" },
    { label: "Actor slots used", value: "0", tone: "good" },
    { label: "Restarts survived", value: "1", tone: "good" },
    { label: "Timeout remaining", value: "18m 18s", tone: "warning" },
  ],
  events: [
    {
      sequence: 205,
      type: "wait.recovered",
      nodeId: "wait",
      summary: "Recovered unresolved Signal after CLI restart.",
      at: "2026-07-30T08:24:12.000Z",
    },
  ],
};

export const lifecycleControlDetail: GraphDetailView = {
  summary: {
    ...deliveryRoot,
    title: "Quiesce and cancel without unsafe process control",
    goal: "Pause new work immediately while valid handles settle, and cancel unowned Gate execution through bounded stale-result cleanup.",
    status: "pausing",
    revision: 29,
    counts: {
      total: 7,
      pending: 2,
      ready: 0,
      running: 2,
      waiting: 1,
      blocked: 0,
      done: 1,
      failed: 0,
      cancelled: 1,
      skipped: 0,
    },
    focusedNodeTitle: "Await exact Gate quiescence",
    updatedAt: "2026-07-30T08:32:00.000Z",
  },
  mermaid: `flowchart LR
  start([Pause requested]):::done --> task["Owned Assignment settles"]:::running
  start --> gate{{"Running Gate stays exact"}}:::running
  start --> wait[/"Wait clock frozen"/]:::waiting
  start -.-> cancelled["Revoked AI work"]:::cancelled
  task --> paused["Paused after quiescence"]:::pending
  gate --> paused
  wait --> paused
  cancelled -.-> paused
  paused --> finish([Resume or Cancelled]):::pending
${classDefinitions}`,
  nodes: [
    node({
      id: "start",
      title: "Pause requested",
      type: "start",
      status: "done",
      resultSummary: "Suppressed new Assignments, child starts, and Gate starts.",
    }),
    node({
      id: "task",
      title: "Owned Assignment settles",
      type: "task",
      status: "running",
      actorId: "main-codex",
      attempt: 1,
      objective: "Finish or release the already valid Assignment handle.",
      systemDetail: "No successor will be scheduled while the tree is Pausing.",
    }),
    node({
      id: "gate",
      title: "Running Gate stays exact",
      type: "gate",
      status: "running",
      systemDetail:
        "Execution chk_91ad… is bounded and owned by another CLI; cancellation makes its result stale instead of signalling its PID.",
    }),
    node({
      id: "wait",
      title: "Wait clock frozen",
      type: "wait",
      status: "waiting",
      systemDetail: "Deadline is frozen from the root pause request.",
    }),
    node({
      id: "cancelled",
      title: "Revoked AI work",
      type: "task",
      status: "cancelled",
      resultSummary:
        "Assignment handle is stale and its logical resource was released.",
    }),
    node({
      id: "paused",
      title: "Paused after quiescence",
      type: "join",
      status: "pending",
      systemDetail:
        "Becomes Paused only after live Assignments, Gate executions, and their resources settle.",
    }),
    node({
      id: "finish",
      title: "Resume or Cancelled",
      type: "end",
      status: "pending",
    }),
  ],
  children: childRuns.map((child, index) =>
    index === 3
      ? {
          ...child,
          status: "cancelling" as const,
          focusedNodeTitle: "Await exact Gate lease",
        }
      : child,
  ),
  projection: {
    depth: 0,
    maximumDepth: 8,
    foldedRuns: 8,
    renderedNodes: 7,
  },
  metrics: [
    { label: "Tree lifecycle", value: "pausing", tone: "warning" },
    { label: "Live Assignments", value: "1" },
    { label: "Live Gate executions", value: "1" },
    { label: "Wait clocks frozen", value: "1", tone: "good" },
    { label: "New work started", value: "0", tone: "good" },
    { label: "PID lookups", value: "0", tone: "good" },
  ],
  events: [
    {
      sequence: 242,
      type: "run.pause_requested",
      nodeId: null,
      summary:
        "Marked the unfinished tree Pausing and suppressed new work atomically.",
      at: "2026-07-30T08:31:45.000Z",
    },
    {
      sequence: 243,
      type: "gate.cancellation_stale",
      nodeId: "gate",
      summary:
        "Invalidated the Gate result and retained its resource until exact exit or lease.",
      at: "2026-07-30T08:32:00.000Z",
    },
  ],
};

export const resourceContentionDetail: GraphDetailView = {
  summary: {
    id: "resource-contention",
    title: "Serialize shared Rust verification",
    goal: "Keep independent work moving while one exact owner holds the shared rust-build resource.",
    status: "running",
    revision: 7,
    priority: "high",
    hierarchy: {
      rootRunId: "resource-contention",
      parentRunId: null,
      parentNodeId: null,
      depth: 0,
      childRuns: 0,
      descendantRuns: 0,
    },
    counts: {
      total: 7,
      pending: 2,
      ready: 1,
      running: 1,
      waiting: 1,
      blocked: 0,
      done: 2,
      failed: 0,
      skipped: 0,
    },
    focusedNodeTitle: "Wait for rust-build lock",
    updatedAt: "2026-07-30T08:31:30.000Z",
  },
  mermaid: `flowchart LR
  start([Start]):::done --> plan["Plan bounded checks"]:::done
  plan --> scoped["Run package tests"]:::running
  plan --> docs["Validate contracts"]:::ready
  scoped --> lock[/"Wait: rust-build lock"/]:::waiting
  lock --> full{{"Gate: full Rust suite"}}:::pending
  docs --> full
  full --> finish([Done]):::pending
${classDefinitions}`,
  nodes: [
    node({ id: "start", title: "Start", type: "start", status: "done" }),
    node({
      id: "plan",
      title: "Plan bounded checks",
      type: "task",
      status: "done",
      resultSummary: "Separated package-local work from the shared full-build Gate.",
    }),
    node({
      id: "scoped",
      title: "Run package tests",
      type: "task",
      status: "running",
      actorId: "main-codex",
      attempt: 1,
      objective: "Finish checks that do not require the shared build resource.",
    }),
    node({
      id: "docs",
      title: "Validate contracts",
      type: "task",
      status: "ready",
      objective: "Validate docs and schemas while the build resource is occupied.",
    }),
    node({
      id: "lock",
      title: "Wait for rust-build lock",
      type: "wait",
      status: "waiting",
      systemDetail:
        "Resource rust-build is owned by slice-hierarchy until 08:39:00 · no actor slot consumed.",
    }),
    node({
      id: "full",
      title: "Full Rust suite",
      type: "gate",
      status: "pending",
      systemDetail:
        "Pinned Check full-rust-suite@2 starts only after the exact resource lease transfers.",
    }),
    node({ id: "finish", title: "Done", type: "end", status: "pending" }),
  ],
  metrics: [
    { label: "Resource", value: "rust-build" },
    { label: "Current owner", value: "slice-hierarchy" },
    { label: "Queue age", value: "2m 14s", tone: "warning" },
    { label: "Actor slots used", value: "1", tone: "good" },
    { label: "Safe work ready", value: "1", tone: "good" },
    { label: "Lease remaining", value: "7m 30s" },
  ],
  events: [
    {
      sequence: 241,
      type: "resource.waiting",
      nodeId: "lock",
      summary:
        "Queued behind the exact rust-build owner and kept unrelated work eligible.",
      at: "2026-07-30T08:31:30.000Z",
    },
  ],
};

export const dogfoodMetricsDetail: GraphDetailView = {
  ...hierarchyExpandedDetail,
  metrics: [
    { label: "Root / child Runs", value: "3 / 11" },
    { label: "Max live work", value: "4", tone: "good" },
    { label: "Repairs caught", value: "2", tone: "good" },
    { label: "Duplicate work", value: "0", tone: "good" },
    { label: "Lease recoveries", value: "1", tone: "good" },
    { label: "Control p95", value: "42 ms", tone: "good" },
    { label: "Known-bad escaped", value: "0", tone: "good" },
    { label: "Verdict", value: "pending", tone: "warning" },
  ],
};

export const previewDetails: Record<string, GraphDetailView> = {
  "delivery-rc1": hierarchyExpandedDetail,
  "bugfix-signal-replay": gateRepairDetail,
  "release-package": durableWaitDetail,
  "slice-gate-wait": gateRepairDetail,
};
