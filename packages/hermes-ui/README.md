# hermes-ui

Polished React (Next.js + Tailwind) dashboard for Hermes. Optional companion to the core CLI.

The core ships an HTML dashboard at `dashboard-live :7777`. This package gives you a richer UX: server-side proxying to the existing `/api/*` endpoints, dark-mode-first design, and route-based tab navigation that's better-suited to enterprise demos.

## Install

```bash
cd packages/hermes-ui
pnpm install
HERMES_API_URL=http://localhost:7777 pnpm dev
```

Then open http://localhost:7780.

The UI proxies `/api/*` to `HERMES_API_URL` so the browser doesn't deal with CORS.

## Pages

- `/` — Overview (run state, drivers, council health, recent merges, parked queue, resources)
- `/engines` — Engine availability matrix (PATH-detected at request time)
- `/cost` — Per-task USD breakdown with live updates every 5s
- `/replay` — Search any task ID; renders state-log timeline + codex rounds + evidence

## Status

`v0.1` — feature-complete for the four tabs. Improvements welcome:
- Real-time WebSocket subscription instead of poll
- Authentication for multi-tenant deployments
- Inline diff viewer for evidence files
- Charts (modules-completed-over-time, cost-burn rate)
- Mobile responsive review

## Build for production

```bash
pnpm build
pnpm start
```
