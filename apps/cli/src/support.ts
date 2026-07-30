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
import { readFileSync } from "node:fs";
import path from "node:path";

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

export interface NextAction {
  readonly id: string;
  readonly command: string;
  readonly description: string;
}

export interface Envelope {
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

export function print(envelope: Envelope): void {
  const output = JSON.stringify(envelope, null, prettyOutput() ? 2 : undefined);
  const stream = envelope.ok ? process.stdout : process.stderr;
  stream.write(`${output}\n`);
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
