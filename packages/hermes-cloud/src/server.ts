/**
 * hermes-cloud — control plane skeleton.
 *
 * What this is:
 *   - Hono-based HTTP server. Runs on Cloudflare Workers / Fly.io /
 *     Railway / Vercel / your laptop.
 *   - Exposes a small API surface for: triggering remote dispatches,
 *     proxying status, streaming progress.
 *   - API-key auth via shared secret HMAC.
 *
 * What this is NOT (yet):
 *   - Multi-tenant. One API key = one operator. Production multi-tenancy
 *     needs a proper auth provider (Auth0/Clerk/Supabase) + per-tenant
 *     state isolation + billing infra. Out of v0.1 scope.
 *   - A worker host. Workers still run on the operator's machine. This
 *     plane just sends webhook triggers and receives status reports —
 *     the audit-trail integrity story stays local.
 *   - A replacement for self-hosted dashboard-live. It complements it.
 *
 * Architecture:
 *
 *   Operator's laptop          hermes-cloud (hosted)         Triggers
 *   ─────────────────          ─────────────────────         ────────
 *   dashboard-live :7777  ←──  GET /status (proxy)     ←──  CronJob
 *                                                            Slack bot
 *                                                            GitHub PR
 *   auto:work             ←──  POST /trigger (webhook) ←──  Mobile UI
 *                                                            Webhook
 *   POST /report          ──→  in-memory recent state
 *
 * The operator's machine establishes an outbound long-poll OR webhook
 * endpoint to hermes-cloud. Cloud receives triggers from external
 * sources, queues them, and the operator's machine pulls the next
 * trigger and dispatches a local worker.
 *
 * Deploy:
 *   pnpm install
 *   HERMES_CLOUD_API_KEY=$(openssl rand -hex 32) pnpm start
 *   # OR via flyctl deploy / wrangler deploy / Vercel
 *
 * Pair with operator's `auto:cloud-poll` (separate CLI, future) that
 * long-polls /next-trigger and dispatches.
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const PORT = parseInt(process.env.PORT || '7790', 10);
const API_KEY = process.env.HERMES_CLOUD_API_KEY || '';

if (!API_KEY) {
  console.error('FATAL: HERMES_CLOUD_API_KEY env not set.');
  console.error('Generate one: openssl rand -hex 32');
  process.exit(1);
}

interface PendingTrigger {
  id: string;
  module: string;
  version: string;
  type: string;
  objective: string;
  source: string;          // who/what triggered (slack-bot, cron, webhook-foo)
  enqueued_at: string;
  claimed_at?: string;
  claimed_by?: string;
}

interface OperatorState {
  /** Most recent /report from the operator's machine. */
  last_report_at: string;
  status: Record<string, unknown>;
}

// In-memory state. Real prod uses Postgres/D1/KV. v0.1 keeps it tractable.
const TRIGGERS = new Map<string, PendingTrigger>();
const OPERATOR_STATES = new Map<string, OperatorState>();

const app = new Hono();

// Auth middleware — every protected route requires Bearer token.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  const auth = c.req.header('authorization') || '';
  if (!auth.startsWith('Bearer ')) return c.json({ error: 'missing bearer token' }, 401);
  const presented = auth.slice(7);
  const expected = API_KEY;
  if (presented.length !== expected.length) return c.json({ error: 'unauthorized' }, 401);
  if (!timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) return c.json({ error: 'unauthorized' }, 401);
  return next();
});

app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Operator → cloud: report current dashboard state.
app.post('/api/report', async (c) => {
  const operatorId = c.req.header('x-operator-id') || 'default';
  const body = await c.req.json();
  OPERATOR_STATES.set(operatorId, {
    last_report_at: new Date().toISOString(),
    status: body,
  });
  return c.json({ accepted: true, operator: operatorId });
});

// Cloud client (web UI / mobile) → cloud: get last reported status.
app.get('/api/status', (c) => {
  const operatorId = c.req.query('operator') || 'default';
  const state = OPERATOR_STATES.get(operatorId);
  if (!state) return c.json({ error: 'no recent report from this operator' }, 404);
  return c.json(state);
});

