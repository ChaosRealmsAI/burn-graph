export const MERMAID_VERSION = "11.16.0";
export const MERMAID_RENDERER_VERSION = "2";
export const MERMAID_THEME = "dark" as const;
export const MERMAID_BACKGROUND = "#0d111a";

export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  htmlLabels: false,
  flowchart: {
    curve: "basis",
    padding: 18,
  },
  themeVariables: {
    background: MERMAID_BACKGROUND,
    primaryColor: "#171d2a",
    primaryTextColor: "#f3f6fb",
    primaryBorderColor: "#364156",
    lineColor: "#526078",
    secondaryColor: "#121722",
    tertiaryColor: "#080b12",
    fontFamily: "Inter, ui-sans-serif, sans-serif",
  },
} as const;
