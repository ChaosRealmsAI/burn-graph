import { describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  BurnGraphError,
  BurnGraphService,
  initializeProject,
} from "@burn-graph/core";
import {
  inspectRenderCapability,
  renderGraphArtifact,
} from "@burn-graph/render";
import {
  cacheIdentity,
  discoverRenderBrowser,
  pngDimensions,
  readCachedArtifact,
  resolveRenderAssetsDirectory,
  sha256,
  validateSvg,
} from "@burn-graph/render/testing";
import { MERMAID_VERSION } from "@burn-graph/design-system/mermaid-config";
import {
  RENDERER_NAME,
  RENDERER_VERSION,
} from "../../packages/render/src/contracts.ts";
import {
  pruneOlderRevisions,
  readCachedArtifactSnapshot,
} from "../../packages/render/src/cache.ts";

import {
  createTestDirectory,
  parallelGraph,
  removeTestProject,
} from "../helpers/fixtures.ts";

function expectBurnGraphError(
  operation: () => unknown,
  code: string,
): void {
  try {
    operation();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BurnGraphError);
    expect((error as BurnGraphError).code).toBe(code);
  }
}

describe("render artifact boundaries", () => {
  test("validates safe fragment-only SVG and bounded PNG", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><defs><marker id="arrow"/></defs><path marker-end="url(#arrow)"/></svg>';
    expect(validateSvg(svg)).toEqual({
      width: 100,
      height: 40,
      bytes: Buffer.byteLength(svg),
    });
    expect(sha256(svg)).toHaveLength(64);

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    expect(pngDimensions(png)).toMatchObject({ width: 1, height: 1 });
  });

  test("rejects active, embedded, external, and malformed SVG", () => {
    for (const value of [
      '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 1 1"><foreignObject/></svg>',
      '<svg viewBox="0 0 1 1"><image href="https://example.test/x"/></svg>',
      '<svg viewBox="0 0 1 1"><path onclick="run()"/></svg>',
      '<svg viewBox="0 0 1 1"><path style="fill:url(https://example.test/x)"/></svg>',
      '<svg viewBox="0 0 1 1"><style>@import "https://example.test/x";</style></svg>',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///tmp/x">]><svg viewBox="0 0 1 1"/>',
      '<?xml-stylesheet href="https://example.test/x"?><svg viewBox="0 0 1 1"/>',
      "<svg></svg>",
    ]) {
      expectBurnGraphError(() => validateSvg(value), "INVALID_RENDER_OUTPUT");
    }
  });

  test("rejects oversized SVG and PNG dimensions", () => {
    const oversizedSvg = `<svg viewBox="0 0 1 1">${" ".repeat(
      8 * 1024 * 1024,
    )}</svg>`;
    expectBurnGraphError(
      () => validateSvg(oversizedSvg),
      "RENDER_OUTPUT_TOO_LARGE",
    );

    const oversizedPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    oversizedPng.writeUInt32BE(2401, 16);
    expectBurnGraphError(
      () => pngDimensions(oversizedPng),
      "INVALID_RENDER_OUTPUT",
    );
  });

  test("builds stable project-relative identities per format", () => {
    const root = createTestDirectory();
    try {
      const input = {
        projectRoot: root,
        runId: "delivery:one",
        graphId: "delivery",
        runtimeRevision: 7,
        sourceHash: sha256("flowchart LR"),
      };
      const svg = cacheIdentity({ ...input, format: "svg" });
      const repeated = cacheIdentity({ ...input, format: "svg" });
      const png = cacheIdentity({ ...input, format: "png" });
      expect(svg.key).toBe(repeated.key);
      expect(svg.key).not.toBe(png.key);
      expect(svg.artifact.startsWith(".burn/graph/runtime/renders/")).toBe(
        true,
      );
      expect(svg.artifact).not.toContain(root);
    } finally {
      removeTestProject(root);
    }
  });

  test("initializes the private render cache and reports optional capability failures", () => {
    const root = createTestDirectory();
    try {
      initializeProject(root, "2026-07-29T00:00:00.000Z");
      expect(
        existsSync(path.join(root, ".burn", "graph", "runtime", "renders")),
      ).toBe(true);
      expect(discoverRenderBrowser(path.join(root, "missing-chrome"))).toBeNull();

      const emptyAssets = path.join(root, "empty-assets");
      mkdirSync(emptyAssets);
      expectBurnGraphError(
        () => resolveRenderAssetsDirectory(emptyAssets),
        "RENDER_ASSETS_MISSING",
      );
      expect(
        inspectRenderCapability({ assetsDirectory: emptyAssets }),
      ).toMatchObject({
        available: false,
        reason: { code: "RENDER_ASSETS_MISSING" },
      });
    } finally {
      removeTestProject(root);
    }
  });

  test("normalizes unexpected cache filesystem failures", async () => {
    const root = createTestDirectory();
    try {
      initializeProject(root, "2026-07-29T00:00:00.000Z");
      const service = new BurnGraphService(root);
      let snapshot;
      try {
        service.applyGraph(parallelGraph("render-storage-error"));
        snapshot = service.startRun(
          "render-storage-error",
          "render-storage-error:run",
        ).value;
      } finally {
        service.close();
      }
      const renderRoot = path.join(
        root,
        ".burn", "graph",
        "runtime",
        "renders",
      );
      rmdirSync(renderRoot);
      writeFileSync(renderRoot, "not a directory");
      try {
        await renderGraphArtifact({
          projectRoot: root,
          snapshot,
          format: "svg",
        });
        throw new Error("Expected RENDER_FAILED");
      } catch (error) {
        expect(error).toBeInstanceOf(BurnGraphError);
        expect((error as BurnGraphError).code).toBe("RENDER_FAILED");
        expect((error as BurnGraphError).details).toEqual({
          causeCode: "ENOTDIR",
        });
      }
    } finally {
      removeTestProject(root);
    }
  });

  test("rejects a symlinked render cache before writing outside the project", async () => {
    const root = createTestDirectory();
    try {
      initializeProject(root, "2026-07-29T00:00:00.000Z");
      const service = new BurnGraphService(root);
      let snapshot;
      try {
        service.applyGraph(parallelGraph("render-cache-boundary"));
        snapshot = service.startRun(
          "render-cache-boundary",
          "render-cache-boundary:run",
        ).value;
      } finally {
        service.close();
      }

      const renderRoot = path.join(
        root,
        ".burn", "graph",
        "runtime",
        "renders",
      );
      const outside = path.join(root, "outside-render-cache");
      mkdirSync(outside);
      writeFileSync(path.join(outside, "sentinel.txt"), "unchanged\n");
      rmSync(renderRoot, { recursive: true, force: true });
      symlinkSync(outside, renderRoot);

      try {
        await renderGraphArtifact({
          projectRoot: root,
          snapshot,
          format: "svg",
        });
        throw new Error("Expected the symlinked render cache to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(BurnGraphError);
        expect((error as BurnGraphError).code).toBe("RENDER_FAILED");
        expect((error as BurnGraphError).message).toContain(
          ".burn/graph/runtime/renders",
        );
      }
      expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
      expect(readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe(
        "unchanged\n",
      );
    } finally {
      removeTestProject(root);
    }
  });

  test("reads cached manifest and artifact through the state boundary", () => {
    const root = createTestDirectory();
    try {
      initializeProject(root, "2026-07-29T00:00:00.000Z");
      const identity = cacheIdentity({
        projectRoot: root,
        runId: "render-read-boundary:run",
        graphId: "render-read-boundary",
        runtimeRevision: 1,
        sourceHash: sha256("flowchart LR"),
        format: "svg",
      });
      mkdirSync(identity.runDirectory, { recursive: true });
      const svg = '<svg viewBox="0 0 10 10"></svg>';
      const outside = path.join(root, "outside-render-read");
      mkdirSync(outside);
      const outsidePeer = path.join(outside, "peer.svg");
      writeFileSync(outsidePeer, svg);
      linkSync(outsidePeer, identity.artifactFile);
      const manifest = {
        schemaVersion: 1,
        runId: identity.runId,
        graphId: identity.graphId,
        runtimeRevision: identity.runtimeRevision,
        scope: identity.scope,
        projectionDepth: identity.projectionDepth,
        sourceHash: identity.sourceHash,
        format: identity.format,
        theme: "dark",
        artifact: identity.artifact,
        bytes: Buffer.byteLength(svg),
        sha256: sha256(svg),
        width: 10,
        height: 10,
        cached: false,
        renderer: {
          name: RENDERER_NAME,
          version: RENDERER_VERSION,
          mermaidVersion: MERMAID_VERSION,
          browser: { name: "test", version: "1" },
        },
      };
      writeFileSync(
        identity.manifestFile,
        JSON.stringify(manifest) + "\n",
      );

      expect(readCachedArtifact(identity)).toMatchObject({
        cached: true,
        artifact: identity.artifact,
      });
      const snapshot = readCachedArtifactSnapshot(identity);
      expect(snapshot?.text).toBe(svg);
      expect(snapshot?.artifact.sha256).toBe(sha256(snapshot?.text ?? ""));
      expect(snapshot?.artifact.bytes).toBe(
        Buffer.byteLength(snapshot?.text ?? ""),
      );
      expect(snapshot?.artifact.width).toBe(validateSvg(svg).width);
      expect(snapshot?.artifact.height).toBe(validateSvg(svg).height);
      expect(readFileSync(outsidePeer, "utf8")).toBe(svg);

      const corruptIdentity = cacheIdentity({
        projectRoot: root,
        runId: "render-corrupt-boundary:run",
        graphId: identity.graphId,
        runtimeRevision: identity.runtimeRevision,
        sourceHash: identity.sourceHash,
        format: identity.format,
      });
      mkdirSync(corruptIdentity.runDirectory, { recursive: true });
      writeFileSync(corruptIdentity.artifactFile, "corrupted artifact\n");
      writeFileSync(
        corruptIdentity.manifestFile,
        JSON.stringify({
          ...manifest,
          runId: corruptIdentity.runId,
          artifact: corruptIdentity.artifact,
        }) + "\n",
      );
      expect(readCachedArtifactSnapshot(corruptIdentity)).toBeNull();
    } finally {
      removeTestProject(root);
    }
  });

  test("cache manifest, artifact, and prune reads reject final namesakes", () => {
    const root = createTestDirectory();
    try {
      initializeProject(root, "2026-07-29T00:00:00.000Z");
      const identity = cacheIdentity({
        projectRoot: root,
        runId: "render-final-read-boundary:run",
        graphId: "render-final-read-boundary",
        runtimeRevision: 1,
        sourceHash: sha256("flowchart LR"),
        format: "svg",
      });
      mkdirSync(identity.runDirectory, { recursive: true });
      const outside = path.join(root, "outside-render-final-read");
      mkdirSync(outside);
      const outsideManifest = path.join(outside, "manifest.json");
      const outsideArtifact = path.join(outside, "artifact.svg");
      const outsideStale = path.join(outside, "stale.json");
      writeFileSync(outsideManifest, "outside manifest\n");
      writeFileSync(outsideArtifact, "outside artifact\n");
      writeFileSync(outsideStale, "outside stale\n");

      symlinkSync(outsideManifest, identity.manifestFile);
      expectBurnGraphError(
        () => readCachedArtifact(identity),
        "RENDER_FAILED",
      );
      expect(readFileSync(outsideManifest, "utf8")).toBe("outside manifest\n");

      rmSync(identity.manifestFile);
      symlinkSync(outsideArtifact, identity.artifactFile);
      expectBurnGraphError(
        () => readCachedArtifact(identity),
        "RENDER_FAILED",
      );
      expect(readFileSync(outsideArtifact, "utf8")).toBe("outside artifact\n");

      rmSync(identity.artifactFile);
      symlinkSync(
        outsideStale,
        path.join(identity.runDirectory, "stale.json"),
      );
      expectBurnGraphError(
        () => pruneOlderRevisions(identity),
        "RENDER_FAILED",
      );
      expect(readFileSync(outsideStale, "utf8")).toBe("outside stale\n");
    } finally {
      removeTestProject(root);
    }
  });
});
