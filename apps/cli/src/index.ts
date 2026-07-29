#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  BurnGraphService,
  discoverProjectRoot,
  initializeProject,
  validateGraphSpec,
  type GraphStatus,
  type NodeStatus,
  type RuntimeChange,
  type WorkSchedule,
} from "@burn-graph/core";
import {
  inspectRenderCapability,
  renderGraphArtifact,
  type RenderFormat,
  type RenderScope,
} from "@burn-graph/render";
import { Command, Option } from "commander";
import { ZodError } from "zod";

import { startViewerServer } from "./server.ts";
import {
  startViewerInstance,
  stopViewerInstance,
  viewerInstanceStatus,
} from "./viewer-runtime.ts";

const VERSION = "0.1.0-dev.5";
const GRAPH_STATUSES: readonly GraphStatus[] = [
  "draft",
  "running",
  "pausing",
  "paused",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
];
const NODE_STATUSES: readonly NodeStatus[] = [
  "pending",
  "ready",
  "running",
  "waiting",
  "blocked",
  "done",
  "failed",
  "cancelled",
  "skipped",
];

interface GlobalOptions {
  readonly root?: string;
  readonly pretty?: boolean;
  readonly version?: boolean;
}

interface NextAction {
  readonly id: string;
  readonly command: string;
  readonly description: string;
}

interface Envelope {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly changes?: readonly RuntimeChange[];
  readonly nextActions?: readonly NextAction[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details: Readonly<Record<string, unknown>>;
  };
  readonly recoveryActions?: readonly NextAction[];
}

interface HelpDetail {
  readonly mutates: boolean;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly errors?: readonly string[];
  readonly next?: readonly string[];
}

const program = new Command("burn-graph")
  .description("Guarded local prompt-graph control plane for AI callers")
  .option("--root <path>", "project root or descendant", process.cwd())
  .option("--pretty", "pretty-print JSON output")
  .option("-V, --version", "return version as JSON")
  .addHelpCommand(false);
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

function group(name: string, description: string): Command {
  return program
    .command(name)
    .description(description)
    .addHelpCommand(false);
}

function globalOptions(): GlobalOptions {
  return program.opts<GlobalOptions>();
}

function prettyOutput(): boolean {
  return globalOptions().pretty === true || process.argv.includes("--pretty");
}

function print(envelope: Envelope): void {
  const output = JSON.stringify(envelope, null, prettyOutput() ? 2 : undefined);
  const stream = envelope.ok ? process.stdout : process.stderr;
  stream.write(`${output}\n`);
}

function success(
  command: string,
  data: unknown,
  options: {
    readonly changes?: readonly RuntimeChange[];
    readonly nextActions?: readonly NextAction[];
  } = {},
): void {
  print({
    schemaVersion: 1,
    ok: true,
    command,
    data,
    ...(options.changes && options.changes.length > 0
      ? { changes: options.changes }
      : {}),
    ...(options.nextActions && options.nextActions.length > 0
      ? { nextActions: options.nextActions }
      : {}),
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

function boundedInteger(maximum: number) {
  return (value: string): number => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > maximum) {
      throw new BurnGraphError(
        "INVALID_NUMBER",
        `${value} must be an integer between 1 and ${maximum}`,
      );
    }
    return number;
  };
}

function nonNegativeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new BurnGraphError(
      "INVALID_NUMBER",
      `${value} must be a non-negative integer`,
    );
  }
  return number;
}

function boundedNonNegativeInteger(maximum: number) {
  return (value: string): number => {
    const number = nonNegativeInteger(value);
    if (number > maximum) {
      throw new BurnGraphError(
        "INVALID_NUMBER",
        `${value} must be an integer between 0 and ${maximum}`,
      );
    }
    return number;
  };
}

function scheduleActions(schedule: WorkSchedule): readonly NextAction[] {
  if (schedule.assignments.length > 0) {
    return schedule.assignments.map((assignment) => ({
      id: `complete:${assignment.assignmentId}`,
      command: assignment.returnProtocol.complete,
      description: `Execute "${assignment.node.title}" and return its validated result.`,
    }));
  }
  if (schedule.state === "waiting") {
    const paused = schedule.runs.find((run) => run.status === "paused");
    return [
      ...(paused
        ? [
            {
              id: "resume",
              command: `burn-graph run resume ${paused.runId} --actor ${schedule.actorId} --idempotency-key <new-key>`,
              description: "Resume the paused Run tree with one stable retry key.",
            },
          ]
        : [
            {
              id: "next",
              command: `burn-graph next --actor ${schedule.actorId}`,
              description: "Resume existing work or fill newly available slots.",
            },
          ]),
      {
        id: "overview",
        command: "burn-graph inspect overview",
        description: "Inspect why no Assignment is currently available.",
      },
    ];
  }
  return [
    {
      id: "overview",
      command: "burn-graph inspect overview",
      description:
        schedule.state === "completed"
          ? "Confirm all Graph outcomes."
          : "Inspect blocked or failed work before recovery.",
    },
  ];
}

function scheduleSuccess<T extends WorkSchedule>(
  command: string,
  result: T,
): void {
  const { changes, ...data } = result;
  success(command, data, {
    changes,
    nextActions: scheduleActions(result),
  });
}

function mutationChange(result: {
  readonly revision: number;
  readonly event: RuntimeChange["event"];
}): readonly RuntimeChange[] {
  return [{ revision: result.revision, event: result.event }];
}

