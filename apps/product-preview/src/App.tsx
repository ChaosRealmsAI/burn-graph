import {
  GraphDetailRegion,
  GraphOverviewRegion,
  type GraphDetailView,
  type ViewerConnection,
} from "@burn-graph/design-system";
import { useState } from "react";

import {
  dogfoodMetricsDetail,
  durableWaitDetail,
  gateRepairDetail,
  hierarchyExpandedDetail,
  hierarchyFoldedDetail,
  lifecycleControlDetail,
  previewDetails,
  previewGraphs,
  resourceContentionDetail,
} from "./fixtures.ts";

type Scene =
  | "hierarchy-overview"
  | "hierarchy-expanded"
  | "gate-repair"
  | "durable-wait"
  | "lifecycle-control"
  | "template-portfolio"
  | "resource-contention"
  | "dogfood-metrics"
  | "empty"
  | "reconnecting";

const scenes: readonly Scene[] = [
  "hierarchy-overview",
  "hierarchy-expanded",
  "gate-repair",
  "durable-wait",
  "lifecycle-control",
  "template-portfolio",
  "resource-contention",
  "dogfood-metrics",
  "empty",
  "reconnecting",
];

function detailForScene(
  scene: Scene,
  expanded: boolean,
): GraphDetailView | null {
  switch (scene) {
    case "hierarchy-expanded":
      return expanded ? hierarchyExpandedDetail : hierarchyFoldedDetail;
    case "gate-repair":
      return gateRepairDetail;
    case "resource-contention":
      return resourceContentionDetail;
    case "durable-wait":
      return durableWaitDetail;
    case "lifecycle-control":
      return lifecycleControlDetail;
    case "dogfood-metrics":
      return dogfoodMetricsDetail;
    default:
      return null;
  }
}

export function App() {
  const [scene, setScene] = useState<Scene>("hierarchy-overview");
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(
    "delivery-rc1",
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("slices");
  const [expanded, setExpanded] = useState(true);
  const connection: ViewerConnection =
    scene === "reconnecting" ? "reconnecting" : "connected";
  const sceneDetail = detailForScene(scene, expanded);
  const selectedDetail = selectedGraphId
    ? previewDetails[selectedGraphId]
    : undefined;
  const detail = sceneDetail ?? selectedDetail;
  const showDetail =
    sceneDetail !== null ||
    (scene === "hierarchy-expanded" && selectedDetail !== undefined);

  return (
    <>
      <nav className="preview-controls" aria-label="Product Preview controls">
        <strong>Product Preview · v2 hierarchy contract</strong>
        <div>
          {scenes.map((value) => (
            <button
              key={value}
              type="button"
              className={scene === value ? "is-active" : ""}
              onClick={() => {
                setScene(value);
                setSelectedNodeId(null);
                if (value === "hierarchy-expanded") setExpanded(true);
              }}
            >
              {value}
            </button>
          ))}
        </div>
      </nav>

      {showDetail && detail ? (
        <GraphDetailRegion
          graph={detail}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          onSelectGraph={(graphId) => {
            setSelectedGraphId(graphId);
            setSelectedNodeId(null);
          }}
          onToggleHierarchy={() => setExpanded((current) => !current)}
          onBack={() => setScene("hierarchy-overview")}
        />
      ) : (
        <GraphOverviewRegion
          graphs={scene === "empty" ? [] : previewGraphs}
          selectedGraphId={selectedGraphId}
          connection={connection}
          metrics={{
            activeResources: scene === "resource-contention" ? 1 : 0,
            contendedNodes: scene === "resource-contention" ? 1 : 0,
            maximumLiveAssignments: 4,
            attempts: 17,
            recoveries: 1,
          }}
          onSelect={(graphId) => {
            setSelectedGraphId(graphId);
            setSelectedNodeId(null);
            setScene(
              graphId === "delivery-rc1"
                ? "hierarchy-expanded"
                : graphId === "release-package"
                  ? "durable-wait"
                  : "gate-repair",
            );
          }}
        />
      )}
    </>
  );
}
