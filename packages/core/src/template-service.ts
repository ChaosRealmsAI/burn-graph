import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  IdempotencyKeySchema,
  IdentifierSchema,
  type GraphSpec,
  type TemplateInstantiationReceipt,
  type TemplateInstantiationRequest,
} from "./contracts.ts";
import {
  assertProjectStateBoundary,
  assertProjectStatePath,
  STATE_DIRECTORY,
  atomicWriteJson,
  graphFile,
  readProjectFile,
} from "./project.ts";
import { json, numberValue, stringValue, type Row } from "./sql.ts";
import type { BurnGraphDatabase } from "./storage.ts";

interface TemplateTransactionJournal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly files: readonly {
    readonly staged: string;
    readonly target: string;
  }[];
}

interface TemplateRegistryOptions {
  readonly root: string;
  readonly database: BurnGraphDatabase;
  readonly timestamp: () => string;
  readonly validateGraph: (input: unknown) => GraphSpec;
  readonly validateReferences: (spec: GraphSpec) => void;
}

const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function journalDirectory(root: string): string {
  return path.join(
    root,
    STATE_DIRECTORY,
    "runtime",
    "template-transactions",
  );
}

function isJournalName(name: string): boolean {
  const transactionId = name.endsWith(".journal.json")
    ? name.slice(0, -".journal.json".length)
    : name.endsWith(".json")
      ? name.slice(0, -".json".length)
      : "";
  return TRANSACTION_ID_PATTERN.test(transactionId);
}

function safeUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

function confinedJournalPath(root: string, candidate: string): string {
  const runtimeRoot = path.resolve(journalDirectory(root));
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(`${runtimeRoot}${path.sep}`)) {
    throw new BurnGraphError(
      "CORRUPT_STATE",
      "Template transaction journal escapes runtime storage",
    );
  }
  return assertProjectStatePath(
    root,
    path.relative(path.resolve(root), resolved),
    "file",
    true,
  );
}

function parseJournal(root: string, file: string): TemplateTransactionJournal {
  assertProjectStatePath(
    root,
    path.relative(path.resolve(root), file),
    "file",
    false,
  );
  let parsed: unknown;
  try {
    const snapshot = readProjectFile(file, root);
    parsed = JSON.parse(Buffer.from(snapshot.bytes).toString("utf8"));
  } catch (error) {
    if (error instanceof BurnGraphError && error.code === "UNSAFE_STATE_ROOT") {
      throw error;
    }
    throw new BurnGraphError(
      "CORRUPT_STATE",
      `Template transaction journal ${path.basename(file)} is invalid`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (parsed as { transactionId?: unknown }).transactionId !== "string" ||
    typeof (parsed as { idempotencyKey?: unknown }).idempotencyKey !== "string" ||
    !Array.isArray((parsed as { files?: unknown }).files)
  ) {
    throw new BurnGraphError(
      "CORRUPT_STATE",
      `Template transaction journal ${path.basename(file)} has an invalid shape`,
    );
  }
  const journal = parsed as TemplateTransactionJournal;
  if (
    !TRANSACTION_ID_PATTERN.test(journal.transactionId) ||
    ![
      `${journal.transactionId}.json`,
      `${journal.transactionId}.journal.json`,
    ].includes(path.basename(file)) ||
    !IdempotencyKeySchema.safeParse(journal.idempotencyKey).success ||
    journal.files.length < 1 ||
    journal.files.length > 32
  ) {
    throw new BurnGraphError(
      "CORRUPT_STATE",
      `Template transaction journal ${path.basename(file)} has invalid ownership`,
    );
  }
  const stagedPaths = new Set<string>();
  const targetPaths = new Set<string>();
  const files: Array<{ readonly staged: string; readonly target: string }> = [];
  for (const item of journal.files) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.staged !== "string" ||
      typeof item.target !== "string"
    ) {
      throw new BurnGraphError(
        "CORRUPT_STATE",
        `Template transaction journal ${path.basename(file)} has an invalid file`,
      );
    }
    const staged = confinedJournalPath(root, item.staged);
    if (!path.basename(staged).startsWith(`${journal.transactionId}-`)) {
      throw new BurnGraphError(
        "CORRUPT_STATE",
        "Template staged output belongs to another transaction",
      );
    }
    const graphRoot = path.resolve(root, STATE_DIRECTORY, "graphs");
    const target = path.resolve(item.target);
    if (!target.startsWith(`${graphRoot}${path.sep}`)) {
      throw new BurnGraphError(
        "CORRUPT_STATE",
        "Template target escapes project graph storage",
      );
    }
    const confinedTarget = assertProjectStatePath(
      root,
      path.relative(path.resolve(root), target),
      "file",
      true,
    );
    if (stagedPaths.has(staged) || targetPaths.has(confinedTarget)) {
      throw new BurnGraphError(
        "CORRUPT_STATE",
        "Template transaction journal repeats an output path",
      );
    }
    stagedPaths.add(staged);
    targetPaths.add(confinedTarget);
    files.push({ staged, target: confinedTarget });
  }
  return { ...journal, files };
}

