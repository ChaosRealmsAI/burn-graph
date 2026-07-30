// The execution surface: the `run` lifecycle group plus the top-level commands an
// Actor drives a Run with — next, current, render, focus and done.
//
// These are kept together because they are one workflow, not one syntax: `run
// start` hands out Assignments, `next` and `current` read them, `done` completes
// them and returns successors. Splitting on whether a command happens to sit
// under a group prefix would cut that workflow in half.
//
// Unlike the other groups this one registers directly on the program too, so it
// takes the program rather than reaching for module scope.

import {
  BurnGraphService,
  discoverProjectRoot,
  type RunPriority,
} from "@burn-graph/core";
import {
  inspectRenderCapability,
  renderGraphArtifact,
  type RenderFormat,
  type RenderScope,
} from "@burn-graph/render";
import { SystemNodeDriver } from "@burn-graph/system-driver";
import { Command, Option } from "commander";

import {
  boundedInteger,
  boundedNonNegativeInteger,
  globalOptions,
  group,
  mutationChange,
  readJsonInput,
  scheduleSuccess,
  success,
  withService,
  withServiceAsync,
} from "./support.ts";

export function registerExecution(program: Command): void {

  const run = group("run", "control Graph Run lifecycle");

  run
    .command("start")
    .description("start a Graph and immediately return prompt Assignments")
    .argument("<graph>", "Graph ID")
    .requiredOption("--actor <id>", "stable Actor ID")
    .option("--run-id <id>", "stable explicit Run ID")
    .action(
      async (
        graphId: string,
        options: { actor: string; runId?: string },
      ) => {
        const result = await withServiceAsync((service) =>
          new SystemNodeDriver(service).start(
            graphId,
            options.actor,
            options.runId,
          ),
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
      // I0010: a lifecycle mutation answers "what is this Run's state now", so it
      // returns the summary rather than the whole GraphSnapshot. Spreading the
      // snapshot shipped the full GraphSpec, every node and edge, recent events
      // and a rendered mermaid string — 542KB at 500 nodes, past this CLI's own
      // 256KB output budget, for a command whose answer is one status. Callers
      // that want the graph ask `inspect`, which is what `inspect` is for.
      success("run.pause", { summary: result.value.summary, replayed: result.replayed }, {
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
      async (
        reference: string,
        options: { actor: string; idempotencyKey: string },
      ) => {
      const result = await withServiceAsync((service) =>
        new SystemNodeDriver(service).resume(
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
      // I0010: a lifecycle mutation answers "what is this Run's state now", so it
      // returns the summary rather than the whole GraphSnapshot. Spreading the
      // snapshot shipped the full GraphSpec, every node and edge, recent events
      // and a rendered mermaid string — 542KB at 500 nodes, past this CLI's own
      // 256KB output budget, for a command whose answer is one status. Callers
      // that want the graph ask `inspect`, which is what `inspect` is for.
      success("run.cancel", { summary: result.value.summary, replayed: result.replayed }, {
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

  run
    .command("priority")
    .description("set one root Run priority idempotently")
    .argument("<run-or-graph>")
    .addOption(
      new Option("--value <priority>", "root scheduling priority")
        .choices(["low", "normal", "high"])
        .makeOptionMandatory(),
    )
    .requiredOption("--idempotency-key <key>", "stable retry key")
    .action((
      reference: string,
      options: { value: RunPriority; idempotencyKey: string },
    ) => {
      const result = withService((service) =>
        service.setRunPriority(
          reference,
          options.value,
          options.idempotencyKey,
        ),
      );
      success(
        "run.priority",
        { ...result.value, replayed: result.replayed },
        {
          changes: result.changes ?? mutationChange(result),
          nextActions: [{
            id: "next",
            command: "burn-graph next --actor primary",
            description: "Schedule eligible roots under the updated priority.",
          }],
        },
      );
    });

  program
    .command("next")
    .description("resume and automatically fill one Actor's Assignment slots")
    .requiredOption("--actor <id>", "stable Actor ID")
    .option("--graph <run-or-graph>", "prefer and converge one Run tree")
    .action(async (options: { actor: string; graph?: string }) => {
      scheduleSuccess(
        "next",
        await withServiceAsync((service) =>
          new SystemNodeDriver(service).next(options.actor, options.graph),
        ),
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
        success("render", {
          ...data,
          projection: projection.tree,
        }, {
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
      const result = await withServiceAsync((service) =>
        new SystemNodeDriver(service).completeAndContinue(
          options.assignment,
          input,
        ),
      );
      scheduleSuccess("done", result);
    });

}
