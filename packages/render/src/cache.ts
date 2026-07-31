import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { safeChmod } from "@burn-graph/core";

import { BurnGraphError, STATE_DIRECTORY } from "@burn-graph/core";
import {
  MERMAID_THEME,
  MERMAID_VERSION,
} from "@burn-graph/design-system/mermaid-config";

import {
  RENDERER_NAME,
  RENDERER_VERSION,
  type PublicRenderBrowser,
  type RenderArtifact,
  type RenderFormat,
  type RenderScope,
} from "./contracts.ts";
import { pngDimensions, sha256, validateSvg } from "./validation.ts";

export interface CacheIdentity {
  readonly projectRoot: string;
  readonly runId: string;
  readonly graphId: string;
  readonly runtimeRevision: number;
  readonly scope: RenderScope;
  readonly projectionDepth: number | null;
  readonly sourceHash: string;
  readonly format: RenderFormat;
  readonly key: string;
  readonly runDirectory: string;
  readonly artifactFile: string;
  readonly manifestFile: string;
  readonly artifact: string;
  readonly lockDirectory: string;
}

interface StoredArtifact extends Omit<RenderArtifact, "cached"> {
  readonly cached: false;
}


function runSlug(runId: string): string {
  const prefix = runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return `${prefix || "run"}-${sha256(runId).slice(0, 10)}`;
}

export function cacheIdentity(input: {
  readonly projectRoot: string;
  readonly runId: string;
  readonly graphId: string;
  readonly runtimeRevision: number;
  readonly scope?: RenderScope;
  readonly projectionDepth?: number | null;
  readonly sourceHash: string;
  readonly format: RenderFormat;
}): CacheIdentity {
  const scope = input.scope ?? "run";
  const projectionDepth =
    scope === "tree" ? (input.projectionDepth ?? 0) : null;
  const key = sha256(
    JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      graphId: input.graphId,
      runtimeRevision: input.runtimeRevision,
      scope,
      projectionDepth,
      sourceHash: input.sourceHash,
      format: input.format,
      theme: MERMAID_THEME,
      rendererVersion: RENDERER_VERSION,
      mermaidVersion: MERMAID_VERSION,
    }),
  ).slice(0, 32);
  const runDirectory = path.join(
    input.projectRoot,
    STATE_DIRECTORY,
    "runtime",
    "renders",
    runSlug(input.runId),
  );
  const artifactFile = path.join(runDirectory, `${key}.${input.format}`);
  return {
    ...input,
    scope,
    projectionDepth,
    key,
    runDirectory,
    artifactFile,
    manifestFile: path.join(runDirectory, `${key}.json`),
    artifact: path
      .relative(input.projectRoot, artifactFile)
      .split(path.sep)
      .join("/"),
    lockDirectory: path.join(runDirectory, `${key}.lock`),
  };
}

function atomicWrite(target: string, value: Uint8Array | string): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  safeChmod(path.dirname(target), 0o700);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, target);
  safeChmod(target, 0o600);
}

function validStoredArtifact(
  value: unknown,
  identity: CacheIdentity,
): value is StoredArtifact {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredArtifact>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.runId === identity.runId &&
    candidate.graphId === identity.graphId &&
    candidate.runtimeRevision === identity.runtimeRevision &&
    candidate.scope === identity.scope &&
    candidate.projectionDepth === identity.projectionDepth &&
    candidate.sourceHash === identity.sourceHash &&
    candidate.format === identity.format &&
    candidate.theme === MERMAID_THEME &&
    candidate.artifact === identity.artifact &&
    candidate.cached === false &&
    typeof candidate.bytes === "number" &&
    typeof candidate.sha256 === "string" &&
    typeof candidate.width === "number" &&
    typeof candidate.height === "number" &&
    candidate.renderer?.name === RENDERER_NAME &&
    candidate.renderer.version === RENDERER_VERSION &&
    candidate.renderer.mermaidVersion === MERMAID_VERSION &&
    typeof candidate.renderer.browser?.name === "string" &&
    typeof candidate.renderer.browser.version === "string"
  );
}

