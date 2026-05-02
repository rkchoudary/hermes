/**
 * Tiny client wrappers around the dashboard-live REST surface.
 * All fetches happen server-side in Server Components or via SWR-style
 * useEffect in Client Components.
 */

export interface StatusResponse {
  ts: string;
  run: { id: string; states: Record<string, number>; total: number };
  parked_count: number;
  recent_merges: Array<{ pr: number; branch: string; merged_at?: string }>;
  council_health: { passed: number; failed: number; pending: number; eval_error: number };
  disk: { used_gb: number; free_gb: number; pct: number };
  worktrees: number;
  drivers: Array<{ pid: number; etime: string; cmd: string }>;
  note?: string;
}

export interface EnginesResponse {
  ts: string;
  engines: Array<{ key: string; bin: string; description: string; available: boolean; binPath: string | null }>;
}

export interface CostResponse {
  ts: string;
  run_id: string | null;
  total_usd: number;
  per_task: Array<{ task_id: string; module: string; type: string; state: string; usd: number; entries: number }>;
}

export interface ReplayResponse {
  task_id: string;
  run_id: string;
  type: string;
  module: string;
  state: string;
  transitions: Array<{ at: string; from: string; to: string; by: string; reason?: string; chain_hash?: string }>;
  codex_rounds: Array<{ round: number; score: number; verdict: string; at: string }>;
  evidence: Array<{ name: string; size: number; mtime: string }>;
  council_sidecars: Array<{ phase: string; status: string; score?: number }>;
  error?: string;
}

async function get<T>(p: string): Promise<T> {
  const r = await fetch(p, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  status: () => get<StatusResponse>('/api/status'),
  engines: () => get<EnginesResponse>('/api/engines'),
  cost: () => get<CostResponse>('/api/cost'),
  replay: (id: string) => get<ReplayResponse>(`/api/replay/${encodeURIComponent(id)}`),
};
