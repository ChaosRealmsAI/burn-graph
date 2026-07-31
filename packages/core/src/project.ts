import {
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  BurnGraphError,
  type CheckSpec,
  type GraphSpec,
  type ProjectConfig,
} from "./contracts.ts";
import {
  PROJECT_ROOT_DIRECTORY,
  STATE_DIRECTORY,
  assertProjectStateBoundary,
  assertProjectStateEntryKind,
  assertProjectStatePath,
  atomicWriteJson,
  inspectProjectFile,
  inspectProjectStatePath,
  publishProjectFile,
  readProjectFile,
  type ProjectFileAdmission,
  type ProjectFileSnapshot,
} from "./state-boundary.ts";

export {
  PROJECT_ROOT_DIRECTORY,
  STATE_DIRECTORY,
  assertProjectStateBoundary,
  assertProjectStatePath,
  assertProjectFileDescriptorGeneration,
  atomicWriteJson,
  detachProjectFile,
  ensureProjectFile,
  inspectProjectFile,
  publishProjectFile,
  readProjectFile,
} from "./state-boundary.ts";
export type {
  ProjectFileAdmission,
  ProjectFilePublishContext,
  ProjectFilePublishOptions,
  ProjectFileSnapshot,
  StateEntryKind,
  StateGeneration,
  StateGenerationKind,
  StatePathInfo,
} from "./state-boundary.ts";

// Every Burn product keeps project state under one shared `.burn/` root, so a
// directory holding `.burn/` is the project root even when this product has not
// been initialized inside it yet.
// The pre-3.0 project root. State is never read, written, or migrated through
// it; it survives only to make the stable judgment and its remediation legible.
export const LEGACY_STATE_DIRECTORY = ".burn-graph";
const RUNTIME_IGNORE_ENTRY = ".burn/graph/runtime/";
const STATE_ROOT_ERROR_CODE = "UNSAFE_STATE_ROOT";

function unsafeProjectRoot(): BurnGraphError {
  return new BurnGraphError(
    STATE_ROOT_ERROR_CODE,
    "The selected project root is $HOME, a user boundary; choose a project " +
      "directory below $HOME and retry.",
    false,
    {
      statePath: "$HOME",
      recovery: "Choose a project directory below $HOME and retry.",
    },
  );
}

function unsafeSelectedProjectRoot(reason: string): BurnGraphError {
  return new BurnGraphError(
    STATE_ROOT_ERROR_CODE,
    `The selected project root ${reason}; choose a real project directory ` +
      "and retry.",
    false,
    {
      statePath: "project root",
      expected: "a real project directory",
      recovery: "Choose a real project directory path, then retry.",
    },
  );
}

