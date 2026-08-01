import { z } from "zod";

import {
  BurnGraphError,
  CompletionInputSchema,
  GoalAmendmentChangeSchema,
  GoalAmendmentProposalInputSchema,
  GoalAmendmentReviewInputSchema,
  IdempotencyKeySchema,
  IdentifierSchema,
  type CheckpointInput,
  type CompletionInput,
  type GoalAmendmentChange,
  type GoalAmendmentProposalInput,
  type GoalAmendmentReviewInput,
  type GoalAmendmentSummary,
  type GoalContract,
  type GoalEvidenceRequirement,
  type GoalSnapshot,
  type GraphEvent,
  type GraphSpec,
  type IdempotentMutationResult,
  type ReviewVerdict,
  type WorkRecord,
} from "./contracts.ts";
import {
  json,
  numberValue,
  optionalString,
  stableJson,
  stringValue,
  type Row,
} from "./sql.ts";
import { BurnGraphDatabase } from "./storage.ts";
import type { ValidatedGraph } from "./validator.ts";

const MAX_GOAL_AMENDMENTS = 32;
const MAX_GOAL_AMENDMENT_HISTORY_BYTES = 64 * 1024;

interface GoalRuntimeOptions {
  readonly database: BurnGraphDatabase;
  readonly timestamp: () => string;
  readonly resolveRun: (reference: string) => string;
  readonly graphForRun: (runId: string) => ValidatedGraph;
  readonly bumpRun: (runId: string, at: string) => number;
  readonly appendEvent: (input: {
    readonly runId: string;
    readonly graphId: string;
    readonly nodeId: string | null;
    readonly type: string;
    readonly summary: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly at: string;
  }) => number;
  readonly getEvent: (sequence: number) => GraphEvent;
}

interface CurrentWorkState {
  readonly nodeId: string;
  readonly status: string;
  readonly attempt: number;
  readonly actorId: string | null;
  readonly result: CompletionInput | null;
  readonly updatedAt: string;
}

interface EvidenceClaimState {
  readonly nodeId: string;
  readonly actorId: string | null;
  readonly evidenceId: string;
}

interface ReviewState {
  readonly nodeId: string;
  readonly actorId: string | null;
  readonly result: CompletionInput;
  readonly updatedAt: string;
}

interface EffectiveGoalState {
  readonly contract: GoalContract;
  readonly ownership: ReadonlyMap<string, string>;
  readonly amendments: readonly GoalAmendmentSummary[];
  readonly pending: boolean;
}

export function goalObjective(spec: GraphSpec): string {
  return typeof spec.goal === "string" ? spec.goal : spec.goal.objective;
}

export function isGoalGraph(spec: GraphSpec): spec is Extract<
  GraphSpec,
  { schemaVersion: 3 }
> {
  return spec.schemaVersion === 3;
}

function meaningfulRecord(record: WorkRecord | undefined): boolean {
  return record !== undefined && (
    record.facts.length > 0 ||
    record.decisions.length > 0 ||
    record.blockers.length > 0 ||
    record.artifacts.length > 0 ||
    record.next !== null
  );
}