function parseNodeStatuses(value?: string): readonly NodeStatus[] | null {
  if (!value) return null;
  const statuses = value
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  const invalid = statuses.filter(
    (status) => !NODE_STATUSES.includes(status as NodeStatus),
  );
  if (invalid.length > 0) {
    throw new BurnGraphError(
      "INVALID_NODE_STATUS",
      `Unknown node status: ${invalid.join(", ")}`,
      false,
      { allowed: NODE_STATUSES },
    );
  }
  return statuses as NodeStatus[];
}

program
  .command("init")
  .description("initialize project-local burn-graph state")
  .argument("[path]", "project directory")
  .action((projectPath?: string) => {
    const root = path.resolve(projectPath ?? globalOptions().root ?? process.cwd());
    const config = initializeProject(root, new Date().toISOString());
    success("init", { root, config }, {
      nextActions: [
        {
          id: "apply-graph",
          command: "burn-graph graph apply --input graph.json",
          description: "Validate and register the first GraphSpec.",
        },
      ],
    });
  });

const graph = group("graph", "author and inspect GraphSpec JSON");

graph
  .command("validate")
  .description("validate a GraphSpec without writing it")
  .requiredOption("--input <file>", "JSON file or - for stdin")
  .action(async (options: { input: string }) => {
    success(
      "graph.validate",
      validateGraphSpec(await readJsonInput(options.input)).spec,
      {
        nextActions: [
          {
            id: "apply-graph",
            command: `burn-graph graph apply --input ${options.input}`,
            description: "Register the validated GraphSpec.",
          },
        ],
      },
    );
  });

graph
  .command("apply")
  .description("validate and register a new GraphSpec revision")
  .requiredOption("--input <file>", "JSON file or - for stdin")
  .action(async (options: { input: string }) => {
    const input = await readJsonInput(options.input);
    const spec = withService((service) => service.applyGraph(input));
    success("graph.apply", spec, {
      nextActions: [
        {
          id: "start-run",
          command: `burn-graph run start ${spec.id} --actor primary`,
          description: "Start the Graph and receive its first Assignments.",
        },
      ],
    });
  });

graph
  .command("list")
  .description("list registered GraphSpecs and latest Run summaries")
  .action(() => {
    success("graph.list", withService((service) => service.listGraphs()));
  });

graph
  .command("show")
  .description("show the latest normalized GraphSpec")
  .argument("<graph>", "Graph ID")
  .action((graphId: string) => {
    success("graph.show", withService((service) => service.getGraph(graphId)));
  });

graph
  .command("clone")
  .description("clone a GraphSpec under a new ID")
  .argument("<source>", "source Graph ID")
  .argument("<target>", "target Graph ID")
  .option("--title <title>", "target title")
  .action((source: string, target: string, options: { title?: string }) => {
    const spec = withService((service) =>
      service.cloneGraph(source, target, options.title),
    );
    success("graph.clone", spec, {
      nextActions: [
        {
          id: "start-run",
          command: `burn-graph run start ${spec.id} --actor primary`,
          description: "Start the cloned Graph.",
        },
      ],
    });
  });

const run = group("run", "control Graph Run lifecycle");

run
  .command("start")
  .description("start a Graph and immediately return prompt Assignments")
  .argument("<graph>", "Graph ID")
  .requiredOption("--actor <id>", "stable Actor ID")
  .option("--run-id <id>", "stable explicit Run ID")
  .action(
    (
      graphId: string,
      options: { actor: string; runId?: string },
    ) => {
      const result = withService((service) =>
        service.startWithAssignments(graphId, options.actor, options.runId),
      );
      scheduleSuccess("run.start", result);
    },
  );

run
  .command("pause")
  .description("pause new scheduling for one Run")
  .argument("<run-or-graph>")
  .requiredOption("--idempotency-key <key>", "stable retry key")
  .action((reference: string, options: { idempotencyKey: string }) => {
    const result = withService((service) =>
      service.pauseRun(reference, options.idempotencyKey),
    );
    success("run.pause", { ...result.value, replayed: result.replayed }, {
      changes:
        result.changes ?? mutationChange(result),
      nextActions: [
        {
          id: "resume",
          command: `burn-graph run resume ${reference} --actor primary --idempotency-key <new-key>`,
          description: "Resume scheduling when ready.",
        },
      ],
    });
  });

run
  .command("resume")
  .description("resume a Run and immediately return prompt Assignments")
  .argument("<run-or-graph>")
  .requiredOption("--actor <id>", "stable Actor ID")
  .requiredOption("--idempotency-key <key>", "stable retry key")
  .action(
    (
      reference: string,
      options: { actor: string; idempotencyKey: string },
    ) => {
    const result = withService((service) =>
      service.resumeWithAssignments(
        reference,
        options.actor,
        options.idempotencyKey,
      ),
    );
    scheduleSuccess("run.resume", result);
    },
  );

run
  .command("cancel")
  .description("cancel one Run and release its active claims")
  .argument("<run-or-graph>")
  .requiredOption("--idempotency-key <key>", "stable retry key")
  .action((reference: string, options: { idempotencyKey: string }) => {
    const result = withService((service) =>
      service.cancelRun(reference, options.idempotencyKey),
    );
    success("run.cancel", { ...result.value, replayed: result.replayed }, {
      changes:
        result.changes ?? mutationChange(result),
      nextActions: [
        {
          id: "overview",
          command: "burn-graph inspect overview",
          description: "Inspect remaining Runs.",
        },
      ],
    });
  });

program
  .command("next")
  .description("resume and automatically fill one Actor's Assignment slots")
  .requiredOption("--actor <id>", "stable Actor ID")
  .action((options: { actor: string }) => {
    scheduleSuccess(
      "next",
      withService((service) => service.schedule(options.actor)),
    );
  });

