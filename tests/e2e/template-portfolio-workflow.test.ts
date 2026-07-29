import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { GraphSpec } from "@burn-graph/core";

import {
  createTestDirectory,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: any;
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cli = path.join(repositoryRoot, "dist", "burn-graph.js");
const roots: string[] = [];

async function invoke(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<CliResult> {
  const child = Bun.spawn(["bun", cli, "--root", root, ...args], {
    cwd: root,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && child.stdin !== undefined) {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    envelope: JSON.parse((exitCode === 0 ? stdout : stderr).trim()),
  };
}

async function ok(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<any> {
  const result = await invoke(root, args, stdin);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.envelope).toMatchObject({ schemaVersion: 1, ok: true });
  return result.envelope;
}

async function fail(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<any> {
  const result = await invoke(root, args, stdin);
  expect(result.exitCode).toBe(1);
  expect(result.envelope).toMatchObject({ schemaVersion: 1, ok: false });
  return result.envelope;
}

function writeJson(root: string, name: string, value: unknown): string {
  const file = path.join(root, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function templateInput(
  graphId: string,
  key: string,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    idempotencyKey: key,
    graphId,
    goal: `Complete ${graphId} through the public AI loop.`,
    include: [],
    context: {
      mustRead: ["README.md"],
      lockedContracts: ["docs/cli.md"],
      writablePaths: ["packages/example"],
      forbidden: ["Do not change unrelated files."],
      runtime: ["bun run check"],
    },
    promptOverrides: [],
  };
}

function resourceGraph(id: string, resources: readonly string[]): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: `${id} resource workflow`,
    goal: `Complete ${id} without overlapping resource owners.`,
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
        title: "Resource work",
        prompt: prompt(`Complete ${id}.`),
        next: [{ to: "end" }],
        maxAttempts: 2,
        actorHint: null,
        tags: ["portfolio-resource"],
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

function assignment(envelope: any, graphId: string, nodeId: string): any {
  const found = envelope.data.assignments.find(
    (candidate: any) =>
      candidate.graph.graphId === graphId && candidate.node.id === nodeId,
  );
  if (!found) throw new Error(`Missing Assignment ${graphId}/${nodeId}`);
  return found;
}

async function complete(
  root: string,
  packet: any,
  route?: string,
): Promise<any> {
  return ok(
    root,
    ["done", "--assignment", packet.assignmentId, "--input", "-"],
    JSON.stringify({
      summary: `Completed ${packet.graph.graphId}/${packet.node.id}.`,
      evidence: [`evidence/${packet.node.id}.json`],
      ...(route ? { route } : {}),
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("template portfolio public path", () => {
  test("instantiates, replays, schedules, filters, measures, and renders several roots", async () => {
    const root = createTestDirectory();
    roots.push(root);
    await ok(root, ["init"]);

    const catalog = await ok(root, ["template", "list"]);
    expect(catalog.data.count).toBe(6);
    expect(catalog.data.templates.map((item: any) => item.id)).toEqual([
      "delivery",
      "vertical-slice",
      "poc",
      "bugfix",
      "review-repair",
      "release",
    ]);
    expect(
      (await ok(root, ["template", "show", "bugfix"])).data.input.required,
    ).toEqual(["schemaVersion", "graphId", "goal"]);
    expect(
      (
        await ok(root, ["template", "instantiate", "--help"])
      ).data.errors,
    ).toContain("TEMPLATE_STAGE_NOT_SUPPORTED");

    const bugfixInput = writeJson(
      root,
      "bugfix-input.json",
      templateInput("template-bugfix", "template-bugfix-key"),
    );
    const first = await ok(root, [
      "template",
      "instantiate",
      "bugfix",
      "--input",
      bugfixInput,
    ]);
    expect(first.data).toMatchObject({
      replayed: false,
      graphs: [{
        graphId: "template-bugfix",
        revision: 1,
        path: ".burn-graph/graphs/template-bugfix.json",
      }],
    });
    expect(
      existsSync(path.join(root, first.data.graphs[0].path)),
    ).toBe(true);
    const replay = await ok(root, [
      "template",
      "instantiate",
      "bugfix",
      "--input",
      bugfixInput,
    ]);
    expect(replay.data).toEqual({ ...first.data, replayed: true });

    const concurrentInput = writeJson(
      root,
      "concurrent-input.json",
      templateInput("template-concurrent", "template-concurrent-key"),
    );
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        invoke(root, [
          "template",
          "instantiate",
          "vertical-slice",
          "--input",
          concurrentInput,
        ])
      ),
    );
    expect(concurrent.map((result) => result.exitCode)).toEqual(
      Array.from({ length: 8 }, () => 0),
    );
    expect(
      concurrent.filter((result) => result.envelope.data.replayed === false),
    ).toHaveLength(1);
    expect(
      concurrent.filter((result) => result.envelope.data.replayed === true),
    ).toHaveLength(7);
    expect(
      existsSync(
        path.join(root, ".burn-graph", "graphs", "template-concurrent.json"),
      ),
    ).toBe(true);

    const unsupportedInput = writeJson(root, "unsupported-input.json", {
      ...templateInput("template-unsupported", "template-unsupported-key"),
      include: ["security"],
    });
    const unsupported = await fail(root, [
      "template",
      "instantiate",
      "poc",
      "--input",
      unsupportedInput,
    ]);
    expect(unsupported.error.code).toBe("TEMPLATE_STAGE_NOT_SUPPORTED");
    expect(
      existsSync(
        path.join(root, ".burn-graph", "graphs", "template-unsupported.json"),
      ),
    ).toBe(false);

    const invalidInput = writeJson(root, "invalid-input.json", {
      ...templateInput("template-invalid", "template-invalid-key"),
      context: { mustRead: ["../private.md"] },
    });
    await fail(root, [
      "template",
      "instantiate",
      "poc",
      "--input",
      invalidInput,
    ]);
    expect(
      existsSync(
        path.join(root, ".burn-graph", "graphs", "template-invalid.json"),
      ),
    ).toBe(false);

    const pocInput = writeJson(
      root,
      "poc-input.json",
      templateInput("template-poc", "template-poc-key"),
    );
    await ok(root, [
      "template",
      "instantiate",
      "poc",
      "--input",
      pocInput,
    ]);
    const bugfixStart = await ok(root, [
      "run",
      "start",
      "template-bugfix",
      "--actor",
      "portfolio-ai",
      "--run-id",
      "template-bugfix:run",
    ]);
    const pocStart = await ok(root, [
      "run",
      "start",
      "template-poc",
      "--actor",
      "portfolio-ai",
      "--run-id",
      "template-poc:run",
    ]);
    await ok(root, [
      "run",
      "priority",
      "template-bugfix:run",
      "--value",
      "high",
      "--idempotency-key",
      "bugfix-priority",
    ]);
    await ok(root, [
      "run",
      "priority",
      "template-poc:run",
      "--value",
      "low",
      "--idempotency-key",
      "poc-priority",
    ]);

    let bugfix = assignment(bugfixStart, "template-bugfix", "reproduce");
    let poc = assignment(pocStart, "template-poc", "frame");
    let next = await complete(root, bugfix);
    bugfix = assignment(next, "template-bugfix", "repair");
    next = await complete(root, poc);
    poc = assignment(next, "template-poc", "experiment");
    next = await complete(root, bugfix);
    bugfix = assignment(next, "template-bugfix", "regression");
    next = await complete(root, poc);
    poc = assignment(next, "template-poc", "verify");
    next = await complete(root, bugfix);
    bugfix = assignment(next, "template-bugfix", "review");
    next = await complete(root, poc);
    poc = assignment(next, "template-poc", "review");
    await complete(root, bugfix, "pass");
    await complete(root, poc, "pass");

    expect(
      (await ok(root, ["inspect", "run", "template-bugfix:run"])).data.summary
        .status,
    ).toBe("completed");
    expect(
      (await ok(root, ["inspect", "run", "template-poc:run"])).data.summary
        .status,
    ).toBe("completed");

    for (const id of ["resource-a", "resource-b", "resource-free"]) {
      const file = writeJson(
        root,
        `${id}.json`,
        resourceGraph(id, id === "resource-free" ? [] : ["shared-build"]),
      );
      await ok(root, ["graph", "apply", "--input", file]);
    }
    const locked = await ok(root, [
      "run",
      "start",
      "resource-a",
      "--actor",
      "portfolio-ai",
      "--run-id",
      "resource-a:run",
    ]);
    const contended = await ok(root, [
      "run",
      "start",
      "resource-b",
      "--actor",
      "portfolio-ai",
      "--run-id",
      "resource-b:run",
    ]);
    const unrelated = await ok(root, [
      "run",
      "start",
      "resource-free",
      "--actor",
      "portfolio-ai",
      "--run-id",
      "resource-free:run",
    ]);
    expect(
      contended.data.assignments.some(
        (item: any) => item.graph.graphId === "resource-b",
      ),
    ).toBe(false);
    const resourceView = await ok(root, [
      "inspect",
      "overview",
      "--resource",
      "shared-build",
      "--node-status",
      "ready,running",
      "--limit",
      "10",
    ]);
    expect(resourceView.data.totals).toMatchObject({
      matchingRuns: 2,
      matchingNodes: 2,
      listedNodes: 2,
    });
    expect(
      resourceView.data.nodes.find(
        (node: any) => node.runId === "resource-b:run",
      ).eligibility,
    ).toEqual({
      eligible: false,
      reason: "RESOURCE_BUSY",
      blockedResources: ["shared-build"],
    });
    expect((await ok(root, ["inspect", "resources"])).data).toHaveLength(1);

    next = await complete(root, assignment(locked, "resource-a", "work"));
    const secondResource = assignment(next, "resource-b", "work");
    expect(
      (await ok(root, ["inspect", "resources"])).data[0],
    ).toMatchObject({
      resource: "shared-build",
      runId: "resource-b:run",
      ownerKind: "assignment",
    });
    await complete(
      root,
      assignment(unrelated, "resource-free", "work"),
    );
    await complete(root, secondResource);

    const beforeMetrics = await ok(root, [
      "inspect",
      "run",
      "template-bugfix:run",
    ]);
    const metrics = await ok(root, ["inspect", "metrics"]);
    expect(metrics.data).toMatchObject({
      scope: { runCount: 5, rootCount: 5 },
      assignments: { current: 0, maximumLive: 2 },
      resources: { activeLocks: 0, contendedReadyNodes: 0 },
      excludedPrivateFields: [
        "prompts",
        "results",
        "checkOutput",
        "environment",
      ],
    });
    const afterMetrics = await ok(root, [
      "inspect",
      "run",
      "template-bugfix:run",
    ]);
    expect(afterMetrics.data.summary.runtimeRevision).toBe(
      beforeMetrics.data.summary.runtimeRevision,
    );
    expect(afterMetrics.data.events).toEqual(beforeMetrics.data.events);

    const bounded = await ok(root, [
      "inspect",
      "overview",
      "--priority",
      "high",
      "--node-status",
      "done",
      "--limit",
      "1",
    ]);
    expect(bounded.data.truncated).toEqual({ runs: false, nodes: true });
    expect(bounded.data.totals).toMatchObject({
      matchingRuns: 1,
      listedRuns: 1,
      listedNodes: 1,
    });

    const svg = await ok(root, [
      "render",
      "template-bugfix:run",
      "--scope",
      "tree",
      "--format",
      "svg",
    ]);
    const png = await ok(root, [
      "render",
      "template-bugfix:run",
      "--scope",
      "tree",
      "--format",
      "png",
    ]);
    expect(svg.data.projection).toMatchObject({
      totalRuns: 1,
      renderedNodes: 6,
    });
    expect(png.data.projection).toMatchObject({
      depth: svg.data.projection.depth,
      maximumDepth: svg.data.projection.maximumDepth,
      limit: svg.data.projection.limit,
      totalRuns: svg.data.projection.totalRuns,
      expandedRuns: svg.data.projection.expandedRuns,
      foldedRuns: svg.data.projection.foldedRuns,
      renderedNodes: svg.data.projection.renderedNodes,
      lastEventSequence: svg.data.projection.lastEventSequence,
    });
    expect(existsSync(path.resolve(root, svg.data.artifact))).toBe(true);
    expect(existsSync(path.resolve(root, png.data.artifact))).toBe(true);
  }, 45_000);
});
