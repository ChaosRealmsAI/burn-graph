import { StatusPill } from "../primitives/StatusPill.tsx";
import type { NodeView } from "../types.ts";

export function NodeDetailPanel({ node }: { readonly node: NodeView | null }) {
  if (!node) {
    return (
      <aside className="bg-node-detail bg-empty-detail">
        <span className="bg-eyebrow">Node inspector</span>
        <strong>Select a node</strong>
        <p>Choose a node from the list to inspect its prompt contract and result.</p>
      </aside>
    );
  }

  return (
    <aside className="bg-node-detail" aria-label={`Node ${node.title}`}>
      <div className="bg-node-detail__heading">
        <div>
          <span className="bg-eyebrow">
            {node.type} · attempt {node.attempt}
          </span>
          <h2>{node.title}</h2>
        </div>
        <StatusPill status={node.status} />
      </div>

      <dl className="bg-facts">
        <div>
          <dt>Node ID</dt>
          <dd>{node.id}</dd>
        </div>
        <div>
          <dt>Actor</dt>
          <dd>{node.actorId ?? "Unclaimed"}</dd>
        </div>
        {node.route ? (
          <div>
            <dt>Route</dt>
            <dd>{node.route}</dd>
          </div>
        ) : null}
      </dl>

      <section>
        <h3>Objective</h3>
        <p>{node.objective || "Structural node; no external work required."}</p>
      </section>

      {node.instructions.length > 0 ? (
        <section>
          <h3>Instructions</h3>
          <ul>
            {node.instructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {node.doneWhen.length > 0 ? (
        <section>
          <h3>Done when</h3>
          <ul className="bg-checklist">
            {node.doneWhen.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {node.predecessorSummaries.length > 0 ? (
        <section>
          <h3>Upstream results</h3>
          <ul>
            {node.predecessorSummaries.map((summary) => (
              <li key={summary}>{summary}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {node.resultSummary ? (
        <section className="bg-result">
          <h3>Latest result</h3>
          <p>{node.resultSummary}</p>
        </section>
      ) : null}
    </aside>
  );
}
