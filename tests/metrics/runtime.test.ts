import { describe, expect, test } from "bun:test";

import {
  BurnGraphService,
  type CheckSpec,
  type GraphSpec,
} from "@burn-graph/core";

import {
  createTestProject,
  loopGraph,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

function resourceGraph(id: string, privatePrompt: string): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: `${id} metrics fixture`,
    goal: "Expose only bounded operational facts.",
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
        title: "Contended work",
        prompt: prompt(privatePrompt),
        next: [{ to: "end" }],
        maxAttempts: 3,
        actorHint: null,
        tags: ["metrics"],
        resources: ["metrics-exclusive"],
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

function gateResourceGraph(id: string, checkId: string): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: `${id} Gate resource fixture`,
    goal: "Expose blocked Gate resources without running the Check.",
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
        title: "Contended Gate",
        prompt: prompt(""),
        next: [
          { to: "end", route: "pass" },
          { to: "end", route: "fail" },
        ],
        maxAttempts: 2,
        actorHint: null,
        tags: ["metrics-gate"],
        check: { id: checkId, revision: 1 },
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

function durableState(service: BurnGraphService): unknown {
  return {
    runs: service.database.db
      .query(
        `SELECT run_id, status, runtime_revision, updated_at
           FROM runs ORDER BY run_id`,
      )
      .all(),
    nodes: service.database.db
      .query(
        `SELECT run_id, node_id, status, attempt, assignment_id, updated_at
           FROM node_runs ORDER BY run_id, node_id`,
      )
      .all(),
    eventCount: service.database.db
      .query("SELECT COUNT(*) AS count FROM events")
      .get(),
  };
}

describe("event-derived runtime metrics", () => {
  test("counts bounded repair traversals independently from lease recovery", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    try {
      service.applyGraph(loopGraph("metrics-repair"));
      service.startRun("metrics-repair", "metrics-repair-run");
      service.claim("metrics-repair-run", "work", "repair-actor", 30);
      service.complete("metrics-repair-run", "work", "repair-actor", {
        summary: "First implementation complete.",
      });
      service.claim("metrics-repair-run", "decide", "repair-actor", 30);
      service.complete("metrics-repair-run", "decide", "repair-actor", {
        summary: "External evidence requires one repair.",
        route: "repair",
      });

      expect(service.inspectMetrics().totals).toMatchObject({
        repairs: 1,
        leaseRecoveries: 0,
      });

      service.claim("metrics-repair-run", "work", "repair-actor", 30);
      now = new Date("2026-01-01T00:00:31.000Z");
      service.reconcileExpired();
      expect(service.inspectMetrics().totals).toMatchObject({
        repairs: 1,
        leaseRecoveries: 1,
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("shows ready Gate contention from registered Check resources", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    const check: CheckSpec = {
      schemaVersion: 1,
      id: "metrics-gate-check",
      revision: 1,
      title: "Metrics Gate Check",
      argv: ["bun", "--version"],
      cwd: ".",
      successExitCodes: [0],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      inheritEnv: ["PATH"],
      resources: ["metrics-exclusive"],
    };
    try {
      service.applyGraph(resourceGraph("metrics-holder", "private-holder"));
      service.applyCheck(check);
      service.applyGraph(
        gateResourceGraph("metrics-gate", "metrics-gate-check"),
      );
      service.startRun("metrics-holder", "metrics-holder-run");
      service.claim(
        "metrics-holder-run",
        "work",
        "metrics-holder-actor",
        60,
      );
      service.startRun("metrics-gate", "metrics-gate-run");

      const overview = service.inspectOverview({
        nodeStatuses: ["ready"],
        resource: "metrics-exclusive",
        limit: 10,
      });
      expect(overview.nodes).toHaveLength(1);
      expect(overview.nodes[0]).toMatchObject({
        runId: "metrics-gate-run",
        nodeId: "gate",
        type: "gate",
        resources: ["metrics-exclusive"],
        eligibility: {
          eligible: false,
          reason: "RESOURCE_BUSY",
          blockedResources: ["metrics-exclusive"],
        },
      });
      expect(service.inspectMetrics().resources).toMatchObject({
        activeLocks: 1,
        contendedReadyNodes: 1,
        contendedResources: 1,
      });

      service.complete(
        "metrics-holder-run",
        "work",
        "metrics-holder-actor",
        { summary: "Released the shared resource." },
      );
      expect(
        service.inspectOverview({
          nodeStatuses: ["ready"],
          resource: "metrics-exclusive",
          limit: 10,
        }).nodes[0]?.eligibility,
      ).toEqual({
        eligible: true,
        reason: null,
        blockedResources: [],
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("reports concurrency, contention, and recovery without private text or mutation", () => {
    const root = createTestProject();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new BurnGraphService(root, { now: () => now });
    const privatePrompt = "PROMPT_PRIVATE_7f9b";
    const privateResult = "RESULT_PRIVATE_2a6c";
    try {
      service.applyGraph(resourceGraph("metrics-a", privatePrompt));
      service.applyGraph(resourceGraph("metrics-b", privatePrompt));
      service.startRun("metrics-a", "metrics-a-run");
      service.startRun("metrics-b", "metrics-b-run");
      const first = service.claim("metrics-a-run", "work", "metrics-actor", 30);

      const live = service.inspectMetrics();
      expect(live).toMatchObject({
        scope: { runId: null, runCount: 2, rootCount: 2 },
        totals: { nodes: 6, attempts: 1, repairs: 0, leaseRecoveries: 0 },
        assignments: { current: 1, maximumLive: 1 },
        resources: {
          activeLocks: 1,
          contendedReadyNodes: 1,
          contendedResources: 1,
        },
      });
      expect(service.inspectMetrics("metrics-a-run").scope).toEqual({
        runId: "metrics-a-run",
        runCount: 1,
        rootCount: 1,
      });

      now = new Date("2026-01-01T00:00:10.000Z");
      service.complete("metrics-a-run", "work", "metrics-actor", {
        summary: privateResult,
      });
      const second = service.claim(
        "metrics-b-run",
        "work",
        "metrics-actor",
        30,
      );
      expect(second.value.assignmentId).not.toBe(first.value.assignmentId);
      now = new Date("2026-01-01T00:00:41.000Z");
      service.reconcileExpired();

      const beforeRead = durableState(service);
      const metrics = service.inspectMetrics();
      const snapshotMetrics = service.projectSnapshot().metrics;
      const afterRead = durableState(service);

      expect(metrics).toEqual(snapshotMetrics);
      expect(metrics).toMatchObject({
        totals: { attempts: 2, repairs: 0, leaseRecoveries: 1 },
        assignments: { current: 0, maximumLive: 1 },
        resources: {
          activeLocks: 0,
          contendedReadyNodes: 0,
          contendedResources: 0,
        },
        excludedPrivateFields: [
          "prompts",
          "results",
          "checkOutput",
          "environment",
        ],
        unknownFields: [],
      });
      expect(afterRead).toEqual(beforeRead);
      const encoded = JSON.stringify(metrics);
      expect(encoded).not.toContain(privatePrompt);
      expect(encoded).not.toContain(privateResult);
      expect(encoded).not.toContain("result_json");
      expect(encoded).not.toContain("document_json");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("returns one bounded read snapshot across root, resource, priority, and depth filters", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(resourceGraph("overview-a", "private-a"));
      service.applyGraph(resourceGraph("overview-b", "private-b"));
      service.startRun("overview-a", "overview-a-run");
      service.startRun("overview-b", "overview-b-run");
      service.setRunPriority("overview-a-run", "high", "overview-a-high");
      service.claim("overview-a-run", "work", "overview-actor", 60);

      const before = durableState(service);
      const bounded = service.inspectOverview({
        nodeStatuses: ["ready", "running"],
        resource: "metrics-exclusive",
        limit: 1,
      });
      expect(bounded).toMatchObject({
        filters: {
          resource: "metrics-exclusive",
          limit: 1,
        },
        totals: {
          matchingRuns: 2,
          listedRuns: 1,
          matchingNodes: 2,
          listedNodes: 1,
        },
        truncated: { runs: true, nodes: true },
      });

      const selected = service.inspectOverview({
        root: "overview-a-run",
        nodeStatuses: ["running"],
        actor: "overview-actor",
        resource: "metrics-exclusive",
        priority: "high",
        depth: 0,
        limit: 10,
      });
      expect(selected.totals).toMatchObject({
        matchingRuns: 1,
        listedRuns: 1,
        matchingNodes: 1,
        listedNodes: 1,
      });
      expect(selected.nodes[0]).toMatchObject({
        runId: "overview-a-run",
        rootRunId: "overview-a-run",
        priority: "high",
        status: "running",
        actorId: "overview-actor",
        tags: ["metrics"],
        resources: ["metrics-exclusive"],
      });
      expect(selected.metrics.scope.runId).toBe("overview-a-run");
      expect(durableState(service)).toEqual(before);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
