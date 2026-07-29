import type {
  GraphDetailView,
  GraphSummaryView,
} from "@burn-graph/design-system";

const counts = {
  delivery: {
    total: 8,
    pending: 2,
    ready: 1,
    running: 2,
    blocked: 0,
    done: 3,
    failed: 0,
    skipped: 0,
  },
  audit: {
    total: 5,
    pending: 1,
    ready: 0,
    running: 1,
    blocked: 1,
    done: 2,
    failed: 0,
    skipped: 0,
  },
  install: {
    total: 4,
    pending: 3,
    ready: 1,
    running: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  },
} as const;

export const previewGraphs: readonly GraphSummaryView[] = [
  {
    id: "delivery-v0.1",
    title: "Ship the first durable graph loop",
    goal: "Implement parallel graph execution, live state, and a bounded verification repair loop.",
    status: "running",
    revision: 12,
    counts: counts.delivery,
    focusedNodeTitle: "Implement state transitions",
    updatedAt: "2026-07-29T08:10:00.000Z",
  },
  {
    id: "quality-audit",
    title: "Independent quality gate",
    goal: "Review graph contracts, concurrency invariants, and blackbox outcomes without changing production code.",
    status: "running",
    revision: 7,
    counts: counts.audit,
    focusedNodeTitle: "Attack duplicate claims",
    updatedAt: "2026-07-29T08:09:22.000Z",
  },
  {
    id: "lightweight-install",
    title: "Lightweight install proof",
    goal: "Install the dependency-free release into an isolated Bun prefix and replay CLI plus Viewer startup.",
    status: "draft",
    revision: 2,
    counts: counts.install,
    focusedNodeTitle: null,
    updatedAt: "2026-07-29T08:07:48.000Z",
  },
];

