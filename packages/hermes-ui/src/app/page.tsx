'use client';
import { useEffect, useState } from 'react';
import { api, type StatusResponse } from '@/lib/api';
import { Card, Stat } from '@/components/Card';

export default function OverviewPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await api.status();
        if (alive) { setData(d); setError(null); }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (error) return <div className="text-error">Cannot reach dashboard-live: {error}. Run <code className="bg-bg-card px-2 py-1 rounded">pnpm auto:dashboard-live</code> first.</div>;
  if (!data) return <div className="text-muted">Loading…</div>;

  if (data.note) return <div className="text-muted bg-bg-card rounded-lg p-6">{data.note}</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <span className="text-xs text-muted font-mono">last update: {data.ts}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        <Card title="Run / Tasks">
          <Stat label="Run" value={data.run.id || '—'} />
          <Stat label="Total" value={data.run.total} />
          <div className="border-t border-bg-hover my-2"></div>
          {Object.entries(data.run.states).map(([state, n]) => (
            <Stat key={state} label={state} value={n} color={state === 'merged' || state === 'promotable' || state === 'ready-for-merge' ? 'text-success' : state === 'needs-revision' || state === 'parked' ? 'text-warn' : 'text-white'} />
          ))}
        </Card>

        <Card title="Drivers">
          {data.drivers.length === 0 ? (
            <div className="text-muted italic">none active</div>
          ) : (
            <div className="space-y-1">
              {data.drivers.map(d => (
                <div key={d.pid} className="flex justify-between text-sm">
                  <span className="font-mono">PID {d.pid}</span>
                  <span className="text-muted">{d.etime}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Council Health">
          <Stat label="passed" value={data.council_health.passed} color="text-success" />
          <Stat label="failed" value={data.council_health.failed} color="text-error" />
          <Stat label="pending" value={data.council_health.pending} color="text-warn" />
          <Stat label="eval-error" value={data.council_health.eval_error} />
        </Card>

        <Card title="Recent Merges">
          {data.recent_merges.length === 0 ? <div className="text-muted italic">none</div> : (
            <ul className="space-y-1 text-sm">
              {data.recent_merges.slice(0, 8).map(m => (
                <li key={m.pr} className="flex gap-3">
                  <span className="font-mono text-accent">#{m.pr}</span>
                  <span className="text-muted truncate">{m.branch}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Parked Queue">
          <div className="text-3xl font-bold text-warn">{data.parked_count}</div>
          <div className="text-xs text-muted mt-1">tasks awaiting operator drain</div>
        </Card>

        <Card title="Resources">
          <Stat label="Disk used" value={`${data.disk.used_gb}/${data.disk.used_gb + data.disk.free_gb} GB (${data.disk.pct}%)`} />
          <Stat label="Worktrees" value={data.worktrees} />
        </Card>
      </div>
    </div>
  );
}
