import { BurnGraphError } from "@burn-graph/core";
import {
  MERMAID_BACKGROUND,
  MERMAID_VERSION,
} from "@burn-graph/design-system/mermaid-config";

import {
  cacheIdentity,
  pruneOlderRevisions,
  readCachedArtifact,
  readCachedArtifactSnapshot,
  storeArtifact,
  withCacheLock,
} from "./cache.ts";
import {
  discoverRenderBrowser,
  inspectRenderCapability,
  renderInIsolatedBrowser,
  resolveRenderAssetsDirectory,
} from "./browser.ts";
import {
  DEFAULT_RENDER_TIMEOUT_MS,
  type RenderArtifact,
  type RenderGraphOptions,
} from "./contracts.ts";
import { pngDimensions, sha256, validateSvg } from "./validation.ts";

export type {
  RenderArtifact,
  RenderCapability,
  RenderFormat,
  RenderGraphOptions,
  RenderScope,
} from "./contracts.ts";
export {
  discoverRenderBrowser,
  inspectRenderCapability,
  resolveRenderAssetsDirectory,
} from "./browser.ts";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function accessibleSvg(
  svg: string,
  renderId: string,
  title: string,
  description: string,
): string {
  const titleId = `${renderId}-title`;
  const descriptionId = `${renderId}-description`;
  return svg.replace(
    /<svg\b([^>]*)>/i,
    (_opening, attributes: string) => {
      const cleaned = attributes
        .replace(/\srole\s*=\s*(["'])[^"']*\1/gi, "")
        .replace(/\saria-labelledby\s*=\s*(["'])[^"']*\1/gi, "");
      return `<svg${cleaned} role="img" aria-labelledby="${titleId} ${descriptionId}"><title id="${titleId}">${escapeXml(title)}</title><desc id="${descriptionId}">${escapeXml(description)}</desc><rect width="100%" height="100%" fill="${MERMAID_BACKGROUND}"/>`;
    },
  );
}

function renderUnavailable(): BurnGraphError {
  return new BurnGraphError(
    "RENDERER_UNAVAILABLE",
    "No supported Chrome-family executable is available",
    true,
    {
      recovery:
        "Install Chrome/Chromium or set BURN_GRAPH_CHROME_BIN to its executable.",
    },
  );
}

async function renderGraphArtifactInternal(
  options: RenderGraphOptions,
): Promise<RenderArtifact> {
  const snapshot = options.snapshot;
  const scope = options.scope ?? "run";
  const projectionDepth =
    scope === "tree" ? (options.projectionDepth ?? 0) : null;
  const sourceHash = sha256(snapshot.mermaid);
  const identity = cacheIdentity({
    projectRoot: options.projectRoot,
    runId: snapshot.summary.runId,
    graphId: snapshot.summary.graphId,
    runtimeRevision: snapshot.summary.runtimeRevision,
    scope,
    projectionDepth,
    sourceHash,
    format: options.format,
  });
  const cached = readCachedArtifact(identity);
  if (cached) return cached;

  return await withCacheLock(
    identity,
    async () => {
      const afterWait = readCachedArtifact(identity);
      if (afterWait) return afterWait;

      const assetsDirectory = resolveRenderAssetsDirectory(
        options.assetsDirectory,
      );
      const explicit =
        options.chromeExecutable ?? process.env.BURN_GRAPH_CHROME_BIN;
      const browser = discoverRenderBrowser(explicit);
      if (!browser) throw renderUnavailable();
      const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
      const renderId = `burn-graph-${sourceHash.slice(0, 20)}`;

      const svgIdentity = cacheIdentity({
        projectRoot: options.projectRoot,
        runId: snapshot.summary.runId,
        graphId: snapshot.summary.graphId,
        runtimeRevision: snapshot.summary.runtimeRevision,
        scope,
        projectionDepth,
        sourceHash,
        format: "svg",
      });
      const cachedSvgSnapshot = readCachedArtifactSnapshot(svgIdentity);
      const existingSvg = cachedSvgSnapshot?.text ?? null;
      const rendered = await renderInIsolatedBrowser({
        assetsDirectory,
        browser,
        source: existingSvg === null ? snapshot.mermaid : null,
        svg: existingSvg,
        renderId,
        capturePng: options.format === "png",
        timeoutMs,
      });

      const finalSvg =
        existingSvg ??
        accessibleSvg(
          rendered.svg,
          renderId,
          snapshot.summary.title,
          `${snapshot.summary.graphId} Run ${snapshot.summary.runId}, runtime revision ${snapshot.summary.runtimeRevision}.`,
        );
      const svgValidation = validateSvg(finalSvg);
      let svgArtifact = cachedSvgSnapshot?.artifact ?? null;
      if (!svgArtifact) {
        svgArtifact = storeArtifact(
          svgIdentity,
          finalSvg,
          {
            width: svgValidation.width,
            height: svgValidation.height,
          },
          rendered.browser,
        );
      }

      let result: RenderArtifact;
      if (options.format === "svg") {
        result = svgArtifact;
      } else {
        if (rendered.png === null) {
          throw new BurnGraphError(
            "INVALID_RENDER_OUTPUT",
            "Browser renderer returned no PNG",
          );
        }
        const dimensions = pngDimensions(rendered.png);
        result = storeArtifact(
          identity,
          rendered.png,
          {
            width: dimensions.width,
            height: dimensions.height,
          },
          rendered.browser,
        );
      }
      pruneOlderRevisions(identity);
      return result;
    },
    (options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS) + 5_000,
  );
}

export async function renderGraphArtifact(
  options: RenderGraphOptions,
): Promise<RenderArtifact> {
  try {
    return await renderGraphArtifactInternal(options);
  } catch (error) {
    if (error instanceof BurnGraphError) throw error;
    const causeCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z0-9_]+$/.test(error.code)
        ? error.code
        : null;
    throw new BurnGraphError(
      "RENDER_FAILED",
      "Graph artifact rendering failed",
      true,
      causeCode === null ? {} : { causeCode },
    );
  }
}

export const rendererContract = {
  mermaidVersion: MERMAID_VERSION,
  defaultFormat: "svg",
  formats: ["svg", "png"],
} as const;
