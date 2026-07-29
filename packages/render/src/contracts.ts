import type { GraphSnapshot } from "@burn-graph/core";
import { MERMAID_RENDERER_VERSION } from "@burn-graph/design-system/mermaid-config";

export const RENDERER_NAME = "burn-graph-mermaid";
export const RENDERER_VERSION = MERMAID_RENDERER_VERSION;
export const MAX_RENDER_BYTES = 8 * 1024 * 1024;
export const MAX_PNG_WIDTH = 2400;
export const MAX_PNG_HEIGHT = 1600;
export const DEFAULT_RENDER_TIMEOUT_MS = 20_000;

export type RenderFormat = "svg" | "png";

export interface RenderBrowser {
  readonly name: string;
  readonly executable: string;
}

export interface PublicRenderBrowser {
  readonly name: string;
  readonly version: string;
}

export interface RenderCapability {
  readonly available: boolean;
  readonly formats: readonly RenderFormat[];
  readonly browser: {
    readonly name: string;
  } | null;
  readonly reason: {
    readonly code: string;
    readonly message: string;
  } | null;
  readonly recovery: string | null;
}

export interface RenderArtifact {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly graphId: string;
  readonly runtimeRevision: number;
  readonly sourceHash: string;
  readonly format: RenderFormat;
  readonly theme: "dark";
  readonly artifact: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly cached: boolean;
  readonly renderer: {
    readonly name: typeof RENDERER_NAME;
    readonly version: typeof RENDERER_VERSION;
    readonly mermaidVersion: string;
    readonly browser: PublicRenderBrowser;
  };
}

export interface RenderGraphOptions {
  readonly projectRoot: string;
  readonly snapshot: GraphSnapshot;
  readonly format: RenderFormat;
  readonly assetsDirectory?: string;
  readonly chromeExecutable?: string;
  readonly timeoutMs?: number;
}

export interface BrowserRenderRequest {
  readonly assetsDirectory: string;
  readonly browser: RenderBrowser;
  readonly source: string | null;
  readonly svg: string | null;
  readonly renderId: string;
  readonly capturePng: boolean;
  readonly timeoutMs: number;
}

export interface BrowserRenderResult {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  readonly png: Uint8Array | null;
  readonly pngWidth: number | null;
  readonly pngHeight: number | null;
  readonly browser: PublicRenderBrowser;
}
