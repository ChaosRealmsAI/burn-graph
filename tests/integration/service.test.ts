import { describe, expect, test } from "bun:test";

import {
  BurnGraphError,
  BurnGraphService,
  type GraphSnapshot,
} from "@burn-graph/core";

import {
  createTestProject,
  loopGraph,
  parallelGraph,
  removeTestProject,
  schemaGraph,
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
      restarted.pauseRun("graph-one:run");
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
});
