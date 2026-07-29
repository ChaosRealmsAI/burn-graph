// Purpose: Start, inspect, and stop one recorded burn-graph Viewer instance.
// Usage: bun scripts/runtime/viewer.ts <start|status|stop> <name> [project-root] [port]
// Notes: Only the exact PID recorded for a matching burn-graph serve command is stopped.

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

interface ViewerRecord {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly pid: number;
  readonly projectRoot: string;
  readonly port: number;
  readonly url: string;
  readonly logFile: string;
  readonly startedAt: string;
}

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const runtimeRoot = path.join(repositoryRoot, ".run", "viewers");
const cliFile = path.join(repositoryRoot, "dist", "burn-graph.js");
const namePattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function print(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

function fail(code: string, message: string): never {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: { code, message, retryable: false },
    })}\n`,
  );
  process.exit(1);
}

function requireName(value: string | undefined): string {
  if (!value || !namePattern.test(value)) {
    return fail(
      "INVALID_INSTANCE_NAME",
      "Instance name must start with a letter and contain only letters, numbers, . _ -",
    );
  }
  return value;
}

function recordFile(name: string): string {
  return path.join(runtimeRoot, `${name}.json`);
}

function readRecord(name: string): ViewerRecord {
  const file = recordFile(name);
  if (!existsSync(file)) {
    return fail("INSTANCE_NOT_FOUND", `No Viewer instance named ${name}`);
  }
  const record = JSON.parse(readFileSync(file, "utf8")) as Partial<ViewerRecord>;
  if (
    record.schemaVersion !== 1 ||
    record.name !== name ||
    typeof record.pid !== "number" ||
    typeof record.projectRoot !== "string" ||
    typeof record.port !== "number" ||
    typeof record.url !== "string" ||
    typeof record.logFile !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    return fail("INVALID_INSTANCE_RECORD", `Invalid record for ${name}`);
  }
  return record as ViewerRecord;
}

function writeRecord(record: ViewerRecord): void {
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const target = recordFile(record.name);
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
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim();
}

function isOwnedViewer(record: ViewerRecord): boolean {
  const command = processCommand(record.pid);
  return (
    command !== null &&
    command.includes("burn-graph.js") &&
    command.includes("serve") &&
    command.includes(`--port ${record.port}`)
  );
}

async function health(record: ViewerRecord): Promise<boolean> {
  try {
    const response = await fetch(`${record.url}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function start(name: string, projectInput?: string, portInput?: string) {
  if (!existsSync(cliFile)) {
    return fail("CLI_NOT_BUILT", "Run `bun run build` before starting the Viewer");
  }
  const existingFile = recordFile(name);
  if (existsSync(existingFile)) {
    const existing = readRecord(name);
    if (isOwnedViewer(existing)) {
      return fail("INSTANCE_RUNNING", `${name} is already running at ${existing.url}`);
    }
    unlinkSync(existingFile);
  }

  const projectRoot = path.resolve(projectInput ?? process.cwd());
  const port = Number(portInput ?? "4173");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return fail("INVALID_PORT", "Port must be an integer between 1 and 65535");
  }
  const configFile = path.join(projectRoot, ".burn-graph", "config.json");
  if (!existsSync(configFile)) {
    return fail("NOT_INITIALIZED", `${projectRoot} is not a burn-graph project`);
  }

  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const logFile = path.join(runtimeRoot, `${name}.log`);
  const logDescriptor = openSync(logFile, "a", 0o600);
  const child = spawn(
    "bun",
    [
      cliFile,
      "--root",
      projectRoot,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, BURN_GRAPH_INSTANCE: name },
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
    },
  );
  if (child.pid === undefined) {
    closeSync(logDescriptor);
    return fail("VIEWER_START_FAILED", "Viewer process did not receive a PID");
  }
  child.unref();
  closeSync(logDescriptor);

  const record: ViewerRecord = {
    schemaVersion: 1,
    name,
    pid: child.pid,
    projectRoot,
    port,
    url: `http://127.0.0.1:${port}`,
    logFile,
    startedAt: new Date().toISOString(),
  };
  writeRecord(record);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (isOwnedViewer(record) && (await health(record))) {
      print({ ...record, running: true, healthy: true });
      return;
    }
    if (processCommand(record.pid) === null) break;
    await Bun.sleep(100);
  }
  if (isOwnedViewer(record)) process.kill(record.pid, "SIGTERM");
  unlinkSync(recordFile(name));
  return fail("VIEWER_START_FAILED", `Viewer did not become healthy; see ${logFile}`);
}

async function status(name: string) {
  const record = readRecord(name);
  const running = isOwnedViewer(record);
  print({ ...record, running, healthy: running ? await health(record) : false });
}

async function stop(name: string) {
  const record = readRecord(name);
  const command = processCommand(record.pid);
  if (command === null) {
    unlinkSync(recordFile(name));
    print({ name, stopped: false, staleRecordRemoved: true });
    return;
  }
  if (!isOwnedViewer(record)) {
    return fail(
      "PID_OWNERSHIP_MISMATCH",
      `PID ${record.pid} no longer matches the recorded Viewer command`,
    );
  }

  process.kill(record.pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (processCommand(record.pid) === null) {
      unlinkSync(recordFile(name));
      print({ name, pid: record.pid, stopped: true });
      return;
    }
    await Bun.sleep(100);
  }
  if (isOwnedViewer(record)) process.kill(record.pid, "SIGKILL");
  unlinkSync(recordFile(name));
  print({ name, pid: record.pid, stopped: true, forced: true });
}

const [operation, nameInput, projectInput, portInput] = process.argv.slice(2);
const name = requireName(nameInput);
switch (operation) {
  case "start":
    await start(name, projectInput, portInput);
    break;
  case "status":
    await status(name);
    break;
  case "stop":
    await stop(name);
    break;
  default:
    fail(
      "INVALID_OPERATION",
      "Usage: viewer.ts <start|status|stop> <name> [project-root] [port]",
    );
}
