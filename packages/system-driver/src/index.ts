import {
  BurnGraphError,
  type BurnGraphService,
  type CompletionContinuation,
  type GraphSnapshot,
  type IdempotentMutationResult,
  type MutationResult,
  type RuntimeChange,
  type SignalResolutionInput,
  type WaitSignalSummary,
  type WorkSchedule,
} from "@burn-graph/core";
import { runGateCheck } from "@burn-graph/gate";

export interface SystemDriverTrace {
  readonly transitions: number;
  readonly gateExecutions: number;
  readonly boundReached: boolean;
  readonly changes: readonly RuntimeChange[];
}

export interface DrivenSchedule extends WorkSchedule {
  readonly system: Omit<SystemDriverTrace, "changes">;
  readonly waiting: readonly WaitSignalSummary[];
}

export interface DrivenStart extends DrivenSchedule {
  readonly started: GraphSnapshot["summary"];
}

export interface DrivenCompletion extends DrivenSchedule {
  readonly completed: CompletionContinuation["completed"];
  readonly replayed: boolean;
}

export interface DrivenSignal extends DrivenSchedule {
  readonly resolved: {
    readonly signalId: string;
    readonly route: string;
    readonly replayed: boolean;
    readonly snapshot: GraphSnapshot;
  };
}

export interface DrivenSignalReceipt {
  readonly resolved: DrivenSignal["resolved"];
  readonly system: Omit<SystemDriverTrace, "changes">;
  readonly waiting: readonly WaitSignalSummary[];
  readonly changes: readonly RuntimeChange[];
}

interface PersistedSignalContinuation {
  readonly actorId: string | null;
  readonly result: DrivenSignal | DrivenSignalReceipt;
}

export interface SystemNodeDriverOptions {
  readonly maxTransitions?: number;
  readonly runGate?: typeof runGateCheck;
}

export class SystemNodeDriver {
  private readonly maximum: number;
  private readonly executeGate: typeof runGateCheck;

  constructor(
    private readonly service: BurnGraphService,
    options: SystemNodeDriverOptions = {},
  ) {
    this.maximum = options.maxTransitions ?? 64;
    if (
      !Number.isInteger(this.maximum) ||
      this.maximum < 1 ||
      this.maximum > 1_000
    ) {
      throw new BurnGraphError(
        "INVALID_DRIVER_BOUND",
        "System Driver transition bound must be 1-1000",
      );
    }
    this.executeGate = options.runGate ?? runGateCheck;
  }

  async converge(reference?: string): Promise<SystemDriverTrace> {
    const changes: RuntimeChange[] = [];
    let transitions = 0;
    let gateExecutions = 0;

    while (transitions < this.maximum) {
      const advanced = this.service.advanceSystemNodes(reference);
      if (advanced.changes.length === 0 && advanced.value === null) break;
      transitions += 1;
      changes.push(...advanced.changes);
      if (advanced.value === null) continue;

      gateExecutions += 1;
      const result = await this.executeGate(
        this.service.root,
        advanced.value.check,
      );
      const reported = this.service.reportGateExecution(
        advanced.value.executionId,
        result,
      );
      changes.push(
        ...(reported.changes ?? [{
          revision: reported.revision,
          event: reported.event,
        }]),
      );
    }

    return {
      transitions,
      gateExecutions,
      boundReached: transitions === this.maximum,
      changes,
    };
  }

  async start(
    graphId: string,
    actorId: string,
    requestedRunId?: string,
  ): Promise<DrivenStart> {
    const started = this.service.startRun(graphId, requestedRunId);
    const trace = await this.converge(started.value.summary.runId);
    const schedule = this.service.schedule(
      actorId,
      started.value.summary.runId,
    );
    return {
      ...schedule,
      started: this.service.getSnapshot(
        started.value.summary.runId,
        0,
      ).summary,
      system: this.traceSummary(trace),
      waiting: this.service.listWaitSignals(started.value.summary.runId)
        .filter((signal) => signal.status === "waiting"),
      changes: [
        ...(started.changes ?? [{
          revision: started.revision,
          event: started.event,
        }]),
        ...trace.changes,
        ...schedule.changes,
      ],
    };
  }

  async next(
    actorId: string,
    preferredRunId?: string,
  ): Promise<DrivenSchedule> {
    const trace = await this.converge(preferredRunId);
    const schedule = this.service.schedule(actorId, preferredRunId);
    return {
      ...schedule,
      system: this.traceSummary(trace),
      waiting: this.service.listWaitSignals(preferredRunId)
        .filter((signal) => signal.status === "waiting"),
      changes: [...trace.changes, ...schedule.changes],
    };
  }

  async continueSchedule<T extends WorkSchedule>(
    initial: T,
    preferredRunId?: string,
  ): Promise<T & DrivenSchedule> {
    const trace = await this.converge(preferredRunId);
    const schedule = this.service.schedule(
      initial.actorId,
      preferredRunId,
    );
    return {
      ...initial,
      ...schedule,
      system: this.traceSummary(trace),
      waiting: this.service.listWaitSignals(preferredRunId)
        .filter((signal) => signal.status === "waiting"),
      changes: [
        ...initial.changes,
        ...trace.changes,
        ...schedule.changes,
      ],
    };
  }

