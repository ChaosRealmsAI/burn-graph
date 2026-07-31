import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import packageMetadata from "../../package.json";
import { confinedInputArgs } from "../helpers/cli.ts";
import {
  createTestDirectory,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: any;
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const archiveFile = path.join(
  repositoryRoot,
  "dist",
  "releases",
  `burn-graph-${packageMetadata.version}.tgz`,
);
const roots: string[] = [];

async function command(
  executable: string,
  cwd: string,
  args: readonly string[],
  stdin?: string,
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
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
  const serialized = (exitCode === 0 ? stdout : stderr).trim();
  return {
    exitCode,
    stdout,
    stderr,
    envelope: serialized.length > 0 ? JSON.parse(serialized) : null,
  };
}

async function invoke(
  executable: string,
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<any> {
  const result = await command(
    executable,
    root,
    ["--root", root, ...confinedInputArgs(root, args)],
    stdin,
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.envelope).toMatchObject({
    schemaVersion: 1,
    ok: true,
  });
  return result.envelope;
}

function writeJson(root: string, name: string, value: unknown): string {
  const file = path.join(root, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function assignment(
  envelope: any,
  runId: string,
  nodeId: string,
): any {
  const found = envelope.data.assignments.find(
    (candidate: any) =>
      candidate.graph.runId === runId && candidate.node.id === nodeId,
  );
  if (!found) throw new Error(`Missing Assignment ${runId}/${nodeId}`);
  return found;
}

function parentGraph() {
  return {
    schemaVersion: 2,
    id: "rc1-parent",
    title: "rc.1 recovery parent",
    goal: "Converge the recovery and resource children.",
    revision: 1,
    maxActive: 3,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "children" }],
        maxAttempts: 1,
        actorHint: null,
        tags: ["rc1"],
      },
      {
        id: "children",
        type: "subgraph",
        title: "Plan exact child Runs",
        prompt: prompt("Return the exact recovery and resource child Runs."),
        next: [
          { to: "review", route: "success" },
          { to: "review", route: "failure" },
          { to: "review", route: "cancelled" },
        ],
        maxAttempts: 1,
        actorHint: "rc1-parent",
        tags: ["rc1", "hierarchy"],
        mode: "dynamic",
        minChildren: 2,
        maxChildren: 2,
        resources: [],
      },
      {
        id: "review",
        type: "task",
        title: "Review converged children",
        prompt: prompt("Verify both child Runs completed exactly once."),
        next: [{ to: "end" }],
        maxAttempts: 1,
        actorHint: "rc1-parent",
        tags: ["rc1", "review"],
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
        tags: ["rc1"],
      },
    ],
  };
}

function recoveryGraph() {
  return {
    schemaVersion: 2,
    id: "rc1-recovery",
    title: "rc.1 recovery controls",
    goal: "Reject bad evidence, resume a Wait, and recover one lease.",
    revision: 1,
    maxActive: 2,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "fixture" }],
        maxAttempts: 1,
        actorHint: null,
        tags: ["rc1"],
      },
      {
        id: "fixture",
        type: "task",
        title: "Seed or repair fixture",
        prompt: prompt("Seed bad state on Attempt 1 and repair it on Attempt 2."),
        next: [{ to: "gate" }],
        maxAttempts: 2,
        actorHint: "rc1-parent",
        tags: ["rc1", "known-bad"],
        resources: [],
      },
      {
        id: "gate",
        type: "gate",
        title: "Verify fixture",
        prompt: prompt(""),
        next: [
          { to: "wait", route: "pass" },
          { to: "decision", route: "fail" },
        ],
        maxAttempts: 2,
        actorHint: null,
        tags: ["rc1", "gate"],
        check: { id: "rc1-known-bad", revision: 1 },
        resources: [],
      },
      {
        id: "decision",
        type: "decision",
        title: "Route one repair",
        prompt: prompt("Route repair only after the known-bad rejection."),
        next: [
          {
            to: "fixture",
            route: "repair",
            maxTraversals: 1,
          },
          { to: "end", route: "abort" },
        ],
        maxAttempts: 1,
        actorHint: "rc1-parent",
        tags: ["rc1", "decision"],
      },
      {
        id: "wait",
        type: "wait",
        title: "Durable approval",
        prompt: prompt(""),
        next: [
          { to: "lease", route: "approved" },
          { to: "end", route: "rejected" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: ["rc1", "wait"],
        signal: { routes: ["approved", "rejected"] },
      },
      {
        id: "lease",
        type: "task",
        title: "Recover one lease",
        prompt: prompt("Let Attempt 1 expire and complete only Attempt 2."),
        next: [{ to: "end" }],
        maxAttempts: 2,
        actorHint: "rc1-lease",
        tags: ["rc1", "lease"],
        resources: ["rc1-lease"],
      },
      {
        id: "end",
        type: "end",
        title: "End",
        prompt: prompt(""),
        next: [],
        maxAttempts: 1,
        actorHint: null,
        tags: ["rc1"],
      },
    ],
  };
}

