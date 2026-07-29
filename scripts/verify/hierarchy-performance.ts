// Purpose: Measure bounded folded hierarchy and expanded graph projections.
// Usage: bun scripts/verify/hierarchy-performance.ts
// Notes: Uses five warm in-process samples and fails when either tail reaches one second.

import {
  BurnGraphService,
  type ChildRunDescriptor,
  type GraphSpec,
} from "@burn-graph/core";

import {
  createTestProject,
  prompt,
  removeTestProject,
} from "../../tests/helpers/fixtures.ts";

interface ProjectionSample {
  readonly milliseconds: number;
  readonly renderedNodes: number;
  readonly totalRuns: number;
}

function singleTaskGraph(id: string): GraphSpec {
  return {
    schemaVersion: 1,
    id,
    title: `${id} task`,
    goal: `Complete ${id}.`,
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
        prompt: prompt(`Complete ${id}.`),
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

function staticParentGraph(
  id: string,
  children: readonly ChildRunDescriptor[],
): GraphSpec {
  return {
    schemaVersion: 2,
    id,
    title: `${id} parent`,
    goal: `Converge ${id} child Runs.`,
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
        title: "Children",
        prompt: prompt(""),
        next: [
          { to: "end", route: "success" },
          { to: "failed", route: "failure" },
          { to: "cancelled", route: "cancelled" },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: ["hierarchy"],
        mode: "static",
        children: [...children],
        resources: [],
      },
      {
        id: "failed",
        type: "task",
        title: "Repair failed child",
        prompt: prompt("Repair the failed child outcome."),
        next: [{ to: "end" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      {
        id: "cancelled",
        type: "task",
        title: "Handle cancelled child",
        prompt: prompt("Handle the cancelled child outcome."),
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

function linearGraph(id: string, nodeCount: number): GraphSpec {
  const taskCount = nodeCount - 2;
  return {
    schemaVersion: 1,
    id,
    title: `${id} linear projection`,
    goal: `Project exactly ${nodeCount} nodes.`,
    revision: 1,
    maxActive: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        title: "Start",
        prompt: prompt(""),
        next: [{ to: "task-0" }],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      },
      ...Array.from({ length: taskCount }, (_, index) => ({
        id: `task-${index}`,
        type: "task" as const,
        title: `Task ${index}`,
        prompt: prompt(`Complete task ${index}.`),
        next: [
          {
            to: index === taskCount - 1 ? "end" : `task-${index + 1}`,
          },
        ],
        maxAttempts: 1,
        actorHint: null,
        tags: [],
      })),
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

function sampleProjection(
  operation: () => ReturnType<BurnGraphService["getTreeSnapshot"]>,
): ProjectionSample {
  const startedAt = performance.now();
  const snapshot = operation();
  return {
    milliseconds: performance.now() - startedAt,
    renderedNodes: snapshot.projection.renderedNodes,
    totalRuns: snapshot.projection.totalRuns,
  };
}

function summarize(samples: readonly ProjectionSample[]) {
  const ordered = samples
    .map((sample) => sample.milliseconds)
    .sort((left, right) => left - right);
  return {
    count: ordered.length,
    p50Milliseconds: Number(ordered[2]!.toFixed(3)),
    p95Milliseconds: Number(ordered[4]!.toFixed(3)),
    maxMilliseconds: Number(ordered[4]!.toFixed(3)),
  };
}

const root = createTestProject();
const service = new BurnGraphService(root);

try {
  service.applyGraph(singleTaskGraph("projection-shared-leaf"));
  const branches: ChildRunDescriptor[] = [];
  for (let branch = 0; branch < 15; branch += 1) {
    const graphId = `projection-branch-${branch}`;
    service.applyGraph(
      staticParentGraph(
        graphId,
        Array.from({ length: 16 }, (_, leaf) => ({
          graphId: "projection-shared-leaf",
          revision: 1,
          runId: `projection-leaf-${branch}-${leaf}`,
          label: `leaf ${branch}/${leaf}`,
        })),
      ),
    );
    branches.push({
      graphId,
      revision: 1,
      runId: `projection-branch-run-${branch}`,
      label: `branch ${branch}`,
    });
  }
  service.applyGraph(
    staticParentGraph("projection-portfolio", branches),
  );
  service.startRun("projection-portfolio", "projection-portfolio-run");
  const folded = Array.from({ length: 5 }, () =>
    sampleProjection(() =>
      service.getTreeSnapshot(
        "projection-portfolio-run",
        0,
        500,
        0,
      ),
    ),
  );

  service.applyGraph(linearGraph("projection-500", 500));
  service.startRun("projection-500", "projection-500-run");
  const expanded = Array.from({ length: 5 }, () =>
    sampleProjection(() =>
      service.getTreeSnapshot("projection-500-run", 0, 500, 0),
    ),
  );

  const summaries = {
    folded256Runs: summarize(folded),
    expanded500Nodes: summarize(expanded),
  };
  for (const [name, summary] of Object.entries(summaries)) {
    if (summary.maxMilliseconds >= 1_000) {
      throw new Error(`${name} exceeded the 1000 ms tail budget`);
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ok: true,
        command: "verify.hierarchy-performance",
        data: {
          samples: {
            folded256Runs: folded,
            expanded500Nodes: expanded,
          },
          summaries,
          budget: {
            maximumMilliseconds: 1_000,
            sampleCount: 5,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  service.close();
  removeTestProject(root);
}
