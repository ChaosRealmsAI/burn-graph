// Shared by the performance scripts, which all report a p95 tail.
//
// It was defined identically in control-performance.ts and
// portfolio-performance.ts. A percentile with two definitions is a budget with
// two meanings the moment one of them is corrected.

export function percentile95(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}
