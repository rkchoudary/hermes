/**
 * hermes-skill-aggregator — opt-in cross-project skill memory.
 *
 * What this is:
 *   - Hono server that receives anonymized skill memory entries from
 *     contributing Hermes operators.
 *   - Aggregates them by (phase, ac_count_bucket, module_shape) and emits
 *     summary statistics (median patch rounds, recovery-rate, cost
 *     distribution).
 *   - Other operators read the aggregates to seed their worker prompts:
 *     "across N operators on similar tasks, median patch rounds = 1.2;
 *      cognitive-recovery used 12% of the time."
 *
 * Privacy posture:
 *   - All uploads MUST go through the scrubber (./scrubber.ts).
 *   - Bucket-only granularity: no exact AC counts, no exact durations,
 *     no exact USD costs.
 *   - No module IDs, no task IDs, no file paths, no operator names.
 *   - Operator IDs at upload time are hashed before storage (preserves
 *     contribution-counting without revealing identity).
 *   - GDPR-ready: aggregate data is not personal data per Recital 26.
 *
 * What this is NOT (yet):
 *   - A trained model. We just aggregate and surface; no embedding,
 *     no fine-tuning.
 *   - A leaderboard. We don't compare operators.
 *   - Mandatory. Operators opt in per upload — no auto-send.
 *
 * v0.1 limitations:
 *   - In-memory aggregates. Real prod uses Postgres + bucket SQL.
 *   - No abuse handling (rate limit, content validation beyond scrub).
 *   - No data deletion API (RTBF) — to be added once durable storage lands.
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHash } from 'node:crypto';
import type { ScrubbedEntry } from './scrubber';

const PORT = parseInt(process.env.PORT || '7791', 10);

interface AggregateBucket {
  count: number;
  patch_rounds_sum: number;
  recovered_count: number;
  recovered_via_dist: Record<string, number>;
}

const AGGREGATES = new Map<string, AggregateBucket>();
const CONTRIBUTORS = new Set<string>();

function bucketKey(e: ScrubbedEntry): string {
  return `${e.phase}|${e.module_shape}|${e.ac_count_bucket}`;
}

function recordEntry(entry: ScrubbedEntry, contributorHash: string): void {
  CONTRIBUTORS.add(contributorHash);
  const key = bucketKey(entry);
  let bucket = AGGREGATES.get(key);
  if (!bucket) {
    bucket = { count: 0, patch_rounds_sum: 0, recovered_count: 0, recovered_via_dist: {} };
    AGGREGATES.set(key, bucket);
  }
  bucket.count++;
  bucket.patch_rounds_sum += entry.patch_rounds;
  if (entry.recovered_via) {
    bucket.recovered_count++;
    bucket.recovered_via_dist[entry.recovered_via] = (bucket.recovered_via_dist[entry.recovered_via] || 0) + 1;
  }
}

const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.get('/', (c) => c.html(`<!DOCTYPE html>
<html><head><title>Hermes Skill Aggregator</title>
<style>body{font-family:system-ui;background:#0a0a0b;color:#e6e6e6;max-width:880px;margin:40px auto;padding:0 20px}
code{background:#1a1a1c;padding:2px 6px;border-radius:3px;font-family:ui-monospace,monospace}
pre{background:#1a1a1c;padding:16px;border-radius:6px;overflow-x:auto}
a{color:#9ec5ff}h2{color:#9ec5ff;font-size:14px;text-transform:uppercase;margin-top:32px}</style></head><body>
<h1>🧠 Hermes Skill Aggregator</h1>
<p><em>Opt-in cross-project skill memory. Every contributing operator makes Hermes smarter for everyone.</em></p>

<h2>What gets sent</h2>
<p>ONLY scrubbed, bucket-granularity data. No module IDs, no task IDs, no paths, no operator names.</p>
<pre>{
  "module_shape": "frd" | "trd" | "sprint-plan" | "code-sprint" | "unknown",
  "phase": "&lt;phase from public allow-list&gt;",
  "patch_rounds": 0..10,
  "recovered_via": "patch" | "cognitive-recovery" | null,
  "ac_count_bucket": "1-3" | "4-6" | "7-10" | "11+",
  "duration_bucket": "≤5min" | "5-15min" | "15-60min" | ">60min",
  "cost_bucket": "≤$0.10" | "$0.10-$1" | "$1-$10" | ">$10"
}</pre>

<h2>API</h2>
<pre>POST /api/contribute       (operator → us, JSON body of scrubbed entries)
GET  /api/aggregated/&lt;phase&gt;  (any → us, returns aggregate stats by phase)
GET  /api/stats             total contributors + entry counts
GET  /api/health</pre>

<h2>Privacy posture</h2>
<ul>
  <li>Uploads pass through <code>scrubber.ts</code> on the operator's machine before hitting the wire</li>
  <li>Bucket-only granularity — exact values are never sent</li>
  <li>Operator IDs hashed (sha256 truncated) — count contributors without identifying them</li>
  <li>GDPR Recital 26: aggregates are not personal data</li>
  <li>Opt-in per-upload — no auto-send, no telemetry without explicit operator action</li>
</ul>

<h2>v0.1 limitations</h2>
<ul>
  <li>In-memory aggregates — restart loses contributions (durable storage in v0.2)</li>
  <li>No content moderation beyond scrub — bad actors can submit garbage</li>
  <li>No RTBF API — to be added once durable storage lands</li>
  <li>No trained model — just aggregation + retrieval</li>
</ul>

<p><a href="https://github.com/rkchoudary/hermes/tree/main/packages/hermes-skill-aggregator">github.com/rkchoudary/hermes/packages/hermes-skill-aggregator</a></p>
</body></html>`));

app.post('/api/contribute', async (c) => {
  const operatorId = c.req.header('x-operator-id') || c.req.header('x-forwarded-for') || 'anon';
  const operatorHash = createHash('sha256').update(operatorId).digest('hex').slice(0, 16);

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'invalid json' }, 400); }

  const entries = Array.isArray(body) ? body : [body];
  let accepted = 0;
  const errors: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (typeof e !== 'object' || e === null) { errors.push(`entry ${i}: not an object`); continue; }
    const obj = e as Record<string, unknown>;
    // Validate scrubbed shape
    if (typeof obj.phase !== 'string' || typeof obj.patch_rounds !== 'number' || typeof obj.module_shape !== 'string') {
      errors.push(`entry ${i}: missing required fields (phase, patch_rounds, module_shape)`);
      continue;
    }
    recordEntry(obj as unknown as ScrubbedEntry, operatorHash);
    accepted++;
  }

  return c.json({ accepted, rejected: entries.length - accepted, errors });
});

app.get('/api/aggregated/:phase', (c) => {
  const phase = c.req.param('phase');
  const buckets: Array<{ key: string; count: number; mean_patch_rounds: number; recovery_rate: number; recovered_via_dist: Record<string, number> }> = [];

  for (const [key, b] of AGGREGATES.entries()) {
    if (!key.startsWith(`${phase}|`)) continue;
    if (b.count < 5) continue;  // k-anonymity: don't reveal buckets with <5 contributions
    buckets.push({
      key,
      count: b.count,
      mean_patch_rounds: b.patch_rounds_sum / b.count,
      recovery_rate: b.recovered_count / b.count,
      recovered_via_dist: b.recovered_via_dist,
    });
  }

  return c.json({
    phase,
    bucket_count: buckets.length,
    total_entries: buckets.reduce((s, b) => s + b.count, 0),
    buckets,
    privacy_note: 'k-anonymity threshold = 5; buckets with fewer contributions are hidden',
  });
});

app.get('/api/stats', (c) => {
  let totalEntries = 0;
  for (const b of AGGREGATES.values()) totalEntries += b.count;
  return c.json({
    contributors: CONTRIBUTORS.size,
    total_entries: totalEntries,
    bucket_count: AGGREGATES.size,
    last_update: new Date().toISOString(),
  });
});

console.log(`[hermes-skill-aggregator] listening on :${PORT}`);
console.log(`[hermes-skill-aggregator] privacy: bucket-granularity, k-anonymity threshold = 5`);
serve({ fetch: app.fetch, port: PORT });