function parseCompletion(value: string | null, context: string): CompletionInput | null {
  if (value === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new BurnGraphError(
      "CORRUPT_STATE",
      `${context} contains malformed completion JSON`,
    );
  }
  const parsed = CompletionInputSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new BurnGraphError(
      "CORRUPT_STATE",
      `${context} contains an invalid completion`,
      false,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function parsePersisted<T>(
  value: string,
  schema: z.ZodType<T>,
  context: string,
): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new BurnGraphError(
      "CORRUPT_STATE",
      `${context} contains malformed JSON`,
    );
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw new BurnGraphError(
      "CORRUPT_STATE",
      `${context} contains invalid persisted JSON`,
      false,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function evidenceTarget(change: GoalAmendmentChange): string {
  return change.op === "add" ? change.evidence.id : change.evidenceId;
}

function applyEvidenceChanges(
  baseline: readonly GoalEvidenceRequirement[],
  changes: readonly GoalAmendmentChange[],
  corrupt: boolean,
): GoalEvidenceRequirement[] {
  const evidence = new Map(baseline.map((entry) => [entry.id, { ...entry }]));
  const touched = new Set<string>();
  const fail = (message: string, details: Readonly<Record<string, unknown>>): never => {
    throw new BurnGraphError(
      corrupt ? "CORRUPT_STATE" : "INVALID_GOAL_AMENDMENT",
      message,
      false,
      details,
    );
  };

  for (const change of changes) {
    const target = evidenceTarget(change);
    if (touched.has(target)) {
      fail(`Goal amendment changes evidence ${target} more than once`, {
        evidenceId: target,
      });
    }
    touched.add(target);
    if (change.op === "add") {
      if (evidence.has(change.evidence.id)) {
        fail(`Goal evidence ${change.evidence.id} already exists`, {
          evidenceId: change.evidence.id,
        });
      }
      evidence.set(change.evidence.id, { ...change.evidence });
      continue;
    }
    const current = evidence.get(change.evidenceId) ??
      fail(`Goal evidence ${change.evidenceId} does not exist`, {
        evidenceId: change.evidenceId,
      });
    if (change.op === "remove") {
      evidence.delete(change.evidenceId);
      continue;
    }
    evidence.set(change.evidenceId, {
      ...current,
      ...(change.description === undefined
        ? {}
        : { description: change.description }),
      ...(change.acceptance === undefined
        ? {}
        : { acceptance: change.acceptance }),
      ...(change.oracle === undefined ? {} : { oracle: change.oracle }),
    });
  }
  if (evidence.size === 0) {
    fail("A Goal must retain at least one success-evidence requirement", {});
  }
  return [...evidence.values()];
}

function finalReviewId(
  spec: Extract<GraphSpec, { schemaVersion: 3 }>,
): string {
  const baselineEvidence = spec.goal.successEvidence.map((entry) => entry.id);
  const reviews = spec.nodes.filter(
    (node) =>
      node.work?.kind === "review" &&
      baselineEvidence.every((evidenceId) => node.work?.evidence.includes(evidenceId)),
  );
  if (reviews.length !== 1) {
    throw new BurnGraphError(
      "CORRUPT_STATE",
      "GraphSpec v3 lost its unique final Review Work",
    );
  }
  return reviews[0]!.id;
}

function baselineOwnership(
  spec: Extract<GraphSpec, { schemaVersion: 3 }>,
): Map<string, string> {
  const ownership = new Map<string, string>();
  for (const node of spec.nodes) {
    if (node.work?.kind !== "execute") continue;
    for (const evidenceId of node.work.evidence) {
      if (ownership.has(evidenceId)) {
        throw new BurnGraphError(
          "CORRUPT_STATE",
          `Goal evidence ${evidenceId} has duplicate Work ownership`,
        );
      }
      ownership.set(evidenceId, node.id);
    }
  }
  return ownership;
}

function applyOwnershipChanges(
  baseline: ReadonlyMap<string, string>,
  changes: readonly GoalAmendmentChange[],
  spec: Extract<GraphSpec, { schemaVersion: 3 }>,
  corrupt: boolean,
): Map<string, string> {
  const ownership = new Map(baseline);
  const finalReview = spec.nodes.find((node) => node.id === finalReviewId(spec))!;
  const fail = (message: string, details: Readonly<Record<string, unknown>>): never => {
    throw new BurnGraphError(
      corrupt ? "CORRUPT_STATE" : "INVALID_GOAL_AMENDMENT",
      message,
      false,
      details,
    );
  };
  for (const change of changes) {
    if (change.op === "add") {
      const owner = spec.nodes.find((node) => node.id === change.ownerWorkId);
      if (owner?.work?.kind !== "execute") {
        fail(`Goal evidence ${change.evidence.id} needs existing execution Work ownership`, {
          evidenceId: change.evidence.id,
          ownerWorkId: change.ownerWorkId,
        });
      }
      if (!finalReview.work?.reviewOf.includes(change.ownerWorkId)) {
        fail(`Final Review Work does not cover ${change.ownerWorkId}`, {
          evidenceId: change.evidence.id,
          ownerWorkId: change.ownerWorkId,
          reviewWorkId: finalReview.id,
        });
      }
      ownership.set(change.evidence.id, change.ownerWorkId);
    } else if (change.op === "remove") {
      ownership.delete(change.evidenceId);
    }
  }
  return ownership;
}

export class GoalRuntime {
  constructor(private readonly options: GoalRuntimeOptions) {}

  get(reference: string): GoalSnapshot | null {
    return this.snapshot(this.options.resolveRun(reference));
  }

  snapshot(runId: string): GoalSnapshot | null {
    const spec = this.options.graphForRun(runId).spec;
    if (!isGoalGraph(spec)) return null;
    const effective = this.effectiveGoal(runId, spec);
    const evidenceIds = new Set(
      effective.contract.successEvidence.map((entry) => entry.id),
    );
    const work = this.currentWork(runId, spec);
    const byNode = new Map(work.map((entry) => [entry.nodeId, entry]));
    const claims: EvidenceClaimState[] = [];
    for (const node of spec.nodes) {
      if (node.work?.kind !== "execute") continue;
      const current = byNode.get(node.id);
      if (!current?.result) continue;
      for (const claim of current.result.evidenceClaims) {
        if (
          !evidenceIds.has(claim.evidenceId) ||
          effective.ownership.get(claim.evidenceId) !== node.id
        ) continue;
        claims.push({
          nodeId: node.id,
          actorId: current.actorId,
          evidenceId: claim.evidenceId,
        });
      }
    }
    const claimsByEvidence = new Map<string, EvidenceClaimState[]>();
    for (const claim of claims) {
      const existing = claimsByEvidence.get(claim.evidenceId) ?? [];
      existing.push(claim);
      claimsByEvidence.set(claim.evidenceId, existing);
    }

    const goalReviewId = finalReviewId(spec);
    const currentReviews: ReviewState[] = [];
    for (const node of spec.nodes) {
      if (node.id !== goalReviewId || node.work?.kind !== "review") continue;
      const current = byNode.get(node.id);
      if (!current?.result?.verdict) continue;
      currentReviews.push({
        nodeId: node.id,
        actorId: current.actorId,
        result: current.result,
        updatedAt: current.updatedAt,
      });
    }
    const validPass = currentReviews
      .filter((review) =>
        this.isValidCurrentPass(
          spec,
          review,
          evidenceIds,
          claims,
          effective.pending,
        )
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;

    const latestReview = validPass ?? this.latestReview(runId, spec);
    const reviewNodes = spec.nodes.filter((node) => node.id === goalReviewId);
    const reviewRunning = reviewNodes.some(
      (node) => byNode.get(node.id)?.status === "running",
    );
    const reviewReady = reviewNodes.some((node) => {
      const reviewed = new Set(node.work?.reviewOf ?? []);
      return [...evidenceIds].every((evidenceId) =>
        claims.some(
          (claim) =>
            claim.evidenceId === evidenceId && reviewed.has(claim.nodeId),
        )
      );
    });
    const reviewStatus: GoalSnapshot["review"]["status"] = validPass
      ? "pass"
      : reviewRunning
        ? "running"
        : reviewReady && !effective.pending
          ? "ready"
          : latestReview?.result.verdict?.decision === "revise"
            ? "revise"
            : "pending";

    const verifiedIds = validPass ? evidenceIds : new Set<string>();
    const workNodes = spec.nodes.filter((node) => node.work !== undefined);
    const executionNodes = spec.nodes.filter(
      (node) => node.work?.kind === "execute",
    );
    const executed = workNodes.filter((node) => byNode.get(node.id)?.result !== null)
      .length;
    const verifiedWork = validPass
      ? executionNodes.filter((node) => byNode.get(node.id)?.result !== null).length
      : 0;
    const run = this.options.database.db
      .query("SELECT status FROM runs WHERE run_id = ?")
      .get(runId) as Row | null;
    if (!run) throw new BurnGraphError("RUN_NOT_FOUND", `Unknown run ${runId}`);
    const runStatus = stringValue(run, "status");
    const goalStatus: GoalSnapshot["status"] = runStatus === "failed"
      ? "failed"
      : runStatus === "cancelled"
        ? "cancelled"
        : effective.pending
          ? "amendment_pending"
          : validPass
            ? "satisfied"
            : reviewStatus === "pending"
              ? "active"
              : "reviewing";
    const required = evidenceIds.size;
    const verified = verifiedIds.size;

    return {
      schemaVersion: 1,
      objective: effective.contract.objective,
      boundaries: effective.contract.boundaries,
      status: goalStatus,
      progress: {
        percent: Math.floor((verified / required) * 100),
        work: { total: workNodes.length, executed, verified: verifiedWork },
        evidence: {
          required,
          claimed: [...evidenceIds].filter((id) => claimsByEvidence.has(id)).length,
          verified,
        },
      },
      evidence: effective.contract.successEvidence.map((entry) => {
        const ownerWorkId = effective.ownership.get(entry.id);
        if (ownerWorkId === undefined) {
          throw new BurnGraphError(
            "CORRUPT_STATE",
            `Goal evidence ${entry.id} has no Work owner`,
          );
        }
        return {
          ...entry,
          ownerWorkId,
          claimed: claimsByEvidence.has(entry.id),
          verified: verifiedIds.has(entry.id),
          claimCount: claimsByEvidence.get(entry.id)?.length ?? 0,
        };
      }),
      review: {
        required: true,
        independentActor: true,
        status: reviewStatus,
        reviewerActorId: latestReview?.actorId ?? null,
        summary: latestReview?.result.verdict?.summary ?? null,
        findings: latestReview?.result.verdict?.findings ?? [],
      },
      amendments: effective.amendments,
    };
  }

  assertReviewClaimAllowed(
    runId: string,
    nodeId: string,
    actorId: string,
    spec: GraphSpec,
  ): void {
    if (!isGoalGraph(spec)) return;
    const node = spec.nodes.find((candidate) => candidate.id === nodeId);
    if (node?.work?.kind !== "review") return;
    const current = new Map(
      this.currentWork(runId, spec).map((entry) => [entry.nodeId, entry]),
    );
    const conflicts = node.work.reviewOf.filter((reviewedId) => {
      const work = current.get(reviewedId);
      return work?.result !== null && work?.actorId === actorId;
    });
    if (conflicts.length > 0) {
      throw new BurnGraphError(
        "REVIEW_INDEPENDENCE_REQUIRED",
        `Actor ${actorId} cannot review Work it completed`,
        true,
        { runId, nodeId, actorId, reviewOf: conflicts },
      );
    }
  }

  validateCheckpoint(
    runId: string,
    nodeId: string,
    checkpoint: CheckpointInput,
    spec: GraphSpec,
  ): void {
    if (!isGoalGraph(spec)) return;
    const node = spec.nodes.find((candidate) => candidate.id === nodeId);
    if (node?.work === undefined) return;
    if (checkpoint.progress !== null) {
      throw new BurnGraphError(
        "DERIVED_PROGRESS_READ_ONLY",
        "GraphSpec v3 progress is derived from reviewed evidence",
      );
    }
    if (!meaningfulRecord(checkpoint.record)) {
      throw new BurnGraphError(
        "WORK_RECORD_REQUIRED",
        `Work ${nodeId} requires facts, decisions, blockers, artifacts, or next`,
      );
    }
  }

  validateCompletion(
    runId: string,
    nodeId: string,
    actorId: string,
    completion: CompletionInput,
    spec: GraphSpec,
  ): void {
    if (!isGoalGraph(spec)) return;
    const node = spec.nodes.find((candidate) => candidate.id === nodeId);
    if (!node?.work) {
      throw new BurnGraphError(
        "INVALID_GRAPH",
        `GraphSpec v3 Work ${nodeId} is missing its contract`,
      );
    }
    if (!meaningfulRecord(completion.record)) {
      throw new BurnGraphError(
        "WORK_RECORD_REQUIRED",
        `Work ${nodeId} requires a structured execution record`,
      );
    }
    const effective = this.effectiveGoal(runId, spec);
    const evidenceIds = new Set(
      effective.contract.successEvidence.map((entry) => entry.id),
    );

    if (node.work.kind === "execute") {
      if (completion.verdict !== undefined) {
        throw new BurnGraphError(
          "VERDICT_NOT_ALLOWED",
          `Execution Work ${nodeId} cannot submit a Review verdict`,
        );
      }
      const claimIds = completion.evidenceClaims.map((claim) => claim.evidenceId);
      if (new Set(claimIds).size !== claimIds.length) {
        throw new BurnGraphError(
          "INVALID_EVIDENCE_CLAIM",
          `Work ${nodeId} repeats a Goal evidence claim`,
        );
      }
      const unknown = claimIds.filter((id) => !evidenceIds.has(id));
      if (unknown.length > 0) {
        throw new BurnGraphError(
          "INVALID_EVIDENCE_CLAIM",
          `Work ${nodeId} claims unknown Goal evidence`,
          false,
          { evidenceIds: unknown },
        );
      }
      const notOwned = claimIds.filter(
        (id) => effective.ownership.get(id) !== nodeId,
      );
      if (notOwned.length > 0) {
        throw new BurnGraphError(
          "INVALID_EVIDENCE_CLAIM",
          `Work ${nodeId} claims Goal evidence owned by another Work`,
          false,
          { evidenceIds: notOwned },
        );
      }
      const assigned = [...effective.ownership.entries()]
        .filter(([, ownerWorkId]) => ownerWorkId === nodeId)
        .map(([evidenceId]) => evidenceId);
      const missing = assigned.filter((id) => !claimIds.includes(id));
      if (missing.length > 0) {
        throw new BurnGraphError(
          "EVIDENCE_CLAIM_REQUIRED",
          `Work ${nodeId} must claim its assigned Goal evidence`,
          false,
          { evidenceIds: missing },
        );
      }
      const artifactless = completion.evidenceClaims
        .filter((claim) => claim.artifacts.length === 0)
        .map((claim) => claim.evidenceId);
      if (artifactless.length > 0) {
        throw new BurnGraphError(
          "EVIDENCE_ARTIFACT_REQUIRED",
          "Every Goal evidence claim requires an external artifact reference",
          false,
          { evidenceIds: artifactless },
        );
      }
      return;
    }

    if (completion.evidenceClaims.length > 0) {
      throw new BurnGraphError(
        "EVIDENCE_CLAIM_NOT_ALLOWED",
        `Review Work ${nodeId} judges claims instead of creating them`,
      );
    }
    const verdict = completion.verdict;
    if (!verdict) {
      throw new BurnGraphError(
        "VERDICT_REQUIRED",
        `Review Work ${nodeId} requires a Verdict`,
      );
    }
    if (completion.route !== verdict.decision) {
      throw new BurnGraphError(
        "VERDICT_ROUTE_MISMATCH",
        `Review route ${completion.route ?? ""} must equal verdict ${verdict.decision}`,
      );
    }
    this.assertReviewClaimAllowed(runId, nodeId, actorId, spec);
    const verdictIds = verdict.evidence;
    if (new Set(verdictIds).size !== verdictIds.length) {
      throw new BurnGraphError(
        "INVALID_VERDICT",
        `Review Work ${nodeId} repeats evidence in its Verdict`,
      );
    }
    const unknownVerdict = verdictIds.filter((id) => !evidenceIds.has(id));
    const unknownFindings = verdict.findings
      .map((finding) => finding.evidenceId)
      .filter((id): id is string => id !== null && !evidenceIds.has(id));
    if (unknownVerdict.length > 0 || unknownFindings.length > 0) {
      throw new BurnGraphError(
        "INVALID_VERDICT",
        `Review Work ${nodeId} references unknown Goal evidence`,
        false,
        { evidenceIds: [...new Set([...unknownVerdict, ...unknownFindings])] },
      );
    }
    if (verdict.decision === "revise") {
      if (!verdict.findings.some((finding) => finding.severity === "blocking")) {
        throw new BurnGraphError(
          "REVIEW_FINDING_REQUIRED",
          "A revise Verdict requires at least one blocking finding",
        );
      }
      return;
    }
    const isFinalReview = nodeId === finalReviewId(spec);
    if (isFinalReview && effective.pending) {
      throw new BurnGraphError(
        "GOAL_AMENDMENT_PENDING",
        "A Goal cannot pass while an evidence amendment awaits Review",
        true,
      );
    }
    if (verdict.findings.some((finding) => finding.severity === "blocking")) {
      throw new BurnGraphError(
        "INVALID_VERDICT",
        "A pass Verdict cannot retain blocking findings",
      );
    }
    const expectedVerdict = isFinalReview
      ? [...evidenceIds]
      : node.work.evidence.filter((evidenceId) => evidenceIds.has(evidenceId));
    const unsupportedVerdict = verdictIds.filter(
      (evidenceId) => !expectedVerdict.includes(evidenceId),
    );
    if (unsupportedVerdict.length > 0) {
      throw new BurnGraphError(
        "INVALID_VERDICT",
        `Review Work ${nodeId} judges evidence outside its contract`,
        false,
        { evidenceIds: unsupportedVerdict },
      );
    }
    const missingVerdict = expectedVerdict.filter(
      (id) => !verdictIds.includes(id),
    );
    if (missingVerdict.length > 0) {
      throw new BurnGraphError(
        "GOAL_EVIDENCE_UNVERIFIED",
        "A pass Verdict must cover every effective Goal evidence requirement",
        false,
        { evidenceIds: missingVerdict },
      );
    }
    const current = new Map(
      this.currentWork(runId, spec).map((entry) => [entry.nodeId, entry]),
    );
    const missingClaims = expectedVerdict.filter((evidenceId) =>
      !node.work!.reviewOf.some((reviewedId) =>
        current.get(reviewedId)?.result?.evidenceClaims.some(
          (claim) => claim.evidenceId === evidenceId,
        )
      )
    );
    if (missingClaims.length > 0) {
      throw new BurnGraphError(
        "GOAL_EVIDENCE_UNCLAIMED",
        "A pass Verdict requires current claims from the declared Work",
        false,
        { evidenceIds: missingClaims },
      );
    }
  }

  proposeAmendment(
    reference: string,
    actorIdInput: string,
    idempotencyKeyInput: string,
    input: unknown,
  ): IdempotentMutationResult<GoalSnapshot> {
    const actorId = IdentifierSchema.parse(actorIdInput);
    const idempotencyKey = IdempotencyKeySchema.parse(idempotencyKeyInput);
    const proposal = GoalAmendmentProposalInputSchema.parse(input);
    const runId = this.options.resolveRun(reference);
    const at = this.options.timestamp();
    const result = this.options.database.immediate(() => {
      const existing = this.options.database.db
        .query("SELECT * FROM goal_amendments WHERE idempotency_key = ?")
        .get(idempotencyKey) as Row | null;
      if (existing) {
        if (
          stringValue(existing, "run_id") !== runId ||
          stringValue(existing, "proposer_actor_id") !== actorId ||
          stringValue(existing, "reason") !== proposal.reason ||
          stableJson(parsePersisted(
            stringValue(existing, "changes_json"),
            z.array(GoalAmendmentChangeSchema),
            "Goal amendment",
          )) !==
            stableJson(proposal.changes)
        ) {
          throw new BurnGraphError(
            "IDEMPOTENCY_CONFLICT",
            `Goal amendment key ${idempotencyKey} was used with different input`,
          );
        }
        return {
          sequence: numberValue(existing, "proposal_event_sequence"),
          replayed: true,
        };
      }
      const spec = this.assertMutableGoalRun(runId);
      const count = this.options.database.db
        .query("SELECT COUNT(*) AS count FROM goal_amendments WHERE run_id = ?")
        .get(runId) as Row;
      if (numberValue(count, "count") >= MAX_GOAL_AMENDMENTS) {
        throw new BurnGraphError(
          "GOAL_AMENDMENT_LIMIT",
          `Run ${runId} reached its ${MAX_GOAL_AMENDMENTS} amendment limit`,
        );
      }
      this.assertAmendmentHistoryCapacity(
        runId,
        Buffer.byteLength(json(proposal)),
      );
      const effective = this.effectiveGoal(runId, spec);
      applyEvidenceChanges(
        effective.contract.successEvidence,
        proposal.changes,
        false,
      );
      applyOwnershipChanges(
        effective.ownership,
        proposal.changes,
        spec,
        false,
      );
      const amendmentId = `amendment:${crypto.randomUUID()}`;
      const revision = this.options.bumpRun(runId, at);
      const run = this.runRow(runId);
      const sequence = this.options.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId: null,
        type: "goal.amendment.proposed",
        summary: proposal.reason,
        payload: {
          amendmentId,
          proposerActorId: actorId,
          changes: proposal.changes,
          revision,
        },
        at,
      });
      this.options.database.db
        .query(
          `INSERT INTO goal_amendments (
             amendment_id, idempotency_key, review_idempotency_key, run_id,
             proposer_actor_id, reason, changes_json, status,
             reviewer_actor_id, review_json, proposal_event_sequence,
             review_event_sequence, created_at, updated_at
           ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, ?, ?)`,
        )
        .run(
          amendmentId,
          idempotencyKey,
          runId,
          actorId,
          proposal.reason,
          json(proposal.changes),
          sequence,
          at,
          at,
        );
      return { sequence, replayed: false };
    });
    const event = this.options.getEvent(result.sequence);
    return {
      revision: Number(event.payload["revision"]),
      event,
      value: this.requireSnapshot(runId),
      replayed: result.replayed,
    };
  }

  reviewAmendment(
    amendmentId: string,
    actorIdInput: string,
    idempotencyKeyInput: string,
    input: unknown,
  ): IdempotentMutationResult<GoalSnapshot> {
    IdentifierSchema.parse(amendmentId);
    const actorId = IdentifierSchema.parse(actorIdInput);
    const idempotencyKey = IdempotencyKeySchema.parse(idempotencyKeyInput);
    const review = GoalAmendmentReviewInputSchema.parse(input);
    const at = this.options.timestamp();
    const result = this.options.database.immediate(() => {
      const reused = this.options.database.db
        .query(
          `SELECT amendment_id
             FROM goal_amendments
            WHERE review_idempotency_key = ?`,
        )
        .get(idempotencyKey) as Row | null;
      if (reused && stringValue(reused, "amendment_id") !== amendmentId) {
        throw new BurnGraphError(
          "IDEMPOTENCY_CONFLICT",
          `Goal amendment review key ${idempotencyKey} was already used`,
        );
      }
      const row = this.amendmentRow(amendmentId);
      const runId = stringValue(row, "run_id");
      const status = stringValue(row, "status");
      if (status !== "pending") {
        const storedReviewValue = optionalString(row, "review_json");
        if (storedReviewValue === null) {
          throw new BurnGraphError(
            "CORRUPT_STATE",
            "Reviewed Goal amendment is missing its persisted Review",
          );
        }
        const storedReview = parsePersisted(
          storedReviewValue,
          GoalAmendmentReviewInputSchema,
          "Goal amendment Review",
        );
        if (
          optionalString(row, "review_idempotency_key") === idempotencyKey &&
          optionalString(row, "reviewer_actor_id") === actorId &&
          stableJson(storedReview) === stableJson(review)
        ) {
          return {
            runId,
            sequence: numberValue(row, "review_event_sequence"),
            replayed: true,
          };
        }
        throw new BurnGraphError(
          "GOAL_AMENDMENT_ALREADY_REVIEWED",
          `Goal amendment ${amendmentId} is ${status}`,
        );
      }
      if (stringValue(row, "proposer_actor_id") === actorId) {
        throw new BurnGraphError(
          "REVIEW_INDEPENDENCE_REQUIRED",
          "A Goal amendment must be reviewed by a different Actor",
        );
      }
      const spec = this.assertMutableGoalRun(runId);
      const changes = parsePersisted(
        stringValue(row, "changes_json"),
        z.array(GoalAmendmentChangeSchema),
        "Goal amendment",
      );
      if (
        review.verdict === "accept" &&
        changes.some((change) => change.op !== "add") &&
        !review.userApproved
      ) {
        throw new BurnGraphError(
          "USER_APPROVAL_REQUIRED",
          "Updating or removing agreed Goal evidence requires explicit user approval",
        );
      }
      if (review.verdict === "accept") {
        const effective = this.effectiveGoal(runId, spec);
        applyEvidenceChanges(
          effective.contract.successEvidence,
          changes,
          false,
        );
        applyOwnershipChanges(effective.ownership, changes, spec, false);
      }
      this.assertAmendmentHistoryCapacity(
        runId,
        Buffer.byteLength(json(review)),
      );
      const nextStatus = review.verdict === "accept" ? "applied" : "rejected";
      const revision = this.options.bumpRun(runId, at);
      const run = this.runRow(runId);
      const sequence = this.options.appendEvent({
        runId,
        graphId: stringValue(run, "graph_id"),
        nodeId: null,
        type: `goal.amendment.${nextStatus}`,
        summary: review.summary,
        payload: {
          amendmentId,
          reviewerActorId: actorId,
          verdict: review.verdict,
          userApproved: review.userApproved,
          revision,
        },
        at,
      });
      this.options.database.db
        .query(
          `UPDATE goal_amendments
              SET review_idempotency_key = ?, status = ?,
                  reviewer_actor_id = ?, review_json = ?,
                  review_event_sequence = ?, updated_at = ?
            WHERE amendment_id = ? AND status = 'pending'`,
        )
        .run(
          idempotencyKey,
          nextStatus,
          actorId,
          json(review),
          sequence,
          at,
          amendmentId,
        );
      return { runId, sequence, replayed: false };
    });
    const event = this.options.getEvent(result.sequence);
    return {
      revision: Number(event.payload["revision"]),
      event,
      value: this.requireSnapshot(result.runId),
      replayed: result.replayed,
    };
  }

  private assertMutableGoalRun(runId: string): Extract<
    GraphSpec,
    { schemaVersion: 3 }
  > {
    const run = this.runRow(runId);
    const status = stringValue(run, "status");
    if (!["running", "pausing", "paused"].includes(status)) {
      throw new BurnGraphError(
        "GOAL_NOT_ACTIVE",
        `Goal ${runId} cannot be amended while its Run is ${status}`,
      );
    }
    const spec = this.options.graphForRun(runId).spec;
    if (!isGoalGraph(spec)) {
      throw new BurnGraphError(
        "GOAL_NOT_AVAILABLE",
        "Goal amendments require GraphSpec v3",
      );
    }
    return spec;
  }

  private runRow(runId: string): Row {
    const row = this.options.database.db
      .query("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as Row | null;
    if (!row) throw new BurnGraphError("RUN_NOT_FOUND", `Unknown run ${runId}`);
    return row;
  }

  private amendmentRow(amendmentId: string): Row {
    const row = this.options.database.db
      .query("SELECT * FROM goal_amendments WHERE amendment_id = ?")
      .get(amendmentId) as Row | null;
    if (!row) {
      throw new BurnGraphError(
        "GOAL_AMENDMENT_NOT_FOUND",
        `Unknown Goal amendment ${amendmentId}`,
      );
    }
    return row;
  }

  private assertAmendmentHistoryCapacity(
    runId: string,
    additionalBytes: number,
  ): void {
    const row = this.options.database.db
      .query(
        `SELECT COALESCE(SUM(
           length(CAST(reason AS BLOB)) + length(CAST(changes_json AS BLOB)) +
           COALESCE(length(CAST(review_json AS BLOB)), 0)
         ), 0) AS bytes
           FROM goal_amendments
          WHERE run_id = ?`,
      )
      .get(runId) as Row;
    const existingBytes = numberValue(row, "bytes");
    if (existingBytes + additionalBytes > MAX_GOAL_AMENDMENT_HISTORY_BYTES) {
      throw new BurnGraphError(
        "GOAL_AMENDMENT_HISTORY_LIMIT",
        `Run ${runId} reached its bounded Goal amendment history`,
        false,
        {
          currentBytes: existingBytes,
          requestedBytes: additionalBytes,
          maximumBytes: MAX_GOAL_AMENDMENT_HISTORY_BYTES,
        },
      );
    }
  }

  private requireSnapshot(runId: string): GoalSnapshot {
    const snapshot = this.snapshot(runId);
    if (!snapshot) {
      throw new BurnGraphError(
        "GOAL_NOT_AVAILABLE",
        `Run ${runId} does not use GraphSpec v3`,
      );
    }
    return snapshot;
  }

  private effectiveGoal(
    runId: string,
    spec: Extract<GraphSpec, { schemaVersion: 3 }>,
  ): EffectiveGoalState {
    const amendments = this.amendments(runId);
    let evidence = spec.goal.successEvidence.map((entry) => ({ ...entry }));
    let ownership = baselineOwnership(spec);
    for (const amendment of amendments) {
      if (amendment.status !== "applied") continue;
      evidence = applyEvidenceChanges(evidence, amendment.changes, true);
      ownership = applyOwnershipChanges(
        ownership,
        amendment.changes,
        spec,
        true,
      );
    }
    return {
      contract: { ...spec.goal, successEvidence: evidence },
      ownership,
      amendments,
      pending: amendments.some((amendment) => amendment.status === "pending"),
    };
  }

  private amendments(runId: string): readonly GoalAmendmentSummary[] {
    const rows = this.options.database.db
      .query(
        `SELECT *
           FROM goal_amendments
          WHERE run_id = ?
          ORDER BY created_at, amendment_id`,
      )
      .all(runId) as Row[];
    return rows.map((row) => {
      const status = stringValue(row, "status");
      if (!["pending", "applied", "rejected"].includes(status)) {
        throw new BurnGraphError(
          "CORRUPT_STATE",
          `Goal amendment has invalid status ${status}`,
        );
      }
      const changes = parsePersisted(
        stringValue(row, "changes_json"),
        z.array(GoalAmendmentChangeSchema),
        "Goal amendment",
      );
      const reviewValue = optionalString(row, "review_json");
      const review = reviewValue === null
        ? null
        : parsePersisted(
          reviewValue,
          GoalAmendmentReviewInputSchema,
          "Goal amendment Review",
        );
      return {
        amendmentId: stringValue(row, "amendment_id"),
        status: status as GoalAmendmentSummary["status"],
        proposerActorId: stringValue(row, "proposer_actor_id"),
        reviewerActorId: optionalString(row, "reviewer_actor_id"),
        reason: stringValue(row, "reason"),
        changes,
        review,
        createdAt: stringValue(row, "created_at"),
        updatedAt: stringValue(row, "updated_at"),
      };
    });
  }

  private currentWork(
    runId: string,
    spec: Extract<GraphSpec, { schemaVersion: 3 }>,
  ): readonly CurrentWorkState[] {
    const workIds = spec.nodes
      .filter((node) => node.work !== undefined)
      .map((node) => node.id);
    if (workIds.length === 0) return [];
    const placeholders = workIds.map(() => "?").join(", ");
    const rows = this.options.database.db
      .query(
        `SELECT n.node_id, n.status, n.attempt, n.result_json, n.updated_at,
                a.actor_id AS completion_actor_id
           FROM node_runs n
           LEFT JOIN attempts a
             ON a.run_id = n.run_id
            AND a.node_id = n.node_id
            AND a.attempt = n.attempt
          WHERE n.run_id = ? AND n.node_id IN (${placeholders})`,
      )
      .all(runId, ...workIds) as Row[];
    return rows.map((row) => ({
      nodeId: stringValue(row, "node_id"),
      status: stringValue(row, "status"),
      attempt: numberValue(row, "attempt"),
      actorId: optionalString(row, "completion_actor_id"),
      result: parseCompletion(
        optionalString(row, "result_json"),
        `${runId}/${stringValue(row, "node_id")}`,
      ),
      updatedAt: stringValue(row, "updated_at"),
    }));
  }

  private latestReview(
    runId: string,
    spec: Extract<GraphSpec, { schemaVersion: 3 }>,
  ): ReviewState | null {
    const reviewIds = [finalReviewId(spec)];
    if (reviewIds.length === 0) return null;
    const placeholders = reviewIds.map(() => "?").join(", ");
    const rows = this.options.database.db
      .query(
        `SELECT node_id, actor_id, result_json,
                COALESCE(finished_at, started_at) AS review_at
           FROM attempts
          WHERE run_id = ? AND node_id IN (${placeholders})
            AND result_json IS NOT NULL
          ORDER BY COALESCE(finished_at, started_at) DESC, attempt DESC`,
      )
      .all(runId, ...reviewIds) as Row[];
    for (const row of rows) {
      const result = parseCompletion(
        optionalString(row, "result_json"),
        `${runId}/${stringValue(row, "node_id")} review`,
      );
      if (!result?.verdict) continue;
      return {
        nodeId: stringValue(row, "node_id"),
        actorId: optionalString(row, "actor_id"),
        result,
        updatedAt: stringValue(row, "review_at"),
      };
    }
    return null;
  }

  private isValidCurrentPass(
    spec: Extract<GraphSpec, { schemaVersion: 3 }>,
    review: ReviewState,
    evidenceIds: ReadonlySet<string>,
    claims: readonly EvidenceClaimState[],
    pendingAmendment: boolean,
  ): boolean {
    const verdict: ReviewVerdict | undefined = review.result.verdict;
    if (
      pendingAmendment ||
      !verdict ||
      verdict.decision !== "pass" ||
      review.result.route !== "pass" ||
      verdict.findings.some((finding) => finding.severity === "blocking")
    ) {
      return false;
    }
    const node = spec.nodes.find((candidate) => candidate.id === review.nodeId);
    if (
      node?.work?.kind !== "review" ||
      node.id !== finalReviewId(spec) ||
      review.actorId === null
    ) return false;
    const verdictIds = new Set(verdict.evidence);
    if (
      verdictIds.size !== evidenceIds.size ||
      [...evidenceIds].some((id) => !verdictIds.has(id))
    ) {
      return false;
    }
    const reviewed = new Set(node.work.reviewOf);
    return [...evidenceIds].every((evidenceId) =>
      claims.some(
        (claim) =>
          claim.evidenceId === evidenceId &&
          reviewed.has(claim.nodeId) &&
          claim.actorId !== review.actorId,
      )
    );
  }
}
