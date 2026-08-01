import { describe, expect, test } from "bun:test";

import { BurnGraphError, validateGraphSpec } from "@burn-graph/core";

import { goalGraph } from "../helpers/fixtures.ts";

function expectGraphError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe(code);
  }
}

describe("GraphSpec v3 Goal–Graph–Work validation", () => {
  test("accepts one evidence-owned path with a final bounded Review", () => {
    const validated = validateGraphSpec(goalGraph());
    expect(validated.spec.schemaVersion).toBe(3);
    expect(validated.spec.nodes[1]?.work).toEqual({
      kind: "execute",
      evidence: ["E1"],
      reviewOf: [],
    });
  });

  test("rejects assignable nodes without Work ownership", () => {
    const graph = structuredClone(goalGraph());
    delete graph.nodes[1]!.work;
    expectGraphError(() => validateGraphSpec(graph), "INVALID_GRAPH");
  });

  test("rejects unowned evidence and unbounded Review repair", () => {
    const unowned = structuredClone(goalGraph());
    if (unowned.schemaVersion !== 3) throw new Error("Expected GraphSpec v3");
    unowned.goal.successEvidence.push({
      id: "E2",
      description: "A second result exists.",
      acceptance: ["The second result is observable."],
      oracle: "An external observer checks it.",
    });
    expectGraphError(() => validateGraphSpec(unowned), "INVALID_GRAPH");

    const unbounded = structuredClone(goalGraph());
    delete unbounded.nodes[2]!.next[1]!.maxTraversals;
    expectGraphError(() => validateGraphSpec(unbounded), "INVALID_ROUTE");
  });

  test("rejects duplicate execution ownership of one Goal evidence item", () => {
    const graph = structuredClone(goalGraph());
    graph.nodes.splice(2, 0, {
      id: "duplicate-owner",
      type: "task",
      title: "Duplicate owner",
      prompt: graph.nodes[1]!.prompt,
      work: { kind: "execute", evidence: ["E1"], reviewOf: [] },
      next: [{ to: "review" }],
      maxAttempts: 1,
      actorHint: null,
      tags: [],
    });
    graph.nodes[0]!.next.push({ to: "duplicate-owner" });
    expectGraphError(() => validateGraphSpec(graph), "INVALID_GRAPH");
  });

  test("rejects a completion path that bypasses final Review", () => {
    const graph = structuredClone(goalGraph());
    graph.nodes[0]!.next.push({ to: "end" });
    expectGraphError(() => validateGraphSpec(graph), "INVALID_GRAPH");
  });
});
