// Purpose: Guard public non-render CLI control latency and response bounds.
// Usage: bun scripts/verify/control-performance.ts
// Notes: Fixture setup is excluded; each sample starts a fresh Bun CLI process.

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { percentile95 } from "./percentile.ts";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cli = path.join(repositoryRoot, "dist", "burn-graph.js");
const sampleCount = 5;
const p95BudgetMs = 1_000;
const outputBudgetBytes = 256 * 1024;

// Width is held to the same budget as everything else: starting a Run on a
// 500-node graph measures 493ms p95 against 48ms at 4 nodes, so a 125x wider
// graph costs ~10x — sub-linear, and inside the shared budget. An earlier
// reading of 1457ms was a fixture artefact, not the command.
//
// Response *size* at width is a separate, real defect and is not fenced here:
// `run cancel` returns 557KB on this width against a 256KB budget, so the perf
// script cannot call it at all. That is tracked as I0010.

// Only the fields this script reads are declared. The public envelope carries
// far more, but typing the whole contract here would duplicate it — and a
// duplicate contract is the thing that drifts.
interface AssignmentEnvelope {
  readonly data: {
    readonly assignments: readonly { readonly assignmentId: string }[];
  };
}

interface Invocation {
  readonly milliseconds: number;
  readonly bytes: number;
  readonly envelope: AssignmentEnvelope;
}

// The CLI returning no Assignment is a real failure mode, not a type puzzle: it
// means the run did not schedule work. Say so where it happens rather than
// letting an undefined assignmentId surface three commands later.
function firstAssignment(envelope: AssignmentEnvelope, command: string): string {
  const assignment = envelope.data.assignments[0];
  if (!assignment) {
    throw new Error(`${command} returned no Assignment; nothing to measure`);
  }
  return assignment.assignmentId;
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

// A wide graph measures what the small control graph cannot: whether starting a
// run stays bounded when hundreds of nodes become ready at once. The assertion
// used to live inside an integration test as a single wall-clock sample, where
// it measured suite load instead of the code and failed only when run alongside
// the rest of the suite. Budgets belong here, with repeatable sampling.
const wideNodeCount = 500;
// Each sample gets its own graph because one graph holds one live run. Cancel is
// now measured too: it used to return an unbounded GraphSnapshot (557 KB at this
// width, past the output budget) and could not be called here at all. I0010
// bounded it to the summary, so this samples both ends of the lifecycle.
const buildWideGraph = (index: number) => ({
  schemaVersion: 2,
  id: `control-performance-wide-${index}`,
  title: "CLI control performance at width",
  goal: "Measure run start when many nodes become ready at once.",
  revision: 1,
  maxActive: 1,
  nodes: [
    {
      id: "start",
      type: "start",
      title: "Start",
      prompt: emptyPrompt,
      next: Array.from({ length: wideNodeCount }, (_unused, index) => ({
        to: `task-${index}`,
      })),
      maxAttempts: 1,
      actorHint: null,
      tags: [],
    },
    ...Array.from({ length: wideNodeCount }, (_unused, index) => ({
      id: `task-${index}`,
      type: "task" as const,
      title: `Task ${index}`,
      prompt: { ...emptyPrompt, objective: `Complete task ${index}.` },
      next: [{ to: "end" }],
      maxAttempts: 1,
      actorHint: null,
      tags: ["control-performance"],
      resources: [],
    })),
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
});

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), "burn-graph-control-performance-"),
);
const graphFile = path.join(temporaryRoot, "graph.json");
writeFileSync(graphFile, `${JSON.stringify(graph)}\n`);

// The wide fixture gets its own project root. Sharing one database made every
// small-graph sample 60-200x slower once thousands of wide-graph rows and five
// live runs sat beside it — a measurement artefact that reads exactly like a
// product regression. Isolation is what keeps each number about its own command.
// Every wide sample gets its own project root. Sharing one root made sample N
// start against a database already holding N*500 nodes, inflating the measured
// latency ~4.6x (1457ms against the 313ms an isolated start actually costs) and
// turning the number into a statement about the fixture instead of the command.
const wideRoots = Array.from({ length: sampleCount }, (_unused, index) => {
  const root = mkdtempSync(
    path.join(tmpdir(), `burn-graph-control-performance-wide-${index}-`),
  );
  const file = path.join(root, "wide-graph.json");
  writeFileSync(file, `${JSON.stringify(buildWideGraph(index))}\n`);
  return { root, file };
});

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
  for (const { root, file } of wideRoots) {
    await invoke(root, ["init"]);
    await invoke(root, ["graph", "apply", "--input", file]);
  }

  for (let index = 0; index < sampleCount; index += 1) {
    const wideStarted = await invoke(wideRoots[index]!.root, [
      "run",
      "start",
      `control-performance-wide-${index}`,
      "--actor",
      `wide-${index}`,
      "--run-id",
      `control-performance-wide-r${index}`,
    ]);
    record("run.start.wide", wideStarted);
    // The schedule must stay bounded regardless of graph width; an unbounded
    // response would meet the latency budget only by accident on a fast machine.
    const wideAssignments = wideStarted.envelope.data.assignments.length;
    if (wideAssignments > 8) {
      throw new Error(
        `run.start on a ${wideNodeCount}-node graph returned ${wideAssignments} assignments; the Actor cap is 8`,
      );
    }
    record(
      "run.cancel.wide",
      await invoke(wideRoots[index]!.root, [
        "run",
        "cancel",
        `control-performance-wide-r${index}`,
        "--idempotency-key",
        `control-performance-wide-r${index}-cancel`,
      ]),
    );
  }

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
    const first = firstAssignment(started.envelope, "run start");

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
        ["done", "--assignment", first, "--input", "-"],
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
    const second = firstAssignment(resumed.envelope, "run resume");
    await invoke(
      temporaryRoot,
      ["done", "--assignment", second, "--input", "-"],
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
  // Report every measurement before deciding. Throwing on the first breach hides
  // the rest of the profile, which is exactly the information needed to tell a
  // single slow command apart from an across-the-board regression.
  const breaches = Object.entries(p95Milliseconds)
    .filter(([, milliseconds]) => milliseconds > p95BudgetMs)
    .map(([name, milliseconds]) => ({
      name,
      p95Milliseconds: milliseconds,
      budgetMs: p95BudgetMs,
    }));

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: breaches.length === 0,
      samplesPerCommand: sampleCount,
      wideNodeCount,
      p95Milliseconds,
      maximumOutputBytes,
      budgets: {
        p95Milliseconds: p95BudgetMs,
        outputBytes: outputBudgetBytes,
      },
      breaches,
    })}\n`,
  );

  if (breaches.length > 0) {
    throw new Error(
      `${breaches.length} command(s) exceed their p95 budget: ${breaches
        .map((breach) => `${breach.name} ${breach.p95Milliseconds}ms > ${breach.budgetMs}ms`)
        .join(", ")}`,
    );
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
  for (const { root } of wideRoots) {
    rmSync(root, { recursive: true, force: true });
  }
}
