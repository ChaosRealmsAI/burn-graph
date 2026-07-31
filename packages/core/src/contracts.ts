import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const MAX_PROMPT_CONTRACT_BYTES = 32 * 1024;
export const MAX_COMPLETION_CONTEXT_BYTES = 8 * 1024;
export const MAX_ACTOR_ASSIGNMENT_BYTES = 128 * 1024;

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export const IdentifierSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/,
    "must start with a letter and contain only letters, numbers, . _ : -",
  );

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/,
    "must contain 1-200 letters, numbers, . _ : -",
  );

export const PromptContractSchema = z
  .object({
    objective: z.string().trim().default(""),
    instructions: z.array(z.string().trim().min(1)).default([]),
    mustRead: z.array(z.string().trim().min(1)).default([]),
    doneWhen: z.array(z.string().trim().min(1)).default([]),
    outputSchema: z.record(z.string(), z.unknown()).nullable().default(null),
    role: z.string().trim().max(2_000).default(""),
    lockedContracts: z.array(z.string().trim().min(1).max(2_000)).default([]),
    writablePaths: z.array(z.string().trim().min(1).max(2_000)).default([]),
    forbidden: z.array(z.string().trim().min(1).max(2_000)).default([]),
    runtime: z.array(z.string().trim().min(1).max(2_000)).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = serializedBytes(value);
    if (bytes > MAX_PROMPT_CONTRACT_BYTES) {
      context.addIssue({
        code: "custom",
        message:
          `complete prompt contract exceeds ${MAX_PROMPT_CONTRACT_BYTES} UTF-8 bytes`,
      });
    }
  })
  .default({
    objective: "",
    instructions: [],
    mustRead: [],
    doneWhen: [],
    outputSchema: null,
    role: "",
    lockedContracts: [],
    writablePaths: [],
    forbidden: [],
    runtime: [],
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
  "subgraph",
  "gate",
  "wait",
  "end",
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const ChildRunDescriptorSchema = z
  .object({
    graphId: IdentifierSchema,
    revision: z.number().int().positive(),
    runId: IdentifierSchema.optional(),
    label: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const CheckReferenceSchema = z
  .object({
    id: IdentifierSchema,
    revision: z.number().int().positive(),
  })
  .strict();

export const WaitTimeoutSchema = z
  .object({
    afterMs: z.number().int().positive().max(31_536_000_000),
    route: IdentifierSchema,
  })
  .strict();

export const WaitSignalSpecSchema = z
  .object({
    routes: z.array(IdentifierSchema).min(1).max(32),
    timeout: WaitTimeoutSchema.optional(),
  })
  .strict()
  .superRefine((signal, context) => {
    if (new Set(signal.routes).size !== signal.routes.length) {
      context.addIssue({
        code: "custom",
        path: ["routes"],
        message: "Wait Signal routes must be unique",
      });
    }
    if (signal.timeout && signal.routes.includes(signal.timeout.route)) {
      context.addIssue({
        code: "custom",
        path: ["timeout", "route"],
        message: "Wait timeout route must be distinct from Signal routes",
      });
    }
  });

const ResourceNamesSchema = z.array(IdentifierSchema).max(32).superRefine(
  (resources, context) => {
    if (new Set(resources).size !== resources.length) {
      context.addIssue({
        code: "custom",
        message: "Resources must be unique",
      });
    }
  },
);

export const ProjectRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .superRefine((value, context) => {
    const segments = value.split(/[\\/]/);
    if (
      value.includes("\0") ||
      value.startsWith("/") ||
      value.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      segments.includes("..")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a confined project-relative path",
      });
    }
  });

const CheckArgumentSchema = z
  .string()
  .max(4_096)
  .refine((value) => !value.includes("\0") && !value.includes("\n"), {
    message: "Check argv entries cannot contain NUL or newlines",
  });

const SafeInheritedEnvironmentSchema = z.enum([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
]);

export const CheckSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).max(160),
    argv: z.array(CheckArgumentSchema).min(1).max(64),
    cwd: ProjectRelativePathSchema,
    successExitCodes: z.array(z.number().int().min(0).max(255)).min(1).max(32),
    timeoutMs: z.number().int().min(10).max(900_000),
    maxOutputBytes: z.number().int().min(1).max(1_048_576),
    inheritEnv: z.array(SafeInheritedEnvironmentSchema).max(7),
    resources: ResourceNamesSchema.default([]),
  })
  .strict()
  .superRefine((check, context) => {
    if (new Set(check.successExitCodes).size !== check.successExitCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["successExitCodes"],
        message: "Success exit codes must be unique",
      });
    }
    if (new Set(check.inheritEnv).size !== check.inheritEnv.length) {
      context.addIssue({
        code: "custom",
        path: ["inheritEnv"],
        message: "Inherited environment names must be unique",
      });
    }
    const executable = check.argv[0]!.replaceAll("\\", "/");
    const base = executable.split("/").at(-1)?.toLowerCase();
    if (
      executable.startsWith("/") ||
      /^[A-Za-z]:\//.test(executable) ||
      executable.split("/").includes("..") ||
      ["sh", "bash", "zsh", "fish", "dash", "cmd", "cmd.exe", "powershell", "pwsh"].includes(
        base ?? "",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["argv", 0],
        message: "Check executable must be a non-shell confined argv entry",
      });
    }
  });