export function recoverTemplateTransactions(
  root: string,
  database: BurnGraphDatabase,
): void {
  assertProjectStateBoundary(root);
  const directory = journalDirectory(root);
  assertProjectStatePath(
    root,
    path.join(STATE_DIRECTORY, "runtime", "template-transactions"),
    "directory",
    true,
  );
  if (!existsSync(directory)) return;
  database.immediate(() => {
    const journals = readdirSync(directory)
      .filter(isJournalName)
      .sort();
    for (const name of journals) {
      const journalFile = path.join(directory, name);
      const journal = parseJournal(root, journalFile);
      const committed = database.db
        .query(
          `SELECT idempotency_key
             FROM template_instantiations
            WHERE idempotency_key = ?`,
        )
        .get(journal.idempotencyKey) as Row | null;
      if (committed) {
        for (const item of journal.files) {
          assertProjectStatePath(
            root,
            path.relative(path.resolve(root), item.target),
            "file",
            true,
          );
          assertProjectStatePath(
            root,
            path.relative(path.resolve(root), item.staged),
            "file",
            true,
          );
          if (!existsSync(item.target) && existsSync(item.staged)) {
            linkSync(item.staged, item.target);
          }
          if (!existsSync(item.target)) {
            throw new BurnGraphError(
              "TEMPLATE_STATE_INCOMPLETE",
              `Committed template output ${path.basename(item.target)} is missing`,
            );
          }
          safeUnlink(item.staged);
        }
      } else {
        for (const item of journal.files) {
          assertProjectStatePath(
            root,
            path.relative(path.resolve(root), item.target),
            "file",
            true,
          );
          assertProjectStatePath(
            root,
            path.relative(path.resolve(root), item.staged),
            "file",
            true,
          );
          safeUnlink(item.target);
          safeUnlink(item.staged);
        }
      }
      safeUnlink(journalFile);
    }
  });
}

function storedReceipt(row: Row): TemplateInstantiationReceipt {
  let receipt: TemplateInstantiationReceipt;
  try {
    receipt = JSON.parse(
      stringValue(row, "result_json"),
    ) as TemplateInstantiationReceipt;
  } catch {
    throw new BurnGraphError(
      "CORRUPT_STATE",
      "Stored template instantiation receipt is invalid",
    );
  }
  return receipt;
}

function validateRequest(request: TemplateInstantiationRequest): void {
  IdentifierSchema.parse(request.template.id);
  if (
    !Number.isInteger(request.template.version) ||
    request.template.version < 1
  ) {
    throw new BurnGraphError(
      "INVALID_TEMPLATE_VERSION",
      "Template version must be a positive integer",
    );
  }
  IdempotencyKeySchema.parse(request.idempotencyKey);
  if (!/^[a-f0-9]{64}$/.test(request.inputDigest)) {
    throw new BurnGraphError(
      "INVALID_TEMPLATE_DIGEST",
      "Template input digest must be SHA-256",
    );
  }
  if (request.graphs.length < 1 || request.graphs.length > 32) {
    throw new BurnGraphError(
      "INVALID_TEMPLATE_OUTPUT",
      "Template output must contain 1-32 GraphSpecs",
    );
  }
}

export class TemplateRegistry {
  constructor(private readonly options: TemplateRegistryOptions) {}

