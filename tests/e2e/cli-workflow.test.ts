import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  createTestDirectory,
  loopGraph,
  parallelGraph,
  removeTestProject,
} from "../helpers/fixtures.ts";

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope: any;
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cli = path.join(repositoryRoot, "dist", "burn-graph.js");
const roots: string[] = [];

async function invoke(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<CliResult> {
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
  const serialized = (exitCode === 0 ? stdout : stderr).trim();
  return {
    exitCode,
    stdout,
    stderr,
    envelope: JSON.parse(serialized),
  };
}

async function ok(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<any> {
  const result = await invoke(root, args, stdin);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.envelope).toMatchObject({
    schemaVersion: 1,
    ok: true,
  });
  return result.envelope;
}

async function fail(
  root: string,
  args: readonly string[],
  stdin?: string,
): Promise<any> {
  const result = await invoke(root, args, stdin);
  expect(result.exitCode).toBe(1);
  expect(result.envelope).toMatchObject({
    schemaVersion: 1,
    ok: false,
  });
  return result.envelope;
}

function writeGraph(root: string, name: string, graph: unknown): string {
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(graph, null, 2)}\n`);
  return file;
}

function assignment(envelope: any, graphId: string, nodeId: string): any {
  const found = envelope.data.assignments.find(
    (candidate: any) =>
      candidate.graph.graphId === graphId && candidate.node.id === nodeId,
  );
  if (!found) throw new Error(`Missing Assignment ${graphId}/${nodeId}`);
  return found;
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("converged public CLI", () => {
  test("progressively discloses JSON Help and rejects removed commands", async () => {
    const root = createTestDirectory();
    roots.push(root);

    const rootHelp = await ok(root, ["--help"]);
    expect(rootHelp.command).toBe("help");
    expect(rootHelp.data.groups.execute).toEqual([
      "run",
      "next",
      "current",
      "focus",
      "done",
    ]);
    expect(
      rootHelp.data.commands.map((command: any) => command.name),
    ).not.toContain("work");
    for (const command of rootHelp.data.commands) {
      const disclosed = await ok(root, [command.name, "--help"]);
      expect(["area", "command"]).toContain(disclosed.data.kind);
      if (disclosed.data.kind === "area") {
        for (const child of disclosed.data.commands) {
          expect(
            (await ok(root, [command.name, child.name, "--help"])).data.kind,
          ).toBe("command");
        }
      }
    }

    const areaHelp = await ok(root, ["inspect", "--help"]);
    expect(areaHelp.data.kind).toBe("area");
    expect(
      areaHelp.data.commands.map((command: any) => command.name),
    ).toEqual([
      "overview",
      "run",
      "tree",
      "node",
      "ready",
      "mermaid",
      "events",
    ]);

    const commandHelp = await ok(root, ["done", "--help"]);
    expect(commandHelp.data).toMatchObject({
      topic: "done",
      kind: "command",
      mutates: true,
    });
    expect(commandHelp.data.errors).toContain("ASSIGNMENT_INPUT_CONFLICT");

    const topicHelp = await ok(root, ["help", "ai-loop"]);
    expect(topicHelp.data.content.sequence).toContain(
      "burn-graph done --assignment <id> --input -",
    );
    expect((await ok(root, ["help", "inspect"])).data.kind).toBe("topic");
    expect((await ok(root, ["help", "recover"])).data.kind).toBe("topic");
    const missingDoneInput = await fail(root, ["done"]);
    expect(missingDoneInput.command).toBe("done");
    expect(missingDoneInput.recoveryActions[0].command).toBe(
      "burn-graph done --help",
    );
    const version = await ok(root, ["--version"]);
    expect(version.data.version).toBe("0.1.0-dev.5");

    for (const removed of [
      ["work", "--help"],
      ["events", "list"],
      ["mermaid", "anything"],
      ["serve"],
      ["run", "list"],
      ["run", "show", "anything"],
    ]) {
      const rejected = await fail(root, removed);
      expect(["HELP_TOPIC_NOT_FOUND", "INVALID_ARGUMENTS"]).toContain(
        rejected.error.code,
      );
    }
  });

  test("starts, injects, loops, and completes parallel multi-Graph work", async () => {
    const root = createTestDirectory();
    roots.push(root);
    await ok(root, ["init"]);

    const loopFile = writeGraph(root, "loop", loopGraph("guarded-loop"));
    const parallelFile = writeGraph(
      root,
      "parallel",
      parallelGraph("guarded-parallel"),
    );
    await ok(root, ["graph", "validate", "--input", loopFile]);
    await ok(root, ["graph", "apply", "--input", loopFile]);
    await ok(root, ["graph", "apply", "--input", parallelFile]);

    const loopStart = await ok(root, [
      "run",
      "start",
      "guarded-loop",
      "--actor",
      "primary",
      "--run-id",
      "guarded-loop:e2e",
    ]);
    const firstWork = assignment(loopStart, "guarded-loop", "work");
    expect(firstWork).toMatchObject({
      schemaVersion: 1,
      projectId: path.basename(root),
      node: {
        id: "work",
        type: "task",
        attempt: 1,
        prompt: {
          objective: "Produce a verified result.",
        },
      },
      claim: { actorId: "primary" },
    });
    expect(firstWork.returnProtocol.complete).toBe(
      `burn-graph done --assignment ${firstWork.assignmentId} --input -`,
    );

    const parallelStart = await ok(root, [
      "run",
      "start",
      "guarded-parallel",
      "--actor",
      "primary",
      "--run-id",
      "guarded-parallel:e2e",
    ]);
    expect(parallelStart.data.assignments).toHaveLength(3);
    const left = assignment(parallelStart, "guarded-parallel", "left");
    const right = assignment(parallelStart, "guarded-parallel", "right");

    const current = await ok(root, ["current", "--actor", "primary"]);
    expect(current.data.assignments).toHaveLength(3);
    const focused = await ok(root, [
      "focus",
      "--assignment",
      left.assignmentId,
    ]);
    expect(focused.data.assignmentId).toBe(left.assignmentId);
    await ok(
      root,
      [
        "recover",
        "checkpoint",
        "--assignment",
        left.assignmentId,
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Left is verified.",
        progress: 80,
        artifacts: ["left evidence"],
      }),
    );

    const afterLeft = await ok(
      root,
      ["done", "--assignment", left.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Left complete.",
        evidence: ["left evidence"],
      }),
    );
    expect(afterLeft.data.assignments.map((item: any) => item.node.id).sort())
      .toEqual(["right", "work"]);

    const afterDraft = await ok(
      root,
      ["done", "--assignment", firstWork.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Draft ready.",
        evidence: ["draft evidence"],
      }),
    );
    const firstReview = assignment(afterDraft, "guarded-loop", "decide");
    expect(firstReview.node.routes).toEqual([
      {
        route: "pass",
        to: "end",
        label: "accepted",
        remainingTraversals: null,
      },
      {
        route: "repair",
        to: "work",
        label: "repair required",
        remainingTraversals: 2,
      },
    ]);

    const afterRepair = await ok(
      root,
      ["done", "--assignment", firstReview.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Repair required.",
        route: "repair",
        evidence: ["review finding"],
      }),
    );
    const secondWork = assignment(afterRepair, "guarded-loop", "work");
    expect(secondWork.node.attempt).toBe(2);
    expect(secondWork.context.predecessors).toContainEqual(
      expect.objectContaining({
        nodeId: "decide",
        attempt: 1,
        route: "repair",
        summary: "Repair required.",
        evidence: ["review finding"],
      }),
    );

    const afterSecondWork = await ok(
      root,
      ["done", "--assignment", secondWork.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Repair verified.",
        evidence: ["repair evidence"],
      }),
    );
    const secondReview = assignment(
      afterSecondWork,
      "guarded-loop",
      "decide",
    );
    expect(secondReview.node.attempt).toBe(2);

    await ok(
      root,
      ["done", "--assignment", secondReview.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Accepted.",
        route: "pass",
        evidence: ["acceptance evidence"],
      }),
    );
    const completed = await ok(
      root,
      ["done", "--assignment", right.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Right complete.",
        evidence: ["right evidence"],
      }),
    );
    expect(completed.data.state).toBe("completed");
    expect(completed.data.assignments).toEqual([]);

    const replay = await ok(
      root,
      ["done", "--assignment", right.assignmentId, "--input", "-"],
      JSON.stringify({
        evidence: ["right evidence"],
        summary: "Right complete.",
      }),
    );
    expect(replay.data.replayed).toBe(true);
    const conflict = await fail(
      root,
      ["done", "--assignment", right.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Conflicting replay.",
        evidence: [],
      }),
    );
    expect(conflict.error.code).toBe("ASSIGNMENT_INPUT_CONFLICT");

    const overview = await ok(root, [
      "inspect",
      "overview",
      "--run-status",
      "completed",
    ]);
    expect(overview.data.runs).toHaveLength(2);
    expect(
      overview.data.runs.every((summary: any) => summary.status === "completed"),
    ).toBe(true);
    const loopSnapshot = await ok(root, [
      "inspect",
      "run",
      "guarded-loop:e2e",
    ]);
    expect(loopSnapshot.data.summary.status).toBe("completed");
    const loopNode = await ok(root, [
      "inspect",
      "node",
      "guarded-loop:e2e",
      "work",
    ]);
    expect(loopNode.data.attempts).toHaveLength(2);
    const mermaid = await ok(root, [
      "inspect",
      "mermaid",
      "guarded-loop:e2e",
    ]);
    expect(mermaid.data.source).toContain("flowchart LR");
    expect(mermaid.data.source).toContain("1/2");
    const events = await ok(root, ["inspect", "events", "--after", "0"]);
    expect(events.data.length).toBeGreaterThan(10);
    expect((await ok(root, ["inspect", "ready"])).data).toEqual([]);
  });

  test("uses Assignment handles for recovery and named Viewer lifecycle", async () => {
    const root = createTestDirectory();
    roots.push(root);
    await ok(root, ["init"]);
    const graphFile = writeGraph(
      root,
      "recovery",
      parallelGraph("guarded-recovery"),
    );
    await ok(root, ["graph", "apply", "--input", graphFile]);
    const started = await ok(root, [
      "run",
      "start",
      "guarded-recovery",
      "--actor",
      "primary",
      "--run-id",
      "guarded-recovery:e2e",
    ]);
    const left = assignment(started, "guarded-recovery", "left");
    const right = assignment(started, "guarded-recovery", "right");

    const heartbeat = await ok(root, [
      "recover",
      "heartbeat",
      "--assignment",
      left.assignmentId,
    ]);
    expect(heartbeat.data.assignmentId).toBe(left.assignmentId);
    const blocked = await ok(root, [
      "recover",
      "block",
      "--assignment",
      left.assignmentId,
      "--reason",
      "External decision required.",
    ]);
    expect(blocked.data.blocked.status).toBe("blocked");

    const unblocked = await ok(root, [
      "recover",
      "unblock",
      "--assignment",
      left.assignmentId,
    ]);
    const secondLeft = assignment(unblocked, "guarded-recovery", "left");
    expect(secondLeft.node.attempt).toBe(2);

    const released = await ok(root, [
      "recover",
      "release",
      "--assignment",
      right.assignmentId,
      "--reason",
      "Move to another execution slot.",
    ]);
    const secondRight = assignment(released, "guarded-recovery", "right");
    expect(secondRight.node.attempt).toBe(2);
    const retried = await ok(root, [
      "recover",
      "fail",
      "--assignment",
      secondRight.assignmentId,
      "--reason",
      "Transient failure.",
      "--retry",
    ]);
    const thirdRight = assignment(retried, "guarded-recovery", "right");
    expect(thirdRight.node.attempt).toBe(3);
    expect((await ok(root, ["recover", "reconcile"])).data.reconciled).toBe(0);

    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
    const port = probe.port;
    const secondProbe = Bun.serve({
      port: 0,
      fetch: () => new Response("probe"),
    });
    const secondPort = secondProbe.port;
    probe.stop(true);
    secondProbe.stop(true);
    let primaryRunning = false;
    let secondaryRunning = false;
    try {
      const viewer = await ok(root, [
        "viewer",
        "start",
        "e2e",
        "--port",
        String(port),
      ]);
      primaryRunning = true;
      const secondary = await ok(root, [
        "viewer",
        "start",
        "e2e-secondary",
        "--port",
        String(secondPort),
      ]);
      secondaryRunning = true;
      expect(viewer.data).toMatchObject({
        name: "e2e",
        port,
        running: true,
        healthy: true,
      });
      expect(viewer.data).not.toHaveProperty("instanceToken");
      expect(viewer.data).not.toHaveProperty("entryFile");
      expect((await fetch(`${viewer.data.url}/api/health`)).ok).toBe(true);
      expect(secondary.data).toMatchObject({
        name: "e2e-secondary",
        running: true,
        healthy: true,
      });
      const status = await ok(root, ["viewer", "status", "e2e"]);
      expect(status.data).toMatchObject({ running: true, healthy: true });
      expect(status.data).not.toHaveProperty("instanceToken");
      const stopped = await ok(root, ["viewer", "stop", "e2e"]);
      primaryRunning = false;
      expect(stopped.data.stopped).toBe(true);
      expect(
        (await ok(root, ["viewer", "status", "e2e-secondary"])).data,
      ).toMatchObject({ running: true, healthy: true });
    } finally {
      if (primaryRunning) {
        await invoke(root, ["viewer", "stop", "e2e"]);
      }
      if (secondaryRunning) {
        await invoke(root, ["viewer", "stop", "e2e-secondary"]);
      }
    }
  });
});
