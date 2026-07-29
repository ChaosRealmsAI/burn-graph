import type { ViewerConnection } from "../types.ts";

const copy: Record<ViewerConnection, string> = {
  connected: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

export function ConnectionBadge({
  connection,
}: {
  readonly connection: ViewerConnection;
}) {
  return (
    <span className={`bg-connection bg-connection--${connection}`} role="status">
      <i aria-hidden="true" />
      {copy[connection]}
    </span>
  );
}
