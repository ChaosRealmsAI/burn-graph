import { describe, expect, test } from "bun:test";

import {
  BurnGraphError,
  BurnGraphService,
  type CompletionInput,
} from "@burn-graph/core";

import {
  createTestProject,
  goalGraph,
  removeTestProject,
} from "../helpers/fixtures.ts";

function expectGraphError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe(code);
  }
}

function executionCompletion(): CompletionInput {
  return {
    summary: "Produced the current result.",
    evidence: [],
    record: {
      facts: ["The result is available."],
      decisions: [
        {
          summary: "Use the durable artifact.",
          reason: "It is externally inspectable.",
        },
      ],
      blockers: [],
      artifacts: ["artifact://result"],
      next: "Independent Review",
    },
    evidenceClaims: [
      {
        evidenceId: "E1",
        summary: "The result artifact demonstrates E1.",
        artifacts: ["artifact://result"],
      },
      {
        evidenceId: "E2",
        summary: "The observation demonstrates E2.",
        artifacts: ["artifact://observation"],
      },
    ],
  };
}

function reviewCompletion(decision: "pass" | "revise"): CompletionInput {
  return {
    summary:
      decision === "pass" ? "Evidence passed." : "Evidence needs repair.",
    evidence: [],
    record: {
      facts: ["The external artifacts were inspected."],
      decisions: [
        {
          summary:
            decision === "pass" ? "Accept the result." : "Request repair.",
          reason: "The Verdict follows the declared acceptance conditions.",
        },
      ],
      blockers:
        decision === "revise" ? ["The first observation is stale."] : [],
      artifacts: ["artifact://review"],
      next: decision === "pass" ? null : "Repeat execution Work",
    },
    evidenceClaims: [],
    verdict: {
      decision,
      summary:
        decision === "pass"
          ? "All evidence is current."
          : "Refresh the evidence.",
      evidence: decision === "pass" ? ["E1", "E2"] : ["E1"],
      findings:
        decision === "pass"
          ? []
          : [
              {
                severity: "blocking",
                summary: "E2 must be refreshed.",
                evidenceId: "E2",
              },
            ],
    },
    route: decision,
  };
}

