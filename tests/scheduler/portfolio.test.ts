import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  BurnGraphService,
  type GraphSpec,
} from "@burn-graph/core";

import {
  createTestProject,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

function constrainActorCapacity(root: string, maximum: number): void {
  const file = path.join(root, ".burn-graph", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    file,
    `${JSON.stringify({
      ...config,
      maxAssignmentsPerActor: maximum,
    }, null, 2)}\n`,
  );
}

function taskGraph(
  id: string,
  resources: readonly string[] = [],
): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: `${id} workflow`,
    goal: `Complete ${id}.`,
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
        title: "Work",
        prompt: prompt(`Complete ${id}.`),
        next: [{ to: "end" }],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
        resources: [...resources],
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

function dynamicResourceGraph(id: string): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: "Dynamic resource workflow",
    goal: "Plan children while owning one exclusive planning resource.",
    revision: 1,
    maxActive: 1,
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
        title: "Plan children",
        prompt: prompt("Return the immutable child set."),
        next: [
          { to: "end", route: "success" },
          { to: "end", route: "failure" },
          { to: "end", route: "cancelled" },
        ],
        maxAttempts: 3,
        actorHint: null,
        tags: [],
        mode: "dynamic",
        minChildren: 1,
        maxChildren: 2,
        resources: ["planning"],
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

describe("portfolio scheduling", () => {
  test("orders priority roots and lets an aged low root outrank fresh high work", () => {
    const root = createTestProject();
    constrainActorCapacity(root, 1);
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      for (const id of ["priority-low", "priority-high", "fresh-high"]) {
        service.applyGraph(taskGraph(id));
      }
      service.startRun("priority-low", "priority-low-run");
      service.startRun("priority-high", "priority-high-run");
      const lowPriority = service.setRunPriority(
        "priority-low-run",
        "low",
        "priority-low-key",
      );
      const lowReplay = service.setRunPriority(
        "priority-low-run",
        "low",
        "priority-low-key",
      );
      expect(lowReplay.replayed).toBe(true);
      expect(lowReplay.revision).toBe(lowPriority.revision);
      service.setRunPriority(
        "priority-high-run",
        "high",
        "priority-high-key",
      );

      const first = service.schedule("one-slot");
      expect(first.assignments).toHaveLength(1);
      expect(first.assignments[0]!.graph.runId).toBe("priority-high-run");
      service.complete(
        "priority-high-run",
        "work",
        "one-slot",
        { summary: "High priority complete." },
      );

      now = new Date("2026-01-01T00:10:01.000Z");
      service.startRun("fresh-high", "fresh-high-run");
      service.setRunPriority(
        "fresh-high-run",
        "high",
        "fresh-high-key",
      );
      const ready = service.listReady();
      expect(
        ready.find((candidate) => candidate.runId === "priority-low-run"),
      ).toMatchObject({
        priority: "low",
        effectivePriority: "high",
      });
      const aged = service.schedule("one-slot");
      expect(aged.assignments).toHaveLength(1);
      expect(aged.assignments[0]!.graph.runId).toBe("priority-low-run");

      expect(() =>
        service.setRunPriority(
          "fresh-high-run",
          "normal",
          "fresh-high-key",
        ),
      ).toThrow(BurnGraphError);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("serializes conflicting Assignment resources and keeps unrelated work eligible", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      service.applyGraph(taskGraph("lock-a", ["rust-build"]));
      service.applyGraph(taskGraph("lock-b", ["rust-build"]));
      service.applyGraph(taskGraph("unrelated"));
      service.startRun("lock-a", "lock-a-run");
      service.startRun("lock-b", "lock-b-run");
      service.startRun("unrelated", "unrelated-run");

      const scheduled = service.schedule("portfolio-actor");
      expect(
        scheduled.assignments.map((assignment) => assignment.graph.runId).sort(),
      ).toEqual(["lock-a-run", "unrelated-run"]);
      expect(service.listResourceLocks()).toHaveLength(1);
      expect(service.listResourceLocks()[0]).toMatchObject({
        resource: "rust-build",
        ownerKind: "assignment",
        runId: "lock-a-run",
      });
      expect(
        service.listReady().find((candidate) => candidate.runId === "lock-b-run"),
      ).toMatchObject({
        resources: ["rust-build"],
        eligibility: {
          eligible: false,
          reason: "RESOURCE_BUSY",
          blockedResources: ["rust-build"],
        },
      });

      const lockA = scheduled.assignments.find(
        (assignment) => assignment.graph.runId === "lock-a-run",
      )!;
      service.complete(
        lockA.graph.runId,
        lockA.node.id,
        lockA.claim.actorId,
        { summary: "Released the exact build lock." },
      );
      expect(service.listResourceLocks()).toEqual([]);
      const second = service.schedule("portfolio-actor");
      expect(
        second.assignments.some(
          (assignment) => assignment.graph.runId === "lock-b-run",
        ),
      ).toBe(true);

      service.applyGraph(taskGraph("expiring-lock", ["release-archive"]));
      service.startRun("expiring-lock", "expiring-lock-run");
      service.claim("expiring-lock-run", "work", "expiring-actor", 30);
      expect(
        service.listResourceLocks("expiring-lock-run")[0],
      ).toMatchObject({ ownerKind: "assignment" });
      now = new Date("2026-01-01T00:00:31.000Z");
      service.reconcileExpired("expiring-lock-run");
      expect(service.listResourceLocks("expiring-lock-run")).toEqual([]);
      expect(service.listReady("expiring-lock-run")[0]).toMatchObject({
        eligibility: { eligible: true },
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("uses the same lock lifecycle for dynamic Subgraph Assignments", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(dynamicResourceGraph("dynamic-resource"));
      service.startRun("dynamic-resource", "dynamic-resource-run");
      const claim = service.claim(
        "dynamic-resource-run",
        "children",
        "planner",
        60,
      );
      expect(service.listResourceLocks()).toEqual([
        expect.objectContaining({
          resource: "planning",
          ownerKind: "assignment",
          ownerId: claim.value.assignmentId,
        }),
      ]);
      service.cancelRun("dynamic-resource-run", "cancel-dynamic-resource");
      expect(service.listResourceLocks()).toEqual([]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
