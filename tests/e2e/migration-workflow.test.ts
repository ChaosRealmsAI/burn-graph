import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  "tests",
  "fixtures",
  "releases",
  "burn-graph-0.1.0-dev.4.tgz",
);
// Golden CLI built from repository commit 531ce12, the final dev.4 source.
// Pinning its bytes keeps the migration Oracle independent of generated dist/.
const DEV4_ARCHIVE_SHA256 =
  "c1bba3acb4acb3a8a31108a85691237b9d2d10f2b92724329ca8aaa871081546";
const candidateArchive = path.join(
  repositoryRoot,
  "dist",
  "releases",
  `burn-graph-${packageMetadata.version}.tgz`,
);
const roots: string[] = [];
// The legacy fixture's size is derived, never restated: the run count drives
// the loop and every expected total is summed from what dev.4 actually wrote.
const LEGACY_RUN_COUNT = 9;

// Proof that nothing was read or written through the legacy root: SQLite would
// rewrite its WAL on any open, so the digest covers every byte and name.
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`D ${relative}\n`);
        walk(full, `${relative}/`);
        continue;
      }
      hash.update(`F ${relative} `);
      hash.update(readFileSync(full));
      hash.update("\n");
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

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

async function invokeFailure(
  executable: string,
  root: string,
  args: readonly string[],
): Promise<any> {
  const child = Bun.spawn(
    ["bun", executable, "--root", root, ...confinedInputArgs(root, args)],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stdout).toBe(1);
  const envelope = JSON.parse(stderr);
  expect(envelope).toMatchObject({ schemaVersion: 1, ok: false });
  return envelope;
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe(`installed dev.4 state under ${packageMetadata.version}`, () => {
  test("refuses the legacy root untouched and only re-registers specifications", async () => {
    expect(existsSync(dev4Archive)).toBe(true);
    expect(existsSync(candidateArchive)).toBe(true);
    expect(createHash("sha256").update(readFileSync(dev4Archive)).digest("hex"))
      .toBe(DEV4_ARCHIVE_SHA256);
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

    let legacyEventCount = 0;
    for (let index = 1; index <= LEGACY_RUN_COUNT; index += 1) {
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
      legacyEventCount += snapshot.data.events.length;
    }
    const legacyEvents = (
      await invoke(dev4, projectRoot, [
        "inspect",
        "events",
        "--limit",
        "1000",
      ])
    ).data;
    expect(legacyEvents).toHaveLength(legacyEventCount);
    const legacyState = path.join(projectRoot, ".burn-graph");
    expect(existsSync(path.join(legacyState, "config.json"))).toBe(true);
    const untouched = treeDigest(legacyState);

    // The 3.0 break: the candidate never adopts, reads, or repairs dev.4 state.
    for (const args of [["inspect", "overview"], ["inspect", "events"], ["doctor"], ["next", "--actor", "legacy-actor"]]) {
      const refused = await invokeFailure(candidate, projectRoot, args);
      expect(refused.error.code).toBe("LEGACY_STATE_ROOT");
      expect(refused.error.message).toContain(".burn-graph");
      expect(refused.error.message).toContain(".burn/graph");
      expect(refused.recoveryActions.map((action: any) => action.command)).toContain(
        "burn-graph init",
      );
    }
    expect(treeDigest(legacyState)).toBe(untouched);

    // The documented remediation, executed exactly as the error states it.
    await invoke(candidate, projectRoot, ["init"]);
    expect(
      existsSync(path.join(projectRoot, ".burn", "graph", "config.json")),
    ).toBe(true);
    expect(
      readFileSync(path.join(projectRoot, ".gitignore"), "utf8")
        .split("\n")
        .filter((line) => line === ".burn/graph/runtime/"),
    ).toHaveLength(1);
    expect(treeDigest(legacyState)).toBe(untouched);

    const reapplied = await invoke(candidate, projectRoot, [
      "graph",
      "apply",
      "--input",
      path.join(".burn-graph", "graphs", "legacy-migration.json"),
    ]);
    expect(reapplied.data.path).toBe(".burn/graph/graphs/legacy-migration.json");
    const overview = await invoke(candidate, projectRoot, ["inspect", "overview"]);
    expect(overview.data.totals.graphs).toBe(1);
    // Run history stays behind with the legacy root; only specifications carry
    // across, which is what the error message promises and nothing more.
    expect(overview.data.runs).toHaveLength(0);
    const doctor = await invoke(candidate, projectRoot, ["doctor"]);
    expect(doctor.data.graphCount).toBe(1);
    expect(doctor.data.runCount).toBe(0);
    expect(doctor.data.legacyStateRoot).toBe(".burn-graph");
    expect(
      (await invoke(candidate, projectRoot, ["inspect", "events", "--limit", "1000"]))
        .data,
    ).toHaveLength(0);
    expect(treeDigest(legacyState)).toBe(untouched);
  }, 120_000);
});
