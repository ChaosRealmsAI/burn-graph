import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  BurnGraphService,
  type AssignmentPacket,
  type ChildRunDescriptor,
  type GraphSpec,
  type GraphSummary,
} from "@burn-graph/core";

import {
  createTestProject,
  parallelGraph,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

function singleTaskGraph(id: string): GraphSpec {
  return {
    schemaVersion: 1,
    id,
    title: `${id} task`,
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
        maxAttempts: 1,
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

function instantGraph(id: string): GraphSpec {
  return {
    schemaVersion: 1,
    id,
    title: `${id} instant`,
    goal: `Complete ${id} structurally.`,
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "end" }],
        maxAttempts: 1,
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

function staticParentGraph(
  id: string,
  children: readonly ChildRunDescriptor[],
): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: `${id} parent`,
    goal: `Converge ${id} child Runs.`,
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
        title: "Children",
        prompt: prompt(""),
        next: [
          { to: "end", route: "success" },
          { to: "failed", route: "failure" },
          { to: "cancelled", route: "cancelled" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: ["hierarchy"],
        mode: "static",
        children: [...children],
        resources: [],
      },
      {
        id: "failed",
        type: "task",
        title: "Repair failed child",
        prompt: prompt("Repair the failed child outcome."),
        next: [{ to: "end" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "cancelled",
        type: "task",
        title: "Handle cancelled child",
        prompt: prompt("Handle the cancelled child outcome."),
        next: [{ to: "end" }],
        maxAttempts: 1,
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

function dynamicParentGraph(id: string): GraphSpec {
  const graph = staticParentGraph(id, []);
  const nodes = graph.nodes.map((node) =>
    node.id === "children"
      ? {
          ...node,
          mode: "dynamic" as const,
          children: undefined,
          minChildren: 1,
          maxChildren: 4,
          prompt: {
            ...prompt("Return the exact immutable child set."),
            role: "Planner",
            lockedContracts: ["../privacy/architecture.md"],
          },
        }
      : node,
  );
  return {
    ...graph,
    nodes,
  } as GraphSpec;
}

function linearGraph(id: string, nodeCount: number): GraphSpec {
  const taskCount = nodeCount - 2;
  return {
    schemaVersion: 1,
    id,
    title: `${id} linear projection`,
    goal: `Project exactly ${nodeCount} nodes.`,
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "task-0" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      ...Array.from({ length: taskCount }, (_, index) => ({
        id: `task-${index}`,
        type: "task" as const,
        title: `Task ${index}`,
        prompt: prompt(`Complete task ${index}.`),
        next: [{ to: index === taskCount - 1 ? "end" : `task-${index + 1}` }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      })),
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

function assignment(
  assignments: readonly AssignmentPacket[],
  runId: string,
  nodeId = "work",
): AssignmentPacket {
  const found = assignments.find(
    (candidate) =>
      candidate.graph.runId === runId && candidate.node.id === nodeId,
  );
  if (!found) throw new Error(`Missing Assignment ${runId}/${nodeId}`);
  return found;
}

function hierarchy(
  summaries: readonly GraphSummary[],
  runId: string,
): GraphSummary & {
  parentRunId: string | null;
  parentNodeId: string | null;
  rootRunId: string;
  depth: number;
  priority: "low" | "normal" | "high";
} {
  const found = summaries.find((candidate) => candidate.runId === runId);
  if (!found) throw new Error(`Missing Run ${runId}`);
  return found as ReturnType<typeof hierarchy>;
}

function completeWork(
  service: BurnGraphService,
  packet: AssignmentPacket,
) {
  return service.completeAndContinue(packet.assignmentId, {
    summary: `Completed ${packet.graph.runId}.`,
    evidence: [`evidence:${packet.graph.runId}`],
  });
}

function expectError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe(code);
  }
}

describe("hierarchical Run convergence", () => {
  test("starts repeated static children atomically and settles the parent", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("slice"));
      service.applyGraph(
        staticParentGraph("delivery", [
          { graphId: "slice", revision: 1, runId: "slice-left" },
          { graphId: "slice", revision: 1, runId: "slice-right" },
        ]),
      );

      const started = service.startWithAssignments(
        "delivery",
        "primary",
        "delivery-root",
      );
      expect(
        started.assignments.map((packet) => packet.graph.runId).sort(),
      ).toEqual(["slice-left", "slice-right"]);

      const summaries = service.listRuns();
      expect(hierarchy(summaries, "delivery-root")).toMatchObject({
        parentRunId: null,
        parentNodeId: null,
        rootRunId: "delivery-root",
        depth: 0,
        priority: "normal",
      });
      expect(hierarchy(summaries, "slice-left")).toMatchObject({
        parentRunId: "delivery-root",
        parentNodeId: "children",
        rootRunId: "delivery-root",
        depth: 1,
      });
      expect(
        service.getSnapshot("delivery-root").nodes.find(
          (node) => node.id === "children",
        )?.status,
      ).toBe("waiting");

      completeWork(
        service,
        assignment(started.assignments, "slice-left"),
      );
      const finished = completeWork(
        service,
        assignment(started.assignments, "slice-right"),
      );
      expect(service.getSnapshot("delivery-root").summary.status).toBe(
        "completed",
      );
      expect(finished.changes.map((change) => change.event.runId)).toEqual([
        "slice-right",
        "delivery-root",
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("rolls back a seeded failure after the first static child insert", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("atomic-child"));
      service.applyGraph(
        staticParentGraph("atomic-parent", [
          {
            graphId: "atomic-child",
            revision: 1,
            runId: "atomic-child-left",
          },
          {
            graphId: "atomic-child",
            revision: 1,
            runId: "atomic-child-right",
          },
        ]),
      );
      service.database.db.exec(`
        CREATE TRIGGER seeded_second_child_failure
        BEFORE INSERT ON subgraph_links
        WHEN NEW.position = 1
        BEGIN
          SELECT RAISE(ABORT, 'seeded second child failure');
        END;
      `);

      expect(() =>
        service.startRun("atomic-parent", "atomic-parent-run"),
      ).toThrow("seeded second child failure");
      expect(service.listRuns()).toEqual([]);
      expect(service.listEvents()).toEqual([]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("seals a dynamic child set through done and makes replay inert", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("dynamic-child"));
      service.applyGraph(dynamicParentGraph("dynamic-delivery"));
      const started = service.startWithAssignments(
        "dynamic-delivery",
        "planner",
        "dynamic-root",
      );
      const planner = assignment(
        started.assignments,
        "dynamic-root",
        "children",
      );
      const completion = {
        summary: "Planned two exact children.",
        evidence: ["evidence:plan"],
        output: {
          children: [
            {
              graphId: "dynamic-child",
              revision: 1,
              label: "left",
            },
            {
              graphId: "dynamic-child",
              revision: 1,
              label: "right",
            },
          ],
        },
      };
      const sealed = service.completeAndContinue(
        planner.assignmentId,
        completion,
      );
      expect(sealed.assignments).toHaveLength(2);
      const assignedRunIds = sealed.assignments
        .map((packet) => packet.graph.runId)
        .sort();
      expect(
        assignedRunIds.every((runId) => runId.startsWith("child-")),
      ).toBe(true);
      const normalizedOutput = sealed.completed.result.output as {
        children: Array<{
          graphId: string;
          revision: number;
          runId: string;
          label: string;
        }>;
      };
      expect(
        normalizedOutput.children.map(({ label }) => label),
      ).toEqual(["left", "right"]);
      expect(
        normalizedOutput.children.map(({ runId }) => runId).sort(),
      ).toEqual(assignedRunIds);
      const beforeReplay = {
        runCount: service.listRuns().length,
        parentRevision: service.getSnapshot("dynamic-root").summary
          .runtimeRevision,
        eventCount: service.listEvents("dynamic-root").length,
      };
      const replay = service.completeAndContinue(
        planner.assignmentId,
        completion,
      );
      expect(replay.replayed).toBe(true);
      expect({
        runCount: service.listRuns().length,
        parentRevision: service.getSnapshot("dynamic-root").summary
          .runtimeRevision,
        eventCount: service.listEvents("dynamic-root").length,
      }).toEqual(beforeReplay);

      expectError(
        () =>
          service.completeAndContinue(planner.assignmentId, {
            ...completion,
            output: {
              children: [
                {
                  graphId: "dynamic-child",
                  revision: 1,
                  runId: "dynamic-other",
                },
              ],
            },
          }),
        "ASSIGNMENT_INPUT_CONFLICT",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("recovers a two-level tree after restart and converges every ancestor", () => {
    const root = createTestProject();
    let service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("leaf"));
      service.applyGraph(
        staticParentGraph("middle", [
          { graphId: "leaf", revision: 1, runId: "leaf-run" },
        ]),
      );
      service.applyGraph(
        staticParentGraph("portfolio", [
          { graphId: "middle", revision: 1, runId: "middle-run" },
        ]),
      );
      const started = service.startWithAssignments(
        "portfolio",
        "primary",
        "portfolio-root",
      );
      const leaf = assignment(started.assignments, "leaf-run");
      service.close();

      service = new BurnGraphService(root);
      const finished = completeWork(service, leaf);
      expect(
        ["leaf-run", "middle-run", "portfolio-root"].map(
          (runId) => service.getSnapshot(runId).summary.status,
        ),
      ).toEqual(["completed", "completed", "completed"]);
      expect(finished.changes.map((change) => change.event.runId)).toEqual([
        "leaf-run",
        "middle-run",
        "portfolio-root",
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("pauses a tree without replacing a live handle and resumes ready work", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("pause-child"));
      service.applyGraph(
        staticParentGraph("pause-parent", [
          { graphId: "pause-child", revision: 1, runId: "pause-left" },
          { graphId: "pause-child", revision: 1, runId: "pause-right" },
        ]),
      );
      service.startRun("pause-parent", "pause-root");
      const left = service.claim("pause-left", "work", "actor-left", 60).value;
      const paused = service.pauseRun("pause-root", "pause-root-request");
      expect(paused.value.summary.status).toBe("pausing");
      const beforePauseReplay = {
        revisions: service
          .listRuns()
          .map((run) => [run.runId, run.runtimeRevision]),
        events: service.listEvents().length,
      };
      const pauseReplay = service.pauseRun(
        "pause-root",
        "pause-root-request",
      );
      expect(pauseReplay.replayed).toBe(true);
      expect({
        revisions: service
          .listRuns()
          .map((run) => [run.runId, run.runtimeRevision]),
        events: service.listEvents().length,
      }).toEqual(beforePauseReplay);
      expectError(
        () => service.cancelRun("pause-root", "pause-root-request"),
        "IDEMPOTENCY_KEY_CONFLICT",
      );
      expect(service.schedule("actor-right").assignments).toHaveLength(0);

      service.completeAndContinue(left.assignmentId, {
        summary: "Left settled during pause.",
        evidence: [],
      });
      expect(service.getSnapshot("pause-root").summary.status).toBe("paused");
      const resumed = service.resumeWithAssignments(
        "pause-root",
        "actor-right",
        "resume-root-request",
      );
      expect(resumed.assignments.map((packet) => packet.graph.runId)).toEqual([
        "pause-right",
      ]);
      const resumeReplay = service.resumeWithAssignments(
        "pause-root",
        "actor-right",
        "resume-root-request",
      );
      expect(resumeReplay.replayed).toBe(true);
      expect(
        resumeReplay.assignments.map((packet) => packet.assignmentId),
      ).toEqual(resumed.assignments.map((packet) => packet.assignmentId));
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("cancels the unfinished tree and makes every AI handle stale", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("cancel-child"));
      service.applyGraph(
        staticParentGraph("cancel-parent", [
          { graphId: "cancel-child", revision: 1, runId: "cancel-left" },
          { graphId: "cancel-child", revision: 1, runId: "cancel-right" },
        ]),
      );
      const started = service.startWithAssignments(
        "cancel-parent",
        "primary",
        "cancel-root",
      );
      const held = assignment(started.assignments, "cancel-left");
      const cancelled = service.cancelRun(
        "cancel-root",
        "cancel-root-request",
      );
      expect(cancelled.value.summary.status).toBe("cancelled");
      expect(
        service
          .listRuns()
          .filter((run) => run.rootRunId === "cancel-root")
          .map((run) => run.status),
      ).toEqual(["cancelled", "cancelled", "cancelled"]);
      const beforeReplay = {
        revisions: service
          .listRuns()
          .map((run) => [run.runId, run.runtimeRevision]),
        events: service.listEvents().length,
      };
      const replay = service.cancelRun(
        "cancel-root",
        "cancel-root-request",
      );
      expect(replay.replayed).toBe(true);
      expect({
        revisions: service
          .listRuns()
          .map((run) => [run.runId, run.runtimeRevision]),
        events: service.listEvents().length,
      }).toEqual(beforeReplay);
      expectError(
        () =>
          service.completeAndContinue(held.assignmentId, {
            summary: "Stale completion.",
            evidence: [],
          }),
        "ASSIGNMENT_NOT_ACTIVE",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("quiesces a paused tree after its final Assignment lease expires", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      service.applyGraph(singleTaskGraph("expiry-child"));
      service.applyGraph(
        staticParentGraph("expiry-parent", [
          {
            graphId: "expiry-child",
            revision: 1,
            runId: "expiry-child-run",
          },
        ]),
      );
      service.startRun("expiry-parent", "expiry-root");
      service.claim("expiry-child-run", "work", "expiry-actor", 30);
      service.pauseRun("expiry-root", "expiry-pause");

      now = new Date("2026-01-01T00:00:31.000Z");
      const reconciled = service.reconcileExpired();
      expect(reconciled).toHaveLength(1);
      expect(service.getSnapshot("expiry-root").summary.status).toBe("paused");
      expect(
        service.getSnapshot("expiry-child-run").nodes.find(
          (node) => node.id === "work",
        )?.status,
      ).toBe("ready");
      expect(
        reconciled[0]?.changes?.map((change) => change.event.type),
      ).toEqual([
        "claims.reconciled",
        "run.paused",
        "run.paused",
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("waits for every child terminal outcome before routing a failure", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("failure-child"));
      service.applyGraph(
        staticParentGraph("failure-parent", [
          {
            graphId: "failure-child",
            revision: 1,
            runId: "failure-left",
          },
          {
            graphId: "failure-child",
            revision: 1,
            runId: "failure-right",
          },
        ]),
      );
      const started = service.startWithAssignments(
        "failure-parent",
        "worker",
        "failure-root",
      );
      const left = assignment(started.assignments, "failure-left");
      const right = assignment(started.assignments, "failure-right");
      const failed = service.failAssignment(
        left.assignmentId,
        "Seeded child failure.",
        false,
      );
      expect(service.getSnapshot("failure-left").summary.status).toBe(
        "failed",
      );
      expect(
        service.getSnapshot("failure-root").nodes.find(
          (node) => node.id === "children",
        ),
      ).toMatchObject({ status: "waiting", route: null });
      expect(
        failed.assignments.some(
          (packet) =>
            packet.graph.runId === "failure-root" &&
            packet.node.id === "failed",
        ),
      ).toBe(false);

      const settled = completeWork(service, right);
      expect(
        service.getSnapshot("failure-root").nodes.find(
          (node) => node.id === "children",
        ),
      ).toMatchObject({ status: "done", route: "failure" });
      expect(
        settled.assignments.some(
          (packet) =>
            packet.graph.runId === "failure-root" &&
            packet.node.id === "failed",
        ),
      ).toBe(true);
      expect(
        settled.changes.slice(0, 2).map((change) => change.event.runId),
      ).toEqual(["failure-right", "failure-root"]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("hard failure invalidates sibling work before the child becomes terminal", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(parallelGraph("parallel-failure-child"));
      service.applyGraph(
        staticParentGraph("parallel-failure-parent", [
          {
            graphId: "parallel-failure-child",
            revision: 1,
            runId: "parallel-failure-child-run",
          },
        ]),
      );
      const started = service.startWithAssignments(
        "parallel-failure-parent",
        "worker",
        "parallel-failure-root",
      );
      const left = assignment(
        started.assignments,
        "parallel-failure-child-run",
        "left",
      );
      const right = assignment(
        started.assignments,
        "parallel-failure-child-run",
        "right",
      );
      const failed = service.failAssignment(
        left.assignmentId,
        "Seeded hard failure.",
        false,
      );

      const child = service.getSnapshot("parallel-failure-child-run");
      expect(child.summary.status).toBe("failed");
      expect(
        child.nodes.find((node) => node.id === "right")?.status,
      ).toBe("cancelled");
      expect(
        failed.assignments.some(
          (packet) =>
            packet.graph.runId === "parallel-failure-root" &&
            packet.node.id === "failed",
        ),
      ).toBe(true);
      expectError(
        () =>
          service.completeAndContinue(right.assignmentId, {
            summary: "Stale sibling completion.",
            evidence: [],
          }),
        "ASSIGNMENT_NOT_ACTIVE",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("counts every recursive static descendant before dynamic attachment", () => {
    const root = createTestProject();
    const configFile = path.join(root, ".burn", "graph", "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8")) as {
      maxUnfinishedDescendants: number;
    };
    config.maxUnfinishedDescendants = 3;
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("bounded-leaf"));
      service.applyGraph(
        staticParentGraph("bounded-branch", [
          {
            graphId: "bounded-leaf",
            revision: 1,
            runId: "bounded-nested-left",
          },
          {
            graphId: "bounded-leaf",
            revision: 1,
            runId: "bounded-nested-right",
          },
        ]),
      );
      service.applyGraph(dynamicParentGraph("bounded-root"));
      const planner = service.startWithAssignments(
        "bounded-root",
        "planner",
        "bounded-root-run",
      ).assignments[0]!;
      expectError(
        () =>
          service.completeAndContinue(planner.assignmentId, {
            summary: "Attempt an input-order-dependent overflow.",
            evidence: [],
            output: {
              children: [
                {
                  graphId: "bounded-branch",
                  revision: 1,
                  runId: "bounded-branch-run",
                },
                {
                  graphId: "bounded-leaf",
                  revision: 1,
                  runId: "bounded-plain-run",
                },
              ],
            },
          }),
        "HIERARCHY_LIMIT",
      );
      expect(service.listRuns().map((run) => run.runId)).toEqual([
        "bounded-root-run",
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("folds instant child settlement into one parent revision and change", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(instantGraph("instant-child"));
      service.applyGraph(dynamicParentGraph("instant-parent"));
      const planner = service.startWithAssignments(
        "instant-parent",
        "planner",
        "instant-root",
      ).assignments[0]!;
      const before = service.getSnapshot("instant-root").summary
        .runtimeRevision;
      const completed = service.completeAndContinue(planner.assignmentId, {
        summary: "Attach one structurally complete child.",
        evidence: [],
        output: {
          children: [
            {
              graphId: "instant-child",
              revision: 1,
              runId: "instant-child-run",
            },
          ],
        },
      });
      const snapshot = service.getSnapshot("instant-root");
      expect(snapshot.summary.runtimeRevision).toBe(before + 1);
      expect(snapshot.summary.status).toBe("completed");
      expect(snapshot.events.map((event) => event.type)).toEqual([
        "run.started",
        "node.claimed",
        "node.completed",
      ]);
      expect(
        completed.changes.map((change) => [
          change.event.runId,
          change.event.type,
        ]),
      ).toEqual([
        ["instant-child-run", "run.started"],
        ["instant-root", "node.completed"],
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("rejects dynamic width and ancestry before creating any child", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("bounded-child"));
      service.applyGraph(dynamicParentGraph("bounded-parent"));
      const started = service.startWithAssignments(
        "bounded-parent",
        "planner",
        "bounded-root",
      );
      const planner = assignment(
        started.assignments,
        "bounded-root",
        "children",
      );
      expectError(
        () =>
          service.completeAndContinue(planner.assignmentId, {
            summary: "Too many children.",
            evidence: [],
            output: {
              children: Array.from({ length: 5 }, (_, index) => ({
                graphId: "bounded-child",
                revision: 1,
                runId: `bounded-child-${index}`,
              })),
            },
          }),
        "HIERARCHY_LIMIT",
      );
      expectError(
        () =>
          service.completeAndContinue(planner.assignmentId, {
            summary: "Recursive child.",
            evidence: [],
            output: {
              children: [
                {
                  graphId: "bounded-parent",
                  revision: 1,
                  runId: "recursive-child",
                },
              ],
            },
          }),
        "HIERARCHY_CYCLE",
      );
      expect(service.listRuns().map((run) => run.runId)).toEqual([
        "bounded-root",
      ]);
      expect(
        service.getSnapshot("bounded-root").nodes.find(
          (node) => node.id === "children",
        )?.status,
      ).toBe("running");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("rejects a dynamic child whose static descendants repeat an ancestor", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("ancestor-root"));
      service.applyGraph(
        staticParentGraph("ancestor-child", [
          { graphId: "ancestor-root", revision: 1 },
        ]),
      );
      service.applyGraph({
        ...dynamicParentGraph("ancestor-root"),
        revision: 2,
      });
      const started = service.startWithAssignments(
        "ancestor-root",
        "planner",
        "ancestor-root-run",
      );
      const planner = assignment(
        started.assignments,
        "ancestor-root-run",
        "children",
      );
      expectError(
        () =>
          service.completeAndContinue(planner.assignmentId, {
            summary: "Attach an indirectly recursive child.",
            evidence: [],
            output: {
              children: [
                {
                  graphId: "ancestor-child",
                  revision: 1,
                  runId: "ancestor-child-run",
                },
              ],
            },
          }),
        "HIERARCHY_CYCLE",
      );
      expect(service.listRuns().map((run) => run.runId)).toEqual([
        "ancestor-root-run",
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("projects one canonical tree as folded and expanded read-only snapshots", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("projection-leaf"));
      service.applyGraph(
        staticParentGraph("projection-middle", [
          {
            graphId: "projection-leaf",
            revision: 1,
            runId: "projection-leaf-run",
            label: "leaf",
          },
        ]),
      );
      service.applyGraph(
        staticParentGraph("projection-root", [
          {
            graphId: "projection-middle",
            revision: 1,
            runId: "projection-middle-run",
            label: "middle",
          },
        ]),
      );
      service.startRun("projection-root", "projection-root-run");
      const before = {
        revisions: service
          .listRuns()
          .map((run) => [run.runId, run.runtimeRevision]),
        events: service.listEvents().length,
      };

      const folded = service.getTreeSnapshot(
        "projection-root-run",
        0,
        500,
      );
      expect(folded).toMatchObject({
        schemaVersion: 1,
        treeRootRunId: "projection-root-run",
        projection: {
          depth: 0,
          maximumDepth: 2,
          totalRuns: 3,
          expandedRuns: 1,
          foldedRuns: 2,
          renderedNodes: 6,
        },
      });
      expect(folded.runs.map((entry) => entry.folded)).toEqual([false, true]);
      expect(folded.mermaid).toContain(
        "running · normal · 1/5 · +1 · middle",
      );
      expect(folded.mermaid).toContain("projection-root-run");
      expect(folded.mermaid).not.toContain("projection-leaf-run");

      const expanded = service.getTreeSnapshot(
        "projection-root-run",
        1,
        500,
      );
      expect(expanded.projection).toMatchObject({
        expandedRuns: 2,
        foldedRuns: 1,
        renderedNodes: 11,
      });
      expect(expanded.mermaid).toContain("projection-middle-run");
      expect(expanded.mermaid).toContain("child Runs");
      expect(
        service.projectSnapshot().rootRuns.find(
          (run) => run.summary.runId === "projection-root-run",
        ),
      ).toMatchObject({
        directChildRuns: 1,
        descendantRuns: 2,
      });
      expect({
        revisions: service
          .listRuns()
          .map((run) => [run.runId, run.runtimeRevision]),
        events: service.listEvents().length,
      }).toEqual(before);
      expectError(
        () => service.getTreeSnapshot("projection-root-run", 1, 10),
        "PROJECTION_LIMIT",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("keeps a WAL read snapshot stable while another connection commits", () => {
    const root = createTestProject();
    const reader = new BurnGraphService(root);
    const writer = new BurnGraphService(root);
    try {
      reader.applyGraph(singleTaskGraph("consistent-read"));
      const observed = reader.database.read(() => {
        const before = (
          reader.database.db
            .query("SELECT COUNT(*) AS count FROM runs")
            .get() as { count: number }
        ).count;
        writer.startRun("consistent-read", "consistent-read:run");
        const during = (
          reader.database.db
            .query("SELECT COUNT(*) AS count FROM runs")
            .get() as { count: number }
        ).count;
        return { before, during };
      });
      expect(observed).toEqual({ before: 0, during: 0 });
      expect(reader.listRuns()).toHaveLength(1);
    } finally {
      writer.close();
      reader.close();
      removeTestProject(root);
    }
  });

  test("folds a 256-Run tree and bounds a 500-node expansion", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(singleTaskGraph("projection-shared-leaf"));
      const branchDescriptors: ChildRunDescriptor[] = [];
      for (let branch = 0; branch < 15; branch += 1) {
        const branchId = `projection-branch-${branch}`;
        service.applyGraph(
          staticParentGraph(
            branchId,
            Array.from({ length: 16 }, (_, leaf) => ({
              graphId: "projection-shared-leaf",
              revision: 1,
              runId: `projection-leaf-${branch}-${leaf}`,
              label: `leaf ${branch}/${leaf}`,
            })),
          ),
        );
        branchDescriptors.push({
          graphId: branchId,
          revision: 1,
          runId: `projection-branch-run-${branch}`,
          label: `branch ${branch}`,
        });
      }
      service.applyGraph(
        staticParentGraph("projection-portfolio", branchDescriptors),
      );
      service.startRun("projection-portfolio", "projection-portfolio-run");

      // Bounding is what this test owns. The 1000ms tail budget that used to sit
      // here is measured by scripts/verify/hierarchy-performance.ts, over this
      // exact fixture with p95 across five samples — here it competed with 65
      // other tests for CPU and duplicated a budget that already has an owner.
      const folded = service.getTreeSnapshot("projection-portfolio-run", 0, 500, 0);
      expect(folded.projection).toMatchObject({
        totalRuns: 256,
        expandedRuns: 1,
        foldedRuns: 255,
        renderedNodes: 20,
      });
      expect(folded.runs).toHaveLength(16);

      service.applyGraph(linearGraph("projection-500", 500));
      service.startRun("projection-500", "projection-500-run");
      const expanded = service.getTreeSnapshot("projection-500-run", 0, 500, 0);
      expect(expanded.projection).toMatchObject({
        totalRuns: 1,
        expandedRuns: 1,
        foldedRuns: 0,
        renderedNodes: 500,
      });
      expectError(
        () => service.getTreeSnapshot("projection-500-run", 0, 499, 0),
        "PROJECTION_LIMIT",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
