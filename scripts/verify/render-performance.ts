// Purpose: Measure five cold and cached CLI renders for a 100-node graph.
// Usage: bun scripts/verify/render-performance.ts
// Notes: Build the bundled CLI and Viewer first; every browser child is isolated.

import path from "node:path";

import { BurnGraphService } from "@burn-graph/core";

import {
  createTestProject,
  removeTestProject,
  wideGraph,
} from "../../tests/helpers/fixtures.ts";

interface Sample {
  readonly format: "svg" | "png";
  readonly mode: "cold" | "cached";
  readonly milliseconds: number;
  readonly bytes: number;
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cli = path.join(repositoryRoot, "dist", "burn-graph.js");
const samples: Sample[] = [];
const root = createTestProject();

function percentile(values: readonly number[], percentileValue: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(
      ordered.length - 1,
      Math.ceil((percentileValue / 100) * ordered.length) - 1,
    ),
  );
  return ordered[index]!;
}

async function invoke(
  runId: string,
  format: "svg" | "png",
  browserUnavailable: boolean,
): Promise<{ readonly milliseconds: number; readonly bytes: number }> {
  const startedAt = performance.now();
  const child = Bun.spawn(
    [
      "bun",
      cli,
      "--root",
      root,
      "render",
      runId,
      "--format",
      format,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ...(browserUnavailable
          ? {
              BURN_GRAPH_CHROME_BIN: path.join(root, "missing-chrome"),
            }
          : {}),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Render failed: ${stderr.trim()}`);
  }
  const envelope = JSON.parse(stdout) as {
    readonly data?: {
      readonly bytes?: number;
      readonly cached?: boolean;
    };
  };
  if (
    typeof envelope.data?.bytes !== "number" ||
    envelope.data.cached !== browserUnavailable
  ) {
    throw new Error("Render returned an invalid cold/cache result");
  }
  return {
    milliseconds: performance.now() - startedAt,
    bytes: envelope.data.bytes,
  };
}

try {
  const service = new BurnGraphService(root);
  try {
    service.applyGraph(wideGraph("render-performance", 97));
  } finally {
    service.close();
  }

  for (const format of ["svg", "png"] as const) {
    for (let index = 0; index < 5; index += 1) {
      const runId = `render-performance:${format}:${index + 1}`;
      const starter = new BurnGraphService(root);
      try {
        starter.startRun("render-performance", runId);
      } finally {
        starter.close();
      }
      const cold = await invoke(runId, format, false);
      samples.push({ format, mode: "cold", ...cold });
      const cached = await invoke(runId, format, true);
      samples.push({ format, mode: "cached", ...cached });
      const stopper = new BurnGraphService(root);
      try {
        stopper.cancelRun(runId);
      } finally {
        stopper.close();
      }
    }
  }

  const summaries = Object.fromEntries(
    (["svg", "png"] as const).flatMap((format) =>
      (["cold", "cached"] as const).map((mode) => {
        const values = samples
          .filter(
            (sample) => sample.format === format && sample.mode === mode,
          )
          .map((sample) => sample.milliseconds);
        return [
          `${format}.${mode}`,
          {
            count: values.length,
            p50Milliseconds: Math.round(percentile(values, 50)),
            p95Milliseconds: Math.round(percentile(values, 95)),
            maxMilliseconds: Math.round(Math.max(...values)),
          },
        ];
      }),
    ),
  );
  for (const [key, summary] of Object.entries(summaries)) {
    const maximum = key.endsWith(".cold") ? 20_000 : 1_000;
    if (summary.maxMilliseconds >= maximum) {
      throw new Error(`${key} exceeded ${maximum} ms`);
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ok: true,
        command: "verify.render-performance",
        data: {
          nodeCount: 100,
          samples,
          summaries,
          budgets: {
            coldMaximumMilliseconds: 20_000,
            cachedMaximumMilliseconds: 1_000,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  removeTestProject(root);
}