program
  .command("current")
  .description("return one Actor's current complete Assignment packets")
  .requiredOption("--actor <id>", "stable Actor ID")
  .action((options: { actor: string }) => {
    const data = withService((service) => ({
      work: service.actorWork(options.actor),
      assignments: service.assignmentsForActor(options.actor),
    }));
    success("current", data, {
      nextActions:
        data.assignments.length > 0
          ? data.assignments.map((assignment) => ({
              id: `complete:${assignment.assignmentId}`,
              command: assignment.returnProtocol.complete,
              description: `Execute "${assignment.node.title}" and return its result.`,
            }))
          : [
              {
                id: "next",
                command: `burn-graph next --actor ${options.actor}`,
                description: "Request the next available Assignments.",
              },
            ],
    });
  });

program
  .command("render")
  .description("materialize one Run as a cached SVG or PNG artifact")
  .argument("<run-or-graph>")
  .addOption(
    new Option("--scope <scope>", "projection scope")
      .choices(["run", "tree"])
      .default("run"),
  )
  .option(
    "--depth <count>",
    "expanded child Run depth for tree scope",
    boundedNonNegativeInteger(8),
    0,
  )
  .option(
    "--limit <count>",
    "maximum rendered tree nodes",
    boundedInteger(500),
    500,
  )
  .addOption(
    new Option("--format <format>", "artifact format")
      .choices(["svg", "png"])
      .default("svg"),
  )
  .action(
    async (
      reference: string,
      options: {
        scope: RenderScope;
        depth: number;
        limit: number;
        format: RenderFormat;
      },
    ) => {
      const root = discoverProjectRoot(
        globalOptions().root ?? process.cwd(),
      );
      const projection = (() => {
        const service = new BurnGraphService(root);
        try {
          if (options.scope === "tree") {
            const tree = service.getTreeSnapshot(
              reference,
              options.depth,
              options.limit,
              0,
            );
            return {
              snapshot: { ...tree.root, mermaid: tree.mermaid },
              tree: tree.projection,
            };
          }
          return {
            snapshot: service.getSnapshot(reference, 0),
            tree: null,
          };
        } finally {
          service.close();
        }
      })();
      const data = await renderGraphArtifact({
        projectRoot: root,
        snapshot: projection.snapshot,
        format: options.format,
        scope: options.scope,
        ...(options.scope === "tree"
          ? { projectionDepth: options.depth }
          : {}),
      });
      success("render", data, {
        nextActions: [
          {
            id: "inspect-run",
            command:
              options.scope === "tree"
                ? `burn-graph inspect tree ${projection.snapshot.summary.runId} --depth ${options.depth} --limit ${options.limit}`
                : `burn-graph inspect run ${projection.snapshot.summary.runId}`,
            description: "Inspect the canonical Run behind this projection.",
          },
        ],
      });
    },
  );

program
  .command("focus")
  .description("focus one already-owned Assignment")
  .requiredOption("--assignment <id>", "Assignment ID")
  .action((options: { assignment: string }) => {
    const result = withService((service) =>
      service.focusAssignment(options.assignment),
    );
    success("focus", result.value, {
      changes: mutationChange(result),
      nextActions: [
        {
          id: "complete",
          command: result.value.returnProtocol.complete,
          description: "Execute the focused prompt and return its result.",
        },
      ],
    });
  });

program
  .command("done")
  .description("complete one Assignment and automatically return successors")
  .requiredOption("--assignment <id>", "Assignment ID")
  .requiredOption("--input <file>", "completion JSON file or - for stdin")
  .action(async (options: { assignment: string; input: string }) => {
    const input = await readJsonInput(options.input);
    const result = withService((service) =>
      service.completeAndContinue(options.assignment, input),
    );
    scheduleSuccess("done", result);
  });

const inspect = group("inspect", "read bounded runtime and graph projections");

inspect
  .command("overview")
  .description("show filtered multi-Graph progress and actionable nodes")
  .option("--graph <run-or-graph>", "filter one Run")
  .addOption(
    new Option("--run-status <status>", "filter Run status").choices([
      ...GRAPH_STATUSES,
    ]),
  )
  .option("--node-status <statuses>", "comma-separated Node statuses")
  .option("--actor <id>", "filter Node owner")
  .option("--tag <tag>", "filter GraphSpec Node tag")
  .option("--limit <count>", "maximum node rows", boundedInteger(1_000), 50)
  .action(
    (options: {
      graph?: string;
      runStatus?: GraphStatus;
      nodeStatus?: string;
      actor?: string;
      tag?: string;
      limit: number;
    }) => {
      const data = withService((service) => {
        const project = service.projectSnapshot();
        const selectedRunId = options.graph
          ? service.getSnapshot(options.graph, 0).summary.runId
          : null;
        const runs = project.runs.filter(
          (candidate) =>
            (selectedRunId === null || candidate.runId === selectedRunId) &&
            (options.runStatus === undefined ||
              candidate.status === options.runStatus),
        );
        const explicitStatuses = parseNodeStatuses(options.nodeStatus);
        const defaultStatuses: readonly NodeStatus[] = [
          "ready",
          "running",
          "blocked",
          "failed",
        ];
        const statuses = explicitStatuses ?? defaultStatuses;
        const nodes = runs
          .flatMap((summary) => {
            const snapshot = service.getSnapshot(summary.runId, 0);
            return snapshot.nodes
              .filter((node) => statuses.includes(node.status))
              .filter(
                (node) =>
                  options.actor === undefined || node.actorId === options.actor,
              )
              .filter((node) => {
                if (options.tag === undefined) return true;
                return (
                  snapshot.spec.nodes
                    .find((spec) => spec.id === node.id)
                    ?.tags.includes(options.tag) ?? false
                );
              })
              .map((node) => ({
                runId: summary.runId,
                graphId: summary.graphId,
                nodeId: node.id,
                type: node.type,
                title: node.title,
                status: node.status,
                attempt: node.attempt,
                assignmentId: node.assignmentId,
                actorId: node.actorId,
                updatedAt: node.updatedAt,
              }));
          })
          .slice(0, options.limit);
        return {
          projectId: project.projectId,
          capturedAt: project.capturedAt,
          filters: {
            graph: options.graph ?? null,
            runStatus: options.runStatus ?? null,
            nodeStatuses: statuses,
            actor: options.actor ?? null,
            tag: options.tag ?? null,
            limit: options.limit,
          },
          totals: {
            graphs: project.graphs.length,
            runs: runs.length,
            listedNodes: nodes.length,
          },
          runs,
          nodes,
          lastEventSequence: project.lastEventSequence,
        };
      });
      success("inspect.overview", data);
    },
  );