  async completeAndContinue(
    assignmentId: string,
    input: unknown,
  ): Promise<DrivenCompletion> {
    const completed = this.service.completeAndContinue(assignmentId, input);
    if (completed.replayed) {
      const stored = completed as typeof completed & Partial<DrivenSchedule>;
      return {
        ...completed,
        system: stored.system ?? {
          transitions: 0,
          gateExecutions: 0,
          boundReached: false,
        },
        waiting:
          stored.waiting ??
          this.service.listWaitSignals(completed.completed.runId)
            .filter((signal) => signal.status === "waiting"),
      };
    }
    const trace = await this.converge(completed.completed.runId);
    const schedule = this.service.schedule(
      completed.actorId,
      completed.completed.runId,
    );
    const result: DrivenCompletion = {
      ...schedule,
      completed: completed.completed,
      replayed: false,
      system: this.traceSummary(trace),
      waiting: this.service.listWaitSignals(completed.completed.runId)
        .filter((signal) => signal.status === "waiting"),
      changes: [
        ...completed.changes,
        ...trace.changes,
        ...schedule.changes,
      ],
    };
    this.service.storeAssignmentContinuation(assignmentId, result);
    return result;
  }

  async resume(
    reference: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<DrivenSchedule & {
    readonly resumed: GraphSnapshot["summary"];
    readonly replayed: boolean;
  }> {
    const resumed = this.service.resumeWithAssignments(
      reference,
      actorId,
      idempotencyKey,
    );
    if (resumed.replayed) {
      const stored = resumed as typeof resumed & Partial<DrivenSchedule>;
      return {
        ...resumed,
        system: stored.system ?? {
          transitions: 0,
          gateExecutions: 0,
          boundReached: false,
        },
        waiting:
          stored.waiting ??
          this.service.listWaitSignals(resumed.resumed.runId)
            .filter((signal) => signal.status === "waiting"),
      };
    }
    const trace = await this.converge(resumed.resumed.runId);
    const schedule = this.service.schedule(actorId, resumed.resumed.runId);
    const result = {
      ...schedule,
      resumed: this.service.getSnapshot(resumed.resumed.runId, 0).summary,
      replayed: false,
      system: this.traceSummary(trace),
      waiting: this.service.listWaitSignals(resumed.resumed.runId)
        .filter((signal) => signal.status === "waiting"),
      changes: [
        ...resumed.changes,
        ...trace.changes,
        ...schedule.changes,
      ],
    };
    this.service.storeLifecycleContinuation(
      "resume",
      idempotencyKey,
      result,
    );
    return result;
  }

  async resolveSignal(
    signalId: string,
    route: string,
    input: SignalResolutionInput,
    idempotencyKey: string,
    actorId?: string,
  ): Promise<DrivenSignal | DrivenSignalReceipt> {
    const resolved = this.service.resolveSignal(
      signalId,
      route,
      input,
      idempotencyKey,
    );
    const runId = resolved.value.summary.runId;
    if (resolved.replayed) {
      const stored = this.service.signalContinuation(signalId) as
        | PersistedSignalContinuation
        | null;
      if (stored) {
        if (stored.actorId !== (actorId ?? null)) {
          throw new BurnGraphError(
            "IDEMPOTENCY_KEY_CONFLICT",
            `Signal ${signalId} replay requested a different Actor`,
          );
        }
        return {
          ...stored.result,
          resolved: {
            ...stored.result.resolved,
            replayed: true,
          },
        };
      }
      const system = {
        transitions: 0,
        gateExecutions: 0,
        boundReached: false,
      };
      const waiting = this.service.listWaitSignals(runId)
        .filter((signal) => signal.status === "waiting");
      const receipt = {
        signalId,
        route,
        replayed: true,
        snapshot: resolved.value,
      };
      if (actorId === undefined) {
        return {
          resolved: receipt,
          system,
          waiting,
          changes: resolved.changes ?? [{
            revision: resolved.revision,
            event: resolved.event,
          }],
        };
      }
      return {
        ...this.service.observeSchedule(actorId, runId),
        resolved: receipt,
        system,
        waiting,
      };
    }
    const trace = await this.converge(runId);
    const changes = [
      ...(resolved.changes ?? [{
        revision: resolved.revision,
        event: resolved.event,
      }]),
      ...trace.changes,
    ];
    const receipt = {
      signalId,
      route,
      replayed: resolved.replayed,
      snapshot: this.service.getSnapshot(runId, 0),
    };
    if (actorId === undefined) {
      const result: DrivenSignalReceipt = {
        resolved: receipt,
        system: this.traceSummary(trace),
        waiting: this.service.listWaitSignals(runId)
          .filter((signal) => signal.status === "waiting"),
        changes,
      };
      this.persistSignalContinuation(signalId, null, result);
      return result;
    }
    const schedule = this.service.schedule(actorId, runId);
    const result: DrivenSignal = {
      ...schedule,
      resolved: receipt,
      system: this.traceSummary(trace),
      waiting: this.service.listWaitSignals(runId)
        .filter((signal) => signal.status === "waiting"),
      changes: [...changes, ...schedule.changes],
    };
    this.persistSignalContinuation(signalId, actorId, result);
    return result;
  }

  async reconcile(reference?: string): Promise<SystemDriverTrace> {
    const reconciled = this.service.reconcileSystemNodes(reference);
    const converged = await this.converge(reference);
    return {
      transitions:
        reconciled.changes.length + converged.transitions,
      gateExecutions: converged.gateExecutions,
      boundReached: converged.boundReached,
      changes: [...reconciled.changes, ...converged.changes],
    };
  }

  private traceSummary(
    trace: SystemDriverTrace,
  ): Omit<SystemDriverTrace, "changes"> {
    return {
      transitions: trace.transitions,
      gateExecutions: trace.gateExecutions,
      boundReached: trace.boundReached,
    };
  }

  private persistSignalContinuation(
    signalId: string,
    actorId: string | null,
    result: DrivenSignal | DrivenSignalReceipt,
  ): void {
    const record: PersistedSignalContinuation = { actorId, result };
    this.service.storeSignalContinuation(signalId, record);
  }
}

export type {
  IdempotentMutationResult,
  MutationResult,
};
