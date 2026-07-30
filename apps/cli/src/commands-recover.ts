// The `recover` command group: operating Assignments that fell out of the
// normal lifecycle — expired claims, stale Gate executions and stranded Waits.
//
// Kept apart from the everyday command groups because recovery is the path a
// caller reaches for when the ordinary ones have already failed, and it should
// be readable without wading through them.

import { SystemNodeDriver } from "@burn-graph/system-driver";

import {
  group,
  mutationChange,
  readJsonInput,
  scheduleSuccess,
  success,
  withService,
  withServiceAsync,
} from "./support.ts";

export function registerRecover(): void {
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
    .action(async (options: { assignment: string; reason: string }) => {
      const result = await withServiceAsync(async (service) => {
        const initial = service.blockAssignment(
          options.assignment,
          options.reason,
        );
        return new SystemNodeDriver(service).continueSchedule(
          initial,
          initial.runs[0]?.runId,
        );
      });
      scheduleSuccess(
        "recover.block",
        result,
      );
    });

  recover
    .command("unblock")
    .description("return one blocked Assignment node to Ready")
    .requiredOption("--assignment <id>", "prior blocked Assignment ID")
    .action(async (options: { assignment: string }) => {
      const result = await withServiceAsync(async (service) => {
        const initial = service.unblockAssignment(options.assignment);
        return new SystemNodeDriver(service).continueSchedule(
          initial,
          initial.runs[0]?.runId,
        );
      });
      scheduleSuccess(
        "recover.unblock",
        result,
      );
    });

  recover
    .command("release")
    .description("release one Assignment and continue other work")
    .requiredOption("--assignment <id>", "Assignment ID")
    .requiredOption("--reason <text>", "release reason")
    .action(async (options: { assignment: string; reason: string }) => {
      const result = await withServiceAsync(async (service) => {
        const initial = service.releaseAssignment(
          options.assignment,
          options.reason,
        );
        return new SystemNodeDriver(service).continueSchedule(
          initial,
          initial.runs[0]?.runId,
        );
      });
      scheduleSuccess(
        "recover.release",
        result,
      );
    });

  recover
    .command("fail")
    .description("fail one Assignment, optionally scheduling another Attempt")
    .requiredOption("--assignment <id>", "Assignment ID")
    .requiredOption("--reason <text>", "failure reason")
    .option("--retry", "retry when maxAttempts allows")
    .action(
      async (options: { assignment: string; reason: string; retry?: boolean }) => {
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
        scheduleSuccess(
          "recover.fail",
          result,
        );
      },
    );

  recover
    .command("reconcile")
    .description("reconcile expired Assignments, Gates, and due Waits")
    .argument("[run-or-graph]")
    .option("--actor <id>", "Actor that may receive work after reconciliation")
    .action(
      async (reference: string | undefined, options: { actor?: string }) => {
        const result = await withServiceAsync(async (service) => {
          const assignments = service.reconcileExpired(reference);
          const system = await new SystemNodeDriver(service).reconcile(reference);
          const assignmentChanges = assignments.flatMap(
            (entry) =>
              entry.changes ?? [{
                revision: entry.revision,
                event: entry.event,
              }],
          );
          const changes = [...assignmentChanges, ...system.changes];
          if (options.actor) {
            const schedule = service.schedule(options.actor, reference);
            return {
              kind: "schedule" as const,
              value: {
                ...schedule,
                reconciledAssignments: assignments.reduce(
                  (count, entry) => count + entry.value.length,
                  0,
                ),
                reconciled: assignments.reduce(
                  (count, entry) => count + entry.value.length,
                  0,
                ),
                system: {
                  transitions: system.transitions,
                  gateExecutions: system.gateExecutions,
                  boundReached: system.boundReached,
                },
                changes: [...changes, ...schedule.changes],
              },
            };
          }
          return {
            kind: "receipt" as const,
            value: {
              reconciledAssignments: assignments.reduce(
                (count, entry) => count + entry.value.length,
                0,
              ),
              reconciled: assignments.reduce(
                (count, entry) => count + entry.value.length,
                0,
              ),
              system: {
                transitions: system.transitions,
                gateExecutions: system.gateExecutions,
                boundReached: system.boundReached,
              },
              changes,
            },
          };
        });
        if (result.kind === "schedule") {
          scheduleSuccess("recover.reconcile", result.value);
          return;
        }
        const { changes, ...data } = result.value;
        success("recover.reconcile", data, { changes });
      },
    );

}
