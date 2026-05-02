'use client';
import { useState } from 'react';
import { api, type ReplayResponse } from '@/lib/api';
import { Card } from '@/components/Card';

export default function ReplayPage() {
  const [taskId, setTaskId] = useState('');
  const [data, setData] = useState<ReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!taskId.trim()) return;
    setLoading(true); setError(null); setData(null);
    try {
      const r = await api.replay(taskId.trim());
      if (r.error) setError(r.error);
      else setData(r);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Replay</h1>

      <Card>
        <div className="flex gap-3">
          <input
            value={taskId}
            onChange={e => setTaskId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && load()}
            placeholder="TP-2026-05-02-001"
            className="flex-1 bg-bg-hover border border-bg-hover rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-accent"
          />
          <button onClick={load} disabled={loading} className="bg-accent text-bg px-5 py-2 rounded text-sm font-semibold hover:bg-accent-subtle disabled:opacity-50">
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>
      </Card>

      {error && <div className="text-error bg-bg-card rounded p-4">{error}</div>}

      {data && (
        <>
          <Card>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <Field label="Task" value={data.task_id} mono />
              <Field label="Module" value={data.module} />
              <Field label="Type" value={data.type} />
              <Field label="State" value={data.state} />
            </div>
          </Card>

          <Card title={`Timeline · ${data.transitions.length} transition(s)`}>
            <div className="space-y-3 relative">
              {data.transitions.map((t, i) => (
                <div key={i} className="border-l-2 border-bg-hover pl-4 py-1">
                  <div className="text-xs text-muted font-mono">{t.at} · {t.by}</div>
                  <div className="text-sm">
                    <span className="text-muted">{t.from}</span> → <span className="text-accent font-semibold">{t.to}</span>
                  </div>
                  {t.reason && <div className="text-xs text-muted mt-1">{t.reason}</div>}
                  {t.chain_hash && <div className="text-[10px] text-muted font-mono mt-0.5">chain: {t.chain_hash.slice(0, 16)}…</div>}
                </div>
              ))}
            </div>
          </Card>

          {data.codex_rounds && data.codex_rounds.length > 0 && (
            <Card title={`Codex rounds · ${data.codex_rounds.length}`}>
              <table className="w-full text-sm">
                <tbody>
                  {data.codex_rounds.map(r => (
                    <tr key={r.round} className="border-t border-bg-hover first:border-t-0">
                      <td className="py-2 font-mono">R{r.round}</td>
                      <td className="py-2 font-mono">{r.score}/10</td>
                      <td className={`py-2 font-semibold ${r.verdict === 'GO' ? 'text-success' : 'text-error'}`}>{r.verdict}</td>
                      <td className="py-2 text-xs text-muted font-mono">{r.at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {data.council_sidecars && data.council_sidecars.length > 0 && (
            <Card title="Council sidecars">
              {data.council_sidecars.map((c, i) => (
                <div key={i} className="flex gap-4 py-1 text-sm">
                  <span className="font-mono">{c.phase}</span>
                  <span className={c.status === 'passed' ? 'text-success' : c.status === 'failed' ? 'text-error' : 'text-warn'}>{c.status}</span>
                  {c.score && <span className="text-muted">{c.score}/10</span>}
                </div>
              ))}
            </Card>
          )}

          {data.evidence && data.evidence.length > 0 && (
            <Card title={`Evidence · ${data.evidence.length} file(s)`}>
              <table className="w-full text-sm">
                <tbody>
                  {data.evidence.map(e => (
                    <tr key={e.name} className="border-t border-bg-hover first:border-t-0">
                      <td className="py-1.5 font-mono">{e.name}</td>
                      <td className="py-1.5 text-muted text-right">{(e.size / 1024).toFixed(1)} KB</td>
                      <td className="py-1.5 text-xs text-muted font-mono pl-4">{e.mtime}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted uppercase tracking-wider">{label}</div>
      <div className={`text-sm mt-1 ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
