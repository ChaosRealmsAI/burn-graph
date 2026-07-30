#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  initializeProject,
  type WorkSchedule,
} from "@burn-graph/core";
import {
  inspectRenderCapability,
} from "@burn-graph/render";
import { SystemNodeDriver } from "@burn-graph/system-driver";
import {
} from "@burn-graph/templates";
import { Command, Option } from "commander";
import { ZodError } from "zod";

import {
  bindProgram,
  boundedInteger,
  globalOptions,
  group,
  print,
  readJsonInput,
  scheduleSuccess,
  success,
  withService,
  withServiceAsync,
  type HelpDetail,
  type NextAction,
} from "./support.ts";
import { registerExecution } from "./commands-execution.ts";
import { registerAuthoring } from "./commands-authoring.ts";
import { registerInspect } from "./commands-inspect.ts";
import { registerRecover } from "./commands-recover.ts";
import { startViewerServer } from "./server.ts";
import {
  startViewerInstance,
  stopViewerInstance,
  viewerInstanceStatus,
} from "./viewer-runtime.ts";

const VERSION = "0.1.0-rc.1";
const program = new Command("burn-graph")
  .description("Guarded local prompt-graph control plane for AI callers")
  .option("--root <path>", "project root or descendant", process.cwd())
  .option("--pretty", "pretty-print JSON output")
  .option("-V, --version", "return version as JSON")
  .addHelpCommand(false);
let activeCommand = "parse";

bindProgram(program);

program.hook("preAction", (_rootCommand, actionCommand) => {
  const parts: string[] = [];
  let current: Command | null = actionCommand;
  while (current && current !== program) {
    parts.unshift(current.name());
    current = current.parent;
  }
  activeCommand = parts.join(".");
});

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

registerAuthoring();
registerExecution(program);

const signal = group("signal", "resolve durable external Wait outcomes");

signal
  .command("resolve")
  .description("settle one opaque Signal route and converge successors")
  .requiredOption("--signal <id>", "opaque Signal ID")
  .requiredOption("--route <route>", "one declared Signal route")
  .requiredOption("--input <file>", "resolution JSON file or - for stdin")
  .requiredOption("--idempotency-key <key>", "stable retry key")
  .option("--actor <id>", "Actor that may receive successor Assignments")
  .action(
    async (options: {
      signal: string;
      route: string;
      input: string;
      idempotencyKey: string;
      actor?: string;
    }) => {
      const input = await readJsonInput(options.input);
      const result = await withServiceAsync((service) =>
        new SystemNodeDriver(service).resolveSignal(
          options.signal,
          options.route,
          input as {
            summary: string;
            evidence: string[];
          },
          options.idempotencyKey,
          options.actor,
        ),
      );
      if ("assignments" in result) {
        scheduleSuccess("signal.resolve", result);
        return;
      }
      const { changes, ...data } = result;
      success("signal.resolve", data, {
        changes,
        nextActions: [{
          id: "next",
          command: "burn-graph next --actor primary",
          description: "Claim any AI successor through the normal scheduler.",
        }],
      });
    },
  );

registerInspect();

