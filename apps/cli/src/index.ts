#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  BurnGraphService,
  discoverProjectRoot,
  initializeProject,
  validateGraphSpec,
  type GraphEvent,
} from "@burn-graph/core";
import { Command, Option } from "commander";
import { ZodError } from "zod";

import { startViewerServer } from "./server.ts";

interface GlobalOptions {
  readonly root?: string;
  readonly pretty?: boolean;
}

interface Envelope {
  readonly ok: boolean;
  readonly command: string;
  readonly revision?: number;
  readonly event?: GraphEvent;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

const program = new Command("burn-graph")
  .description("AI-first local prompt graph control plane")
  .version("0.1.0-dev.1")
  .option("--root <path>", "project root or descendant", process.cwd())
  .option("--pretty", "pretty-print JSON output");
let activeCommand = "parse";

program.hook("preAction", (_rootCommand, actionCommand) => {
  const parts: string[] = [];
  let current: Command | null = actionCommand;
  while (current && current !== program) {
    parts.unshift(current.name());
    current = current.parent;
  }
  activeCommand = parts.join(".");
});

function globalOptions(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

function print(envelope: Envelope): void {
  const output = JSON.stringify(
    envelope,
    null,
    globalOptions().pretty ? 2 : undefined,
  );
  if (envelope.ok) {
    process.stdout.write(`${output}\n`);
  } else {
    process.stderr.write(`${output}\n`);
  }
}

function success(
  command: string,
  data: unknown,
  mutation?: { readonly revision: number; readonly event: GraphEvent },
): void {
  print({
    ok: true,
    command,
    ...(mutation
      ? { revision: mutation.revision, event: mutation.event }
      : {}),
    data,
  });
}

function withService<T>(operation: (service: BurnGraphService) => T): T {
  const service = new BurnGraphService(globalOptions().root ?? process.cwd());
  try {
    return operation(service);
  } finally {
    service.close();
  }
}

async function readJsonInput(input: string): Promise<unknown> {
  const text =
    input === "-"
      ? await Bun.stdin.text()
      : readFileSync(path.resolve(input), "utf8");
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) {
    throw new BurnGraphError(
      "INPUT_TOO_LARGE",
      "JSON input exceeds the 2 MiB limit",
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BurnGraphError(
      "INVALID_JSON",
      error instanceof Error ? error.message : "Invalid JSON",
    );
  }
}

function positiveInteger(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new BurnGraphError("INVALID_NUMBER", `${value} is not a positive integer`);
  }
  return number;
}

program
  .command("init")
  .description("initialize .burn-graph in a project")
  .argument("[path]", "project directory")
  .action((projectPath?: string) => {
    const root = path.resolve(projectPath ?? globalOptions().root ?? process.cwd());
    const config = initializeProject(root, new Date().toISOString());
    success("init", {
      root,
      config,
      next: "burn-graph graph apply --input graph.json",
    });
  });

const graph = program.command("graph").description("author graph specifications");

graph
  .command("validate")
  .description("validate a GraphSpec without writing it")
  .requiredOption("--input <file>", "JSON file or - for stdin")
  .action(async (options: { input: string }) => {
    const spec = validateGraphSpec(await readJsonInput(options.input)).spec;
    success("graph.validate", spec);
  });

graph
  .command("apply")
  .description("validate and persist a new GraphSpec revision")
  .requiredOption("--input <file>", "JSON file or - for stdin")
  .action(async (options: { input: string }) => {
    const input = await readJsonInput(options.input);
    const spec = withService((service) => service.applyGraph(input));
    success("graph.apply", spec);
  });

graph
  .command("list")
  .description("list graph specifications and their latest runs")
  .action(() => {
    success("graph.list", withService((service) => service.listGraphs()));
  });

graph
  .command("show")
  .description("show the latest GraphSpec")
  .argument("<graph>", "graph id")
  .action((graphId: string) => {
    success("graph.show", withService((service) => service.getGraph(graphId)));
  });

graph
  .command("clone")
  .description("clone a GraphSpec into a new graph id")
  .argument("<source>", "source graph id")
  .argument("<target>", "new graph id")
  .option("--title <title>", "new graph title")
  .action((source: string, target: string, options: { title?: string }) => {
    success(
      "graph.clone",
      withService((service) => service.cloneGraph(source, target, options.title)),
    );
  });

const run = program.command("run").description("control graph runs");

run
  .command("start")
  .description("start the latest revision of a graph")
  .argument("<graph>", "graph id")
  .option("--run-id <id>", "stable explicit run id")
  .action((graphId: string, options: { runId?: string }) => {
    const result = withService((service) =>
      service.startRun(graphId, options.runId),
    );
    success("run.start", result.value, result);
  });

run
  .command("list")
  .description("list all graph runs")
  .action(() => {
    success("run.list", withService((service) => service.listRuns()));
  });

run
  .command("show")
  .description("show a canonical run snapshot")
  .argument("<run-or-graph>")
  .option("--events <count>", "recent event count", positiveInteger, 100)
  .action((reference: string, options: { events: number }) => {
    success(
      "run.show",
      withService((service) => service.getSnapshot(reference, options.events)),
    );
  });

for (const [name, method] of [
  ["pause", "pauseRun"],
  ["resume", "resumeRun"],
  ["cancel", "cancelRun"],
] as const) {
  run
    .command(name)
    .description(`${name} a graph run`)
    .argument("<run-or-graph>")
    .action((reference: string) => {
      const result = withService((service) => service[method](reference));
      success(`run.${name}`, result.value, result);
    });
}

const work = program.command("work").description("claim and report AI work");

work
  .command("ready")
  .description("list Ready Task and Decision nodes")
  .option("--graph <run-or-graph>", "filter by one run")
  .option("--all", "explicitly request all active runs")
  .action((options: { graph?: string }) => {
    success(
      "work.ready",
      withService((service) => service.listReady(options.graph)),
    );
  });

work
  .command("claim")
  .description("atomically claim a Ready node and receive its assignment")
  .argument("<run-or-graph>")
  .argument("<node>")
  .requiredOption("--actor <id>", "stable actor id")
  .option("--lease <seconds>", "lease duration", positiveInteger)
  .action(
    (
      reference: string,
      nodeId: string,
      options: { actor: string; lease?: number },
    ) => {
      const result = withService((service) =>
        service.claim(reference, nodeId, options.actor, options.lease),
      );
      success("work.claim", result.value, result);
    },
  );

work
  .command("current")
  .description("show an actor's focused and claimed nodes")
  .requiredOption("--actor <id>", "stable actor id")
  .action((options: { actor: string }) => {
    success(
      "work.current",
      withService((service) => service.actorWork(options.actor)),
    );
  });

work
  .command("focus")
  .description("focus one of an actor's running nodes")
  .argument("<run-or-graph>")
  .argument("<node>")
  .requiredOption("--actor <id>", "stable actor id")
  .action((reference: string, nodeId: string, options: { actor: string }) => {
    const result = withService((service) =>
      service.focus(reference, nodeId, options.actor),
    );
    success("work.focus", result.value, result);
  });

work
  .command("heartbeat")
  .description("renew a running node lease")
  .argument("<run-or-graph>")
  .argument("<node>")
  .requiredOption("--actor <id>", "stable actor id")
  .option("--lease <seconds>", "lease duration", positiveInteger)
  .action(
    (
      reference: string,
      nodeId: string,
      options: { actor: string; lease?: number },
    ) => {
      const result = withService((service) =>
        service.heartbeat(reference, nodeId, options.actor, options.lease),
      );
      success("work.heartbeat", result.value, result);
    },
  );

work
  .command("checkpoint")
  .description("record bounded progress for a running node")
  .argument("<run-or-graph>")
  .argument("<node>")
  .requiredOption("--actor <id>", "stable actor id")
  .requiredOption("--input <file>", "JSON file or - for stdin")
  .action(
    async (
      reference: string,
      nodeId: string,
      options: { actor: string; input: string },
    ) => {
      const input = await readJsonInput(options.input);
      const result = withService((service) =>
        service.checkpoint(reference, nodeId, options.actor, input),
      );
      success("work.checkpoint", result.value, result);
    },
  );

work
  .command("complete")
  .description("complete a node and activate its structural Next")
  .argument("<run-or-graph>")
  .argument("<node>")
  .requiredOption("--actor <id>", "stable actor id")
  .requiredOption("--input <file>", "JSON file or - for stdin")
  .action(
    async (
      reference: string,
      nodeId: string,
      options: { actor: string; input: string },
    ) => {
      const input = await readJsonInput(options.input);
      const result = withService((service) =>
        service.complete(reference, nodeId, options.actor, input),
      );
      success("work.complete", result.value, result);
    },
  );

for (const name of ["block", "release"] as const) {
  work
    .command(name)
    .description(`${name} a running node`)
    .argument("<run-or-graph>")
    .argument("<node>")
    .requiredOption("--actor <id>", "stable actor id")
    .requiredOption("--reason <text>", "reason")
    .action(
      (
        reference: string,
        nodeId: string,
        options: { actor: string; reason: string },
      ) => {
        const result = withService((service) =>
          service[name](reference, nodeId, options.actor, options.reason),
        );
        success(`work.${name}`, result.value, result);
      },
    );
}

work
  .command("fail")
  .description("fail a running node, optionally scheduling another attempt")
  .argument("<run-or-graph>")
  .argument("<node>")
  .requiredOption("--actor <id>", "stable actor id")
  .requiredOption("--reason <text>", "failure reason")
  .option("--retry", "return to Ready when maxAttempts allows")
  .action(
    (
      reference: string,
      nodeId: string,
      options: { actor: string; reason: string; retry?: boolean },
    ) => {
      const result = withService((service) =>
        service.fail(
          reference,
          nodeId,
          options.actor,
          options.reason,
          options.retry ?? false,
        ),
      );
      success("work.fail", result.value, result);
    },
  );

work
  .command("unblock")
  .description("return a Blocked node to Ready")
  .argument("<run-or-graph>")
  .argument("<node>")
  .action((reference: string, nodeId: string) => {
    const result = withService((service) =>
      service.unblock(reference, nodeId),
    );
    success("work.unblock", result.value, result);
  });

work
  .command("reconcile")
  .description("reopen expired claims across all runs or one selected run")
  .argument("[run-or-graph]")
  .action((reference?: string) => {
    const results = withService((service) =>
      service.reconcileExpired(reference),
    );
    success("work.reconcile", {
      reconciled: results.reduce(
        (count, result) => count + result.value.length,
        0,
      ),
      runs: results.map((result) => ({
        revision: result.revision,
        event: result.event,
        nodes: result.value,
      })),
    });
  });

const events = program.command("events").description("read durable events");

events
  .command("list")
  .description("list events after a cursor")
  .option("--graph <run-or-graph>")
  .option("--after <sequence>", "exclusive sequence cursor", Number, 0)
  .option("--limit <count>", "maximum events", positiveInteger, 100)
  .action((options: { graph?: string; after: number; limit: number }) => {
    success(
      "events.list",
      withService((service) =>
        service.listEvents(options.graph, options.after, options.limit),
      ),
    );
  });

events
  .command("follow")
  .description("stream new events as JSON Lines")
  .option("--after <sequence>", "exclusive sequence cursor", Number, 0)
  .action(async (options: { after: number }) => {
    let cursor = options.after;
    const root = discoverProjectRoot(globalOptions().root ?? process.cwd());
    for (;;) {
      const service = new BurnGraphService(root);
      try {
        const batch = service.listEvents(undefined, cursor, 100);
        for (const event of batch) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
          cursor = event.sequence;
        }
      } finally {
        service.close();
      }
      await Bun.sleep(500);
    }
  });

