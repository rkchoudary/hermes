#!/usr/bin/env node
/**
 * pnpm auto:yaml-runner <workflow.yaml> [--module M21] [--version v1.0]
 *
 * Sprint M (#22): YAML workflow runner — Archon-pattern. Reads workflow YAML
 * (nodes + DAG), executes nodes in order. Replaces inline drive_phase logic
 * for portable, version-controlled workflows.
 */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

interface Node {
  id: string;
  cmd?: string;
  cmds?: string[];
  capture?: string;
  extract?: Record<string, string>;
  when?: string;
  on_exit_nonzero?: string | string[];
  on_exit_zero?: string;
  background?: boolean;
  timeout?: number;
  final?: boolean;
  exit_code?: number;
  success_criteria?: string;
}

interface Workflow {
  name: string;
  description?: string;
  env?: Record<string, string>;
  nodes: Node[];
  hooks?: { pre_module?: string[]; post_module?: string[] };
}

interface CliArgs { workflow: string; inputs: Record<string, string>; dryRun?: boolean; }

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(`pnpm auto:yaml-runner <workflow.yaml> [--module M21] [--version v1.0] [--dry-run]`);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const a: CliArgs = { workflow: argv[0], inputs: {} };
  for (let i = 1; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dry-run') a.dryRun = true;
    else if (x.startsWith('--') && i + 1 < argv.length) a.inputs[x.slice(2).replace(/-/g, '_')] = argv[++i];
  }
  return a;
}

// Minimal YAML parser (no external dep). Supports our schema fully.
function parseYAML(text: string): Workflow {
  const lines = text.split('\n').map(l => l.replace(/(^|[^"'])#.*$/, '$1')).filter(l => l.trim() || l.startsWith(' '));
  let i = 0;
  const ind = (s: string): number => { const m = s.match(/^( *)/); return m ? m[1].length : 0; };
  const parseValue = (raw: string): unknown => {
    const v = raw.trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    return v;
  };
  const parseBlock = (level: number): unknown => {
    const result: Record<string, unknown> = {};
    let listItems: unknown[] | null = null;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const li = ind(line);
      if (li < level) return listItems !== null ? listItems : result;
      if (li > level) { i++; continue; }
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        if (listItems === null) listItems = [];
        const itemContent = trimmed.slice(2);
        // A list item is a map only if (a) it has a YAML-key-shaped prefix
        // before the first colon — i.e., no spaces — AND (b) either the value
        // is empty (block-style map) or there are more-indented sibling lines
        // following. Otherwise treat the entire content as a scalar string.
        // This guards against shell commands like `pnpm auto:work …` being
        // misread as `key=pnpm auto, value=work …`.
        const keyMatch = itemContent.match(/^([A-Za-z_][\w-]*):(\s|$)(.*)$/);
        const looksLikeMap = !!keyMatch && (
          keyMatch[3].trim() === '' ||
          (i + 1 < lines.length && ind(lines[i + 1]) >= li + 2)
        );
        if (looksLikeMap) {
          const m = itemContent.match(/^([^:]+):\s*(.*)$/);
          if (m) {
            const mapStart: Record<string, unknown> = {};
            mapStart[m[1].trim()] = m[2].trim() ? parseValue(m[2]) : null;
            i++;
            const innerLevel = li + 2;
            while (i < lines.length) {
              const sub = lines[i];
              if (!sub.trim()) { i++; continue; }
              const subInd = ind(sub);
              if (subInd < innerLevel) break;
              if (subInd === innerLevel) {
                const subTrim = sub.trim();
                const sm = subTrim.match(/^([^:]+):\s*(.*)$/);
                if (sm) {
                  const k = sm[1].trim();
                  const rawV = sm[2];
                  if (rawV === '|' || rawV === '>') {
                    i++;
                    const blockLines: string[] = [];
                    while (i < lines.length && (lines[i].trim() === '' || ind(lines[i]) > innerLevel)) {
                      blockLines.push(lines[i].slice(innerLevel + 2)); i++;
                    }
                    mapStart[k] = blockLines.join('\n');
                    continue;
                  }
                  if (rawV.trim()) { mapStart[k] = parseValue(rawV); i++; }
                  else { i++; mapStart[k] = parseBlock(innerLevel + 2); }
                } else { i++; }
              } else { i++; }
            }
            listItems!.push(mapStart);
            continue;
          }
        }
        listItems!.push(parseValue(itemContent));
        i++;
      } else if (trimmed.includes(':')) {
        const m = trimmed.match(/^([^:]+):\s*(.*)$/);
        if (m) {
          const key = m[1].trim();
          const rawV = m[2];
          if (rawV === '|' || rawV === '>') {
            i++;
            const blockLines: string[] = [];
            while (i < lines.length && (lines[i].trim() === '' || ind(lines[i]) > level)) {
              blockLines.push(lines[i].slice(level + 2)); i++;
            }
            result[key] = blockLines.join('\n').trim();
          } else if (rawV.trim()) { result[key] = parseValue(rawV); i++; }
          else { i++; result[key] = parseBlock(level + 2); }
        } else { i++; }
      } else { i++; }
    }
    return listItems !== null ? listItems : result;
  };
  return parseBlock(0) as Workflow;
}

function interpolate(s: unknown, ctx: Record<string, unknown>): string {
  if (typeof s !== 'string') return s == null ? '' : String(s);
  return s.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_, expr) => {
    let v: unknown = ctx;
    for (const p of expr.split('.')) { if (v && typeof v === 'object') v = (v as Record<string, unknown>)[p]; }
    return v == null ? '' : String(v);
  });
}