export const previewDetails: Record<string, GraphDetailView> = {
  "delivery-v0.1": {
    summary: previewGraphs[0]!,
    mermaid: `flowchart LR
  start([Start]):::done --> contracts[Lock contracts]:::done
  contracts --> core[Implement core]:::running
  contracts --> viewer[Build Viewer]:::running
  core --> join{{Converge}}:::pending
  viewer --> join
  join --> verify{Verify outcome}:::ready
  verify -->|pass| finish([End]):::pending
  verify -.->|repair · 0/2| core
  classDef pending fill:#171d2a,stroke:#7c8799,color:#f3f6fb
  classDef ready fill:#17223a,stroke:#6e9fff,color:#f3f6fb,stroke-width:3px
  classDef running fill:#2a2318,stroke:#f5b84b,color:#f3f6fb,stroke-width:3px
  classDef done fill:#14271f,stroke:#54ce8f,color:#f3f6fb
  classDef blocked fill:#2a171c,stroke:#ff6e7c,color:#f3f6fb
  classDef failed fill:#2f1319,stroke:#ff475d,color:#f3f6fb
  classDef skipped fill:#171d2a,stroke:#667084,color:#a7b1c2,stroke-dasharray: 4 4`,
    nodes: [
      {
        id: "start",
        title: "Start",
        type: "start",
        status: "done",
        objective: "",
        instructions: [],
        doneWhen: [],
        actorId: null,
        attempt: 1,
        route: null,
        predecessorSummaries: [],
        resultSummary: "Graph revision 12 started.",
        updatedAt: "2026-07-29T08:00:00.000Z",
      },
      {
        id: "contracts",
        title: "Lock contracts",
        type: "task",
        status: "done",
        objective: "Lock graph semantics before production implementation.",
        instructions: ["Review User Paths and BDD.", "Freeze the JSON contract."],
        doneWhen: ["Every transition has one observable result."],
        actorId: "main",
        attempt: 1,
        route: null,
        predecessorSummaries: [],
        resultSummary: "Graph contract revision 12 locked.",
        updatedAt: "2026-07-29T08:03:00.000Z",
      },
      {
        id: "core",
        title: "Implement core",
        type: "task",
        status: "running",
        objective: "Implement transactional state transitions and atomic claims.",
        instructions: [
          "Keep graph content opaque.",
          "Emit one event per mutation.",
          "Preserve every attempt across bounded loops.",
        ],
        doneWhen: [
          "Parallel claims are atomic.",
          "Restart recovery preserves state.",
          "Known-bad controls fail.",
        ],
        actorId: "main",
        attempt: 1,
        route: null,
        predecessorSummaries: ["Graph contract revision 12 locked."],
        resultSummary: null,
        updatedAt: "2026-07-29T08:08:15.000Z",
      },
      {
        id: "viewer",
        title: "Build Viewer",
        type: "task",
        status: "running",
        objective: "Render canonical multi-graph state in a local read-only page.",
        instructions: ["Use the design-system Regions.", "Reconnect SSE by cursor."],
        doneWhen: ["Visible state matches the public CLI snapshot."],
        actorId: "ui-worker",
        attempt: 1,
        route: null,
        predecessorSummaries: ["Graph contract revision 12 locked."],
        resultSummary: null,
        updatedAt: "2026-07-29T08:08:40.000Z",
      },
      {
        id: "join",
        title: "Converge",
        type: "join",
        status: "pending",
        objective: "",
        instructions: [],
        doneWhen: [],
        actorId: null,
        attempt: 0,
        route: null,
        predecessorSummaries: [],
        resultSummary: null,
        updatedAt: "2026-07-29T08:03:00.000Z",
      },
      {
        id: "verify",
        title: "Verify outcome",
        type: "decision",
        status: "ready",
        objective: "Choose pass only when the external product result is proven.",
        instructions: ["Use browser Evidence and a clean runtime restart."],
        doneWhen: ["Return exactly one route: pass or repair."],
        actorId: null,
        attempt: 0,
        route: null,
        predecessorSummaries: [],
        resultSummary: null,
        updatedAt: "2026-07-29T08:03:00.000Z",
      },
      {
        id: "finish",
        title: "End",
        type: "end",
        status: "pending",
        objective: "",
        instructions: [],
        doneWhen: [],
        actorId: null,
        attempt: 0,
        route: null,
        predecessorSummaries: [],
        resultSummary: null,
        updatedAt: "2026-07-29T08:03:00.000Z",
      },
    ],
    events: [
      {
        sequence: 17,
        type: "node.claimed",
        nodeId: "viewer",
        summary: "ui-worker claimed Build Viewer.",
        at: "2026-07-29T08:08:40.000Z",
      },
      {
        sequence: 16,
        type: "node.claimed",
        nodeId: "core",
        summary: "main claimed Implement core.",
        at: "2026-07-29T08:08:15.000Z",
      },
      {
        sequence: 15,
        type: "node.completed",
        nodeId: "contracts",
        summary: "Lock contracts completed.",
        at: "2026-07-29T08:03:00.000Z",
      },
    ],
  },
  "quality-audit": {
    summary: previewGraphs[1]!,
    mermaid: `flowchart LR
  start([Start]):::done --> inspect[Inspect contracts]:::done
  inspect --> race[Attack claims]:::running
  inspect --> privacy[Privacy review]:::blocked
  race --> report[Report]:::pending
  privacy --> report
  report --> finish([End]):::pending
  classDef pending fill:#171d2a,stroke:#7c8799,color:#f3f6fb
  classDef ready fill:#17223a,stroke:#6e9fff,color:#f3f6fb,stroke-width:3px
  classDef running fill:#2a2318,stroke:#f5b84b,color:#f3f6fb,stroke-width:3px
  classDef done fill:#14271f,stroke:#54ce8f,color:#f3f6fb
  classDef blocked fill:#2a171c,stroke:#ff6e7c,color:#f3f6fb
  classDef failed fill:#2f1319,stroke:#ff475d,color:#f3f6fb
  classDef skipped fill:#171d2a,stroke:#667084,color:#a7b1c2,stroke-dasharray: 4 4`,
    nodes: [],
    events: [],
  },
  "lightweight-install": {
    summary: previewGraphs[2]!,
    mermaid: `flowchart LR
  start([Start]):::pending --> build[Pack release]:::ready
  build --> run[Run isolated install]:::pending
  run --> finish([End]):::pending
  classDef pending fill:#171d2a,stroke:#7c8799,color:#f3f6fb
  classDef ready fill:#17223a,stroke:#6e9fff,color:#f3f6fb,stroke-width:3px`,
    nodes: [],
    events: [],
  },
};
