'use client';
import { useEffect, useState } from 'react';
import { api, type CostResponse } from '@/lib/api';
import { Card } from '@/components/Card';

export default function CostPage() {
  const [data, setData] = useState<CostResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => api.cost().then(d => { if (alive) setData(d); }).catch((e: Error) => { if (alive) setError(e.message); });
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (error) return <div className="text-error">Cannot load cost: {error}</div>;
  if (!data) return <div className="text-muted">Loading…</div>;

  if (!data.run_id || data.per_task.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Cost</h1>
        <Card>
          <p className="text-muted italic">No cost telemetry recorded yet for run <code>{data.run_id ?? '(none)'}</code>.</p>
          <p className="text-xs text-muted mt-2">Cost is captured when workers report <code>est_usd</code> in pack.cost_telemetry.</p>
        </Card>
      </div>
    );
  }

  const max = Math.max(...data.per_task.map(t => t.usd)) || 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Cost</h1>
        <p className="text-muted text-sm mt-1">
          Run <code className="text-accent">{data.run_id}</code> total:{' '}
          <span className="text-2xl font-bold text-accent ml-2">${data.total_usd.toFixed(3)}</span>{' '}
          across {data.per_task.length} task(s).
        </p>
      </div>

      <Card>
        <table className="w-full text-sm">
          <thead className="text-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left py-2">Task</th>
              <th className="text-left py-2">Module</th>
              <th className="text-left py-2 hidden md:table-cell">Type</th>
              <th className="text-left py-2 hidden md:table-cell">State</th>
              <th className="text-right py-2">USD</th>
              <th className="text-left py-2 pl-4">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.per_task.map(t => (
              <tr key={t.task_id} className="border-t border-bg-hover">
                <td className="py-2 pr-3 font-mono">{t.task_id}</td>
                <td className="py-2 pr-3 text-muted">{t.module}</td>
                <td className="py-2 pr-3 text-muted hidden md:table-cell">{t.type}</td>
                <td className="py-2 pr-3 text-muted hidden md:table-cell">{t.state}</td>
                <td className="py-2 text-right font-mono">${t.usd.toFixed(3)}</td>
                <td className="py-2 pl-4 w-48">
                  <div className="h-1.5 bg-bg-hover rounded overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${(100 * t.usd / max).toFixed(1)}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
