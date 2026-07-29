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
  createTestDirectory,
  parallelGraph,
  removeTestProject,
} from "../helpers/fixtures.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const archiveFile = path.join(
  repositoryRoot,
  "dist",
  "releases",
  "burn-graph-0.1.0-dev.2.tgz",
);
const roots: string[] = [];

async function command(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly stdin?: string;
  },
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    ...(options.env ? { env: { ...options.env } } : {}),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined && child.stdin !== undefined) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function installedCli(
  executable: string,
  projectRoot: string,
  args: readonly string[],
  stdin?: string,
): Promise<any> {
  const result = await command(
    executable,
    ["--root", projectRoot, ...args],
    {
      cwd: projectRoot,
      ...(stdin === undefined ? {} : { stdin }),
    },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function directoryBytes(root: string): number {
  let bytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      bytes += directoryBytes(target);
    } else if (!entry.isSymbolicLink()) {
      bytes += lstatSync(target).size;
    }
  }
  return bytes;
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("lightweight Bun package", () => {
  test("installs without dependencies and runs CLI state plus packaged Viewer", async () => {
    expect(existsSync(archiveFile)).toBe(true);
    expect(statSync(archiveFile).size).toBeLessThan(2_000_000);

    const testRoot = createTestDirectory();
    roots.push(testRoot);
    const installPrefix = path.join(testRoot, "bun-prefix");
    const projectRoot = path.join(testRoot, "project");
    mkdirSync(projectRoot, { recursive: true });
    const installEnvironment: Record<string, string | undefined> = {
      ...process.env,
      BUN_INSTALL: installPrefix,
    };
    delete installEnvironment["BURN_GRAPH_VIEWER_DIR"];

    const sourcePackageBefore = readFileSync(
      path.join(repositoryRoot, "package.json"),
      "utf8",
    );
    const sourceLockBefore = readFileSync(
      path.join(repositoryRoot, "bun.lock"),
      "utf8",
    );
    const installStarted = performance.now();
    const installation = await command(
      "bun",
      [
        path.join(repositoryRoot, "scripts", "install", "local.ts"),
        "--prefix",
        installPrefix,
      ],
      {
        cwd: repositoryRoot,
      },
    );
    const installMilliseconds = Math.round(performance.now() - installStarted);
    expect(installation.exitCode, installation.stderr).toBe(0);
    expect(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ).toBe(sourcePackageBefore);
    expect(readFileSync(path.join(repositoryRoot, "bun.lock"), "utf8")).toBe(
      sourceLockBefore,
    );

    const refusedPrefix = await command(
      "bun",
      [
        path.join(repositoryRoot, "scripts", "install", "local.ts"),
        "--prefix",
        path.join(repositoryRoot, ".tmp", "unsafe-install-prefix"),
      ],
      { cwd: repositoryRoot },
    );
    expect(refusedPrefix.exitCode).toBe(1);
    expect(refusedPrefix.stderr).toContain(
      "BUN_INSTALL and --prefix must resolve outside the source repository",
    );
    expect(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ).toBe(sourcePackageBefore);
    expect(readFileSync(path.join(repositoryRoot, "bun.lock"), "utf8")).toBe(
      sourceLockBefore,
    );

    const refusedEnvironment = await command(
      "bun",
      [path.join(repositoryRoot, "scripts", "install", "local.ts")],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          BUN_INSTALL: path.join(
            repositoryRoot,
            ".tmp",
            "unsafe-environment-prefix",
          ),
        },
      },
    );
    expect(refusedEnvironment.exitCode).toBe(1);
    expect(refusedEnvironment.stderr).toContain(
      "BUN_INSTALL and --prefix must resolve outside the source repository",
    );

    const executable = path.join(installPrefix, "bin", "burn-graph");
    expect(existsSync(executable)).toBe(true);
    const version = await command(executable, ["--version"], {
      cwd: testRoot,
      env: installEnvironment,
    });
    expect(version.exitCode, version.stderr).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "version",
      data: { version: "0.1.0-dev.2" },
    });

    const installedPackage = path.join(
      installPrefix,
      "install",
      "global",
      "node_modules",
      "burn-graph",
    );
    const installedManifest = JSON.parse(
      readFileSync(path.join(installedPackage, "package.json"), "utf8"),
    ) as { readonly dependencies?: unknown };
    expect(installedManifest.dependencies).toBeUndefined();
    const installedBytes = directoryBytes(installedPackage);
    expect(installedBytes).toBeLessThan(5_000_000);

    const graphFile = path.join(projectRoot, "graph.json");
    writeFileSync(
      graphFile,
      `${JSON.stringify(parallelGraph("installed-smoke"))}\n`,
    );
    await installedCli(executable, projectRoot, ["init", projectRoot]);
    await installedCli(executable, projectRoot, [
      "graph",
      "apply",
      "--input",
      graphFile,
    ]);
    const started = await installedCli(executable, projectRoot, [
      "run",
      "start",
      "installed-smoke",
      "--actor",
      "installed",
      "--run-id",
      "installed:smoke",
    ]);
    const left = started.data.assignments.find(
      (assignment: any) => assignment.node.id === "left",
    );
    const right = started.data.assignments.find(
      (assignment: any) => assignment.node.id === "right",
    );
    expect(left.node.prompt.objective).toBe("Complete the left branch.");
    expect(right.node.prompt.objective).toBe("Complete the right branch.");
    const overlapping = await installedCli(executable, projectRoot, [
      "inspect",
      "run",
      "installed:smoke",
    ]);
    expect(overlapping.data.summary.counts.running).toBe(2);

    await Promise.all([
      installedCli(
        executable,
        projectRoot,
        [
          "done",
          "--assignment",
          left.assignmentId,
          "--input",
          "-",
        ],
        JSON.stringify({ summary: "Installed left completed." }),
      ),
      installedCli(
        executable,
        projectRoot,
        [
          "done",
          "--assignment",
          right.assignmentId,
          "--input",
          "-",
        ],
        JSON.stringify({ summary: "Installed right completed." }),
      ),
    ]);
    const completed = await installedCli(executable, projectRoot, [
      "inspect",
      "run",
      "installed:smoke",
    ]);
    expect(completed.data.summary.status).toBe("completed");

    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("probe"),
    });
    const viewerPort = probe.port;
    probe.stop(true);
    const viewer = await installedCli(executable, projectRoot, [
      "viewer",
      "start",
      "installed",
      "--port",
      String(viewerPort),
    ]);
    try {
      expect(viewer.data).toMatchObject({
        name: "installed",
        running: true,
        healthy: true,
      });
      expect(viewer.data).not.toHaveProperty("instanceToken");
      expect(viewer.data).not.toHaveProperty("entryFile");
      expect(
        (
          await installedCli(executable, projectRoot, [
            "viewer",
            "status",
            "installed",
          ])
        ).data,
      ).toMatchObject({ running: true, healthy: true });
      const mutation = await fetch(
        `http://127.0.0.1:${viewerPort}/api/snapshot`,
        { method: "POST" },
      );
      expect(mutation.status).toBe(405);
    } finally {
      await installedCli(executable, projectRoot, [
        "viewer",
        "stop",
        "installed",
      ]);
    }

    const evidenceRoot = path.join(
      repositoryRoot,
      ".tmp",
      "e2e",
      "install",
    );
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(
      path.join(evidenceRoot, "result.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "passed",
          artifactBytes: statSync(archiveFile).size,
          installedBytes,
          runtimeDependencies: 0,
          installMilliseconds,
          installedCliParallelNodes: 2,
          packagedViewerHealth: 200,
          packagedViewerMutation: 405,
        },
        null,
        2,
      )}\n`,
    );
  });
});