inspect
  .command("run")
  .description("show one canonical Run snapshot")
  .argument("<run-or-graph>")
  .option("--events <count>", "recent event count", boundedInteger(1_000), 100)
  .action((reference: string, options: { events: number }) => {
    success(
      "inspect.run",
      withService((service) => service.getSnapshot(reference, options.events)),
    );
  });

inspect
  .command("tree")
  .description("show one bounded folded or expanded Run tree snapshot")
  .argument("<run-or-graph>")
  .option(
    "--depth <count>",
    "expanded child Run depth",
    boundedNonNegativeInteger(8),
    0,
  )
  .option(
    "--limit <count>",
    "maximum rendered nodes",
    boundedInteger(500),
    500,
  )
  .option("--events <count>", "root event count", boundedInteger(1_000), 100)
  .action(
    (
      reference: string,
      options: { depth: number; limit: number; events: number },
    ) => {
      success(
        "inspect.tree",
        withService((service) =>
          service.getTreeSnapshot(
            reference,
            options.depth,
            options.limit,
            options.events,
          ),
        ),
      );
    },
  );

inspect
  .command("node")
  .description("show one Node, its prompt, Attempts, edges, and events")
  .argument("<run-or-graph>")
  .argument("<node>")
  .option("--events <count>", "recent event count", boundedInteger(1_000), 50)
  .action(
    (reference: string, nodeId: string, options: { events: number }) => {
      success(
        "inspect.node",
        withService((service) =>
          service.inspectNode(reference, nodeId, options.events),
        ),
      );
    },
  );

inspect
  .command("ready")
  .description("diagnose the Ready queue without claiming work")
  .option("--graph <run-or-graph>", "filter one Run")
  .option("--actor <id>", "rank rows for one Actor")
  .action((options: { graph?: string; actor?: string }) => {
    const rows = withService((service) => [...service.listReady(options.graph)]);
    if (options.actor) {
      rows.sort((left, right) => {
        const rank = (actorHint: string | null): number =>
          actorHint === options.actor ? 0 : actorHint === null ? 1 : 2;
        return rank(left.actorHint) - rank(right.actorHint);
      });
    }
    success("inspect.ready", rows, {
      nextActions: [
        {
          id: "next",
          command: `burn-graph next --actor ${options.actor ?? "primary"}`,
          description: "Let the Runtime claim eligible nodes automatically.",
        },
      ],
    });
  });

inspect
  .command("mermaid")
  .description("return one Run or Run tree Mermaid projection inside JSON")
  .argument("<run-or-graph>")
  .addOption(
    new Option("--scope <scope>", "projection scope")
      .choices(["run", "tree"])
      .default("run"),
  )
  .option(
    "--depth <count>",
    "expanded child Run depth for tree scope",
    boundedNonNegativeInteger(8),
    0,
  )
  .option(
    "--limit <count>",
    "maximum rendered tree nodes",
    boundedInteger(500),
    500,
  )
  .action(
    (
      reference: string,
      options: { scope: RenderScope; depth: number; limit: number },
    ) => {
      const projection = withService((service) => {
        if (options.scope === "tree") {
          const tree = service.getTreeSnapshot(
            reference,
            options.depth,
            options.limit,
            0,
          );
          return {
            summary: tree.root.summary,
            source: tree.mermaid,
            projection: tree.projection,
          };
        }
        const snapshot = service.getSnapshot(reference, 0);
        return {
          summary: snapshot.summary,
          source: snapshot.mermaid,
          projection: null,
        };
      });
    success("inspect.mermaid", {
        runId: projection.summary.runId,
        graphId: projection.summary.graphId,
        runtimeRevision: projection.summary.runtimeRevision,
        scope: options.scope,
        projection: projection.projection,
        source: projection.source,
    });
    },
  );

inspect
  .command("events")
  .description("list or follow durable events")
  .argument("[run-or-graph]")
  .option("--after <sequence>", "exclusive sequence cursor", nonNegativeInteger, 0)
  .option("--limit <count>", "maximum events", boundedInteger(1_000), 100)
  .option("--follow", "stream matching events as JSON Lines")
  .action(
    async (
      reference: string | undefined,
      options: { after: number; limit: number; follow?: boolean },
    ) => {
      if (!options.follow) {
        success(
          "inspect.events",
          withService((service) =>
            service.listEvents(reference, options.after, options.limit),
          ),
        );
        return;
      }
      let cursor = options.after;
      const root = discoverProjectRoot(
        globalOptions().root ?? process.cwd(),
      );
      for (;;) {
        const service = new BurnGraphService(root);
        try {
          const batch = service.listEvents(reference, cursor, options.limit);
          for (const event of batch) {
            process.stdout.write(
              `${JSON.stringify({
                schemaVersion: 1,
                ok: true,
                command: "inspect.events",
                data: event,
              })}\n`,
            );
            cursor = event.sequence;
          }
        } finally {
          service.close();
        }
        await Bun.sleep(500);
      }
    },
  );

