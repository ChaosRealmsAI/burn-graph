import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

import packageMetadata from "../../package.json";
import { confinedInputArgs } from "../helpers/cli.ts";
import {
  createTestDirectory,
  parallelGraph,
  removeTestProject,
  wideGraph,
} from "../helpers/fixtures.ts";
import {
  durableWaitGraph,
  gateRepairGraph,
} from "../helpers/system-node-fixtures.ts";

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
  `burn-graph-${packageMetadata.version}.tgz`,
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
    [
      "--root",
      projectRoot,
      ...confinedInputArgs(projectRoot, args),
    ],
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

function assignment(envelope: any, nodeId: string): any {
  const found = envelope.data.assignments.find(
    (candidate: any) => candidate.node.id === nodeId,
  );
  if (!found) throw new Error(`Missing Assignment ${nodeId}`);
  return found;
}

function graphAssignment(
  envelope: any,
  graphId: string,
  nodeId: string,
): any {
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

describe("lightweight Bun package", () => {
  test("installs without dependencies and runs CLI state plus packaged Viewer", async () => {
    expect(existsSync(archiveFile)).toBe(true);
    expect(statSync(archiveFile).size).toBeLessThan(2_000_000);
    const archiveListing = await command("tar", ["-tzf", archiveFile], {
      cwd: repositoryRoot,
    });
    expect(archiveListing.exitCode, archiveListing.stderr).toBe(0);
    expect(archiveListing.stdout).toContain("package/viewer/render.html");
    expect(archiveListing.stdout).toContain("package/templates/catalog.json");
    for (
      const asset of [
        "package/USAGE.md",
        "package/help/root.json",
        "package/help/authoring.json",
        "package/schema/graph-spec.json",
        "package/examples/flat.json",
        "package/examples/decision.json",
        "package/examples/hierarchy.json",
        "package/examples/gate.json",
        "package/examples/wait.json",
        "package/examples/template-delivery.json",
      ]
    ) {
      expect(archiveListing.stdout).toContain(asset);
    }
    expect(archiveListing.stdout).not.toMatch(
      /(?:^|\/)(?:privacy|bdd|milestones|slices|issues|feedback)(?:\/|$)|product\.md/,
    );

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
    expect(statSync(executable).mode & 0o111).not.toBe(0);
    const version = await command(executable, ["--version"], {
      cwd: testRoot,
      env: installEnvironment,
    });
    expect(version.exitCode, version.stderr).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "version",
      data: { version: packageMetadata.version },
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
    ) as { readonly version?: unknown; readonly dependencies?: unknown };
    expect(installedManifest.version).toBe(packageMetadata.version);
    expect(installedManifest.dependencies).toBeUndefined();
    const installedBytes = directoryBytes(installedPackage);
    expect(installedBytes).toBeLessThan(5_000_000);
    const installedReadme = readFileSync(
      path.join(installedPackage, "README.md"),
      "utf8",
    );
    for (const match of installedReadme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (
        target.startsWith("#") ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)
      ) {
        continue;
      }
      expect(
        existsSync(path.resolve(installedPackage, target)),
        `broken packaged README link: ${target}`,
      ).toBe(true);
    }
    const installedRootHelp = await installedCli(
      executable,
      projectRoot,
      ["--help"],
    );
    expect(
      JSON.parse(
        readFileSync(
          path.join(installedPackage, "help", "root.json"),
          "utf8",
        ),
      ),
    ).toEqual(installedRootHelp);
    const installedSchema = await installedCli(
      executable,
      projectRoot,
      ["graph", "schema"],
    );
    expect(
      JSON.parse(
        readFileSync(
          path.join(installedPackage, "schema", "graph-spec.json"),
          "utf8",
        ),
      ),
    ).toEqual(installedSchema);

    const graphFile = path.join(projectRoot, "graph.json");
    writeFileSync(
      graphFile,
      `${JSON.stringify(parallelGraph("installed-smoke"))}\n`,
    );
    await installedCli(executable, projectRoot, ["init", projectRoot]);
    const installedTemplates = await installedCli(
      executable,
      projectRoot,
      ["template", "list"],
    );
    expect(installedTemplates.data.count).toBe(6);
    const installedCatalog = JSON.parse(
      readFileSync(
        path.join(installedPackage, "templates", "catalog.json"),
        "utf8",
      ),
    ) as { readonly templates: readonly unknown[] };
    expect(installedTemplates.data.templates).toEqual(
      installedCatalog.templates,
    );
    expect(
      (
        await installedCli(executable, projectRoot, [
          "template",
          "show",
          "bugfix",
        ])
      ).data.template.id,
    ).toBe("bugfix");
    const installedTemplateInput = (
      graphId: string,
      idempotencyKey: string,
      include: readonly string[] = [],
    ) => ({
      schemaVersion: 1,
      graphId,
      goal: `Complete ${graphId} from the isolated package.`,
      idempotencyKey,
      include,
      context: {
        mustRead: ["README.md"],
        lockedContracts: [],
        writablePaths: ["src"],
        forbidden: ["Do not change unrelated files."],
        runtime: ["burn-graph inspect metrics"],
      },
      promptOverrides: [],
    });
    const installedBugfixInput = path.join(
      projectRoot,
      "installed-bugfix-input.json",
    );
    const installedPocInput = path.join(
      projectRoot,
      "installed-poc-input.json",
    );
    writeFileSync(
      installedBugfixInput,
      `${JSON.stringify(
        installedTemplateInput(
          "installed-template-bugfix",
          "installed-template-bugfix-key",
          ["poc"],
        ),
      )}\n`,
    );
    writeFileSync(
      installedPocInput,
      `${JSON.stringify(
        installedTemplateInput(
          "installed-template-poc",
          "installed-template-poc-key",
        ),
      )}\n`,
    );
    const instantiatedBugfix = await installedCli(
      executable,
      projectRoot,
      [
        "template",
        "instantiate",
        "bugfix",
        "--input",
        installedBugfixInput,
      ],
    );
    expect(instantiatedBugfix.data).toMatchObject({
      replayed: false,
      graphs: [{
        graphId: "installed-template-bugfix",
        path: ".burn-graph/graphs/installed-template-bugfix.json",
      }],
    });
    expect(
      (
        await installedCli(executable, projectRoot, [
          "template",
          "instantiate",
          "bugfix",
          "--input",
          installedBugfixInput,
        ])
      ).data.replayed,
    ).toBe(true);
    const instantiatedPoc = await installedCli(executable, projectRoot, [
      "template",
      "instantiate",
      "poc",
      "--input",
      installedPocInput,
    ]);
    const installedTemplateReceipts = [
      instantiatedBugfix,
      instantiatedPoc,
    ];
    for (
      const templateId of [
        "delivery",
        "vertical-slice",
        "review-repair",
        "release",
      ]
    ) {
      const graphId = `installed-template-${templateId}`;
      const inputFile = path.join(
        projectRoot,
        `installed-${templateId}-input.json`,
      );
      writeFileSync(
        inputFile,
        `${JSON.stringify(
          installedTemplateInput(
            graphId,
            `${graphId}-key`,
            templateId === "vertical-slice"
              ? ["security", "performance"]
              : [],
          ),
        )}\n`,
      );
      installedTemplateReceipts.push(
        await installedCli(executable, projectRoot, [
          "template",
          "instantiate",
          templateId,
          "--input",
          inputFile,
        ]),
      );
    }
    expect(installedTemplateReceipts).toHaveLength(6);
    for (const receipt of installedTemplateReceipts) {
      const graph = receipt.data.graphs[0];
      const generatedFile = path.resolve(projectRoot, graph.path);
      const document = readFileSync(generatedFile, "utf8");
      expect(statSync(generatedFile).mode & 0o077).toBe(0);
      expect(
        createHash("sha256").update(document).digest("hex"),
      ).toBe(graph.sha256);
      expect(document).not.toContain(repositoryRoot);
      expect(document).not.toContain("privacy/");
      await installedCli(executable, projectRoot, [
        "graph",
        "validate",
        "--input",
        generatedFile,
      ]);
    }
    expect(
      JSON.parse(
        readFileSync(
          path.join(
            projectRoot,
            ".burn-graph",
            "graphs",
            "installed-template-bugfix.json",
          ),
          "utf8",
        ),
      ).nodes.map((node: any) => node.id),
    ).toContain("risk-poc");
    expect(
      JSON.parse(
        readFileSync(
          path.join(
            projectRoot,
            ".burn-graph",
            "graphs",
            "installed-template-vertical-slice.json",
          ),
          "utf8",
        ),
      ).nodes
        .filter((node: any) => node.id.startsWith("risk-"))
        .map((node: any) => node.id),
    ).toEqual(["risk-security", "risk-performance"]);
    const siblingContractInput = path.join(
      projectRoot,
      "installed-sibling-contract-input.json",
    );
    writeFileSync(
      siblingContractInput,
      `${JSON.stringify({
        ...installedTemplateInput(
          "installed-template-sibling-contract",
          "installed-template-sibling-contract-key",
        ),
        context: {
          mustRead: ["../privacy/product.md"],
          lockedContracts: ["../privacy/architecture.md"],
          writablePaths: ["src"],
          forbidden: ["Do not change unrelated files."],
          runtime: ["burn-graph inspect metrics"],
        },
      })}\n`,
    );
    const siblingReceipt = await installedCli(executable, projectRoot, [
      "template",
      "instantiate",
      "poc",
      "--input",
      siblingContractInput,
    ]);
    const siblingGraph = JSON.parse(
      readFileSync(
        path.resolve(projectRoot, siblingReceipt.data.graphs[0].path),
        "utf8",
      ),
    );
    expect(
      siblingGraph.nodes.some(
        (node: any) =>
          node.prompt.mustRead.includes("../privacy/product.md") &&
          node.prompt.lockedContracts.includes("../privacy/architecture.md") &&
          node.prompt.writablePaths.includes("src"),
      ),
    ).toBe(true);
    const invalidTemplateInput = path.join(
      projectRoot,
      "installed-invalid-template.json",
    );
    writeFileSync(
      invalidTemplateInput,
      `${JSON.stringify({
        ...installedTemplateInput(
          "installed-template-invalid",
          "installed-template-invalid-key",
        ),
        context: { writablePaths: ["../private"] },
      })}\n`,
    );
    const rejectedTemplate = await command(
      executable,
      [
        "--root",
        projectRoot,
        "template",
        "instantiate",
        "poc",
        "--input",
        path.basename(invalidTemplateInput),
      ],
      { cwd: projectRoot },
    );
    expect(rejectedTemplate.exitCode).toBe(1);
    expect(
      existsSync(
        path.join(
          projectRoot,
          ".burn-graph",
          "graphs",
          "installed-template-invalid.json",
        ),
      ),
    ).toBe(false);

    const installedBugfix = await installedCli(executable, projectRoot, [
      "run",
      "start",
      "installed-template-bugfix",
      "--actor",
      "installed-template",
      "--run-id",
      "installed:template-bugfix",
    ]);
    const installedPoc = await installedCli(executable, projectRoot, [
      "run",
      "start",
      "installed-template-poc",
      "--actor",
      "installed-template",
      "--run-id",
      "installed:template-poc",
    ]);
    await installedCli(executable, projectRoot, [
      "run",
      "priority",
      "installed:template-bugfix",
      "--value",
      "high",
      "--idempotency-key",
      "installed-template-high",
    ]);
    await installedCli(executable, projectRoot, [
      "run",
      "priority",
      "installed:template-poc",
      "--value",
      "low",
      "--idempotency-key",
      "installed-template-low",
    ]);
    const completeTemplate = async (
      packet: any,
      route?: string,
    ): Promise<any> =>
      installedCli(
        executable,
        projectRoot,
        ["done", "--assignment", packet.assignmentId, "--input", "-"],
        JSON.stringify({
          summary: `Completed ${packet.graph.graphId}/${packet.node.id}.`,
          evidence: [`evidence/${packet.node.id}.json`],
          ...(route ? { route } : {}),
        }),
      );
    let templateProgress = await completeTemplate(
      graphAssignment(
        installedBugfix,
        "installed-template-bugfix",
        "reproduce",
      ),
    );
    templateProgress = await completeTemplate(
      graphAssignment(installedPoc, "installed-template-poc", "frame"),
    );
    templateProgress = await completeTemplate(
      graphAssignment(
        templateProgress,
        "installed-template-bugfix",
        "repair",
      ),
    );
    templateProgress = await completeTemplate(
      graphAssignment(
        templateProgress,
        "installed-template-poc",
        "experiment",
      ),
    );
    templateProgress = await completeTemplate(
      graphAssignment(
        templateProgress,
        "installed-template-bugfix",
        "regression",
      ),
    );
    templateProgress = await completeTemplate(
      graphAssignment(templateProgress, "installed-template-poc", "verify"),
    );
    templateProgress = await completeTemplate(
      graphAssignment(
        templateProgress,
        "installed-template-bugfix",
        "risk-poc",
      ),
    );
    templateProgress = await completeTemplate(
      graphAssignment(
        templateProgress,
        "installed-template-bugfix",
        "review",
      ),
      "pass",
    );
    await completeTemplate(
      graphAssignment(templateProgress, "installed-template-poc", "review"),
      "pass",
    );
    const installedTemplateMetrics = await installedCli(
      executable,
      projectRoot,
      ["inspect", "metrics"],
    );
    expect(installedTemplateMetrics.data).toMatchObject({
      scope: { runCount: 2, rootCount: 2 },
      assignments: { current: 0, maximumLive: 2 },
      excludedPrivateFields: [
        "prompts",
        "results",
        "checkOutput",
        "environment",
      ],
    });
    const installedTemplateTree = await installedCli(
      executable,
      projectRoot,
      ["inspect", "tree", "installed:template-bugfix", "--depth", "0"],
    );
    const installedTemplateSvg = await installedCli(
      executable,
      projectRoot,
      [
        "render",
        "installed:template-bugfix",
        "--scope",
        "tree",
        "--format",
        "svg",
      ],
    );
    const installedTemplatePng = await installedCli(
      executable,
      projectRoot,
      [
        "render",
        "installed:template-bugfix",
        "--scope",
        "tree",
        "--format",
        "png",
      ],
    );
    for (const artifact of [installedTemplateSvg, installedTemplatePng]) {
      expect(artifact.data.projection).toMatchObject({
        totalRuns: installedTemplateTree.data.projection.totalRuns,
        renderedNodes: installedTemplateTree.data.projection.renderedNodes,
        lastEventSequence:
          installedTemplateTree.data.projection.lastEventSequence,
      });
    }

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
    const rendered = await installedCli(executable, projectRoot, [
      "render",
      "installed:smoke",
    ]);
    expect(rendered.data).toMatchObject({
      runId: "installed:smoke",
      format: "svg",
      cached: false,
    });
    expect(
      existsSync(path.resolve(projectRoot, rendered.data.artifact)),
    ).toBe(true);
    const afterRender = await installedCli(executable, projectRoot, [
      "current",
      "--actor",
      "installed",
    ]);
    expect(
      afterRender.data.assignments
        .map((assignment: any) => assignment.assignmentId)
        .sort(),
    ).toEqual([left.assignmentId, right.assignmentId].sort());

    const completions = await Promise.all([
      command(
        executable,
        [
          "--root",
          projectRoot,
          "done",
          "--assignment",
          left.assignmentId,
          "--input",
          "-",
        ],
        {
          cwd: projectRoot,
          stdin: JSON.stringify({ summary: "Installed left completed." }),
        },
      ),
      command(
        executable,
        [
          "--root",
          projectRoot,
          "done",
          "--assignment",
          right.assignmentId,
          "--input",
          "-",
        ],
        {
          cwd: projectRoot,
          stdin: JSON.stringify({ summary: "Installed right completed." }),
        },
      ),
    ]);
    if (completions.some((completion) => completion.exitCode !== 0)) {
      const diagnostic = await installedCli(executable, projectRoot, [
        "inspect",
        "run",
        "installed:smoke",
      ]);
      expect(
        completions.every((completion) => completion.exitCode === 0),
        JSON.stringify({ completions, diagnostic: diagnostic.data.nodes }),
      ).toBe(true);
    }
    const completed = await installedCli(executable, projectRoot, [
      "inspect",
      "run",
      "installed:smoke",
    ]);
    expect(completed.data.summary.status).toBe("completed");

    writeFileSync(
      path.join(projectRoot, "installed-check.ts"),
      "const value = await Bun.file('status.txt').text(); console.log(value.trim()); process.exit(value.trim() === 'good' ? 0 : 9);\n",
    );
    writeFileSync(path.join(projectRoot, "status.txt"), "bad-private-output\n");
    const installedCheckFile = path.join(
      projectRoot,
      "installed-check.json",
    );
    writeFileSync(
      installedCheckFile,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "installed-check",
        revision: 1,
        title: "Installed Check",
        argv: ["bun", "installed-check.ts"],
        cwd: ".",
        successExitCodes: [0],
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
        inheritEnv: ["PATH"],
        resources: ["installed-check"],
      })}\n`,
    );
    const installedGateFile = path.join(projectRoot, "installed-gate.json");
    writeFileSync(
      installedGateFile,
      `${JSON.stringify(gateRepairGraph("installed-gate", "installed-check"))}\n`,
    );
    await installedCli(executable, projectRoot, [
      "check",
      "apply",
      "--input",
      installedCheckFile,
    ]);
    await installedCli(executable, projectRoot, [
      "graph",
      "apply",
      "--input",
      installedGateFile,
    ]);
    const installedGate = await installedCli(executable, projectRoot, [
      "run",
      "start",
      "installed-gate",
      "--actor",
      "installed",
      "--run-id",
      "installed:gate",
    ]);
    const firstImplementation = assignment(installedGate, "implement");
    const rejectedGate = await installedCli(
      executable,
      projectRoot,
      [
        "done",
        "--assignment",
        firstImplementation.assignmentId,
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Installed package saw the seeded bad fixture.",
        evidence: [],
      }),
    );
    expect(rejectedGate.data.system.gateExecutions).toBe(1);
    const review = assignment(rejectedGate, "review");
    const repair = await installedCli(
      executable,
      projectRoot,
      ["done", "--assignment", review.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Installed machine evidence requires repair.",
        route: "repair",
        evidence: [],
      }),
    );
    const secondImplementation = assignment(repair, "implement");
    writeFileSync(path.join(projectRoot, "status.txt"), "good\n");
    const acceptedGate = await installedCli(
      executable,
      projectRoot,
      [
        "done",
        "--assignment",
        secondImplementation.assignmentId,
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Installed fixture repaired.",
        evidence: ["status.txt"],
      }),
    );
    expect(acceptedGate.data).toMatchObject({
      state: "completed",
      system: { gateExecutions: 1 },
      assignments: [],
    });
    const installedExecutions = (
      await installedCli(executable, projectRoot, [
        "inspect",
        "executions",
        "installed:gate",
      ])
    ).data;
    expect(
      installedExecutions
        .map((execution: any) => execution.classification)
        .sort(),
    ).toEqual(["non_success", "success"]);
    expect(JSON.stringify(installedExecutions)).not.toContain(
      "bad-private-output",
    );

    const installedWaitFile = path.join(projectRoot, "installed-wait.json");
    writeFileSync(
      installedWaitFile,
      `${JSON.stringify(durableWaitGraph("installed-wait"))}\n`,
    );
    await installedCli(executable, projectRoot, [
      "graph",
      "apply",
      "--input",
      installedWaitFile,
    ]);
    const installedWait = await installedCli(executable, projectRoot, [
      "run",
      "start",
      "installed-wait",
      "--actor",
      "installed",
      "--run-id",
      "installed:wait",
    ]);
    expect(installedWait.data.waiting).toHaveLength(1);
    const unrelated = assignment(installedWait, "unrelated");
    const signalId = installedWait.data.waiting[0].signalId;
    expect(
      (
        await installedCli(executable, projectRoot, [
          "inspect",
          "waits",
          "installed:wait",
        ])
      ).data[0],
    ).toMatchObject({
      signalId,
      status: "waiting",
      routes: ["approved", "rejected"],
    });
    const resolvedWait = await installedCli(
      executable,
      projectRoot,
      [
        "signal",
        "resolve",
        "--signal",
        signalId,
        "--route",
        "approved",
        "--actor",
        "installed",
        "--idempotency-key",
        "installed-approval-1",
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Installed approval accepted.",
        evidence: ["evidence/approval.json"],
      }),
    );
    const afterApproval = assignment(resolvedWait, "after");
    expect(afterApproval.context.predecessors).toContainEqual(
      expect.objectContaining({
        nodeId: "wait",
        route: "approved",
        summary: "Installed approval accepted.",
      }),
    );
    const beforeReplay = await installedCli(executable, projectRoot, [
      "inspect",
      "run",
      "installed:wait",
      "--events",
      "100",
    ]);
    const replayedWait = await installedCli(
      executable,
      projectRoot,
      [
        "signal",
        "resolve",
        "--signal",
        signalId,
        "--route",
        "approved",
        "--actor",
        "installed",
        "--idempotency-key",
        "installed-approval-1",
        "--input",
        "-",
      ],
      JSON.stringify({
        summary: "Installed approval accepted.",
        evidence: ["evidence/approval.json"],
      }),
    );
    expect(replayedWait.data.resolved.replayed).toBe(true);
    expect(assignment(replayedWait, "after").assignmentId).toBe(
      afterApproval.assignmentId,
    );
    const afterReplay = await installedCli(executable, projectRoot, [
      "inspect",
      "run",
      "installed:wait",
      "--events",
      "100",
    ]);
    expect(afterReplay.data.summary.runtimeRevision).toBe(
      beforeReplay.data.summary.runtimeRevision,
    );
    expect(afterReplay.data.events).toEqual(beforeReplay.data.events);

    await installedCli(
      executable,
      projectRoot,
      ["done", "--assignment", unrelated.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Installed unrelated work completed." }),
    );
    const completedWait = await installedCli(
      executable,
      projectRoot,
      ["done", "--assignment", afterApproval.assignmentId, "--input", "-"],
      JSON.stringify({ summary: "Installed approved work completed." }),
    );
    expect(completedWait.data.state).toBe("completed");
    expect(
      (
        await installedCli(executable, projectRoot, [
          "inspect",
          "run",
          "installed:wait",
        ])
      ).data.summary.status,
    ).toBe("completed");

    const wideGraphFile = path.join(projectRoot, "wide-graph.json");
    writeFileSync(
      wideGraphFile,
      `${JSON.stringify(wideGraph("installed-wide", 97))}\n`,
    );
    await installedCli(executable, projectRoot, [
      "graph",
      "apply",
      "--input",
      wideGraphFile,
    ]);
    await installedCli(executable, projectRoot, [
      "run",
      "start",
      "installed-wide",
      "--actor",
      "installed",
      "--run-id",
      "installed:wide",
    ]);
    const installedWideRender = await installedCli(
      executable,
      projectRoot,
      ["render", "installed:wide", "--format", "png"],
    );
    expect(installedWideRender.data).toMatchObject({
      graphId: "installed-wide",
      format: "png",
      cached: false,
    });
    expect(installedWideRender.data.width).toBeLessThanOrEqual(2400);
    expect(installedWideRender.data.height).toBeLessThanOrEqual(1600);

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
      const portfolioResponse = await fetch(
        `http://127.0.0.1:${viewerPort}/api/snapshot`,
      );
      expect(portfolioResponse.status).toBe(200);
      const portfolioEnvelope = (await portfolioResponse.json()) as any;
      expect(
        portfolioEnvelope.data.metrics.scope.runCount,
      ).toBeGreaterThanOrEqual(installedTemplateMetrics.data.scope.runCount);
      expect(
        portfolioEnvelope.data.metrics.assignments.maximumLive,
      ).toBeGreaterThanOrEqual(
        installedTemplateMetrics.data.assignments.maximumLive,
      );
      const treeResponse = await fetch(
        `http://127.0.0.1:${viewerPort}/api/trees/${encodeURIComponent("installed:wide")}?depth=0&limit=500`,
      );
      expect(treeResponse.status).toBe(200);
      const treeEnvelope = (await treeResponse.json()) as any;
      expect(treeEnvelope).toMatchObject({
        ok: true,
        data: {
          root: { summary: { runId: "installed:wide" } },
          projection: {
            depth: 0,
            totalRuns: 1,
            renderedNodes: 100,
          },
        },
      });
      const templateTreeResponse = await fetch(
        `http://127.0.0.1:${viewerPort}/api/trees/${encodeURIComponent("installed:template-bugfix")}?depth=0&limit=500`,
      );
      expect(templateTreeResponse.status).toBe(200);
      const templateTreeEnvelope = (await templateTreeResponse.json()) as any;
      expect(templateTreeEnvelope.data.projection).toMatchObject({
        depth: installedTemplateTree.data.projection.depth,
        maximumDepth: installedTemplateTree.data.projection.maximumDepth,
        limit: installedTemplateTree.data.projection.limit,
        totalRuns: installedTemplateTree.data.projection.totalRuns,
        expandedRuns: installedTemplateTree.data.projection.expandedRuns,
        foldedRuns: installedTemplateTree.data.projection.foldedRuns,
        renderedNodes: installedTemplateTree.data.projection.renderedNodes,
        lastEventSequence:
          installedTemplateTree.data.projection.lastEventSequence,
      });
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
          packagedRendererFormat: rendered.data.format,
          packagedRendererBytes: rendered.data.bytes,
          packagedTemplateSvgBytes: installedTemplateSvg.data.bytes,
          packagedTemplatePngBytes: installedTemplatePng.data.bytes,
          packagedTemplateProjection:
            installedTemplateTree.data.projection.renderedNodes,
          packagedHundredNodeFormat: installedWideRender.data.format,
          packagedHundredNodeBytes: installedWideRender.data.bytes,
          packagedViewerHealth: 200,
          packagedViewerMutation: 405,
          packagedViewerTreeProjection: 100,
        },
        null,
        2,
      )}\n`,
    );
  }, 60_000);
});
