import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  type GraphSpec,
  type ProjectConfig,
} from "./contracts.ts";

export const STATE_DIRECTORY = ".burn-graph";

function safeChmod(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch {
    // Filesystems without POSIX permissions still keep the local-only boundary.
  }
}

export function atomicWriteJson(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, target);
}

export function initializeProject(rootInput: string, now: string): ProjectConfig {
  const root = path.resolve(rootInput);
  const stateRoot = path.join(root, STATE_DIRECTORY);
  const configFile = path.join(stateRoot, "config.json");
  if (existsSync(configFile)) {
    throw new BurnGraphError(
      "ALREADY_INITIALIZED",
      `burn-graph is already initialized at ${root}`,
    );
  }
  mkdirSync(path.join(stateRoot, "graphs"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(stateRoot, "prompts"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(stateRoot, "runtime", "artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  safeChmod(stateRoot, 0o700);
  const baseName = path.basename(root).replace(/[^A-Za-z0-9._:-]/g, "-");
  const projectId = /^[A-Za-z]/.test(baseName) ? baseName : `project-${baseName}`;
  const config: ProjectConfig = {
    schemaVersion: 1,
    projectId,
    createdAt: now,
    defaultLeaseSeconds: 900,
    maxAssignmentsPerActor: 8,
  };
  atomicWriteJson(configFile, config);
  writeFileSync(path.join(stateRoot, ".gitignore"), "runtime/\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return config;
}

export function discoverProjectRoot(startInput: string): string {
  let current = path.resolve(startInput);
  for (;;) {
    if (existsSync(path.join(current, STATE_DIRECTORY, "config.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new BurnGraphError(
    "NOT_INITIALIZED",
    `No .burn-graph/config.json found from ${path.resolve(startInput)}`,
  );
}

export function readProjectConfig(root: string): ProjectConfig {
  const file = path.join(root, STATE_DIRECTORY, "config.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProjectConfig>;
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.projectId !== "string" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.defaultLeaseSeconds !== "number" ||
    (parsed.maxAssignmentsPerActor !== undefined &&
      (typeof parsed.maxAssignmentsPerActor !== "number" ||
        !Number.isInteger(parsed.maxAssignmentsPerActor) ||
        parsed.maxAssignmentsPerActor < 1 ||
        parsed.maxAssignmentsPerActor > 32))
  ) {
    throw new BurnGraphError("INVALID_CONFIG", `Invalid config at ${file}`);
  }
  return {
    schemaVersion: 1,
    projectId: parsed.projectId,
    createdAt: parsed.createdAt,
    defaultLeaseSeconds: parsed.defaultLeaseSeconds,
    maxAssignmentsPerActor: parsed.maxAssignmentsPerActor ?? 8,
  };
}

export function graphFile(root: string, graphId: string): string {
  return path.join(root, STATE_DIRECTORY, "graphs", `${graphId}.json`);
}

export function writeGraphSpec(root: string, spec: GraphSpec): void {
  atomicWriteJson(graphFile(root, spec.id), spec);
}

export function runtimeDatabaseFile(root: string): string {
  return path.join(root, STATE_DIRECTORY, "runtime", "state.sqlite");
}