function evalWhen(expr: string, ctx: Record<string, unknown>): boolean {
  const m = expr.match(/^([\w-]+)\.([\w_]+)\s*(==|!=)\s*(.+)$/);
  if (!m) return true;
  const [, nodeId, key, op, rhsRaw] = m;
  const node = (ctx[nodeId] as Record<string, unknown>) || {};
  const lhs = node[key];
  const rhs = rhsRaw.trim().replace(/^["']|["']$/g, '');
  const rhsTyped: unknown = /^-?\d+$/.test(rhs) ? parseInt(rhs, 10) : rhs;
  return op === '==' ? lhs === rhsTyped : lhs !== rhsTyped;
}

function runShell(cmd: string, env: Record<string, string>, timeoutSec?: number, background = false): { exit_code: number; stdout: string; stderr: string } {
  if (background) { spawnSync('sh', ['-c', `${cmd} >/dev/null 2>&1 &`], { env: { ...process.env, ...env } }); return { exit_code: 0, stdout: '', stderr: '' }; }
  const r = spawnSync('sh', ['-c', cmd], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: (timeoutSec ?? 0) * 1000 || undefined });
  return { exit_code: r.status ?? 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function jsonPathExtract(json: unknown, jpath: string): unknown {
  if (!jpath.startsWith('$')) return undefined;
  let v: unknown = json;
  for (const p of jpath.slice(1).split('.').filter(Boolean)) { if (v && typeof v === 'object') v = (v as Record<string, unknown>)[p]; else return undefined; }
  return v;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wf = parseYAML(fs.readFileSync(args.workflow, 'utf8'));
  if (!wf.nodes || !Array.isArray(wf.nodes)) throw new Error(`workflow has no .nodes: ${args.workflow}`);
  const env: Record<string, string> = { ...wf.env };
  const ctx: Record<string, unknown> = { ...args.inputs };
  console.log(`[yaml-runner] workflow: ${wf.name} (${wf.nodes.length} nodes)`);
  if (wf.hooks?.pre_module) for (const cmd of wf.hooks.pre_module) { const c = interpolate(cmd, ctx); console.log(`[pre] ${c}`); if (!args.dryRun) runShell(c, env); }
  let lastExitCode = 0;
  for (const node of wf.nodes) {
    if (node.when) { const w = interpolate(node.when, ctx); if (!evalWhen(w, ctx)) { console.log(`[skip ${node.id}] when=${w}`); continue; } }
    if (node.final) { console.log(`[final ${node.id}] exit=${node.exit_code ?? 0}`); if (node.cmd) console.log(interpolate(node.cmd, ctx)); process.exit(node.exit_code ?? 0); }
    const cmds = node.cmds || (node.cmd ? [node.cmd] : []);
    let nodeExit = 0; let nodeStdout = '';
    for (const cmd of cmds) {
      const c = interpolate(cmd, ctx);
      console.log(`[${node.id}] ${c}`);
      if (args.dryRun) continue;
      const r = runShell(c, env, node.timeout, node.background);
      nodeExit = r.exit_code; nodeStdout += r.stdout;
      if (r.stderr) process.stderr.write(r.stderr);
      if (nodeExit !== 0 && !node.background && cmds.length > 1) break;
    }
    ctx[node.id] = { exit_code: nodeExit, stdout: nodeStdout };
    lastExitCode = nodeExit;
    if (node.capture && nodeStdout) {
      try { const parsed = JSON.parse(nodeStdout); (ctx[node.id] as Record<string, unknown>)[node.capture] = parsed; if (node.extract) for (const [k, j] of Object.entries(node.extract)) { const val = jsonPathExtract(parsed, j); if (val !== undefined) ctx[k] = val; } } catch { /* skip */ }
    }
  }
  if (wf.hooks?.post_module) for (const cmd of wf.hooks.post_module) { const c = interpolate(cmd, ctx); console.log(`[post] ${c}`); if (!args.dryRun) runShell(c, env); }
  console.log(`[yaml-runner] complete; last exit=${lastExitCode}`);
  process.exit(lastExitCode);
}

main().catch((e) => { console.error(`[yaml-runner] fatal: ${(e as Error).message}`); process.exit(99); });
