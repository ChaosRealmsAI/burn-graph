import type {
  GraphSnapshot,
  GraphSummary,
  GraphTreeSnapshot,
  PortfolioRun,
  RuntimeMetrics,
} from "@burn-graph/core";

interface ApiEnvelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ProjectSnapshotResponse {
  readonly projectId: string;
  readonly runs: readonly GraphSummary[];
  readonly rootRuns: readonly PortfolioRun[];
  readonly lastEventSequence: number;
  readonly capturedAt: string;
  readonly metrics: RuntimeMetrics;
}

async function request<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !envelope.ok || envelope.data === undefined) {
    throw new Error(envelope.error?.message ?? `Request failed: ${response.status}`);
  }
  return envelope.data;
}

export function fetchProjectSnapshot(): Promise<ProjectSnapshotResponse> {
  return request<ProjectSnapshotResponse>("/api/snapshot");
}

export function fetchGraph(reference: string): Promise<GraphSnapshot> {
  return request<GraphSnapshot>(`/api/graphs/${encodeURIComponent(reference)}`);
}

export function fetchTree(
  reference: string,
  depth: number,
  limit = 500,
): Promise<GraphTreeSnapshot> {
  const query = new URLSearchParams({
    depth: String(depth),
    limit: String(limit),
  });
  return request<GraphTreeSnapshot>(
    `/api/trees/${encodeURIComponent(reference)}?${query}`,
  );
}
