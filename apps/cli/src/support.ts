// Shared CLI infrastructure: the envelope contract, output, service lifetime,
// argument parsers and the Run-schedule helpers every command group uses.
//
// Split out of index.ts, which had grown to 2236 lines holding this substrate
// plus eight command groups, so a change to one command sat in the same file as
// every other. Nothing here registers a command; index.ts still owns the program
// and the wiring order.

import {
  BurnGraphError,
  BurnGraphService,
  type GraphStatus,
  type NodeStatus,
  type RuntimeChange,
  type WorkSchedule,
} from "@burn-graph/core";
import { Command } from "commander";

import {
  printEnvelope,
  readConfinedJsonInput,
  type Envelope,
  type NextAction,
} from "./public-io.ts";

// The envelope shape and the code that emits it belong together, so both live in
// public-io.ts and are re-exported here. Every command group already imports its
// infrastructure from this module; a second declaration of Envelope would let the
// printer and its callers drift apart silently.
export type { Envelope, NextAction };

// The root program is bound once at startup rather than imported, because the
// helpers below need the parsed global options and the program is what owns
// them. An explicit binding with a named failure beats a module-level `program`
// that silently reads as undefined when the wiring order changes.
let rootProgram: Command | null = null;

export function bindProgram(program: Command): void {
  rootProgram = program;
}

function requireProgram(): Command {
  if (!rootProgram) {
    throw new Error("bindProgram must run before any CLI helper is used");
  }
  return rootProgram;
}

export const GRAPH_STATUSES: readonly GraphStatus[] = [
  "draft",
  "running",
  "pausing",
  "paused",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
];
export const NODE_STATUSES: readonly NodeStatus[] = [
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

export interface GlobalOptions {
  readonly root?: string;
  readonly pretty?: boolean;
  readonly version?: boolean;
}

export interface HelpDetail {
  readonly mutates: boolean;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly errors?: readonly string[];
  readonly next?: readonly string[];
}

export function group(name: string, description: string): Command {
  return requireProgram()
    .command(name)
    .description(description)
    .addHelpCommand(false);
}

export function globalOptions(): GlobalOptions {
  return requireProgram().opts<GlobalOptions>();
}

export function prettyOutput(): boolean {
  return globalOptions().pretty === true || process.argv.includes("--pretty");
}

export function print(
  envelope: Envelope,
  options: { readonly forceCompact?: boolean } = {},
): void {
  // forceCompact exists for `inspect events`, which frames one JSON value per
  // line: pretty-printing there would break the framing the stream contract
  // promises, regardless of the global --pretty flag.
  const rootInput = globalOptions().root;
  printEnvelope(envelope, {
    pretty: options.forceCompact === true ? false : prettyOutput(),
    ...(rootInput === undefined ? {} : { rootInput }),
  });
}

export function success(
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

export function withService<T>(operation: (service: BurnGraphService) => T): T {
  const service = new BurnGraphService(globalOptions().root ?? process.cwd());
  try {
    return operation(service);
  } finally {
    service.close();
  }
}

export async function withServiceAsync<T>(
  operation: (service: BurnGraphService) => Promise<T>,
): Promise<T> {
  const service = new BurnGraphService(globalOptions().root ?? process.cwd());
  try {
    return await operation(service);
  } finally {
    service.close();
  }
}

export async function readJsonInput(input: string): Promise<unknown> {
  return readConfinedJsonInput(input, globalOptions().root ?? process.cwd());
}

// An explicit --actor always wins; otherwise the project's configured Actor, and
// only then the "primary" default. Requiring --actor on every command was the
// single largest source of noise in the authoring loop S16 exists to shorten.
export function resolveActor(
  service: BurnGraphService,
  requested?: string,
): string {
  if (requested !== undefined) return requested;
  const configured = (service.config as unknown as { defaultActor?: unknown })
    .defaultActor;
  return typeof configured === "string" && configured.length > 0
    ? configured
    : "primary";
}

export function boundedInteger(maximum: number) {
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

export function nonNegativeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new BurnGraphError(
      "INVALID_NUMBER",
      `${value} must be a non-negative integer`,
    );
  }
  return number;
}

export function boundedNonNegativeInteger(maximum: number) {
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

export function scheduleActions(schedule: WorkSchedule): readonly NextAction[] {
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
              command: `burn-graph work next --actor ${schedule.actorId}`,
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

export function scheduleSuccess<T extends WorkSchedule>(
  command: string,
  result: T,
): void {
  const { changes, ...data } = result;
  success(command, data, {
    changes,
    nextActions: scheduleActions(result),
  });
}

export function mutationChange(result: {
  readonly revision: number;
  readonly event: RuntimeChange["event"];
}): readonly RuntimeChange[] {
  return [{ revision: result.revision, event: result.event }];
}

export function parseNodeStatuses(value?: string): readonly NodeStatus[] | null {
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
