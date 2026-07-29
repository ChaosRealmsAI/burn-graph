import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { runtimeDatabaseFile } from "./project.ts";

export class BurnGraphDatabase {
  readonly db: Database;

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

  private migrate(): void {
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

      CREATE UNIQUE INDEX IF NOT EXISTS runs_one_live_graph_idx
        ON runs(graph_id)
        WHERE status IN ('running', 'paused');

      CREATE TABLE IF NOT EXISTS node_runs (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
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
    `);
  }
}
