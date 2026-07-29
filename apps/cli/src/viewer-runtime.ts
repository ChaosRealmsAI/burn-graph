import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  BurnGraphError,
  discoverProjectRoot,
} from "@burn-graph/core";

export interface ViewerRecord {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly pid: number;
  readonly projectRoot: string;
  readonly port: number;
  readonly url: string;
  readonly logFile: string;
  readonly entryFile: string;
  readonly instanceToken: string;
  readonly startedAt: string;
}

export type ViewerStatus = Omit<
  ViewerRecord,
  "entryFile" | "instanceToken"
> & {
  readonly running: boolean;
  readonly healthy: boolean;
};

const namePattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function requireName(value: string): string {
  if (!namePattern.test(value)) {
    throw new BurnGraphError(
      "INVALID_INSTANCE_NAME",
      "Viewer name must start with a letter and contain only letters, numbers, . _ -",
    );
  }
  return value;
}

function runtimeRoot(projectRoot: string): string {
  return path.join(projectRoot, ".burn-graph", "runtime", "viewers");
}

function recordFile(projectRoot: string, name: string): string {
  return path.join(runtimeRoot(projectRoot), `${name}.json`);
}

function readRecord(projectRoot: string, name: string): ViewerRecord {
  const file = recordFile(projectRoot, name);
  if (!existsSync(file)) {
    throw new BurnGraphError(
      "VIEWER_NOT_FOUND",
      `No Viewer instance named ${name}`,
    );
  }
  const record = JSON.parse(readFileSync(file, "utf8")) as Partial<ViewerRecord>;
  if (
    record.schemaVersion !== 1 ||
    record.name !== name ||
    typeof record.pid !== "number" ||
    record.projectRoot !== projectRoot ||
    typeof record.port !== "number" ||
    typeof record.url !== "string" ||
    typeof record.logFile !== "string" ||
    typeof record.entryFile !== "string" ||
    typeof record.instanceToken !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    throw new BurnGraphError(
      "INVALID_VIEWER_RECORD",
      `Invalid Viewer record for ${name}`,
    );
  }
  return record as ViewerRecord;
}

function writeRecord(record: ViewerRecord): void {
  const directory = runtimeRoot(record.projectRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = recordFile(record.projectRoot, record.name);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, target);
}

function processCommand(pid: number): string | null {
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  const result = Bun.spawnSync([
    "/bin/ps",
    "-p",
    String(pid),
    "-o",
    "command=",
  ]);
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function isOwnedViewer(record: ViewerRecord): boolean {
  const command = processCommand(record.pid);
  return (
    command !== null &&
    command.includes("__viewer-serve") &&
    command.includes(record.instanceToken) &&
    command.includes(String(record.port))
  );
}

async function healthy(record: ViewerRecord): Promise<boolean> {
  try {
    const response = await fetch(`${record.url}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function publicStatus(
  record: ViewerRecord,
  running: boolean,
  isHealthy: boolean,
): ViewerStatus {
  return {
    schemaVersion: record.schemaVersion,
    name: record.name,
    pid: record.pid,
    projectRoot: record.projectRoot,
    port: record.port,
    url: record.url,
    logFile: record.logFile,
    startedAt: record.startedAt,
    running,
    healthy: isHealthy,
  };
}

export async function startViewerInstance(
  rootInput: string,
  nameInput: string,
  port: number,
  open: boolean,
): Promise<ViewerStatus> {
  const projectRoot = discoverProjectRoot(rootInput);
  const name = requireName(nameInput);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new BurnGraphError(
      "INVALID_PORT",
      "Port must be an integer between 1 and 65535",
    );
  }
  const file = recordFile(projectRoot, name);
  if (existsSync(file)) {
    const existing = readRecord(projectRoot, name);
    if (isOwnedViewer(existing)) {
      throw new BurnGraphError(
        "VIEWER_RUNNING",
        `${name} is already running at ${existing.url}`,
        true,
      );
    }
    unlinkSync(file);
  }

  const entryFile = path.resolve(process.argv[1] ?? "");
  if (!existsSync(entryFile)) {
    throw new BurnGraphError(
      "CLI_ENTRY_NOT_FOUND",
      "Cannot resolve the active burn-graph executable",
    );
  }
  const directory = runtimeRoot(projectRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const logFile = path.join(directory, `${name}.log`);
  const logDescriptor = openSync(logFile, "a", 0o600);
  const instanceToken = crypto.randomUUID();
  const child = spawn(
    process.execPath,
    [
      entryFile,
      "--root",
      projectRoot,
      "__viewer-serve",
      "--port",
      String(port),
      "--instance-token",
      instanceToken,
    ],
    {
      cwd: projectRoot,
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
    },
  );
  closeSync(logDescriptor);
  if (child.pid === undefined) {
    throw new BurnGraphError(
      "VIEWER_START_FAILED",
      "Viewer process did not receive a PID",
    );
  }
  child.unref();

  const record: ViewerRecord = {
    schemaVersion: 1,
    name,
    pid: child.pid,
    projectRoot,
    port,
    url: `http://127.0.0.1:${port}`,
    logFile,
    entryFile,
    instanceToken,
    startedAt: new Date().toISOString(),
  };
  writeRecord(record);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (isOwnedViewer(record) && (await healthy(record))) {
      if (open) {
        Bun.spawn(["/usr/bin/open", record.url], {
          stdout: "ignore",
          stderr: "ignore",
        });
      }
      return publicStatus(record, true, true);
    }
    if (processCommand(record.pid) === null) break;
    await Bun.sleep(100);
  }
  if (isOwnedViewer(record)) process.kill(record.pid, "SIGTERM");
  if (existsSync(file)) unlinkSync(file);
  throw new BurnGraphError(
    "VIEWER_START_FAILED",
    `Viewer did not become healthy; inspect ${logFile}`,
  );
}

export async function viewerInstanceStatus(
  rootInput: string,
  nameInput: string,
): Promise<ViewerStatus> {
  const projectRoot = discoverProjectRoot(rootInput);
  const record = readRecord(projectRoot, requireName(nameInput));
  const running = isOwnedViewer(record);
  return publicStatus(
    record,
    running,
    running ? await healthy(record) : false,
  );
}

export async function stopViewerInstance(
  rootInput: string,
  nameInput: string,
): Promise<{
  readonly name: string;
  readonly pid: number;
  readonly stopped: boolean;
  readonly forced?: boolean;
  readonly staleRecordRemoved?: boolean;
}> {
  const projectRoot = discoverProjectRoot(rootInput);
  const name = requireName(nameInput);
  const record = readRecord(projectRoot, name);
  const file = recordFile(projectRoot, name);
  const command = processCommand(record.pid);
  if (command === null) {
    unlinkSync(file);
    return {
      name,
      pid: record.pid,
      stopped: false,
      staleRecordRemoved: true,
    };
  }
  if (!isOwnedViewer(record)) {
    throw new BurnGraphError(
      "PID_OWNERSHIP_MISMATCH",
      `PID ${record.pid} no longer matches Viewer ${name}`,
    );
  }

  process.kill(record.pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (processCommand(record.pid) === null) {
      unlinkSync(file);
      return { name, pid: record.pid, stopped: true };
    }
    await Bun.sleep(100);
  }
  if (!isOwnedViewer(record)) {
    throw new BurnGraphError(
      "PID_OWNERSHIP_MISMATCH",
      `PID ${record.pid} changed before forced Viewer stop`,
    );
  }
  process.kill(record.pid, "SIGKILL");
  unlinkSync(file);
  return { name, pid: record.pid, stopped: true, forced: true };
}
