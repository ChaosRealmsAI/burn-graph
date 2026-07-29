import { describe, expect, test } from "bun:test";

import {
  BurnGraphService,
  type CheckSpec,
  type GateExecutionClaim,
  type GraphSpec,
  type SystemNodeMutation,
  type WaitSignalSummary,
} from "@burn-graph/core";

import {
  createTestProject,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

const check: CheckSpec = {
  schemaVersion: 1,
  id: "shared-contract",
  revision: 1,
  title: "Shared System Node contract",
  argv: ["bun", "--version"],
  cwd: ".",
  successExitCodes: [0],
  timeoutMs: 5_000,
  maxOutputBytes: 4_096,
  inheritEnv: ["PATH"],
  resources: ["system-contract"],
};

function gateGraph(): GraphSpec {
  return {
    schemaVersion: 2,
    id: "shared-gate",
    title: "Shared Gate",
    goal: "Prove one exact System Node execution claim.",
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
        title: "Gate",
        prompt: prompt(""),
        next: [
          { to: "end", route: "pass" },
          { to: "end", route: "fail" },
        ],
        maxAttempts: 2,
        actorHint: null,
        tags: [],
        check: { id: check.id, revision: check.revision },
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

function waitGraph(): GraphSpec {
  return {
    schemaVersion: 2,
    id: "shared-wait",
    title: "Shared Wait",
    goal: "Prove one durable no-Assignment Signal.",
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "wait" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "wait",
        type: "wait",
        title: "Wait",
        prompt: prompt(""),
        next: [
          { to: "end", route: "accepted" },
          { to: "end", route: "timeout" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
        signal: {
          routes: ["accepted"],
          timeout: { afterMs: 60_000, route: "timeout" },
        },
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

describe("shared System Node contract", () => {
  test("registers Checks and claims at most one Gate outside SQLite", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      expect(service.applyCheck(check)).toEqual(check);
      service.applyGraph(gateGraph());
      const started = service.startRun("shared-gate", "shared-gate-r1");
      expect(started.value.summary.runtimeRevision).toBe(1);

      const claimed: SystemNodeMutation<GateExecutionClaim | null> =
        service.advanceSystemNodes("shared-gate-r1");
      expect(claimed.value).toMatchObject({
        runId: "shared-gate-r1",
        nodeId: "gate",
        check: { id: "shared-contract", revision: 1 },
      });
      expect(service.getSnapshot("shared-gate-r1", 0).nodes[1]).toMatchObject({
        status: "running",
        assignmentId: null,
        actorId: null,
      });
      expect(service.database.db.inTransaction).toBe(false);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("materializes Wait as one durable Signal without an Assignment", () => {
    const root = createTestProject();
    let signal: WaitSignalSummary | undefined;
    {
      const service = new BurnGraphService(root);
      try {
        service.applyGraph(waitGraph());
        service.startRun("shared-wait", "shared-wait-r1");
        const advanced = service.advanceSystemNodes("shared-wait-r1");
        expect(advanced.value).toBeNull();
        [signal] = service.listWaitSignals("shared-wait-r1");
        expect(signal).toMatchObject({
          runId: "shared-wait-r1",
          nodeId: "wait",
          routes: ["accepted"],
          status: "waiting",
        });
        expect(service.assignmentsForActor("nobody")).toEqual([]);
      } finally {
        service.close();
      }
    }

    const reopened = new BurnGraphService(root);
    try {
      expect(reopened.listWaitSignals("shared-wait-r1")).toEqual([signal!]);
      expect(reopened.getSnapshot("shared-wait-r1", 0).nodes[1]).toMatchObject({
        status: "waiting",
        assignmentId: null,
        actorId: null,
      });
    } finally {
      reopened.close();
      removeTestProject(root);
    }
  });
});
