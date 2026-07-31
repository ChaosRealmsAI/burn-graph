import { describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  BurnGraphService,
  graphFile,
  validateGraphSpec,
} from "@burn-graph/core";
import {
  generateTemplate,
  listTemplates,
  showTemplate,
} from "@burn-graph/templates";

import {
  createTestProject,
  removeTestProject,
} from "../helpers/fixtures.ts";

const TEMPLATE_IDS = [
  "delivery",
  "vertical-slice",
  "poc",
  "bugfix",
  "review-repair",
  "release",
] as const;

function input(graphId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    graphId,
    goal: `Complete ${graphId} with external evidence.`,
    include: [],
    context: {
      mustRead: ["README.md"],
      lockedContracts: ["docs/graph-spec.md"],
      writablePaths: ["packages/example"],
      forbidden: ["Do not change unrelated files."],
      runtime: ["bun run check"],
    },
    promptOverrides: [],
  };
}

describe("package template catalog", () => {
  test("owns six stable descriptors and generates valid GraphSpec v2", () => {
    expect(listTemplates().map((template) => template.id)).toEqual([
      ...TEMPLATE_IDS,
    ]);
    for (const templateId of TEMPLATE_IDS) {
      const shown = showTemplate(templateId);
      expect(shown.template.id).toBe(templateId);
      expect(shown.input).toMatchObject({ schemaVersion: 1 });
      const generation = generateTemplate(
        templateId,
        input(`generated-${templateId}`),
        `instantiate-${templateId}`,
      );
      expect(generation.template).toEqual({ id: templateId, version: 1 });
      expect(generation.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(generation.graphs).toHaveLength(1);
      expect(validateGraphSpec(generation.graphs[0]!).spec).toEqual(
        generation.graphs[0]!,
      );
    }
  });

  test("materializes every supported include stage in caller order", () => {
    for (const template of listTemplates()) {
      const graphId = `included-${template.id}`;
      const idempotencyKey = `included-${template.id}-key`;
      const baseline = generateTemplate(
        template.id,
        input(graphId),
        idempotencyKey,
      );
      const include = [...template.supports].reverse();
      const included = generateTemplate(
        template.id,
        { ...input(graphId), include },
        idempotencyKey,
      );
      const riskNodes = included.graphs[0]!.nodes.filter((node) =>
        node.id.startsWith("risk-")
      );
      expect(riskNodes.map((node) => node.id)).toEqual(
        include.map((stage) => `risk-${stage}`),
      );
      expect(riskNodes.map((node) => node.tags)).toEqual(
        include.map((stage) => ["risk", stage]),
      );
      if (include.length > 0) {
        expect(included.inputDigest).not.toBe(baseline.inputDigest);
        expect(included.graphs[0]).not.toEqual(baseline.graphs[0]);
      } else {
        expect(included.inputDigest).toBe(baseline.inputDigest);
        expect(included.graphs[0]).toEqual(baseline.graphs[0]);
      }
    }
  });

  test("bounds prompt overrides and separates read from write paths", () => {
    try {
      generateTemplate(
        "poc",
        {
          ...input("unsupported-stage"),
          include: ["security"],
        },
        "unsupported-stage",
      );
      throw new Error("Expected TEMPLATE_STAGE_NOT_SUPPORTED");
    } catch (error) {
      expect(error).toBeInstanceOf(BurnGraphError);
      expect((error as BurnGraphError).code).toBe(
        "TEMPLATE_STAGE_NOT_SUPPORTED",
      );
    }
    expect(() =>
      generateTemplate(
        "bugfix",
        {
          ...input("bad-override"),
          promptOverrides: [
            { nodeId: "not-in-template", objective: "Escape contract." },
          ],
        },
        "bad-override",
      ),
    ).toThrow(BurnGraphError);
    const siblingContracts = generateTemplate(
      "bugfix",
      {
        ...input("sibling-contracts"),
        context: {
          ...(input("sibling-contracts").context as Record<string, unknown>),
          mustRead: ["../privacy/product.md"],
          lockedContracts: ["../privacy/architecture.md"],
        },
      },
      "sibling-contracts",
    );
    expect(siblingContracts.graphs[0]!.nodes[1]!.prompt).toMatchObject({
      mustRead: ["../privacy/product.md"],
      lockedContracts: ["../privacy/architecture.md"],
    });
    for (const context of [
      {
        ...(input("bad-write-path").context as Record<string, unknown>),
        writablePaths: ["../privacy"],
      },
      {
        ...(input("bad-deep-read").context as Record<string, unknown>),
        mustRead: ["../../secrets.txt"],
      },
      {
        ...(input("bad-absolute-read").context as Record<string, unknown>),
        mustRead: ["/tmp/private.txt"],
      },
      {
        ...(input("bad-uri-read").context as Record<string, unknown>),
        mustRead: ["https://example.test/contract"],
      },
      {
        ...(input("bad-empty-sibling").context as Record<string, unknown>),
        mustRead: ["../"],
      },
      {
        ...(input("bad-control-read").context as Record<string, unknown>),
        mustRead: ["docs/\nsecret.md"],
      },
    ]) {
      expect(() =>
        generateTemplate(
          "bugfix",
          {
            ...input("bad-path"),
            context,
          },
          "bad-path",
        ),
      ).toThrow();
    }
    expect(() => showTemplate("unknown")).toThrow(BurnGraphError);
  });

  test("instantiates normalized JSON and immutable revision idempotently", () => {
    const root = createTestProject();
    let service = new BurnGraphService(root);
    try {
      const generation = generateTemplate(
        "vertical-slice",
        input("local-slice"),
        "local-slice-key",
      );
      const first = service.instantiateTemplate(generation);
      expect(first).toMatchObject({
        schemaVersion: 1,
        template: { id: "vertical-slice", version: 1 },
        idempotencyKey: "local-slice-key",
        replayed: false,
        graphs: [
          {
            graphId: "local-slice",
            revision: 1,
            path: ".burn/graph/graphs/local-slice.json",
          },
        ],
      });
      expect(existsSync(graphFile(root, "local-slice"))).toBe(true);
      expect(service.getGraph("local-slice")).toEqual(generation.graphs[0]!);
      const eventCount = service.database.db
        .query("SELECT COUNT(*) AS count FROM events")
        .get() as { count: number };

      service.close();
      service = new BurnGraphService(root);
      const replay = service.instantiateTemplate(generation);
      expect(replay).toEqual({ ...first, replayed: true });
      expect(
        (
          service.database.db
            .query("SELECT COUNT(*) AS count FROM graph_specs")
            .get() as { count: number }
        ).count,
      ).toBe(1);
      expect(
        (
          service.database.db
            .query("SELECT COUNT(*) AS count FROM events")
            .get() as { count: number }
        ).count,
      ).toBe(eventCount.count);

      expect(() =>
        service.instantiateTemplate(
          generateTemplate(
            "bugfix",
            input("another-graph"),
            "local-slice-key",
          ),
        ),
      ).toThrow(BurnGraphError);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("preflight and seeded commit failure leave no partial project state", () => {
    const root = createTestProject();
    let service = new BurnGraphService(root);
    try {
      const missingCheck = generateTemplate(
        "release",
        {
          ...input("missing-check-release"),
          check: { id: "missing-check", revision: 1 },
        },
        "missing-check-key",
      );
      expect(() => service.instantiateTemplate(missingCheck)).toThrow(
        BurnGraphError,
      );
      expect(
        (
          service.database.db
            .query("SELECT COUNT(*) AS count FROM graph_specs")
            .get() as { count: number }
        ).count,
      ).toBe(0);
      expect(existsSync(graphFile(root, "missing-check-release"))).toBe(false);

      service.database.db.exec(`
        CREATE TRIGGER seeded_template_receipt_failure
        BEFORE INSERT ON template_instantiations
        BEGIN
          SELECT RAISE(ABORT, 'seeded template receipt failure');
        END;
      `);
      const candidate = generateTemplate(
        "poc",
        input("atomic-poc"),
        "atomic-poc-key",
      );
      expect(() => service.instantiateTemplate(candidate)).toThrow(
        "seeded template receipt failure",
      );
      expect(existsSync(graphFile(root, "atomic-poc"))).toBe(false);
      expect(
        (
          service.database.db
            .query("SELECT COUNT(*) AS count FROM graph_specs")
            .get() as { count: number }
        ).count,
      ).toBe(0);
      const journals = path.join(
        root,
        ".burn", "graph",
        "runtime",
        "template-transactions",
      );
      expect(
        existsSync(journals)
          ? readdirSync(journals)
          : [],
      ).toEqual([]);

      service.close();
      service = new BurnGraphService(root);
      expect(service.listGraphs()).toEqual([]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("rejects a symlinked template transaction root before outside writes", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    const outside = path.join(root, "outside-template-runtime");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "sentinel.txt"), "unchanged\n");
    const transactions = path.join(
      root,
      ".burn", "graph",
      "runtime",
      "template-transactions",
    );
    try {
      symlinkSync(outside, transactions);
      let thrown: unknown;
      try {
        service.instantiateTemplate(
          generateTemplate(
            "poc",
            input("template-runtime-boundary"),
            "template-runtime-boundary-key",
          ),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BurnGraphError);
      expect((thrown as BurnGraphError).code).toBe("UNSAFE_STATE_ROOT");
      expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
      expect(readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe(
        "unchanged\n",
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("recovers seeded hard-crash journals before and after receipt commit", () => {
    const root = createTestProject();
    let service = new BurnGraphService(root);
    const transactions = path.join(
      root,
      ".burn", "graph",
      "runtime",
      "template-transactions",
    );
    const seedJournal = (
      transactionId: string,
      idempotencyKey: string,
      staged: string,
      target: string,
      legacy = false,
    ): string => {
      mkdirSync(transactions, { recursive: true });
      const journal = path.join(
        transactions,
        legacy
          ? `${transactionId}.json`
          : `${transactionId}.journal.json`,
      );
      writeFileSync(
        journal,
        `${JSON.stringify({
          schemaVersion: 1,
          transactionId,
          idempotencyKey,
          files: [{ staged, target }],
        })}\n`,
      );
      return journal;
    };
    try {
      const orphanId = "11111111-1111-4111-8111-111111111111";
      const orphanStaged = path.join(
        transactions,
        `${orphanId}-orphan-template.json`,
      );
      const orphanTarget = graphFile(root, "orphan-template");
      mkdirSync(transactions, { recursive: true });
      writeFileSync(orphanStaged, "{}\n");
      writeFileSync(orphanTarget, "{}\n");
      const orphanJournal = seedJournal(
        orphanId,
        "orphan-template-key",
        orphanStaged,
        orphanTarget,
        true,
      );

      service.close();
      service = new BurnGraphService(root);
      expect(existsSync(orphanStaged)).toBe(false);
      expect(existsSync(orphanTarget)).toBe(false);
      expect(existsSync(orphanJournal)).toBe(false);

      const generation = generateTemplate(
        "bugfix",
        input("committed-template"),
        "committed-template-key",
      );
      service.instantiateTemplate(generation);
      const committedTarget = graphFile(root, "committed-template");
      const committedDocument = readFileSync(committedTarget, "utf8");
      service.close();

      const committedId = "22222222-2222-4222-8222-222222222222";
      const committedStaged = path.join(
        transactions,
        `${committedId}-committed-template.stage`,
      );
      writeFileSync(committedStaged, committedDocument);
      unlinkSync(committedTarget);
      const committedJournal = seedJournal(
        committedId,
        "committed-template-key",
        committedStaged,
        committedTarget,
      );

      service = new BurnGraphService(root);
      expect(readFileSync(committedTarget, "utf8")).toBe(committedDocument);
      expect(existsSync(committedStaged)).toBe(false);
      expect(existsSync(committedJournal)).toBe(false);
      expect(service.getGraph("committed-template")).toEqual(
        generation.graphs[0]!,
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("journal reads preserve a hardlinked outside peer", () => {
    const root = createTestProject();
    let service = new BurnGraphService(root);
    const transactions = path.join(
      root,
      ".burn",
      "graph",
      "runtime",
      "template-transactions",
    );
    const transactionId = "33333333-3333-4333-8333-333333333333";
    const journal = path.join(
      transactions,
      `${transactionId}.journal.json`,
    );
    const staged = path.join(transactions, `${transactionId}-staged.json`);
    const target = graphFile(root, "hardlinked-journal");
    const payload = `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      idempotencyKey: "hardlinked-journal-key",
      files: [{ staged, target }],
    })}\n`;
    const outsidePeer = path.join(root, "outside-journal-peer.json");
    try {
      mkdirSync(transactions, { recursive: true });
      writeFileSync(staged, "{}\n");
      writeFileSync(target, "{}\n");
      writeFileSync(outsidePeer, payload);
      linkSync(outsidePeer, journal);

      service.close();
      service = new BurnGraphService(root);

      expect(readFileSync(outsidePeer, "utf8")).toBe(payload);
      expect(existsSync(journal)).toBe(false);
      expect(existsSync(staged)).toBe(false);
      expect(existsSync(target)).toBe(false);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
