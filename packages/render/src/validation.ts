import { BurnGraphError } from "@burn-graph/core";

import {
  MAX_PNG_HEIGHT,
  MAX_PNG_WIDTH,
  MAX_RENDER_BYTES,
} from "./contracts.ts";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function sha256(value: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function svgDimensions(svg: string): {
  readonly width: number;
  readonly height: number;
} {
  const match = /\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(
    svg,
  );
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new BurnGraphError(
      "INVALID_RENDER_OUTPUT",
      "SVG output does not contain a positive viewBox",
    );
  }
  return { width, height };
}

export function validateSvg(svg: string): {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
} {
  const bytes = Buffer.byteLength(svg);
  if (bytes > MAX_RENDER_BYTES) {
    throw new BurnGraphError(
      "RENDER_OUTPUT_TOO_LARGE",
      "SVG output exceeds the 8 MiB limit",
      false,
      { maximumBytes: MAX_RENDER_BYTES, actualBytes: bytes },
    );
  }
  if (!/<svg\b[^>]*\bviewBox\s*=/i.test(svg)) {
    throw new BurnGraphError(
      "INVALID_RENDER_OUTPUT",
      "Renderer output is not a viewBox SVG",
    );
  }
  const forbidden: readonly (readonly [string, RegExp])[] = [
    ["document-declaration", /<\s*!(?:DOCTYPE|ENTITY)\b/i],
    ["xml-stylesheet", /<\?xml-stylesheet\b/i],
    ["script", /<\s*script\b/i],
    ["foreign-object", /<\s*foreignObject\b/i],
    ["embedded-content", /<\s*(?:iframe|object|embed|image)\b/i],
    ["event-handler", /\son[a-z]+\s*=/i],
    [
      "external-link",
      /\b(?:href|xlink:href)\s*=\s*["']\s*(?!#)[^"']+/i,
    ],
    ["external-style-url", /url\(\s*["']?\s*(?!#)[^)]+/i],
    ["external-style-import", /@import\b/i],
  ];
  const rejected = forbidden.find(([, pattern]) => pattern.test(svg));
  if (rejected) {
    throw new BurnGraphError(
      "INVALID_RENDER_OUTPUT",
      "SVG output contains active or external content",
      false,
      { rule: rejected[0] },
    );
  }
  return { ...svgDimensions(svg), bytes };
}

export function pngDimensions(png: Uint8Array): {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
} {
  const buffer = Buffer.from(png);
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new BurnGraphError(
      "INVALID_RENDER_OUTPUT",
      "Renderer output is not a valid PNG",
    );
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_PNG_WIDTH ||
    height > MAX_PNG_HEIGHT
  ) {
    throw new BurnGraphError(
      "INVALID_RENDER_OUTPUT",
      "PNG dimensions exceed the 2400 by 1600 limit",
      false,
      {
        width,
        height,
        maximumWidth: MAX_PNG_WIDTH,
        maximumHeight: MAX_PNG_HEIGHT,
      },
    );
  }
  if (buffer.length > MAX_RENDER_BYTES) {
    throw new BurnGraphError(
      "RENDER_OUTPUT_TOO_LARGE",
      "PNG output exceeds the 8 MiB limit",
      false,
      { maximumBytes: MAX_RENDER_BYTES, actualBytes: buffer.length },
    );
  }
  return { width, height, bytes: buffer.length };
}
