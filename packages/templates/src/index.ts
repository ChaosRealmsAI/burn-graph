import { createHash } from "node:crypto";

import {
  BurnGraphError,
  CheckReferenceSchema,
  IdentifierSchema,
  IdempotencyKeySchema,
  ProjectRelativePathSchema,
  validateGraphSpec,
  type GraphSpec,
  type NodeSpec,
  type PromptContract,
} from "@burn-graph/core";
import { z } from "zod";

import catalogAsset from "../assets/catalog.json";

const TemplateIdSchema = z.enum([
  "delivery",
  "vertical-slice",
  "poc",
  "bugfix",
  "review-repair",
  "release",
]);

export type TemplateId = z.infer<typeof TemplateIdSchema>;

const TemplateStageSchema = z.enum([
  "poc",
  "security",
  "performance",
  "release",
]);

const StringListSchema = z.array(z.string().trim().min(1).max(2_000)).max(64);
const PathListSchema = z.array(ProjectRelativePathSchema).max(64);

const TemplateContextSchema = z
  .object({
    mustRead: PathListSchema.default([]),
    lockedContracts: PathListSchema.default([]),
    writablePaths: PathListSchema.default([]),
    forbidden: StringListSchema.default([]),
    runtime: StringListSchema.default([]),
  })
  .strict()
  .default({
    mustRead: [],
    lockedContracts: [],
    writablePaths: [],
    forbidden: [],
    runtime: [],
  });

const PromptOverrideSchema = z
  .object({
    nodeId: IdentifierSchema,
    objective: z.string().trim().min(1).max(4_000).optional(),
    instructions: StringListSchema.optional(),
    doneWhen: StringListSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.objective !== undefined ||
      value.instructions !== undefined ||
      value.doneWhen !== undefined,
    "Prompt override must change at least one declared prompt field",
  );

export const TemplateInstantiationInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: IdempotencyKeySchema.optional(),
    graphId: IdentifierSchema,
    revision: z.number().int().positive().max(2_147_483_647).default(1),
    title: z.string().trim().min(1).max(180).optional(),
    goal: z.string().trim().min(1).max(4_000),
    check: CheckReferenceSchema.optional(),
    include: z.array(TemplateStageSchema).max(4).default([]),
    context: TemplateContextSchema,
    promptOverrides: z.array(PromptOverrideSchema).max(32).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.include).size !== value.include.length) {
      context.addIssue({
        code: "custom",
        path: ["include"],
        message: "Included stages must be unique",
      });
    }
    const overrideIds = value.promptOverrides.map((override) => override.nodeId);
    if (new Set(overrideIds).size !== overrideIds.length) {
      context.addIssue({
        code: "custom",
        path: ["promptOverrides"],
        message: "Each node may be overridden once",
      });
    }
  });

export type TemplateInstantiationInput = z.infer<
  typeof TemplateInstantiationInputSchema
>;

const CatalogEntrySchema = z
  .object({
    id: TemplateIdSchema,
    title: z.string(),
    summary: z.string(),
    stages: z.array(z.string()),
    supports: z.array(TemplateStageSchema),
  })
  .strict();

const CatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    templates: z.array(CatalogEntrySchema).length(6),
  })
  .strict();

const catalog = CatalogSchema.parse(catalogAsset);