describe("Goal–Graph–Work runtime", () => {
  test("reports corrupt persisted amendments with a stable product error", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(goalGraph("goal-corrupt-amendment"));
      service.startRun("goal-corrupt-amendment", "goal-corrupt-amendment:run");
      service.proposeGoalAmendment(
        "goal-corrupt-amendment:run",
        "planner",
        "corrupt-amendment",
        {
          reason: "Create one durable amendment row for the corruption Oracle.",
          changes: [
            {
              op: "update",
              evidenceId: "E1",
              acceptance: ["The durable result remains externally observable."],
            },
          ],
        },
      );
      service.database.db
        .query("UPDATE goal_amendments SET changes_json = ? WHERE run_id = ?")
        .run("{", "goal-corrupt-amendment:run");

      expectGraphError(
        () => service.getGoal("goal-corrupt-amendment:run"),
        "CORRUPT_STATE",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("keeps a persisted pre-rule repair Graph operable while rejecting new admission", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      const legacy = structuredClone(goalGraph("goal-legacy-repair"));
      if (legacy.schemaVersion !== 3) throw new Error("Expected GraphSpec v3");
      const review = legacy.nodes.find((node) => node.id === "review")!;
      review.work = {
        kind: "review",
        evidence: ["E1"],
        reviewOf: ["work", "repair"],
      };
      review.next = [
        { to: "end", route: "pass" },
        { to: "repair", route: "revise", maxTraversals: 2 },
      ];
      legacy.nodes.splice(2, 0, {
        id: "repair",
        type: "task",
        title: "Legacy dormant repair",
        prompt: legacy.nodes[1]!.prompt,
        work: { kind: "execute", evidence: [], reviewOf: [] },
        next: [{ to: "review" }],
        maxAttempts: 2,
        actorHint: null,
        tags: [],
      });

      expectGraphError(() => service.applyGraph(legacy), "INVALID_LOOP");
      service.database.db
        .query(
          `INSERT INTO graph_specs (
             graph_id, revision, document_json, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          legacy.id,
          legacy.revision,
          JSON.stringify(legacy),
          new Date().toISOString(),
        );

      expect(service.getGraph(legacy.id).id).toBe(legacy.id);
      expect(service.listGraphs().map((entry) => entry.id)).toContain(
        legacy.id,
      );
      expect(
        service.startRun(legacy.id, `${legacy.id}:run`).value.summary.status,
      ).toBe("running");
      expect(
        service.cancelRun(`${legacy.id}:run`, "cancel-legacy-repair").value
          .summary.status,
      ).toBe("cancelled");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("derives progress only from independent current Review across repair", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(goalGraph());
      service.startRun("goal-work", "goal-work:run");

      expectGraphError(
        () =>
          service.proposeGoalAmendment(
            "goal-work:run",
            "planner",
            "bad-owner-e2",
            {
              reason: "A new requirement still needs a real Work owner.",
              changes: [
                {
                  op: "add",
                  ownerWorkId: "missing-work",
                  evidence: {
                    id: "E2",
                    description:
                      "The result is observable from the public surface.",
                    acceptance: ["A public observation artifact exists."],
                    oracle: "A different Actor checks the observation.",
                  },
                },
              ],
            },
          ),
        "INVALID_GOAL_AMENDMENT",
      );
      expect(service.getGoal("goal-work:run")?.amendments).toHaveLength(0);

      const proposal = service.proposeGoalAmendment(
        "goal-work:run",
        "planner",
        "add-e2",
        {
          reason: "New observation revealed one additional success condition.",
          changes: [
            {
              op: "add",
              ownerWorkId: "work",
              evidence: {
                id: "E2",
                description:
                  "The result is observable from the public surface.",
                acceptance: ["A public observation artifact exists."],
                oracle: "A different Actor checks the observation.",
              },
            },
          ],
        },
      );
      expect(proposal.value.status).toBe("amendment_pending");
      const amendmentId = proposal.value.amendments[0]!.amendmentId;
      expectGraphError(
        () =>
          service.reviewGoalAmendment(
            amendmentId,
            "planner",
            "self-review-e2",
            { verdict: "accept", summary: "Self approval is invalid." },
          ),
        "REVIEW_INDEPENDENCE_REQUIRED",
      );
      const accepted = service.reviewGoalAmendment(
        amendmentId,
        "contract-reviewer",
        "accept-e2",
        { verdict: "accept", summary: "E2 raises the agreed bar." },
      );
      expect(accepted.value.evidence.map((entry) => entry.id)).toEqual([
        "E1",
        "E2",
      ]);

      const assignment = service.claim(
        "goal-work:run",
        "work",
        "maker",
        60,
      ).value;
      expect(assignment.graph.goalState?.progress.evidence.required).toBe(2);
      service.complete("goal-work:run", "work", "maker", executionCompletion());
      let goal = service.getGoal("goal-work:run")!;
      expect(goal.progress).toMatchObject({
        percent: 0,
        evidence: { required: 2, claimed: 2, verified: 0 },
      });

      const before = service.getSnapshot("goal-work:run");
      const attemptsBefore = service.database.db
        .query("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?")
        .get("goal-work:run") as { count: number };
      expectGraphError(
        () => service.claim("goal-work:run", "review", "maker", 60),
        "REVIEW_INDEPENDENCE_REQUIRED",
      );
      const after = service.getSnapshot("goal-work:run");
      const attemptsAfter = service.database.db
        .query("SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?")
        .get("goal-work:run") as { count: number };
      expect(after.summary.runtimeRevision).toBe(
        before.summary.runtimeRevision,
      );
      expect(after.events).toHaveLength(before.events.length);
      expect(attemptsAfter.count).toBe(attemptsBefore.count);

      service.claim("goal-work:run", "review", "reviewer", 60);
      service.complete(
        "goal-work:run",
        "review",
        "reviewer",
        reviewCompletion("revise"),
      );
      goal = service.getGoal("goal-work:run")!;
      expect(goal.review.status).toBe("revise");
      expect(goal.progress.evidence).toEqual({
        required: 2,
        claimed: 0,
        verified: 0,
      });

      service.claim("goal-work:run", "work", "maker", 60);
      service.complete("goal-work:run", "work", "maker", executionCompletion());
      service.claim("goal-work:run", "review", "reviewer", 60);
      const completed = service.complete(
        "goal-work:run",
        "review",
        "reviewer",
        reviewCompletion("pass"),
      ).value;
      expect(completed.summary.status).toBe("completed");
      expect(completed.summary.goalState?.status).toBe("satisfied");
      expect(completed.summary.goalState?.progress).toMatchObject({
        percent: 100,
        evidence: { required: 2, claimed: 2, verified: 2 },
      });
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("requires explicit user approval before changing agreed evidence", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(goalGraph("goal-amend"));
      service.startRun("goal-amend", "goal-amend:run");
      const proposed = service.proposeGoalAmendment(
        "goal-amend:run",
        "planner",
        "tighten-e1",
        {
          reason:
            "The external Oracle needs a more precise acceptance condition.",
          changes: [
            {
              op: "update",
              evidenceId: "E1",
              acceptance: ["Two independent observations match the result."],
            },
          ],
        },
      );
      const amendmentId = proposed.value.amendments[0]!.amendmentId;
      const revision =
        service.getSnapshot("goal-amend:run").summary.runtimeRevision;
      expectGraphError(
        () =>
          service.reviewGoalAmendment(
            amendmentId,
            "reviewer",
            "review-tighten-without-user",
            { verdict: "accept", summary: "Looks reasonable." },
          ),
        "USER_APPROVAL_REQUIRED",
      );
      expect(
        service.getSnapshot("goal-amend:run").summary.runtimeRevision,
      ).toBe(revision);
      const applied = service.reviewGoalAmendment(
        amendmentId,
        "reviewer",
        "review-tighten-with-user",
        {
          verdict: "accept",
          summary:
            "The user explicitly approved the revised evidence contract.",
          userApproved: true,
        },
      );
      expect(applied.value.evidence[0]?.acceptance).toEqual([
        "Two independent observations match the result.",
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("blocks final pass while an evidence amendment is pending", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(goalGraph("goal-pending"));
      service.startRun("goal-pending", "goal-pending:run");
      service.claim("goal-pending:run", "work", "maker", 60);
      const completion = executionCompletion();
      service.complete("goal-pending:run", "work", "maker", {
        ...completion,
        evidenceClaims: completion.evidenceClaims.filter(
          (claim) => claim.evidenceId === "E1",
        ),
      });
      service.claim("goal-pending:run", "review", "reviewer", 60);
      service.proposeGoalAmendment(
        "goal-pending:run",
        "planner",
        "pending-e2",
        {
          reason:
            "A newly observed outcome may need to raise the evidence bar.",
          changes: [
            {
              op: "add",
              ownerWorkId: "work",
              evidence: {
                id: "E2",
                description: "A second observation may be required.",
                acceptance: ["The second observation exists."],
                oracle: "An independent Actor checks the observation.",
              },
            },
          ],
        },
      );
      const before = service.getSnapshot("goal-pending:run");
      const pass = reviewCompletion("pass");
      expectGraphError(
        () =>
          service.complete("goal-pending:run", "review", "reviewer", {
            ...pass,
            verdict: { ...pass.verdict!, evidence: ["E1"] },
          }),
        "GOAL_AMENDMENT_PENDING",
      );
      expect(
        service.getSnapshot("goal-pending:run").summary.runtimeRevision,
      ).toBe(before.summary.runtimeRevision);
      expect(service.getGoal("goal-pending:run")?.status).toBe(
        "amendment_pending",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("replays amendments idempotently and restores accepted ownership", () => {
    const root = createTestProject();
    let service = new BurnGraphService(root);
    try {
      service.applyGraph(goalGraph("goal-restart"));
      service.startRun("goal-restart", "goal-restart:run");
      const proposalInput = {
        reason: "A durable public observation is now part of success.",
        changes: [
          {
            op: "add" as const,
            ownerWorkId: "work",
            evidence: {
              id: "E2",
              description: "The public observation is durable.",
              acceptance: ["The observation artifact survives restart."],
              oracle: "A different Actor reads the artifact after restart.",
            },
          },
        ],
      };
      const proposed = service.proposeGoalAmendment(
        "goal-restart:run",
        "planner",
        "restart-add-e2",
        proposalInput,
      );
      const replayedProposal = service.proposeGoalAmendment(
        "goal-restart:run",
        "planner",
        "restart-add-e2",
        proposalInput,
      );
      expect(replayedProposal.replayed).toBe(true);
      expect(replayedProposal.event.sequence).toBe(proposed.event.sequence);
      const amendmentId = proposed.value.amendments[0]!.amendmentId;
      const reviewInput = {
        verdict: "accept" as const,
        summary: "The added evidence raises rather than weakens the contract.",
      };
      const reviewed = service.reviewGoalAmendment(
        amendmentId,
        "contract-reviewer",
        "restart-review-e2",
        reviewInput,
      );
      const replayedReview = service.reviewGoalAmendment(
        amendmentId,
        "contract-reviewer",
        "restart-review-e2",
        reviewInput,
      );
      expect(replayedReview.replayed).toBe(true);
      expect(replayedReview.event.sequence).toBe(reviewed.event.sequence);

      service.close();
      service = new BurnGraphService(root);
      const restored = service.getGoal("goal-restart:run")!;
      expect(
        restored.evidence.map((entry) => [entry.id, entry.ownerWorkId]),
      ).toEqual([
        ["E1", "work"],
        ["E2", "work"],
      ]);
      expect(restored.amendments).toHaveLength(1);
      expect(restored.amendments[0]?.status).toBe("applied");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("requires user approval before removing accepted evidence", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      service.applyGraph(goalGraph("goal-remove"));
      service.startRun("goal-remove", "goal-remove:run");
      const added = service.proposeGoalAmendment(
        "goal-remove:run",
        "planner",
        "remove-add-e2",
        {
          reason: "Temporarily add an independently observable requirement.",
          changes: [
            {
              op: "add",
              ownerWorkId: "work",
              evidence: {
                id: "E2",
                description: "A temporary external observation exists.",
                acceptance: ["The external observation can be inspected."],
                oracle: "A different Actor inspects it.",
              },
            },
          ],
        },
      );
      service.reviewGoalAmendment(
        added.value.amendments[0]!.amendmentId,
        "reviewer",
        "remove-accept-e2",
        { verdict: "accept", summary: "E2 raises the bar." },
      );
      const removal = service.proposeGoalAmendment(
        "goal-remove:run",
        "planner",
        "remove-e2",
        {
          reason: "The user changed the agreed result boundary.",
          changes: [{ op: "remove", evidenceId: "E2" }],
        },
      );
      const amendmentId = removal.value.amendments.at(-1)!.amendmentId;
      expectGraphError(
        () =>
          service.reviewGoalAmendment(
            amendmentId,
            "reviewer",
            "remove-e2-no-user",
            { verdict: "accept", summary: "No user approval was supplied." },
          ),
        "USER_APPROVAL_REQUIRED",
      );
      const applied = service.reviewGoalAmendment(
        amendmentId,
        "reviewer",
        "remove-e2-with-user",
        {
          verdict: "accept",
          summary: "The user explicitly approved removing E2.",
          userApproved: true,
        },
      );
      expect(applied.value.evidence.map((entry) => entry.id)).toEqual(["E1"]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