const recover = group("recover", "operate exceptional Assignment states");

recover
  .command("heartbeat")
  .description("renew one Assignment using the project lease")
  .requiredOption("--assignment <id>", "Assignment ID")
  .action((options: { assignment: string }) => {
    const result = withService((service) =>
      service.heartbeatAssignment(options.assignment),
    );
    success("recover.heartbeat", result.value, {
      changes: mutationChange(result),
    });
  });

recover
  .command("checkpoint")
  .description("persist bounded progress for one Assignment")
  .requiredOption("--assignment <id>", "Assignment ID")
  .requiredOption("--input <file>", "checkpoint JSON file or - for stdin")
  .action(async (options: { assignment: string; input: string }) => {
    const input = await readJsonInput(options.input);
    const result = withService((service) =>
      service.checkpointAssignment(options.assignment, input),
    );
    success("recover.checkpoint", result.value, {
      changes: mutationChange(result),
    });
  });

recover
  .command("block")
  .description("block one Assignment and continue other work")
  .requiredOption("--assignment <id>", "Assignment ID")
  .requiredOption("--reason <text>", "actionable blocking reason")
  .action((options: { assignment: string; reason: string }) => {
    scheduleSuccess(
      "recover.block",
      withService((service) =>
        service.blockAssignment(options.assignment, options.reason),
      ),
    );
  });

recover
  .command("unblock")
  .description("return one blocked Assignment node to Ready")
  .requiredOption("--assignment <id>", "prior blocked Assignment ID")
  .action((options: { assignment: string }) => {
    scheduleSuccess(
      "recover.unblock",
      withService((service) =>
        service.unblockAssignment(options.assignment),
      ),
    );
  });

recover
  .command("release")
  .description("release one Assignment and continue other work")
  .requiredOption("--assignment <id>", "Assignment ID")
  .requiredOption("--reason <text>", "release reason")
  .action((options: { assignment: string; reason: string }) => {
    scheduleSuccess(
      "recover.release",
      withService((service) =>
        service.releaseAssignment(options.assignment, options.reason),
      ),
    );
  });

recover
  .command("fail")
  .description("fail one Assignment, optionally scheduling another Attempt")
  .requiredOption("--assignment <id>", "Assignment ID")
  .requiredOption("--reason <text>", "failure reason")
  .option("--retry", "retry when maxAttempts allows")
  .action(
    (options: { assignment: string; reason: string; retry?: boolean }) => {
      scheduleSuccess(
        "recover.fail",
        withService((service) =>
          service.failAssignment(
            options.assignment,
            options.reason,
            options.retry ?? false,
          ),
        ),
      );
    },
  );

recover
  .command("reconcile")
  .description("reopen expired Assignments across all or one selected Run")
  .argument("[run-or-graph]")
  .action((reference?: string) => {
    const results = withService((service) =>
      service.reconcileExpired(reference),
    );
    const changes = results.flatMap(
      (result) =>
        result.changes ?? [
          {
            revision: result.revision,
            event: result.event,
          },
        ],
    );
    success(
      "recover.reconcile",
      {
        reconciled: results.reduce(
          (count, result) => count + result.value.length,
          0,
        ),
        runs: results.map((result) => ({
          revision: result.revision,
          nodes: result.value,
        })),
      },
      { changes },
    );
  });

const viewer = group("viewer", "manage named read-only local Viewer instances");

viewer
  .command("start")
  .description("start one named background Viewer")
  .argument("[name]", "instance name", "default")
  .option("--port <port>", "loopback port", boundedInteger(65_535), 4173)
  .option("--open", "open the healthy URL")
  .action(
    async (
      name: string,
      options: { port: number; open?: boolean },
    ) => {
      const data = await startViewerInstance(
        globalOptions().root ?? process.cwd(),
        name,
        options.port,
        options.open ?? false,
      );
      success("viewer.start", data, {
        nextActions: [
          {
            id: "status",
            command: `burn-graph viewer status ${name}`,
            description: "Check the named Viewer process and health endpoint.",
          },
          {
            id: "stop",
            command: `burn-graph viewer stop ${name}`,
            description: "Stop only this recorded Viewer process.",
          },
        ],
      });
    },
  );

viewer
  .command("status")
  .description("inspect one named Viewer")
  .argument("[name]", "instance name", "default")
  .action(async (name: string) => {
    success(
      "viewer.status",
      await viewerInstanceStatus(
        globalOptions().root ?? process.cwd(),
        name,
      ),
    );
  });

viewer
  .command("stop")
  .description("stop one exact recorded Viewer process")
  .argument("[name]", "instance name", "default")
  .action(async (name: string) => {
    success(
      "viewer.stop",
      await stopViewerInstance(
        globalOptions().root ?? process.cwd(),
        name,
      ),
    );
  });

program
  .command("__viewer-serve", { hidden: true })
  .description("internal foreground Viewer process")
  .option("--port <port>", "port", boundedInteger(65_535), 4173)
  .requiredOption("--instance-token <token>", "ownership token")
  .action(async (options: { port: number; instanceToken: string }) => {
    if (options.instanceToken.length < 1) {
      throw new BurnGraphError(
        "INVALID_INSTANCE_TOKEN",
        "Viewer instance token is required",
      );
    }
    await startViewerServer({
      projectRoot: globalOptions().root ?? process.cwd(),
      host: "127.0.0.1",
      port: options.port,
      open: false,
    });
  });

