import {
  BurnGraphError,
  GraphSpecSchema,
  MAX_ACTOR_ASSIGNMENT_BYTES,
  MAX_COMPLETION_CONTEXT_BYTES,
  MAX_PROMPT_CONTRACT_BYTES,
  validateGraphSpec,
  type GraphSpec,
  type PromptContract,
} from "@burn-graph/core";
import { z } from "zod";

export const GRAPH_EXAMPLE_KINDS = [
  "flat",
  "decision",
  "hierarchy",
  "gate",
  "wait",
] as const;

export type GraphExampleKind = (typeof GRAPH_EXAMPLE_KINDS)[number];

function prompt(objective = ""): PromptContract {
  return {
    objective,
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

function normalize(input: unknown): GraphSpec {
  return validateGraphSpec(input).spec;
}

const examples: Readonly<Record<GraphExampleKind, GraphSpec>> = {
  flat: normalize({
    schemaVersion: 1,
    id: "example-flat",
    title: "One bounded task",
    goal: "Complete one task and finish.",
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(),
        next: [{ to: "work" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "work",
        type: "task",
        title: "Complete the task",
        prompt: prompt("Produce the requested bounded result."),
        next: [{ to: "end" }],
        maxAttempts: 3,
        actorHint: null,
        tags: ["example"],
      },
      {
        id: "end",
        type: "end",
        title: "Complete",
        prompt: prompt(),
        next: [],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
    ],
  }),
  decision: normalize({
    schemaVersion: 1,
    id: "example-decision",
    title: "Review and optional repair",
    goal: "Accept verified work or repair it once.",
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(),
        next: [{ to: "review" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "review",
        type: "decision",
        title: "Review result",
        prompt: prompt("Choose pass when evidence is sufficient; otherwise repair."),
        next: [
          { to: "end", route: "pass", label: "evidence accepted" },
          { to: "repair", route: "repair", label: "repair required" },
        ],
        maxAttempts: 3,
        actorHint: null,
        tags: ["review"],
      },
      {
        id: "repair",
        type: "task",
        title: "Repair result",
        prompt: prompt("Repair the evidence-backed defect and return verification."),
        next: [{ to: "end" }],
        maxAttempts: 3,
        actorHint: null,
        tags: ["repair"],
      },
      {
        id: "end",
        type: "end",
        title: "Complete",
        prompt: prompt(),
        next: [],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
    ],
  }),
  hierarchy: normalize({
    schemaVersion: 2,
    id: "example-hierarchy",
    title: "Plan bounded child Runs",
    goal: "Create and settle a bounded immutable child Run set.",
    revision: 1,
    maxActive: 2,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(),
        next: [{ to: "children" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "children",
        type: "subgraph",
        title: "Plan child Runs",
        prompt: prompt(
          "Return one to four exact child Graph revisions as output.children.",
        ),
        next: [
          { to: "end", route: "success", label: "all children completed" },
          { to: "end", route: "failure", label: "a child failed" },
          { to: "end", route: "cancelled", label: "a child was cancelled" },
        ],
        maxAttempts: 3,
        actorHint: null,
        tags: ["hierarchy"],
        mode: "dynamic",
        minChildren: 1,
        maxChildren: 4,
        resources: [],
      },
      {
        id: "end",
        type: "end",
        title: "Complete",
        prompt: prompt(),
        next: [],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
    ],
  }),
  gate: normalize({
    schemaVersion: 2,
    id: "example-gate",
    title: "Run a registered verification",
    goal: "Route a bounded registered Check outcome.",
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(),
        next: [{ to: "verify" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "verify",
        type: "gate",
        title: "Run verification",
        prompt: prompt(),
        next: [
          { to: "end", route: "pass", label: "check passed" },
          { to: "end", route: "fail", label: "check did not pass" },
        ],
        maxAttempts: 2,
        actorHint: null,
        tags: ["gate"],
        check: { id: "example-check", revision: 1 },
        resources: [],
      },
      {
        id: "end",
        type: "end",
        title: "Complete",
        prompt: prompt(),
        next: [],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
    ],
  }),
  wait: normalize({
    schemaVersion: 2,
    id: "example-wait",
    title: "Wait for an external outcome",
    goal: "Resume through one declared external route or a bounded timeout.",
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(),
        next: [{ to: "approval" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "approval",
        type: "wait",
        title: "Wait for approval",
        prompt: prompt(),
        next: [
          { to: "end", route: "approved", label: "approved" },
          { to: "end", route: "rejected", label: "rejected" },
          { to: "end", route: "timeout", label: "deadline reached" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: ["wait"],
        signal: {
          routes: ["approved", "rejected"],
          timeout: { afterMs: 86_400_000, route: "timeout" },
        },
      },
      {
        id: "end",
        type: "end",
        title: "Complete",
        prompt: prompt(),
        next: [],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
    ],
  }),
};

export function graphSchemaDocument(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    document: "GraphSpec",
    acceptedGraphSpecVersions: [1, 2],
    jsonSchema: {
      ...z.toJSONSchema(GraphSpecSchema, {
        target: "draft-2020-12",
        unrepresentable: "any",
      }),
      $id: "burn-graph://schema/graph-spec",
      title: "burn-graph GraphSpec",
      description:
        "Complete structural schema; topology rules below are also enforced.",
    },
    fieldGuide: {
      graph: {
        schemaVersion: "1 for basic graphs; 2 for Subgraph, Gate, Wait, resources, or extended prompts.",
        id: "Stable identifier: 1-128 letters, numbers, dot, underscore, colon, or hyphen; starts with a letter.",
        title: "Human title, 1-180 characters.",
        goal: "Bounded outcome, 1-4000 characters.",
        revision: "Positive immutable authoring revision.",
        maxActive: "Positive concurrent Assignment limit, maximum 32; default 8.",
        nodes: "Two to 10,000 complete NodeSpec objects.",
      },
      node: {
        type: [
          "start",
          "task",
          "decision",
          "join",
          "subgraph",
          "gate",
          "wait",
          "end",
        ],
        next: "Edges use {to}; routed nodes also require a unique route on every edge.",
        maxAttempts: "Positive Assignment-attempt limit, maximum 20; default 3.",
        actorHint: "Optional scheduling hint only; null by default.",
        tags: "Stable identifier array.",
        resources: "At most 32 unique exclusive resources on Task, Subgraph, or Gate.",
      },
      prompt: {
        maximumBytes: `The complete normalized prompt contract is at most ${MAX_PROMPT_CONTRACT_BYTES} UTF-8 bytes.`,
        objective: "Required and non-empty for Task, Decision, and dynamic Subgraph.",
        instructions: "Ordered non-empty instruction strings.",
        mustRead: "Ordered project or permitted read-only sibling references.",
        doneWhen: "Observable completion conditions.",
        outputSchema: "Optional JSON Schema object for Assignment output.",
        role: "Optional bounded role text; GraphSpec v2 only when non-empty.",
        lockedContracts: "Read-only contract references; GraphSpec v2 only when non-empty.",
        writablePaths: "Project-confined writable references; GraphSpec v2 only when non-empty.",
        forbidden: "Explicit bounded prohibitions; GraphSpec v2 only when non-empty.",
        runtime: "Registered startup, status, log, metric, or verification commands; GraphSpec v2 only when non-empty.",
      },
      systemNodes: {
        subgraph: "v2; static children or dynamic minChildren/maxChildren (package maximum 32), with success/failure/cancelled routes.",
        gate: "v2; exact {id, revision} Check reference with pass and fail routes.",
        wait: "v2; 1-32 unique Signal routes and optional distinct timeout route.",
      },
      completion: {
        contextMaximumBytes:
          `summary, evidence, and route together are at most ${MAX_COMPLETION_CONTEXT_BYTES} UTF-8 bytes; node-specific output is not repeated into successor context.`,
      },
      scheduling: {
        actorAssignmentMaximumBytes:
          `One Actor owns at most ${MAX_ACTOR_ASSIGNMENT_BYTES} serialized bytes of complete Assignment packets; scheduling stops before the next claim would exceed it.`,
      },
    },
    topologyRules: [
      "Exactly one Start and one End.",
      "Every node is reachable from Start and can reach End.",
      "Only Decision may declare a back-edge; it targets an ancestor Task and has maxTraversals 1-100.",
      "Join has at least two incoming edges.",
      "Decision has at least two unique routes.",
      "GraphSpec v1 cannot use System Nodes, resources, or non-empty extended prompt fields.",
    ],
    input: {
      file: "Use a project-relative existing JSON file that remains inside the project after realpath and symlink resolution.",
      stdin: "Use --input - and send exactly one JSON document.",
      maximumBytes: 2_097_152,
    },
    recovery: [
      {
        error: "INVALID_JSON",
        action: "Correct the JSON syntax or retry with --input -.",
      },
      {
        error: "INVALID_GRAPH",
        action: "Compare error.details.issues with this schema and one complete graph example.",
      },
      {
        error: "INVALID_INPUT_PATH",
        action: "Move the input under the project and use its project-relative path, or use stdin.",
      },
    ],
  };
}

export function graphExample(kindInput: string): {
  readonly kind: GraphExampleKind;
  readonly graph: GraphSpec;
  readonly application: Readonly<Record<string, unknown>>;
} {
  if (!GRAPH_EXAMPLE_KINDS.includes(kindInput as GraphExampleKind)) {
    throw new BurnGraphError(
      "GRAPH_EXAMPLE_NOT_FOUND",
      `Unknown Graph example ${kindInput}`,
      false,
      { available: GRAPH_EXAMPLE_KINDS },
    );
  }
  const kind = kindInput as GraphExampleKind;
  return {
    kind,
    graph: examples[kind],
    application: {
      file: {
        save: "Save data.graph as graph.json inside the initialized project.",
        validate: "burn-graph graph validate --input graph.json",
        apply: "burn-graph graph apply --input graph.json",
      },
      stdin: {
        validate: "burn-graph graph validate --input -",
        apply: "burn-graph graph apply --input -",
        note: "Send data.graph only, not the surrounding CLI envelope.",
      },
      prerequisites:
        kind === "gate"
          ? [
              "Register the exact CheckSpec {id:\"example-check\",revision:1} before graph apply or run start.",
            ]
          : [],
    },
  };
}
