// Purpose: Guard bounded scheduler and overview latency across a large root portfolio.
// Usage: bun scripts/verify/portfolio-performance.ts
// Notes: Setup is excluded; thresholds are local regression limits, not benchmarks.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BurnGraphService,
  initializeProject,
  type GraphSpec,
} from "@burn-graph/core";

const ROOT_COUNT = 128;
const SAMPLE_COUNT = 5;
const INSPECT_P95_BUDGET_MS = 1_000;
const SCHEDULE_P95_BUDGET_MS = 1_000;
const OUTPUT_BUDGET_BYTES = 256 * 1024;

function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

function graph(id: string): GraphSpec {
  const emptyPrompt = {
    objective: "",
    instructions: [],
    mustRead: [],
    doneWhen: [],
    outputSchema: null,
    role: "",
    lockedContracts: [],
    writablePaths: [],
    forbidden: [],
    runtime: [],
  };
  return {
    schemaVersion: 2,
    id,
    title: `${id} portfolio fixture`,
    goal: `Schedule ${id}.`,
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: emptyPrompt,
        next: [{ to: "work" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "work",
        type: "task",
        title: "Work",
        prompt: {
          ...emptyPrompt,
          objective: `Complete ${id}.`,
        },
        next: [{ to: "end" }],
        maxAttempts: 2,
        actorHint: null,
        tags: ["portfolio-performance"],
        resources: [],
      },
      {
        id: "end",
        type: "end",
        title: "End",
        prompt: emptyPrompt,
        next: [],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
    ],
  };
}

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), "burn-graph-portfolio-performance-"),
);
initializeProject(temporaryRoot, "2026-01-01T00:00:00.000Z");
const service = new BurnGraphService(temporaryRoot, {
  now: () => new Date("2026-01-01T00:10:01.000Z"),
});

try {
  for (let index = 0; index < ROOT_COUNT; index += 1) {
    const id = `portfolio-${String(index).padStart(3, "0")}`;
    service.applyGraph(graph(id));
    service.startRun(id, `${id}:run`);
    service.setRunPriority(
      `${id}:run`,
      index % 3 === 0 ? "high" : index % 3 === 1 ? "normal" : "low",
      `${id}-priority`,
    );
  }

  const inspectSamples: number[] = [];
  let encodedBytes = 0;
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const started = performance.now();
    const overview = service.inspectOverview({
      nodeStatuses: ["ready", "running"],
      tag: "portfolio-performance",
      limit: 50,
    });
    inspectSamples.push(performance.now() - started);
    encodedBytes = Math.max(
      encodedBytes,
      Buffer.byteLength(JSON.stringify(overview)),
    );
    if (!overview.truncated.runs || !overview.truncated.nodes) {
      throw new Error("Portfolio fixture did not prove explicit truncation");
    }
  }

  const scheduleSamples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const started = performance.now();
    const schedule = service.schedule(`portfolio-perf-${index}`);
    scheduleSamples.push(performance.now() - started);
    if (schedule.assignments.length !== 8) {
      throw new Error(
        `Expected eight bounded Assignments, got ${schedule.assignments.length}`,
      );
    }
  }

  const inspectP95Ms = Math.round(percentile95(inspectSamples) * 100) / 100;
  const scheduleP95Ms = Math.round(percentile95(scheduleSamples) * 100) / 100;
  if (inspectP95Ms > INSPECT_P95_BUDGET_MS) {
    throw new Error(
      `Overview p95 ${inspectP95Ms}ms exceeds ${INSPECT_P95_BUDGET_MS}ms`,
    );
  }
  if (scheduleP95Ms > SCHEDULE_P95_BUDGET_MS) {
    throw new Error(
      `Scheduler p95 ${scheduleP95Ms}ms exceeds ${SCHEDULE_P95_BUDGET_MS}ms`,
    );
  }
  if (encodedBytes > OUTPUT_BUDGET_BYTES) {
    throw new Error(
      `Overview ${encodedBytes} bytes exceeds ${OUTPUT_BUDGET_BYTES} bytes`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      roots: ROOT_COUNT,
      samples: SAMPLE_COUNT,
      inspectP95Ms,
      scheduleP95Ms,
      maximumOverviewBytes: encodedBytes,
      budgets: {
        inspectP95Ms: INSPECT_P95_BUDGET_MS,
        scheduleP95Ms: SCHEDULE_P95_BUDGET_MS,
        overviewBytes: OUTPUT_BUDGET_BYTES,
      },
    })}\n`,
  );
} finally {
  service.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
}
