import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { BurnGraphService } from "@burn-graph/core";
import {
  createTestProject,
  loopGraph,
  removeTestProject,
  wideGraph,
} from "../helpers/fixtures.ts";

const roots: string[] = [];
const cli = path.resolve(import.meta.dir, "../../apps/cli/src/index.ts");

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
    expect(contenders.every((result) => result.exitCode === 0)).toBe(true);
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
});
