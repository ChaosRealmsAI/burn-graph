import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  BurnGraphError,
  type CheckSpec,
  type GraphSpec,
  type ProjectConfig,
} from "./contracts.ts";

// Every Burn product keeps project state under one shared `.burn/` root, so a
// directory holding `.burn/` is the project root even when this product has not
// been initialized inside it yet.
export const PROJECT_ROOT_DIRECTORY = ".burn";
export const STATE_DIRECTORY = ".burn/graph";
// The pre-3.0 project root. State is never read, written, or migrated through
// it; it survives only to make the stable judgment and its remediation legible.
export const LEGACY_STATE_DIRECTORY = ".burn-graph";
const RUNTIME_IGNORE_ENTRY = ".burn/graph/runtime/";

function isDirectory(target: string): boolean {
  try {
    // No-follow: a symlinked state root would let discovery adopt a project
    // outside the walked tree.
    return lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

// The walk stops at $HOME because a home directory is a user boundary, not a
// project. macOS reaches the same home through /private, so both forms count.
function homeBoundaries(): readonly string[] {
  const raw = process.env["HOME"] ?? homedir();
  if (raw === undefined || raw.length === 0) return [];
  const resolved = path.resolve(raw);
  const boundaries = [resolved];
  try {
    const real = realpathSync(resolved);
    if (real !== resolved) boundaries.push(real);
  } catch {
    // An unreadable $HOME still bounds the walk by its resolved name.
  }
  return boundaries;
}

// `~/.burn-graph` is this product's user-level home. It is untouched by the
// project-root migration, so it is neither adopted as a project nor reported as
// a legacy project root.
function globalHomes(boundaries: readonly string[]): readonly string[] {
  return boundaries.map((home) => path.join(home, LEGACY_STATE_DIRECTORY));
}

function notInitialized(reason: string): BurnGraphError {
  return new BurnGraphError(
    "NOT_INITIALIZED",
    `${reason} Run \`burn-graph init\` to create ${STATE_DIRECTORY}/ here.`,
  );
}

function legacyStateRoot(): BurnGraphError {
  return new BurnGraphError(
    "LEGACY_STATE_ROOT",
    `Found legacy project state in ${LEGACY_STATE_DIRECTORY}/ but no ` +
      `${STATE_DIRECTORY}/; burn-graph does not migrate it silently and never ` +
      `reads or writes through the legacy root. Run \`burn-graph init\`, then ` +
      `re-register each specification from ${LEGACY_STATE_DIRECTORY}/graphs and ` +
      `${LEGACY_STATE_DIRECTORY}/checks with \`graph apply\` and \`check apply\`. ` +
      `Run history in ${LEGACY_STATE_DIRECTORY}/runtime does not carry over; ` +
      `delete ${LEGACY_STATE_DIRECTORY}/ once you no longer need it.`,
    false,
    { legacyStateRoot: LEGACY_STATE_DIRECTORY, stateRoot: STATE_DIRECTORY },
  );
}

export function hasLegacyStateRoot(root: string): boolean {
  const boundaries = homeBoundaries();
  const legacy = path.join(path.resolve(root), LEGACY_STATE_DIRECTORY);
  if (globalHomes(boundaries).includes(legacy)) return false;
  return isDirectory(legacy);
}

export function safeChmod(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch {
    // Filesystems without POSIX permissions still keep the local-only boundary.
    // Shared with the render cache: two copies of this fallback is how one gets
    // corrected and the other does not.
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

// Returns an open descriptor for an existing regular .gitignore, or null when
// this call created the file with the entry already in it. The create/open race
// is retried a bounded number of times so a hostile churn cannot spin here.
function openIgnoreFile(ignoreFile: string): number | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return openSync(
        ignoreFile,
        constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EISDIR" || code === "EFTYPE") {
        throw unsafeIgnoreFile();
      }
      if (code !== "ENOENT") throw error;
    }
    try {
      // No-clobber: whoever wins this race owns the file, and the next attempt
      // extends its bytes rather than replacing them.
      writeFileSync(ignoreFile, `${RUNTIME_IGNORE_ENTRY}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new BurnGraphError(
    "UNSAFE_PROJECT_FILE",
    "The project .gitignore kept being replaced while burn-graph extended it; " +
      `add ${RUNTIME_IGNORE_ENTRY} to it yourself, then run \`burn-graph init\` again.`,
  );
}

// Only the ephemeral runtime is ignored: GraphSpecs and CheckSpecs are tracked
// project facts, so a blanket `.burn/` entry would delete them from history.
// The entry is written no-follow through one descriptor, because the project
// `.gitignore` is a user file this CLI may extend but never rewrite (P004).
function ensureRuntimeIgnored(root: string): void {
  const ignoreFile = path.join(root, ".gitignore");
  const descriptor = openIgnoreFile(ignoreFile);
  // A concurrent writer created the file and already owns its bytes; the
  // no-clobber create in openIgnoreFile published the entry in that case.
  if (descriptor === null) return;
  try {
    if (!fstatSync(descriptor).isFile()) throw unsafeIgnoreFile();
    const existing = readFileSync(descriptor);
    // latin1 maps bytes to code points one-to-one, so a non-UTF-8 line can
    // neither hide nor forge the ASCII entry this check looks for.
    const alreadyIgnored = existing
      .toString("latin1")
      .split("\n")
      .some((line) => line.trim() === RUNTIME_IGNORE_ENTRY);
    if (alreadyIgnored) return;
    const separator =
      existing.length === 0 || existing[existing.length - 1] === 0x0a ? "" : "\n";
    writeSync(descriptor, `${separator}${RUNTIME_IGNORE_ENTRY}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function unsafeIgnoreFile(): BurnGraphError {
  return new BurnGraphError(
    "UNSAFE_PROJECT_FILE",
    "The project .gitignore is a symlink or not a regular file; burn-graph " +
      `will not write through it. Add ${RUNTIME_IGNORE_ENTRY} to it yourself, ` +
      "then run `burn-graph init` again.",
  );
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
  // A refused user file must stop init before any state exists, so a failed run
  // leaves nothing half-initialized behind (P006).
  ensureRuntimeIgnored(root);
  mkdirSync(path.join(stateRoot, "graphs"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(stateRoot, "checks"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(stateRoot, "prompts"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(stateRoot, "runtime", "artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  mkdirSync(path.join(stateRoot, "runtime", "renders"), {
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
    maxHierarchyDepth: 8,
    maxUnfinishedDescendants: 256,
  };
  writeFileSync(path.join(stateRoot, ".gitignore"), "runtime/\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // config.json is what discovery keys on, so it is published last: a project
  // is only discoverable once every directory it needs already exists (P006).
  atomicWriteJson(configFile, config);
  return config;
}

export function discoverProjectRoot(startInput: string): string {
  const start = path.resolve(startInput);
  const boundaries = homeBoundaries();
  const skipped = globalHomes(boundaries);
  const startedInsideHome = boundaries.some(
    (home) => start === home || start.startsWith(`${home}${path.sep}`),
  );
  let current = start;
  for (;;) {
    if (!skipped.includes(current)) {
      if (isDirectory(path.join(current, PROJECT_ROOT_DIRECTORY))) {
        if (existsSync(path.join(current, STATE_DIRECTORY, "config.json"))) {
          return current;
        }
        throw notInitialized(
          `A ${PROJECT_ROOT_DIRECTORY}/ project root exists without ` +
            `${STATE_DIRECTORY}/config.json.`,
        );
      }
      const legacy = path.join(current, LEGACY_STATE_DIRECTORY);
      if (!skipped.includes(legacy) && isDirectory(legacy)) {
        throw legacyStateRoot();
      }
    }
    if (startedInsideHome && boundaries.includes(current)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw notInitialized(
    `No ${STATE_DIRECTORY}/config.json in this directory or any parent up to $HOME.`,
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
        parsed.maxAssignmentsPerActor > 32)) ||
    (parsed.maxHierarchyDepth !== undefined &&
      (typeof parsed.maxHierarchyDepth !== "number" ||
        !Number.isInteger(parsed.maxHierarchyDepth) ||
        parsed.maxHierarchyDepth < 1 ||
        parsed.maxHierarchyDepth > 8)) ||
    (parsed.maxUnfinishedDescendants !== undefined &&
      (typeof parsed.maxUnfinishedDescendants !== "number" ||
        !Number.isInteger(parsed.maxUnfinishedDescendants) ||
        parsed.maxUnfinishedDescendants < 1 ||
        parsed.maxUnfinishedDescendants > 256))
  ) {
    throw new BurnGraphError("INVALID_CONFIG", `Invalid config at ${file}`);
  }
  return {
    schemaVersion: 1,
    projectId: parsed.projectId,
    createdAt: parsed.createdAt,
    defaultLeaseSeconds: parsed.defaultLeaseSeconds,
    maxAssignmentsPerActor: parsed.maxAssignmentsPerActor ?? 8,
    maxHierarchyDepth: parsed.maxHierarchyDepth ?? 8,
    maxUnfinishedDescendants: parsed.maxUnfinishedDescendants ?? 256,
  };
}

export function graphFile(root: string, graphId: string): string {
  return path.join(root, STATE_DIRECTORY, "graphs", `${graphId}.json`);
}

export function writeGraphSpec(root: string, spec: GraphSpec): void {
  atomicWriteJson(graphFile(root, spec.id), spec);
}

export function checkFile(root: string, checkId: string): string {
  return path.join(root, STATE_DIRECTORY, "checks", `${checkId}.json`);
}

export function writeCheckSpec(root: string, spec: CheckSpec): void {
  atomicWriteJson(checkFile(root, spec.id), spec);
}

export function runtimeDatabaseFile(root: string): string {
  return path.join(root, STATE_DIRECTORY, "runtime", "state.sqlite");
}
