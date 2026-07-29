import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const IdentifierSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/,
    "must start with a letter and contain only letters, numbers, . _ : -",
  );

export const PromptContractSchema = z
  .object({
    objective: z.string().trim().default(""),
    instructions: z.array(z.string().trim().min(1)).default([]),
    mustRead: z.array(z.string().trim().min(1)).default([]),
    doneWhen: z.array(z.string().trim().min(1)).default([]),
    outputSchema: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict()
  .default({
    objective: "",
    instructions: [],
    mustRead: [],
    doneWhen: [],
    outputSchema: null,
  });

export const NextEdgeSpecSchema = z
  .object({
    to: IdentifierSchema,
    route: IdentifierSchema.optional(),
    label: z.string().trim().max(120).optional(),
    maxTraversals: z.number().int().positive().max(100).optional(),
  })
  .strict();

export const NodeTypeSchema = z.enum([
  "start",
  "task",
  "decision",
  "join",
  "end",
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const NodeSpecSchema = z
  .object({
    id: IdentifierSchema,
    type: NodeTypeSchema,
    title: z.string().trim().min(1).max(160),
    prompt: PromptContractSchema,
    next: z.array(NextEdgeSpecSchema).default([]),
    maxAttempts: z.number().int().positive().max(20).default(3),
    actorHint: z.string().trim().max(120).nullable().default(null),
    tags: z.array(IdentifierSchema).default([]),
  })
  .strict()
  .superRefine((node, context) => {
    if (node.type === "end" && node.next.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["next"],
        message: "End must not have Next edges",
      });
    }
    if (node.type !== "end" && node.next.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["next"],
        message: `${node.type} must have at least one Next edge`,
      });
    }
    if (
      (node.type === "task" || node.type === "decision") &&
      node.prompt.objective.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["prompt", "objective"],
        message: `${node.type} requires a non-empty objective`,
      });
    }
    const routes = node.next.map((edge) => edge.route).filter(Boolean);
    if (node.type === "decision") {
      if (node.next.length < 2) {
        context.addIssue({
          code: "custom",
          path: ["next"],
          message: "Decision requires at least two routed Next edges",
        });
      }
      if (routes.length !== node.next.length) {
        context.addIssue({
          code: "custom",
          path: ["next"],
          message: "Every Decision edge requires route",
        });
      }
      if (new Set(routes).size !== routes.length) {
        context.addIssue({
          code: "custom",
          path: ["next"],
          message: "Decision routes must be unique",
        });
      }
    } else if (routes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["next"],
        message: "Only Decision edges may declare route",
      });
    }
  });

export const GraphSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    title: z.string().trim().min(1).max(180),
    goal: z.string().trim().min(1).max(4_000),
    revision: z.number().int().positive(),
    maxActive: z.number().int().positive().max(32).default(8),
    nodes: z.array(NodeSpecSchema).min(2).max(10_000),
  })
  .strict();

export type PromptContract = z.infer<typeof PromptContractSchema>;
export type NextEdgeSpec = z.infer<typeof NextEdgeSpecSchema>;
export type NodeSpec = z.infer<typeof NodeSpecSchema>;
export type GraphSpec = z.infer<typeof GraphSpecSchema>;

