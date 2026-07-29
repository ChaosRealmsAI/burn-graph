import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { runtimeDatabaseFile } from "./project.ts";

export class BurnGraphDatabase {
  readonly db: Database;
  private nestedTransactionSequence = 0;

  constructor(readonly projectRoot: string) {
    const file = runtimeDatabaseFile(projectRoot);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    try {
      chmodSync(file, 0o600);
    } catch {
      // Non-POSIX filesystems still retain the project-local storage boundary.
    }
  }

  close(): void {
    this.db.close();
  }

  immediate<T>(operation: () => T): T {
    if (this.db.inTransaction) {
      const savepoint = `burn_graph_nested_${++this.nestedTransactionSequence}`;
      this.db.exec(`SAVEPOINT ${savepoint};`);
      try {
        const result = operation();
        this.db.exec(`RELEASE SAVEPOINT ${savepoint};`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint};`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint};`);
        throw error;
      }
    }
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  read<T>(operation: () => T): T {
    if (this.db.inTransaction) return operation();
    this.db.exec("BEGIN;");
    try {
      const result = operation();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      if (this.db.inTransaction) {
        this.db.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS graph_specs (
          graph_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          document_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (graph_id, revision)
        );

        CREATE TABLE IF NOT EXISTS runs (
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

        CREATE INDEX IF NOT EXISTS runs_graph_idx
          ON runs(graph_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS node_runs (
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

        CREATE INDEX IF NOT EXISTS node_runs_ready_idx
          ON node_runs(status, updated_at);

        CREATE TABLE IF NOT EXISTS edge_runs (
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

        CREATE TABLE IF NOT EXISTS attempts (
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

        CREATE TABLE IF NOT EXISTS events (
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

        CREATE INDEX IF NOT EXISTS events_run_idx
          ON events(run_id, sequence);

        CREATE TABLE IF NOT EXISTS actor_focus (
          actor_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (run_id, node_id)
            REFERENCES node_runs(run_id, node_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);

      this.ensureColumn("node_runs", "assignment_id", "TEXT");
      this.ensureColumn("attempts", "assignment_id", "TEXT");

      const active = this.db
        .query(
          `SELECT n.run_id, n.node_id, n.attempt
             FROM node_runs n
            WHERE n.status = 'running' AND n.assignment_id IS NULL`,
        )
        .all() as Array<{ run_id: string; node_id: string; attempt: number }>;
      for (const row of active) {
        const assignmentId = crypto.randomUUID();
        this.db
          .query(
            `UPDATE node_runs
                SET assignment_id = ?
              WHERE run_id = ? AND node_id = ?`,
          )
          .run(assignmentId, row.run_id, row.node_id);
        this.db
          .query(
            `UPDATE attempts
                SET assignment_id = ?
              WHERE run_id = ? AND node_id = ? AND attempt = ?`,
          )
          .run(assignmentId, row.run_id, row.node_id, row.attempt);
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS attempts_assignment_idx
          ON attempts(assignment_id)
          WHERE assignment_id IS NOT NULL;
      `);
      this.db
        .query(
          `INSERT OR IGNORE INTO schema_migrations
           (version, name, applied_at)
           VALUES (1, 'assignment-runtime',
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        )
        .run();

      const hierarchy = this.db
        .query("SELECT version FROM schema_migrations WHERE version = 2")
        .get() as { version: number } | null;
      if (!hierarchy) {
        this.ensureColumn("runs", "parent_run_id", "TEXT");
        this.ensureColumn("runs", "parent_node_id", "TEXT");
        this.ensureColumn("runs", "root_run_id", "TEXT");
        this.ensureColumn("runs", "depth", "INTEGER");
        this.ensureColumn("runs", "priority", "TEXT");
        this.ensureColumn("runs", "pause_requested_at", "TEXT");
        this.ensureColumn("runs", "paused_at", "TEXT");
        this.ensureColumn("runs", "cancel_requested_at", "TEXT");
        this.ensureColumn("runs", "scheduler_ready_at", "TEXT");

        this.db.exec(`
          UPDATE runs
             SET root_run_id = COALESCE(root_run_id, run_id),
                 depth = COALESCE(depth, 0),
                 priority = COALESCE(priority, 'normal'),
                 scheduler_ready_at = COALESCE(scheduler_ready_at, updated_at);

          DROP INDEX IF EXISTS runs_one_live_graph_idx;

          CREATE UNIQUE INDEX runs_one_live_root_graph_idx
            ON runs(graph_id)
            WHERE parent_run_id IS NULL
              AND status IN ('running', 'pausing', 'paused', 'cancelling');

          CREATE INDEX runs_root_idx
            ON runs(root_run_id, depth, updated_at DESC);

          CREATE INDEX runs_parent_idx
            ON runs(parent_run_id, parent_node_id, updated_at DESC);

          CREATE TABLE subgraph_links (
            parent_run_id TEXT NOT NULL,
            parent_node_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            child_run_id TEXT NOT NULL UNIQUE,
            child_graph_id TEXT NOT NULL,
            child_spec_revision INTEGER NOT NULL,
            label TEXT,
            outcome TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (parent_run_id, parent_node_id, position),
            FOREIGN KEY (parent_run_id, parent_node_id)
              REFERENCES node_runs(run_id, node_id) ON DELETE CASCADE,
            FOREIGN KEY (child_run_id)
              REFERENCES runs(run_id) ON DELETE CASCADE,
            FOREIGN KEY (child_graph_id, child_spec_revision)
              REFERENCES graph_specs(graph_id, revision)
          );

          CREATE INDEX subgraph_links_parent_idx
            ON subgraph_links(parent_run_id, parent_node_id, position);
        `);
        this.db
          .query(
            `INSERT INTO schema_migrations
             (version, name, applied_at)
             VALUES (2, 'hierarchical-runs',
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
          )
          .run();
      }
      this.db.exec(`
        DROP INDEX IF EXISTS runs_one_live_graph_idx;

        CREATE UNIQUE INDEX IF NOT EXISTS runs_one_live_root_graph_idx
          ON runs(graph_id)
          WHERE parent_run_id IS NULL
            AND status IN ('running', 'pausing', 'paused', 'cancelling');
      `);

      const lifecycleIdempotency = this.db
        .query("SELECT version FROM schema_migrations WHERE version = 3")
        .get() as { version: number } | null;
      if (!lifecycleIdempotency) {
        this.ensureColumn("runs", "pause_scope_run_id", "TEXT");
        this.db.exec(`
          CREATE TABLE lifecycle_requests (
            idempotency_key TEXT PRIMARY KEY,
            operation TEXT NOT NULL,
            request_reference TEXT NOT NULL,
            target_run_id TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (target_run_id)
              REFERENCES runs(run_id) ON DELETE CASCADE
          );
        `);
        this.db
          .query(
            `INSERT INTO schema_migrations
             (version, name, applied_at)
             VALUES (3, 'lifecycle-idempotency',
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
          )
          .run();
      }

      const atomicContinuations = this.db
        .query("SELECT version FROM schema_migrations WHERE version = 4")
        .get() as { version: number } | null;
      if (!atomicContinuations) {
        this.ensureColumn("attempts", "continuation_json", "TEXT");
        this.ensureColumn(
          "lifecycle_requests",
          "continuation_json",
          "TEXT",
        );
        this.db
          .query(
            `INSERT INTO schema_migrations
             (version, name, applied_at)
             VALUES (4, 'atomic-continuations',
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
          )
          .run();
      }

      const systemNodes = this.db
        .query("SELECT version FROM schema_migrations WHERE version = 5")
        .get() as { version: number } | null;
      if (!systemNodes) {
        this.db.exec(`
          CREATE TABLE check_specs (
            check_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            document_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (check_id, revision)
          );

          CREATE TABLE check_executions (
            execution_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            check_id TEXT NOT NULL,
            check_revision INTEGER NOT NULL,
            status TEXT NOT NULL,
            lease_expires_at TEXT NOT NULL,
            classification TEXT,
            exit_code INTEGER,
            duration_ms INTEGER,
            byte_count INTEGER,
            digest TEXT,
            stdout_text TEXT,
            stderr_text TEXT,
            created_at TEXT NOT NULL,
            finished_at TEXT,
            UNIQUE (run_id, node_id, attempt),
            FOREIGN KEY (run_id, node_id)
              REFERENCES node_runs(run_id, node_id) ON DELETE CASCADE,
            FOREIGN KEY (check_id, check_revision)
              REFERENCES check_specs(check_id, revision)
          );

          CREATE INDEX check_executions_status_idx
            ON check_executions(status, lease_expires_at, run_id);

          CREATE TABLE wait_signals (
            signal_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            status TEXT NOT NULL,
            routes_json TEXT NOT NULL,
            timeout_route TEXT,
            deadline_at TEXT,
            resolved_route TEXT,
            summary TEXT,
            evidence_json TEXT,
            idempotency_key TEXT,
            resolution_json TEXT,
            continuation_json TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE (run_id, node_id, attempt),
            FOREIGN KEY (run_id, node_id)
              REFERENCES node_runs(run_id, node_id) ON DELETE CASCADE
          );

          CREATE UNIQUE INDEX wait_signals_idempotency_idx
            ON wait_signals(idempotency_key)
            WHERE idempotency_key IS NOT NULL;

          CREATE INDEX wait_signals_status_idx
            ON wait_signals(status, deadline_at, run_id);

          CREATE TABLE resource_locks (
            resource TEXT PRIMARY KEY,
            owner_kind TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            root_run_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (run_id, node_id)
              REFERENCES node_runs(run_id, node_id) ON DELETE CASCADE
          );

          CREATE INDEX resource_locks_owner_idx
            ON resource_locks(owner_kind, owner_id);
        `);
        this.db
          .query(
            `INSERT INTO schema_migrations
             (version, name, applied_at)
             VALUES (5, 'system-nodes',
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
          )
          .run();
      }
      this.ensureColumn("wait_signals", "continuation_json", "TEXT");

      const templateCatalog = this.db
        .query("SELECT version FROM schema_migrations WHERE version = 6")
        .get() as { version: number } | null;
      if (!templateCatalog) {
        this.db.exec(`
          CREATE TABLE template_instantiations (
            idempotency_key TEXT PRIMARY KEY,
            template_id TEXT NOT NULL,
            template_version INTEGER NOT NULL,
            input_digest TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE INDEX template_instantiations_template_idx
            ON template_instantiations(template_id, created_at);
        `);
        this.db
          .query(
            `INSERT INTO schema_migrations
             (version, name, applied_at)
             VALUES (6, 'template-catalog',
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
          )
          .run();
      }

      this.db.exec("COMMIT;");
    } catch (error) {
      if (this.db.inTransaction) {
        this.db.exec("ROLLBACK;");
      }
      throw error;
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }
}
