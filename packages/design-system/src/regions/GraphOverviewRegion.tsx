import { Brand } from "../components/Brand.tsx";
import { ConnectionBadge } from "../components/ConnectionBadge.tsx";
import { GraphCard } from "../components/GraphCard.tsx";
import type {
  GraphSummaryView,
  PortfolioMetricsView,
  ViewerConnection,
} from "../types.ts";

export function GraphOverviewRegion({
  graphs,
  selectedGraphId,
  connection,
  metrics = null,
  onSelect,
}: {
  readonly graphs: readonly GraphSummaryView[];
  readonly selectedGraphId: string | null;
  readonly connection: ViewerConnection;
  readonly metrics?: PortfolioMetricsView | null;
  readonly onSelect: (graphId: string) => void;
}) {
  const running = graphs.reduce(
    (count, graph) => count + graph.counts.running,
    0,
  );
  const ready = graphs.reduce(
    (count, graph) => count + graph.counts.ready,
    0,
  );
  const waiting = graphs.reduce(
    (count, graph) => count + (graph.counts.waiting ?? 0),
    0,
  );
  const roots = graphs.filter(
    (graph) => !graph.hierarchy || graph.hierarchy.depth === 0,
  ).length;

  return (
    <section className="bg-overview" aria-label="Graph overview">
      <header className="bg-topbar">
        <Brand />
        <ConnectionBadge connection={connection} />
      </header>

      <div className="bg-overview__intro">
        <div>
          <span className="bg-eyebrow">Project control plane</span>
          <h1>Delivery trees, one truthful view.</h1>
          <p>
            Fold large delivery into durable child Runs, expand only what needs
            attention, and keep every transition local.
          </p>
        </div>
        <dl className="bg-overview__totals">
          <div>
            <dt>Roots</dt>
            <dd>{roots}</dd>
          </div>
          <div>
            <dt>Running</dt>
            <dd>{running}</dd>
          </div>
          <div>
            <dt>Ready</dt>
            <dd>{ready}</dd>
          </div>
          <div>
            <dt>Waiting</dt>
            <dd>{waiting}</dd>
          </div>
          {metrics ? (
            <>
              <div>
                <dt>Peak live</dt>
                <dd>{metrics.maximumLiveAssignments}</dd>
              </div>
              <div>
                <dt>Locks</dt>
                <dd>{metrics.activeResources}</dd>
              </div>
              <div>
                <dt>Contended</dt>
                <dd>{metrics.contendedNodes}</dd>
              </div>
              <div>
                <dt>Attempts / recoveries</dt>
                <dd>{metrics.attempts} / {metrics.recoveries}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </div>

      {graphs.length === 0 ? (
        <div className="bg-empty-state">
          <span aria-hidden="true">⌁</span>
          <h2>No graphs yet</h2>
          <p>
            Initialize a graph from the CLI, then this surface will update
            automatically.
          </p>
          <code>burn-graph graph apply --input graph.json</code>
        </div>
      ) : (
        <div className="bg-graph-grid">
          {graphs.map((graph) => (
            <GraphCard
              key={graph.id}
              graph={graph}
              selected={selectedGraphId === graph.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}
