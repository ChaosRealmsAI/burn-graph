import { BurnGraphError, BurnGraphService } from "@burn-graph/core";
import { renderGraphArtifact } from "@burn-graph/render";

const root = process.argv[2];
const runId = process.argv[3];
if (!root || !runId) throw new Error("Expected project root and Run ID");

const service = new BurnGraphService(root);
const snapshot = service.getSnapshot(runId, 0);
service.close();

try {
  await renderGraphArtifact({
    projectRoot: root,
    snapshot,
    format: "svg",
    timeoutMs: 1,
  });
  throw new Error("Expected render timeout");
} catch (error) {
  if (!(error instanceof BurnGraphError) || error.code !== "RENDER_TIMEOUT") {
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      errorCode: error.code,
    })}\n`,
  );
}
