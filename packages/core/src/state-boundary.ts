import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

import { BurnGraphError } from "./contracts.ts";

// Every Burn product keeps project state under one shared `.burn/` root. This
// module owns the no-follow and generation rules for that shared boundary.
export const PROJECT_ROOT_DIRECTORY = ".burn";
export const STATE_DIRECTORY = ".burn/graph";
const STATE_ROOT_ERROR_CODE = "UNSAFE_STATE_ROOT";

export type StateEntryKind = "directory" | "file";

export type StateGenerationKind = StateEntryKind | "other";

export interface StateGeneration {
  readonly relative: string;
  readonly kind: StateGenerationKind;
  readonly dev: string;
  readonly ino: string;
}

export interface StatePathInfo {
  readonly target: string;
  readonly relative: string;
  readonly stat: BigIntStats | null;
  readonly components: readonly StateGeneration[];
}

function statePathLabel(relative: string): string {
  return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

function unsafeStatePath(
  relative: string,
  expected: string,
  reason = "is a symlink or has the wrong type",
): BurnGraphError {
  const label = statePathLabel(relative);
  return new BurnGraphError(
    STATE_ROOT_ERROR_CODE,
    `Project-owned state path ${label} ${reason}; replace it with a real ` +
      `${expected} inside the project, then retry.`,
    false,
    {
      statePath: label,
      expected,
      recovery:
        `Replace ${label} with a real ${expected} inside the project, then retry.`,
    },
  );
}

function stateGeneration(
  relative: string,
  stat: BigIntStats,
): StateGeneration {
  return {
    relative,
    kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
}

export function sameStateGeneration(
  expected: StateGeneration,
  actual: StateGeneration,
): boolean {
  return (
    expected.relative === actual.relative &&
    expected.kind === actual.kind &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  );
}

/**
 * Inspect one state path without following any existing component below the
 * selected project root. The discovery walk may inspect a symlinked candidate
 * only to learn that it has no `.burn`; all state consumers use the default
 * no-follow behavior and reject it before admission.
 */
export function inspectProjectStatePath(
  rootInput: string,
  relativeInput: string,
  allowSymlinkRootForDiscovery = false,
): StatePathInfo {
  const root = path.resolve(rootInput);
  const target = path.resolve(root, relativeInput);
  const relative = path.relative(root, target);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw unsafeStatePath(
      statePathLabel(relativeInput),
      "a project-confined path",
      "escapes the selected project",
    );
  }

  let rootStat: BigIntStats;
  try {
    rootStat = lstatSync(root, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { target, relative, stat: null, components: [] };
    }
    throw unsafeStatePath(
      ".",
      "an accessible project directory",
      "cannot be inspected safely",
    );
  }
  if (rootStat.isSymbolicLink() && !allowSymlinkRootForDiscovery) {
    throw unsafeStatePath(".", "a real project directory");
  }
  if (!rootStat.isSymbolicLink() && !rootStat.isDirectory()) {
    throw unsafeStatePath(".", "a directory", "is not a directory");
  }

  const segments = relative.split(path.sep);
  let current = root;
  const components: StateGeneration[] = rootStat.isSymbolicLink()
    ? []
    : [stateGeneration("", rootStat)];
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    let stat: BigIntStats;
    try {
      stat = lstatSync(current, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { target, relative, stat: null, components };
      }
      throw unsafeStatePath(
        path.relative(root, current),
        "an accessible state entry",
        "cannot be inspected safely",
      );
    }
    if (stat.isSymbolicLink()) {
      throw unsafeStatePath(
        path.relative(root, current),
        index === segments.length - 1 ? "state entry" : "directory",
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw unsafeStatePath(
        path.relative(root, current),
        "directory",
        "is not a directory",
      );
    }
    components.push(stateGeneration(path.relative(root, current), stat));
    if (index === segments.length - 1) {
      return { target, relative, stat, components };
    }
  }
  throw unsafeStatePath(relative, "state entry", "cannot be inspected safely");
}

export function assertProjectStateEntryKind(
  info: StatePathInfo,
  kind: StateEntryKind,
): void {
  if (!info.stat) return;
  const matches = kind === "directory" ? info.stat.isDirectory() : info.stat.isFile();
  if (!matches) {
    throw unsafeStatePath(
      info.relative,
      kind,
      kind === "directory" ? "is not a directory" : "is not a regular file",
    );
  }
}

/**
 * Validate one state path without following any existing component below the
 * selected project root. Missing final components are allowed when a caller is
 * about to create them; callers must validate again after creating parents.
 */
export function assertProjectStatePath(
  root: string,
  relative: string,
  kind: StateEntryKind,
  allowMissing = true,
): string {
  const info = inspectProjectStatePath(root, relative);
  if (info.stat === null) {
    if (allowMissing) return info.target;
    throw unsafeStatePath(info.relative, kind, "is missing");
  }
  assertProjectStateEntryKind(info, kind);
  return info.target;
}

/**
 * Validate the fixed owner directories below the shared `.burn/graph` root.
 * Descendants are checked by the consumer that owns the exact path; this is
 * deliberately bounded and never walks graph, check, or runtime history.
 */
export function assertProjectStateBoundary(root: string): void {
  const burn = inspectProjectStatePath(root, PROJECT_ROOT_DIRECTORY);
  if (burn.stat === null) return;
  assertProjectStateEntryKind(burn, "directory");

  const graph = inspectProjectStatePath(root, STATE_DIRECTORY);
  if (graph.stat === null) return;
  assertProjectStateEntryKind(graph, "directory");

  for (const relative of [
    path.join(STATE_DIRECTORY, "config.json"),
    path.join(STATE_DIRECTORY, ".gitignore"),
  ]) {
    const info = inspectProjectStatePath(root, relative);
    if (info.stat !== null) assertProjectStateEntryKind(info, "file");
  }
  for (const relative of [
    path.join(STATE_DIRECTORY, "graphs"),
    path.join(STATE_DIRECTORY, "checks"),
    path.join(STATE_DIRECTORY, "prompts"),
    path.join(STATE_DIRECTORY, "runtime"),
    path.join(STATE_DIRECTORY, "runtime", "artifacts"),
    path.join(STATE_DIRECTORY, "runtime", "renders"),
    path.join(STATE_DIRECTORY, "runtime", "viewers"),
    path.join(STATE_DIRECTORY, "runtime", "template-transactions"),
  ]) {
    const info = inspectProjectStatePath(root, relative);
    if (info.stat !== null) assertProjectStateEntryKind(info, "directory");
  }
}

export interface ProjectFileAdmission {
  readonly root: string;
  readonly target: string;
  readonly relative: string;
  readonly components: readonly StateGeneration[];
  readonly targetGeneration: StateGeneration | null;
  readonly mode: number | null;
  readonly linkCount: bigint | null;
}

export interface ProjectFileSnapshot {
  readonly root: string;
  readonly target: string;
  readonly relative: string;
  readonly components: readonly StateGeneration[];
  readonly targetGeneration: StateGeneration;
  readonly mode: number;
  readonly linkCount: bigint;
  readonly bytes: Uint8Array;
}

type ProjectFilePreflight = ProjectFileAdmission;

export interface ProjectFilePublishContext {
  readonly root: string;
  readonly target: string;
  readonly temporary: string;
}

export interface ProjectFilePublishOptions {
  /** Test-only synchronization point for deterministic replacement races. */
  readonly beforePublish?: (context: ProjectFilePublishContext) => void;
  /** Test-only synchronization point after the last generation check. */
  readonly afterGenerationCheck?: (context: ProjectFilePublishContext) => void;
  /** Test-only synchronization point after publication and before observation. */
  readonly afterPublish?: (context: ProjectFilePublishContext) => void;
  /** Admission captured while reading an existing file or observing absence. */
  readonly expectedAdmission?: ProjectFileAdmission;
  /** Mode for the newly-created publication inode. */
  readonly mode?: number;
}

function publishRoot(target: string, boundaryRoot?: string): string {
  return path.resolve(
    boundaryRoot ?? path.parse(path.resolve(target)).root,
  );
}

function captureProjectFile(
  targetInput: string,
  boundaryRoot?: string,
): ProjectFilePreflight {
  const target = path.resolve(targetInput);
  const root = publishRoot(target, boundaryRoot);
  const relative = path.relative(root, target);
  const info = inspectProjectStatePath(root, relative);
  if (info.stat !== null) assertProjectStateEntryKind(info, "file");
  return {
    root,
    target,
    relative,
    components: info.components,
    targetGeneration:
      info.stat === null
        ? null
        : info.components[info.components.length - 1] ?? null,
    mode: info.stat === null ? null : Number(info.stat.mode & 0o7777n),
    linkCount: info.stat === null ? null : info.stat.nlink,
  };
}

export function inspectProjectFile(
  target: string,
  boundaryRoot?: string,
): ProjectFileAdmission {
  return captureProjectFile(target, boundaryRoot);
}

export function readProjectFile(
  target: string,
  boundaryRoot?: string,
): ProjectFileSnapshot {
  const accepted = captureProjectFile(target, boundaryRoot);
  if (
    accepted.targetGeneration === null ||
    accepted.mode === null ||
    accepted.linkCount === null
  ) {
    throw unsafeProjectFileGeneration(accepted.relative, "is missing");
  }

  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW binds the final file to the descriptor, while the parent
    // check-to-open and post-read path checks remain userspace observations;
    // Node does not provide a portable dirfd-relative atomic walk here.
    descriptor = openSync(
      accepted.target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const descriptorGeneration = stateGeneration(
      accepted.relative,
      fstatSync(descriptor, { bigint: true }),
    );
    if (!sameStateGeneration(accepted.targetGeneration, descriptorGeneration)) {
      throw unsafeProjectFileGeneration(
        accepted.relative,
        "changed before it could be read",
      );
    }
    const bytes = readFileSync(descriptor);
    const current = captureProjectFile(accepted.target, accepted.root);
    assertPublishGeneration(accepted, current);
    return {
      root: accepted.root,
      target: accepted.target,
      relative: accepted.relative,
      components: accepted.components,
      targetGeneration: accepted.targetGeneration,
      mode: accepted.mode,
      linkCount: accepted.linkCount,
      bytes,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw unsafeProjectFileGeneration(
        accepted.relative,
        "disappeared while it was being read",
      );
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameGeneration(
  expected: StateGeneration,
  actual: StateGeneration,
): boolean {
  return sameStateGeneration(expected, actual);
}

function sameInodeGeneration(
  expected: StateGeneration,
  actual: StateGeneration,
): boolean {
  return (
    expected.kind === actual.kind &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  );
}

function sameGenerationSequence(
  expected: readonly StateGeneration[],
  actual: readonly StateGeneration[],
): boolean {
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (!sameGeneration(expected[index]!, actual[index]!)) return false;
  }
  return true;
}

function assertExpectedAdmission(
  expected: ProjectFileAdmission,
  actual: ProjectFilePreflight,
): void {
  const targetMatches =
    expected.targetGeneration === null
      ? actual.targetGeneration === null
      : actual.targetGeneration !== null &&
        sameStateGeneration(expected.targetGeneration, actual.targetGeneration);
  if (
    expected.root !== actual.root ||
    expected.target !== actual.target ||
    expected.relative !== actual.relative ||
    !sameGenerationSequence(expected.components, actual.components) ||
    !targetMatches
  ) {
    throw unsafeProjectFileGeneration(
      actual.relative,
      "changed since it was admitted",
    );
  }
}

function createTemporaryFile(
  target: string,
  value: Uint8Array | string,
  mode: number,
): void {
  const descriptor = openSync(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode & 0o7777,
  );
  try {
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : value;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
      );
      if (written <= 0) throw new Error("Temporary project file write stalled");
      offset += written;
    }
    // Bind the permission adjustment to the inode we just opened. This is
    // required for preserving an existing file mode without a path chmod.
    fchmodSync(descriptor, mode & 0o7777);
  } finally {
    closeSync(descriptor);
  }
}

export function assertProjectFileDescriptorGeneration(
  target: string,
  descriptor: number,
  boundaryRoot?: string,
): void {
  const current = captureProjectFile(target, boundaryRoot);
  if (current.targetGeneration === null) {
    throw unsafeProjectFileGeneration(
      current.relative,
      "disappeared before its descriptor was handed to a child",
    );
  }
  const descriptorGeneration = stateGeneration(
    current.relative,
    fstatSync(descriptor, { bigint: true }),
  );
  if (!sameStateGeneration(current.targetGeneration, descriptorGeneration)) {
    throw unsafeProjectFileGeneration(
      current.relative,
      "no longer matches the descriptor handed to a child",
    );
  }
}

function unsafeProjectFileGeneration(
  relative: string,
  reason: string,
): BurnGraphError {
  const label = statePathLabel(relative);
  return new BurnGraphError(
    STATE_ROOT_ERROR_CODE,
    `Project-owned state path ${label} ${reason}; operation stopped. ` +
      "Unable to confirm the current pathname safely; check the target before retrying.",
    false,
    {
      statePath: label,
      expected: "a regular file with the accepted path generation",
      recovery: `Check ${label} is a real project-local file before retrying.`,
    },
  );
}

export function detachProjectFile(
  target: string,
  boundaryRoot?: string,
): boolean {
  const admission = captureProjectFile(target, boundaryRoot);
  if (
    admission.targetGeneration === null ||
    admission.linkCount === null ||
    admission.linkCount <= 1n
  ) {
    return false;
  }
  const snapshot = readProjectFile(admission.target, admission.root);
  publishProjectFile(snapshot.target, snapshot.bytes, snapshot.root, {
    expectedAdmission: snapshot,
    mode: snapshot.mode,
  });
  return true;
}

interface TemporaryFileIdentity {
  readonly path: string;
  readonly root: string;
  readonly parentComponents: readonly StateGeneration[];
  readonly generation: StateGeneration;
}

function temporaryFileIdentity(
  accepted: ProjectFilePreflight,
  temporary: ProjectFilePreflight,
): TemporaryFileIdentity {
  const generation = temporary.targetGeneration;
  if (generation === null) {
    throw unsafeProjectFileGeneration(
      temporary.relative,
      "temporary output disappeared",
    );
  }
  return {
    path: temporary.target,
    root: temporary.root,
    parentComponents:
      accepted.targetGeneration === null
        ? accepted.components
        : accepted.components.slice(0, -1),
    generation,
  };
}

function temporaryFileStillBound(
  expected: TemporaryFileIdentity,
  current: ProjectFilePreflight,
): boolean {
  if (current.targetGeneration === null) return false;
  return (
    sameGenerationSequence(
      expected.parentComponents,
      current.components.slice(0, -1),
    ) && sameGeneration(expected.generation, current.targetGeneration)
  );
}

function assertPublishedGeneration(
  expected: TemporaryFileIdentity,
  current: ProjectFilePreflight,
): void {
  if (
    current.targetGeneration === null ||
    !sameGenerationSequence(
      expected.parentComponents,
      current.components.slice(0, -1),
    ) ||
    !sameInodeGeneration(expected.generation, current.targetGeneration)
  ) {
    throw unsafeProjectFileGeneration(
      current.relative,
      "no longer names the inode that was just published",
    );
  }
}

function cleanupTemporary(expected: TemporaryFileIdentity): void {
  let current: ProjectFilePreflight;
  try {
    current = captureProjectFile(expected.path, expected.root);
  } catch {
    // A replaced or unreadable parent is not evidence that this pathname is
    // still ours. Leak the detached temporary rather than deleting a namesake.
    return;
  }
  if (!temporaryFileStillBound(expected, current)) return;
  try {
    unlinkSync(expected.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertPublishGeneration(
  accepted: ProjectFilePreflight,
  current: ProjectFilePreflight,
): void {
  const acceptedComponents = accepted.components;
  const currentComponents = current.components;
  const componentCount = Math.min(
    acceptedComponents.length,
    currentComponents.length,
  );
  for (let index = 0; index < componentCount; index += 1) {
    if (!sameGeneration(acceptedComponents[index]!, currentComponents[index]!)) {
      throw unsafeProjectFileGeneration(
        accepted.relative,
        `component ${acceptedComponents[index]!.relative} changed`,
      );
    }
  }
  if (currentComponents.length !== acceptedComponents.length) {
    throw unsafeProjectFileGeneration(
      accepted.relative,
      accepted.targetGeneration === null
        ? "was created by another writer"
        : "lost an accepted path component",
    );
  }
  if (accepted.targetGeneration === null) {
    if (current.targetGeneration !== null) {
      throw unsafeProjectFileGeneration(
        accepted.relative,
        "was created by another writer",
      );
    }
    return;
  }
  if (
    current.targetGeneration === null ||
    !sameGeneration(accepted.targetGeneration, current.targetGeneration)
  ) {
    throw unsafeProjectFileGeneration(
      accepted.relative,
      "was replaced by another writer",
    );
  }
}

function assertAdmissionGeneration(
  accepted: ProjectFilePreflight,
  current: ProjectFilePreflight,
): void {
  const acceptedComponents = accepted.components;
  const currentComponents = current.components;
  const componentCount = Math.min(
    acceptedComponents.length,
    currentComponents.length,
  );
  for (let index = 0; index < componentCount; index += 1) {
    if (!sameGeneration(acceptedComponents[index]!, currentComponents[index]!)) {
      throw unsafeProjectFileGeneration(
        accepted.relative,
        `component ${acceptedComponents[index]!.relative} changed during admission`,
      );
    }
  }
  if (currentComponents.length < acceptedComponents.length) {
    throw unsafeProjectFileGeneration(
      accepted.relative,
      "lost an accepted path component during admission",
    );
  }
  if (accepted.targetGeneration === null) {
    if (current.targetGeneration !== null) {
      throw unsafeProjectFileGeneration(
        accepted.relative,
        "was created by another writer during admission",
      );
    }
    return;
  }
  if (
    current.targetGeneration === null ||
    !sameGeneration(accepted.targetGeneration, current.targetGeneration)
  ) {
    throw unsafeProjectFileGeneration(
      accepted.relative,
      "was replaced during admission",
    );
  }
}

function assertAcceptedParentGeneration(
  accepted: ProjectFilePreflight,
  current: ProjectFilePreflight,
): void {
  if (
    !sameGenerationSequence(accepted.components, current.components.slice(0, -1))
  ) {
    throw unsafeProjectFileGeneration(
      accepted.relative,
      "project root or parent component changed",
    );
  }
}

/**
 * Create a missing project file with a same-directory 0600 inode without
 * replacing a concurrent creator. Existing files are left untouched; callers
 * must use a separate descriptor or database policy when they need to change
 * an existing file's permissions.
 */
export function ensureProjectFile(
  target: string,
  boundaryRoot?: string,
  options: ProjectFilePublishOptions = {},
): void {
  const resolvedTarget = path.resolve(target);
  const root = publishRoot(resolvedTarget, boundaryRoot);
  const initial = captureProjectFile(resolvedTarget, root);
  if (initial.targetGeneration !== null) return;

  const accepted = captureProjectFile(resolvedTarget, root);
  assertAdmissionGeneration(initial, accepted);
  if (accepted.targetGeneration !== null) return;

  const temporary = `${resolvedTarget}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let primaryFailure = false;
  let temporaryIdentity: TemporaryFileIdentity | null = null;
  try {
    createTemporaryFile(temporary, new Uint8Array(), 0o600);
    temporaryIdentity = temporaryFileIdentity(
      accepted,
      captureProjectFile(temporary, root),
    );
    const current = captureProjectFile(resolvedTarget, root);
    if (current.targetGeneration !== null) {
      assertAcceptedParentGeneration(accepted, current);
      return;
    }
    assertPublishGeneration(accepted, current);
    try {
      linkSync(temporary, resolvedTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = captureProjectFile(resolvedTarget, root);
      assertAcceptedParentGeneration(accepted, raced);
      return;
    }
    options.afterPublish?.({
      root,
      target: resolvedTarget,
      temporary,
    });
    assertPublishedGeneration(
      temporaryIdentity,
      captureProjectFile(resolvedTarget, root),
    );
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    if (temporaryIdentity !== null) {
      try {
        cleanupTemporary(temporaryIdentity);
      } catch (error) {
        if (!primaryFailure) throw error;
      }
    }
  }
}

/**
 * Publish one project-owned file through a same-directory wx temporary inode.
 * A missing target is linked with the kernel's no-clobber EEXIST rule; an
 * accepted existing file is replaced only after its path generation is bound.
 * Node's path APIs cannot bind all accepted parent components to link/rename,
 * so a hostile parent replacement in the final check-to-syscall window can
 * still redirect the syscall and is only observable after it returns.
 * The existing-file check-to-rename sequence still has a userspace syscall
 * window; no kernel-atomic conditional replacement is claimed for it.
 */
export function publishProjectFile(
  target: string,
  value: Uint8Array | string,
  boundaryRoot?: string,
  options: ProjectFilePublishOptions = {},
): void {
  const resolvedTarget = path.resolve(target);
  const root = publishRoot(resolvedTarget, boundaryRoot);
  // Validate before mkdir so an existing symlink cannot redirect the first
  // filesystem mutation. A later hostile replacement remains detectable at
  // the final userspace generation check described above.
  const initial = captureProjectFile(resolvedTarget, root);
  mkdirSync(path.dirname(resolvedTarget), { recursive: true, mode: 0o700 });
  const accepted = captureProjectFile(resolvedTarget, root);
  assertAdmissionGeneration(initial, accepted);
  if (options.expectedAdmission !== undefined) {
    assertExpectedAdmission(options.expectedAdmission, accepted);
  }
  const temporary = `${resolvedTarget}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let primaryFailure = false;
  let temporaryIdentity: TemporaryFileIdentity | null = null;
  try {
    createTemporaryFile(temporary, value, options.mode ?? 0o600);
    const context: ProjectFilePublishContext = {
      root,
      target: resolvedTarget,
      temporary,
    };
    temporaryIdentity = temporaryFileIdentity(
      accepted,
      captureProjectFile(temporary, root),
    );
    options.beforePublish?.(context);
    const current = captureProjectFile(resolvedTarget, root);
    assertPublishGeneration(accepted, current);
    options.afterGenerationCheck?.(context);
    if (accepted.targetGeneration === null) {
      try {
        linkSync(temporary, resolvedTarget);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw unsafeProjectFileGeneration(
            accepted.relative,
            "was created by another writer",
          );
        }
        throw error;
      }
    } else {
      renameSync(temporary, resolvedTarget);
    }
    options.afterPublish?.(context);
    // This is an observation after publish, not an atomic lock. It catches an
    // ordinary immediate replacement while keeping the remaining hostile-writer
    // window explicit in the contract above.
    assertPublishedGeneration(
      temporaryIdentity,
      captureProjectFile(resolvedTarget, root),
    );
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    if (temporaryIdentity !== null) {
      try {
        cleanupTemporary(temporaryIdentity);
      } catch (error) {
        // Cleanup must not hide the publish or boundary failure.
        if (!primaryFailure) {
          throw error;
        }
      }
    }
  }
}

export function atomicWriteJson(
  target: string,
  value: unknown,
  boundaryRoot?: string,
): void {
  publishProjectFile(
    target,
    `${JSON.stringify(value, null, 2)}\n`,
    boundaryRoot,
  );
}
