import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  initializeProject,
  type GraphSpec,
  type NodeSpec,
} from "@burn-graph/core";

const TEMP_PREFIX = path.join(tmpdir(), "burn-graph-test-");

export function createTestDirectory(): string {
  return mkdtempSync(TEMP_PREFIX);
}

export function createTestProject(): string {
  const root = createTestDirectory();
  initializeProject(root, "2026-01-01T00:00:00.000Z");
  return root;
}

export function removeTestProject(root: string): void {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(TEMP_PREFIX)) {
    throw new Error(`Refusing to remove non-test path: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

export function prompt(objective: string): NodeSpec["prompt"] {
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

export function parallelGraph(id = "parallel"): GraphSpec {
  return {
    schemaVersion: 1,
    id,
    title: "Parallel convergence",
    goal: "Run two tasks concurrently and converge exactly once.",
    revision: 1,
    maxActive: 2,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "left" }, { to: "right" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "left",
        type: "task",
        title: "Left task",
        prompt: prompt("Complete the left branch."),
        next: [{ to: "join" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "right",
        type: "task",
        title: "Right task",
        prompt: prompt("Complete the right branch."),
        next: [{ to: "join" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "join",
        type: "join",
        title: "Join",
        prompt: prompt(""),
        next: [{ to: "end" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "end",
        type: "end",
        title: "End",
        prompt: prompt(""),
        next: [],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
    ],
  };
}

export function goalGraph(id = "goal-work"): GraphSpec {
  return {
    schemaVersion: 3,
    id,
    title: "Evidence-reviewed Goal",
    goal: {
      objective: "Produce one result and prove it independently.",
      boundaries: ["Keep the execution path generic."],
      successEvidence: [
        {
          id: "E1",
          description: "The requested result exists.",
          acceptance: ["An external artifact demonstrates the result."],
          oracle: "A different Actor inspects the artifact.",
        },
      ],
      review: {
        required: true,
        independentActor: true,
        criteria: ["Judge every effective evidence requirement."],
      },
    },
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "work" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "work",
        type: "task",
        title: "Produce result",
        prompt: prompt("Produce and record a result."),
        work: { kind: "execute", evidence: ["E1"], reviewOf: [] },
        next: [{ to: "review" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "review",
        type: "decision",
        title: "Review evidence",
        prompt: prompt("Independently judge the current evidence."),
        work: { kind: "review", evidence: ["E1"], reviewOf: ["work"] },
        next: [
          { to: "end", route: "pass" },
          { to: "work", route: "revise", maxTraversals: 2 },
        ],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "end",
        type: "end",
        title: "End",
        prompt: prompt(""),
        next: [],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
    ],
  };
}

export function wideGraph(id = "wide", taskCount = 50): GraphSpec {
  const tasks: NodeSpec[] = Array.from({ length: taskCount }, (_, index) => ({
    id: `task-${index}`,
    type: "task",
    title: `Task ${index}`,
    prompt: prompt(`Complete task ${index}.`),
    next: [{ to: "join" }],
    maxAttempts: 3,
    actorHint: null,
    tags: [],
  }));
  return {
    schemaVersion: 1,
    id,
    title: "Wide parallel convergence",
    goal: "Schedule many parallel tasks within bounded runtime limits.",
    revision: 1,
    maxActive: 32,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: tasks.map((task) => ({ to: task.id })),
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      ...tasks,
      {
        id: "join",
        type: "join",
        title: "Join",
        prompt: prompt(""),
        next: [{ to: "end" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "end",
        type: "end",
        title: "End",
        prompt: prompt(""),
        next: [],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
    ],
  };
}

export function loopGraph(id = "repair-loop"): GraphSpec {
  return {
    schemaVersion: 1,
    id,
    title: "Bounded repair",
    goal: "Repair once and then pass.",
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "work" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "work",
        type: "task",
        title: "Do work",
        prompt: prompt("Produce a verified result."),
        next: [{ to: "decide" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "decide",
        type: "decision",
        title: "Accept result",
        prompt: prompt("Choose pass or repair from evidence."),
        next: [
          { to: "end", route: "pass", label: "accepted" },
          {
            to: "work",
            route: "repair",
            label: "repair required",
            maxTraversals: 2,
          },
        ],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "end",
        type: "end",
        title: "End",
        prompt: prompt(""),
        next: [],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
    ],
  };
}

export function schemaGraph(id = "schema-output"): GraphSpec {
  const graph = loopGraph(id);
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === "work"
        ? {
            ...node,
            prompt: {
              ...node.prompt,
              outputSchema: {
                type: "object",
                required: ["checks"],
                properties: {
                  checks: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                additionalProperties: false,
              },
            },
          }
        : node,
    ),
  };
}

export function convergenceGraph(id = "delivery"): GraphSpec {
  const requiredOutput = {
    type: "object",
    required: ["checks"],
    properties: {
      checks: {
        type: "array",
        items: { type: "string" },
      },
    },
    additionalProperties: false,
  };
  return {
    schemaVersion: 1,
    id,
    title: "CLI delivery convergence",
    goal: "Run parallel work, repair one bounded region, and converge.",
    revision: 1,
    maxActive: 2,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start delivery",
        prompt: prompt(""),
        next: [{ to: "left" }, { to: "right" }, { to: "third" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "left",
        type: "task",
        title: "Implement core",
        prompt: {
          ...prompt(""),
          objective: "Implement the smallest verified core result.",
          instructions: [
            "Read the declared context before changing code.",
            "Report only externally verifiable evidence.",
          ],
          mustRead: ["README.md", "docs/graph-spec.md"],
          doneWhen: ["Typecheck passes.", "The public CLI path passes."],
          outputSchema: requiredOutput,
        },
        next: [{ to: "join" }],
        maxAttempts: 3,
        actorHint: "implementation",
        tags: ["core"],
      },
      {
        id: "right",
        type: "task",
        title: "Verify behavior",
        prompt: prompt("Verify behavior from the public entry."),
        next: [{ to: "join" }],
        maxAttempts: 3,
        actorHint: "verification",
        tags: ["test"],
      },
      {
        id: "third",
        type: "task",
        title: "Review boundary",
        prompt: prompt("Review privacy and provider-neutral boundaries."),
        next: [{ to: "join" }],
        maxAttempts: 3,
        actorHint: "review",
        tags: ["review"],
      },
      {
        id: "join",
        type: "join",
        title: "Converge branches",
        prompt: prompt(""),
        next: [{ to: "decision" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
      {
        id: "decision",
        type: "decision",
        title: "Accept delivery",
        prompt: prompt("Choose pass or repair from concrete evidence."),
        next: [
          { to: "end", route: "pass", label: "all checks pass" },
          {
            to: "left",
            route: "repair",
            label: "repair core",
            maxTraversals: 2,
          },
        ],
        maxAttempts: 3,
        actorHint: "quality",
        tags: ["decision"],
      },
      {
        id: "end",
        type: "end",
        title: "Delivery complete",
        prompt: prompt(""),
        next: [],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
      },
    ],
  };
}
