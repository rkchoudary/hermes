# hermes-cloud

Hosted control plane for the Hermes self-hosted harness. Lets external sources (cron jobs, Slack bots, GitHub webhooks, mobile apps) trigger Hermes work *without* hosting the workers themselves — the audit trail stays on the operator's machine.

## Why

Self-hosted Hermes works great when you're sitting at your laptop. But you also want:
- Cron-triggered nightly module runs
- "Trigger module M22 from a Slack `/hermes` command"
- Mobile "kick off the deploy" from the pool
- Webhook-driven dispatches from external systems

Hermes-cloud is the thin webhook surface for those — your workers still run locally, only the control surface is hosted.

## Architecture

```
External trigger sources    hermes-cloud (hosted)        Operator's machine
────────────────────────    ─────────────────────        ──────────────────
Cron / Slack / GitHub  ─→   POST /api/trigger
                              ↓ (queue)
                            GET /api/next-trigger   ─→  long-poll loop
                                                         (auto:cloud-poll)
                                                         ↓ (claim)
                                                         pnpm auto:plan
                                                         pnpm auto:work
                                                         pnpm auto:land
                                                         ↓ (post-status)
                            POST /api/report        ←──  dashboard snapshot
                              ↓
Web UI / Mobile        ←─   GET /api/status
```

## Quick start

```bash
cd packages/hermes-cloud
pnpm install

# Generate an API key (any 32+ random bytes work)
export HERMES_CLOUD_API_KEY=$(openssl rand -hex 32)
echo $HERMES_CLOUD_API_KEY > .env-api-key   # save somewhere

# Run locally
pnpm start
# OR deploy: flyctl deploy / wrangler deploy / Vercel / Railway
```

## API

All `/api/*` routes (except `/api/health`) require `Authorization: Bearer $HERMES_CLOUD_API_KEY`.

### `POST /api/trigger`

External source enqueues a dispatch. Body:

```json
{
  "module": "M22",
  "version": "v1.0",
  "type": "code-sprint",
  "objective": "Add OAuth2 callback verification",
  "source": "slack-bot:#deploys"
}
```

Returns `{ accepted: true, trigger_id: "trg_..." }`.

### `GET /api/next-trigger`

Operator's `auto:cloud-poll` long-polls this. Header `X-Operator-Id: <id>` if multiple operators share the cloud. Returns the next un-claimed trigger or `{trigger: null}`.

### `POST /api/trigger/<id>/complete`

After dispatch finishes, operator reports outcome. Body: `{ status, pr_url, cost_usd, ... }`.

### `POST /api/report`

Operator → cloud, periodic snapshot of `dashboard-live` state. Body is the JSON shape from `/api/status` of the local dashboard.

### `GET /api/status?operator=<id>`

Web/mobile clients fetch the last reported state. No data unless the operator has reported recently.

## v0.1 limitations

This is a control-plane scaffold. Production needs:

- [ ] **Multi-tenancy** — currently 1 API key = 1 operator. Real version needs OAuth/SSO + per-tenant DB partitioning + role-based access.
- [ ] **Durable storage** — in-memory state loses pending triggers on restart. Hook in Postgres / D1 / KV.
- [ ] **SLA + monitoring** — health endpoint returns `ok` if process is alive; doesn't verify upstream operator connectivity.
- [ ] **Quotas + billing** — no rate limiting, no per-tenant cost caps.
- [ ] **Audit trail integration** — triggers + completions should mirror to the operator's local override-audit log.
- [ ] **Webhook signature verification** — incoming trigger sources should sign their requests; we currently trust Bearer auth alone.

PRs welcome on any of the above.

## Deploy targets

The Hono server runs anywhere Node 20+ runs. Suggested:
- **Fly.io** — `flyctl deploy` with included `fly.toml` (TODO)
- **Cloudflare Workers** — change adapter to `@hono/cloudflare-workers`
- **Railway / Render / Vercel** — vanilla Node deploy
- **Docker** — `Dockerfile` (TODO)

## License

Apache-2.0.
