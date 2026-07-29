import { describe, expect, test } from "bun:test";

import {
  BurnGraphService,
  type CheckSpec,
  type GraphSpec,
} from "@burn-graph/core";
import { SystemNodeDriver } from "@burn-graph/system-driver";

import {
  createTestProject,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

const check: CheckSpec = {
  schemaVersion: 1,
  id: "driver-check",
  revision: 1,
  title: "Known bad fixture",
  argv: ["bun", "-e", "process.exit(1)"],
  cwd: ".",
  successExitCodes: [0],
  timeoutMs: 2_000,
  maxOutputBytes: 1_024,
  inheritEnv: ["PATH"],
  resources: ["driver-check"],
};

const graph: GraphSpec = {
  schemaVersion: 2,
  id: "driver-graph",
  title: "Driver Graph",
  goal: "Run a Gate and return repair work.",
  revision: 1,
  maxActive: 2,
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
      title: "Verify",
      prompt: prompt(""),
      next: [
        { to: "end", route: "pass" },
        { to: "repair", route: "fail" },
      ],
      maxAttempts: 1,
      actorHint: null,
      tags: [],
      check: { id: check.id, revision: check.revision },
      resources: [],
    },
    {
      id: "repair",
      type: "task",
      title: "Repair",
      prompt: prompt("Repair the seeded defect."),
      next: [{ to: "end" }],
      maxAttempts: 1,
      actorHint: null,
      tags: [],
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

describe("System Node Driver", () => {
  test("runs a registered Gate outside Core and returns the repair Assignment", async () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyCheck(check);
      service.applyGraph(graph);
      const result = await new SystemNodeDriver(service).start(
        graph.id,
        "driver-ai",
        "driver-r1",
      );
      expect(result.system).toMatchObject({
        transitions: 1,
        gateExecutions: 1,
        boundReached: false,
      });
      expect(result.assignments).toHaveLength(1);
      expect(result.assignments[0]?.node.id).toBe("repair");
      expect(service.listResourceLocks("driver-r1")).toEqual([]);
      expect(service.listCheckExecutions("driver-r1")[0]).toMatchObject({
        status: "completed",
        classification: "non_success",
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("blocks a missing executable without selecting the fail route", async () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyCheck({
        ...check,
        id: "missing-driver-check",
        argv: ["burn-graph-definitely-missing"],
        resources: [],
      });
      service.applyGraph({
        ...graph,
        id: "missing-driver-graph",
        nodes: graph.nodes.map((node) =>
          node.id === "gate"
            ? {
                ...node,
                check: { id: "missing-driver-check", revision: 1 },
              }
            : node,
        ),
      });
      const result = await new SystemNodeDriver(service).start(
        "missing-driver-graph",
        "driver-ai",
        "missing-driver-r1",
      );
      expect(result.state).toBe("blocked");
      expect(result.assignments).toEqual([]);
      expect(service.getSnapshot("missing-driver-r1", 0).nodes[1]).toMatchObject({
        status: "blocked",
        route: null,
        lastError: "CHECK_SPAWN_ERROR",
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