export const NodeStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "blocked",
  "done",
  "failed",
  "skipped",
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const GraphStatusSchema = z.enum([
  "draft",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type GraphStatus = z.infer<typeof GraphStatusSchema>;

export const EdgeStatusSchema = z.enum(["pending", "taken", "disabled"]);
export type EdgeStatus = z.infer<typeof EdgeStatusSchema>;

export const CompletionInputSchema = z
  .object({
    summary: z.string().trim().min(1).max(20_000),
    output: z.unknown().optional(),
    evidence: z.array(z.string().trim().min(1).max(2_000)).default([]),
    route: IdentifierSchema.optional(),
  })
  .strict();
export type CompletionInput = z.infer<typeof CompletionInputSchema>;

export const CheckpointInputSchema = z
  .object({
    summary: z.string().trim().min(1).max(20_000),
    progress: z.number().min(0).max(100).nullable().default(null),
    artifacts: z.array(z.string().trim().min(1).max(2_000)).default([]),
  })
  .strict();
export type CheckpointInput = z.infer<typeof CheckpointInputSchema>;

export interface ProjectConfig {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly createdAt: string;
  readonly defaultLeaseSeconds: number;
  readonly maxAssignmentsPerActor: number;
}

export interface RuntimeNode {
  readonly id: string;
  readonly type: NodeType;
  readonly title: string;
  readonly status: NodeStatus;
  readonly attempt: number;
  readonly assignmentId: string | null;
  readonly actorId: string | null;
  readonly leaseExpiresAt: string | null;
  readonly route: string | null;
  readonly result: CompletionInput | null;
  readonly checkpoint: CheckpointInput | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface RuntimeEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly route: string | null;
  readonly label: string | null;
  readonly maxTraversals: number | null;
  readonly traversals: number;
  readonly status: EdgeStatus;
  readonly updatedAt: string;
}

export interface GraphCounts {
  readonly total: number;
  readonly pending: number;
  readonly ready: number;
  readonly running: number;
  readonly blocked: number;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface GraphSummary {
  readonly runId: string;
  readonly graphId: string;
  readonly title: string;
  readonly goal: string;
  readonly specRevision: number;
  readonly runtimeRevision: number;
  readonly status: GraphStatus;
  readonly maxActive: number;
  readonly focusedNodeId: string | null;
  readonly focusedNodeTitle: string | null;
  readonly counts: GraphCounts;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GraphEvent {
  readonly sequence: number;
  readonly runId: string;
  readonly graphId: string;
  readonly nodeId: string | null;
  readonly type: string;
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface GraphSnapshot {
  readonly summary: GraphSummary;
  readonly spec: GraphSpec;
  readonly nodes: readonly RuntimeNode[];
  readonly edges: readonly RuntimeEdge[];
  readonly events: readonly GraphEvent[];
  readonly mermaid: string;
}

export interface AssignmentPacket {
  readonly schemaVersion: 1;
  readonly assignmentId: string;
  readonly projectId: string;
  readonly graph: {
    readonly runId: string;
    readonly graphId: string;
    readonly title: string;
    readonly goal: string;
    readonly specRevision: number;
    readonly runtimeRevision: number;
    readonly progress: GraphCounts;
  };
  readonly node: {
    readonly id: string;
    readonly type: "task" | "decision";
    readonly title: string;
    readonly attempt: number;
    readonly actorHint: string | null;
    readonly prompt: PromptContract;
    readonly routes: readonly {
      readonly route: string;
      readonly to: string;
      readonly label: string | null;
      readonly remainingTraversals: number | null;
    }[];
  };
  readonly context: {
    readonly predecessors: readonly {
      readonly nodeId: string;
      readonly title: string;
      readonly status: NodeStatus;
      readonly attempt: number;
      readonly route: string | null;
      readonly summary: string | null;
      readonly evidence: readonly string[];
    }[];
  };
  readonly claim: {
    readonly actorId: string;
    readonly leaseExpiresAt: string;
  };
  readonly returnProtocol: {
    readonly checkpoint: string;
    readonly complete: string;
    readonly block: string;
    readonly fail: string;
  };
}

export interface ActorWork {
  readonly actorId: string;
  readonly focused: {
    readonly runId: string;
    readonly nodeId: string;
  } | null;
  readonly claimed: readonly {
    readonly runId: string;
    readonly graphId: string;
    readonly nodeId: string;
    readonly assignmentId: string;
    readonly title: string;
    readonly leaseExpiresAt: string;
  }[];
}

export interface RuntimeChange {
  readonly revision: number;
  readonly event: GraphEvent;
}

export interface ReadyWork {
  readonly runId: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly type: "task" | "decision";
  readonly title: string;
  readonly actorHint: string | null;
  readonly attempt: number;
  readonly updatedAt: string;
}

export interface WorkSchedule {
  readonly actorId: string;
  readonly state: "assigned" | "waiting" | "completed" | "blocked";
  readonly assignments: readonly AssignmentPacket[];
  readonly remainingReady: readonly ReadyWork[];
  readonly remainingReadyCount: number;
  readonly activeRunCount: number;
  readonly runs: readonly GraphSummary[];
  readonly changes: readonly RuntimeChange[];
}

export interface CompletionContinuation extends WorkSchedule {
  readonly completed: {
    readonly assignmentId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly result: CompletionInput;
  };
  readonly replayed: boolean;
}

export interface MutationResult<T> {
  readonly revision: number;
  readonly event: GraphEvent;
  readonly value: T;
}

export class BurnGraphError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "BurnGraphError";
  }
}