export type CheckSpec = z.infer<typeof CheckSpecSchema>;

export const GateExecutionClassificationSchema = z.enum([
  "success",
  "non_success",
  "timeout",
  "output_limit",
  "spawn_error",
]);
export type GateExecutionClassification = z.infer<
  typeof GateExecutionClassificationSchema
>;

export const GateExecutionResultSchema = z
  .object({
    classification: GateExecutionClassificationSchema,
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative().max(3_600_000),
    byteCount: z.number().int().nonnegative().max(1_048_576),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    stdout: z.string().max(1_048_576),
    stderr: z.string().max(1_048_576),
  })
  .strict();
export type GateExecutionResult = z.infer<typeof GateExecutionResultSchema>;

export const SignalResolutionInputSchema = z
  .object({
    summary: z.string().trim().min(1).max(20_000),
    evidence: z.array(ProjectRelativePathSchema).max(64).default([]),
  })
  .strict();
export type SignalResolutionInput = z.infer<
  typeof SignalResolutionInputSchema
>;

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
    mode: z.enum(["static", "dynamic"]).optional(),
    children: z.array(ChildRunDescriptorSchema).min(1).max(256).optional(),
    minChildren: z.number().int().positive().max(256).optional(),
    maxChildren: z.number().int().positive().max(256).optional(),
    check: CheckReferenceSchema.optional(),
    signal: WaitSignalSpecSchema.optional(),
    resources: ResourceNamesSchema.optional(),
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
      (node.type === "task" ||
        node.type === "decision" ||
        (node.type === "subgraph" && node.mode === "dynamic")) &&
      node.prompt.objective.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["prompt", "objective"],
        message: `${node.type} requires a non-empty objective`,
      });
    }

    if (node.type === "subgraph") {
      if (!node.mode) {
        context.addIssue({
          code: "custom",
          path: ["mode"],
          message: "Subgraph requires static or dynamic mode",
        });
      } else if (node.mode === "static") {
        if (!node.children || node.children.length === 0) {
          context.addIssue({
            code: "custom",
            path: ["children"],
            message: "Static Subgraph requires children",
          });
        }
        if (
          node.minChildren !== undefined ||
          node.maxChildren !== undefined
        ) {
          context.addIssue({
            code: "custom",
            path: ["minChildren"],
            message: "Static Subgraph cannot declare dynamic bounds",
          });
        }
      } else {
        if (node.children !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["children"],
            message: "Dynamic Subgraph cannot declare static children",
          });
        }
        if (
          node.minChildren === undefined ||
          node.maxChildren === undefined ||
          node.minChildren > node.maxChildren
        ) {
          context.addIssue({
            code: "custom",
            path: ["maxChildren"],
            message: "Dynamic Subgraph requires an ordered child range",
          });
        }
      }
    } else if (
      node.mode !== undefined ||
      node.children !== undefined ||
      node.minChildren !== undefined ||
      node.maxChildren !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "Only Subgraph may declare child configuration",
      });
    }

    if (node.type === "gate" && node.check === undefined) {
      context.addIssue({
        code: "custom",
        path: ["check"],
        message: "Gate requires an exact Check revision",
      });
    } else if (node.type !== "gate" && node.check !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["check"],
        message: "Only Gate may reference a Check",
      });
    }

    if (node.type === "wait" && node.signal === undefined) {
      context.addIssue({
        code: "custom",
        path: ["signal"],
        message: "Wait requires a Signal contract",
      });
    } else if (node.type !== "wait" && node.signal !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["signal"],
        message: "Only Wait may declare a Signal",
      });
    }

    if (
      node.resources !== undefined &&
      !["task", "subgraph", "gate"].includes(node.type)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resources"],
        message: "Only Task, Subgraph, and Gate may declare resources",
      });
    }

    const routes = node.next.map((edge) => edge.route).filter(Boolean);
    const routedNode = ["decision", "subgraph", "gate", "wait"].includes(
      node.type,
    );
    if (routedNode) {
      if (node.type === "decision" && node.next.length < 2) {
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
          message: `Every ${node.type} edge requires route`,
        });
      }
      if (new Set(routes).size !== routes.length) {
        context.addIssue({
          code: "custom",
          path: ["next"],
          message: `${node.type} routes must be unique`,
        });
      }
    } else if (routes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["next"],
        message: "Only routed nodes may declare route",
      });
    }
  });

