import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmdirSync,
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
  resolveRenderAssetsDirectory,
  sha256,
  validateSvg,
} from "@burn-graph/render/testing";

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
      expect(svg.artifact.startsWith(".burn-graph/runtime/renders/")).toBe(
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
        existsSync(path.join(root, ".burn-graph", "runtime", "renders")),
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
        ".burn-graph",
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
});
