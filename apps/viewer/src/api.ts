import type {
  GraphSnapshot,
  GraphSummary,
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
  readonly lastEventSequence: number;
  readonly capturedAt: string;
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