program
  .command("doctor")
  .description("inspect project, runtime, configuration, and stale claims")
  .action(() => {
    const data = withService((service) => {
      const snapshot = service.projectSnapshot();
      const staleClaims = snapshot.runs.reduce(
        (count, runSummary) =>
          count +
          service
            .getSnapshot(runSummary.runId, 0)
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
        config: service.config,
        graphCount: snapshot.graphs.length,
        runCount: snapshot.runs.length,
        staleClaims,
        healthy: staleClaims === 0,
        capabilities: {
          render: inspectRenderCapability(),
        },
      };
    });
    success("doctor", data, {
      nextActions: data.healthy
        ? [
            {
              id: "overview",
              command: "burn-graph inspect overview",
              description: "Inspect current project progress.",
            },
          ]
        : [
            {
              id: "reconcile",
              command: "burn-graph recover reconcile",
              description: "Reopen expired Assignments.",
            },
          ],
    });
  });

const helpDetails = new Map<string, HelpDetail>([
  ["init", { mutates: true, next: ["graph.apply"] }],
  ["graph", { mutates: false }],
  ["graph.validate", { mutates: false, input: "GraphSpec JSON" }],
  ["graph.apply", { mutates: true, input: "GraphSpec JSON", next: ["run.start"] }],
  ["graph.list", { mutates: false }],
  ["graph.show", { mutates: false }],
  ["graph.clone", { mutates: true, next: ["run.start"] }],
  ["run", { mutates: false }],
  [
    "run.start",
    {
      mutates: true,
      output: "WorkSchedule with AssignmentPacket[]",
      errors: ["SYSTEM_NODE_UNAVAILABLE"],
    },
  ],
  [
    "run.pause",
    {
      mutates: true,
      input: { idempotencyKey: "required stable retry key" },
      errors: ["INVALID_RUN_STATE", "IDEMPOTENCY_KEY_CONFLICT"],
    },
  ],
  [
    "run.resume",
    {
      mutates: true,
      input: { idempotencyKey: "required stable retry key" },
      output: "WorkSchedule with AssignmentPacket[]",
      errors: ["INVALID_RUN_STATE", "IDEMPOTENCY_KEY_CONFLICT"],
    },
  ],
  [
    "run.cancel",
    {
      mutates: true,
      input: { idempotencyKey: "required stable retry key" },
      errors: ["INVALID_RUN_STATE", "IDEMPOTENCY_KEY_CONFLICT"],
    },
  ],
  ["next", { mutates: true, output: "WorkSchedule with AssignmentPacket[]" }],
  ["current", { mutates: false, output: "Actor focus and complete AssignmentPacket[]" }],
  [
    "render",
    {
      mutates: false,
      output:
        "Cached SVG or PNG metadata with project-relative artifact, hash, dimensions, revision, and renderer versions",
      errors: [
        "RUN_NOT_FOUND",
        "RENDERER_UNAVAILABLE",
        "RENDER_ASSETS_MISSING",
        "RENDER_TIMEOUT",
        "RENDER_FAILED",
        "INVALID_RENDER_OUTPUT",
        "RENDER_OUTPUT_TOO_LARGE",
      ],
    },
  ],
  ["focus", { mutates: true, output: "Focused AssignmentPacket" }],
  [
    "done",
    {
      mutates: true,
      input: {
        summary: "non-empty string",
        output: "node-specific JSON value",
        evidence: "string[]",
        route: "declared Decision route only",
      },
      output: "Completion receipt plus automatically scheduled AssignmentPacket[]",
      errors: [
        "ASSIGNMENT_NOT_FOUND",
        "ASSIGNMENT_NOT_ACTIVE",
        "ASSIGNMENT_INPUT_CONFLICT",
        "OUTPUT_SCHEMA_MISMATCH",
        "INVALID_ROUTE",
        "LOOP_LIMIT_REACHED",
      ],
    },
  ],
  ["inspect", { mutates: false }],
  ["inspect.overview", { mutates: false }],
  ["inspect.run", { mutates: false }],
  ["inspect.tree", { mutates: false, output: "bounded GraphTreeSnapshot" }],
  ["inspect.node", { mutates: false }],
  ["inspect.ready", { mutates: false, next: ["next"] }],
  ["inspect.mermaid", { mutates: false, output: "{ source: Mermaid string }" }],
  ["inspect.events", { mutates: false, output: "JSON envelope or JSONL stream" }],
  ["recover", { mutates: false }],
  ["recover.heartbeat", { mutates: true }],
  [
    "recover.checkpoint",
    {
      mutates: true,
      input: {
        summary: "non-empty string",
        progress: "number 0..100 or null",
        artifacts: "string[]",
      },
    },
  ],
  ["recover.block", { mutates: true }],
  ["recover.unblock", { mutates: true }],
  ["recover.release", { mutates: true }],
  ["recover.fail", { mutates: true }],
  ["recover.reconcile", { mutates: true }],
  ["viewer", { mutates: false }],
  ["viewer.start", { mutates: true }],
  ["viewer.status", { mutates: false }],
  ["viewer.stop", { mutates: true }],
  ["doctor", { mutates: false }],
]);