  instantiate(
    request: TemplateInstantiationRequest,
  ): TemplateInstantiationReceipt {
    validateRequest(request);
    assertProjectStateBoundary(this.options.root);
    recoverTemplateTransactions(this.options.root, this.options.database);

    const existing = this.options.database.db
      .query(
        `SELECT template_id, template_version, input_digest, result_json
           FROM template_instantiations
          WHERE idempotency_key = ?`,
      )
      .get(request.idempotencyKey) as Row | null;
    if (existing) {
      this.requireEquivalent(existing, request);
      return { ...storedReceipt(existing), replayed: true };
    }

    const graphs = request.graphs.map((graph) => {
      const normalized = this.options.validateGraph(graph);
      this.options.validateReferences(normalized);
      return normalized;
    });
    if (new Set(graphs.map((graph) => graph.id)).size !== graphs.length) {
      throw new BurnGraphError(
        "INVALID_TEMPLATE_OUTPUT",
        "Generated Graph IDs must be unique",
      );
    }

    const graphDirectory = path.join(
      this.options.root,
      STATE_DIRECTORY,
      "graphs",
    );
    const transactionDirectory = journalDirectory(this.options.root);
    assertProjectStatePath(
      this.options.root,
      path.join(STATE_DIRECTORY, "graphs"),
      "directory",
      true,
    );
    assertProjectStatePath(
      this.options.root,
      path.join(STATE_DIRECTORY, "runtime", "template-transactions"),
      "directory",
      true,
    );
    mkdirSync(graphDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(transactionDirectory, { recursive: true, mode: 0o700 });
    assertProjectStatePath(
      this.options.root,
      path.join(STATE_DIRECTORY, "graphs"),
      "directory",
      false,
    );
    assertProjectStatePath(
      this.options.root,
      path.join(STATE_DIRECTORY, "runtime", "template-transactions"),
      "directory",
      false,
    );
    const transactionId = crypto.randomUUID();
    const files = graphs.map((graph) => {
      const target = graphFile(this.options.root, graph.id);
      const staged = path.join(
        transactionDirectory,
        `${transactionId}-${graph.id}.stage`,
      );
      const document = `${JSON.stringify(graph, null, 2)}\n`;
      return {
        graph,
        target,
        staged,
        document,
        sha256: createHash("sha256").update(document).digest("hex"),
      };
    });

    const journalFile = path.join(
      transactionDirectory,
      `${transactionId}.journal.json`,
    );
    const journal: TemplateTransactionJournal = {
      schemaVersion: 1,
      transactionId,
      idempotencyKey: request.idempotencyKey,
      files: files.map((item) => ({
        staged: item.staged,
        target: item.target,
      })),
    };
    const createdTargets: string[] = [];
    const createdStaged: string[] = [];
    const at = this.options.timestamp();
    const receipt: TemplateInstantiationReceipt = {
      schemaVersion: 1,
      template: request.template,
      idempotencyKey: request.idempotencyKey,
      inputDigest: request.inputDigest,
      graphs: files.map((item) => ({
        graphId: item.graph.id,
        revision: item.graph.revision,
        path: path.relative(this.options.root, item.target),
        sha256: item.sha256,
      })),
      createdAt: at,
      replayed: false,
    };

    let committed = false;
    try {
      const result = this.options.database.immediate(() => {
        const replay = this.options.database.db
          .query(
            `SELECT template_id, template_version, input_digest, result_json
               FROM template_instantiations
              WHERE idempotency_key = ?`,
          )
          .get(request.idempotencyKey) as Row | null;
        if (replay) {
          this.requireEquivalent(replay, request);
          return { ...storedReceipt(replay), replayed: true };
        }
        for (const item of files) {
          const conflict = this.options.database.db
            .query(
              "SELECT revision FROM graph_specs WHERE graph_id = ? LIMIT 1",
            )
            .get(item.graph.id) as Row | null;
          if (conflict || existsSync(item.target)) {
            throw new BurnGraphError(
              "TEMPLATE_GRAPH_EXISTS",
              `Template graph ${item.graph.id} already exists`,
              true,
              { graphId: item.graph.id },
            );
          }
        }
        // Persist recovery intent under the SQLite writer lock before the
        // first filesystem side effect.
        atomicWriteJson(journalFile, journal, this.options.root);
        for (const item of files) {
          assertProjectStatePath(
            this.options.root,
            path.relative(path.resolve(this.options.root), item.staged),
            "file",
            true,
          );
          writeFileSync(item.staged, item.document, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          createdStaged.push(item.staged);
          assertProjectStatePath(
            this.options.root,
            path.relative(path.resolve(this.options.root), item.staged),
            "file",
            false,
          );
        }
        for (const item of files) {
          this.options.database.db
            .query(
              `INSERT INTO graph_specs (
                 graph_id, revision, document_json, created_at
               ) VALUES (?, ?, ?, ?)`,
            )
            .run(
              item.graph.id,
              item.graph.revision,
              json(item.graph),
              at,
            );
        }
        for (const item of files) {
          assertProjectStatePath(
            this.options.root,
            path.relative(path.resolve(this.options.root), item.target),
            "file",
            true,
          );
          assertProjectStatePath(
            this.options.root,
            path.relative(path.resolve(this.options.root), item.staged),
            "file",
            false,
          );
          linkSync(item.staged, item.target);
          createdTargets.push(item.target);
        }
        this.options.database.db
          .query(
            `INSERT INTO template_instantiations (
               idempotency_key, template_id, template_version,
               input_digest, result_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.idempotencyKey,
            request.template.id,
            request.template.version,
            request.inputDigest,
            json(receipt),
            at,
          );
        return receipt;
      });
      committed = true;
      this.options.database.immediate(() => {
        for (const staged of createdStaged) safeUnlink(staged);
        safeUnlink(journalFile);
      });
      return result;
    } catch (error) {
      if (!committed) {
        this.options.database.immediate(() => {
          for (const target of createdTargets) safeUnlink(target);
          for (const staged of createdStaged) safeUnlink(staged);
          safeUnlink(journalFile);
        });
      }
      throw error;
    }
  }

  private requireEquivalent(
    row: Row,
    request: TemplateInstantiationRequest,
  ): void {
    const templateId = stringValue(row, "template_id");
    const templateVersion = numberValue(row, "template_version");
    const inputDigest = stringValue(row, "input_digest");
    if (
      templateId !== request.template.id ||
      templateVersion !== request.template.version ||
      inputDigest !== request.inputDigest
    ) {
      throw new BurnGraphError(
        "IDEMPOTENCY_KEY_CONFLICT",
        `Idempotency key ${request.idempotencyKey} owns another template input`,
        false,
        {
          templateId,
          templateVersion,
          inputDigest,
        },
      );
    }
  }
}
