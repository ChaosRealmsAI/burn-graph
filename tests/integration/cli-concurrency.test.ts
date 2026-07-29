import { afterEach, describe, expect, test } from "bun:test";

import {
  createTestProject,
  parallelGraph,
  removeTestProject,
} from "../helpers/fixtures.ts";
import { writeFileSync } from "node:fs";
import path from "node:path";

const roots: string[] = [];
const cli = path.resolve(import.meta.dir, "../../apps/cli/src/index.ts");

async function invoke(
  root: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["bun", cli, "--root", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
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
  test("two processes racing for one node produce exactly one winner", async () => {
    const root = createTestProject();
    roots.push(root);
    const graphFile = path.join(root, "graph.json");
    writeFileSync(graphFile, `${JSON.stringify(parallelGraph())}\n`);

    expect(
      (await invoke(root, ["graph", "apply", "--input", graphFile])).exitCode,
    ).toBe(0);
    expect(
      (
        await invoke(root, [
          "run",
          "start",
          "parallel",
          "--run-id",
          "parallel:race",
        ])
      ).exitCode,
    ).toBe(0);

    const contenders = await Promise.all([
      invoke(root, [
        "work",
        "claim",
        "parallel:race",
        "left",
        "--actor",
        "racer-one",
        "--lease",
        "60",
      ]),
      invoke(root, [
        "work",
        "claim",
        "parallel:race",
        "left",
        "--actor",
        "racer-two",
        "--lease",
        "60",
      ]),
    ]);
    const winners = contenders.filter((result) => result.exitCode === 0);
    const losers = contenders.filter((result) => result.exitCode !== 0);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(JSON.parse(winners[0]!.stdout).ok).toBe(true);
    const loser = JSON.parse(losers[0]!.stderr) as {
      ok: boolean;
      error: { code: string; retryable: boolean };
    };
    expect(loser.ok).toBe(false);
    expect((loser as typeof loser & { command: string }).command).toBe(
      "work.claim",
    );
    expect(loser.error.code).toBe("NODE_NOT_READY");
    expect(loser.error.retryable).toBe(true);
  });
});
