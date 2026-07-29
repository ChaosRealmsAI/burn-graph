import type { ReadyWork, RunPriority } from "./contracts.ts";

export const PRIORITY_AGING_INTERVAL_MS = 5 * 60 * 1_000;

const PRIORITY_RANK: Readonly<Record<RunPriority, number>> = {
  low: 0,
  normal: 1,
  high: 2,
};

const PRIORITY_BY_RANK: readonly RunPriority[] = [
  "low",
  "normal",
  "high",
];

export function effectivePriority(
  priority: RunPriority,
  readySince: string,
  now: Date,
): RunPriority {
  const readyAt = new Date(readySince).getTime();
  const waited = Number.isFinite(readyAt)
    ? Math.max(0, now.getTime() - readyAt)
    : 0;
  const agingLevels = Math.floor(waited / PRIORITY_AGING_INTERVAL_MS);
  const rank = Math.min(2, PRIORITY_RANK[priority] + agingLevels);
  return PRIORITY_BY_RANK[rank]!;
}

export function orderReadyWork(
  work: readonly ReadyWork[],
  actorId: string,
  preferredRunId?: string,
): readonly ReadyWork[] {
  const actorRank = (candidate: ReadyWork): number =>
    candidate.actorHint === actorId
      ? 0
      : candidate.actorHint === null
        ? 1
        : 2;
  const preferredRank = (candidate: ReadyWork): number =>
    candidate.runId === preferredRunId ||
    candidate.rootRunId === preferredRunId
      ? 0
      : 1;
  return [...work].sort(
    (left, right) =>
      PRIORITY_RANK[right.effectivePriority] -
        PRIORITY_RANK[left.effectivePriority] ||
      left.readySince.localeCompare(right.readySince) ||
      preferredRank(left) - preferredRank(right) ||
      actorRank(left) - actorRank(right) ||
      left.depth - right.depth ||
      left.runId.localeCompare(right.runId) ||
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.nodeId.localeCompare(right.nodeId),
  );
}
