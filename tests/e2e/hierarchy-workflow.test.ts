import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createTestDirectory,
  prompt,
  removeTestProject,
} from "../helpers/fixtures.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const distCli = path.join(repositoryRoot, "dist", "burn-graph.js");
const archiveFile = path.join(
  repositoryRoot,
  "dist",
  "releases",
  "burn-graph-0.1.0-dev.7.tgz",
);
const roots: string[] = [];
const preserveEvidenceFixture =
  process.env.BURN_GRAPH_PRESERVE_UP06_FIXTURE === "1";

async function invokeCli(
  executable: string,
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<any> {
  const child = Bun.spawn(["bun", executable, "--root", root, ...args], {
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
  expect(exitCode, stderr).toBe(0);
  const envelope = JSON.parse(stdout);
  expect(envelope).toMatchObject({ schemaVersion: 1, ok: true });
  return envelope;
}

function writeGraph(root: string, name: string, graph: unknown): string {
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(graph, null, 2)}\n`);
  return file;
}

function leafGraph() {
  return {
    schemaVersion: 1,
    id: "hierarchy-leaf",
    title: "Hierarchy leaf",
    goal: "Complete one independently scheduled leaf.",
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
        title: "Leaf work",
        prompt: prompt("Complete and verify this leaf."),
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

function middleGraph() {
  return {
    schemaVersion: 2,
    id: "hierarchy-middle",
    title: "Hierarchy middle",
    goal: "Converge one second-depth child.",
    revision: 1,
    maxActive: 1,
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
        title: "Deep child",
        prompt: prompt(""),
        next: [{ to: "end", route: "success" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
        mode: "static",
        children: [
          {
            graphId: "hierarchy-leaf",
            revision: 1,
            runId: "hierarchy-deep-leaf:run",
            label: "deep leaf",
          },
        ],
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

function rootGraph() {
  return {
    schemaVersion: 2,
    id: "hierarchy-root",
    title: "Hierarchical delivery",
    goal: "Converge static and dynamically planned children at two depths.",
    revision: 1,
    maxActive: 4,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "static" }, { to: "dynamic" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "static",
        type: "subgraph",
        title: "Static child",
        prompt: prompt(""),
        next: [{ to: "join", route: "success" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
        mode: "static",
        children: [
          {
            graphId: "hierarchy-middle",
            revision: 1,
            runId: "hierarchy-middle:run",
            label: "middle",
          },
        ],
        resources: [],
      },
      {
        id: "dynamic",
        type: "subgraph",
        title: "Dynamic children",
        prompt: prompt("Return two exact child Runs."),
        next: [{ to: "join", route: "success" }],
        maxAttempts: 1,
        actorHint: "hierarchy-ai",
        tags: [],
        mode: "dynamic",
        minChildren: 2,
        maxChildren: 2,
        resources: [],
      },
      {
        id: "join",
        type: "join",
        title: "Join",
        prompt: prompt(""),
        next: [{ to: "finish" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "finish",
        type: "task",
        title: "Finish root",
        prompt: prompt("Verify the converged hierarchy."),
        next: [{ to: "end" }],
        maxAttempts: 1,
        actorHint: "hierarchy-ai",
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

afterEach(() => {
  if (preserveEvidenceFixture) return;
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("installed-shape hierarchical workflow", () => {
  async function verifyHierarchyWorkflow(executable: string): Promise<void> {
    const invoke = (
      root: string,
      args: readonly string[],
      stdin?: string,
    ) => invokeCli(executable, root, args, stdin);
    const root = createTestDirectory();
    roots.push(root);
    await invoke(root, ["init"]);
    for (const [name, graph] of [
      ["leaf", leafGraph()],
      ["middle", middleGraph()],
      ["root", rootGraph()],
    ] as const) {
      await invoke(root, [
        "graph",
        "apply",
        "--input",
        writeGraph(root, name, graph),
      ]);
    }

    const started = await invoke(root, [
      "run",
      "start",
      "hierarchy-root",
      "--actor",
      "hierarchy-ai",
      "--run-id",
      "hierarchy-root:run",
    ]);
    const planner = started.data.assignments.find(
      (assignment: any) =>
        assignment.graph.runId === "hierarchy-root:run" &&
        assignment.node.id === "dynamic",
    );
    expect(planner).toBeDefined();
    const plan = JSON.stringify({
      summary: "Planned two stable leaf Runs.",
      evidence: ["tests/e2e/hierarchy-workflow.test.ts"],
      output: {
        children: [
          {
            graphId: "hierarchy-leaf",
            revision: 1,
            runId: "hierarchy-dynamic-left:run",
            label: "dynamic left",
          },
          {
            graphId: "hierarchy-leaf",
            revision: 1,
            runId: "hierarchy-dynamic-right:run",
            label: "dynamic right",
          },
        ],
      },
    });
    const planned = await invoke(
      root,
      ["done", "--assignment", planner.assignmentId, "--input", "-"],
      plan,
    );
    expect(planned.data.replayed).toBe(false);
    const replay = await invoke(
      root,
      ["done", "--assignment", planner.assignmentId, "--input", "-"],
      plan,
    );
    expect(replay.data.replayed).toBe(true);

    for (let turn = 0; turn < 20; turn += 1) {
      const snapshot = await invoke(root, [
        "inspect",
        "run",
        "hierarchy-root:run",
        "--events",
        "1",
      ]);
      if (snapshot.data.summary.status === "completed") break;
      let current = await invoke(root, [
        "current",
        "--actor",
        "hierarchy-ai",
      ]);
      if (current.data.assignments.length === 0) {
        current = await invoke(root, ["next", "--actor", "hierarchy-ai"]);
      }
      expect(current.data.assignments.length).toBeGreaterThan(0);
      for (const assignment of current.data.assignments) {
        await invoke(
          root,
          ["done", "--assignment", assignment.assignmentId, "--input", "-"],
          JSON.stringify({
            summary: `Completed ${assignment.graph.runId}/${assignment.node.id}.`,
            evidence: ["tests/e2e/hierarchy-workflow.test.ts"],
          }),
        );
      }
    }

    const completed = await invoke(root, [
      "inspect",
      "run",
      "hierarchy-root:run",
      "--events",
      "100",
    ]);
    expect(completed.data.summary.status).toBe("completed");
    const beforeReadOnly = {
      revision: completed.data.summary.runtimeRevision,
      events: completed.data.events.length,
    };
    const folded = await invoke(root, [
      "inspect",
      "tree",
      "hierarchy-root:run",
      "--depth",
      "0",
      "--limit",
      "500",
    ]);
    const expanded = await invoke(root, [
      "inspect",
      "tree",
      "hierarchy-root:run",
      "--depth",
      "1",
      "--limit",
      "500",
    ]);
    expect(folded.data.projection).toMatchObject({
      totalRuns: 5,
      expandedRuns: 1,
      foldedRuns: 4,
      renderedNodes: 9,
    });
    expect(expanded.data.projection).toMatchObject({
      totalRuns: 5,
      expandedRuns: 4,
      foldedRuns: 1,
      renderedNodes: 16,
    });
    expect(
      expanded.data.runs.every(
        (entry: any) => entry.summary.status === "completed",
      ),
    ).toBe(true);
    const mermaid = await invoke(root, [
      "inspect",
      "mermaid",
      "hierarchy-root:run",
      "--scope",
      "tree",
      "--depth",
      "1",
    ]);
    expect(mermaid.data.source).toBe(expanded.data.mermaid);

    const svg = await invoke(root, [
      "render",
      "hierarchy-root:run",
      "--scope",
      "tree",
      "--depth",
      "1",
      "--format",
      "svg",
    ]);
    const png = await invoke(root, [
      "render",
      "hierarchy-root:run",
      "--scope",
      "tree",
      "--depth",
      "1",
      "--format",
      "png",
    ]);
    expect(svg.data).toMatchObject({
      scope: "tree",
      projectionDepth: 1,
      format: "svg",
    });
    expect(png.data).toMatchObject({
      scope: "tree",
      projectionDepth: 1,
      format: "png",
    });
    expect(existsSync(path.resolve(root, svg.data.artifact))).toBe(true);
    expect(existsSync(path.resolve(root, png.data.artifact))).toBe(true);

    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("probe"),
    });
    const port = probe.port;
    probe.stop(true);
    await invoke(root, [
      "viewer",
      "start",
      "hierarchy",
      "--port",
      String(port),
    ]);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/trees/${encodeURIComponent("hierarchy-root:run")}?depth=1&limit=500`,
      );
      expect(response.status).toBe(200);
      const envelope = (await response.json()) as any;
      expect(envelope.data.projection).toMatchObject({
        depth: expanded.data.projection.depth,
        maximumDepth: expanded.data.projection.maximumDepth,
        limit: expanded.data.projection.limit,
        totalRuns: expanded.data.projection.totalRuns,
        expandedRuns: expanded.data.projection.expandedRuns,
        foldedRuns: expanded.data.projection.foldedRuns,
        renderedNodes: expanded.data.projection.renderedNodes,
        lastEventSequence: expanded.data.projection.lastEventSequence,
      });
      expect(envelope.data.mermaid).toBe(expanded.data.mermaid);
      if (preserveEvidenceFixture) {
        process.stdout.write(
          `BURN_GRAPH_EVIDENCE_FIXTURE=${JSON.stringify({
            projectRoot: root,
            executable,
            viewerInstance: "hierarchy",
            viewerUrl: `http://127.0.0.1:${port}`,
            runId: "hierarchy-root:run",
            svgArtifact: path.resolve(root, svg.data.artifact),
            pngArtifact: path.resolve(root, png.data.artifact),
          })}\n`,
        );
      }
    } finally {
      if (!preserveEvidenceFixture) {
        await invoke(root, ["viewer", "stop", "hierarchy"]);
      }
    }

    const afterReadOnly = await invoke(root, [
      "inspect",
      "run",
      "hierarchy-root:run",
      "--events",
      "100",
    ]);
    expect({
      revision: afterReadOnly.data.summary.runtimeRevision,
      events: afterReadOnly.data.events.length,
    }).toEqual(beforeReadOnly);
  }

  test("converges UP06 from the source distribution", async () => {
    await verifyHierarchyWorkflow(distCli);
  }, 90_000);

  test("converges UP06 from the isolated release archive", async () => {
    expect(existsSync(archiveFile)).toBe(true);
    const extractionRoot = createTestDirectory();
    roots.push(extractionRoot);
    const extraction = Bun.spawn(
      ["tar", "-xzf", archiveFile, "-C", extractionRoot],
      {
        cwd: extractionRoot,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      extraction.exited,
      new Response(extraction.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    await verifyHierarchyWorkflow(
      path.join(extractionRoot, "package", "burn-graph.js"),
    );
  }, 90_000);
});
