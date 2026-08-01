import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  BurnGraphService,
  initializeProject,
  runtimeDatabaseFile,
} from "@burn-graph/core";

import {
  createTestDirectory,
  parallelGraph,
  removeTestProject,
} from "../helpers/fixtures.ts";

type Row = Record<string, unknown>;

function seedDev4Database(root: string, failBackfill = false): Database {
  initializeProject(root, "2026-01-01T00:00:00.000Z");
  const database = new Database(runtimeDatabaseFile(root), {
    create: true,
    strict: true,
  });
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE graph_specs (
      graph_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (graph_id, revision)
    );

    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      spec_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      runtime_revision INTEGER NOT NULL,
      focused_node_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (graph_id, spec_revision)
        REFERENCES graph_specs(graph_id, revision)
    );

    CREATE UNIQUE INDEX runs_one_live_graph_idx
      ON runs(graph_id)
      WHERE status IN ('running', 'paused');

    CREATE TABLE node_runs (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      assignment_id TEXT,
      actor_id TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      route TEXT,
      result_json TEXT,
      checkpoint_json TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE edge_runs (
      run_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      route TEXT,
      label TEXT,
      max_traversals INTEGER,
      traversals INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, edge_id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE attempts (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      assignment_id TEXT,
      actor_id TEXT,
      result_json TEXT,
      checkpoint_json TEXT,
      route TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY (run_id, node_id, attempt),
      FOREIGN KEY (run_id, node_id)
        REFERENCES node_runs(run_id, node_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX attempts_assignment_idx
      ON attempts(assignment_id)
      WHERE assignment_id IS NOT NULL;

    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      graph_id TEXT NOT NULL,
      node_id TEXT,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE actor_focus (
      actor_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id, node_id)
        REFERENCES node_runs(run_id, node_id) ON DELETE CASCADE
    );
  `);

  const graph = parallelGraph("legacy");
  const at = "2026-01-01T00:01:00.000Z";
  database
    .query(
      `INSERT INTO graph_specs
       (graph_id, revision, document_json, created_at)
       VALUES (?, 1, ?, ?)`,
    )
    .run(graph.id, JSON.stringify(graph), at);
  const runIds = Array.from({ length: 9 }, (_, index) =>
    index === 0 ? "legacy-run" : `legacy-run-${index + 1}`,
  );
  runIds.forEach((runId, runIndex) => {
    database
      .query(
        `INSERT INTO runs
         (run_id, graph_id, spec_revision, status, runtime_revision,
          focused_node_id, created_at, updated_at)
         VALUES (?, 'legacy', 1, 'completed', ?, NULL, ?, ?)`,
      )
      .run(runId, 7 + runIndex, at, at);

    for (const node of graph.nodes) {
      const attempt = node.type === "task" ? 1 : 0;
      const result =
        node.type === "task"
          ? JSON.stringify({
              summary: `Completed ${runId}/${node.id}.`,
              evidence: [`evidence:${runId}:${node.id}`],
            })
          : null;
      database
        .query(
          `INSERT INTO node_runs
           (run_id, node_id, node_type, title, status, attempt,
            assignment_id, actor_id, lease_expires_at, heartbeat_at,
            route, result_json, checkpoint_json, last_error, updated_at)
           VALUES (?, ?, ?, ?, 'done', ?, NULL, NULL, NULL, NULL,
                   NULL, ?, NULL, NULL, ?)`,
        )
        .run(
          runId,
          node.id,
          node.type,
          node.title,
          attempt,
          result,
          at,
        );
      if (node.type === "task") {
        database
          .query(
            `INSERT INTO attempts
             (run_id, node_id, attempt, status, assignment_id, actor_id,
              result_json, checkpoint_json, route, started_at, finished_at)
             VALUES (?, ?, 1, 'done', ?, 'legacy-actor',
                     ?, NULL, NULL, ?, ?)`,
          )
          .run(
            runId,
            node.id,
            `legacy-assignment-${runIndex}-${node.id}`,
            result,
            at,
            at,
          );
      }
    }

    graph.nodes.forEach((node) => {
      node.next.forEach((edge, index) => {
        database
          .query(
            `INSERT INTO edge_runs
             (run_id, edge_id, from_node_id, to_node_id, route, label,
              max_traversals, traversals, status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'taken', ?)`,
          )
          .run(
            runId,
            `${node.id}:${index}:${edge.to}`,
            node.id,
            edge.to,
            edge.route ?? null,
            edge.label ?? null,
            edge.maxTraversals ?? null,
            at,
          );
      });
    });

    for (let eventIndex = 0; eventIndex < 10; eventIndex += 1) {
      const sequence = runIndex * 10 + eventIndex + 1;
      const node = graph.nodes[eventIndex % graph.nodes.length]!;
      database
        .query(
          `INSERT INTO events
           (sequence, run_id, graph_id, node_id, type, summary,
            payload_json, created_at)
           VALUES (?, ?, 'legacy', ?, ?, ?, ?, ?)`,
        )
        .run(
          sequence,
          runId,
          node.id,
          eventIndex === 0 ? "run.started" : "node.completed",
          `Legacy event ${sequence}.`,
          JSON.stringify({ revision: 7 + runIndex }),
          at,
        );
    }
  });

  if (failBackfill) {
    database.exec(`
      CREATE VIEW subgraph_links AS
      SELECT run_id AS child_run_id FROM runs;
    `);
  }
  return database;
}

function legacyProjection(database: Database): Record<string, readonly Row[]> {
  return {
    graphSpecs: database
      .query(
        `SELECT graph_id, revision, document_json, created_at
           FROM graph_specs ORDER BY graph_id, revision`,
      )
      .all() as Row[],
    runs: database
      .query(
        `SELECT run_id, graph_id, spec_revision, status, runtime_revision,
                focused_node_id, created_at, updated_at
           FROM runs ORDER BY run_id`,
      )
      .all() as Row[],
    nodes: database
      .query(
        `SELECT run_id, node_id, node_type, title, status, attempt,
                assignment_id, actor_id, lease_expires_at, heartbeat_at,
                route, result_json, checkpoint_json, last_error, updated_at
           FROM node_runs ORDER BY run_id, node_id`,
      )
      .all() as Row[],
    edges: database
      .query(
        `SELECT run_id, edge_id, from_node_id, to_node_id, route, label,
                max_traversals, traversals, status, updated_at
           FROM edge_runs ORDER BY run_id, edge_id`,
      )
      .all() as Row[],
    attempts: database
      .query(
        `SELECT run_id, node_id, attempt, status, assignment_id, actor_id,
                result_json, checkpoint_json, route, started_at, finished_at
           FROM attempts ORDER BY run_id, node_id, attempt`,
      )
      .all() as Row[],
    events: database
      .query(
        `SELECT sequence, run_id, graph_id, node_id, type, summary,
                payload_json, created_at
           FROM events ORDER BY sequence`,
      )
      .all() as Row[],
  };
}

describe("dev.4 hierarchy migration", () => {
  test("preserves v1 rows and backfills depth-zero root metadata", () => {
    const root = createTestDirectory();
    const legacy = seedDev4Database(root);
    const before = legacyProjection(legacy);
    legacy.close();

    const service = new BurnGraphService(root);
    try {
      expect(legacyProjection(service.database.db)).toEqual(before);
      expect(
        service.database.db
          .query(
            `SELECT root_run_id, parent_run_id, parent_node_id, depth, priority
               FROM runs WHERE run_id = 'legacy-run'`,
          )
          .get(),
      ).toEqual({
        root_run_id: "legacy-run",
        parent_run_id: null,
        parent_node_id: null,
        depth: 0,
        priority: "normal",
      });
      expect(
        service.database.db
          .query("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
      ]);
      expect(
        (
          service.database.db
            .query("PRAGMA table_info(attempts)")
            .all() as Array<{ name: string }>
        ).map(({ name }) => name),
      ).toContain("continuation_json");
      expect(
        service.database.db
          .query(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'template_instantiations'`,
          )
          .get(),
      ).toEqual({ name: "template_instantiations" });
      expect(
        service.database.db
          .query("SELECT COUNT(*) AS count FROM runs")
          .get(),
      ).toEqual({ count: 9 });
      expect(
        service.database.db
          .query("SELECT COUNT(*) AS count FROM events")
          .get(),
      ).toEqual({ count: 90 });

      const snapshot = service.getSnapshot("legacy-run");
      expect(snapshot.summary).toMatchObject({
        runId: "legacy-run",
        graphId: "legacy",
        runtimeRevision: 7,
        status: "completed",
      });
      expect(snapshot.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 10 }, (_, index) => index + 1),
      );
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("allows repeated live child instances while retaining root uniqueness", () => {
    const root = createTestDirectory();
    const legacy = seedDev4Database(root);
    legacy.close();
    let service = new BurnGraphService(root);
    try {
      service.close();
      service = new BurnGraphService(root);
      const insert = service.database.db.query(
        `INSERT INTO runs
         (run_id, graph_id, spec_revision, status, runtime_revision,
          focused_node_id, parent_run_id, parent_node_id, root_run_id,
          depth, priority, created_at, updated_at)
         VALUES (?, 'legacy', 1, 'running', 1, NULL,
                 'legacy-run', 'left', 'legacy-run', 1, 'normal', ?, ?)`,
      );
      const at = "2026-01-01T00:02:00.000Z";
      insert.run("legacy-child-one", at, at);
      insert.run("legacy-child-two", at, at);
      expect(
        service.database.db
          .query(
            `SELECT run_id FROM runs
              WHERE parent_run_id = 'legacy-run'
              ORDER BY run_id`,
          )
          .all(),
      ).toEqual([
        { run_id: "legacy-child-one" },
        { run_id: "legacy-child-two" },
      ]);
    } finally {
      service.close();
      removeTestProject(root);
    }
  });

  test("rolls back every hierarchy DDL change after a seeded backfill failure", () => {
    const root = createTestDirectory();
    const legacy = seedDev4Database(root, true);
    legacy.close();

    expect(() => new BurnGraphService(root)).toThrow(
      "subgraph_links",
    );

    const after = new Database(runtimeDatabaseFile(root), {
      create: false,
      strict: true,
    });
    try {
      const runColumns = after.query("PRAGMA table_info(runs)").all() as Array<{
        name: string;
      }>;
      expect(runColumns.map(({ name }) => name)).not.toContain("root_run_id");
      expect(
        after
          .query(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name IN
                    ('schema_migrations', 'subgraph_links')
              ORDER BY name`,
          )
          .all(),
      ).toEqual([]);
    } finally {
      after.close();
      removeTestProject(root);
    }
  });
});
