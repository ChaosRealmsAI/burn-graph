import { describe, expect, test } from "bun:test";

import {
  BurnGraphError,
  BurnGraphService,
  type CheckSpec,
  type GateExecutionResult,
  type GraphSpec,
} from "@burn-graph/core";

import {
  createTestProject,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

function validCheck(overrides: Partial<CheckSpec> = {}): CheckSpec {
  return {
    schemaVersion: 1,
    id: "fixture-check",
    revision: 1,
    title: "Fixture Check",
    argv: ["bun", "--version"],
    cwd: ".",
    successExitCodes: [0],
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    inheritEnv: ["PATH"],
    resources: [],
    ...overrides,
  };
}

function gateGraph(checkId = "fixture-check", revision = 1): GraphSpec {
  return {
    schemaVersion: 2,
    id: "gate-contract",
    title: "Gate contract",
    goal: "Route only pinned machine evidence.",
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
          { to: "repair", route: "fail" },
        ],
        maxAttempts: 2,
        actorHint: null,
        tags: [],
        check: { id: checkId, revision },
        resources: [],
      },
      {
        id: "repair",
        type: "task",
        title: "Repair",
        prompt: prompt("Repair the failed evidence."),
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

describe("CheckSpec and Gate contracts", () => {
  test("rejects shell, unsafe cwd, secret environment, and excessive output", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      for (const candidate of [
        validCheck({ id: "shell", argv: ["sh", "-c", "exit 0"] }),
        validCheck({ id: "cwd", cwd: "../outside" }),
        validCheck({
          id: "secret-env",
          inheritEnv: [
            "AWS_SECRET_ACCESS_KEY",
          ] as unknown as CheckSpec["inheritEnv"],
        }),
        validCheck({ id: "output", maxOutputBytes: 2 * 1024 * 1024 }),
      ]) {
        expectCode(() => service.applyCheck(candidate), "INVALID_CHECK");
      }
      expect(service.listChecks()).toEqual([]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("pins an existing immutable Check before Graph mutation", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      expectCode(() => service.applyGraph(gateGraph("missing", 7)), "CHECK_NOT_FOUND");
      expect(service.listGraphs()).toEqual([]);
      expect(service.applyCheck(validCheck())).toMatchObject({
        id: "fixture-check",
        revision: 1,
      });
      service.applyGraph(gateGraph());
      expectCode(() => service.applyCheck(validCheck()), "STALE_CHECK_REVISION");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("claims once, rejects stale output, and exposes only bounded evidence", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyCheck(validCheck());
      service.applyGraph(gateGraph());
      service.startRun("gate-contract", "gate-contract-r1");
      const first = service.advanceSystemNodes("gate-contract-r1");
      const claim = first.value;
      expect(claim).not.toBeNull();
      expect(service.advanceSystemNodes("gate-contract-r1").value).toBeNull();

      const failed: GateExecutionResult = {
        classification: "non_success",
        exitCode: 1,
        durationMs: 12,
        byteCount: 3,
        digest: "a".repeat(64),
        stdout: "bad",
        stderr: "",
      };
      const reported = service.reportGateExecution(claim!.executionId, failed);
      expect(reported.value.nodes.find((node) => node.id === "repair")).toMatchObject({
        status: "ready",
      });
      expect(reported.event.payload).toMatchObject({
        classification: "non_success",
        durationMs: 12,
        byteCount: 3,
        digest: "a".repeat(64),
      });
      expect(JSON.stringify(reported.event)).not.toContain("bad");
      expectCode(
        () => service.reportGateExecution(claim!.executionId, failed),
        "CHECK_EXECUTION_STALE",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("retains a cancelled Gate resource until exact exit is reported", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyCheck(validCheck({ resources: ["gate-lock"] }));
      service.applyGraph(gateGraph());
      service.startRun("gate-contract", "gate-cancel-r1");
      const claim = service.advanceSystemNodes("gate-cancel-r1").value!;
      expect(service.listResourceLocks("gate-cancel-r1")).toHaveLength(1);

      const cancelled = service.cancelRun(
        "gate-cancel-r1",
        "gate-cancel-request",
      );
      expect(cancelled.value.summary.status).toBe("cancelling");
      expect(service.listResourceLocks("gate-cancel-r1")).toHaveLength(1);
      expect(service.listCheckExecutions("gate-cancel-r1")[0]?.status).toBe(
        "stale",
      );

      expectCode(
        () =>
          service.reportGateExecution(claim.executionId, {
            classification: "success",
            exitCode: 0,
            durationMs: 10,
            byteCount: 0,
            digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            stdout: "",
            stderr: "",
          }),
        "CHECK_EXECUTION_STALE",
      );
      expect(service.listResourceLocks("gate-cancel-r1")).toEqual([]);
      expect(service.getSnapshot("gate-cancel-r1", 0).summary.status).toBe(
        "cancelled",
      );
      expect(service.getSnapshot("gate-cancel-r1", 0).nodes[1]).toMatchObject({
        status: "cancelled",
        route: null,
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("does not retry an interrupted Gate before its execution lease", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      service.applyCheck(validCheck({ timeoutMs: 1_000 }));
      service.applyGraph(gateGraph());
      service.startRun("gate-contract", "gate-recovery-r1");
      const first = service.advanceSystemNodes("gate-recovery-r1").value!;

      now = new Date("2026-01-01T00:00:30.999Z");
      expect(service.reconcileSystemNodes("gate-recovery-r1").changes).toEqual(
        [],
      );
      expect(service.advanceSystemNodes("gate-recovery-r1").value).toBeNull();

      now = new Date("2026-01-01T00:00:31.001Z");
      expect(
        service.reconcileSystemNodes("gate-recovery-r1").changes,
      ).toHaveLength(1);
      const second = service.advanceSystemNodes("gate-recovery-r1").value!;
      expect(second.executionId).not.toBe(first.executionId);
      expect(second.attempt).toBe(2);
      expectCode(
        () =>
          service.reportGateExecution(first.executionId, {
            classification: "success",
            exitCode: 0,
            durationMs: 10,
            byteCount: 0,
            digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            stdout: "",
            stderr: "",
          }),
        "CHECK_EXECUTION_STALE",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
