import { describe, expect, test } from "bun:test";

import { BurnGraphService } from "@burn-graph/core";

import {
  createTestProject,
  parallelGraph,
  removeTestProject,
} from "../helpers/fixtures.ts";

describe("Mermaid projection", () => {
  test("uses encoded ids, escaped labels, and runtime status classes", () => {
    const root = createTestProject();
    const service = new BurnGraphService(root);
    try {
      const graph = parallelGraph("safe-mermaid");
      service.applyGraph({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "left"
            ? { ...node, title: "Review <unsafe> & \"quoted\" | line\nnext" }
            : node,
        ),
      });
      const snapshot = service.startRun("safe-mermaid", "safe-mermaid:run").value;
      expect(snapshot.mermaid).toContain(
        "Review &lt;unsafe&gt; &amp; 'quoted'",
      );
      expect(snapshot.mermaid).not.toContain("<unsafe>");
      expect(snapshot.mermaid).toContain("&#124; line next");
      expect(snapshot.mermaid).toContain(":::ready");
      expect(snapshot.mermaid).toContain("n_6c656674");
    } finally {
      service.close();
      removeTestProject(root);
    }
  });
});
