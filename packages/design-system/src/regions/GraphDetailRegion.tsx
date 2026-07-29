import { MermaidCanvas } from "../components/MermaidCanvas.tsx";
import { NodeDetailPanel } from "../components/NodeDetailPanel.tsx";
import { StatusPill } from "../primitives/StatusPill.tsx";
import type { GraphDetailView } from "../types.ts";

const statusOrder = [
  "ready",
  "running",
  "waiting",
  "done",
  "blocked",
  "failed",
  "cancelled",
  "pending",
  "skipped",
] as const;

export function GraphDetailRegion({
  graph,
  selectedNodeId,
  onSelectNode,
  onBack,
  onSelectGraph,
  onToggleHierarchy,
}: {
  readonly graph: GraphDetailView;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onBack: () => void;
  readonly onSelectGraph?: (graphId: string) => void;
  readonly onToggleHierarchy?: () => void;
}) {
  const selected =
    graph.nodes.find((node) => node.id === selectedNodeId) ??
    graph.nodes.find((node) => node.status === "running") ??
    graph.nodes[0] ??
    null;

  return (
    <section className="bg-detail" aria-label={`Graph ${graph.summary.title}`}>
      <header className="bg-detail__header">
        <button className="bg-back" type="button" onClick={onBack}>
          <span aria-hidden="true">←</span> All graphs
        </button>
        <div className="bg-detail__identity">
          <span className="bg-eyebrow">
            {graph.summary.id} · revision {graph.summary.revision}
            {graph.summary.hierarchy
              ? ` · depth ${graph.summary.hierarchy.depth}`
              : ""}
          </span>
          <h1>{graph.summary.title}</h1>
          <p>{graph.summary.goal}</p>
        </div>
        <StatusPill status={graph.summary.status} />
      </header>

      <div className="bg-detail__layout">
        <main className="bg-detail__main">
          <div className="bg-diagram-header">
            <div>
              <span className="bg-eyebrow">Live topology</span>
              <strong>Graph state</strong>
            </div>
            {graph.projection && onToggleHierarchy ? (
              <button
                className="bg-projection-toggle"
                type="button"
                onClick={onToggleHierarchy}
              >
                {graph.projection.depth === 0
                  ? `Expand ${graph.projection.foldedRuns} child Runs`
                  : "Fold child Runs"}
              </button>
            ) : null}
            <div className="bg-legend" aria-label="Node status legend">
              {statusOrder.map((status) => (
                <StatusPill key={status} status={status} />
              ))}
            </div>
          </div>
          <MermaidCanvas
            source={graph.mermaid}
            title={`${graph.summary.title} Mermaid graph`}
          />

          {graph.children && graph.children.length > 0 ? (
            <section className="bg-child-runs" aria-label="Child Runs">
              <header>
                <div>
                  <span className="bg-eyebrow">Run hierarchy</span>
                  <strong>{graph.children.length} direct children</strong>
                </div>
                {graph.projection ? (
                  <code>
                    depth {graph.projection.depth}/{graph.projection.maximumDepth}
                    {" · "}
                    {graph.projection.renderedNodes} rendered nodes
                  </code>
                ) : null}
              </header>
              <div>
                {graph.children.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => onSelectGraph?.(child.id)}
                    disabled={!onSelectGraph}
                  >
                    <span>
                      <b>{child.title}</b>
                      <small>{child.id}</small>
                    </span>
                    <span>
                      <StatusPill status={child.status} />
                      <small>
                        {child.counts.done}/{child.counts.total}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section className="bg-node-list" aria-label="Graph nodes">
            <header>
              <span className="bg-eyebrow">Node index</span>
              <strong>{graph.nodes.length} nodes</strong>
            </header>
            <div>
              {graph.nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  className={selected?.id === node.id ? "is-selected" : ""}
                  onClick={() => onSelectNode(node.id)}
                >
                  <span>
                    <i className={`is-${node.status}`} aria-hidden="true" />
                    <b>{node.title}</b>
                    <small>{node.id}</small>
                  </span>
                  <StatusPill status={node.status} />
                </button>
              ))}
            </div>
          </section>
        </main>

        <div className="bg-detail__rail">
          {graph.metrics && graph.metrics.length > 0 ? (
            <section className="bg-metrics" aria-label="Run metrics">
              <header>
                <span className="bg-eyebrow">Bounded evidence</span>
                <strong>Runtime metrics</strong>
              </header>
              <dl>
                {graph.metrics.map((metric) => (
                  <div
                    key={metric.label}
                    className={`is-${metric.tone ?? "default"}`}
                  >
                    <dt>{metric.label}</dt>
                    <dd>{metric.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          <NodeDetailPanel node={selected} />
          <section className="bg-timeline" aria-label="Recent graph events">
            <header>
              <span className="bg-eyebrow">Event stream</span>
              <strong>Recent transitions</strong>
            </header>
            <ol>
              {graph.events.slice(-8).reverse().map((event) => (
                <li key={event.sequence}>
                  <i aria-hidden="true" />
                  <div>
                    <span>
                      #{event.sequence} · {event.type}
                    </span>
                    <p>{event.summary}</p>
                    <time dateTime={event.at}>
                      {new Date(event.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </section>
  );
}
