import { describe, expect, test } from "bun:test";

import { BurnGraphError, validateGraphSpec } from "@burn-graph/core";

import { parallelGraph, prompt } from "../helpers/fixtures.ts";

function expectGraphError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe(code);
  }
}

function staticParentGraph() {
  return {
    schemaVersion: 2,
    id: "hierarchy-parent",
    title: "Hierarchy parent",
    goal: "Run two exact child revisions and converge.",
    revision: 1,
    maxActive: 2,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "children" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "children",
        type: "subgraph",
        title: "Pinned children",
        mode: "static",
        children: [
          { graphId: "child", revision: 1, label: "left" },
          {
            graphId: "child",
            revision: 1,
            runId: "stable-child-right",
            label: "right",
          },
        ],
        resources: [],
        prompt: prompt(""),
        next: [
          { to: "end", route: "success" },
          { to: "end", route: "failure" },
          { to: "end", route: "cancelled" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: ["hierarchy"],
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

function mutableStaticParent(): Record<string, unknown> & {
  nodes: Array<Record<string, unknown>>;
} {
  return structuredClone(staticParentGraph()) as unknown as Record<
    string,
    unknown
  > & {
    nodes: Array<Record<string, unknown>>;
  };
}

describe("GraphSpec v2 validation", () => {
  test("normalizes v1 prompts without rewriting the v1 version", () => {
    const graph = validateGraphSpec(parallelGraph("legacy-v1")).spec;
    expect(graph.schemaVersion).toBe(1);
    expect(graph.nodes[1]?.prompt).toMatchObject({
      role: "",
      lockedContracts: [],
      writablePaths: [],
      forbidden: [],
      runtime: [],
    });
  });

  test("accepts static and dynamic Subgraph contracts", () => {
    const staticGraph = validateGraphSpec(staticParentGraph()).spec;
    expect(staticGraph.schemaVersion).toBe(2);
    expect(staticGraph.nodes[1]).toMatchObject({
      type: "subgraph",
      mode: "static",
      children: [
        { graphId: "child", revision: 1, label: "left" },
        {
          graphId: "child",
          revision: 1,
          runId: "stable-child-right",
          label: "right",
        },
      ],
    });

    const dynamic = mutableStaticParent();
    const node = dynamic.nodes[1]!;
    node.mode = "dynamic";
    delete node.children;
    node.minChildren = 1;
    node.maxChildren = 8;
    node.resources = ["rust-build"];
    node.prompt = {
      ...prompt("Return the immutable child set."),
      role: "Planner",
      lockedContracts: ["../privacy/architecture.md"],
      writablePaths: [".burn-graph/graphs"],
      forbidden: ["Do not launch an AI process."],
      runtime: ["burn-graph graph validate --input <file>"],
    };

    expect(validateGraphSpec(dynamic).spec.nodes[1]).toMatchObject({
      type: "subgraph",
      mode: "dynamic",
      minChildren: 1,
      maxChildren: 8,
      resources: ["rust-build"],
    });
  });

  test("rejects v2 nodes in v1 and malformed Subgraph modes", () => {
    const v1WithSubgraph = {
      ...staticParentGraph(),
      schemaVersion: 1,
    };
    expectGraphError(
      () => validateGraphSpec(v1WithSubgraph),
      "INVALID_GRAPH",
    );

    const malformed = mutableStaticParent();
    malformed.nodes[1]!.mode = "dynamic";
    expectGraphError(() => validateGraphSpec(malformed), "INVALID_GRAPH");
  });

  test("keeps non-empty v2 prompt and resource fields out of v1", () => {
    const promptExtension = structuredClone(parallelGraph("legacy-prompt"));
    promptExtension.nodes[1]!.prompt.role = "Planner";
    expectGraphError(
      () => validateGraphSpec(promptExtension),
      "INVALID_GRAPH",
    );

    const resourceExtension = structuredClone(
      parallelGraph("legacy-resource"),
    );
    resourceExtension.nodes[1]!.resources = [];
    expectGraphError(
      () => validateGraphSpec(resourceExtension),
      "INVALID_GRAPH",
    );
  });

  test("uses stable hierarchy errors for width, self ancestry, and routes", () => {
    const tooWide = mutableStaticParent();
    tooWide.nodes[1]!.children = Array.from({ length: 33 }, (_, index) => ({
      graphId: "child",
      revision: 1,
      label: `child-${index}`,
    }));
    expectGraphError(() => validateGraphSpec(tooWide), "HIERARCHY_LIMIT");

    const recursive = mutableStaticParent();
    recursive.nodes[1]!.children = [
      { graphId: "hierarchy-parent", revision: 1 },
    ];
    expectGraphError(() => validateGraphSpec(recursive), "HIERARCHY_CYCLE");

    const invalidRoute = mutableStaticParent();
    invalidRoute.nodes[1]!.next = [{ to: "end", route: "pass" }];
    expectGraphError(() => validateGraphSpec(invalidRoute), "INVALID_ROUTE");
  });
});
