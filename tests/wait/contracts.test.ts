import { describe, expect, test } from "bun:test";

import {
  BurnGraphError,
  BurnGraphService,
  type GraphSpec,
  type SignalResolutionInput,
} from "@burn-graph/core";

import {
  createTestProject,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

function waitGraph(id = "wait-contract", timeoutMs = 60_000): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: "Wait contract",
    goal: "Wait durably without consuming AI capacity.",
    revision: 1,
    maxActive: 2,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "wait" }, { to: "unrelated" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "wait",
        type: "wait",
        title: "External approval",
        prompt: prompt(""),
        next: [
          { to: "after", route: "approved" },
          { to: "after", route: "rejected" },
          { to: "after", route: "timeout" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
        signal: {
          routes: ["approved", "rejected"],
          timeout: { afterMs: timeoutMs, route: "timeout" },
        },
      },
      {
        id: "unrelated",
        type: "task",
        title: "Unrelated",
        prompt: prompt("Complete unrelated work."),
        next: [{ to: "join" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
        resources: [],
      },
      {
        id: "after",
        type: "task",
        title: "After Signal",
        prompt: prompt("Use the bounded Signal predecessor context."),
        next: [{ to: "join" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
        resources: [],
      },
      {
        id: "join",
        type: "join",
        title: "Join",
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

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe(code);
  }
}

describe("durable Wait contract", () => {
  test("survives restart, uses no Assignment, and leaves unrelated work schedulable", () => {
    const root = createTestProject();
    let signalId = "";
    {
      const service = new BurnGraphService(root);
      try {
        service.applyGraph(waitGraph());
        service.startRun("wait-contract", "wait-contract-r1");
        service.advanceSystemNodes("wait-contract-r1");
        const [signal] = service.listWaitSignals("wait-contract-r1");
        signalId = signal!.signalId;
        expect(signal).toMatchObject({
          runId: "wait-contract-r1",
          nodeId: "wait",
          status: "waiting",
        });
        expect(service.getSnapshot("wait-contract-r1", 0).nodes[1]).toMatchObject({
          status: "waiting",
          assignmentId: null,
          actorId: null,
        });
        expect(service.schedule("wait-ai", "wait-contract-r1").assignments).toHaveLength(1);
      } finally {
        service.close();
      }
    }

    const reopened = new BurnGraphService(root);
    try {
      expect(reopened.listWaitSignals("wait-contract-r1")[0]?.signalId).toBe(signalId);
      expect(reopened.assignmentsForActor("wait-ai")).toHaveLength(1);
    } finally {
      reopened.close();
      removeTestProject(root);
    }
  });

  test("settles once and rejects conflicting or stale resolution", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(waitGraph("wait-resolution"));
      service.startRun("wait-resolution", "wait-resolution-r1");
      service.advanceSystemNodes("wait-resolution-r1");
      const [signal] = service.listWaitSignals("wait-resolution-r1");
      const input: SignalResolutionInput = {
        summary: "Synthetic approval accepted.",
        evidence: ["tests/fixtures/approval.json"],
      };
      const first = service.resolveSignal(
        signal!.signalId,
        "approved",
        input,
        "resolve-1",
      );
      const replay = service.resolveSignal(
        signal!.signalId,
        "approved",
        input,
        "resolve-1",
      );
      expect(replay.replayed).toBe(true);
      expect(replay.revision).toBe(first.revision);
      expectCode(
        () =>
          service.resolveSignal(
            signal!.signalId,
            "rejected",
            { ...input, summary: "Conflicting rejection." },
            "resolve-1",
          ),
        "SIGNAL_INPUT_CONFLICT",
      );
      expectCode(
        () =>
          service.resolveSignal(
            "missing-signal",
            "approved",
            input,
            "resolve-missing",
          ),
        "SIGNAL_NOT_FOUND",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("read-only overdue inspection is inert until explicit reconciliation", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      service.applyGraph(waitGraph("wait-timeout", 1_000));
      service.startRun("wait-timeout", "wait-timeout-r1");
      service.advanceSystemNodes("wait-timeout-r1");
      const before = service.getSnapshot("wait-timeout-r1", 0);
      now = new Date("2026-01-01T00:00:02.000Z");
      const observed = service.getSnapshot("wait-timeout-r1", 0);
      expect(observed.summary.runtimeRevision).toBe(before.summary.runtimeRevision);
      expect(observed.nodes[1]).toMatchObject({ status: "waiting", route: null });
      expect(service.listWaitSignals("wait-timeout-r1")[0]?.overdue).toBe(true);

      service.reconcileSystemNodes("wait-timeout-r1");
      const settled = service.getSnapshot("wait-timeout-r1", 0);
      expect(settled.nodes[1]).toMatchObject({
        status: "done",
        route: "timeout",
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("freezes deadlines across pause and makes cancelled Signals stale", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      service.applyGraph(waitGraph("wait-lifecycle", 1_000));
      service.startRun("wait-lifecycle", "wait-lifecycle-r1");
      service.advanceSystemNodes("wait-lifecycle-r1");
      const signalId =
        service.listWaitSignals("wait-lifecycle-r1")[0]!.signalId;

      now = new Date("2026-01-01T00:00:00.500Z");
      service.pauseRun("wait-lifecycle-r1", "wait-pause-1");
      now = new Date("2026-01-01T00:00:02.500Z");
      expect(service.listWaitSignals("wait-lifecycle-r1")[0]?.overdue).toBe(
        false,
      );
      service.resumeRun("wait-lifecycle-r1", "wait-resume-1");
      expect(
        service.listWaitSignals("wait-lifecycle-r1")[0]?.deadlineAt,
      ).toBe("2026-01-01T00:00:03.000Z");
      service.reconcileSystemNodes("wait-lifecycle-r1");
      expect(service.getSnapshot("wait-lifecycle-r1", 0).nodes[1]).toMatchObject({
        status: "waiting",
        route: null,
      });

      service.cancelRun("wait-lifecycle-r1", "wait-cancel-1");
      expectCode(
        () =>
          service.resolveSignal(
            signalId,
            "approved",
            { summary: "Too late.", evidence: [] },
            "wait-stale-1",
          ),
        "SIGNAL_STALE",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
