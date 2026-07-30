import { describe, expect, test } from "bun:test";

import {
  BurnGraphError,
  BurnGraphService,
  type GraphSpec,
  type GraphSnapshot,
} from "@burn-graph/core";

import {
  createTestProject,
  loopGraph,
  parallelGraph,
  prompt,
  removeTestProject,
  schemaGraph,
  wideGraph,
} from "../helpers/fixtures.ts";

function status(snapshot: GraphSnapshot, nodeId: string): string {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Missing ${nodeId}`);
  return node.status;
}

function complete(
  service: BurnGraphService,
  runId: string,
  nodeId: string,
  actorId: string,
  extra: Readonly<Record<string, unknown>> = {},
): GraphSnapshot {
  return service.complete(runId, nodeId, actorId, {
    summary: `Completed ${nodeId}.`,
    evidence: [`evidence:${nodeId}`],
    ...extra,
  }).value;
}

function upstreamBranchLoopGraph(): GraphSpec {
  return {
    schemaVersion: 1,
    id: "upstream-branch-loop",
    title: "Upstream branch repair",
    goal: "Reopen a skipped success branch after one bounded repair.",
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
        prompt: prompt("Produce the candidate result."),
        next: [{ to: "classify" }],
        maxAttempts: 2,
        actorHint: null,
        tags: [],
      },
      {
        id: "classify",
        type: "decision",
        title: "Classify",
        prompt: prompt("Choose pass or fail."),
        next: [
          { to: "success", route: "pass" },
          { to: "review", route: "fail" },
        ],
        maxAttempts: 2,
        actorHint: null,
        tags: [],
      },
      {
        id: "review",
        type: "decision",
        title: "Review",
        prompt: prompt("Repair the failed classification."),
        next: [
          {
            to: "work",
            route: "repair",
            maxTraversals: 1,
          },
          { to: "end", route: "abort" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "success",
        type: "task",
        title: "Success",
        prompt: prompt("Continue through the restored success branch."),
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

function convergingRoutesGraph(): GraphSpec {
  return {
    schemaVersion: 1,
    id: "converging-routes",
    title: "Converging routes",
    goal: "Expose one predecessor when several routes share a successor.",
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "decision" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "decision",
        type: "decision",
        title: "Decision",
        prompt: prompt("Choose one route."),
        next: [
          { to: "after", route: "pass" },
          { to: "after", route: "fail" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "after",
        type: "task",
        title: "After",
        prompt: prompt("Read the direct predecessor once."),
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

describe("runtime convergence", () => {
  test("parallel branches wait at Join and complete exactly once", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(parallelGraph());
      let snapshot = service.startRun("parallel", "parallel:run").value;
      expect(status(snapshot, "left")).toBe("ready");
      expect(status(snapshot, "right")).toBe("ready");
      expect(status(snapshot, "join")).toBe("pending");

      service.claim("parallel:run", "left", "actor-left", 60);
      service.claim("parallel:run", "right", "actor-right", 60);
      snapshot = complete(service, "parallel:run", "left", "actor-left");
      expect(status(snapshot, "join")).toBe("pending");
      snapshot = complete(service, "parallel:run", "right", "actor-right");

      expect(status(snapshot, "join")).toBe("done");
      expect(status(snapshot, "end")).toBe("done");
      expect(snapshot.summary.status).toBe("completed");
      expect(
        snapshot.events.filter((event) => event.type === "node.completed"),
      ).toHaveLength(2);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("bounded repair preserves Attempts and converges on pass", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(loopGraph());
      service.startRun("repair-loop", "repair-loop:run");

      service.claim("repair-loop:run", "work", "worker", 60);
      complete(service, "repair-loop:run", "work", "worker");
      service.claim("repair-loop:run", "decide", "reviewer", 60);
      let snapshot = complete(
        service,
        "repair-loop:run",
        "decide",
        "reviewer",
        { route: "repair" },
      );

      expect(status(snapshot, "work")).toBe("ready");
      expect(status(snapshot, "decide")).toBe("pending");
      expect(
        snapshot.edges.find((edge) => edge.route === "repair")?.traversals,
      ).toBe(1);

      const repairAssignment = service.claim(
        "repair-loop:run",
        "work",
        "worker",
        60,
      ).value;
      expect(
        repairAssignment.context.predecessors.find(
          (predecessor) => predecessor.nodeId === "decide",
        ),
      ).toMatchObject({
        status: "pending",
        attempt: 1,
        route: "repair",
        summary: "Completed decide.",
        evidence: ["evidence:decide"],
      });
      complete(service, "repair-loop:run", "work", "worker");
      service.claim("repair-loop:run", "decide", "reviewer", 60);
      snapshot = complete(
        service,
        "repair-loop:run",
        "decide",
        "reviewer",
        { route: "pass" },
      );

      expect(snapshot.summary.status).toBe("completed");
      expect(snapshot.nodes.find((node) => node.id === "work")?.attempt).toBe(2);
      expect(snapshot.nodes.find((node) => node.id === "decide")?.attempt).toBe(2);
      const attempts = service.database.db
        .query(
          "SELECT node_id, attempt, status, route FROM attempts WHERE run_id = ? ORDER BY node_id, attempt",
        )
        .all("repair-loop:run") as Array<{
        node_id: string;
        attempt: number;
        status: string;
        route: string | null;
      }>;
      expect(attempts).toEqual([
        { node_id: "decide", attempt: 1, status: "done", route: "repair" },
        { node_id: "decide", attempt: 2, status: "done", route: "pass" },
        { node_id: "work", attempt: 1, status: "done", route: null },
        { node_id: "work", attempt: 2, status: "done", route: null },
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("reopens a success branch skipped before an upstream repair loop", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(upstreamBranchLoopGraph());
      service.startRun("upstream-branch-loop", "upstream-branch-loop:run");
      service.claim("upstream-branch-loop:run", "work", "worker", 60);
      complete(
        service,
        "upstream-branch-loop:run",
        "work",
        "worker",
      );
      service.claim(
        "upstream-branch-loop:run",
        "classify",
        "reviewer",
        60,
      );
      let snapshot = complete(
        service,
        "upstream-branch-loop:run",
        "classify",
        "reviewer",
        { route: "fail" },
      );
      expect(status(snapshot, "success")).toBe("skipped");

      service.claim(
        "upstream-branch-loop:run",
        "review",
        "reviewer",
        60,
      );
      snapshot = complete(
        service,
        "upstream-branch-loop:run",
        "review",
        "reviewer",
        { route: "repair" },
      );
      expect(status(snapshot, "work")).toBe("ready");
      expect(status(snapshot, "success")).toBe("pending");

      service.claim("upstream-branch-loop:run", "work", "worker", 60);
      complete(
        service,
        "upstream-branch-loop:run",
        "work",
        "worker",
      );
      service.claim(
        "upstream-branch-loop:run",
        "classify",
        "reviewer",
        60,
      );
      snapshot = complete(
        service,
        "upstream-branch-loop:run",
        "classify",
        "reviewer",
        { route: "pass" },
      );
      expect(status(snapshot, "success")).toBe("ready");
      service.claim(
        "upstream-branch-loop:run",
        "success",
        "worker",
        60,
      );
      snapshot = complete(
        service,
        "upstream-branch-loop:run",
        "success",
        "worker",
      );
      expect(snapshot.summary.status).toBe("completed");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("reports a direct predecessor once when several routes converge", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(convergingRoutesGraph());
      service.startRun("converging-routes", "converging-routes:run");
      service.claim(
        "converging-routes:run",
        "decision",
        "reviewer",
        60,
      );
      complete(
        service,
        "converging-routes:run",
        "decision",
        "reviewer",
        { route: "pass" },
      );
      const successor = service.claim(
        "converging-routes:run",
        "after",
        "worker",
        60,
      ).value;
      expect(successor.context.predecessors).toEqual([
        expect.objectContaining({
          nodeId: "decision",
          route: "pass",
        }),
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("rejects output that violates a node JSON Schema", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(schemaGraph());
      service.startRun("schema-output", "schema-output:run");
      service.claim("schema-output:run", "work", "worker", 60);
      expect(() =>
        complete(service, "schema-output:run", "work", "worker", {
          output: { checks: [42] },
        }),
      ).toThrow(BurnGraphError);
      expect(
        service
          .getSnapshot("schema-output:run")
          .nodes.find((node) => node.id === "work")?.status,
      ).toBe("running");

      const snapshot = complete(
        service,
        "schema-output:run",
        "work",
        "worker",
        { output: { checks: ["typecheck"] } },
      );
      expect(status(snapshot, "decide")).toBe("ready");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("rejects a bounded route past its cap without corrupting the Decision", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(loopGraph("loop-cap"));
      service.startRun("loop-cap", "loop-cap:run");

      for (let traversal = 1; traversal <= 2; traversal += 1) {
        service.claim("loop-cap:run", "work", "worker", 60);
        complete(service, "loop-cap:run", "work", "worker");
        service.claim("loop-cap:run", "decide", "reviewer", 60);
        complete(service, "loop-cap:run", "decide", "reviewer", {
          route: "repair",
        });
        expect(
          service
            .getSnapshot("loop-cap:run")
            .edges.find((edge) => edge.route === "repair")?.traversals,
        ).toBe(traversal);
      }

      service.claim("loop-cap:run", "work", "worker", 60);
      complete(service, "loop-cap:run", "work", "worker");
      service.claim("loop-cap:run", "decide", "reviewer", 60);
      try {
        complete(service, "loop-cap:run", "decide", "reviewer", {
          route: "repair",
        });
        throw new Error("Expected LOOP_LIMIT_REACHED");
      } catch (error) {
        expect(error).toBeInstanceOf(BurnGraphError);
        expect((error as BurnGraphError).code).toBe("LOOP_LIMIT_REACHED");
      }
      let snapshot = service.getSnapshot("loop-cap:run");
      expect(status(snapshot, "decide")).toBe("running");
      expect(
        snapshot.edges.find((edge) => edge.route === "repair")?.traversals,
      ).toBe(2);

      snapshot = complete(
        service,
        "loop-cap:run",
        "decide",
        "reviewer",
        { route: "pass" },
      );
      expect(snapshot.summary.status).toBe("completed");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("persists independent graph state across process-like restarts", () => {
    const root = createTestProject();
    let first = new BurnGraphService(root);
    try {
      first.applyGraph(parallelGraph("graph-one"));
      first.applyGraph(parallelGraph("graph-two"));
      first.startRun("graph-one", "graph-one:run");
      first.startRun("graph-two", "graph-two:run");
      first.claim("graph-one:run", "left", "one-left", 60);
      first.claim("graph-two:run", "right", "two-right", 60);
      first.close();

      const restarted = new BurnGraphService(root);
      first = restarted;
      const one = restarted.getSnapshot("graph-one:run");
      const two = restarted.getSnapshot("graph-two:run");
      expect(status(one, "left")).toBe("running");
      expect(status(one, "right")).toBe("ready");
      expect(status(two, "right")).toBe("running");
      expect(status(two, "left")).toBe("ready");
      restarted.pauseRun("graph-one:run", "pause-graph-one");
      expect(() =>
        restarted.claim("graph-one:run", "right", "one-right", 60),
      ).toThrow(BurnGraphError);
      expect(
        restarted.claim("graph-two:run", "left", "two-left", 60).value.node.id,
      ).toBe("left");
    } finally {
      first.close();
      removeTestProject(root);
    }
  });

  test("reopens an expired claim without erasing its prior Attempt", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      service.applyGraph(parallelGraph());
      service.startRun("parallel", "expiry:run");
      service.claim("expiry:run", "left", "worker", 30);
      now = new Date("2026-01-01T00:00:31.000Z");
      const results = service.reconcileExpired();
      expect(results).toHaveLength(1);
      expect(results[0]?.value.map((node) => node.id)).toEqual(["left"]);
      expect(
        service.getSnapshot("expiry:run").nodes.find((node) => node.id === "left")
          ?.status,
      ).toBe("ready");
      const prior = service.database.db
        .query(
          "SELECT status FROM attempts WHERE run_id = ? AND node_id = ? AND attempt = 1",
        )
        .get("expiry:run", "left") as { status: string };
      expect(prior.status).toBe("expired");
      expect(service.claim("expiry:run", "left", "worker-2", 30).value.node.attempt)
        .toBe(2);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("reconciles expired claims across multiple graphs in one call", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      service.applyGraph(parallelGraph("expiry-one"));
      service.applyGraph(parallelGraph("expiry-two"));
      service.startRun("expiry-one", "expiry-one:run");
      service.startRun("expiry-two", "expiry-two:run");
      service.claim("expiry-one:run", "left", "worker-one", 30);
      service.claim("expiry-two:run", "right", "worker-two", 30);
      now = new Date("2026-01-01T00:00:31.000Z");

      const results = service.reconcileExpired();
      expect(results).toHaveLength(2);
      expect(
        results.flatMap((result) => result.value.map((node) => node.id)).sort(),
      ).toEqual(["left", "right"]);
      expect(
        service.getSnapshot("expiry-one:run").nodes.find((node) => node.id === "left")
          ?.status,
      ).toBe("ready");
      expect(
        service.getSnapshot("expiry-two:run").nodes.find((node) => node.id === "right")
          ?.status,
      ).toBe("ready");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("opportunistic expiry recovery clears the previous actor focus", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      service.applyGraph(parallelGraph());
      service.startRun("parallel", "opportunistic:run");
      service.claim("opportunistic:run", "left", "stale-actor", 30);
      now = new Date("2026-01-01T00:00:31.000Z");

      const recovered = service.claim(
        "opportunistic:run",
        "left",
        "new-actor",
        30,
      );
      expect(recovered.value.node.attempt).toBe(2);
      expect(service.actorWork("stale-actor")).toEqual({
        actorId: "stale-actor",
        focused: null,
        claimed: [],
      });
      expect(recovered.event.payload.recoveredExpiredAttempt).toEqual({
        attempt: 1,
        actorId: "stale-actor",
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("starts with complete Assignments and automatically refills parallel work", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(parallelGraph("guarded-parallel"));
      const started = service.startWithAssignments(
        "guarded-parallel",
        "primary",
        "guarded-parallel:run",
      );

      expect(started.state).toBe("assigned");
      expect(started.assignments.map((assignment) => assignment.node.id).sort())
        .toEqual(["left", "right"]);
      expect(
        started.assignments.every(
          (assignment) =>
            assignment.assignmentId.length > 0 &&
            assignment.returnProtocol.complete.includes(
              `done --assignment ${assignment.assignmentId}`,
            ),
        ),
      ).toBe(true);

      const left = started.assignments.find(
        (assignment) => assignment.node.id === "left",
      )!;
      const afterLeft = service.completeAndContinue(left.assignmentId, {
        summary: "Left complete.",
        evidence: ["left evidence"],
      });
      expect(afterLeft.replayed).toBe(false);
      expect(afterLeft.assignments.map((assignment) => assignment.node.id))
        .toEqual(["right"]);

      const right = afterLeft.assignments[0]!;
      const completed = service.completeAndContinue(right.assignmentId, {
        summary: "Right complete.",
        evidence: ["right evidence"],
      });
      expect(completed.state).toBe("completed");
      expect(completed.assignments).toEqual([]);
      expect(service.getSnapshot("guarded-parallel:run").summary.status).toBe(
        "completed",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("makes Done idempotent and rejects conflicting replay input", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(parallelGraph("idempotent-done"));
      const started = service.startWithAssignments(
        "idempotent-done",
        "primary",
        "idempotent-done:run",
      );
      const assignment = started.assignments.find(
        (candidate) => candidate.node.id === "left",
      )!;
      const input = {
        summary: "Stable completion.",
        evidence: ["stable evidence"],
      };

      service.completeAndContinue(assignment.assignmentId, input);
      const replay = service.completeAndContinue(assignment.assignmentId, input);
      expect(replay.replayed).toBe(true);
      expect(
        service
          .getSnapshot("idempotent-done:run")
          .events.filter(
            (event) =>
              event.type === "node.completed" && event.nodeId === "left",
          ),
      ).toHaveLength(1);

      try {
        service.completeAndContinue(assignment.assignmentId, {
          summary: "Different completion.",
          evidence: [],
        });
        throw new Error("Expected ASSIGNMENT_INPUT_CONFLICT");
      } catch (error) {
        expect(error).toBeInstanceOf(BurnGraphError);
        expect((error as BurnGraphError).code).toBe(
          "ASSIGNMENT_INPUT_CONFLICT",
        );
      }
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("automatically carries Decision repair context into the next Attempt", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(loopGraph("guarded-loop"));
      const started = service.startWithAssignments(
        "guarded-loop",
        "primary",
        "guarded-loop:run",
      );
      const work = started.assignments[0]!;
      const reviewSchedule = service.completeAndContinue(work.assignmentId, {
        summary: "Draft ready.",
        evidence: ["draft evidence"],
      });
      const review = reviewSchedule.assignments[0]!;
      expect(review.node.id).toBe("decide");

      const repairSchedule = service.completeAndContinue(review.assignmentId, {
        summary: "Repair the draft.",
        route: "repair",
        evidence: ["review finding"],
      });
      const repairedWork = repairSchedule.assignments[0]!;
      expect(repairedWork.node.id).toBe("work");
      expect(repairedWork.node.attempt).toBe(2);
      expect(repairedWork.context.predecessors).toContainEqual(
        expect.objectContaining({
          nodeId: "decide",
          attempt: 1,
          route: "repair",
          summary: "Repair the draft.",
          evidence: ["review finding"],
        }),
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("fills one Actor fairly across multiple running Graphs", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(parallelGraph("fair-one"));
      service.applyGraph(parallelGraph("fair-two"));
      service.startWithAssignments("fair-one", "primary", "fair-one:run");
      const second = service.startWithAssignments(
        "fair-two",
        "primary",
        "fair-two:run",
      );

      expect(second.assignments).toHaveLength(4);
      expect(
        second.assignments.reduce<Record<string, number>>(
          (counts, assignment) => ({
            ...counts,
            [assignment.graph.graphId]:
              (counts[assignment.graph.graphId] ?? 0) + 1,
          }),
          {},
        ),
      ).toEqual({ "fair-one": 2, "fair-two": 2 });
      expect(service.config.maxAssignmentsPerActor).toBe(8);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("enforces the Actor cap transactionally and bounds schedule context", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(wideGraph("actor-cap"));
      service.startRun("actor-cap", "actor-cap:run");
      for (let index = 0; index < 8; index += 1) {
        service.claim("actor-cap:run", `task-${index}`, "bounded-actor");
      }
      try {
        service.claim("actor-cap:run", "task-8", "bounded-actor");
        throw new Error("Expected ACTOR_ASSIGNMENT_LIMIT_REACHED");
      } catch (error) {
        expect(error).toBeInstanceOf(BurnGraphError);
        expect((error as BurnGraphError).code).toBe(
          "ACTOR_ASSIGNMENT_LIMIT_REACHED",
        );
      }
    } finally {
      service.close();
      removeTestProject(root);
    }

    const scheduleRoot = createTestProject();
    const scheduleService = new BurnGraphService(scheduleRoot);
    try {
      scheduleService.applyGraph(wideGraph("bounded-schedule", 500));
      const schedule = scheduleService.startWithAssignments(
        "bounded-schedule",
        "bounded-actor",
        "bounded-schedule:run",
      );
      // Bounding is what this test owns, and these four assertions prove it
      // deterministically: 500 ready nodes collapse to 8 assignments and a
      // 32-item sample. The wall-clock budget that used to sit here measured
      // machine load rather than the code — it passed alone and failed inside
      // the full suite — and now lives in scripts/verify/control-performance.ts
      // with repeatable p95 sampling.
      expect(schedule.assignments).toHaveLength(8);
      expect(schedule.remainingReadyCount).toBe(492);
      expect(schedule.remainingReady).toHaveLength(32);
      expect(schedule.activeRunCount).toBe(1);
      expect(schedule.runs).toHaveLength(1);
    } finally {
      scheduleService.close();
      removeTestProject(scheduleRoot);
    }
  });

  test("rejects a stale blocked Assignment when a later Attempt is blocked", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(loopGraph("guarded-unblock"));
      const first = service.startWithAssignments(
        "guarded-unblock",
        "primary",
        "guarded-unblock:run",
      ).assignments[0]!;
      service.blockAssignment(first.assignmentId, "Block Attempt 1.");
      const second = service.unblockAssignment(first.assignmentId)
        .assignments[0]!;
      expect(second.node.attempt).toBe(2);
      service.blockAssignment(second.assignmentId, "Block Attempt 2.");

      try {
        service.unblockAssignment(first.assignmentId);
        throw new Error("Expected ASSIGNMENT_STALE");
      } catch (error) {
        expect(error).toBeInstanceOf(BurnGraphError);
        expect((error as BurnGraphError).code).toBe("ASSIGNMENT_STALE");
      }
      expect(
        service
          .getSnapshot("guarded-unblock:run", 0)
          .nodes.find((node) => node.id === "work"),
      ).toMatchObject({ status: "blocked", attempt: 2 });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("returns the most recent bounded events in snapshots", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(loopGraph("recent-events"));
      const assignment = service.startWithAssignments(
        "recent-events",
        "primary",
        "recent-events:run",
      ).assignments[0]!;
      service.heartbeatAssignment(assignment.assignmentId);
      service.checkpointAssignment(assignment.assignmentId, {
        summary: "Checkpoint.",
        progress: 50,
        artifacts: [],
      });
      const all = service.listEvents("recent-events:run", 0, 100);
      const recent = service.getSnapshot("recent-events:run", 2).events;
      expect(recent.map((event) => event.sequence)).toEqual(
        all.slice(-2).map((event) => event.sequence),
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
