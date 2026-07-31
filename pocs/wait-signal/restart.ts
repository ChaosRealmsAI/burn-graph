import { mkdirSync } from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

export interface WaitSignalPocRecord {
  readonly signalId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly routes: readonly string[];
  readonly deadlineAt: string | null;
  readonly createdAt: string;
}

export class WaitSignalRestartPoc {
  private readonly database: Database;

  constructor(projectRoot: string) {
    const runtime = path.join(projectRoot, ".burn", "graph", "runtime");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    this.database = new Database(path.join(runtime, "wait-signal-poc.sqlite"), {
      create: true,
      strict: true,
    });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS poc_wait_signals (
        signal_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        routes_json TEXT NOT NULL,
        deadline_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  materialize(record: WaitSignalPocRecord): void {
    this.database
      .query(
        `INSERT INTO poc_wait_signals (
           signal_id, run_id, node_id, routes_json, deadline_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.signalId,
        record.runId,
        record.nodeId,
        JSON.stringify(record.routes),
        record.deadlineAt,
        record.createdAt,
      );
  }

  read(signalId: string): WaitSignalPocRecord | null {
    const row = this.database
      .query(
        `SELECT signal_id, run_id, node_id, routes_json, deadline_at, created_at
           FROM poc_wait_signals
          WHERE signal_id = ?`,
      )
      .get(signalId) as
      | {
          signal_id: string;
          run_id: string;
          node_id: string;
          routes_json: string;
          deadline_at: string | null;
          created_at: string;
        }
      | null;
    if (!row) return null;
    return {
      signalId: row.signal_id,
      runId: row.run_id,
      nodeId: row.node_id,
      routes: JSON.parse(row.routes_json) as readonly string[],
      deadlineAt: row.deadline_at,
      createdAt: row.created_at,
    };
  }
}
