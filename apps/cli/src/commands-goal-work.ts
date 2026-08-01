// The public Goal–Graph–Work surface. Legacy Run/Assignment commands remain
// available for GraphSpec v1/v2 compatibility, while new callers can stay
// entirely inside the three product concepts.

import { BurnGraphError } from "@burn-graph/core";
import { SystemNodeDriver } from "@burn-graph/system-driver";

import {
  group,
  mutationChange,
  readJsonInput,
  resolveActor,
  scheduleSuccess,
  success,
  withService,
  withServiceAsync,
} from "./support.ts";

export function registerGoalWork(): void {
  const goal = group("goal", "start and inspect evidence-reviewed Goals");

  goal
    .command("start")
    .description("start one GraphSpec v3 Goal and return its first Work")
    .argument("<graph>", "Graph ID")
    .option("--actor <id>", "stable Actor ID; defaults to project Actor")
    .option("--run-id <id>", "stable explicit Run ID")
    .action(async (
      graphId: string,
      options: { actor?: string; runId?: string },
    ) => {
      const result = await withServiceAsync((service) => {
        const graph = service.getGraph(graphId);
        if (graph.schemaVersion !== 3) {
          throw new BurnGraphError(
            "GOAL_CONTRACT_REQUIRED",
            "goal start requires a GraphSpec v3 evidence contract",
            false,
            { graphId, schemaVersion: graph.schemaVersion },
          );
        }
        return new SystemNodeDriver(service).start(
          graphId,
          resolveActor(service, options.actor),
          options.runId,
        );
      });
      scheduleSuccess("goal.start", result);
    });

  goal
    .command("show")
    .description("show one Goal contract, verified progress, Review, and amendments")
    .argument("<run-or-graph>")
    .action((reference: string) => {
      const data = withService((service) => {
        const snapshot = service.getSnapshot(reference, 0);
        if (snapshot.summary.goalState === null) {
          throw new BurnGraphError(
            "GOAL_NOT_AVAILABLE",
            `${reference} does not use GraphSpec v3`,
          );
        }
        return {
          runId: snapshot.summary.runId,
          graphId: snapshot.summary.graphId,
          runStatus: snapshot.summary.status,
          runtimeRevision: snapshot.summary.runtimeRevision,
          goal: snapshot.summary.goalState,
        };
      });
      success("goal.show", data, {
        nextActions: data.goal.status === "satisfied"
          ? [{
              id: "inspect",
              command: `burn-graph inspect run ${data.runId}`,
              description: "Inspect the completed Graph and event evidence.",
            }]
          : [{
              id: "next-work",
              command: `burn-graph work next --graph ${data.runId}`,
              description: "Claim currently eligible Work.",
            }],
      });
    });

  goal
    .command("list")
    .description("list GraphSpec v3 Goals and their current verified progress")
    .action(() => {
      const goals = withService((service) =>
        service.listRuns()
          .filter((run) => run.goalState !== null)
          .map((run) => ({
            runId: run.runId,
            graphId: run.graphId,
            runStatus: run.status,
            updatedAt: run.updatedAt,
            goal: run.goalState,
          })),
      );
      success("goal.list", { goals, count: goals.length });
    });

  goal
    .command("amend")
    .description("propose an append-only change to current Goal evidence")
    .argument("<run-or-graph>")
    .requiredOption("--input <file>", "amendment JSON file or - for stdin")
    .requiredOption("--idempotency-key <key>", "stable retry key")
    .option("--actor <id>", "proposing Actor; defaults to project Actor")
    .action(async (
      reference: string,
      options: { input: string; idempotencyKey: string; actor?: string },
    ) => {
      const input = await readJsonInput(options.input);
      const result = withService((service) =>
        service.proposeGoalAmendment(
          reference,
          resolveActor(service, options.actor),
          options.idempotencyKey,
          input,
        ),
      );
      success("goal.amend", {
        goal: result.value,
        replayed: result.replayed,
      }, {
        changes: mutationChange(result),
        nextActions: [{
          id: "review-amendment",
          command:
            "burn-graph goal review-amendment <amendment-id> --actor <different-actor> --idempotency-key <new-key> --input -",
          description: "Independently accept or reject the evidence change.",
        }],
      });
    });

  goal
    .command("review-amendment")
    .description("independently accept or reject one Goal evidence amendment")
    .argument("<amendment>", "amendment ID")
    .requiredOption("--input <file>", "Review JSON file or - for stdin")
    .requiredOption("--idempotency-key <key>", "stable retry key")
    .option("--actor <id>", "reviewing Actor; defaults to project Actor")
    .action(async (
      amendmentId: string,
      options: { input: string; idempotencyKey: string; actor?: string },
    ) => {
      const input = await readJsonInput(options.input);
      const result = withService((service) =>
        service.reviewGoalAmendment(
          amendmentId,
          resolveActor(service, options.actor),
          options.idempotencyKey,
          input,
        ),
      );
      success("goal.review-amendment", {
        goal: result.value,
        replayed: result.replayed,
      }, {
        changes: mutationChange(result),
        nextActions: [{
          id: "next-work",
          command: "burn-graph work next",
          description: "Continue against the effective evidence contract.",
        }],
      });
    });

  const work = group("work", "claim, record, complete, and recover Work");

  work
    .command("next")
    .description("claim eligible Work for one Actor")
    .option("--actor <id>", "stable Actor ID; defaults to project Actor")
    .option("--graph <run-or-graph>", "prefer and converge one Goal Graph")
    .action(async (options: { actor?: string; graph?: string }) => {
      const result = await withServiceAsync((service) =>
        new SystemNodeDriver(service).next(
          resolveActor(service, options.actor),
          options.graph,
        ),
      );
      scheduleSuccess("work.next", result);
    });

  work
    .command("current")
    .description("show one Actor's current complete Work packets")
    .option("--actor <id>", "stable Actor ID; defaults to project Actor")
    .action((options: { actor?: string }) => {
      const data = withService((service) => {
        const actor = resolveActor(service, options.actor);
        return {
          actor,
          work: service.actorWork(actor),
          assignments: service.assignmentsForActor(actor),
        };
      });
      success("work.current", data, {
        nextActions: data.assignments.length > 0
          ? data.assignments.map((assignment) => ({
              id: `complete:${assignment.assignmentId}`,
              command: assignment.returnProtocol.complete,
              description: `Execute "${assignment.node.title}" and return its record.`,
            }))
          : [{
              id: "next-work",
              command: `burn-graph work next --actor ${data.actor}`,
              description: "Request eligible Work.",
            }],
      });
    });

  work
    .command("done")
    .description("complete one Work packet and return successors")
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
      scheduleSuccess("work.done", result);
    });

  work
    .command("checkpoint")
    .description("persist a structured Work record without changing progress")
    .requiredOption("--assignment <id>", "Assignment ID")
    .requiredOption("--input <file>", "checkpoint JSON file or - for stdin")
    .action(async (options: { assignment: string; input: string }) => {
      const input = await readJsonInput(options.input);
      const result = withService((service) =>
        service.checkpointAssignment(options.assignment, input),
      );
      success("work.checkpoint", result.value, {
        changes: mutationChange(result),
      });
    });

  work
    .command("block")
    .description("record an actionable blocker and continue other Work")
    .requiredOption("--assignment <id>", "Assignment ID")
    .requiredOption("--reason <text>", "actionable blocking reason")
    .action(async (options: { assignment: string; reason: string }) => {
      const result = await withServiceAsync(async (service) => {
        const initial = service.blockAssignment(options.assignment, options.reason);
        return new SystemNodeDriver(service).continueSchedule(
          initial,
          initial.runs[0]?.runId,
        );
      });
      scheduleSuccess("work.block", result);
    });

  work
    .command("fail")
    .description("fail one Work packet, optionally opening another Attempt")
    .requiredOption("--assignment <id>", "Assignment ID")
    .requiredOption("--reason <text>", "failure reason")
    .option("--retry", "retry when maxAttempts allows")
    .action(async (
      options: { assignment: string; reason: string; retry?: boolean },
    ) => {
      const result = await withServiceAsync(async (service) => {
        const initial = service.failAssignment(
          options.assignment,
          options.reason,
          options.retry ?? false,
        );
        return new SystemNodeDriver(service).continueSchedule(
          initial,
          initial.runs[0]?.runId,
        );
      });
      scheduleSuccess("work.fail", result);
    });
}
