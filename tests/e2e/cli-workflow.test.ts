import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  convergenceGraph,
  createTestDirectory,
  parallelGraph,
  removeTestProject,
} from "../helpers/fixtures.ts";

interface CliEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: any;
  readonly error?: {
    readonly code: string;
    readonly retryable: boolean;
  };
}

interface StepEvidence {
  readonly id: string;
  readonly action: string;
  readonly oracle: string;
  readonly status: "passed";
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cli = path.join(repositoryRoot, "dist", "burn-graph.js");
const roots: string[] = [];
let cliProcessCount = 0;

async function invoke(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: CliEnvelope;
}> {
  cliProcessCount += 1;
  const child = Bun.spawn(["bun", cli, "--root", root, ...args], {
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
  const json = (exitCode === 0 ? stdout : stderr).trim();
  return {
    exitCode,
    stdout,
    stderr,
    envelope: JSON.parse(json) as CliEnvelope,
  };
}

async function ok(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<CliEnvelope> {
  const result = await invoke(root, args, stdin);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.envelope.ok).toBe(true);
  return result.envelope;
}

function node(snapshot: any, nodeId: string): any {
  const found = snapshot.nodes.find((candidate: any) => candidate.id === nodeId);
  if (!found) throw new Error(`Missing node ${nodeId}`);
  return found;
}

function record(
  steps: StepEvidence[],
  id: string,
  action: string,
  oracle: string,
): void {
  steps.push({ id, action, oracle, status: "passed" });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writeEvidence(
  startedAt: string,
  steps: readonly StepEvidence[],
  publicCliProcesses: number,
): void {
  const evidenceRoot = path.join(repositoryRoot, ".tmp", "e2e", "cli");
  mkdirSync(evidenceRoot, { recursive: true });
  const report = {
    schemaVersion: 1,
    runId: `cli-dogfood-${Date.now()}`,
    status: "passed",
    subject: {
      product: "burn-graph",
      version: "0.1.0-dev.1",
      entrypoint: "dist/burn-graph.js",
    },
    userPaths: ["UP01", "UP02"],
    startedAt,
    completedAt: new Date().toISOString(),
    steps,
    metrics: {
      publicCliProcesses,
      graphsRunConcurrently: 2,
      maximumParallelNodesObserved: 4,
      boundedRepairTraversals: 1,
    },
  };
  writeFileSync(
    path.join(evidenceRoot, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const rows = steps
    .map(
      (step) =>
        `<tr><td>${escapeHtml(step.id)}</td><td>${escapeHtml(
          step.action,
        )}</td><td>${escapeHtml(step.oracle)}</td><td>${step.status}</td></tr>`,
    )
    .join("");
  writeFileSync(
    path.join(evidenceRoot, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>burn-graph CLI E2E</title><style>body{font-family:system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d8deea;padding:10px;text-align:left}th{background:#f4f7fb}td:last-child{color:#087443;font-weight:700}</style></head><body><h1>burn-graph CLI E2E</h1><p>Generated from a real public-CLI run. Status: passed.</p><table><thead><tr><th>Step</th><th>Action</th><th>External oracle</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></body></html>\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("AI operates burn-graph entirely through its CLI", () => {
  test("confirms, starts, completes, routes, and converges parallel nodes across two graphs", async () => {
    const startedAt = new Date().toISOString();
    const steps: StepEvidence[] = [];
    cliProcessCount = 0;
    const root = createTestDirectory();
    roots.push(root);
    const deliveryFile = path.join(root, "delivery.json");
    const researchFile = path.join(root, "research.json");
    writeFileSync(deliveryFile, `${JSON.stringify(convergenceGraph())}\n`);
    writeFileSync(
      researchFile,
      `${JSON.stringify(parallelGraph("research"))}\n`,
    );

    const initialized = await ok(root, ["init", root]);
    expect(initialized.data.config.projectId).toMatch(/^burn-graph-test-/);
    record(steps, "UP01-01", "Initialize project", "Project-local state is created.");

    await ok(root, ["graph", "validate", "--input", deliveryFile]);
    await ok(root, ["graph", "apply", "--input", deliveryFile]);
    await ok(root, ["graph", "apply", "--input", researchFile]);
    record(
      steps,
      "UP01-02",
      "Validate and apply two GraphSpecs",
      "Both graph revisions are accepted before execution.",
    );

    await ok(root, [
      "run",
      "start",
      "delivery",
      "--run-id",
      "delivery:e2e",
    ]);
    await ok(root, [
      "run",
      "start",
      "research",
      "--run-id",
      "research:e2e",
    ]);
    const initiallyReady = await ok(root, ["work", "ready", "--all"]);
    expect(initiallyReady.data).toHaveLength(5);
    record(
      steps,
      "UP02-01",
      "Start two graphs",
      "Five tasks become Ready across two independent runs.",
    );

    const assignment = await ok(root, [
      "work",
      "claim",
      "delivery:e2e",
      "left",
      "--actor",
      "ai:implementation",
      "--lease",
      "300",
    ]);
    expect(assignment.data.node.prompt.objective).toBe(
      "Implement the smallest verified core result.",
    );
    expect(assignment.data.node.prompt.mustRead).toEqual([
      "README.md",
      "privacy/spec/bdd/S01-graph-runtime.feature",
    ]);
    expect(assignment.data.node.prompt.doneWhen).toHaveLength(2);
    expect(assignment.data.returnProtocol.complete).toContain(
      "delivery:e2e left",
    );
    record(
      steps,
      "UP01-03",
      "Claim a node",
      "The assignment injects objective, instructions, Must Read, Done When, and return protocol.",
    );

    await ok(root, [
      "work",
      "claim",
      "delivery:e2e",
      "right",
      "--actor",
      "ai:verification",
      "--lease",
      "300",
    ]);
    const overLimit = await invoke(root, [
      "work",
      "claim",
      "delivery:e2e",
      "third",
      "--actor",
      "ai:review",
      "--lease",
      "300",
    ]);
    expect(overLimit.exitCode).toBe(1);
    expect(overLimit.envelope.error?.code).toBe("MAX_ACTIVE_REACHED");
    expect(overLimit.envelope.error?.retryable).toBe(true);

    await ok(root, [
      "work",
      "claim",
      "research:e2e",
      "left",
      "--actor",
      "ai:research-left",
      "--lease",
      "300",
    ]);
    await ok(root, [
      "work",
      "claim",
      "research:e2e",
      "right",
      "--actor",
      "ai:research-right",
      "--lease",
      "300",
    ]);
    const parallelRuns = await ok(root, ["run", "list"]);
    expect(
      parallelRuns.data.reduce(
        (count: number, run: any) => count + run.counts.running,
        0,
      ),
    ).toBe(4);
    record(
      steps,
      "UP02-02",
      "Claim parallel nodes in both graphs",
      "Four nodes overlap as Running while each graph enforces its own maxActive.",
    );

    const duplicate = await invoke(root, [
      "work",
      "claim",
      "delivery:e2e",
      "left",
      "--actor",
      "ai:duplicate",
      "--lease",
      "300",
    ]);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.envelope.error?.code).toBe("NODE_NOT_READY");
    expect(duplicate.envelope.error?.retryable).toBe(true);
    const current = await ok(root, [
      "work",
      "current",
      "--actor",
      "ai:implementation",
    ]);
    expect(current.data.focused).toEqual({
      runId: "delivery:e2e",
      nodeId: "left",
    });
    record(
      steps,
      "UP01-04",
      "Reject a duplicate claim and inspect current work",
      "Exactly one actor owns the node and can recover its focus.",
    );

    await ok(
      root,
      [
        "work",
        "checkpoint",
        "delivery:e2e",
        "left",
        "--actor",
        "ai:implementation",
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Core implementation is type-safe.",
        progress: 70,
        artifacts: ["tests/integration"],
      }),
    );
    let delivery = (
      await ok(root, ["run", "show", "delivery:e2e"])
    ).data;
    expect(node(delivery, "left").checkpoint.progress).toBe(70);
    record(
      steps,
      "UP01-05",
      "Checkpoint through JSON stdin",
      "A fresh CLI process reads the durable checkpoint.",
    );

    await ok(
      root,
      [
        "work",
        "complete",
        "delivery:e2e",
        "left",
        "--actor",
        "ai:implementation",
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Core implementation verified.",
        output: { checks: ["typecheck", "CLI integration"] },
        evidence: ["tests/integration/service.test.ts"],
      }),
    );
    await ok(root, [
      "work",
      "claim",
      "delivery:e2e",
      "third",
      "--actor",
      "ai:review",
      "--lease",
      "300",
    ]);
    await ok(
      root,
      [
        "work",
        "complete",
        "delivery:e2e",
        "right",
        "--actor",
        "ai:verification",
        "--input",
        "-",
      ],
      JSON.stringify({ summary: "Public behavior verified.", evidence: [] }),
    );
    delivery = (await ok(root, ["run", "show", "delivery:e2e"])).data;
    expect(node(delivery, "join").status).toBe("pending");
    await ok(
      root,
      [
        "work",
        "complete",
        "delivery:e2e",
        "third",
        "--actor",
        "ai:review",
        "--input",
        "-",
      ],
      JSON.stringify({ summary: "Boundaries reviewed.", evidence: [] }),
    );
    delivery = (await ok(root, ["run", "show", "delivery:e2e"])).data;
    expect(node(delivery, "join").status).toBe("done");
    expect(node(delivery, "decision").status).toBe("ready");
    record(
      steps,
      "UP01-06",
      "Complete all activated branches",
      "Join waits for the last branch, then auto-completes and opens Decision exactly once.",
    );

    const decision = await ok(root, [
      "work",
      "claim",
      "delivery:e2e",
      "decision",
      "--actor",
      "ai:quality",
      "--lease",
      "300",
    ]);
    expect(decision.data.node.routes).toEqual([
      {
        route: "pass",
        to: "end",
        label: "all checks pass",
        remainingTraversals: null,
      },
      {
        route: "repair",
        to: "left",
        label: "repair core",
        remainingTraversals: 2,
      },
    ]);
    await ok(
      root,
      [
        "work",
        "complete",
        "delivery:e2e",
        "decision",
        "--actor",
        "ai:quality",
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "One repair is required.",
        route: "repair",
        evidence: ["quality finding"],
      }),
    );
    delivery = (await ok(root, ["run", "show", "delivery:e2e"])).data;
    expect(node(delivery, "left").status).toBe("ready");
    expect(node(delivery, "left").attempt).toBe(1);
    expect(
      delivery.edges.find((edge: any) => edge.route === "repair").traversals,
    ).toBe(1);
    record(
      steps,
      "UP01-07",
      "Return Decision route repair",
      "Only the bounded repair region reopens and prior Attempt remains visible.",
    );

    const repaired = await ok(root, [
      "work",
      "claim",
      "delivery:e2e",
      "left",
      "--actor",
      "ai:implementation",
      "--lease",
      "300",
    ]);
    expect(repaired.data.node.attempt).toBe(2);
    expect(
      repaired.data.context.predecessors.find(
        (predecessor: any) => predecessor.nodeId === "decision",
      ),
    ).toMatchObject({
      status: "pending",
      attempt: 1,
      route: "repair",
      summary: "One repair is required.",
      evidence: ["quality finding"],
    });
    await ok(
      root,
      [
        "work",
        "complete",
        "delivery:e2e",
        "left",
        "--actor",
        "ai:implementation",
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Repair verified.",
        output: { checks: ["typecheck", "CLI integration", "repair regression"] },
        evidence: ["repair evidence"],
      }),
    );
    await ok(root, [
      "work",
      "claim",
      "delivery:e2e",
      "decision",
      "--actor",
      "ai:quality",
      "--lease",
      "300",
    ]);
    await ok(
      root,
      [
        "work",
        "complete",
        "delivery:e2e",
        "decision",
        "--actor",
        "ai:quality",
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "All gates pass.",
        route: "pass",
        evidence: ["final quality evidence"],
      }),
    );
    delivery = (await ok(root, ["run", "show", "delivery:e2e"])).data;
    expect(delivery.summary.status).toBe("completed");
    expect(node(delivery, "end").status).toBe("done");
    expect(node(delivery, "left").attempt).toBe(2);
    record(
      steps,
      "UP01-08",
      "Repair and return Decision route pass",
      "Next reaches End and the graph becomes completed after two preserved Attempts.",
    );

    for (const [nodeId, actor] of [
      ["left", "ai:research-left"],
      ["right", "ai:research-right"],
    ] as const) {
      await ok(
        root,
        [
          "work",
          "complete",
          "research:e2e",
          nodeId,
          "--actor",
          actor,
          "--input",
          "-",
        ],
        JSON.stringify({
          summary: `Research ${nodeId} completed.`,
          evidence: [],
        }),
      );
    }
    const finalRuns = await ok(root, ["run", "list"]);
    expect(finalRuns.data).toHaveLength(2);
    expect(finalRuns.data.every((run: any) => run.status === "completed")).toBe(
      true,
    );
    const noWork = await ok(root, ["work", "ready", "--all"]);
    expect(noWork.data).toEqual([]);
    record(
      steps,
      "UP02-03",
      "Finish the second graph independently",
      "Both runs complete with no Ready work and no cross-graph state leakage.",
    );

    const events = await ok(root, ["events", "list", "--after", "0"]);
    expect(events.data.length).toBeGreaterThan(15);
    expect(
      events.data.every(
        (event: any, index: number, all: any[]) =>
          index === 0 || event.sequence > all[index - 1].sequence,
      ),
    ).toBe(true);
    const persistedGraph = JSON.parse(
      readFileSync(
        path.join(root, ".burn-graph", "graphs", "delivery.json"),
        "utf8",
      ),
    );
    expect(persistedGraph.revision).toBe(1);
    record(
      steps,
      "UP01-09",
      "Inspect history after many process restarts",
      "Events remain globally ordered and the authored GraphSpec remains inspectable JSON.",
    );

    expect(cliProcessCount).toBeGreaterThan(25);
    writeEvidence(startedAt, steps, cliProcessCount);
  });
});