function pathRealpath(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function resolvedRealpath(candidate: string): string | null {
  let current = path.resolve(candidate);
  const missing: string[] = [];
  for (;;) {
    const real = pathRealpath(current);
    if (real !== null) {
      return path.join(real, ...missing.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    missing.push(path.basename(current));
    current = parent;
  }
}

function isWithin(candidate: string, boundary: string): boolean {
  return candidate === boundary || candidate.startsWith(`${boundary}${path.sep}`);
}

function isHomeBoundary(candidate: string, boundaries: readonly string[]): boolean {
  const resolved = path.resolve(candidate);
  const real = resolvedRealpath(resolved);
  return boundaries.some(
    (boundary) => resolved === boundary || (real !== null && real === boundary),
  );
}

function isInsideHome(candidate: string, boundaries: readonly string[]): boolean {
  const resolved = path.resolve(candidate);
  const real = resolvedRealpath(resolved);
  return boundaries.some(
    (boundary) =>
      isWithin(resolved, boundary) || (real !== null && isWithin(real, boundary)),
  );
}

function assertProjectRootAllowed(
  root: string,
  boundaries: readonly string[],
): void {
  if (isHomeBoundary(root, boundaries)) throw unsafeProjectRoot();
}

function assertProjectRootPath(
  root: string,
  boundaries: readonly string[],
): void {
  const resolved = resolvedRealpath(root);
  // Projects outside $HOME retain existing platform aliases such as macOS
  // `/var` -> `/private/var`; roots entered through the user boundary do not.
  // Otherwise a missing project below a symlinked HOME child could redirect
  // the first `.gitignore` or state-root mutation outside the selected tree.
  const selectedPathIsInsideHome = isInsideHome(root, boundaries);
  if (selectedPathIsInsideHome && resolved !== null && resolved !== root) {
    throw unsafeSelectedProjectRoot("uses a symlink path component");
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw unsafeSelectedProjectRoot("cannot be inspected safely");
  }
  if (stat.isSymbolicLink()) {
    throw unsafeSelectedProjectRoot("is a symlink");
  }
  if (!stat.isDirectory()) {
    throw unsafeSelectedProjectRoot("is not a directory");
  }
}

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
  const resolved = path.resolve(root);
  if (isHomeBoundary(resolved, boundaries)) return false;
  const legacy = path.join(resolved, LEGACY_STATE_DIRECTORY);
  if (globalHomes(boundaries).includes(legacy)) return false;
  return isDirectory(legacy);
}

// Only the ephemeral runtime is ignored: GraphSpecs and CheckSpecs are tracked
// project facts, so a blanket `.burn/` entry would delete them from history.
// The existing user file is read no-follow, then replaced by a same-directory
// inode bound to the read generation. This preserves unrelated bytes and mode
// while keeping a hardlinked outside peer untouched (P004).
function ensureRuntimeIgnored(root: string): void {
  const ignoreFile = path.join(root, ".gitignore");
  let admission: ProjectFileAdmission;
  try {
    admission = inspectProjectFile(ignoreFile, root);
  } catch {
    throw unsafeIgnoreFile();
  }
  if (admission.targetGeneration === null) {
    publishProjectFile(
      ignoreFile,
      RUNTIME_IGNORE_ENTRY + "\n",
      root,
      { expectedAdmission: admission },
    );
    return;
  }

  let snapshot: ProjectFileSnapshot;
  try {
    snapshot = readProjectFile(ignoreFile, root);
  } catch {
    throw unsafeIgnoreFile();
  }
  // latin1 maps bytes to code points one-to-one, so a non-UTF-8 line can
  // neither hide nor forge the ASCII entry this check looks for.
  const existing = Buffer.from(snapshot.bytes);
  const alreadyIgnored = existing
    .toString("latin1")
    .split("\n")
    .some((line) => line.trim() === RUNTIME_IGNORE_ENTRY);
  if (alreadyIgnored) return;
  const separator =
    existing.length === 0 || existing[existing.length - 1] === 0x0a ? "" : "\n";
  const suffix = new TextEncoder().encode(
    separator + RUNTIME_IGNORE_ENTRY + "\n",
  );
  const updated = new Uint8Array(existing.length + suffix.length);
  updated.set(existing, 0);
  updated.set(suffix, existing.length);
  publishProjectFile(ignoreFile, updated, root, {
    expectedAdmission: snapshot,
    mode: snapshot.mode,
  });
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
  const boundaries = homeBoundaries();
  assertProjectRootAllowed(root, boundaries);
  assertProjectRootPath(root, boundaries);
  // Validate pre-existing product state before touching the user-owned
  // .gitignore. This is the migration boundary: no malformed .burn/graph
  // component may turn init into a write through an outside symlink (P004/P013).
  assertProjectStateBoundary(root);
  const stateRoot = path.join(root, STATE_DIRECTORY);
  const configInfo = inspectProjectStatePath(
    root,
    path.join(STATE_DIRECTORY, "config.json"),
  );
  if (configInfo.stat !== null) {
    throw new BurnGraphError(
      "ALREADY_INITIALIZED",
      `burn-graph is already initialized at ${root}`,
    );
  }
  // A refused user file must stop init before any state exists, so a failed run
  // leaves nothing half-initialized behind (P006).
  ensureRuntimeIgnored(root);
  const createStateDirectory = (relative: string): void => {
    assertProjectStatePath(root, relative, "directory", true);
    mkdirSync(path.join(root, relative), { recursive: true, mode: 0o700 });
    assertProjectStatePath(root, relative, "directory", false);
  };
  createStateDirectory(PROJECT_ROOT_DIRECTORY);
  createStateDirectory(STATE_DIRECTORY);
  createStateDirectory(path.join(STATE_DIRECTORY, "graphs"));
  createStateDirectory(path.join(STATE_DIRECTORY, "checks"));
  createStateDirectory(path.join(STATE_DIRECTORY, "prompts"));
  createStateDirectory(path.join(STATE_DIRECTORY, "runtime"));
  createStateDirectory(path.join(STATE_DIRECTORY, "runtime", "artifacts"));
  createStateDirectory(path.join(STATE_DIRECTORY, "runtime", "renders"));
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
  publishProjectFile(path.join(stateRoot, ".gitignore"), "runtime/\n", root);
  // config.json is what discovery keys on, so it is published last: a project
  // is only discoverable once every directory it needs already exists (P006).
  atomicWriteJson(path.join(stateRoot, "config.json"), config, root);
  return config;
}

export function discoverProjectRoot(startInput: string): string {
  const start = path.resolve(startInput);
  const boundaries = homeBoundaries();
  const skipped = globalHomes(boundaries);
  const startedInsideHome = isInsideHome(start, boundaries);
  let current = start;
  for (;;) {
    // Check the boundary before inspecting it. A project at $HOME or through a
    // symlink alias of $HOME is never a discoverable project root.
    if (startedInsideHome && isHomeBoundary(current, boundaries)) break;
    if (!skipped.includes(current)) {
      const burn = inspectProjectStatePath(
        current,
        PROJECT_ROOT_DIRECTORY,
        true,
      );
      if (burn.stat !== null) {
        assertProjectRootPath(current, boundaries);
        assertProjectStateEntryKind(burn, "directory");
        const graph = inspectProjectStatePath(current, STATE_DIRECTORY);
        if (graph.stat !== null) {
          assertProjectStateEntryKind(graph, "directory");
          const config = inspectProjectStatePath(
            current,
            path.join(STATE_DIRECTORY, "config.json"),
          );
          if (config.stat !== null) {
            assertProjectStateEntryKind(config, "file");
            assertProjectStateBoundary(current);
            return current;
          }
          throw notInitialized(
            `A ${PROJECT_ROOT_DIRECTORY}/ project root exists without ` +
              `${STATE_DIRECTORY}/config.json.`,
          );
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
    if (startedInsideHome && isHomeBoundary(current, boundaries)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw notInitialized(
    `No ${STATE_DIRECTORY}/config.json in this directory or any parent up to $HOME.`,
  );
}

export function readProjectConfig(root: string): ProjectConfig {
  const admission = inspectProjectFile(
    path.join(root, STATE_DIRECTORY, "config.json"),
    root,
  );
  const file = admission.target;
  if (admission.targetGeneration === null) {
    throw notInitialized(
      `Project state is missing ${STATE_DIRECTORY}/config.json.`,
    );
  }
  const snapshot = readProjectFile(file, root);
  const raw = Buffer.from(snapshot.bytes).toString("utf8");
  const parsed = JSON.parse(raw) as Partial<ProjectConfig>;
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
  return assertProjectStatePath(
    root,
    path.join(STATE_DIRECTORY, "graphs", `${graphId}.json`),
    "file",
    true,
  );
}

export function writeGraphSpec(root: string, spec: GraphSpec): void {
  atomicWriteJson(graphFile(root, spec.id), spec, root);
}

export function checkFile(root: string, checkId: string): string {
  return assertProjectStatePath(
    root,
    path.join(STATE_DIRECTORY, "checks", `${checkId}.json`),
    "file",
    true,
  );
}

export function writeCheckSpec(root: string, spec: CheckSpec): void {
  atomicWriteJson(checkFile(root, spec.id), spec, root);
}

export function runtimeDatabaseFile(root: string): string {
  return assertProjectStatePath(
    root,
    path.join(STATE_DIRECTORY, "runtime", "state.sqlite"),
    "file",
    true,
  );
}
