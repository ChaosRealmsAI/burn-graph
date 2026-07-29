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
  "burn-graph-0.1.0-dev.1.tgz",
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
    expect(version.stdout.trim()).toBe("0.1.0-dev.1");

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
    await installedCli(executable, projectRoot, [
      "run",
      "start",
      "installed-smoke",
      "--run-id",
      "installed:smoke",
    ]);

    const [left, right] = await Promise.all([
      installedCli(executable, projectRoot, [
        "work",
        "claim",
        "installed:smoke",
        "left",
        "--actor",
        "installed:left",
      ]),
      installedCli(executable, projectRoot, [
        "work",
        "claim",
        "installed:smoke",
        "right",
        "--actor",
        "installed:right",
      ]),
    ]);
    expect(left.data.node.id).toBe("left");
    expect(right.data.node.id).toBe("right");
    const overlapping = await installedCli(executable, projectRoot, [
      "run",
      "show",
      "installed:smoke",
    ]);
    expect(overlapping.data.summary.counts.running).toBe(2);

    await Promise.all([
      installedCli(
        executable,
        projectRoot,
        [
          "work",
          "complete",
          "installed:smoke",
          "left",
          "--actor",
          "installed:left",
          "--input",
          "-",
        ],
        JSON.stringify({ summary: "Installed left completed." }),
      ),
      installedCli(
        executable,
        projectRoot,
        [
          "work",
          "complete",
          "installed:smoke",
          "right",
          "--actor",
          "installed:right",
          "--input",
          "-",
        ],
        JSON.stringify({ summary: "Installed right completed." }),
      ),
    ]);
    const completed = await installedCli(executable, projectRoot, [
      "run",
      "show",
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
    const viewer = Bun.spawn(
      [
        executable,
        "--root",
        projectRoot,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(viewerPort),
      ],
      {
        cwd: projectRoot,
        env: installEnvironment,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${viewerPort}/api/health`,
          );
          if (response.ok) {
            healthy = true;
            break;
          }
        } catch {
          // The installed process may still be binding its loopback port.
        }
        await Bun.sleep(50);
      }
      expect(healthy).toBe(true);
      const mutation = await fetch(
        `http://127.0.0.1:${viewerPort}/api/snapshot`,
        { method: "POST" },
      );
      expect(mutation.status).toBe(405);
    } finally {
      viewer.kill("SIGTERM");
      await viewer.exited;
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