export function readCachedArtifact(
  identity: CacheIdentity,
): RenderArtifact | null {
  if (
    !existsSync(identity.manifestFile) ||
    !existsSync(identity.artifactFile)
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(identity.manifestFile, "utf8"),
    );
    if (!validStoredArtifact(parsed, identity)) return null;
    const stored = parsed;
    const bytes = readFileSync(identity.artifactFile);
    if (bytes.length !== stored.bytes || sha256(bytes) !== stored.sha256) {
      return null;
    }
    if (identity.format === "svg") {
      const dimensions = validateSvg(bytes.toString("utf8"));
      if (
        dimensions.width !== stored.width ||
        dimensions.height !== stored.height
      ) {
        return null;
      }
    } else {
      const dimensions = pngDimensions(bytes);
      if (
        dimensions.width !== stored.width ||
        dimensions.height !== stored.height
      ) {
        return null;
      }
    }
    return { ...stored, cached: true };
  } catch {
    return null;
  }
}

export function storeArtifact(
  identity: CacheIdentity,
  bytes: Uint8Array | string,
  dimensions: { readonly width: number; readonly height: number },
  browser: PublicRenderBrowser,
): RenderArtifact {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  const stored: StoredArtifact = {
    schemaVersion: 1,
    runId: identity.runId,
    graphId: identity.graphId,
    runtimeRevision: identity.runtimeRevision,
    scope: identity.scope,
    projectionDepth: identity.projectionDepth,
    sourceHash: identity.sourceHash,
    format: identity.format,
    theme: MERMAID_THEME,
    artifact: identity.artifact,
    bytes: buffer.length,
    sha256: sha256(buffer),
    width: dimensions.width,
    height: dimensions.height,
    cached: false,
    renderer: {
      name: RENDERER_NAME,
      version: RENDERER_VERSION,
      mermaidVersion: MERMAID_VERSION,
      browser,
    },
  };
  atomicWrite(identity.artifactFile, buffer);
  atomicWrite(identity.manifestFile, `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

function staleLock(lockDirectory: string, staleAfterMs: number): boolean {
  try {
    const stat = lstatSync(lockDirectory);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      Date.now() - stat.mtimeMs > staleAfterMs
    );
  } catch {
    return false;
  }
}

export async function withCacheLock<T>(
  identity: CacheIdentity,
  operation: () => Promise<T>,
  waitMs: number,
): Promise<T> {
  mkdirSync(identity.runDirectory, { recursive: true, mode: 0o700 });
  safeChmod(identity.runDirectory, 0o700);
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(identity.lockDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "EEXIST") throw error;
      if (staleLock(identity.lockDirectory, waitMs * 2)) {
        try {
          rmdirSync(identity.lockDirectory);
          continue;
        } catch {
          // The lock owner may still be active; bounded polling decides next.
        }
      }
      if (Date.now() - startedAt >= waitMs) {
        throw new BurnGraphError(
          "RENDER_TIMEOUT",
          "Timed out waiting for an identical render request",
          true,
        );
      }
      await Bun.sleep(50);
    }
  }
  try {
    return await operation();
  } finally {
    try {
      rmdirSync(identity.lockDirectory);
    } catch {
      // A failed cleanup cannot invalidate an already atomic artifact.
    }
  }
}

export function pruneOlderRevisions(
  identity: CacheIdentity,
): void {
  if (!existsSync(identity.runDirectory)) return;
  for (const entry of readdirSync(identity.runDirectory)) {
    if (!entry.endsWith(".json") || entry === `${identity.key}.json`) continue;
    const manifest = path.join(identity.runDirectory, entry);
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        readonly runId?: unknown;
        readonly runtimeRevision?: unknown;
        readonly scope?: unknown;
        readonly sourceHash?: unknown;
        readonly artifact?: unknown;
      };
      const staleRevision =
        parsed.runtimeRevision !== identity.runtimeRevision;
      const staleTreeSource =
        identity.scope === "tree" &&
        parsed.sourceHash !== identity.sourceHash;
      if (
        parsed.runId !== identity.runId ||
        parsed.scope !== identity.scope ||
        (!staleRevision && !staleTreeSource) ||
        typeof parsed.artifact !== "string"
      ) {
        continue;
      }
      const artifact = path.resolve(identity.projectRoot, parsed.artifact);
      if (artifact.startsWith(`${identity.runDirectory}${path.sep}`)) {
        try {
          unlinkSync(artifact);
        } catch {
          // Missing stale artifacts need no separate recovery.
        }
      }
      unlinkSync(manifest);
    } catch {
      // Unknown files are preserved because this cleanup owns only valid manifests.
    }
  }
}
