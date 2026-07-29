import { describe, expect, test } from "bun:test";

import {
  BurnGraphError,
  BurnGraphService,
  type ChildRunDescriptor,
  type GraphSpec,
} from "@burn-graph/core";

import {
  createTestProject,
  parallelGraph,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

function staticGraph(
  id: string,
  children: readonly ChildRunDescriptor[],
  revision = 1,
): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: `${id} hierarchy`,
    goal: `Converge the exact children of ${id}.`,
    revision,
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
        title: "Children",
        prompt: prompt(""),
        next: [
          { to: "end", route: "success" },
          { to: "end", route: "failure" },
          { to: "end", route: "cancelled" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: ["hierarchy"],
        mode: "static",
        children: [...children],
        resources: [],
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

function expectGraphError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe(code);
  }
}

function gateGraph(id: string): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: `${id} machine gate`,
    goal: `Verify the execution boundary for ${id}.`,
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "gate" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "gate",
        type: "gate",
        title: "Machine Gate",
        prompt: prompt(""),
        next: [
          { to: "end", route: "pass" },
          { to: "end", route: "fail" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
        check: { id: "registered-check", revision: 1 },
        resources: [],
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

describe("GraphSpec v2 authoring", () => {
  test("registers exact static child revisions without embedding documents", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(parallelGraph("child"));
      const applied = service.applyGraph(
        staticGraph("parent", [
          { graphId: "child", revision: 1, label: "left" },
          {
            graphId: "child",
            revision: 1,
            runId: "parent-child-right",
            label: "right",
          },
        ]),
      );
      expect(applied).toMatchObject({
        schemaVersion: 2,
        id: "parent",
        revision: 1,
      });
      expect(applied.nodes[1]).toMatchObject({
        type: "subgraph",
        mode: "static",
        children: [
          { graphId: "child", revision: 1, label: "left" },
          {
            graphId: "child",
            revision: 1,
            runId: "parent-child-right",
            label: "right",
          },
        ],
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("rejects a missing child revision before Graph mutation", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      expectGraphError(
        () =>
          service.applyGraph(
            staticGraph("missing-parent", [
              { graphId: "missing-child", revision: 7 },
            ]),
          ),
        "GRAPH_NOT_FOUND",
      );
      expect(
        service.database.db
          .query(
            "SELECT COUNT(*) AS count FROM graph_specs WHERE graph_id = 'missing-parent'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("rejects an indirect ancestry cycle without replacing the last revision", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(parallelGraph("cycle-root"));
      service.applyGraph(
        staticGraph("cycle-child", [
          { graphId: "cycle-root", revision: 1 },
        ]),
      );

      expectGraphError(
        () =>
          service.applyGraph(
            staticGraph(
              "cycle-root",
              [{ graphId: "cycle-child", revision: 1 }],
              2,
            ),
          ),
        "HIERARCHY_CYCLE",
      );
      expect(service.getGraph("cycle-root").revision).toBe(1);
      expect(
        service.database.db
          .query(
            "SELECT COUNT(*) AS count FROM graph_specs WHERE graph_id = 'cycle-root'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("accepts future System Node contracts but fails before starting them", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(gateGraph("future-gate"));
      service.applyGraph(
        staticGraph("future-gate-parent", [
          {
            graphId: "future-gate",
            revision: 1,
            runId: "future-gate-child",
          },
        ]),
      );

      expectGraphError(
        () => service.startRun("future-gate-parent", "future-gate-root"),
        "SYSTEM_NODE_UNAVAILABLE",
      );
      expect(
        service.database.db
          .query("SELECT COUNT(*) AS count FROM runs")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