export interface TemplateGeneration {
  readonly template: {
    readonly id: TemplateId;
    readonly version: 1;
  };
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly graphs: readonly GraphSpec[];
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stable(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function emptyPrompt(): PromptContract {
  return {
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
  };
}

function prompt(
  input: TemplateInstantiationInput,
  role: string,
  objective: string,
  instructions: readonly string[],
  doneWhen: readonly string[],
): PromptContract {
  return {
    objective,
    instructions: [...instructions],
    mustRead: [...input.context.mustRead],
    doneWhen: [...doneWhen],
    outputSchema: null,
    role,
    lockedContracts: [...input.context.lockedContracts],
    writablePaths: [...input.context.writablePaths],
    forbidden: [...input.context.forbidden],
    runtime: [...input.context.runtime],
  };
}

function structural(
  id: string,
  type: "start" | "join" | "end",
  title: string,
  next: NodeSpec["next"],
): NodeSpec {
  return {
    id,
    type,
    title,
    prompt: emptyPrompt(),
    next,
    maxAttempts: 1,
    actorHint: null,
    tags: [],
  };
}

function task(
  input: TemplateInstantiationInput,
  id: string,
  title: string,
  objective: string,
  next: NodeSpec["next"],
  tags: readonly string[] = [],
): NodeSpec {
  return {
    id,
    type: "task",
    title,
    prompt: prompt(
      input,
      `${title} owner`,
      objective,
      [
        "Read every declared context path before acting.",
        "Return bounded evidence from the public product boundary.",
      ],
      [
        "The stated outcome is observable.",
        "Applicable declared runtime checks pass.",
      ],
    ),
    next,
    maxAttempts: 3,
    actorHint: null,
    tags: [...tags],
    resources: [],
  };
}

function review(
  input: TemplateInstantiationInput,
  repairTarget: string,
): NodeSpec {
  return {
    id: "review",
    type: "decision",
    title: "Accept or repair",
    prompt: prompt(
      input,
      "independent quality decision",
      "Choose pass only from external evidence; otherwise route the smallest repair.",
      [
        "Check product behavior, contracts, architecture, tests, recovery, privacy, and performance.",
        "Cite the exact verification result behind the route.",
      ],
      [
        "Pass has an oracle outside the implementation result.",
        "No unresolved blocker or unaccepted debt remains.",
      ],
    ),
    next: [
      { to: "end", route: "pass", label: "evidence accepted" },
      {
        to: repairTarget,
        route: "repair",
        label: "repair required",
        maxTraversals: 2,
      },
    ],
    maxAttempts: 3,
    actorHint: null,
    tags: ["review"],
  };
}

function gate(
  input: TemplateInstantiationInput,
  next = "review",
): NodeSpec | null {
  if (!input.check) return null;
  return {
    id: "machine-gate",
    type: "gate",
    title: "Run registered verification",
    prompt: emptyPrompt(),
    next: [
      { to: next, route: "pass", label: "check passed" },
      { to: next, route: "fail", label: "check failed" },
    ],
    maxAttempts: 2,
    actorHint: null,
    tags: ["gate"],
    check: input.check,
    resources: [],
  };
}

function finish(
  input: TemplateInstantiationInput,
  nodes: readonly NodeSpec[],
): GraphSpec {
  const known = new Set(nodes.map((node) => node.id));
  const overrides = new Map(
    input.promptOverrides.map((override) => [override.nodeId, override]),
  );
  for (const nodeId of overrides.keys()) {
    if (!known.has(nodeId)) {
      throw new BurnGraphError(
        "TEMPLATE_OVERRIDE_NODE_NOT_FOUND",
        `Template output has no node ${nodeId}`,
        false,
        { nodeId, available: [...known].slice(0, 32) },
      );
    }
  }
  const overridden = nodes.map((node): NodeSpec => {
    const override = overrides.get(node.id);
    if (!override) return node;
    if (!["task", "decision", "subgraph"].includes(node.type)) {
      throw new BurnGraphError(
        "TEMPLATE_OVERRIDE_NOT_ALLOWED",
        `Node ${node.id} has no injectable AI prompt`,
      );
    }
    return {
      ...node,
      prompt: {
        ...node.prompt,
        ...(override.objective === undefined
          ? {}
          : { objective: override.objective }),
        ...(override.instructions === undefined
          ? {}
          : { instructions: override.instructions }),
        ...(override.doneWhen === undefined
          ? {}
          : { doneWhen: override.doneWhen }),
      },
    };
  });
  return validateGraphSpec({
    schemaVersion: 2,
    id: input.graphId,
    title: input.title ?? `${input.graphId} workflow`,
    goal: input.goal,
    revision: input.revision,
    maxActive: 4,
    nodes: overridden,
  }).spec;
}

function chainTemplate(
  input: TemplateInstantiationInput,
  stages: readonly {
    readonly id: string;
    readonly title: string;
    readonly objective: string;
  }[],
  repairTarget: string,
): GraphSpec {
  const machineGate = gate(input);
  const orderedStages = [
    ...stages.map((stage) => ({
      ...stage,
      tags: [stage.id],
    })),
    ...input.include.map((stage) => ({
      id: `risk-${stage}`,
      title: `${stage} evidence`,
      objective:
        `Resolve the declared ${stage} risk with a bounded independent result.`,
      tags: ["risk", stage],
    })),
  ];
  const stageNodes = orderedStages.map((stage, index) =>
    task(
      input,
      stage.id,
      stage.title,
      stage.objective,
      [{
        to:
          index === orderedStages.length - 1
            ? machineGate?.id ?? "review"
            : orderedStages[index + 1]!.id,
      }],
      stage.tags,
    ),
  );
  return finish(input, [
    structural("start", "start", "Start workflow", [
      { to: orderedStages[0]!.id },
    ]),
    ...stageNodes,
    ...(machineGate ? [machineGate] : []),
    review(input, repairTarget),
    structural("end", "end", "Workflow complete", []),
  ]);
}

function delivery(input: TemplateInstantiationInput): GraphSpec {
  const optional = input.include.map((stage) =>
    task(
      input,
      `risk-${stage}`,
      `${stage} evidence`,
      `Resolve the declared ${stage} risk with a bounded independent result.`,
      [{ to: "converge" }],
      ["risk", stage],
    ),
  );
  const sliceNode: NodeSpec = {
    id: "vertical-slices",
    type: "subgraph",
    title: "Create vertical-slice Runs",
    prompt: prompt(
      input,
      "delivery slicer",
      "Return one immutable child Graph revision per independently verifiable user result.",
      [
        "Prefer existing vertical-slice template instances.",
        "Keep child count and hierarchy depth within the declared bounds.",
      ],
      [
        "Every child has one complete user-visible outcome.",
        "The complete child set validates before any Run starts.",
      ],
    ),
    next: [
      { to: "converge", route: "success" },
      { to: "converge", route: "failure" },
      { to: "converge", route: "cancelled" },
    ],
    maxAttempts: 3,
    actorHint: null,
    tags: ["delivery", "hierarchy"],
    mode: "dynamic",
    minChildren: 1,
    maxChildren: 32,
    resources: [],
  };
  const machineGate = gate(input);
  return finish(input, [
    structural("start", "start", "Start delivery", [{ to: "plan" }]),
    task(
      input,
      "plan",
      "Lock delivery plan",
      "Lock the smallest milestone, user results, dependencies, and acceptance oracles.",
      [
        { to: "vertical-slices" },
        ...optional.map((node) => ({ to: node.id })),
      ],
      ["delivery", "plan"],
    ),
    sliceNode,
    ...optional,
    structural("converge", "join", "Converge delivery work", [
      { to: "integrate" },
    ]),
    task(
      input,
      "integrate",
      "Verify integrated delivery",
      "Integrate child outcomes and replay every affected public user path.",
      [{ to: machineGate?.id ?? "review" }],
      ["delivery", "integration"],
    ),
    ...(machineGate ? [machineGate] : []),
    review(input, "integrate"),
    structural("end", "end", "Delivery complete", []),
  ]);
}

function generate(
  templateId: TemplateId,
  input: TemplateInstantiationInput,
): GraphSpec {
  switch (templateId) {
    case "delivery":
      return delivery(input);
    case "vertical-slice":
      return chainTemplate(
        input,
        [
          {
            id: "contract",
            title: "Lock slice contract",
            objective: "Lock one user-visible result, boundaries, and external oracle.",
          },
          {
            id: "implement",
            title: "Implement vertical result",
            objective: "Implement the smallest end-to-end result through the real entry.",
          },
          {
            id: "self-verify",
            title: "Self-verify runtime",
            objective: "Start and operate the result with bounded runtime evidence.",
          },
          {
            id: "blackbox",
            title: "Replay blackbox path",
            objective: "Replay the complete user path without private implementation shortcuts.",
          },
        ],
        "implement",
      );
    case "poc":
      return chainTemplate(
        input,
        [
          {
            id: "frame",
            title: "Frame unknown",
            objective: "State one unknown that can overturn the proposed architecture.",
          },
          {
            id: "experiment",
            title: "Run minimal experiment",
            objective: "Run the smallest controlled experiment that answers the unknown.",
          },
          {
            id: "verify",
            title: "Verify PoC oracle",
            objective: "Compare the measured result with the explicit decision threshold.",
          },
        ],
        "experiment",
      );
    case "bugfix":
      return chainTemplate(
        input,
        [
          {
            id: "reproduce",
            title: "Reproduce defect",
            objective: "Create a deterministic public-path reproduction that fails for the known defect.",
          },
          {
            id: "repair",
            title: "Repair defect",
            objective: "Repair the smallest owning boundary without unrelated refactoring.",
          },
          {
            id: "regression",
            title: "Run regression",
            objective: "Prove the known defect is gone and affected paths still pass.",
          },
        ],
        "repair",
      );
    case "review-repair":
      return chainTemplate(
        input,
        [
          {
            id: "inspect",
            title: "Inspect findings",
            objective: "Reproduce and classify every evidence-backed review finding.",
          },
          {
            id: "repair",
            title: "Repair accepted findings",
            objective: "Repair all confirmed blockers in their owning modules.",
          },
          {
            id: "verify",
            title: "Verify repairs",
            objective: "Run independent controls proving each accepted finding no longer exists.",
          },
        ],
        "repair",
      );
    case "release":
      return chainTemplate(
        input,
        [
          {
            id: "scope",
            title: "Freeze release scope",
            objective: "Freeze version, artifact, contracts, environments, migration, and rollback.",
          },
          {
            id: "regression",
            title: "Run release regression",
            objective: "Replay every release user path and required safety and performance gate.",
          },
          {
            id: "package",
            title: "Build immutable artifact",
            objective: "Build one immutable artifact and record its hash and package audit.",
          },
        ],
        "regression",
      );
  }
}

export function listTemplates(): readonly (typeof catalog.templates)[number][] {
  return catalog.templates;
}

export function showTemplate(templateId: string): {
  readonly template: (typeof catalog.templates)[number];
  readonly input: Readonly<Record<string, unknown>>;
} {
  const id = TemplateIdSchema.safeParse(templateId);
  if (!id.success) {
    throw new BurnGraphError(
      "TEMPLATE_NOT_FOUND",
      `Unknown package template ${templateId}`,
      false,
      { available: catalog.templates.map((entry) => entry.id) },
    );
  }
  const template = catalog.templates.find((entry) => entry.id === id.data)!;
  return {
    template,
    input: {
      schemaVersion: 1,
      required: ["schemaVersion", "graphId", "goal"],
      idempotency:
        "Provide input.idempotencyKey or --idempotency-key; equivalent replay is inert.",
      graphId: "new project-local Graph ID",
      revision: "positive integer, default 1",
      goal: "bounded workflow outcome",
      check: "optional exact registered Check { id, revision }",
      include: template.supports,
      context: [
        "mustRead",
        "lockedContracts",
        "writablePaths",
        "forbidden",
        "runtime",
      ],
      promptOverrides:
        "bounded nodeId plus objective/instructions/doneWhen only",
    },
  };
}

export function generateTemplate(
  templateId: string,
  rawInput: unknown,
  idempotencyOverride?: string,
): TemplateGeneration {
  const shown = showTemplate(templateId);
  const id = shown.template.id;
  const parsed = TemplateInstantiationInputSchema.parse(rawInput);
  const unsupportedStages = parsed.include.filter(
    (stage) => !shown.template.supports.includes(stage),
  );
  if (unsupportedStages.length > 0) {
    throw new BurnGraphError(
      "TEMPLATE_STAGE_NOT_SUPPORTED",
      `Template ${id} does not support: ${unsupportedStages.join(", ")}`,
      false,
      {
        templateId: id,
        unsupported: unsupportedStages,
        supported: shown.template.supports,
      },
    );
  }
  if (
    idempotencyOverride !== undefined &&
    parsed.idempotencyKey !== undefined &&
    parsed.idempotencyKey !== idempotencyOverride
  ) {
    throw new BurnGraphError(
      "IDEMPOTENCY_KEY_CONFLICT",
      "CLI and input idempotency keys differ",
    );
  }
  const idempotencyKey = IdempotencyKeySchema.parse(
    idempotencyOverride ?? parsed.idempotencyKey,
  );
  const normalized = {
    ...parsed,
    idempotencyKey,
  };
  return {
    template: { id, version: 1 },
    idempotencyKey,
    inputDigest: digest({ templateId: id, input: normalized }),
    graphs: [generate(id, normalized)],
  };
}
