import {
  GraphDetailRegion,
  GraphOverviewRegion,
  type GraphDetailView,
  type GraphSummaryView,
  type ViewerConnection,
} from "@burn-graph/design-system";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchProjectSnapshot, fetchTree } from "./api.ts";
import { graphSummaryView, graphTreeDetailView } from "./view-model.ts";

export function App() {
  const [graphs, setGraphs] = useState<readonly GraphSummaryView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [projectionDepth, setProjectionDepth] = useState(0);
  const [detail, setDetail] = useState<GraphDetailView | null>(null);
  const [connection, setConnection] =
    useState<ViewerConnection>("reconnecting");
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef(0);

  const refresh = useCallback(async () => {
    const snapshot = await fetchProjectSnapshot();
    cursor.current = Math.max(cursor.current, snapshot.lastEventSequence);
    setGraphs(
      snapshot.rootRuns.map((run) =>
        graphSummaryView(run.summary, {
          directChildRuns: run.directChildRuns,
          descendantRuns: run.descendantRuns,
        }),
      ),
    );
    if (selectedRunId) {
      const graph = await fetchTree(selectedRunId, projectionDepth);
      setDetail(graphTreeDetailView(graph));
    }
  }, [projectionDepth, selectedRunId]);

  useEffect(() => {
    let cancelled = false;
    void refresh()
      .then(() => {
        if (!cancelled) {
          setConnection("connected");
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setConnection("offline");
          setError(reason instanceof Error ? reason.message : "Viewer unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    const source = new EventSource(`/api/events?after=${cursor.current}`);
    source.onopen = () => setConnection("connected");
    source.onerror = () => setConnection("reconnecting");
    source.onmessage = (event) => {
      const sequence = Number(event.lastEventId);
      if (Number.isInteger(sequence)) cursor.current = Math.max(cursor.current, sequence);
      void refresh().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Refresh failed");
      });
    };
    return () => source.close();
  }, [refresh]);

  const openGraph = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setSelectedNodeId(null);
    setProjectionDepth(0);
    setError(null);
    try {
      setDetail(graphTreeDetailView(await fetchTree(runId, 0)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Graph unavailable");
    }
  }, []);

  if (error && graphs.length === 0) {
    return (
      <main className="viewer-error" role="alert">
        <span>Connection interrupted</span>
        <h1>The local graph state is unavailable.</h1>
        <p>{error}</p>
        <button type="button" onClick={() => void refresh()}>
          Try again
        </button>
      </main>
    );
  }

  if (selectedRunId && detail) {
    return (
      <GraphDetailRegion
        graph={detail}
        selectedNodeId={selectedNodeId}
        onSelectNode={setSelectedNodeId}
        onBack={() => {
          setSelectedRunId(null);
          setDetail(null);
          setProjectionDepth(0);
        }}
        onSelectGraph={(runId) => void openGraph(runId)}
        onToggleHierarchy={() =>
          setProjectionDepth((current) => (current === 0 ? 1 : 0))
        }
      />
    );
  }

  return (
    <GraphOverviewRegion
      graphs={graphs}
      selectedGraphId={selectedRunId}
      connection={connection}
      onSelect={(runId) => void openGraph(runId)}
    />
  );
}
