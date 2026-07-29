import type {
  VisualGraphStatus,
  VisualNodeStatus,
} from "../types.ts";

const labels: Record<VisualNodeStatus | VisualGraphStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  draft: "Draft",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function StatusPill({
  status,
}: {
  readonly status: VisualNodeStatus | VisualGraphStatus;
}) {
  return (
    <span className={`bg-status bg-status--${status}`}>
      <span className="bg-status__dot" aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
