'use client';
import { useEffect, useState } from 'react';
import { api, type EnginesResponse } from '@/lib/api';
import { Card } from '@/components/Card';

export default function EnginesPage() {
  const [data, setData] = useState<EnginesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.engines().then(setData).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="text-error">Cannot load engines: {error}</div>;
  if (!data) return <div className="text-muted">Loading…</div>;

  const available = data.engines.filter(e => e.available).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Engines</h1>
        <p className="text-muted text-sm mt-1">{available} of {data.engines.length} engines detected on PATH.</p>
      </div>

      <Card>
        <table className="w-full text-sm">
          <thead className="text-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left py-2"></th>
              <th className="text-left py-2">Engine</th>
              <th className="text-left py-2">Bin</th>
              <th className="text-left py-2 hidden md:table-cell">Path</th>
              <th className="text-left py-2 hidden lg:table-cell">Description</th>
            </tr>
          </thead>
          <tbody>
            {data.engines.map(e => (
              <tr key={e.key} className="border-t border-bg-hover">
                <td className="py-3 pr-3">
                  <span className={e.available ? 'text-success' : 'text-error'}>{e.available ? '✓' : '✗'}</span>
                </td>
                <td className="py-3 pr-3 font-mono">{e.key}</td>
                <td className="py-3 pr-3 text-muted">{e.bin}</td>
                <td className="py-3 pr-3 text-muted truncate max-w-xs hidden md:table-cell font-mono text-xs">{e.binPath || '—'}</td>
                <td className="py-3 text-muted hidden lg:table-cell">{e.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <p className="text-xs text-muted">
        Install missing engines via their official channels. Hermes checks PATH at runtime — no rebuild needed after install.
      </p>
    </div>
  );
}
