import { ProgressBar } from "../primitives/ProgressBar.tsx";
import { StatusPill } from "../primitives/StatusPill.tsx";
import type { GraphSummaryView } from "../types.ts";

function progress(graph: GraphSummaryView): number {
  if (graph.counts.total === 0) return 0;
  return (
    ((graph.counts.done + graph.counts.skipped) / graph.counts.total) * 100
  );
}

export function GraphCard({
  graph,
  selected,
  onSelect,
}: {
  readonly graph: GraphSummaryView;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <button
      className={`bg-graph-card${selected ? " is-selected" : ""}`}
      type="button"
      onClick={() => onSelect(graph.id)}
      aria-pressed={selected}
    >
      <span className="bg-graph-card__topline">
        <span className="bg-graph-card__id">{graph.id}</span>
        <StatusPill status={graph.status} />
      </span>
      <strong>{graph.title}</strong>
      <span className="bg-graph-card__goal">{graph.goal}</span>
      <span className="bg-graph-card__focus">
        <i aria-hidden="true" />
        {graph.focusedNodeTitle ?? "No node in progress"}
      </span>
      <ProgressBar value={progress(graph)} label={`${graph.title} progress`} />
      <span className="bg-graph-card__counts">
        <span>
          <b>{graph.counts.done}</b> done
        </span>
        <span>
          <b>{graph.counts.running}</b> running
        </span>
        <span>
          <b>{graph.counts.ready}</b> ready
        </span>
      </span>
    </button>
  );
}
