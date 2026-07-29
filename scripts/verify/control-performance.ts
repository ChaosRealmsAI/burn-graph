// Purpose: Guard public non-render CLI control latency and response bounds.
// Usage: bun scripts/verify/control-performance.ts
// Notes: Fixture setup is excluded; each sample starts a fresh Bun CLI process.

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cli = path.join(repositoryRoot, "dist", "burn-graph.js");
const sampleCount = 5;
const p95BudgetMs = 1_000;
const outputBudgetBytes = 256 * 1024;

interface Invocation {
  readonly milliseconds: number;
  readonly bytes: number;
  readonly envelope: any;
}

function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

async function invoke(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<Invocation> {
  const started = performance.now();
  const child = Bun.spawn(["bun", cli, "--root", root, ...args], {
    cwd: repositoryRoot,
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
  const milliseconds = performance.now() - started;
  const serialized = (exitCode === 0 ? stdout : stderr).trim();
  if (exitCode !== 0) {
    throw new Error(`CLI ${args.join(" ")} failed: ${serialized.slice(0, 512)}`);
  }
  const bytes = Buffer.byteLength(stdout);
  if (bytes > outputBudgetBytes) {
    throw new Error(
      `CLI ${args.join(" ")} returned ${bytes} bytes; budget ${outputBudgetBytes}`,
    );
  }
  return { milliseconds, bytes, envelope: JSON.parse(serialized) };
}

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
const graph = {
  schemaVersion: 2,
  id: "control-performance",
  title: "CLI control performance",
  goal: "Measure public control commands without Gate or render work.",
  revision: 1,
  maxActive: 1,
  nodes: [
    {
      id: "start",
      type: "start",
      title: "Start",
      prompt: emptyPrompt,
      next: [{ to: "first" }],
      maxAttempts: 1,
      actorHint: null,
      tags: [],
    },
    {
      id: "first",
      type: "task",
      title: "First",
      prompt: { ...emptyPrompt, objective: "Complete the first control task." },
      next: [{ to: "second" }],
      maxAttempts: 1,
      actorHint: null,
      tags: ["control-performance"],
      resources: [],
    },
    {
      id: "second",
      type: "task",
      title: "Second",
      prompt: { ...emptyPrompt, objective: "Complete the second control task." },
      next: [{ to: "end" }],
      maxAttempts: 1,
      actorHint: null,
      tags: ["control-performance"],
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

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), "burn-graph-control-performance-"),
);
const graphFile = path.join(temporaryRoot, "graph.json");
writeFileSync(graphFile, `${JSON.stringify(graph)}\n`);

const samples = new Map<string, number[]>();
let maximumOutputBytes = 0;
function record(name: string, result: Invocation): void {
  const values = samples.get(name) ?? [];
  values.push(result.milliseconds);
  samples.set(name, values);
  maximumOutputBytes = Math.max(maximumOutputBytes, result.bytes);
}

try {
  await invoke(temporaryRoot, ["init"]);
  await invoke(temporaryRoot, ["graph", "apply", "--input", graphFile]);

  for (let index = 0; index < sampleCount; index += 1) {
    const actor = `control-${index}`;
    const runId = `control-performance-r${index}`;
    record(
      "graph.validate",
      await invoke(temporaryRoot, ["graph", "validate", "--input", graphFile]),
    );
    record(
      "graph.show",
      await invoke(temporaryRoot, ["graph", "show", "control-performance"]),
    );
    const started = await invoke(temporaryRoot, [
      "run",
      "start",
      "control-performance",
      "--actor",
      actor,
      "--run-id",
      runId,
    ]);
    record("run.start", started);
    const first = started.envelope.data.assignments[0];

    record(
      "current",
      await invoke(temporaryRoot, ["current", "--actor", actor]),
    );
    record(
      "next",
      await invoke(temporaryRoot, ["next", "--actor", actor, "--graph", runId]),
    );
    record(
      "run.pause",
      await invoke(temporaryRoot, [
        "run",
        "pause",
        runId,
        "--idempotency-key",
        `${runId}-pause`,
      ]),
    );
    record(
      "done",
      await invoke(
        temporaryRoot,
        ["done", "--assignment", first.assignmentId, "--input", "-"],
        JSON.stringify({ summary: "First task complete.", evidence: [] }),
      ),
    );
    const resumed = await invoke(temporaryRoot, [
      "run",
      "resume",
      runId,
      "--actor",
      actor,
      "--idempotency-key",
      `${runId}-resume`,
    ]);
    record("run.resume", resumed);
    const second = resumed.envelope.data.assignments[0];
    await invoke(
      temporaryRoot,
      ["done", "--assignment", second.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Second task complete.", evidence: [] }),
    );
    record(
      "inspect.overview",
      await invoke(temporaryRoot, [
        "inspect",
        "overview",
        "--root-run",
        runId,
        "--limit",
        "20",
      ]),
    );
    record(
      "inspect.metrics",
      await invoke(temporaryRoot, ["inspect", "metrics", runId]),
    );
  }

  const p95Milliseconds = Object.fromEntries(
    [...samples].map(([name, values]) => [
      name,
      Math.round(percentile95(values) * 100) / 100,
    ]),
  );
  for (const [name, milliseconds] of Object.entries(p95Milliseconds)) {
    if (milliseconds > p95BudgetMs) {
      throw new Error(
        `${name} p95 ${milliseconds}ms exceeds ${p95BudgetMs}ms`,
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      samplesPerCommand: sampleCount,
      p95Milliseconds,
      maximumOutputBytes,
      budgets: {
        p95Milliseconds: p95BudgetMs,
        outputBytes: outputBudgetBytes,
      },
    })}\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