function resourceGraph() {
  return {
    schemaVersion: 2,
    id: "rc1-resources",
    title: "rc.1 exclusive resource",
    goal: "Serialize two independently eligible Tasks on one resource.",
    revision: 1,
    maxActive: 2,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "resource-a" }, { to: "resource-b" }],
        maxAttempts: 1,
        actorHint: null,
        tags: ["rc1"],
      },
      ...["a", "b"].map((branch) => ({
        id: `resource-${branch}`,
        type: "task",
        title: `Resource ${branch.toUpperCase()}`,
        prompt: prompt(`Complete resource branch ${branch.toUpperCase()}.`),
        next: [{ to: "join" }],
        maxAttempts: 1,
        actorHint: "rc1-parent",
        tags: ["rc1", "resource"],
        resources: ["rc1-exclusive"],
      })),
      {
        id: "join",
        type: "join",
        title: "Join",
        prompt: prompt(""),
        next: [{ to: "end" }],
        maxAttempts: 1,
        actorHint: null,
        tags: ["rc1"],
      },
      {
        id: "end",
        type: "end",
        title: "End",
        prompt: prompt(""),
        next: [],
        maxAttempts: 1,
        actorHint: null,
        tags: ["rc1"],
      },
    ],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("installed rc.1 dogfood workflow", () => {
  test("converges recovery controls through one dynamic parent Graph", async () => {
    expect(existsSync(archiveFile)).toBe(true);
    const testRoot = createTestDirectory();
    roots.push(testRoot);
    const installPrefix = path.join(testRoot, "bun-prefix");
    const projectRoot = path.join(testRoot, "project");
    mkdirSync(projectRoot, { recursive: true });
    const installation = await command(
      "bun",
      repositoryRoot,
      [
        path.join(repositoryRoot, "scripts", "install", "local.ts"),
        "--prefix",
        installPrefix,
      ],
    );
    expect(installation.exitCode, installation.stderr).toBe(0);
    const executable = path.join(installPrefix, "bin", "burn-graph");

    await invoke(executable, projectRoot, ["init", projectRoot]);
    writeFileSync(
      path.join(projectRoot, "verify-fixture.ts"),
      [
        "const value = (await Bun.file('status.txt').text()).trim();",
        "console.log(JSON.stringify({ state: value }));",
        "process.exit(value === 'good' ? 0 : 9);",
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(projectRoot, "status.txt"), "bad\n");
    const checkFile = writeJson(projectRoot, "check.json", {
      schemaVersion: 1,
      id: "rc1-known-bad",
      revision: 1,
      title: "rc.1 known-bad fixture",
      argv: ["bun", "verify-fixture.ts"],
      cwd: ".",
      successExitCodes: [0],
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
      inheritEnv: ["PATH"],
      resources: ["rc1-known-bad"],
    });
    await invoke(executable, projectRoot, [
      "check",
      "apply",
      "--input",
      checkFile,
    ]);
    for (const [name, graph] of [
      ["parent", parentGraph()],
      ["recovery", recoveryGraph()],
      ["resources", resourceGraph()],
    ] as const) {
      await invoke(executable, projectRoot, [
        "graph",
        "apply",
        "--input",
        writeJson(projectRoot, `${name}.json`, graph),
      ]);
    }

    const started = await invoke(executable, projectRoot, [
      "run",
      "start",
      "rc1-parent",
      "--actor",
      "rc1-parent",
      "--run-id",
      "rc1-parent-r1",
    ]);
    const planner = assignment(started, "rc1-parent-r1", "children");
    const childPlan = JSON.stringify({
      summary: "Planned the exact recovery and resource children.",
      evidence: ["tests/e2e/rc1-dogfood-workflow.test.ts"],
      output: {
        children: [
          {
            graphId: "rc1-recovery",
            revision: 1,
            runId: "rc1-recovery-r1",
            label: "recovery",
          },
          {
            graphId: "rc1-resources",
            revision: 1,
            runId: "rc1-resources-r1",
            label: "resources",
          },
        ],
      },
    });
    const planned = await invoke(
      executable,
      projectRoot,
      ["done", "--assignment", planner.assignmentId, "--input", "-"],
      childPlan,
    );
    expect(planned.data.assignments).toHaveLength(2);
    const replayedPlan = await invoke(
      executable,
      projectRoot,
      ["done", "--assignment", planner.assignmentId, "--input", "-"],
      childPlan,
    );
    expect(replayedPlan.data.replayed).toBe(true);

    await invoke(executable, projectRoot, [
      "run",
      "pause",
      "rc1-parent-r1",
      "--idempotency-key",
      "rc1-pause-1",
    ]);
    expect(
      (
        await invoke(executable, projectRoot, [
          "inspect",
          "run",
          "rc1-parent-r1",
        ])
      ).data.summary.status,
    ).toBe("pausing");
    await invoke(executable, projectRoot, [
      "run",
      "resume",
      "rc1-parent-r1",
      "--actor",
      "rc1-parent",
      "--idempotency-key",
      "rc1-resume-1",
    ]);

    const firstFixture = assignment(planned, "rc1-recovery-r1", "fixture");
    const rejected = await invoke(
      executable,
      projectRoot,
      ["done", "--assignment", firstFixture.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Seeded the known-bad fixture.", evidence: [] }),
    );
    const decision = assignment(rejected, "rc1-recovery-r1", "decision");
    expect(decision.context.predecessors).toEqual([
      expect.objectContaining({
        nodeId: "gate",
        route: "fail",
      }),
    ]);
    expect(
      (
        await invoke(executable, projectRoot, [
          "inspect",
          "executions",
          "rc1-recovery-r1",
        ])
      ).data.map((entry: any) => entry.classification),
    ).toEqual(["non_success"]);
    const repair = await invoke(
      executable,
      projectRoot,
      ["done", "--assignment", decision.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "The pinned Check rejected the fixture.",
        route: "repair",
        evidence: [],
      }),
    );
    const repairedFixture = assignment(repair, "rc1-recovery-r1", "fixture");
    expect(repairedFixture.node.attempt).toBe(2);
    writeFileSync(path.join(projectRoot, "status.txt"), "good\n");
    const accepted = await invoke(
      executable,
      projectRoot,
      ["done", "--assignment", repairedFixture.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Repaired the same fixture.", evidence: [] }),
    );
    expect(accepted.data.system.gateExecutions).toBe(1);
    expect(
      (
        await invoke(executable, projectRoot, [
          "inspect",
          "executions",
          "rc1-recovery-r1",
        ])
      ).data.map((entry: any) => entry.classification).sort(),
    ).toEqual(["non_success", "success"]);

    const waiting = await invoke(executable, projectRoot, [
      "inspect",
      "waits",
      "rc1-recovery-r1",
    ]);
    const recoveryAfterGate = await invoke(executable, projectRoot, [
      "inspect",
      "run",
      "rc1-recovery-r1",
      "--events",
      "100",
    ]);
    expect(
      waiting.data.length,
      JSON.stringify({ accepted, recoveryAfterGate }, null, 2),
    ).toBe(1);
    expect(waiting.data[0].status).toBe("waiting");
    const signalId = waiting.data[0].signalId;

    const resourceView = await invoke(executable, projectRoot, [
      "inspect",
      "overview",
      "--root-run",
      "rc1-parent-r1",
      "--resource",
      "rc1-exclusive",
      "--node-status",
      "ready,running",
      "--limit",
      "10",
    ]);
    expect(resourceView.data.nodes).toHaveLength(2);
    expect(
      resourceView.data.nodes.find(
        (node: any) => node.nodeId === "resource-b",
      ).eligibility,
    ).toEqual({
      eligible: false,
      reason: "RESOURCE_BUSY",
      blockedResources: ["rc1-exclusive"],
    });
    const firstResource = assignment(
      planned,
      "rc1-resources-r1",
      "resource-a",
    );
    const resourceTransfer = await invoke(
      executable,
      projectRoot,
      ["done", "--assignment", firstResource.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Released resource branch A.", evidence: [] }),
    );
    const secondResource = assignment(
      resourceTransfer,
      "rc1-resources-r1",
      "resource-b",
    );
    expect(
      (
        await invoke(executable, projectRoot, [
          "inspect",
          "resources",
          "rc1-parent-r1",
        ])
      ).data[0],
    ).toMatchObject({
      resource: "rc1-exclusive",
      runId: "rc1-resources-r1",
      ownerId: secondResource.assignmentId,
    });

    const configFile = path.join(projectRoot, ".burn-graph", "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    writeFileSync(
      configFile,
      `${JSON.stringify({ ...config, defaultLeaseSeconds: 30 }, null, 2)}\n`,
    );
    const resolved = await invoke(
      executable,
      projectRoot,
      [
        "signal",
        "resolve",
        "--signal",
        signalId,
        "--route",
        "approved",
        "--actor",
        "rc1-lease",
        "--idempotency-key",
        "rc1-approval-1",
        "--input",
        "-",
      ],
      JSON.stringify({ summary: "Approved lease recovery.", evidence: [] }),
    );
    const expiring = assignment(resolved, "rc1-recovery-r1", "lease");
    const replayedSignal = await invoke(
      executable,
      projectRoot,
      [
        "signal",
        "resolve",
        "--signal",
        signalId,
        "--route",
        "approved",
        "--actor",
        "rc1-lease",
        "--idempotency-key",
        "rc1-approval-1",
        "--input",
        "-",
      ],
      JSON.stringify({ summary: "Approved lease recovery.", evidence: [] }),
    );
    expect(replayedSignal.data.resolved.replayed).toBe(true);
    expect(
      assignment(replayedSignal, "rc1-recovery-r1", "lease").assignmentId,
    ).toBe(expiring.assignmentId);
    writeFileSync(
      configFile,
      `${JSON.stringify({ ...config, defaultLeaseSeconds: 900 }, null, 2)}\n`,
    );

    await Bun.sleep(30_250);
    const reconciled = await invoke(executable, projectRoot, [
      "recover",
      "reconcile",
      "rc1-recovery-r1",
      "--actor",
      "rc1-lease",
    ]);
    expect(reconciled.data.reconciledAssignments).toBe(1);
    const recovered = assignment(reconciled, "rc1-recovery-r1", "lease");
    expect(recovered.node.attempt).toBe(2);
    expect(recovered.assignmentId).not.toBe(expiring.assignmentId);

    const staleCompletion = await command(
      executable,
      projectRoot,
      [
        "--root",
        projectRoot,
        "done",
        "--assignment",
        expiring.assignmentId,
        "--input",
        "-",
      ],
      JSON.stringify({ summary: "Stale completion must fail.", evidence: [] }),
    );
    expect(staleCompletion.exitCode).toBe(1);
    expect(staleCompletion.envelope.error.code).toBe("ASSIGNMENT_NOT_ACTIVE");

    await invoke(
      executable,
      projectRoot,
      ["done", "--assignment", recovered.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Recovered lease completed.", evidence: [] }),
    );
    const converged = await invoke(
      executable,
      projectRoot,
      ["done", "--assignment", secondResource.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Released resource branch B.", evidence: [] }),
    );
    const review = converged.data.assignments.find(
      (candidate: any) =>
        candidate.graph.runId === "rc1-parent-r1" &&
        candidate.node.id === "review",
    ) ?? assignment(
      await invoke(executable, projectRoot, [
        "next",
        "--actor",
        "rc1-parent",
        "--graph",
        "rc1-parent-r1",
      ]),
      "rc1-parent-r1",
      "review",
    );
    await invoke(
      executable,
      projectRoot,
      ["done", "--assignment", review.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Both child Runs converged exactly once.",
        evidence: ["tests/e2e/rc1-dogfood-workflow.test.ts"],
      }),
    );

    const completed = await invoke(executable, projectRoot, [
      "inspect",
      "run",
      "rc1-parent-r1",
      "--events",
      "100",
    ]);
    expect(completed.data.summary.status).toBe("completed");
    const tree = await invoke(executable, projectRoot, [
      "inspect",
      "tree",
      "rc1-parent-r1",
      "--depth",
      "1",
      "--limit",
      "100",
    ]);
    expect(tree.data.projection).toMatchObject({
      totalRuns: 3,
      expandedRuns: 3,
      foldedRuns: 0,
    });
    expect(
      tree.data.runs.every(
        (run: any) => run.summary.status === "completed",
      ),
    ).toBe(true);
    const metrics = await invoke(executable, projectRoot, [
      "inspect",
      "metrics",
      "rc1-parent-r1",
    ]);
    expect(metrics.data).toMatchObject({
      scope: { runId: "rc1-parent-r1", runCount: 3, rootCount: 1 },
      totals: { repairs: 1, leaseRecoveries: 1 },
      assignments: { current: 0 },
      gates: { success: 1, nonSuccess: 1 },
      signals: { waiting: 0, resolved: 1 },
      resources: { activeLocks: 0, contendedReadyNodes: 0 },
    });
    const recoveryEvents = await invoke(executable, projectRoot, [
      "inspect",
      "events",
      "rc1-recovery-r1",
      "--limit",
      "100",
    ]);
    expect(
      recoveryEvents.data.filter(
        (event: any) => event.type === "wait.resolved",
      ),
    ).toHaveLength(1);
    expect(
      recoveryEvents.data.filter(
        (event: any) => event.type === "claims.reconciled",
      ),
    ).toHaveLength(1);
    expect(
      (
        await invoke(executable, projectRoot, [
          "inspect",
          "resources",
          "rc1-parent-r1",
        ])
      ).data,
    ).toEqual([]);
    expect(
      (
        await invoke(executable, projectRoot, [
          "current",
          "--actor",
          "rc1-parent",
        ])
      ).data.assignments,
    ).toEqual([]);
    expect(
      (
        await invoke(executable, projectRoot, [
          "current",
          "--actor",
          "rc1-lease",
        ])
      ).data.assignments,
    ).toEqual([]);

    const svg = await invoke(executable, projectRoot, [
      "render",
      "rc1-parent-r1",
      "--scope",
      "tree",
      "--depth",
      "1",
      "--format",
      "svg",
    ]);
    const png = await invoke(executable, projectRoot, [
      "render",
      "rc1-parent-r1",
      "--scope",
      "tree",
      "--depth",
      "1",
      "--format",
      "png",
    ]);
    expect(svg.data).toMatchObject({ scope: "tree", format: "svg" });
    expect(png.data).toMatchObject({ scope: "tree", format: "png" });
    expect(existsSync(path.resolve(projectRoot, svg.data.artifact))).toBe(true);
    expect(existsSync(path.resolve(projectRoot, png.data.artifact))).toBe(true);
  }, 120_000);
});
