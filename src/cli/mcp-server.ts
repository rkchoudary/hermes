#!/usr/bin/env node
/**
 * pnpm auto:mcp-server
 *
 * Sprint K v3 (2026-05-02): minimal MCP server primitive. Exposes harness
 * read-only ops over stdio MCP protocol so external tools (Vibe Kanban,
 * Claude Desktop, Cursor) can query the harness state.
 *
 * Tools exposed:
 *   - harness.status            — snapshot of all module states
 *   - harness.module_state      — drill into one module
 *   - harness.list_parked       — list parked tasks needing operator drain
 *   - harness.skill_memory      — patterns from prior runs
 *
 * Wire-format: simple JSON-RPC 2.0 over stdin/stdout. Compatible with the
 * Model Context Protocol client spec (basic subset).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { harnessRoot } from '../lib/harnessRoot';

interface RpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = {
  'harness.status': {
    description: 'Snapshot of harness state: modules by phase, recent merges, parked queue size',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  'harness.module_state': {
    description: 'Drill into a single module: phase outcomes, latest task IDs, council sidecar statuses',
    inputSchema: { type: 'object', properties: { module: { type: 'string', description: 'Module ID (e.g., M21)' } }, required: ['module'] },
  },
  'harness.list_parked': {
    description: 'Parked modules/tasks awaiting operator drain via Stage 25 memo',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  'harness.skill_memory': {
    description: 'Patterns from prior runs of a phase type',
    inputSchema: { type: 'object', properties: { phase: { type: 'string', enum: ['frd-author', 'frd-polish', 'trd-author', 'sprint-plan-author', 'code-sprint'] } }, required: ['phase'] },
  },
};

function handleStatus(): unknown {
  const root = harnessRoot();
  const runs = fs.readdirSync(path.join(root, '.agent-runs')).filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  const latestRun = runs[runs.length - 1];
  const tasksDir = path.join(root, '.agent-runs', latestRun, 'tasks');
  const states: Record<string, number> = {};
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
        states[p.state || 'unknown'] = (states[p.state || 'unknown'] || 0) + 1;
      } catch { /* skip */ }
    }
  }
  const parkedFile = path.join(root, '.agent-runs', '_parked-modules.jsonl');
  let parkedCount = 0;
  if (fs.existsSync(parkedFile)) {
    parkedCount = fs.readFileSync(parkedFile, 'utf8').split('\n').filter(Boolean).length;
  }
  return { latest_run: latestRun, task_states: states, parked_count: parkedCount };
}

function handleModuleState(params: Record<string, unknown>): unknown {
  const module = String(params.module || '');
  if (!module) return { error: 'module required' };
  const root = harnessRoot();
  const runs = fs.readdirSync(path.join(root, '.agent-runs')).filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  const latestRun = runs[runs.length - 1];
  const tasksDir = path.join(root, '.agent-runs', latestRun, 'tasks');
  const moduleTasks: Array<Record<string, unknown>> = [];
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
        if ((p.module_or_sprint || '').startsWith(`${module}-`) || p.module_or_sprint === module) {
          moduleTasks.push({ task_id: p.task_id, type: p.type, state: p.state, version: p.version_target });
        }
      } catch { /* skip */ }
    }
  }
  // Council sidecars for this module
  const councilDir = path.join(root, '.agent-runs', '_audit', 'council', module);
  const sidecars: Array<{ phase: string; version: string; status: string }> = [];
  if (fs.existsSync(councilDir)) {
    for (const phase of fs.readdirSync(councilDir)) {
      const phaseDir = path.join(councilDir, phase);
      if (!fs.statSync(phaseDir).isDirectory()) continue;
      for (const verFile of fs.readdirSync(phaseDir)) {
        try {
          const sc = JSON.parse(fs.readFileSync(path.join(phaseDir, verFile), 'utf8'));
          sidecars.push({ phase, version: verFile.replace('.json', ''), status: sc.status });
        } catch { /* skip */ }
      }
    }
  }
  return { module, tasks: moduleTasks, council_sidecars: sidecars };
}

function handleListParked(): unknown {
  const parkedFile = path.join(harnessRoot(), '.agent-runs', '_parked-modules.jsonl');
  if (!fs.existsSync(parkedFile)) return { count: 0, items: [] };
  const items = fs.readFileSync(parkedFile, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return { count: items.length, items };
}

function handleSkillMemory(params: Record<string, unknown>): unknown {
  const phase = String(params.phase || '');
  if (!phase) return { error: 'phase required' };
  const f = path.join(harnessRoot(), '.agent-runs', '_skill-memory', `${phase}.jsonl`);
  if (!fs.existsSync(f)) return { phase, count: 0, entries: [] };
  const entries = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return { phase, count: entries.length, entries: entries.slice(-10) };
}

function dispatch(req: RpcRequest): RpcResponse {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'autonomous-delivery-harness', version: '0.1.0' }, capabilities: { tools: {} } } };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: Object.entries(TOOLS).map(([name, def]) => ({ name, description: def.description, inputSchema: def.inputSchema })) } };
      case 'tools/call': {
        const name = String((req.params?.name as string) || '');
        const args = (req.params?.arguments as Record<string, unknown>) || {};
        let result;
        if (name === 'harness.status') result = handleStatus();
        else if (name === 'harness.module_state') result = handleModuleState(args);
        else if (name === 'harness.list_parked') result = handleListParked();
        else if (name === 'harness.skill_memory') result = handleSkillMemory(args);
        else return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } };
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${req.method}` } };
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line) as RpcRequest;
    const resp = dispatch(req);
    process.stdout.write(JSON.stringify(resp) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${(e as Error).message}` } }) + '\n');
  }
});

console.error('[mcp-server] harness MCP server listening on stdio');