const helpTopics: Readonly<Record<string, unknown>> = {
  "ai-loop": {
    title: "Guarded AI execution loop",
    sequence: [
      "burn-graph graph apply --input graph.json",
      "burn-graph run start <graph> --actor <actor>",
      "execute every returned AssignmentPacket prompt",
      "burn-graph done --assignment <id> --input -",
      "repeat returned AssignmentPacket prompts until state is completed",
    ],
    invariants: [
      "The Runtime chooses Ready nodes and legal Next transitions.",
      "Every Assignment contains prompt, context, lease, routes, and return commands.",
      "One Actor holds at most eight live Assignments across all Graphs.",
    ],
  },
  "graph-spec": {
    title: "GraphSpec authoring contract",
    source: ".burn-graph/graphs/<graph-id>.json",
    nodeTypes: [
      "start",
      "task",
      "decision",
      "join",
      "subgraph",
      "gate",
      "wait",
      "end",
    ],
    required: [
      "one Start and one End",
      "all nodes reachable and convergent",
      "Task and Decision prompt objectives",
      "explicit bounded Decision back-edges",
    ],
    commands: ["graph validate", "graph apply", "graph show"],
    executionAvailability: {
      "0.1.0-dev.5":
        "Subgraph executes; Gate and Wait authoring is contract-only.",
      next:
        "Gate and Wait execute through the System Node Driver in 0.1.0-dev.6.",
    },
  },
  lifecycle: {
    title: "Idempotent Run-tree lifecycle",
    commands: [
      "run pause <run> --idempotency-key <key>",
      "run resume <run> --actor <actor> --idempotency-key <new-key>",
      "run cancel <run> --idempotency-key <new-key>",
    ],
    invariants: [
      "Pause suppresses new descendant work while existing Assignment handles settle.",
      "Equivalent key replay adds no revision or event.",
      "Reusing a key for another operation or reference is rejected.",
    ],
  },
  inspect: {
    title: "Read-only inspection",
    commands: [
      "inspect overview",
      "inspect run",
      "inspect tree",
      "inspect node",
      "inspect ready",
      "inspect mermaid",
      "inspect events",
    ],
  },
  render: {
    title: "Project-local graph artifacts",
    default: "burn-graph render <run-or-graph>",
    scopes: ["run", "tree"],
    formats: ["svg", "png"],
    storage: ".burn-graph/runtime/renders/",
    invariants: [
      "The returned path is relative to the project root.",
      "Rendering never changes Run revision or events.",
      "Validated cache hits do not require a browser.",
      "A cache miss uses only a new isolated headless browser child.",
    ],
  },
  recover: {
    title: "Exceptional Assignment recovery",
    normalPath: "Use done; recovery commands are only for non-success outcomes.",
    commands: [
      "recover heartbeat",
      "recover checkpoint",
      "recover block",
      "recover unblock",
      "recover release",
      "recover fail",
      "recover reconcile",
    ],
  },
  errors: {
    title: "Stable error envelope",
    shape: {
      schemaVersion: 1,
      ok: false,
      command: "stable command label",
      error: {
        code: "stable machine code",
        message: "bounded explanation",
        retryable: "boolean",
        details: "object",
      },
      recoveryActions: "exact safe commands when available",
    },
  },
};

program
  .command("help")
  .description("return progressive structured Help")
  .argument("[topic...]", "topic or command path")
  .action((topic: string[]) => {
    success("help", helpPayload(topic, true));
  });

function commandForPath(parts: readonly string[]): Command | null {
  let command = program;
  for (const part of parts) {
    const next = command.commands.find(
      (candidate) =>
        !candidate.name().startsWith("__") && candidate.name() === part,
    );
    if (!next) return null;
    command = next;
  }
  return command;
}

function commandPath(command: Command): readonly string[] {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current && current !== program) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts;
}

function helpPayload(
  parts: readonly string[],
  preferTopic = false,
): unknown {
  const command = commandForPath(parts);
  if (
    parts.length === 1 &&
    (preferTopic || command === null) &&
    helpTopics[parts[0]!] !== undefined
  ) {
    return {
      topic: parts[0],
      kind: "topic",
      content: helpTopics[parts[0]!],
      next: {
        root: "burn-graph --help",
      },
    };
  }
  if (!command) {
    throw new BurnGraphError(
      "HELP_TOPIC_NOT_FOUND",
      `Unknown Help topic: ${parts.join(" ")}`,
      false,
      { topics: Object.keys(helpTopics) },
    );
  }
  const pathParts = commandPath(command);
  const key = pathParts.join(".");
  const detail = helpDetails.get(key) ?? { mutates: false };
  const visibleCommands = command.commands.filter(
    (candidate) =>
      !candidate.name().startsWith("__") && candidate.name() !== "help",
  );
  return {
    topic: key || "root",
    kind: visibleCommands.length > 0 ? "area" : "command",
    summary: command.description(),
    usage: [
      "burn-graph",
      ...pathParts,
      ...command.registeredArguments.map((argument) => {
        const name = `${argument.name()}${argument.variadic ? "..." : ""}`;
        return argument.required ? `<${name}>` : `[${name}]`;
      }),
    ].join(" "),
    mutates: detail.mutates,
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      flags: argument.required
        ? `<${argument.name()}${argument.variadic ? "..." : ""}>`
        : `[${argument.name()}${argument.variadic ? "..." : ""}]`,
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
      defaultValue: argument.defaultValue ?? null,
    })),
    options: command.options
      .filter((option) => !option.hidden)
      .map((option) => ({
        flags: option.flags,
        description: option.description,
        required: option.mandatory,
        defaultValue: option.defaultValue ?? null,
        choices: option.argChoices ?? null,
      })),
    commands: visibleCommands.map((candidate) => ({
      name: candidate.name(),
      summary: candidate.description(),
      help: `burn-graph ${[...pathParts, candidate.name()].join(" ")} --help`,
    })),
    input: detail.input ?? null,
    output: detail.output ?? {
      schemaVersion: 1,
      ok: true,
      command: key || "help",
      data: "command-specific JSON",
    },
    errors: detail.errors ?? ["INVALID_ARGUMENTS", "NOT_INITIALIZED"],
    next: detail.next ?? [],
    ...(parts.length === 0
      ? {
          quickstart: [
            "burn-graph init",
            "burn-graph graph apply --input graph.json",
            "burn-graph run start <graph> --actor primary",
            "burn-graph done --assignment <id> --input -",
          ],
          groups: {
            author: ["init", "graph"],
            execute: ["run", "next", "current", "focus", "done"],
            observe: ["inspect", "render", "viewer"],
            recover: ["recover", "doctor"],
            learn: Object.keys(helpTopics).map(
              (topic) => `burn-graph help ${topic}`,
            ),
          },
        }
      : {}),
  };
}

