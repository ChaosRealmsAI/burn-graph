import { renderMermaidSvg } from "@burn-graph/design-system/mermaid-browser";

interface RenderedSvg {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

interface PngLayout {
  readonly width: number;
  readonly height: number;
}

const rootElement = document.getElementById("render-root");
if (!rootElement) throw new Error("Missing #render-root");
const root: HTMLElement = rootElement;

function installSvg(svg: string): SVGSVGElement {
  root.innerHTML = svg;
  const element = root.querySelector("svg");
  if (!(element instanceof SVGSVGElement)) {
    throw new Error("Renderer did not produce an SVG element");
  }
  return element;
}

function naturalDimensions(element: SVGSVGElement): PngLayout {
  const viewBox = element.viewBox.baseVal;
  if (viewBox.width <= 0 || viewBox.height <= 0) {
    throw new Error("SVG does not contain a positive viewBox");
  }
  return { width: viewBox.width, height: viewBox.height };
}

const renderer = {
  async render(renderId: string, source: string): Promise<RenderedSvg> {
    const result = await renderMermaidSvg(renderId, source);
    installSvg(result.svg);
    return result;
  },

  load(svg: string): PngLayout {
    return naturalDimensions(installSvg(svg));
  },

  preparePng(maxWidth: number, maxHeight: number): PngLayout {
    const element = root.querySelector("svg");
    if (!(element instanceof SVGSVGElement)) {
      throw new Error("No SVG is ready for PNG capture");
    }
    const natural = naturalDimensions(element);
    const scale = Math.min(
      1,
      maxWidth / natural.width,
      maxHeight / natural.height,
    );
    const width = Math.max(1, Math.ceil(natural.width * scale));
    const height = Math.max(1, Math.ceil(natural.height * scale));
    element.setAttribute("width", String(width));
    element.setAttribute("height", String(height));
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    document.documentElement.style.width = `${width}px`;
    document.documentElement.style.height = `${height}px`;
    document.body.style.width = `${width}px`;
    document.body.style.height = `${height}px`;
    return { width, height };
  },
};

declare global {
  interface Window {
    __burnGraphRenderer: typeof renderer;
  }
}

window.__burnGraphRenderer = renderer;
