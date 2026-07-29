import mermaid from "mermaid";
import { useEffect, useId, useRef, useState } from "react";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  flowchart: {
    curve: "basis",
    htmlLabels: false,
    padding: 18,
  },
  themeVariables: {
    background: "#0d111a",
    primaryColor: "#171d2a",
    primaryTextColor: "#f3f6fb",
    primaryBorderColor: "#364156",
    lineColor: "#526078",
    secondaryColor: "#121722",
    tertiaryColor: "#080b12",
    fontFamily: "Inter, ui-sans-serif, sans-serif",
  },
});

export function MermaidCanvas({
  source,
  title,
}: {
  readonly source: string;
  readonly title: string;
}) {
  const rawId = useId();
  const renderId = `burn-graph-${rawId.replaceAll(":", "")}`;
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void mermaid
      .render(renderId, source)
      .then(({ svg }) => {
        if (cancelled || !container.current) return;
        container.current.innerHTML = svg;
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Diagram failed");
      });
    return () => {
      cancelled = true;
    };
  }, [renderId, source]);

  return (
    <div className="bg-mermaid" aria-label={title}>
      {error ? (
        <div className="bg-inline-error" role="alert">
          <strong>Diagram unavailable</strong>
          <span>{error}</span>
        </div>
      ) : (
        <div ref={container} className="bg-mermaid__stage" />
      )}
    </div>
  );
}
