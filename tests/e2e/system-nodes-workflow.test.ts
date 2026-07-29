import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { CheckSpec } from "@burn-graph/core";

import {
  createTestDirectory,
  removeTestProject,
} from "../helpers/fixtures.ts";
import {
  durableWaitGraph,
  gateRepairGraph,
} from "../helpers/system-node-fixtures.ts";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cli = path.join(repositoryRoot, "dist", "burn-graph.js");
const roots: string[] = [];

async function invoke(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<any> {
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
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout);
}

function writeJson(root: string, name: string, value: unknown): string {
  const file = path.join(root, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function assignment(envelope: any, nodeId: string): any {
  const found = envelope.data.assignments.find(
    (candidate: any) => candidate.node.id === nodeId,
  );
  if (!found) throw new Error(`Missing Assignment ${nodeId}`);
  return found;
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("public System Node workflows", () => {
  test("rejects a known-bad fixture, returns repair, then passes the pinned Check", async () => {
    const root = createTestDirectory();
    roots.push(root);
    await invoke(root, ["init"]);
    writeFileSync(
      path.join(root, "check-fixture.ts"),
      "const value = await Bun.file('status.txt').text(); console.log(value.trim()); process.exit(value.trim() === 'good' ? 0 : 9);\n",
    );
    writeFileSync(path.join(root, "status.txt"), "bad-private-output\n");
    const check: CheckSpec = {
      schemaVersion: 1,
      id: "fixture-check",
      revision: 1,
      title: "Fixture Check",
      argv: ["bun", "check-fixture.ts"],
      cwd: ".",
      successExitCodes: [0],
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
      inheritEnv: ["PATH"],
      resources: ["fixture-check"],
    };
    const checkFile = writeJson(root, "check.json", check);
    const graphFile = writeJson(root, "gate.json", gateRepairGraph());
    await invoke(root, ["check", "validate", "--input", checkFile]);
    await invoke(root, ["check", "apply", "--input", checkFile]);
    await invoke(root, ["graph", "apply", "--input", graphFile]);

    const started = await invoke(root, [
      "run",
      "start",
      "public-gate",
      "--actor",
      "gate-ai",
      "--run-id",
      "public-gate-r1",
    ]);
    const first = assignment(started, "implement");
    const rejected = await invoke(
      root,
      ["done", "--assignment", first.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Seeded bad fixture.", evidence: [] }),
    );
    expect(rejected.data.system.gateExecutions).toBe(1);
    const review = assignment(rejected, "review");
    const repair = await invoke(
      root,
      ["done", "--assignment", review.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Machine evidence requires repair.",
        route: "repair",
        evidence: [],
      }),
    );
    const second = assignment(repair, "implement");
    writeFileSync(path.join(root, "status.txt"), "good\n");
    const accepted = await invoke(
      root,
      ["done", "--assignment", second.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Fixture repaired.", evidence: ["status.txt"] }),
    );
    expect(accepted.data.state).toBe("completed");
    expect(accepted.data.system.gateExecutions).toBe(1);

    const executions = await invoke(root, [
      "inspect",
      "executions",
      "public-gate-r1",
    ]);
    expect(
      executions.data.map((entry: any) => entry.classification).sort(),
    ).toEqual(["non_success", "success"]);
    expect(JSON.stringify(executions)).not.toContain("bad-private-output");
    const localOutput = await invoke(root, [
      "inspect",
      "executions",
      "public-gate-r1",
      "--include-output",
      "--output-bytes",
      "64",
    ]);
    expect(JSON.stringify(localOutput)).toContain("bad-private-output");
    expect(localOutput.data.every(
      (entry: any) => entry.output.retainedBytes <= 64,
    )).toBe(true);
    const resources = await invoke(root, [
      "inspect",
      "resources",
      "public-gate-r1",
    ]);
    expect(resources.data).toEqual([]);
  });

  test("restores one Wait Signal and returns its successor prompt on resolution", async () => {
    const root = createTestDirectory();
    roots.push(root);
    await invoke(root, ["init"]);
    const graphFile = writeJson(root, "wait.json", durableWaitGraph());
    await invoke(root, ["graph", "apply", "--input", graphFile]);
    const started = await invoke(root, [
      "run",
      "start",
      "public-wait",
      "--actor",
      "wait-ai",
      "--run-id",
      "public-wait-r1",
    ]);
    expect(started.data.waiting).toHaveLength(1);
    expect(assignment(started, "unrelated").node.id).toBe("unrelated");
    const signalId = started.data.waiting[0].signalId;

    const reopened = await invoke(root, [
      "inspect",
      "waits",
      "public-wait-r1",
    ]);
    expect(reopened.data[0]).toMatchObject({
      signalId,
      status: "waiting",
      routes: ["approved", "rejected"],
    });
    const resolved = await invoke(
      root,
      [
        "signal",
        "resolve",
        "--signal",
        signalId,
        "--route",
        "approved",
        "--actor",
        "wait-ai",
        "--idempotency-key",
        "public-approval-1",
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Approval accepted.",
        evidence: ["evidence/approval.json"],
      }),
    );
    const after = assignment(resolved, "after");
    expect(after.context.predecessors).toContainEqual(
      expect.objectContaining({
        nodeId: "wait",
        route: "approved",
        summary: "Approval accepted.",
      }),
    );
    const beforeReplay = await invoke(root, [
      "inspect",
      "run",
      "public-wait-r1",
      "--events",
      "100",
    ]);

    const replay = await invoke(
      root,
      [
        "signal",
        "resolve",
        "--signal",
        signalId,
        "--route",
        "approved",
        "--actor",
        "wait-ai",
        "--idempotency-key",
        "public-approval-1",
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Approval accepted.",
        evidence: ["evidence/approval.json"],
      }),
    );
    expect(replay.data.resolved.replayed).toBe(true);
    expect(replay.data.assignments.map((entry: any) => entry.assignmentId))
      .toContain(after.assignmentId);
    const afterReplay = await invoke(root, [
      "inspect",
      "run",
      "public-wait-r1",
      "--events",
      "100",
    ]);
    expect(afterReplay.data.summary.runtimeRevision).toBe(
      beforeReplay.data.summary.runtimeRevision,
    );
    expect(afterReplay.data.events.at(-1)?.sequence).toBe(
      beforeReplay.data.events.at(-1)?.sequence,
    );
  });
});