program
  .command("mermaid")
  .description("print the current Mermaid projection")
  .argument("<run-or-graph>")
  .action((reference: string) => {
    const source = withService((service) => service.getSnapshot(reference).mermaid);
    process.stdout.write(`${source}\n`);
  });

program
  .command("serve")
  .description("serve the read-only local Viewer")
  .option("--host <host>", "bind host", "127.0.0.1")
  .option("--port <port>", "bind port", positiveInteger, 4173)
  .option("--open", "open the local URL in Google Chrome")
  .action(
    async (options: { host: string; port: number; open?: boolean }) => {
      await startViewerServer({
        projectRoot: globalOptions().root ?? process.cwd(),
        host: options.host,
        port: options.port,
        open: options.open ?? false,
      });
    },
  );

program
  .command("doctor")
  .description("inspect project, runtime, and stale claims")
  .action(() => {
    const data = withService((service) => {
      const snapshot = service.projectSnapshot();
      const staleClaims = snapshot.runs.reduce(
        (count, runSummary) =>
          count +
          service
            .getSnapshot(runSummary.runId, 1)
            .nodes.filter(
              (node) =>
                node.status === "running" &&
                node.leaseExpiresAt !== null &&
                new Date(node.leaseExpiresAt).getTime() <= Date.now(),
            ).length,
        0,
      );
      return {
        projectId: snapshot.projectId,
        root: service.root,
        graphCount: snapshot.graphs.length,
        runCount: snapshot.runs.length,
        staleClaims,
        healthy: staleClaims === 0,
      };
    });
    success("doctor", data);
  });

program.configureOutput({
  outputError: () => undefined,
});
program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("commander.")
  ) {
    if (
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.version"
    ) {
      process.exit(0);
    }
    print({
      ok: false,
      command: "parse",
      error: {
        code: "INVALID_ARGUMENTS",
        message: error.message,
        retryable: false,
        details: {},
      },
    });
    process.exit(1);
  }
  const normalized =
    error instanceof BurnGraphError
      ? error
      : error instanceof ZodError
        ? new BurnGraphError("INVALID_INPUT", "Input validation failed", false, {
            issues: error.issues,
          })
        : new BurnGraphError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
          );
  print({
    ok: false,
    command: activeCommand,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      details: normalized.details,
    },
  });
  process.exit(1);
}
