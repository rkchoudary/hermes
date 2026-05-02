# Hermes — VS Code extension

Thin VS Code surface for the Hermes autonomous delivery harness. Runs the
Hermes MCP server as a child process; surfaces the same 4 tools as
commands + tree views.

## Commands

- **Hermes: Status snapshot** — opens a JSON view of the current `harness.status`
- **Hermes: Dispatch task** — interactive `auto:plan` + `auto:work` in a terminal
- **Hermes: Diagnose task** — runs `auto:diagnose-task` for the failure-analysis report
- **Hermes: Steer running task** — sends a mid-task directive (`auto:steer`)
- **Hermes: Interrupt task** — soft-kill via `auto:interrupt`
- **Hermes: Open live dashboard** — webview embed of `dashboard-live` :7777

## Settings

- `hermes.harnessRoot` — path to your Hermes install. Empty = use `npx hermes`
- `hermes.dashboardUrl` — `http://localhost:7777` by default
- `hermes.mcpAutoStart` — auto-start the MCP server on extension activation

## Build

```bash
cd extensions/vscode
pnpm install
pnpm run compile
# Then: F5 in VS Code to launch the Extension Development Host
```

## Status

`v0.1` — minimum viable scaffold. PRs welcome for:
- Inline diff acceptance UX
- Real-time agent thought streaming via webview
- Tree views populated from MCP responses
- Inline test-run integration
