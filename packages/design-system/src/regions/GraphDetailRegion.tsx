import { MermaidCanvas } from "../components/MermaidCanvas.tsx";
import { NodeDetailPanel } from "../components/NodeDetailPanel.tsx";
import { StatusPill } from "../primitives/StatusPill.tsx";
import type { GraphDetailView } from "../types.ts";

const statusOrder = [
  "ready",
  "running",
  "done",
  "blocked",
  "failed",
  "pending",
  "skipped",
] as const;

export function GraphDetailRegion({
  graph,
  selectedNodeId,
  onSelectNode,
  onBack,
}: {
  readonly graph: GraphDetailView;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onBack: () => void;
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
