import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  convergenceGraph,
  createTestDirectory,
  parallelGraph,
  removeTestProject,
  wideGraph,
} from "../helpers/fixtures.ts";

interface CliResult {
  readonly exitCode: number;
  readonly envelope: any;
  readonly stderr: string;
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const cli = path.join(repositoryRoot, "dist", "burn-graph.js");
const roots: string[] = [];

async function invoke(
  root: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<CliResult> {
  const child = Bun.spawn(["bun", cli, "--root", root, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    exitCode,
    envelope: JSON.parse((exitCode === 0 ? stdout : stderr).trim()),
    stderr,
  };
}

async function ok(
  root: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<any> {
  const result = await invoke(root, args, env);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.envelope).toMatchObject({ schemaVersion: 1, ok: true });
  return result.envelope;
}

function graphFile(root: string, name: string, graph: unknown): string {
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(graph, null, 2)}\n`);
  return file;
}

function artifactFile(root: string, artifact: string): string {
  const file = path.resolve(root, artifact);
  expect(file.startsWith(`${root}${path.sep}`)).toBe(true);
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("package-internal graph rendering", () => {
  test(
    "renders immutable SVG and PNG projections with cache and concurrency",
    async () => {
      const root = createTestDirectory();
      roots.push(root);
      await ok(root, ["init"]);
      const input = graphFile(
        root,
        "render-flow",
        convergenceGraph("render-flow"),
      );
      await ok(root, ["graph", "apply", "--input", input]);
      const started = await ok(root, [
        "run",
        "start",
        "render-flow",
        "--actor",
        "renderer",
        "--run-id",
        "render-flow:e2e",
      ]);

      const before = await ok(root, ["inspect", "run", "render-flow:e2e"]);
      const rendererTemporaryRoot = path.join(root, "renderer-temporary");
      mkdirSync(rendererTemporaryRoot);
      const sentinel = Bun.spawn(
        ["bun", "-e", "setInterval(() => undefined, 1000)"],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      let svg: any;
      try {
        svg = await ok(
          root,
          ["render", "render-flow:e2e"],
          { TMPDIR: rendererTemporaryRoot },
        );
        expect(sentinel.exitCode).toBeNull();
        expect(() => process.kill(sentinel.pid, 0)).not.toThrow();
      } finally {
        sentinel.kill("SIGTERM");
        await sentinel.exited;
      }
      expect(
        readdirSync(rendererTemporaryRoot).filter((entry) =>
          entry.startsWith("burn-graph-render-profile-"),
        ),
      ).toEqual([]);
      expect(svg.data).toMatchObject({
        runId: "render-flow:e2e",
        graphId: "render-flow",
        runtimeRevision: before.data.summary.runtimeRevision,
        format: "svg",
        theme: "dark",
        cached: false,
        renderer: {
          name: "burn-graph-mermaid",
          mermaidVersion: "11.16.0",
        },
      });
      const svgFile = artifactFile(root, svg.data.artifact);
      expect(existsSync(svgFile)).toBe(true);
      const svgBytes = readFileSync(svgFile);
      expect(svgBytes.length).toBe(svg.data.bytes);
      expect(
        new Bun.CryptoHasher("sha256").update(svgBytes).digest("hex"),
      ).toBe(svg.data.sha256);
      const svgText = svgBytes.toString("utf8");
      expect(svgText).toContain("<svg");
      expect(svgText).toContain("viewBox=");
      expect(svgText).toContain('fill="#0d111a"');
      expect(svgText).not.toMatch(/<script|<foreignObject|\son[a-z]+=/i);
      if (process.platform !== "win32") {
        expect(lstatSync(svgFile).mode & 0o777).toBe(0o600);
      }

      const treeSvg = await ok(root, [
        "render",
        "render-flow:e2e",
        "--scope",
        "tree",
        "--depth",
        "0",
        "--limit",
        "500",
      ]);
      expect(treeSvg.data).toMatchObject({
        runId: "render-flow:e2e",
        graphId: "render-flow",
        scope: "tree",
        projectionDepth: 0,
        format: "svg",
        cached: false,
      });
      expect(treeSvg.data.artifact).not.toBe(svg.data.artifact);
      expect(existsSync(artifactFile(root, treeSvg.data.artifact))).toBe(true);

      const unavailableBrowser = {
        BURN_GRAPH_CHROME_BIN: path.join(root, "missing-chrome"),
      };
      const cached = await ok(
        root,
        ["render", "render-flow:e2e"],
        unavailableBrowser,
      );
      expect(cached.data).toMatchObject({
        artifact: svg.data.artifact,
        sha256: svg.data.sha256,
        cached: true,
      });

      writeFileSync(svgFile, Buffer.concat([svgBytes, Buffer.from("corrupt")]));
      const corruptCache = await invoke(
        root,
        ["render", "render-flow:e2e"],
        unavailableBrowser,
      );
      expect(corruptCache.exitCode).toBe(1);
      expect(corruptCache.envelope.error.code).toBe(
        "RENDERER_UNAVAILABLE",
      );
      const regenerated = await ok(
        root,
        ["render", "render-flow:e2e"],
        { TMPDIR: rendererTemporaryRoot },
      );
      expect(regenerated.data).toMatchObject({
        artifact: svg.data.artifact,
        cached: false,
      });
      const regeneratedBytes = readFileSync(svgFile);
      expect(regeneratedBytes.length).toBe(regenerated.data.bytes);
      expect(
        new Bun.CryptoHasher("sha256")
          .update(regeneratedBytes)
          .digest("hex"),
      ).toBe(regenerated.data.sha256);

      const concurrent = await Promise.all([
        invoke(root, ["render", "render-flow:e2e", "--format", "png"]),
        invoke(root, ["render", "render-flow:e2e", "--format", "png"]),
      ]);
      expect(concurrent.every((result) => result.exitCode === 0)).toBe(true);
      const firstPng = concurrent[0]!.envelope.data;
      const secondPng = concurrent[1]!.envelope.data;
      expect(firstPng.artifact).toBe(secondPng.artifact);
      expect(firstPng.sha256).toBe(secondPng.sha256);
      expect([firstPng.cached, secondPng.cached].sort()).toEqual([
        false,
        true,
      ]);
      expect(firstPng.width).toBeLessThanOrEqual(2400);
      expect(firstPng.height).toBeLessThanOrEqual(1600);
      expect(firstPng.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(
        readFileSync(artifactFile(root, firstPng.artifact)).subarray(0, 8),
      ).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      const after = await ok(root, ["inspect", "run", "render-flow:e2e"]);
      expect(after.data.summary.runtimeRevision).toBe(
        before.data.summary.runtimeRevision,
      );
      expect(
        after.data.events.map((event: any) => event.sequence),
      ).toEqual(before.data.events.map((event: any) => event.sequence));

      const firstAssignment = started.data.assignments[0];
      const completion = Bun.spawn(
        [
          "bun",
          cli,
          "--root",
          root,
          "done",
          "--assignment",
          firstAssignment.assignmentId,
          "--input",
          "-",
        ],
        {
          cwd: root,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      completion.stdin.write('{"summary":"Advance render revision."}');
      completion.stdin.end();
      expect(await completion.exited).toBe(0);
      const advanced = await ok(root, ["render", "render-flow:e2e"]);
      expect(advanced.data.runtimeRevision).toBeGreaterThan(
        svg.data.runtimeRevision,
      );
      expect(advanced.data.artifact).not.toBe(svg.data.artifact);
      expect(existsSync(svgFile)).toBe(false);
      expect(existsSync(artifactFile(root, firstPng.artifact))).toBe(false);

      const doctor = await ok(root, ["doctor"], unavailableBrowser);
      expect(doctor.data).toMatchObject({
        healthy: true,
        capabilities: {
          render: {
            available: false,
            reason: { code: "RENDERER_UNAVAILABLE" },
          },
        },
      });

      const missingInput = graphFile(
        root,
        "render-missing",
        parallelGraph("render-missing"),
      );
      await ok(root, ["graph", "apply", "--input", missingInput]);
      await ok(root, [
        "run",
        "start",
        "render-missing",
        "--actor",
        "renderer",
        "--run-id",
        "render-missing:e2e",
      ]);
      const missing = await invoke(
        root,
        ["render", "render-missing:e2e"],
        unavailableBrowser,
      );
      expect(missing.exitCode).toBe(1);
      expect(missing.envelope.error.code).toBe("RENDERER_UNAVAILABLE");
      expect(
        statSync(path.join(root, ".burn-graph", "runtime", "renders")).isDirectory(),
      ).toBe(true);
    },
    60_000,
  );

  test(
    "renders a 100-node graph within the bounded browser lifetime",
    async () => {
      const root = createTestDirectory();
      roots.push(root);
      await ok(root, ["init"]);
      const input = graphFile(root, "wide", wideGraph("render-wide", 97));
      await ok(root, ["graph", "apply", "--input", input]);
      await ok(root, [
        "run",
        "start",
        "render-wide",
        "--actor",
        "renderer",
        "--run-id",
        "render-wide:e2e",
      ]);
      const rendered = await ok(root, [
        "render",
        "render-wide:e2e",
        "--format",
        "png",
      ]);
      // The 20s cold-render ceiling that used to sit here is the same number
      // scripts/verify/render-performance.ts enforces as coldMaximumMilliseconds,
      // over the same operation with p50/p95/max sampling. Here it measured suite
      // contention and shadowed the owner.
      expect(rendered.data).toMatchObject({
        format: "png",
        cached: false,
      });
      expect(rendered.data.width).toBeLessThanOrEqual(2400);
      expect(rendered.data.height).toBeLessThanOrEqual(1600);
    },
    60_000,
  );

  test(
    "times out and removes the exact isolated browser profile",
    async () => {
      const root = createTestDirectory();
      roots.push(root);
      await ok(root, ["init"]);
      const input = graphFile(
        root,
        "timeout",
        parallelGraph("render-timeout"),
      );
      await ok(root, ["graph", "apply", "--input", input]);
      await ok(root, [
        "run",
        "start",
        "render-timeout",
        "--actor",
        "renderer",
        "--run-id",
        "render-timeout:e2e",
      ]);
      const temporaryRoot = path.join(root, "timeout-temporary");
      mkdirSync(temporaryRoot);
      const helper = Bun.spawn(
        [
          "bun",
          path.join(repositoryRoot, "tests", "helpers", "render-timeout.ts"),
          root,
          "render-timeout:e2e",
        ],
        {
          cwd: repositoryRoot,
          env: { ...process.env, TMPDIR: temporaryRoot },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        helper.exited,
        new Response(helper.stdout).text(),
        new Response(helper.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        errorCode: "RENDER_TIMEOUT",
      });
      expect(
        readdirSync(temporaryRoot).filter((entry) =>
          entry.startsWith("burn-graph-render-profile-"),
        ),
      ).toEqual([]);
    },
    30_000,
  );
});
