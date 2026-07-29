import mermaid from "mermaid";

import { MERMAID_CONFIG } from "./mermaid-config.ts";

let initialized = false;

function initializeMermaid(): void {
  if (initialized) return;
  mermaid.initialize(MERMAID_CONFIG);
  initialized = true;
}

function dimensionsFromSvg(svg: string): {
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
    throw new Error("Mermaid output does not contain a positive viewBox");
  }
  return { width, height };
}

export async function renderMermaidSvg(
  renderId: string,
  source: string,
): Promise<{
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}> {
  initializeMermaid();
  const { svg } = await mermaid.render(renderId, source);
  return { svg, ...dimensionsFromSvg(svg) };
}
