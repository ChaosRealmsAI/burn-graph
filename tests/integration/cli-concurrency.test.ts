import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import {
  BurnGraphService,
  type GraphSpec,
} from "@burn-graph/core";
import {
  createTestProject,
  loopGraph,
  prompt,
  removeTestProject,
  wideGraph,
} from "../helpers/fixtures.ts";

const roots: string[] = [];
const cli = path.resolve(import.meta.dir, "../../apps/cli/src/index.ts");

function childGraph(): GraphSpec {
  return {
    schemaVersion: 1,
    id: "concurrent-child",
    title: "Concurrent child",
    goal: "Complete one child.",
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
        title: "Work",
        prompt: prompt("Complete the child."),
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

function dynamicGraph(): GraphSpec {
  return {
    schemaVersion: 2,
    id: "concurrent-parent",
    title: "Concurrent dynamic parent",
    goal: "Seal one immutable child set exactly once.",
    revision: 1,
    maxActive: 2,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "children" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "children",
        type: "subgraph",
        title: "Plan children",
        prompt: prompt("Return the complete immutable child set."),
        next: [{ to: "end", route: "success" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
        mode: "dynamic",
        minChildren: 1,
        maxChildren: 2,
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

async function invoke(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["bun", cli, "--root", root, ...args], {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && process.stdin !== undefined) {
    process.stdin.write(stdin);
    process.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("public CLI concurrency", () => {
  // I0010: lifecycle mutations returned a whole GraphSnapshot — summary, the full
  // GraphSpec, every node, every edge, recent events and a rendered mermaid
  // string. At 500 nodes that is 557KB, 2.1x the output budget this CLI declares
  // for itself and a large fraction of an AI caller's context for a command whose
  // only answer is "the Run is cancelled".
  //
  // This is the known-bad case: it fails before the fix and passes after it.
  test("lifecycle mutations stay inside the output budget at width", async () => {
    const root = createTestProject();
    roots.push(root);
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(wideGraph("bounded-cancel", 500));
    } finally {
      service.close();
    }

    const started = await invoke(root, [
      "run",
      "start",
      "bounded-cancel",
      "--actor",
      "budget-actor",
      "--run-id",
      "bounded-cancel:run",
    ]);
    expect(started.exitCode).toBe(0);

    const OUTPUT_BUDGET_BYTES = 256 * 1024;
    for (const [command, args] of [
      ["run.pause", ["run", "pause", "bounded-cancel:run", "--idempotency-key", "p1"]],
      ["run.cancel", ["run", "cancel", "bounded-cancel:run", "--idempotency-key", "c1"]],
    ] as const) {
      const result = await invoke(root, args);
      expect(result.exitCode).toBe(0);
      const bytes = Buffer.byteLength(result.stdout);
      expect(
        bytes,
        `${command} returned ${bytes} bytes against a ${OUTPUT_BUDGET_BYTES} budget`,
      ).toBeLessThanOrEqual(OUTPUT_BUDGET_BYTES);

      // Bounded must not mean uninformative: the caller still learns the outcome.
      const envelope = JSON.parse(result.stdout) as {
        readonly ok: boolean;
        readonly data: { readonly summary?: { readonly status?: string } };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data.summary?.status).toBeDefined();
    }
  });

  test("concurrent lifecycle retries share one idempotent mutation", async () => {
    const root = createTestProject();
    roots.push(root);
    const service = new BurnGraphService(root);
    service.applyGraph(loopGraph("lifecycle-race"));
    service.startRun("lifecycle-race", "lifecycle-race:run");
    service.close();

    const paused = await Promise.all(
      Array.from({ length: 2 }, () =>
        invoke(root, [
          "run",
          "pause",
          "lifecycle-race:run",
          "--idempotency-key",
          "pause-race-key",
        ]),
      ),
    );
    expect(paused.every((result) => result.exitCode === 0)).toBe(true);
    expect(
      paused
        .map((result) => JSON.parse(result.stdout).data.replayed)
        .sort(),
    ).toEqual([false, true]);

    const conflicting = await invoke(root, [
      "run",
      "cancel",
      "lifecycle-race:run",
      "--idempotency-key",
      "pause-race-key",
    ]);
    expect(conflicting.exitCode).toBe(1);
    expect(JSON.parse(conflicting.stderr).error.code).toBe(
      "IDEMPOTENCY_KEY_CONFLICT",
    );

    const resumed = await Promise.all(
      Array.from({ length: 2 }, () =>
        invoke(root, [
          "run",
          "resume",
          "lifecycle-race:run",
          "--actor",
          "lifecycle-actor",
          "--idempotency-key",
          "resume-race-key",
        ]),
      ),
    );
    expect(resumed.every((result) => result.exitCode === 0)).toBe(true);
    expect(
      resumed
        .map((result) => JSON.parse(result.stdout).data.replayed)
        .sort(),
    ).toEqual([false, true]);
    expect(
      resumed.map(
        (result) =>
          JSON.parse(result.stdout).data.assignments[0]?.assignmentId,
      ),
    ).toEqual([
      JSON.parse(resumed[0]!.stdout).data.assignments[0].assignmentId,
      JSON.parse(resumed[0]!.stdout).data.assignments[0].assignmentId,
    ]);

    const firstAssignment =
      JSON.parse(resumed[0]!.stdout).data.assignments[0];
    await invoke(
      root,
      [
        "done",
        "--assignment",
        firstAssignment.assignmentId,
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Advance beyond the first resume response.",
        evidence: [],
      }),
    );
    const beforeReplay = new BurnGraphService(root);
    const replayBaseline = {
      revision: beforeReplay.getSnapshot("lifecycle-race:run").summary
        .runtimeRevision,
      events: beforeReplay.listEvents("lifecycle-race:run").length,
    };
    beforeReplay.close();
    const lateReplay = await invoke(root, [
      "run",
      "resume",
      "lifecycle-race:run",
      "--actor",
      "lifecycle-actor",
      "--idempotency-key",
      "resume-race-key",
    ]);
    expect(lateReplay.exitCode, lateReplay.stderr).toBe(0);
    expect(JSON.parse(lateReplay.stdout).data).toMatchObject({
      replayed: true,
      assignments: [{ assignmentId: firstAssignment.assignmentId }],
    });
    const actorConflict = await invoke(root, [
      "run",
      "resume",
      "lifecycle-race:run",
      "--actor",
      "other-actor",
      "--idempotency-key",
      "resume-race-key",
    ]);
    expect(actorConflict.exitCode).toBe(1);
    expect(JSON.parse(actorConflict.stderr).error.code).toBe(
      "IDEMPOTENCY_KEY_CONFLICT",
    );

    const persisted = new BurnGraphService(root);
    expect({
      revision: persisted.getSnapshot("lifecycle-race:run").summary
        .runtimeRevision,
      events: persisted.listEvents("lifecycle-race:run").length,
    }).toEqual(replayBaseline);
    expect(
      persisted
        .listEvents("lifecycle-race:run")
        .filter((event) => event.type === "run.paused"),
    ).toHaveLength(1);
    expect(
      persisted
        .listEvents("lifecycle-race:run")
        .filter((event) => event.type === "run.resumed"),
    ).toHaveLength(1);
    persisted.close();
  });

  test("tree and Mermaid inspection share one bounded read-only projection", async () => {
    const root = createTestProject();
    roots.push(root);
    const service = new BurnGraphService(root);
    service.applyGraph(wideGraph("tree-inspect", 2));
    service.startRun("tree-inspect", "tree-inspect:run");
    const before = {
      revision: service.getSnapshot("tree-inspect:run").summary.runtimeRevision,
      events: service.listEvents("tree-inspect:run").length,
    };
    service.close();

    const treeResult = await invoke(root, [
      "inspect",
      "tree",
      "tree-inspect:run",
      "--depth",
      "0",
      "--limit",
      "5",
      "--events",
      "1",
    ]);
    expect(treeResult.exitCode, treeResult.stderr).toBe(0);
    const tree = JSON.parse(treeResult.stdout);
    expect(tree).toMatchObject({
      command: "inspect.tree",
      data: {
        projection: {
          depth: 0,
          limit: 5,
          totalRuns: 1,
          renderedNodes: 5,
        },
      },
    });

    const mermaidResult = await invoke(root, [
      "inspect",
      "mermaid",
      "tree-inspect:run",
      "--scope",
      "tree",
      "--limit",
      "5",
    ]);
    expect(mermaidResult.exitCode, mermaidResult.stderr).toBe(0);
    const mermaid = JSON.parse(mermaidResult.stdout);
    expect(mermaid).toMatchObject({
      command: "inspect.mermaid",
      data: {
        scope: "tree",
        projection: { renderedNodes: 5 },
      },
    });
    expect(mermaid.data.source).toBe(tree.data.mermaid);

    const limited = await invoke(root, [
      "inspect",
      "tree",
      "tree-inspect:run",
      "--limit",
      "4",
    ]);
    expect(limited.exitCode).toBe(1);
    expect(JSON.parse(limited.stderr).error.code).toBe("PROJECTION_LIMIT");

    const persisted = new BurnGraphService(root);
    expect({
      revision: persisted.getSnapshot("tree-inspect:run").summary
        .runtimeRevision,
      events: persisted.listEvents("tree-inspect:run").length,
    }).toEqual(before);
    persisted.close();
  });

  test("two Next processes racing for one node return exactly one Assignment", async () => {
    const root = createTestProject();
    roots.push(root);
    const service = new BurnGraphService(root);
    service.applyGraph(loopGraph("next-race"));
    service.startRun("next-race", "next-race:run");
    service.close();

    const contenders = await Promise.all([
      invoke(root, [
        "next",
        "--actor",
        "racer-one",
      ]),
      invoke(root, [
        "next",
        "--actor",
        "racer-two",
      ]),
    ]);
    expect(
      contenders.every((result) => result.exitCode === 0),
      JSON.stringify(contenders),
    ).toBe(true);
    const envelopes = contenders.map((result) => JSON.parse(result.stdout));
    expect(
      envelopes
        .map((envelope) => envelope.data.assignments.length)
        .sort((left, right) => left - right),
    ).toEqual([0, 1]);
    expect(
      envelopes.flatMap((envelope) => envelope.data.assignments),
    ).toHaveLength(1);

    const persisted = new BurnGraphService(root);
    expect(
      persisted
        .listEvents("next-race:run", 0, 100)
        .filter((event) => event.type === "node.claimed"),
    ).toHaveLength(1);
    persisted.close();
  });

  test("concurrent Next calls cannot exceed one Actor's Assignment cap", async () => {
    const root = createTestProject();
    roots.push(root);
    const service = new BurnGraphService(root);
    service.applyGraph(wideGraph("next-cap"));
    service.startRun("next-cap", "next-cap:run");
    service.close();

    const contenders = await Promise.all(
      Array.from({ length: 4 }, () =>
        invoke(root, ["next", "--actor", "same-actor"]),
      ),
    );
    expect(contenders.every((result) => result.exitCode === 0)).toBe(true);

    const persisted = new BurnGraphService(root);
    expect(persisted.actorWork("same-actor").claimed).toHaveLength(8);
    expect(
      persisted
        .getSnapshot("next-cap:run", 0)
        .nodes.filter((node) => node.status === "running"),
    ).toHaveLength(8);
    persisted.close();
  });

  test("concurrent equivalent Done calls converge as one completion", async () => {
    const root = createTestProject();
    roots.push(root);
    const service = new BurnGraphService(root);
    service.applyGraph(loopGraph("done-race"));
    const assignment = service.startWithAssignments(
      "done-race",
      "same-actor",
      "done-race:run",
    ).assignments[0]!;
    service.close();
    const input = JSON.stringify({
      summary: "One stable completion.",
      evidence: ["race evidence"],
    });

    const contenders = await Promise.all(
      Array.from({ length: 4 }, () =>
        invoke(
          root,
          ["done", "--assignment", assignment.assignmentId, "--input", "-"],
          input,
        ),
      ),
    );
    expect(contenders.every((result) => result.exitCode === 0)).toBe(true);
    const replayed = contenders
      .map((result) => JSON.parse(result.stdout).data.replayed)
      .sort();
    expect(replayed).toEqual([false, true, true, true]);
    expect(
      new Set(
        contenders.map((result) =>
          JSON.parse(result.stdout).data.assignments
            .map((assignment: any) => assignment.assignmentId)
            .join(","),
        ),
      ).size,
    ).toBe(1);

    const persisted = new BurnGraphService(root);
    expect(
      persisted
        .listEvents("done-race:run", 0, 100)
        .filter(
          (event) =>
            event.type === "node.completed" && event.nodeId === "work",
        ),
    ).toHaveLength(1);
    persisted.close();
  });

  test("concurrent sibling Done calls retain both Assignment owners", async () => {
    const root = createTestProject();
    roots.push(root);
    const service = new BurnGraphService(root);
    service.applyGraph(wideGraph("sibling-done-race", 2));
    const assignments = service.startWithAssignments(
      "sibling-done-race",
      "same-actor",
      "sibling-done-race:run",
    ).assignments;
    service.close();

    const contenders = await Promise.all(
      assignments.map((assignment) =>
        invoke(
          root,
          ["done", "--assignment", assignment.assignmentId, "--input", "-"],
          JSON.stringify({
            summary: `Completed ${assignment.node.id}.`,
            evidence: [],
          }),
        ),
      ),
    );
    expect(
      contenders.every((result) => result.exitCode === 0),
      JSON.stringify(contenders),
    ).toBe(true);

    const persisted = new BurnGraphService(root);
    expect(persisted.getSnapshot("sibling-done-race:run").summary.status).toBe(
      "completed",
    );
    persisted.close();
  });

  test("concurrent dynamic Done creates one complete child set", async () => {
    const root = createTestProject();
    roots.push(root);
    const service = new BurnGraphService(root);
    service.applyGraph(childGraph());
    service.applyGraph(dynamicGraph());
    const planner = service.startWithAssignments(
      "concurrent-parent",
      "planner",
      "concurrent-parent:run",
    ).assignments[0]!;
    service.close();
    const input = JSON.stringify({
      summary: "Sealed two stable child Runs.",
      evidence: ["tests/integration/cli-concurrency.test.ts"],
      output: {
        children: [
          {
            graphId: "concurrent-child",
            revision: 1,
            runId: "concurrent-child:left",
          },
          {
            graphId: "concurrent-child",
            revision: 1,
            runId: "concurrent-child:right",
          },
        ],
      },
    });

    const contenders = await Promise.all(
      Array.from({ length: 4 }, () =>
        invoke(
          root,
          ["done", "--assignment", planner.assignmentId, "--input", "-"],
          input,
        ),
      ),
    );
    expect(
      contenders.every((result) => result.exitCode === 0),
      JSON.stringify(contenders),
    ).toBe(true);
    expect(
      contenders
        .map((result) => JSON.parse(result.stdout).data.replayed)
        .sort(),
    ).toEqual([false, true, true, true]);

    const persisted = new BurnGraphService(root);
    expect(
      persisted
        .listRuns()
        .map((run) => run.runId)
        .filter((runId) => runId.startsWith("concurrent-child:"))
        .sort(),
    ).toEqual(["concurrent-child:left", "concurrent-child:right"]);
    expect(
      persisted
        .listEvents("concurrent-parent:run")
        .filter(
          (event) =>
            event.type === "node.completed" && event.nodeId === "children",
        ),
    ).toHaveLength(1);
    persisted.close();
  });
});
