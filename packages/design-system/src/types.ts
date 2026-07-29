export type VisualNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "skipped";

export type VisualGraphStatus =
  | "draft"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface GraphCountsView {
  readonly total: number;
  readonly pending: number;
  readonly ready: number;
  readonly running: number;
  readonly blocked: number;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface GraphSummaryView {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly status: VisualGraphStatus;
  readonly revision: number;
  readonly counts: GraphCountsView;
  readonly focusedNodeTitle: string | null;
  readonly updatedAt: string;
}

export interface NodeView {
  readonly id: string;
  readonly title: string;
  readonly type: "start" | "task" | "decision" | "join" | "end";
  readonly status: VisualNodeStatus;
  readonly objective: string;
  readonly instructions: readonly string[];
  readonly doneWhen: readonly string[];
  readonly actorId: string | null;
  readonly attempt: number;
  readonly route: string | null;
  readonly predecessorSummaries: readonly string[];
  readonly resultSummary: string | null;
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
}

export type ViewerConnection = "connected" | "reconnecting" | "offline";