const GraphSpecV1Schema = z
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

const GraphSpecV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: IdentifierSchema,
    title: z.string().trim().min(1).max(180),
    goal: z.string().trim().min(1).max(4_000),
    revision: z.number().int().positive(),
    maxActive: z.number().int().positive().max(32).default(8),
    nodes: z.array(NodeSpecSchema).min(2).max(10_000),
  })
  .strict();

export const GraphSpecSchema = z.discriminatedUnion("schemaVersion", [
  GraphSpecV1Schema,
  GraphSpecV2Schema,
]);

export type PromptContract = z.infer<typeof PromptContractSchema>;
export type NextEdgeSpec = z.infer<typeof NextEdgeSpecSchema>;
export type NodeSpec = z.infer<typeof NodeSpecSchema>;
export type GraphSpec = z.infer<typeof GraphSpecSchema>;
export type ChildRunDescriptor = z.infer<typeof ChildRunDescriptorSchema>;

export const NodeStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "waiting",
  "blocked",
  "done",
  "failed",
  "skipped",
  "cancelled",
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const GraphStatusSchema = z.enum([
  "draft",
  "running",
  "pausing",
  "paused",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);
export type GraphStatus = z.infer<typeof GraphStatusSchema>;

export const RunPrioritySchema = z.enum(["low", "normal", "high"]);
export type RunPriority = z.infer<typeof RunPrioritySchema>;

export const EdgeStatusSchema = z.enum(["pending", "taken", "disabled"]);
export type EdgeStatus = z.infer<typeof EdgeStatusSchema>;

export const CompletionInputSchema = z
  .object({
    summary: z.string().trim().min(1).max(20_000),
    output: z.unknown().optional(),
    evidence: z.array(z.string().trim().min(1).max(2_000)).default([]),
    route: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = serializedBytes({
      summary: value.summary,
      evidence: value.evidence,
      route: value.route ?? null,
    });
    if (bytes > MAX_COMPLETION_CONTEXT_BYTES) {
      context.addIssue({
        code: "custom",
        message:
          `completion summary, evidence, and route exceed ${MAX_COMPLETION_CONTEXT_BYTES} UTF-8 bytes`,
      });
    }
  });
export type CompletionInput = z.infer<typeof CompletionInputSchema>;

export const DynamicSubgraphOutputSchema = z
  .object({
    children: z.array(ChildRunDescriptorSchema).min(1).max(256),
  })
  .strict();
export type DynamicSubgraphOutput = z.infer<
  typeof DynamicSubgraphOutputSchema
>;

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
  readonly maxHierarchyDepth: number;
  readonly maxUnfinishedDescendants: number;
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
  readonly waiting: number;
  readonly blocked: number;
  readonly done: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cancelled: number;
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
  readonly parentRunId: string | null;
  readonly parentNodeId: string | null;
  readonly rootRunId: string;
  readonly depth: number;
  readonly priority: RunPriority;
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

export interface RunTreeEntry {
  readonly summary: GraphSummary;
  readonly label: string | null;
  readonly relativeDepth: number;
  readonly folded: boolean;
  readonly directChildRuns: number;
  readonly descendantRuns: number;
  readonly topology: {
    readonly spec: GraphSpec;
    readonly nodes: readonly RuntimeNode[];
    readonly edges: readonly RuntimeEdge[];
  } | null;
}

export interface GraphTreeSnapshot {
  readonly schemaVersion: 1;
  readonly root: GraphSnapshot;
  readonly treeRootRunId: string;
  readonly runs: readonly RunTreeEntry[];
  readonly projection: {
    readonly depth: number;
    readonly maximumDepth: number;
    readonly limit: number;
    readonly totalRuns: number;
    readonly expandedRuns: number;
    readonly foldedRuns: number;
    readonly renderedNodes: number;
    readonly lastEventSequence: number;
    readonly capturedAt: string;
  };
  readonly mermaid: string;
}

export interface PortfolioRun {
  readonly summary: GraphSummary;
  readonly directChildRuns: number;
  readonly descendantRuns: number;
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
    readonly type: "task" | "decision" | "subgraph";
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

export interface GateExecutionClaim {
  readonly executionId: string;
  readonly runId: string;
  readonly rootRunId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly check: CheckSpec;
  readonly leaseExpiresAt: string;
}

export interface CheckExecutionSummary {
  readonly executionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly check: {
    readonly id: string;
    readonly revision: number;
  };
  readonly status:
    | "claimed"
    | "completed"
    | "blocked"
    | "stale"
    | "expired";
  readonly leaseExpiresAt: string;
  readonly classification: GateExecutionClassification | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly byteCount: number | null;
  readonly digest: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface CheckExecutionInspection extends CheckExecutionSummary {
  readonly output: {
    readonly stdout: string;
    readonly stderr: string;
    readonly retainedBytes: number;
    readonly truncated: boolean;
  };
}

export interface WaitSignalSummary {
  readonly signalId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly status: "waiting" | "resolved" | "timed_out" | "stale";
  readonly routes: readonly string[];
  readonly timeoutRoute: string | null;
  readonly deadlineAt: string | null;
  readonly overdue: boolean;
  readonly resolvedRoute: string | null;
  readonly summary: string | null;
  readonly evidence: readonly string[];
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface ResourceLockSummary {
  readonly resource: string;
  readonly ownerKind: "assignment" | "gate";
  readonly ownerId: string;
  readonly rootRunId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface TemplateInstantiationRequest {
  readonly template: {
    readonly id: string;
    readonly version: number;
  };
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly graphs: readonly GraphSpec[];
}

export interface TemplateGraphReceipt {
  readonly graphId: string;
  readonly revision: number;
  readonly path: string;
  readonly sha256: string;
}

export interface TemplateInstantiationReceipt {
  readonly schemaVersion: 1;
  readonly template: {
    readonly id: string;
    readonly version: number;
  };
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly graphs: readonly TemplateGraphReceipt[];
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface DurationMetrics {
  readonly count: number;
  readonly totalMs: number;
  readonly averageMs: number | null;
  readonly maximumMs: number | null;
}

export interface RuntimeMetrics {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly scope: {
    readonly runId: string | null;
    readonly runCount: number;
    readonly rootCount: number;
  };
  readonly totals: {
    readonly nodes: number;
    readonly attempts: number;
    readonly repairs: number;
    readonly leaseRecoveries: number;
  };
  readonly assignments: {
    readonly current: number;
    readonly maximumLive: number;
    readonly averageLive: number;
    readonly duration: DurationMetrics;
  };
  readonly gates: {
    readonly claimed: number;
    readonly success: number;
    readonly nonSuccess: number;
    readonly timeout: number;
    readonly outputLimit: number;
    readonly spawnError: number;
    readonly staleOrExpired: number;
    readonly duration: DurationMetrics;
  };
  readonly signals: {
    readonly waiting: number;
    readonly resolved: number;
    readonly timedOut: number;
    readonly stale: number;
    readonly latency: DurationMetrics;
  };
  readonly resources: {
    readonly activeLocks: number;
    readonly contendedReadyNodes: number;
    readonly contendedResources: number;
  };
  readonly excludedPrivateFields: readonly [
    "prompts",
    "results",
    "checkOutput",
    "environment",
  ];
  readonly unknownFields: readonly string[];
}

export interface PortfolioOverviewOptions {
  readonly run?: string;
  readonly root?: string;
  readonly runStatus?: GraphStatus;
  readonly nodeStatuses: readonly NodeStatus[];
  readonly actor?: string;
  readonly tag?: string;
  readonly resource?: string;
  readonly priority?: RunPriority;
  readonly depth?: number;
  readonly limit: number;
}

export interface PortfolioOverviewNode {
  readonly runId: string;
  readonly rootRunId: string;
  readonly graphId: string;
  readonly depth: number;
  readonly priority: RunPriority;
  readonly nodeId: string;
  readonly type: NodeType;
  readonly title: string;
  readonly status: NodeStatus;
  readonly attempt: number;
  readonly assignmentId: string | null;
  readonly actorId: string | null;
  readonly tags: readonly string[];
  readonly resources: readonly string[];
  readonly eligibility: ReadyWork["eligibility"] | null;
  readonly updatedAt: string;
}

export interface PortfolioOverview {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly capturedAt: string;
  readonly filters: {
    readonly run: string | null;
    readonly root: string | null;
    readonly runStatus: GraphStatus | null;
    readonly nodeStatuses: readonly NodeStatus[];
    readonly actor: string | null;
    readonly tag: string | null;
    readonly resource: string | null;
    readonly priority: RunPriority | null;
    readonly depth: number | null;
    readonly limit: number;
  };
  readonly totals: {
    readonly graphs: number;
    readonly matchingRuns: number;
    readonly listedRuns: number;
    readonly matchingNodes: number;
    readonly listedNodes: number;
  };
  readonly truncated: {
    readonly runs: boolean;
    readonly nodes: boolean;
  };
  readonly runs: readonly (GraphSummary & {
    readonly rootPriority: RunPriority;
  })[];
  readonly nodes: readonly PortfolioOverviewNode[];
  readonly metrics: RuntimeMetrics;
  readonly lastEventSequence: number;
}

export interface SystemNodeMutation<T> {
  readonly value: T;
  readonly changes: readonly RuntimeChange[];
}

export interface ReadyWork {
  readonly runId: string;
  readonly rootRunId: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly type: "task" | "decision" | "subgraph";
  readonly title: string;
  readonly actorHint: string | null;
  readonly attempt: number;
  readonly depth: number;
  readonly priority: RunPriority;
  readonly effectivePriority: RunPriority;
  readonly readySince: string;
  readonly resources: readonly string[];
  readonly eligibility: {
    readonly eligible: boolean;
    readonly reason: "RESOURCE_BUSY" | null;
    readonly blockedResources: readonly string[];
  };
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
  readonly assignmentOutput: {
    readonly maximumBytes: number;
    readonly usedBytes: number;
    readonly limited: boolean;
    readonly blockedCount: number;
    readonly blocked: readonly {
      readonly runId: string;
      readonly nodeId: string;
      readonly requestedBytes: number;
    }[];
  };
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
  readonly changes?: readonly RuntimeChange[];
}

export interface IdempotentMutationResult<T> extends MutationResult<T> {
  readonly replayed: boolean;
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