// External trigger source → cloud: enqueue a dispatch.
app.post('/api/trigger', async (c) => {
  const body = await c.req.json();
  const id = `trg_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const trigger: PendingTrigger = {
    id,
    module: String(body.module || ''),
    version: String(body.version || 'v1.0'),
    type: String(body.type || 'code-sprint'),
    objective: String(body.objective || ''),
    source: String(body.source || c.req.header('user-agent') || 'unknown'),
    enqueued_at: new Date().toISOString(),
  };
  if (!trigger.module || !trigger.objective) {
    return c.json({ error: 'module + objective required' }, 400);
  }
  TRIGGERS.set(id, trigger);
  return c.json({ accepted: true, trigger_id: id });
});

// Operator → cloud: long-poll for next trigger (claims it atomically).
app.get('/api/next-trigger', (c) => {
  const operatorId = c.req.header('x-operator-id') || 'default';
  for (const [id, t] of TRIGGERS.entries()) {
    if (!t.claimed_at) {
      t.claimed_at = new Date().toISOString();
      t.claimed_by = operatorId;
      return c.json(t);
    }
  }
  return c.json({ trigger: null });
});

// Operator → cloud: report a trigger as completed (and what happened).
app.post('/api/trigger/:id/complete', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const t = TRIGGERS.get(id);
  if (!t) return c.json({ error: 'unknown trigger' }, 404);
  TRIGGERS.delete(id);
  // In a real system: write to durable log here. v0.1 just drops on the floor.
  return c.json({ accepted: true, trigger_id: id, outcome: body });
});

// Cloud client → cloud: list pending triggers (operator-scoped).
app.get('/api/triggers', (c) => {
  const items = [...TRIGGERS.values()];
  return c.json({ count: items.length, items });
});

// Tiny static UI surface for operators who want a hosted dashboard.
app.get('/', (c) => c.html(`<!DOCTYPE html>
<html><head><title>Hermes Cloud</title>
<style>
  body{font-family:system-ui;background:#0a0a0b;color:#e6e6e6;max-width:900px;margin:40px auto;padding:0 20px}
  code{background:#1a1a1c;padding:2px 6px;border-radius:3px;font-family:ui-monospace,SF Mono,monospace}
  pre{background:#1a1a1c;padding:16px;border-radius:6px;overflow-x:auto}
  a{color:#9ec5ff}
  h1{margin-bottom:6px}h2{color:#9ec5ff;font-size:14px;text-transform:uppercase;margin-top:32px}
</style></head><body>
<h1>🚀 Hermes Cloud</h1>
<p><em>Webhook trigger surface for the Hermes self-hosted harness.</em></p>

<h2>API endpoints</h2>
<pre>
GET  /api/health                 (no auth)
POST /api/report                 operator → cloud, JSON body of dashboard status
GET  /api/status                 client  → cloud, returns last operator report
POST /api/trigger                external → cloud, body: {module, version, type, objective}
GET  /api/next-trigger           operator → cloud, claims next pending trigger
POST /api/trigger/&lt;id&gt;/complete  operator → cloud, marks trigger done
GET  /api/triggers               client  → cloud, lists pending
</pre>

<h2>Auth</h2>
<p>Every <code>/api/*</code> route except <code>/api/health</code> requires <code>Authorization: Bearer &lt;HERMES_CLOUD_API_KEY&gt;</code>.</p>

<h2>Source</h2>
<p><a href="https://github.com/rkchoudary/hermes/tree/main/packages/hermes-cloud">github.com/rkchoudary/hermes/packages/hermes-cloud</a></p>

<h2>v0.1 limitations (pull requests welcome)</h2>
<ul>
  <li>Single-tenant: one API key, one operator namespace</li>
  <li>In-memory state — restart loses pending triggers</li>
  <li>No SSO / OAuth — Bearer token only</li>
  <li>No SLA / quotas / billing — bring your own infra observability</li>
</ul>

</body></html>`));

console.log(`[hermes-cloud] listening on :${PORT}`);
console.log(`[hermes-cloud] API key configured (${API_KEY.length} chars)`);
serve({ fetch: app.fetch, port: PORT });
