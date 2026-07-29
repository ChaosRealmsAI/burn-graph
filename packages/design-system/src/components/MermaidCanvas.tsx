import { useEffect, useId, useRef, useState } from "react";

import { renderMermaidSvg } from "../mermaid-browser.ts";

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
    void renderMermaidSvg(renderId, source)
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
