export function Card({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-bg-card rounded-lg border border-bg-card p-5 ${className}`}>
      {title && (
        <h2 className="text-xs uppercase tracking-wider text-accent mb-3 font-semibold">{title}</h2>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value, color = 'text-white' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex items-baseline justify-between py-1">
      <span className="text-sm text-muted">{label}</span>
      <span className={`font-mono text-sm ${color}`}>{value}</span>
    </div>
  );
}
