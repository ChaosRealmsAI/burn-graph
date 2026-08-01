import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import packageMetadata from "../../package.json";
import {
  createTestDirectory,
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
    cwd: root,
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
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(256 * 1024);
  expect(result.stdout).not.toContain(root);
  expect(result.stdout).not.toContain(repositoryRoot);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
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
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(256 * 1024);
  expect(result.stderr).not.toContain(root);
  expect(result.stderr).not.toContain(repositoryRoot);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  return result.envelope;
}

async function firstOutputLine(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) throw new Error("stream ended before one JSONL record");
    buffered += decoder.decode(result.value, { stream: true });
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return buffered.slice(0, newline);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTestProject(root);
});

describe("CLI-only authoring from progressive installed Help", () => {
  test("discovers, authors, and completes a Graph without source docs", async () => {
    const root = createTestDirectory();
    roots.push(root);

    const rootHelp = await ok(root, ["--help"]);
    expect(rootHelp.data.commands.map((command: any) => command.name)).toEqual([
      "init",
      "goal",
      "graph",
      "work",
      "inspect",
      "help",
    ]);
    expect(rootHelp.data.topics.map((topic: any) => topic.name)).toContain(
      "authoring",
    );

    const version = await ok(root, ["--version"]);
    expect(version.data.version).toBe(packageMetadata.version);
    const initialized = await ok(root, ["init"]);
    expect(initialized.data.root).toBe(".");

    const authoring = await ok(root, ["help", "authoring"]);
    expect(authoring.data.content.schema).toBe("burn-graph graph schema");
    const schema = await ok(root, ["graph", "schema"]);
    expect(schema.data.acceptedGraphSpecVersions).toEqual([1, 2, 3]);
    expect(schema.data.jsonSchema.oneOf).toHaveLength(3);

    for (
      const kind of ["flat", "decision", "goal", "hierarchy", "gate", "wait"]
    ) {
      const example = await ok(root, ["graph", "example", kind]);
      const relativeFile = `example-${kind}.json`;
      writeFileSync(
        path.join(root, relativeFile),
        `${JSON.stringify(example.data.graph, null, 2)}\n`,
      );
      const fromFile = await ok(root, [
        "graph",
        "validate",
        "--input",
        relativeFile,
      ]);
      const fromStdin = await ok(
        root,
        ["graph", "validate", "--input", "-"],
        JSON.stringify(example.data.graph),
      );
      expect(fromFile.data).toEqual(fromStdin.data);
    }

    await ok(root, [
      "graph",
      "apply",
      "--input",
      "example-flat.json",
    ]);
    const started = await ok(root, ["run", "start", "example-flat"]);
    expect(started.data.actorId).toBe("primary");
    expect(started.data.assignments).toHaveLength(1);
    const assignment = started.data.assignments[0];
    const completed = await ok(
      root,
      ["done", "--assignment", assignment.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Completed from installed Help only.",
        evidence: [],
      }),
    );
    expect(completed.data.state).toBe("completed");

    const follower = Bun.spawn(
      [
        "bun",
        cli,
        "--root",
        root,
        "--pretty",
        "inspect",
        "events",
        "--after",
        "0",
        "--limit",
        "1",
        "--follow",
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const line = await firstOutputLine(follower.stdout);
      expect(JSON.parse(line)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        command: "inspect.events",
      });
      expect(line).not.toContain(root);
    } finally {
      follower.kill();
      await follower.exited;
    }

    const shown = await ok(root, ["template", "show", "delivery"]);
    expect(shown.data.exampleInput).toMatchObject({
      schemaVersion: 1,
      graphId: "example-delivery",
      context: {
        mustRead: [],
        lockedContracts: [],
        writablePaths: ["src"],
        forbidden: ["Do not change unrelated files."],
        runtime: ["burn-graph inspect overview"],
      },
      promptOverrides: [],
    });
    const templateFile = "template-delivery.json";
    writeFileSync(
      path.join(root, templateFile),
      `${JSON.stringify(shown.data.exampleInput, null, 2)}\n`,
    );
    const fromFile = await ok(root, [
      "template",
      "instantiate",
      "delivery",
      "--input",
      templateFile,
    ]);
    const fromStdin = await ok(
      root,
      ["template", "instantiate", "delivery", "--input", "-"],
      JSON.stringify(shown.data.exampleInput),
    );
    expect(fromFile.data.graphs).toEqual(fromStdin.data.graphs);
    expect(fromStdin.data.replayed).toBe(true);
  });

  test("rejects malformed and escaping input before mutation", async () => {
    const root = createTestDirectory();
    const outsideRoot = createTestDirectory();
    roots.push(root, outsideRoot);
    await ok(root, ["init"]);

    const example = await ok(root, ["graph", "example", "flat"]);
    const insideFile = path.join(root, "inside.json");
    const outsideFile = path.join(outsideRoot, "outside.json");
    writeFileSync(insideFile, `${JSON.stringify(example.data.graph)}\n`);
    writeFileSync(outsideFile, `${JSON.stringify(example.data.graph)}\n`);
    symlinkSync(outsideFile, path.join(root, "escape.json"));

    expect(
      (
        await fail(root, [
          "graph",
          "apply",
          "--input",
          insideFile,
        ])
      ).error.code,
    ).toBe("INVALID_INPUT_PATH");
    expect(
      (
        await fail(root, [
          "graph",
          "apply",
          "--input",
          `../${path.basename(outsideRoot)}/outside.json`,
        ])
      ).error.code,
    ).toBe("INVALID_INPUT_PATH");
    expect(
      (
        await fail(root, [
          "graph",
          "apply",
          "--input",
          "escape.json",
        ])
      ).error.code,
    ).toBe("INVALID_INPUT_PATH");
    expect(
      (
        await fail(
          root,
          ["graph", "apply", "--input", "-"],
          "{\"schemaVersion\":",
        )
      ).error.code,
    ).toBe("INVALID_JSON");
    expect(
      (
        await fail(
          root,
          ["graph", "apply", "--input", "-"],
          `"${"x".repeat(2 * 1024 * 1024)}"`,
        )
      ).error.code,
    ).toBe("INPUT_TOO_LARGE");

    expect(
      readdirSync(path.join(root, ".burn", "graph", "graphs")),
    ).toEqual([]);

    const taskCount = 900;
    const largeGraph = {
      schemaVersion: 1,
      id: "known-bad-unbounded-output",
      title: "Known-bad unbounded output fixture",
      goal: "Prove the public envelope limit judges red.",
      revision: 1,
      maxActive: 1,
      nodes: [
        {
          id: "start",
          type: "start",
          title: "Start",
          prompt: {},
          next: [{ to: "task-0" }],
        },
        ...Array.from({ length: taskCount }, (_, index) => ({
          id: `task-${index}`,
          type: "task",
          title: `Task ${index}`,
          prompt: {
            objective:
              `Return bounded evidence for task ${index}. ${"x".repeat(96)}`,
          },
          next: [{ to: index === taskCount - 1 ? "end" : `task-${index + 1}` }],
        })),
        {
          id: "end",
          type: "end",
          title: "End",
          prompt: {},
          next: [],
        },
      ],
    };
    const largeValidation = await ok(
      root,
      ["graph", "validate", "--input", "-"],
      JSON.stringify(largeGraph),
    );
    expect(largeValidation.data).toMatchObject({
      valid: true,
      id: "known-bad-unbounded-output",
      nodeCount: taskCount + 2,
    });
    expect(largeValidation.data.documentBytes).toBeGreaterThan(256 * 1024);
    expect(largeValidation.data.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      readdirSync(path.join(root, ".burn", "graph", "graphs")),
    ).toEqual([]);

    await ok(
      root,
      ["graph", "apply", "--input", "-"],
      JSON.stringify(largeGraph),
    );
    expect(
      (
        await fail(root, [
          "graph",
          "show",
          "known-bad-unbounded-output",
        ])
      ).error.code,
    ).toBe("OUTPUT_LIMIT_EXCEEDED");
    const parser = await fail(root, ["run", "start"]);
    expect(parser.error.code).toBe("INVALID_ARGUMENTS");
    expect(parser.recoveryActions[0].command).toBe(
      "burn-graph run start --help",
    );
  });

  test("keeps oversized mutation results truthful and recoverable", async () => {
    const root = createTestDirectory();
    roots.push(root);
    await ok(root, ["init"]);

    const widePrompt = "x".repeat(30_000);
    const graph = {
      schemaVersion: 1,
      id: "bounded-mutation-output",
      title: "Bounded mutation output",
      goal: "Keep complete Assignment packets inside the public envelope.",
      revision: 1,
      maxActive: 8,
      nodes: [
        {
          id: "start",
          type: "start",
          title: "Start",
          prompt: {},
          next: Array.from({ length: 8 }, (_, index) => ({
            to: `task-${index}`,
          })),
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `task-${index}`,
          type: "task",
          title: `Task ${index}`,
          prompt: { objective: widePrompt },
          next: [{ to: "join" }],
        })),
        {
          id: "join",
          type: "join",
          title: "Join",
          prompt: {},
          next: [{ to: "end" }],
        },
        {
          id: "end",
          type: "end",
          title: "End",
          prompt: {},
          next: [],
        },
      ],
    };
    await ok(
      root,
      ["graph", "apply", "--input", "-"],
      JSON.stringify(graph),
    );
    const started = await ok(root, [
      "run",
      "start",
      "bounded-mutation-output",
    ]);
    expect(started.data.assignments.length).toBeGreaterThan(0);
    expect(started.data.assignments.length).toBeLessThan(8);
    expect(started.data.assignmentOutput).toMatchObject({
      maximumBytes: 128 * 1024,
      limited: true,
    });
    expect(started.data.assignmentOutput.usedBytes).toBeLessThanOrEqual(
      128 * 1024,
    );
    const doneBefore = started.data.runs.find(
      (entry: any) => entry.graphId === "bounded-mutation-output",
    ).counts.done;

    const current = await ok(root, ["current"]);
    expect(current.data.assignments.map(
      (entry: any) => entry.assignmentId,
    )).toEqual(started.data.assignments.map(
      (entry: any) => entry.assignmentId,
    ));

    const first = started.data.assignments[0];
    const completion = await ok(
      root,
      ["done", "--assignment", first.assignmentId, "--input", "-"],
      JSON.stringify({
        summary: "Large node-specific output committed.",
        output: { value: "z".repeat(400_000) },
        evidence: [],
      }),
    );
    expect(completion.data).toMatchObject({
      boundedReceipt: true,
      responseOmitted: true,
      actorId: "primary",
      state: "assigned",
    });
    expect(completion.data.originalBytes).toBeGreaterThan(256 * 1024);
    expect(completion.data.committedChangeCount).toBeGreaterThan(0);
    expect(completion.data.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completion.nextActions).toContainEqual(
      expect.objectContaining({
        command: "burn-graph current --actor primary",
      }),
    );

    const overview = await ok(root, [
      "inspect",
      "overview",
      "--limit",
      "10",
    ]);
    const summary = overview.data.runs.find(
      (entry: any) => entry.graphId === "bounded-mutation-output",
    );
    expect(summary.counts.done).toBe(doneBefore + 1);
    expect((await ok(root, ["current"])).data.assignments.length)
      .toBeGreaterThan(0);

    const oversizedPromptGraph = {
      ...graph,
      id: "oversized-prompt-contract",
      nodes: graph.nodes.map((node) =>
        node.id === "task-0"
          ? {
              ...node,
              prompt: { objective: "x".repeat(33_000) },
            }
          : node
      ),
    };
    expect(
      (
        await fail(
          root,
          ["graph", "validate", "--input", "-"],
          JSON.stringify(oversizedPromptGraph),
        )
      ).error.code,
    ).toBe("INVALID_GRAPH");
  });

  // P010 Gate. The known-bad data is user text that *looks* like a private
  // absolute path: the printer used to mask every string in the envelope, so a
  // persisted objective of `Read /opt/acme/spec.txt unchanged` was published as
  // `Read <absolute-path> unchanged`. Both halves are asserted here, because
  // either one alone is satisfiable by a wrong printer: persisted user text must
  // read back byte for byte, and product-generated path fields must still be
  // project-relative.
  test("returns persisted user text byte-for-byte while product paths stay private", async () => {
    const root = createTestDirectory();
    roots.push(root);
    await ok(root, ["init"]);

    const objective =
      "Read /opt/acme/spec.txt unchanged, compare \"/etc/acme/base.conf\", then C:\\acme\\spec.txt.";
    const instruction =
      "/opt/acme/spec.txt is the source of truth (see /srv/acme/out.txt).";
    const mustRead = "/opt/acme/spec.txt";
    const writablePath = "/srv/acme/out";
    const graph = {
      schemaVersion: 2,
      id: "path-shaped-user-text",
      title: "Author text that looks like /opt/acme absolute paths",
      goal: "Prove /opt/acme/spec.txt survives the public envelope unchanged.",
      revision: 1,
      maxActive: 1,
      nodes: [
        {
          id: "start",
          type: "start",
          title: "Start",
          prompt: {},
          next: [{ to: "work" }],
        },
        {
          id: "work",
          type: "task",
          title: "Compare /opt/acme/spec.txt",
          prompt: {
            objective,
            instructions: [instruction],
            mustRead: [mustRead],
            doneWhen: ["/opt/acme/spec.txt is byte-identical"],
            writablePaths: [writablePath],
          },
          next: [{ to: "end" }],
        },
        {
          id: "end",
          type: "end",
          title: "End",
          prompt: {},
          next: [],
        },
      ],
    };

    const applied = await ok(
      root,
      ["graph", "apply", "--input", "-"],
      JSON.stringify(graph),
    );
    // The product's own path field for the same command stays project-relative.
    expect(applied.data.path).toBe(
      ".burn/graph/graphs/path-shaped-user-text.json",
    );

    const shown = await ok(root, ["graph", "show", "path-shaped-user-text"]);
    const shownNode = shown.data.nodes.find((node: any) => node.id === "work");
    expect(shownNode.title).toBe("Compare /opt/acme/spec.txt");
    expect(shownNode.prompt.objective).toBe(objective);
    expect(shownNode.prompt.instructions).toEqual([instruction]);
    expect(shownNode.prompt.mustRead).toEqual([mustRead]);
    expect(shownNode.prompt.writablePaths).toEqual([writablePath]);
    expect(shown.data.goal).toBe(graph.goal);
    expect(shown.data.title).toBe(graph.title);

    const started = await ok(root, ["run", "start", "path-shaped-user-text"]);
    const assignment = started.data.assignments[0];
    expect(assignment.node.prompt.objective).toBe(objective);
    expect(assignment.node.prompt.instructions).toEqual([instruction]);
    expect(assignment.node.prompt.mustRead).toEqual([mustRead]);

    const summary =
      "Compared /opt/acme/spec.txt with \"/etc/acme/base.conf\" byte-for-byte.";
    const evidence = "/opt/acme/spec.txt#sha256=deadbeef";
    await ok(
      root,
      ["done", "--assignment", assignment.assignmentId, "--input", "-"],
      JSON.stringify({
        summary,
        evidence: [evidence],
        output: { checked: "/opt/acme/spec.txt", root: "/srv/acme" },
      }),
    );

    const node = await ok(root, [
      "inspect",
      "node",
      "path-shaped-user-text",
      "work",
    ]);
    expect(node.data.spec.prompt.objective).toBe(objective);
    const attempt = node.data.attempts.at(-1);
    expect(attempt.result.summary).toBe(summary);
    expect(attempt.result.evidence).toEqual([evidence]);
    // A user JSON key called `root` is user content at every depth: only the
    // product's own `data.root` may ever be relativized.
    expect(attempt.result.output).toEqual({
      checked: "/opt/acme/spec.txt",
      root: "/srv/acme",
    });

    const events = await ok(root, [
      "inspect",
      "events",
      "path-shaped-user-text",
      "--after",
      "0",
      "--limit",
      "100",
    ]);
    const completed = events.data.find(
      (event: any) => event.type === "node.completed",
    );
    expect(completed.summary).toBe(summary);
    expect(completed.payload.evidence).toEqual([evidence]);

    // A Viewer record is the one product field that is genuinely absolute before
    // the printer sees it, so it proves relativization is still applied where
    // P010 requires it. The recorded PID owns nothing, so nothing is started.
    const viewers = path.join(root, ".burn", "graph", "runtime", "viewers");
    mkdirSync(viewers, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(viewers, "default.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        name: "default",
        pid: 999_999,
        projectRoot: root,
        port: 4173,
        url: "http://127.0.0.1:4173",
        logFile: path.join(viewers, "default.log"),
        entryFile: path.join(root, "burn-graph.js"),
        instanceToken: "known-bad-token",
        startedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const status = await ok(root, ["viewer", "status", "default"]);
    expect(status.data.running).toBe(false);
    expect(status.data.projectRoot).toBe(".");
    expect(status.data.logFile).toBe(
      "./.burn/graph/runtime/viewers/default.log",
    );

    // The same private root must still be absent from an unrelated failure
    // envelope, which is where I0014 originally leaked it.
    const uninitialized = createTestDirectory();
    roots.push(uninitialized);
    const notInitialized = await fail(uninitialized, ["inspect", "overview"]);
    expect(notInitialized.error.code).toBe("NOT_INITIALIZED");
    expect(notInitialized.error.message).not.toContain(uninitialized);
    expect(notInitialized.error.message).not.toMatch(/(?:^|[\s"'(=])\/\w/);
  });
});

describe("Unified .burn project state root", () => {
  test("legacy .burn-graph fails with a stable error naming both roots", async () => {
    const root = createTestDirectory();
    roots.push(root);
    mkdirSync(path.join(root, ".burn-graph", "graphs"), { recursive: true });
    writeFileSync(
      path.join(root, ".burn-graph", "config.json"),
      `${JSON.stringify({ schemaVersion: 1, projectId: "legacy" })}\n`,
    );

    const legacy = await fail(root, ["inspect", "overview"]);
    expect(legacy.error.code).toBe("LEGACY_STATE_ROOT");
    expect(legacy.error.message).toContain(".burn-graph");
    expect(legacy.error.message).toContain(".burn/graph");
    expect(legacy.error.message).toMatch(/not .*migrat/i);
    expect(
      legacy.recoveryActions.map((action: any) => action.command),
    ).toContain("burn-graph init");

    // doctor is the documented diagnosis surface, so it must answer with the
    // same stable judgment rather than an unrelated failure.
    const doctor = await fail(root, ["doctor"]);
    expect(doctor.error.code).toBe("LEGACY_STATE_ROOT");
  });

  test("doctor flags a legacy leftover once the new root exists", async () => {
    const root = createTestDirectory();
    roots.push(root);
    await ok(root, ["init"]);

    const clean = await ok(root, ["doctor"]);
    expect(clean.data.legacyStateRoot).toBeUndefined();

    mkdirSync(path.join(root, ".burn-graph", "graphs"), { recursive: true });
    const flagged = await ok(root, ["doctor"]);
    expect(flagged.data.legacyStateRoot).toBe(".burn-graph");
    expect(
      flagged.nextActions.some((action: any) =>
        action.description.includes(".burn-graph")
      ),
    ).toBe(true);
  });

  test("init writes .burn/graph and one runtime ignore entry", async () => {
    const root = createTestDirectory();
    roots.push(root);
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");

    await ok(root, ["init"]);

    expect(existsSync(path.join(root, ".burn", "graph", "config.json"))).toBe(
      true,
    );
    expect(existsSync(path.join(root, ".burn-graph"))).toBe(false);
    const ignore = readFileSync(path.join(root, ".gitignore"), "utf8");
    expect(ignore.startsWith("node_modules/\n")).toBe(true);
    expect(
      ignore.split("\n").filter((line) => line === ".burn/graph/runtime/"),
    ).toHaveLength(1);

    const applied = await ok(root, ["graph", "apply", "--input", "-"], JSON.stringify({
      schemaVersion: 1,
      id: "state-root",
      title: "State root",
      goal: "Prove the new state root carries authored specifications.",
      revision: 1,
      maxActive: 1,
      nodes: [
        {
          id: "start",
          type: "start",
          title: "Start",
          prompt: {
            objective: "",
            instructions: [],
            mustRead: [],
            doneWhen: [],
            outputSchema: null,
            role: "",
            lockedContracts: [],
            writablePaths: [],
            forbidden: [],
            runtime: [],
          },
          next: [{ to: "end" }],
          maxAttempts: 3,
          actorHint: null,
          tags: [],
        },
        {
          id: "end",
          type: "end",
          title: "End",
          prompt: {
            objective: "",
            instructions: [],
            mustRead: [],
            doneWhen: [],
            outputSchema: null,
            role: "",
            lockedContracts: [],
            writablePaths: [],
            forbidden: [],
            runtime: [],
          },
          next: [],
          maxAttempts: 3,
          actorHint: null,
          tags: [],
        },
      ],
    }));
    expect(applied.data.path).toBe(".burn/graph/graphs/state-root.json");
    expect(
      existsSync(path.join(root, ".burn", "graph", "graphs", "state-root.json")),
    ).toBe(true);
  });
});
