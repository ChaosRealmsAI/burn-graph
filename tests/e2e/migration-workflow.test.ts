import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import packageMetadata from "../../package.json";
import { confinedInputArgs } from "../helpers/cli.ts";
import {
  createTestDirectory,
  parallelGraph,
  removeTestProject,
} from "../helpers/fixtures.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const dev4Archive = path.join(
  repositoryRoot,
  "dist",
  "releases",
  "burn-graph-0.1.0-dev.4.tgz",
);
const candidateArchive = path.join(
  repositoryRoot,
  "dist",
  "releases",
  `burn-graph-${packageMetadata.version}.tgz`,
);
const roots: string[] = [];

async function extractArchive(archive: string): Promise<string> {
  const root = createTestDirectory();
  roots.push(root);
  const child = Bun.spawn(["tar", "-xzf", archive, "-C", root], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return path.join(root, "package", "burn-graph.js");
}

async function invoke(
  executable: string,
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<any> {
  const child = Bun.spawn(
    [
      "bun",
      executable,
      "--root",
      root,
      ...confinedInputArgs(root, args),
    ],
    {
      cwd: root,
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe(`installed dev.4 to ${packageMetadata.version} migration`, () => {
  test("preserves nine Runs and ninety public events through the release archive", async () => {
    expect(existsSync(dev4Archive)).toBe(true);
    expect(existsSync(candidateArchive)).toBe(true);
    const dev4 = await extractArchive(dev4Archive);
    const candidate = await extractArchive(candidateArchive);
    const projectRoot = createTestDirectory();
    roots.push(projectRoot);
    await invoke(dev4, projectRoot, ["init"]);
    const graphFile = path.join(projectRoot, "legacy.json");
    const legacyGraph = parallelGraph("legacy-migration");
    writeFileSync(
      graphFile,
      `${JSON.stringify(
        {
          ...legacyGraph,
          nodes: legacyGraph.nodes.map((node) => ({
            ...node,
            prompt: {
              objective: node.prompt.objective,
              instructions: node.prompt.instructions,
              mustRead: node.prompt.mustRead,
              doneWhen: node.prompt.doneWhen,
              outputSchema: node.prompt.outputSchema,
            },
          })),
        },
        null,
        2,
      )}\n`,
    );
    await invoke(dev4, projectRoot, [
      "graph",
      "apply",
      "--input",
      graphFile,
    ]);

    const beforeRuns: any[] = [];
    const beforeAttempts: any[] = [];
    for (let index = 1; index <= 9; index += 1) {
      const runId = `legacy-migration:run:${index}`;
      const started = await invoke(dev4, projectRoot, [
        "run",
        "start",
        "legacy-migration",
        "--actor",
        "legacy-actor",
        "--run-id",
        runId,
      ]);
      const left = started.data.assignments.find(
        (assignment: any) => assignment.node.id === "left",
      );
      const right = started.data.assignments.find(
        (assignment: any) => assignment.node.id === "right",
      );
      for (const assignment of [left, right, left, right]) {
        await invoke(dev4, projectRoot, [
          "recover",
          "heartbeat",
          "--assignment",
          assignment.assignmentId,
        ]);
      }
      await invoke(dev4, projectRoot, [
        "focus",
        "--assignment",
        left.assignmentId,
      ]);
      for (const assignment of [left, right]) {
        await invoke(
          dev4,
          projectRoot,
          [
            "done",
            "--assignment",
            assignment.assignmentId,
            "--input",
            "-",
          ],
          JSON.stringify({
            summary: `Completed ${runId}/${assignment.node.id}.`,
            evidence: ["tests/e2e/migration-workflow.test.ts"],
          }),
        );
      }
      const snapshot = await invoke(dev4, projectRoot, [
        "inspect",
        "run",
        runId,
        "--events",
        "100",
      ]);
      expect(snapshot.data.summary.status).toBe("completed");
      expect(snapshot.data.events).toHaveLength(10);
      beforeRuns.push(snapshot.data);
      beforeAttempts.push(
        (
          await invoke(dev4, projectRoot, [
            "inspect",
            "node",
            runId,
            "left",
            "--events",
            "100",
          ])
        ).data.attempts,
      );
    }
    const beforeEvents = (
      await invoke(dev4, projectRoot, [
        "inspect",
        "events",
        "--limit",
        "1000",
      ])
    ).data;
    expect(beforeEvents).toHaveLength(90);
    const graphBytes = readFileSync(
      path.join(
        projectRoot,
        ".burn-graph",
        "graphs",
        "legacy-migration.json",
      ),
      "utf8",
    );

    const migratedEvents = (
      await invoke(candidate, projectRoot, [
        "inspect",
        "events",
        "--limit",
        "1000",
      ])
    ).data;
    expect(migratedEvents).toEqual(beforeEvents);
    expect(
      readFileSync(
        path.join(
          projectRoot,
          ".burn-graph",
          "graphs",
          "legacy-migration.json",
        ),
        "utf8",
      ),
    ).toBe(graphBytes);

    for (let index = 1; index <= 9; index += 1) {
      const runId = `legacy-migration:run:${index}`;
      const migrated = (
        await invoke(candidate, projectRoot, [
          "inspect",
          "run",
          runId,
          "--events",
          "100",
        ])
      ).data;
      const before = beforeRuns[index - 1]!;
      expect(migrated.summary).toMatchObject({
        runId: before.summary.runId,
        graphId: before.summary.graphId,
        specRevision: before.summary.specRevision,
        runtimeRevision: before.summary.runtimeRevision,
        status: before.summary.status,
        counts: before.summary.counts,
        parentRunId: null,
        parentNodeId: null,
        rootRunId: runId,
        depth: 0,
        priority: "normal",
        createdAt: before.summary.createdAt,
        updatedAt: before.summary.updatedAt,
      });
      expect(migrated.nodes).toEqual(before.nodes);
      expect(migrated.edges).toEqual(before.edges);
      expect(migrated.events).toEqual(before.events);
      expect(
        (
          await invoke(candidate, projectRoot, [
            "inspect",
            "node",
            runId,
            "left",
            "--events",
            "100",
          ])
        ).data.attempts,
      ).toEqual(beforeAttempts[index - 1]);
    }
  }, 90_000);
});