registerRecover();

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
      const waits = service.listWaitSignals();
      const executions = service.listCheckExecutions();
      const overdueWaits = waits.filter((signal) => signal.overdue).length;
      const expiredExecutions = executions.filter(
        (execution) =>
          ["claimed", "stale"].includes(execution.status) &&
          new Date(execution.leaseExpiresAt).getTime() <= Date.now(),
      ).length;
      const resourceLocks = service.listResourceLocks().length;
      return {
        projectId: snapshot.projectId,
        root: service.root,
        config: service.config,
        graphCount: snapshot.graphs.length,
        runCount: snapshot.runs.length,
        staleClaims,
        overdueWaits,
        expiredExecutions,
        resourceLocks,
        healthy: staleClaims === 0 && expiredExecutions === 0,
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
  ["template", { mutates: false }],
  ["template.list", { mutates: false, next: ["template.show"] }],
  ["template.show", { mutates: false, next: ["template.instantiate"] }],
  [
    "template.instantiate",
    {
      mutates: true,
      input: {
        schemaVersion: 1,
        graphId: "new project-local Graph ID",
        goal: "bounded workflow outcome",
        idempotencyKey: "input field or --idempotency-key",
      },
      output: "atomic TemplateInstantiationReceipt",
      errors: [
        "TEMPLATE_NOT_FOUND",
        "TEMPLATE_GRAPH_EXISTS",
        "TEMPLATE_STAGE_NOT_SUPPORTED",
        "TEMPLATE_OVERRIDE_NODE_NOT_FOUND",
        "CHECK_NOT_FOUND",
        "IDEMPOTENCY_KEY_CONFLICT",
      ],
      next: ["run.start"],
    },
  ],
  ["check", { mutates: false }],
  ["check.validate", { mutates: false, input: "CheckSpec JSON" }],
  ["check.apply", { mutates: true, input: "CheckSpec JSON", next: ["graph.apply"] }],
  ["check.list", { mutates: false }],
  ["check.show", { mutates: false }],
  ["run", { mutates: false }],
  [
    "run.start",
    {
      mutates: true,
      output: "WorkSchedule with AssignmentPacket[]",
      errors: ["CHECK_NOT_FOUND", "CHECK_EXECUTION_STALE"],
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
  [
    "run.priority",
    {
      mutates: true,
      input: {
        value: "low | normal | high",
        idempotencyKey: "required stable retry key",
      },
      errors: [
        "PRIORITY_ROOT_REQUIRED",
        "INVALID_RUN_STATE",
        "IDEMPOTENCY_KEY_CONFLICT",
      ],
      next: ["next"],
    },
  ],
  ["next", { mutates: true, output: "WorkSchedule with AssignmentPacket[]" }],
  ["current", { mutates: false, output: "Actor focus and complete AssignmentPacket[]" }],
  [
    "render",
    {
      mutates: false,
      output:
        "Cached SVG or PNG metadata plus the canonical tree projection when requested",
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
  ["signal", { mutates: false }],
  [
    "signal.resolve",
    {
      mutates: true,
      input: {
        summary: "non-empty bounded string",
        evidence: "project-relative string[]",
      },
      errors: [
        "SIGNAL_NOT_FOUND",
        "SIGNAL_INPUT_CONFLICT",
        "INVALID_SIGNAL_ROUTE",
      ],
    },
  ],
  ["inspect", { mutates: false }],
  ["inspect.overview", { mutates: false }],
  ["inspect.run", { mutates: false }],
  ["inspect.tree", { mutates: false, output: "bounded GraphTreeSnapshot" }],
  ["inspect.node", { mutates: false }],
  ["inspect.ready", { mutates: false, next: ["next"] }],
  ["inspect.waits", { mutates: false }],
  ["inspect.resources", { mutates: false }],
  [
    "inspect.metrics",
    {
      mutates: false,
      output: "bounded operational metrics excluding private text and output",
    },
  ],
  ["inspect.executions", { mutates: false }],
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
      "Mutating loop commands automatically settle Gate and Wait System Nodes.",
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
      "0.1.0-rc.1":
        "Subgraph, registered Gate, and durable Wait execute through the bounded System Node Driver.",
    },
  },
  lifecycle: {
    title: "Idempotent Run-tree lifecycle",
    commands: [
      "run pause <run> --idempotency-key <key>",
      "run resume <run> --actor <actor> --idempotency-key <new-key>",
      "run cancel <run> --idempotency-key <new-key>",
      "run priority <root-run> --value low|normal|high --idempotency-key <new-key>",
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
      "inspect waits",
      "inspect resources",
      "inspect metrics",
      "inspect executions",
      "inspect mermaid",
      "inspect events",
    ],
  },
  templates: {
    title: "Immutable package workflow templates",
    templates: [
      "delivery",
      "vertical-slice",
      "poc",
      "bugfix",
      "review-repair",
      "release",
    ],
    sequence: [
      "burn-graph template list",
      "burn-graph template show <template>",
      "burn-graph template instantiate <template> --input template-input.json",
      "burn-graph run start <generated-graph> --actor <actor>",
    ],
    invariants: [
      "All generated GraphSpecs and Check references validate before write.",
      "One idempotency key owns one immutable normalized result.",
      "Invalid input leaves no file or registered Graph revision.",
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
            author: ["init", "graph", "template"],
            execute: ["check", "run", "next", "current", "focus", "done", "signal"],
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
  if (error.code === "CHECK_NOT_FOUND" || error.code === "INVALID_CHECK") {
    return [{
      id: "check-help",
      command: "burn-graph check --help",
      description: "Validate and register the exact Check revision first.",
    }];
  }
  if (
    error.code === "SIGNAL_NOT_FOUND" ||
    error.code === "SIGNAL_STALE" ||
    error.code === "SIGNAL_INPUT_CONFLICT"
  ) {
    return [{
      id: "inspect-waits",
      command: "burn-graph inspect waits",
      description: "Recover authoritative opaque Signal state.",
    }];
  }
  if (error.code === "CHECK_EXECUTION_STALE") {
    return [{
      id: "reconcile",
      command: "burn-graph recover reconcile",
      description: "Reconcile the current Gate execution identity safely.",
    }];
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