function commandPathBeforeHelp(args: readonly string[]): readonly string[] {
  let command = program;
  const parts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--help" || token === "-h") break;
    if (token === "--root") {
      index += 1;
      continue;
    }
    if (token === "--pretty" || token === "--version" || token === "-V") {
      continue;
    }
    const next = command.commands.find(
      (candidate) =>
        !candidate.name().startsWith("__") && candidate.name() === token,
    );
    if (next) {
      command = next;
      parts.push(token);
    } else if (
      !token.startsWith("-") &&
      command.commands.some((candidate) => !candidate.name().startsWith("__"))
    ) {
      return [...parts, token];
    }
  }
  return parts;
}

function recognizedCommandPath(args: readonly string[]): readonly string[] {
  const candidate = [...commandPathBeforeHelp(args)];
  while (candidate.length > 0 && commandForPath(candidate) === null) {
    candidate.pop();
  }
  return candidate;
}

function hasCommandOperand(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--root") {
      index += 1;
      continue;
    }
    if (
      token === "--pretty" ||
      token === "--help" ||
      token === "-h" ||
      token === "--version" ||
      token === "-V"
    ) {
      continue;
    }
    if (!token.startsWith("-")) return true;
  }
  return false;
}

function recoveryActions(error: BurnGraphError): readonly NextAction[] {
  if (error.code === "LEASE_EXPIRED") {
    return [
      {
        id: "reconcile",
        command: "burn-graph recover reconcile",
        description: "Reopen expired Assignments before requesting work.",
      },
    ];
  }
  if (error.code.startsWith("ASSIGNMENT_")) {
    return [
      {
        id: "current",
        command: "burn-graph current --actor <actor>",
        description: "Recover authoritative live Assignment handles.",
      },
    ];
  }
  if (error.code === "NOT_INITIALIZED") {
    return [
      {
        id: "init",
        command: "burn-graph init",
        description: "Initialize this project before other commands.",
      },
    ];
  }
  if (
    error.code === "RENDERER_UNAVAILABLE" ||
    error.code === "RENDER_ASSETS_MISSING"
  ) {
    return [
      {
        id: "doctor",
        command: "burn-graph doctor",
        description: "Inspect the optional render capability and recovery.",
      },
      {
        id: "render-help",
        command: "burn-graph help render",
        description: "Inspect the package-internal rendering contract.",
      },
    ];
  }
  return [
    {
      id: "help",
      command: "burn-graph help errors",
      description: "Inspect the stable error contract.",
    },
  ];
}

function configureJsonErrors(command: Command): void {
  command.configureOutput({
    outputError: () => undefined,
  });
  command.exitOverride();
  for (const child of command.commands) configureJsonErrors(child);
}

configureJsonErrors(program);

const rawArgs = process.argv.slice(2);
const helpRequested = rawArgs.some(
  (argument) => argument === "--help" || argument === "-h",
);
const versionRequested = rawArgs.some(
  (argument) => argument === "--version" || argument === "-V",
);
const commandOperandRequested = hasCommandOperand(rawArgs);
const parsedCommandPath = recognizedCommandPath(rawArgs);
if (parsedCommandPath.length > 0) {
  activeCommand = parsedCommandPath.join(".");
}

try {
  if (versionRequested) {
    success("version", { version: VERSION });
  } else if (helpRequested || !commandOperandRequested) {
    success("help", helpPayload(commandPathBeforeHelp(rawArgs)));
  } else {
    await program.parseAsync(process.argv);
  }
} catch (error) {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("commander.")
  ) {
    print({
      schemaVersion: 1,
      ok: false,
      command: activeCommand,
      error: {
        code: "INVALID_ARGUMENTS",
        message: error.message,
        retryable: false,
        details: {},
      },
      recoveryActions: [
        {
          id: "help",
          command:
            activeCommand === "parse"
              ? "burn-graph --help"
              : `burn-graph ${activeCommand.replaceAll(".", " ")} --help`,
          description: "Inspect the exact command contract.",
        },
      ],
    });
    process.exitCode = 1;
  } else {
    const normalized =
      error instanceof BurnGraphError
        ? error
        : error instanceof ZodError
          ? new BurnGraphError(
              "INVALID_INPUT",
              "Input validation failed",
              false,
              { issues: error.issues },
            )
          : new BurnGraphError(
              "INTERNAL_ERROR",
              error instanceof Error ? error.message : String(error),
            );
    print({
      schemaVersion: 1,
      ok: false,
      command: activeCommand,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        details: normalized.details,
      },
      recoveryActions: recoveryActions(normalized),
    });
    process.exitCode = 1;
  }
}
