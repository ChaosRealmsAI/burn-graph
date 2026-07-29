export function ProgressBar({
  value,
  label,
}: {
  readonly value: number;
  readonly label: string;
}) {
  const normalized = Math.max(0, Math.min(100, value));
  return (
    <div
      className="bg-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(normalized)}
    >
      <span style={{ width: `${normalized}%` }} />
    </div>
  );
}
