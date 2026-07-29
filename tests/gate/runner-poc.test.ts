import { describe, expect, test } from "bun:test";

import { runExactProcessPoc } from "../../pocs/gate-runner/exact-process.ts";
import { createTestDirectory, removeTestProject } from "../helpers/fixtures.ts";

describe("exact-process Gate Runner PoC", () => {
  test("times out only its held child while a separately owned sentinel survives", async () => {
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
      const result = await runExactProcessPoc({
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        cwd: root,
        timeoutMs: 50,
        maxOutputBytes: 1_024,
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(result).toMatchObject({
        classification: "timeout",
        byteCount: 0,
      });
      expect(sentinel.exitCode).toBeNull();
      expect(result.durationMs).toBeLessThan(2_000);
    } finally {
      if (sentinel.exitCode === null) sentinel.kill();
      await sentinel.exited;
      removeTestProject(root);
    }
  });

  test("caps output and stops the exact producer", async () => {
    const root = createTestDirectory();
    try {
      const result = await runExactProcessPoc({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)",
        ],
        cwd: root,
        timeoutMs: 2_000,
        maxOutputBytes: 256,
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(result.classification).toBe("output_limit");
      expect(result.byteCount).toBe(256);
      expect(result.output.byteLength).toBe(256);
      expect(result.digest).toHaveLength(64);
    } finally {
      removeTestProject(root);
    }
  });
});
