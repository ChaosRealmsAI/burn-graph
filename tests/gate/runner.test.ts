import { describe, expect, test } from "bun:test";

import type { CheckSpec } from "@burn-graph/core";
import { runGateCheck } from "@burn-graph/gate";

import { createTestDirectory, removeTestProject } from "../helpers/fixtures.ts";

function check(
  argv: readonly string[],
  overrides: Partial<CheckSpec> = {},
): CheckSpec {
  return {
    schemaVersion: 1,
    id: "runner",
    revision: 1,
    title: "Runner",
    argv: [...argv],
    cwd: ".",
    successExitCodes: [0],
    timeoutMs: 2_000,
    maxOutputBytes: 4_096,
    inheritEnv: ["PATH"],
    resources: [],
    ...overrides,
  };
}

describe("production Gate Runner", () => {
  test("uses exact argv, selected environment, and configured success codes", async () => {
    const root = createTestDirectory();
    try {
      const result = await runGateCheck(
        root,
        check([
          "bun",
          "-e",
          "process.stdout.write(`${process.env.CI ?? ''}|${process.env.SECRET ?? ''}`); process.exit(7)",
        ], {
          successExitCodes: [7],
          inheritEnv: ["PATH", "CI"],
        }),
        { environment: { PATH: process.env.PATH, CI: "1", SECRET: "hidden" } },
      );
      expect(result).toMatchObject({
        classification: "success",
        exitCode: 7,
        stdout: "1|",
        stderr: "",
      });
      expect(result.byteCount).toBe(2);
    } finally {
      removeTestProject(root);
    }
  });

  test("returns spawn_error for unavailable executable without a shell", async () => {
    const root = createTestDirectory();
    try {
      const result = await runGateCheck(
        root,
        check(["burn-graph-definitely-missing"]),
      );
      expect(result.classification).toBe("spawn_error");
      expect(result.exitCode).toBeNull();
      expect(result.digest).toHaveLength(64);
    } finally {
      removeTestProject(root);
    }
  });

  test("bounds combined output and stops only its held child", async () => {
    const root = createTestDirectory();
    const sentinel = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      const result = await runGateCheck(
        root,
        check(
          [
            "bun",
            "-e",
            "process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)",
          ],
          { maxOutputBytes: 256, timeoutMs: 1_000 },
        ),
      );
      expect(result.classification).toBe("output_limit");
      expect(result.byteCount).toBe(256);
      expect(sentinel.exitCode).toBeNull();
    } finally {
      if (sentinel.exitCode === null) sentinel.kill();
      await sentinel.exited;
      removeTestProject(root);
    }
  });

  test("times out only the held child while an unrelated sentinel survives", async () => {
    const root = createTestDirectory();
    const sentinel = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      const result = await runGateCheck(
        root,
        check(
          ["bun", "-e", "setInterval(() => {}, 1000)"],
          { timeoutMs: 50 },
        ),
      );
      expect(result.classification).toBe("timeout");
      expect(result.durationMs).toBeLessThan(2_000);
      expect(sentinel.exitCode).toBeNull();
    } finally {
      if (sentinel.exitCode === null) sentinel.kill();
      await sentinel.exited;
      removeTestProject(root);
    }
  });
});
