export function MetricTile({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <article className={`metric-tile${accent ? " metric-tile--accent" : ""}`}>
      <span className="metric-tile__label">{label}</span>
      <strong className="metric-tile__value">{value}</strong>
    </article>
  );
}
