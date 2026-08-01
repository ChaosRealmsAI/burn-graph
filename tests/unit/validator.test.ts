import { describe, expect, test } from "bun:test";

import {
  BurnGraphError,
  validateGraphSpec,
  type GraphSpec,
} from "@burn-graph/core";

import { loopGraph, parallelGraph } from "../helpers/fixtures.ts";

function expectGraphError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe(code);
  }
}

describe("GraphSpec validation", () => {
  test("accepts convergent parallel and bounded-loop graphs", () => {
    expect(validateGraphSpec(parallelGraph()).spec.nodes).toHaveLength(5);
    const loop = validateGraphSpec(loopGraph());
    expect(loop.loopEdges).toHaveLength(1);
    expect(loop.loopEdges[0]?.maxTraversals).toBe(2);
  });

  test("rejects unknown targets", () => {
    const graph = parallelGraph();
    const invalid: GraphSpec = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "left" ? { ...node, next: [{ to: "missing" }] } : node,
      ),
    };
    expectGraphError(() => validateGraphSpec(invalid), "UNKNOWN_NEXT");
  });

  test("rejects every unbounded cycle", () => {
    const graph = loopGraph();
    const invalid: GraphSpec = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "decide"
          ? {
              ...node,
              next: node.next.map((edge) =>
                edge.route === "repair"
                  ? { to: edge.to, route: edge.route, label: edge.label }
                  : edge,
              ),
            }
          : node,
      ),
    };
    expectGraphError(() => validateGraphSpec(invalid), "UNBOUNDED_CYCLE");
  });

  test("rejects a bounded edge that is not Decision to ancestor Task", () => {
    const graph = parallelGraph();
    const invalid: GraphSpec = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "left"
          ? { ...node, next: [{ to: "join", maxTraversals: 2 }] }
          : node,
      ),
    };
    expectGraphError(() => validateGraphSpec(invalid), "INVALID_LOOP");
  });

  test("rejects a repair loop whose target cannot open before its Decision", () => {
    const graph = loopGraph();
    const work = graph.nodes.find((node) => node.id === "work")!;
    const decision = graph.nodes.find((node) => node.id === "decide")!;
    const invalid: GraphSpec = {
      ...graph,
      nodes: graph.nodes
        .filter((node) => node.id !== "work")
        .map((node) => {
          if (node.id === "start") return { ...node, next: [{ to: "decide" }] };
          if (node.id === "decide") {
            return {
              ...decision,
              next: decision.next.map((edge) =>
                edge.route === "repair"
                  ? { ...edge, to: "dormant-repair" }
                  : edge,
              ),
            };
          }
          return node;
        })
        .concat({
          ...work,
          id: "dormant-repair",
          title: "Dormant repair",
          next: [{ to: "decide" }],
        }),
    };
    expectGraphError(() => validateGraphSpec(invalid), "INVALID_LOOP");
  });

  test("rejects joins with fewer than two inputs", () => {
    const graph = parallelGraph();
    const invalid: GraphSpec = {
      ...graph,
      nodes: graph.nodes
        .filter((node) => node.id !== "right")
        .map((node) =>
          node.id === "start" ? { ...node, next: [{ to: "left" }] } : node,
        ),
    };
    expectGraphError(() => validateGraphSpec(invalid), "INVALID_JOIN");
  });

  test("rejects nodes unreachable from Start", () => {
    const graph = loopGraph();
    const detachedTask = {
      ...graph.nodes.find((node) => node.id === "work")!,
      id: "detached",
      title: "Detached",
      next: [{ to: "end" }],
    };
    expectGraphError(
      () =>
        validateGraphSpec({
          ...graph,
          nodes: [...graph.nodes, detachedTask],
        }),
      "UNREACHABLE_NODE",
    );
  });
});
