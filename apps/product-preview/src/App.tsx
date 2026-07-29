import {
  GraphDetailRegion,
  GraphOverviewRegion,
  type ViewerConnection,
} from "@burn-graph/design-system";
import { useState } from "react";

import { previewDetails, previewGraphs } from "./fixtures.ts";

type Scene = "overview" | "detail" | "empty" | "reconnecting";

export function App() {
  const [scene, setScene] = useState<Scene>("overview");
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(
    "delivery-v0.1",
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("core");
  const connection: ViewerConnection =
    scene === "reconnecting" ? "reconnecting" : "connected";
  const detail = selectedGraphId ? previewDetails[selectedGraphId] : undefined;

  return (
    <>
      <nav className="preview-controls" aria-label="Product Preview controls">
        <strong>Product Preview · v1</strong>
        <div>
          {(["overview", "detail", "empty", "reconnecting"] as const).map(
            (value) => (
              <button
                key={value}
                type="button"
                className={scene === value ? "is-active" : ""}
                onClick={() => setScene(value)}
              >
                {value}
              </button>
            ),
          )}
        </div>
      </nav>

      {scene === "detail" && detail ? (
        <GraphDetailRegion
          graph={detail}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          onBack={() => setScene("overview")}
        />
      ) : (
        <GraphOverviewRegion
          graphs={scene === "empty" ? [] : previewGraphs}
          selectedGraphId={selectedGraphId}
          connection={connection}
          onSelect={(graphId) => {
            setSelectedGraphId(graphId);
            setSelectedNodeId(null);
            setScene("detail");
          }}
        />
      )}
    </>
  );
}
