export type VisualNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

export type VisualGraphStatus =
  | "draft"
  | "running"
  | "pausing"
  | "paused"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface GraphCountsView {
  readonly total: number;
  readonly pending: number;
  readonly ready: number;
  readonly running: number;
  readonly waiting?: number;
  readonly blocked: number;
  readonly done: number;
  readonly failed: number;
  readonly cancelled?: number;
  readonly skipped: number;
}

export type VisualRunPriority = "low" | "normal" | "high";

export interface GraphHierarchyView {
  readonly rootRunId: string;
  readonly parentRunId: string | null;
  readonly parentNodeId: string | null;
  readonly depth: number;
  readonly childRuns: number;
  readonly descendantRuns: number;
}

export interface GraphSummaryView {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly status: VisualGraphStatus;
  readonly revision: number;
  readonly counts: GraphCountsView;
  readonly focusedNodeTitle: string | null;
  readonly priority?: VisualRunPriority;
  readonly hierarchy?: GraphHierarchyView;
  readonly updatedAt: string;
}

export interface NodeView {
  readonly id: string;
  readonly title: string;
  readonly type:
    | "start"
    | "task"
    | "decision"
    | "join"
    | "subgraph"
    | "gate"
    | "wait"
    | "end";
  readonly status: VisualNodeStatus;
  readonly objective: string;
  readonly instructions: readonly string[];
  readonly doneWhen: readonly string[];
  readonly actorId: string | null;
  readonly attempt: number;
  readonly route: string | null;
  readonly predecessorSummaries: readonly string[];
  readonly resultSummary: string | null;
  readonly systemDetail?: string | null;
  readonly updatedAt: string;
}

export interface GraphEventView {
  readonly sequence: number;
  readonly type: string;
  readonly nodeId: string | null;
  readonly summary: string;
  readonly at: string;
}

export interface GraphDetailView {
  readonly summary: GraphSummaryView;
  readonly mermaid: string;
  readonly nodes: readonly NodeView[];
  readonly events: readonly GraphEventView[];
  readonly children?: readonly GraphSummaryView[];
  readonly projection?: {
    readonly depth: number;
    readonly maximumDepth: number;
    readonly foldedRuns: number;
    readonly renderedNodes: number;
  };
  readonly metrics?: readonly {
    readonly label: string;
    readonly value: string;
    readonly tone?: "default" | "good" | "warning";
  }[];
}

export type ViewerConnection = "connected" | "reconnecting" | "offline";
